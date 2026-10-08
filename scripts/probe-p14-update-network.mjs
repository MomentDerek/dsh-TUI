/**
 * P14 / 任务 A 探针：`/update` 的前置判定（`checkForTuiUpdate` →
 * `resolveTuiUpdateTarget` → `resolveRegistryBase` / `fetchLatestVersion`）
 * 能否在**可控网络 + 隔离用户目录**下验收，以及这条路径是否写盘。
 *
 * 控制面：
 *  - `NPM_CONFIG_REGISTRY`（src/update.ts:309-320）决定 registry 基址 → 指向
 *    本地 fixture http 服务；
 *  - `resolveRegistryBase` 非默认 registry 时还会并行查 npmjs.org
 *    （src/update.ts:988-992），本探针用 `globalThis.fetch` 包装把
 *    registry.npmjs.org 的请求也重定向到同一个本地服务，保证**零真实网络**；
 *  - `HOME` 指向临时目录，`os.homedir()` 与 `DATA_DIR`（src/utils/paths.ts:17-22）
 *    随之隔离，`~/.npmrc` 不再参与。
 *
 * 三个分支：有新版本 / 已是最新 / 网络失败（服务关闭）。每个分支前后对比
 * 临时 HOME 的目录树，回答「是否写盘」。
 *
 * 真写盘点（本探针不触发，静态列出）：`updateTui`（src/update.ts:1690 起）
 * 会改 profile 的 `pnpm-workspace.yaml`、跑 `dsh plugin update` 子进程、
 * 改 profile 的 node_modules；standalone 分支会下载并 `renameSync` 替换
 * 当前二进制（src/update.ts:920-940）；`writeRestartLine` 写
 * `<DATA_DIR>/restart.log`（src/update.ts:61-68）。
 *
 * Run: node --import tsx/esm scripts/probe-p14-update-network.mjs
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'probe-p14-update-'))
const fakeHome = join(scratch, 'home')
mkdirSync(fakeHome, { recursive: true })
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.DSH_TUI_STANDALONE
delete process.env.DSH_TUI_STANDALONE_BINARY
delete process.env.DSH_HOME

/** 已观察到的请求 URL（用来证明没有真实网络）。 */
const seen = []
const realFetch = globalThis.fetch
const answered = { version: '9.9.9' }
let redirectTo = undefined
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input.url ?? input)
  seen.push(raw)
  if (redirectTo !== undefined && raw.startsWith('https://registry.npmjs.org/')) {
    return realFetch(redirectTo + raw.slice('https://registry.npmjs.org'.length), init)
  }
  return realFetch(input, init)
}

const server = createServer((request, response) => {
  if (request.url === '/@deepseek-harness-tui/dsh-tui/latest') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: answered.version }))
    return
  }
  response.writeHead(404).end('not found')
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
redirectTo = base
process.env.NPM_CONFIG_REGISTRY = base

const walk = (dir, prefix = '') => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name
    out.push(rel + (entry.isDirectory() ? '/' : ''))
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), `${rel}/`))
  }
  return out
}
const homeBefore = walk(fakeHome)

const update = await import('../src/update.js')
const version = update.installedTuiVersion()
const report = line => process.stdout.write(`${line}\n`)
report(`临时 HOME                : ${fakeHome}`)
report(`本包版本（读自身 manifest）: ${version}`)
report(`registry 基址（NPM_CONFIG_REGISTRY）: ${update.resolveRegistryBase()}`)

const newer = await update.checkForTuiUpdate()
report(`分支 1 · registry 报 9.9.9 → ${newer === undefined ? 'undefined（无更新）' : `kind=update latest=${newer.latest} current=${newer.current}`}`)
const auth = await update.resolveTuiUpdateTarget()
report(`         resolveTuiUpdateTarget → kind=${auth.kind}${auth.authoritative === undefined ? '' : ` authoritative=${auth.authoritative}`}`)

answered.version = version ?? '0.0.0'
const same = await update.checkForTuiUpdate()
report(`分支 2 · registry 报同版本 → ${same === undefined ? 'undefined（无更新，符合预期）' : `意外：kind=update latest=${same.latest}`}`)

answered.version = '9.9.9'
await new Promise(done => server.close(done))
globalThis.fetch = realFetch
const offline = await update.checkForTuiUpdate()
report(`分支 3 · 服务已关闭        → ${offline === undefined ? 'undefined（离线视为无结果，符合预期）' : `意外：kind=update latest=${offline.latest}`}`)

const homeAfter = walk(fakeHome)
const written = homeAfter.filter(path => !homeBefore.includes(path))
report(`真实网络请求（非 127.0.0.1）: ${seen.filter(url => !url.includes('127.0.0.1')).length} 条`)
report(`临时 HOME 新增条目        : ${written.length}${written.length === 0 ? '（未写盘）' : ` → ${written.join(', ')}`}`)
report(`重定向证明                : npmjs.org 请求 ${seen.filter(url => url.startsWith('https://registry.npmjs.org/')).length} 条，全部由本地服务应答`)

rmSync(scratch, { recursive: true, force: true })
const ok = newer !== undefined && newer.latest === '9.9.9' && same === undefined && offline === undefined && written.length === 0
process.exit(ok ? 0 : 1)
