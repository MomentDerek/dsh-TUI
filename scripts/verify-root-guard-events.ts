/**
 * #1765：root capability guard 在 `events` / `registry` 上的拦截面。
 *
 * 病不是「emit 被拦」一处，而是守卫把 Cordis 的服务解析路径一起关进了门：
 *   A. 插件 activation 里 `root.events.emit` 必须放行——DSH 的 `recompose()`
 *      在 `ctx.emit('app-boot/config-reload')` 收尾，而 web 请求永远跑在
 *      `dsh-host-webserver` 的 activation 令牌下；
 *   B. `waterfall` 必须放行——每个 context 未直接定义的服务属性都要过
 *      `events.waterfall('internal/get', …)`（cordis lib/index.js），拦它等于拦
 *      服务系统本身，`recompose()` 的 `ctx.loader.await()` 就在这里死掉，
 *      插件卸载因此连 emit 那一步都到不了；
 *   C. registry 的读方法必须放行——`resolve`/`get`/`has` 不移动任何状态，
 *      却是 loader 与 plugin-manager 查服务的必经之路；
 *   D. 监听与结构操作仍然关着——`on`/`once`/`register`/`unregister` 会把监听器
 *      挂在 root fiber 上、活过注册它的 activation，`root.effect` 与
 *      `registry.delete` 是真正的结构变更。放行它们才是把守卫拆了。
 *
 * 这里用真实 Cordis 根 + 真实插件 activation 断言，不 mock 守卫本身。
 * Run via `node --import tsx/esm scripts/verify-root-guard-events.ts`.
 */
import { Context } from '@deepseek-ai/cordis'
import { compositionRoot } from '../src/dsh-adapter/host-access.js'

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const REFUSAL = 'is unavailable from a plugin activation'
const refused = (message: string): boolean => message.includes(REFUSAL)

async function attempt(run: () => unknown): Promise<string> {
  try {
    await run()
    return 'ok'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const app = new Context()
const root = compositionRoot(app)

// The host side runs without an activation token; the guard must stay out of its way.
let delivered = 0
root.events.on('probe/emit', () => { delivered += 1 })
check('the host may listen on the root', delivered === 0)

const seen: Record<string, string> = {}

const probe = {
  name: 'probe-root-guard-events',
  async apply(ctx: Context): Promise<void> {
    seen.emit = await attempt(() => root.events.emit('probe/emit'))
    seen.parallel = await attempt(() => (root.events as unknown as {
      parallel: (name: string, ...args: unknown[]) => Promise<unknown>
    }).parallel('probe/parallel'))
    seen.waterfall = await attempt(() => (root.events as unknown as {
      waterfall: (name: string, ...args: unknown[]) => unknown
    }).waterfall('probe/waterfall', 1))
    // An undeclared service read is the same path `ctx.loader` takes in recompose().
    seen.undeclared = await attempt(() => (root as unknown as Record<string, unknown>).probeUndeclared)
    seen.registryHas = await attempt(() => root.registry.has('probe-nobody' as never))
    seen.on = await attempt(() => root.events.on('probe/ping', () => {}))
    seen.effect = await attempt(() => root.effect(() => {}))
    seen.registryDelete = await attempt(() => root.registry.delete('probe-nobody' as never))
    check('the probe really ran inside a plugin activation', ctx !== root)
  },
}

root.plugin(probe)
// Let the activation run; Cordis defers the apply callback by a microtask.
for (let turn = 0; turn < 8 && Object.keys(seen).length === 0; turn += 1) {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
await new Promise((resolve) => setTimeout(resolve, 0))

check('a plugin activation may emit on the root', !refused(seen.emit ?? ''), seen.emit)
check('the root listener received the plugin activation\'s emit', delivered === 1, String(delivered))
check('a plugin activation may run a root waterfall', !refused(seen.waterfall ?? ''), seen.waterfall)
check('a plugin activation may run a root parallel emit', !refused(seen.parallel ?? ''), seen.parallel)
check('a plugin activation may read an undeclared root service', !refused(seen.undeclared ?? ''), seen.undeclared)
check('a plugin activation may read the root registry', !refused(seen.registryHas ?? ''), seen.registryHas)

check('a plugin activation may not listen on the root', seen.on === `dsh-tui: root.events.on ${REFUSAL}`, seen.on)
check('a plugin activation may not add a root effect', seen.effect === `dsh-tui: root.effect ${REFUSAL}`, seen.effect)
check('a plugin activation may not delete a root service', seen.registryDelete === `dsh-tui: root.registry.delete ${REFUSAL}`, seen.registryDelete)

check('the host side may still emit on the root', await attempt(() => root.events.emit('probe/emit')) === 'ok')
check('the host emit reached its listener', delivered === 2, String(delivered))

console.log(`\n${passed} checks passed`)
