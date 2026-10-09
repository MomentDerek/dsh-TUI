/**
 * probe-lite-profile-claude.mjs — 5.7 轻量 profile 的**聚焦验证探针**。
 *
 * 它走真实实现路径（`src/dsh-adapter/host-dsh.ts` 的 `prepareHostRoot({dsh:false})`
 * + `HostRoot.composeLite`），在一个隔离的 `DSH_HOME` 里组合一份轻量 profile，
 * 回答四件事：
 *
 *  1. Claude 内核（`dsh: false`）的根上，轻量组合**真的装起来了**吗：
 *     `tui*` 服务出现、第三方插件行 active、无 pending；
 *  2. 同根之下一个第三方插件（`inject: ['tuiPanels']`）能否激活 —— 这是 5.7 的
 *     实际目标（插件生态桥接）；
 *  3. `./src/dsh-adapter/lite-profile.ts` 的裁剪表（`LITE_PROFILE_ROW_DISABLES`）
 *     与实测的 pending 行**逐条对上**吗（这是「依据缺失符号裁剪」的可复现证据）；
 *  4. 组合的 effect 归属：一次 `ctx.fiber.dispose()` 是否覆盖全部。这是单根形状的
 *     退出漏斗前提，量在**真实组合**上——就是这里的第 4 点自身，不依赖仓库外的
 *     一次性脚本，所以它随本脚本一起入库并持续复核。
 *
 * 隔离：`DSH_HOME` 指向临时目录，profile 的 `bundles` 只写
 * `@deepseek-harness-tui/dsh-tui` 与 `dsh-tui-exit-banner`，`node_modules` 全部
 * symlink 回真实 profile（只读）。**不装 dsh-purge**：它的 `autoApplyOnStart: true`
 * 会改写用户的 harness 文件（`lib/index.js` 的 `shimNeedsPatch`），探针不碰它。
 * 不写真实 `~/.dsh`，不渲染 TUI。`HOME`/`USERPROFILE` 也一起重定向到本次运行的
 * scratch（见下方 `process.env.HOME`），否则偏好根 `~/.dsh-tui` 仍是真实 home ——
 * 组合里 active 的 `dsh-tui-plugin-host` 会在 apply 时挂 effect ledger 并
 * `appendFileSync` 写 `~/.dsh-tui/effect-ledger.jsonl`（硬证据：真实文件的 mtime
 * 曾正好落在上一次探针运行时刻）。
 *
 * 跑法：node --import tsx/esm scripts/probe-lite-profile-claude.mjs
 * 退出码：0 = 全部断言通过；1 = 有断言不一致（逐条打印）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在下面的 HOME 重定向**之前**取：`os.homedir()` 每次都读 `$HOME`，重定向后
// 再取就拿到 scratch 了，而这个探针要真实 profile 的 `node_modules` 做只读底座。
const REAL_PROFILE = join(homedir(), '.dsh', 'profiles', 'dsh-tui')
/**
 * 隔离 profile 的 bundles：与真实 profile 一致，只去掉 dsh-purge（它的
 * `autoApplyOnStart: true` 会改写用户的 harness 文件）。**保留 dsh-base**：
 * 裁掉它正是 `composeLite` 的职责，探针不能替它先裁。
 */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui', 'dsh-tui-exit-banner']
/** 期望的组合结果：dsh-base 那一层被裁掉后的 bundle 名单。 */
const LITE_BUNDLES = ['@deepseek-harness-tui/dsh-tui', 'dsh-tui-exit-banner']

