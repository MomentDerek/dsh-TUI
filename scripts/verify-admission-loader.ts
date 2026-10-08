/**
 * Admission-loader regression (docs/standalone-host-design.md §2.7 遗留 1).
 *
 * Before this loader existed, nothing in the product called
 * `getHostAdmission`: a third-party row activated without any manifest, so
 * every activation stayed anonymous — panels registered under the `act<N>`
 * fallback namespace, and DecisionEvents / storage.local refused the caller.
 * The acceptance fixtures had to play the loader themselves.
 *
 * This script drives the real thing on a real Cordis composition:
 *
 *  1. control — a loader entry whose package carries a package-root
 *     `dsh-plugin.json` activates with NO admission loader armed; its
 *     `apply` registers a panel, which lands in the `act<N>` namespace;
 *  2. armed — the same package on a second composition with the real
 *     `armAdmissionLoader()` armed: admission happens during LOADING (before
 *     the row's own callback), so the panel registers under the manifest id;
 *  3. bare — the same, but the entry is named by a BARE package specifier the
 *     way a real profile row is, so the `require.resolve('<pkg>/package.json')`
 *     branch of the manifest lookup runs instead of the absolute-path one;
 *  4. host-missing — `tuiPluginHost` never mounts (issue #183): the wait must
 *     be bounded, settle as refused, and leave an opt-in diagnostic.
 *
 * HOME/USERPROFILE are redirected to a throwaway dir before any `src/` import
 * (scripts/lib/fake-home.mjs): DATA_DIR is an import-time constant, and the
 * real plugin-host row mounted below appends its effect ledger to
 * `~/.dsh-tui/effect-ledger.jsonl`. Running this script must never touch the
 * user's real home.
 *
 * Run: node --import tsx/esm scripts/verify-admission-loader.ts
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './lib/fake-home.mjs' // 必须最先：DATA_DIR/effect-ledger 在 import 时定死

const { Context } = await import('@deepseek-ai/cordis')
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const hostRow = await import('../src/dsh-adapter/plugin-host.js')
const { TuiPanelRuntime } = await import('../src/dsh-adapter/panels.js')
const { armAdmissionLoader } = await import('../src/dsh-adapter/admission-loader.js')

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-admission-loader-'))
const packageDir = join(dir, 'third-party-package')
mkdirSync(packageDir)
writeFileSync(join(dir, 'marker'), '')
/**
 * A second loading root, so the bare-specifier case is reachable: the Loader's
 * own import and `resolveEntryFile`'s `require.resolve` both resolve relative
 * to the composition's baseUrl (the root cordis.yml), not to this process's
 * cwd — a bare package name therefore needs a `node_modules` under that root.
 * The real profile resolves third-party rows exactly this way.
 */
const loadRoot = join(dir, 'load-root')
const BARE_PACKAGE = '@dsh-tui-verify/bare-third-party'
const barePackageDir = join(loadRoot, 'node_modules', '@dsh-tui-verify', 'bare-third-party')
mkdirSync(barePackageDir, { recursive: true })
const LOAD_BASE_URL = pathToFileURL(join(loadRoot, 'cordis.yml')).href
writeFileSync(join(loadRoot, 'cordis.yml'), '')
writeFileSync(join(barePackageDir, 'package.json'), JSON.stringify({
  name: BARE_PACKAGE,
  version: '0.1.0',
  type: 'module',
  main: 'main.js',
}, null, 2))

const manifestOf = (id: string): string => JSON.stringify({
  $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
  id,
  name: id,
  version: '0.1.0',
  manifestVersion: '0.15',
  facets: { host: { entry: 'main.js', apiVersion: 'v1alpha1' } },
  requires: { contracts: [] },
  permissions: [],
  contributes: { commands: [] },
  subscriptions: [],
  license: 'MIT',
  source: { repository: 'https://example.com/verify-admission-loader' },
}, null, 2)

/** The entry module both fixtures share: registers a panel, reports its ids. */
const ENTRY_SOURCE = `import { appendFileSync } from 'node:fs'
export default function thirdParty(ctx, config) {
  const panels = ctx.get('tuiPanels', false)
  const out = { hasPanels: panels !== undefined, registered: false, ids: [] }
  if (panels !== undefined) {
    const dispose = panels.register({ apiVersion: 1, id: 'demo', title: 'Demo', component: () => null })
    out.registered = typeof dispose === 'function'
    out.ids = panels.list().map(panel => panel.id)
  }
  appendFileSync(config.report, JSON.stringify(out) + '\\n')
}
`

/** A minimal Community v0.15 package: manifest + entry that registers a panel. */
function writePackage(id: string): string {
  writeFileSync(join(packageDir, 'dsh-plugin.json'), manifestOf(id))
  writeFileSync(join(packageDir, 'main.js'), ENTRY_SOURCE)
  return join(packageDir, 'main.js')
}