const out = []
const say = (key, value) => { out.push(`${key} = ${value}`) }
const failures = []
const check = (key, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  say(key, `${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(key)
}

const scratch = mkdtempSync(join(tmpdir(), 'probe-lite-profile-'))
const home = join(scratch, '.dsh')
const profileDir = join(home, 'profiles', 'dsh-tui')
const modulesDir = join(profileDir, 'node_modules')
mkdirSync(modulesDir, { recursive: true })

writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-dsh-tui',
  private: true,
  dsh: { profile: { bundles: PROFILE_BUNDLES, patchReload: 'live' } },
}, null, 2)}\n`)
writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

for (const entry of readdirSync(join(REAL_PROFILE, 'node_modules'))) {
  symlinkSync(join(REAL_PROFILE, 'node_modules', entry), join(modulesDir, entry), 'junction')
}

process.env.DSH_HOME = home
process.env.DSH_TUI_SESSION_ROOT = join(scratch, 'sessions')
// 偏好根 `DATA_DIR = join(homeDir(), '.dsh-tui')`（`src/utils/paths.ts`）在 import
// 期定死，`homeDir()` 优先取 `os.homedir()`——只设 `DSH_HOME` 拦不住它。手法同
// `scripts/lib/fake-home.mjs`（那里另起一个 mkdtemp；这里复用探针自己的 scratch，
// 让 ledger 与组合产物落在同一个可回收目录里），顺序也一样是「必须先于任何
// src/ 模块的 import」：`plugin-host` 的 effect ledger 常量由 `DATA_DIR` 派生，
// import 之后再设 HOME 只会让它继续指真实 home。win32 的 `homedir()` 走
// `USERPROFILE`，两个都要动（run-verify-build.mjs 的每 gate HOME 同款）。
process.env.HOME = scratch
process.env.USERPROFILE = scratch
say('scratch.dshHome', home)
say('scratch.home', process.env.HOME)

const { loadHostDsh, prepareHostRoot } = await import('../src/dsh-adapter/host-dsh.ts')
const { LITE_PROFILE_ROW_DISABLES, liteProfilePlan } = await import('../src/dsh-adapter/lite-profile.ts')
const { DATA_DIR } = await import('../src/utils/paths.ts')

// 隔离自查：`DATA_DIR` 是 import 期常量，这一条同时证明「HOME 重定向生效」与
// 「重定向在 import 之前」——把它挪到 import 之后，这里就会打印真实 home。
const scratchDataDir = join(scratch, '.dsh-tui')
check('A.dataDirIsolated', DATA_DIR, scratchDataDir)
const ledgerFile = join(scratchDataDir, 'effect-ledger.jsonl')

const host = await loadHostDsh()
say('host.packageDir', host.packageDir)

const loaderOf = ctx => ctx.get('loader')
const entriesOf = ctx => [...loaderOf(ctx).entries()].map(entry => ({
  id: entry.options.id,
  name: entry.options.name,
  disabled: entry.disabled === true,
  state: entry.fiber?.state,
}))

// ── 轮 A：真实实现路径（prepareHostRoot dsh:false + composeLite）────────────
const hostRoot = await prepareHostRoot(host, { profile: 'dsh-tui', args: [], dsh: false })
const ctx = hostRoot.ctx
say('A.rootContext.baseUrl', String(ctx.baseUrl))
check('A.rootContext.hasDshHomePath', typeof ctx.get('dshHomePath', false) === 'function', true)
check('A.rootContext.hasLoader', loaderOf(ctx) !== undefined, true)

const warnings = []
await hostRoot.composeLite(line => { warnings.push(line.trimEnd()) })
say('A.warnings', JSON.stringify(warnings))

const entries = entriesOf(ctx)
const inactive = entries.filter(entry => !entry.disabled && entry.state !== 2)
check('A.entryCount', entries.length > 0, true)
check('A.inactive', inactive.map(entry => `${entry.id}:${entry.state}`), [])
check('A.dshTuiRowDisabled', entries.some(entry => entry.id === 'dsh-tui' && entry.disabled), true)
check('A.exitBannerRowActive', entries.some(entry => entry.id === 'dsh-tui-exit-banner' && !entry.disabled && entry.state === 2), true)
say('A.disabledRows', JSON.stringify(entries.filter(entry => entry.disabled).map(entry => entry.id)))

check('A.rootService.tuiPanels', ctx.get('tuiPanels', false) !== undefined, true)
check('A.rootService.tuiThemes', ctx.get('tuiThemes', false) !== undefined, true)
check('A.rootService.tuiWorkspaces', ctx.get('tuiWorkspaces', false) !== undefined, true)
check('A.rootService.tuiScenes', ctx.get('tuiScenes', false) !== undefined, true)
check('A.rootService.tuiPluginHost', ctx.get('tuiPluginHost', false) !== undefined, true)

// 非 DSH 内核**没有**偷拿 DSH 的 prepare 面：profileContext / launchEnvironment
// 仍旧只在 DSH 内核上提供（`prepareHostRoot` 的 `options.dsh` 分支保持原样）。
check('A.noProfileContext', ctx.get('profileContext', false) === undefined, true)
check('A.noLaunchEnvironment', ctx.get(host.launchEnvironmentKey, false) === undefined, true)

// 第三方插件的样子：inject 本包的行服务，并**真的登记一个 panel**。它能激活 =
// 5.7 的插件面成立；登记动作同时把 `plugin-host` 挂的 effect ledger 写出去
// （`panels.ts` 的 `ledger?.record`，`~/.dsh-tui/effect-ledger.jsonl`）——正是
// 需要 HOME 隔离拦住的那条写路径，所以这里的 ledger 落点就是隔离的验收证据。
let thirdPartyActivated = false
let thirdPartyService = undefined
let thirdPartyPanels = []
await ctx.plugin({
  name: 'probe-lite-third-party',
  inject: ['tuiPanels', 'tuiThemes'],
  apply(rowCtx) {
    thirdPartyActivated = true
    thirdPartyService = rowCtx.get('tuiPanels') !== undefined
    const panels = rowCtx.get('tuiPanels', false)
    if (panels === undefined) return
    panels.register({ apiVersion: 1, id: 'probe-lite-demo', title: 'Probe', component: () => null })
    thirdPartyPanels = panels.list().map(panel => panel.id)
  },
}, undefined)
check('A.thirdPartyActivated', thirdPartyActivated, true)
check('A.thirdPartySeesTuiPanels', thirdPartyService, true)
// `pluginIdFor` 的前缀由宿主决定（未声明身份时是 `undeclared`）：只钉后缀与数量。
check('A.thirdPartyPanelRegistered', thirdPartyPanels.filter(id => id.endsWith(':probe-lite-demo')), thirdPartyPanels)
check('A.thirdPartyPanelCount', thirdPartyPanels.length, 1)

// 隔离验收：ledger 必须落在本次 scratch 里，且确实被这次组合写过。
const ledgerLines = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean) : []
check('A.ledgerInScratch', existsSync(ledgerFile), true)
check('A.ledgerRecordsProbePanel', ledgerLines.some(line => line.includes('probe-lite-demo')), true)
say('A.ledgerFile', ledgerFile)
say('A.ledgerLineCount', ledgerLines.length)

await ctx.fiber.dispose()

// ── 轮 B：对照组合（排除 dsh-base 层但**不**裁剪行），读实测的 pending ──────
const hostRootB = await prepareHostRoot(host, { profile: 'dsh-tui', args: [], dsh: false })
const ctxB = hostRootB.ctx
const profileB = host.profileBoot.prepareProfile('dsh-tui', true, undefined)
const planB = liteProfilePlan(profileB)
check('B.plan.trimmed', planB.trimmed, true)
check('B.plan.bundles', planB.bundles, LITE_BUNDLES)
say('B.plan.excluded', JSON.stringify(planB.excluded))

const contextB = {
  name: 'dsh-tui',
  dir: profileB.dir,
  patchPath: profileB.patchPath,
  installAnchor: host.profileBoot.INSTALL_ANCHOR,
  startedBundles: planB.bundles,
  cwd: process.cwd(),
  home: host.homePaths.resolveDshHome(),
  overlays: [],
  telemetryDisabledEnv: undefined,
}
const patchesB = host.appBoot.readProfilePatches('dsh', contextB, { ...profileB, layers: [...planB.layers] })
// 故意不追加 planB.disableRows：这一轮要看行**本来**会 pending 成什么样。
const warningsB = []
await host.appBoot.mountRootInclude(ctxB, join(profileB.dir, host.profileBoot.PROFILE_ROOT_FILENAME), patchesB, undefined, 'dsh')
await loaderOf(ctxB).await()
await host.appBoot.auditStartupEntries(ctxB, 'dsh', line => { warningsB.push(String(line).trimEnd()) })

const pendingB = entriesOf(ctxB).filter(entry => !entry.disabled && entry.state !== 2)
say('B.pendingRows', JSON.stringify(pendingB.map(entry => `${entry.id}:${entry.name}`)))
const missingB = {}
for (const line of warningsB.join('\n').split('\n')) {
  const match = /^([\w@/.-]+) (\([^)]*\)): pending \(waiting for services?: (.+)\)$/u.exec(line.trim())
  if (match !== null) missingB[match[1]] = match[3]
}
say('B.missingServices', JSON.stringify(missingB))

// 裁剪表与实测逐条对表：id 集合一致，且每条 missing 与 Loader 报的服务一致。
// 集合比较按排序做：Loader 的输出顺序不该让一个内容一致的探针变红。
const sort = values => [...values].sort()
check('B.table.ids', sort(LITE_PROFILE_ROW_DISABLES.map(row => row.id)), sort(Object.keys(missingB)))
for (const row of LITE_PROFILE_ROW_DISABLES) {
  const actual = (missingB[row.id] ?? '').split(',').map(part => part.trim()).filter(Boolean)
  check(`B.table.missing.${row.id}`, sort(actual), sort(row.missing))
}
check('B.disableRowsShape', planB.disableRows, LITE_PROFILE_ROW_DISABLES.map(row => ({ id: row.id, disabled: true })))

await ctxB.fiber.dispose()