interface MountedComposition {
  root: InstanceType<typeof Context>
  report: string
}

/**
 * One composition: the loader, the real plugin-host row, tuiPanels. `withHost`
 * false models the host-missing path (issue #183: stale patch, `tuiPluginHost`
 * never mounts while third-party rows still activate).
 */
async function mount(
  armed: boolean,
  retryAttempts?: number,
  withHost = true,
  baseUrl = pathToFileURL(join(dir, 'cordis.yml')).href,
): Promise<MountedComposition> {
  const report = join(dir, `${armed ? 'armed' : 'control'}-report.jsonl`)
  writeFileSync(report, '')
  const root = new Context()
  root.logger.warn = () => undefined
  root.logger.info = () => undefined
  await root.plugin(Loader, { baseUrl })
  if (withHost) await root.plugin({ name: hostRow.name, apply: hostRow.apply })
  await root.plugin(TuiPanelRuntime)
  if (armed) armAdmissionLoader(root, retryAttempts === undefined ? {} : { retryAttempts })
  return { root, report }
}

function reportedIds(report: string): string[] {
  const lines = readFileSync(report, 'utf8').split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return []
  const last = JSON.parse(lines[lines.length - 1]) as { ids?: string[] }
  return last.ids ?? []
}

async function activate(composition: MountedComposition, id: string): Promise<string> {
  const entry = writePackage(id)
  await composition.root.loader.create({ id, name: entry, config: { report: composition.report } })
  await composition.root.loader.await()
  // 固定窗:pacing 行 apply 后的落盘报告没有可轮询锚点（reportedIds 要等 appendFileSync）
  await sleep(400)
  return readFileSync(composition.report, 'utf8')
}

// ── control: no admission loader armed ────────────────────────────────────
const control = await mount(false)
await activate(control, 'verify-anonymous')
const controlIds = reportedIds(control.report)
check('control: the plugin applied and registered its panel', controlIds.length === 1, JSON.stringify(controlIds))
check('control: without the loader the panel falls back to the act<N> namespace',
  controlIds.length === 1 && /^act\d+:demo$/u.test(controlIds[0]))

// ── armed: the real armAdmissionLoader on the composition ─────────────────
const armed = await mount(true)
await activate(armed, 'verify-admitted')
const armedIds = reportedIds(armed.report)
check('armed: the plugin applied and registered its panel', armedIds.length === 1, JSON.stringify(armedIds))
check('armed: admission lands before apply, so the panel carries the manifest id',
  armedIds.length === 1 && armedIds[0] === 'verify-admitted:demo')

// ── nested entry id: the shape a real profile actually produces ────────────
// `loader.locate(fiber)` returns `fiber.entry.id`, and a profile nests rows
// behind group ids separated by `:` — the live dsh-tui profile carries
// `include:dsh-tui-agent-preset-registry:agent-instructions`. `EntryTree.
// resolve` does NOT return undefined for such an id, it **throws** (`cannot
// resolve entry <id>`). The loader walks every activating fiber, so one
// unresolvable entry among the profile's own rows used to take the whole
// process down from inside the `internal/status` listener: every PTY case
// ended in `dsh-tui crashed: cannot resolve entry …`. The pass must be
// skipped for it and every other activation still handled.
const nested = await mount(true)
// A genuine nested entry: a Group row owns the child, so the child's id grows
// a `:` segment. Its `name` is the same fixture as the top-level one; only the
// id differs, which is exactly what the fence has to survive.
const groupFile = join(dir, 'nested-group.mjs')
writeFileSync(groupFile, `import { Group } from ${JSON.stringify(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js')).href,
)}
export default Group
`)
const nestedReport = join(dir, 'nested-report.jsonl')
writeFileSync(nestedReport, '')
await nested.root.loader.create({ id: 'include', name: groupFile, group: true, config: [] })
await nested.root.loader.await()
// The child's OWN id already contains the separator, so `grp:child` cannot
// resolve: that is the failing shape, without waiting for a Group plugin to
// reparent the entry. `writePackage` is the fixture this pass must still
// admit, on the same composition and after the unresolvable one.
await nested.root.loader.create({
  id: 'dsh-tui-agent-preset-registry:agent-instructions',
  name: writePackage('verify-nested'),
  group: true,
  config: [],
})
await nested.root.loader.await()
// 固定窗:pacing 嵌套 entry 的激活落点没有可轮询完成条件（下一步的断言在另一组合上）
await sleep(300)
let nestedThrew: string | undefined
try {
  await activate(nested, 'verify-after-nested')
} catch (error) {
  nestedThrew = messageOf(error)
}
check('nested id: an unresolvable entry id does not tear the loader down',
  nestedThrew === undefined, nestedThrew ?? '')
check('nested id: the other activation on the same composition is still admitted',
  readFileSync(nested.report, 'utf8').includes('verify-after-nested:demo'), readFileSync(nested.report, 'utf8'))