// ── 轮 C：DSH 内核的 prepare 面（证明 step 4 前置化没改动 DSH 路径）────────
// `prepareHostRoot` 的 step 4（baseUrl / dshHomePath / internal-update / Loader）
// 从 `options.dsh` 里搬到了两个内核都走的位置；DSH 内核本来的四步语义与
// `options.dsh` 分支的其余部分（proxy、fail-loud、profileContext、launch
// environment、cmdline）必须一字不变。
const hostRootC = await prepareHostRoot(host, { profile: 'dsh-tui', args: [], dsh: true })
const ctxC = hostRootC.ctx
check('C.baseUrl', String(ctxC.baseUrl), `file://${profileB.dir}/`)
check('C.hasDshHomePath', typeof ctxC.get('dshHomePath', false) === 'function', true)
check('C.hasLoader', loaderOf(ctxC) !== undefined, true)
check('C.profileContext.name', ctxC.get('profileContext', false)?.name, 'dsh-tui')
check('C.profileContext.startedBundles', [...(ctxC.get('profileContext', false)?.startedBundles ?? [])], PROFILE_BUNDLES)
check('C.hasLaunchEnvironment', ctxC.get(host.launchEnvironmentKey, false) !== undefined, true)
hostRootC.uninstallFailLoud()
await ctxC.fiber.dispose()

// ── 轮 D：bundles 里出现未安装包（轻量路径的容错）──────────────────────────
// 上游 `loadProfileDirectory` 逐 bundle try/catch，把不可解析的项放进
// `skippedBundles`（不抛）。轻量组合走的是同一个 `prepareProfile`，所以容错
// 由上游承担、本包不需要另写一份 —— 这一轮把它量出来。
const GHOST = '@deepseek-ai/dsh-provider-ghost-not-installed'
const ghostDir = join(home, 'profiles', 'dsh-tui-ghost')
mkdirSync(join(ghostDir, 'node_modules'), { recursive: true })
writeFileSync(join(ghostDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-dsh-tui-ghost',
  private: true,
  dsh: { profile: { bundles: [...PROFILE_BUNDLES, GHOST] } },
}, null, 2)}\n`)
writeFileSync(join(ghostDir, 'cordis.yml'), '[]\n')
writeFileSync(join(ghostDir, 'cordis.patch.yml'), '[]\n')
for (const entry of readdirSync(join(REAL_PROFILE, 'node_modules'))) {
  symlinkSync(join(REAL_PROFILE, 'node_modules', entry), join(ghostDir, 'node_modules', entry), 'junction')
}

const ghostProfile = host.profileBoot.prepareProfile('dsh-tui-ghost', true, undefined)
check('D.skippedBundles', ghostProfile.skippedBundles.map(skipped => skipped.packageName), [GHOST])
check('D.layers', ghostProfile.layers.map(layer => layer.packageName), PROFILE_BUNDLES)

const hostRootD = await prepareHostRoot(host, { profile: 'dsh-tui-ghost', args: [], dsh: false })
await hostRootD.composeLite(() => {})
const entriesD = entriesOf(hostRootD.ctx)
check('D.composed', entriesD.length > 0, true)
check('D.inactive', entriesD.filter(entry => !entry.disabled && entry.state !== 2).map(entry => entry.id), [])
await hostRootD.ctx.fiber.dispose()

// ── 轮 E：真实 profile 的清单（只读，不加载、不写用户目录）──────────────────
// 任务问的就是这一个值：本机 `dsh.profile.bundles` 实际是什么，轻量计划据此
// 会裁掉什么。只读 package.json —— `prepareProfile` 会重写 profile 的
// cordis.yml，探针不碰真实目录。
const realBundles = JSON.parse(readFileSync(join(REAL_PROFILE, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []
say('E.realProfile.bundles', JSON.stringify(realBundles))
const realPlan = liteProfilePlan({ layers: realBundles.map(packageName => ({ packageName })) })
check('E.realPlan.excluded', realPlan.excluded, ['@deepseek-ai/dsh-base'])
say('E.realPlan.bundles', JSON.stringify(realPlan.bundles))
say('E.realPlan.disableRows', JSON.stringify(realPlan.disableRows.map(row => row.id)))
check('E.realPlan.trimmed', realPlan.trimmed, true)

process.stdout.write(out.join('\n') + '\n')
process.stdout.write(failures.length === 0 ? 'PROBE_LITE_PROFILE_OK\n' : `PROBE_LITE_PROFILE_MISMATCH (${failures.join(', ')})\n`)
process.exitCode = failures.length === 0 ? 0 : 1
// 组合留下的句柄（watcher / 定时器）不该拖住一个探针：给自然退出一个短窗口。
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