// The identity is bound to the plugin's own activation: unloading the row
// (dispose the entry fiber) must release it — re-activating the same entry
// admits again instead of failing COMPONENT_ALREADY_ADMITTED.
const entryId = 'verify-admitted'
const entry = armed.root.loader.resolve(entryId) as { fiber?: { dispose?: () => Promise<unknown> } } | undefined
await entry?.fiber?.dispose?.()
// 固定窗:pacing 让撤销在 Cordis 里落定，之后没有断言锚点可轮询
await sleep(200)
const again = await activate(armed, 'verify-admitted-2')
check('armed: a fresh activation is admitted again (identity is per-activation)',
  readFileSync(armed.report, 'utf8').includes('verify-admitted-2:demo') || again.includes('verify-admitted-2:demo'))

// ── armed + BARE specifier: the profile's real third-party row name ───────
// Every case above drives an ABSOLUTE entry path, which takes
// resolveEntryFile's `isAbsolute` branch. A real profile row names a package
// ("@scope/pkg"), which takes the `require.resolve('<pkg>/package.json')`
// branch instead — the one the manifest lookup actually depends on. Resolve
// that branch on its own first (the observable that the loader consumes), then
// drive it end to end through the Loader.
writeFileSync(join(barePackageDir, 'dsh-plugin.json'), manifestOf('verify-bare'))
writeFileSync(join(barePackageDir, 'main.js'), ENTRY_SOURCE)
const requireFromLoadRoot = createRequire(LOAD_BASE_URL)
let bareResolved = ''
try {
  bareResolved = requireFromLoadRoot.resolve(BARE_PACKAGE + '/package.json')
} catch (error) {
  bareResolved = 'FAIL:' + (error instanceof Error ? error.message : String(error))
}
check('bare specifier: require.resolve(<pkg>/package.json) resolves under the load root',
  bareResolved === join(barePackageDir, 'package.json'), bareResolved)
// The manifest walk must land on the fixture's package root (one dsh-plugin.json).
check('bare specifier: the manifest sits at the resolved package root',
  bareResolved.startsWith(dir) && bareResolved === join(barePackageDir, 'package.json'))

const bare = await mount(true, undefined, true, LOAD_BASE_URL)
await bare.root.loader.create({ id: BARE_PACKAGE, name: BARE_PACKAGE, config: { report: bare.report } })
await bare.root.loader.await()
// 固定窗:pacing 裸包名 entry 的 import+apply 落盘，无可轮询完成条件
await sleep(600)
const bareIds = reportedIds(bare.report)
check('bare specifier: the row applied and registered its panel', bareIds.length === 1, JSON.stringify(bareIds))
check('bare specifier: the manifest id is found through the package-root walk',
  bareIds.length === 1 && bareIds[0] === 'verify-bare:demo')

// ── host-missing: bounded retry, then settle + loud diagnostic ────────────
// issue #183's shape: a third-party row activates while `tuiPluginHost` never
// mounts. The row is past the manifest gate, so it stays pending; unbounded,
// that keeps the flush timer re-arming itself for ever.
const ARM_TICKS = 4
const debugLines: string[] = []
const stderrWrite = process.stderr.write
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  debugLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  return true
}) as typeof process.stderr.write
process.env.DSH_TUI_DEBUG = '1'
try {
  const hostless = await mount(true, ARM_TICKS, false)
  await activate(hostless, 'verify-hostless')
  const refusals = (): string[] => debugLines.filter(line => line.includes('waiting') && line.includes('tuiPluginHost'))
  const deadline = Date.now() + 8000
  // 固定窗:探针 轮询诊断到达；上限由 deadline 兜住，不是断言窗口
  while (refusals().length === 0 && Date.now() < deadline) await sleep(100)
  const refusalLines = refusals()
  check('host-missing: the wait is bounded and settles with a diagnostic',
    refusalLines.length === 1, JSON.stringify(refusalLines))
  check('host-missing: the diagnostic names the missing host and the tick count',
    refusalLines.length === 1 && refusalLines[0].includes(String(ARM_TICKS)) && refusalLines[0].includes('host missing'),
    refusalLines[0] ?? '')
  // Settled: no further tick re-arms the flush timer.
  const ticksAtSettle = refusalLines.length
  const lineCountAtSettle = debugLines.length
  // 固定窗:探针 断言「已 settle 后计时器不再自续」——不变量，只能等观察窗
  await sleep(1200)
  check('host-missing: no further tick after it settled (the loop stopped)',
    refusals().length === ticksAtSettle && debugLines.length === lineCountAtSettle,
    debugLines.slice(lineCountAtSettle).join(''))
} finally {
  delete process.env.DSH_TUI_DEBUG
  process.stderr.write = stderrWrite
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? 'verify-admission-loader ALL PASS' : `verify-admission-loader ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
