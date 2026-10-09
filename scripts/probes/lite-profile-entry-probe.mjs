#!/usr/bin/env node
/**
 * probe-lite-profile-entry.mjs — 5.7 接线（入口在非 DSH 内核真的组合轻量 profile）
 * 的端到端探针。仓库内诊断物，不入库（publish 前删）。
 *
 * 它跑的是**真入口**：隔离 profile 的 `bin/dsh-tui.js` → `lib/types/dsh-adapter/host-entry.js`，
 * 内核钉在 Claude（profile patch 的 dsh-tui Config 行 + kernel.json），真实 PTY、真实首帧、
 * 真实组合。它回答三件事：
 *
 *  1. Claude 内核路径上轻量组合**真的执行了**：boot trace 里有
 *     `entry-first-frame-flushed` → `entry-compose-start` → `entry-compose-end`；
 *  2. 第三方插件**真的被组合并激活**：profile 的 patch 层里那一行 fixture 插件
 *     （`inject: ['tuiThemes','tuiPanels']`，带 package 根的 `dsh-plugin.json`）写出了
 *     apply 记录，并且它的 panel 落在 manifest 身份下（不是 `act<N>` 兜底）——
 *     没有接线时这份报告文件根本不会出现（`--before` 就是这条反证）；
 *  3. 组合面是**轻**的：插件在同一个根上看到 `tui*` 服务，看不到 dsh-base 的
 *     `llm` / `agents` / `workspaceRegistry`（被裁掉的那一层）。
 *
 * 隔离：`buildIsolatedProfile` 全量重定向（HOME / DSH_HOME / sessions 都在临时根里），
 * 不写真实 `~/.dsh` 与 `~/.dsh-tui`。Claude CLI 用假脚本（`--version` 转发真 CLI，
 * 其余 sleep），不联网、不花额度。
 *
 * 跑法：pnpm compile && node scripts/probes/lite-profile-entry-probe.mjs [--before] [--fail-notrim] [--keep]
 *   --before  把隔离副本的 host-entry.js 的轻量分支去掉（kernel !== 'dsh' → false），
 *             即接线前的行为：预期 compose 标记缺失、报告文件为空 → 探针判红。
 *   --fail-notrim  清单里没有可裁的 bundle（无 dsh-base）→ 断言「warning 后继续整份组合」
 *             的新语义（组合跑到底 + warning 落到 sink），见文件头的说明。
 * 退出码：0 = 全部断言通过；1 = 有断言不一致。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TuiTest } from '@microsoft/tui-test'
import { buildIsolatedProfile, executable } from '../lib/isolated-profile.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const before = flag('--before')
/**
 * 语义注入：`notrim` 让 profile 的 bundles 里没有 dsh-base（没有可裁的层）。
 * 这一条**不再**是「组合失败必须响亮退出」的证据：收口把 `composeLite` 的
 * `!plan.trimmed` 守卫改成「在被调方的 warning sink 上说明后继续整份组合」
 * （那种计划的 layers 本就是整份 profile、`rowDisables` 为空）。所以本模式
 * 断言新语义：组合**跑到底**，屏幕上没有启动失败，且那条 warning 出现——
 * warning 经 `logForDebugging` 写 stderr 且只有 `DSH_TUI_DEBUG` 打开时才写，
 * 所以本模式把入口的 stderr 单独重定向到文件再读（见下方 t.run 分支）。
 *
 * 实测的另一条（**不是**组合失败，所以不在这个模式里）：一个第三方行激活失败
 * （导入期抛、或 `!!js` 表达式抛）只让该行 inactive，`loader.await()` 与
 * `auditStartupEntries` 都照常返回 —— 上游只在**它自己 required 的 id**（dsh-base
 * 那些）inactive 时才抛 StartupError，轻量组合里一个都没有。所以那条只走 warn
 * 通道（入口与 DSH 内核一样把它送进 debug 日志，不写终端），组合本身仍然算成功。
 */
const fail = flag('--fail-notrim') ? 'notrim' : undefined

const repo = fileURLToPath(new URL('../..', import.meta.url))
const { root, dshHome, profile: profileDir, launcher, dshBin } = buildIsolatedProfile({ repo, prefix: `dsh-tui-probe-lite-${before ? 'before' : 'after'}-` })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lines = text => text.split('\n').filter(line => line.trim() !== '')
const readLines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
const readJsonLines = path => readLines(path).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// ── 夹具：一个第三方 Cordis 插件（package 根带 dsh-plugin.json，v0.15 社区清单）───
const thirdDir = join(root, 'probe-third-party')
mkdirSync(thirdDir, { recursive: true })
const report = join(root, 'probe-third-party-report.jsonl')
writeFileSync(join(thirdDir, 'dsh-plugin.json'), `${JSON.stringify({
  $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
  id: 'probe-entry-third',
  name: 'probe-entry-third',
  version: '0.1.0',
  manifestVersion: '0.15',
  facets: { host: { entry: 'index.mjs', apiVersion: 'v1alpha1' } },
  requires: { contracts: [] },
  permissions: [],
  contributes: { commands: [] },
  subscriptions: [],
  license: 'MIT',
  source: { repository: 'https://example.com/probe-lite-profile-entry' },
}, null, 2)}\n`)
writeFileSync(join(thirdDir, 'index.mjs'), `import { appendFileSync } from 'node:fs'

const write = event => data => {
  try { appendFileSync(process.env.PROBE_LITE_REPORT, \`\${JSON.stringify({ at: Date.now(), pid: process.pid, event, ...data })}\\n\`) } catch { /* the probe reads what is there */ }
}

export const name = 'probe-entry-third-party'
export const inject = ['tuiThemes', 'tuiPanels']

export function apply(ctx) {
  const service = value => {
    try { return ctx.get(value, false) !== undefined } catch { return false }
  }
  const names = ['tuiThemes', 'tuiPanels', 'tuiPluginHost', 'tuiWorkspaces', 'tuiScenes',
    'tuiCommandTrees', 'llm', 'agents', 'workspaceRegistry', 'commands', 'tools']
  write('apply')({ present: Object.fromEntries(names.map(name => [name, service(name)])) })
  const panels = ctx.get('tuiPanels', false)
  if (panels === undefined) { write('panels')({ registered: false }); return }
  try {
    panels.register({ apiVersion: 1, id: 'demo', title: 'Probe', component: () => null })
    write('panels')({ registered: true, ids: panels.list().map(panel => panel.id) })
  } catch (error) {
    write('panels')({ registered: false, error: error instanceof Error ? error.message : String(error) })
  }
  // 一拍之后再记一次：准入是异步重试的（admission-loader），身份与宿主服务可能
  // 在 apply 之后才落到这个根上。
  setTimeout(() => {
    try {
      write('later')({ pluginHost: service('tuiPluginHost'), ids: panels.list().map(panel => panel.id) })
    } catch { /* the probe reads what is there */ }
  }, 1500)
}
`)

// ── profile patch：内核钉 Claude + 第三方插件行 ─────────────────────────────────
// 失败注入模式换成会炸的那一行（导入期抛 / patch 表达式抛），其余不变。
if (fail === 'notrim') {
  // 没有 dsh-base 可裁：`composeLite` 只在该计划上说明（warning sink）然后继续
  // 组合整份 profile —— 入口不得因此结束进程。
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== '@deepseek-ai/dsh-base')
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
} else if (fail === undefined) {
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: dsh-tui
  config:
    backend: claude
- insert:
    - id: probe-entry-third
      name: ${JSON.stringify(`file://${join(thirdDir, 'index.mjs')}`)}
`)
}

// ── 偏好根：已过引导页，记住 Claude（入口路由的第二票）─────────────────────────
mkdirSync(join(root, '.dsh-tui'), { recursive: true })
writeFileSync(join(root, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
writeFileSync(join(root, '.dsh-tui', 'kernel.json'), `${JSON.stringify({ backend: 'claude' }, null, 2)}\n`)

// ── 假 Claude CLI：版本查询转发真 CLI，其余长睡（不联网、不起真会话）───────────
const realClaude = executable('claude')
const fakeClaude = join(root, 'fake-claude.sh')
writeFileSync(fakeClaude, `#!/bin/sh
case "$1" in --version|-v) exec '${realClaude}' "$@";; esac
sleep 60
`)
chmodSync(fakeClaude, 0o755)

if (before) {
  const entryJs = join(dshHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'lib', 'types', 'dsh-adapter', 'host-entry.js')
  const text = readFileSync(entryJs, 'utf8')
  const mutated = text.replaceAll("kernel !== 'dsh'", 'false')
  if (mutated === text) throw new Error('--before: the isolated host-entry.js has no `kernel !== \'dsh\'` to neutralize')
  writeFileSync(entryJs, mutated)
  console.log('(before: the isolated entry no longer composes the light profile)')
}

const trace = join(root, 'trace.jsonl')
const full = {
  HOME: root,
  PATH: `${dshBin}:${process.env.PATH ?? ''}`,
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  DSH_HOME: dshHome,
  DSH_TUI_SESSION_ROOT: join(root, 'sessions'),
  DSH_TUI_WORKSPACE_TARGET: repo,
  DSH_TUI_LANG: 'en',
  DSH_TUI_BOOT_TRACE: trace,
  DSH_TELEMETRY_MODE: 'DISABLED',
  NODE_ENV: 'production',
  DSH_TUI_NO_LAUNCHPAD: '1',
  CLAUDE_CODE_EXECUTABLE: fakeClaude,
  PROBE_LITE_REPORT: report,
  // warning 只在调试通道上写（utils/debug.ts 的 logForDebugging）；composeLite
  // 的 warn sink 就是它。正常模式不需要这行。
  ...(fail === 'notrim' ? { DSH_TUI_DEBUG: '1' } : {}),
}

console.log(`(isolated root: ${root})`)
const t = TuiTest.ephemeral(`probe-lite-${before ? 'before' : 'after'}`)
const envPairs = Object.entries(full).map(([key, value]) => `${key}=${value}`)
const stderrLog = join(root, 'entry-stderr.log')
if (fail === 'notrim') {
  // 入口的 stderr 单独落文件。PTY 屏幕上那条 warning 会被组合后的重绘抹掉，
  // 而 stderr 是它唯一的输出面（`2>` 只影响这条注入模式）。
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
  await t.run('/bin/sh', ['-c', `exec /usr/bin/env -i ${envPairs.map(quote).join(' ')} ${quote(process.execPath)} ${quote(launcher)} 2>${quote(stderrLog)}`], { cols: 100, rows: 30, cwd: repo })
} else {
  await t.run('/usr/bin/env', ['-i', ...envPairs, process.execPath, launcher], { cols: 100, rows: 30, cwd: repo })
}

try {
  const marks = () => readJsonLines(trace)
  const traced = mark => marks().some(entry => entry.mark === mark)
  // 组合区间只在入口进程里：等 compose-end 出现后，用 entry-start 的 pid 归属
  // （第一跳 read 时文件通常还是空的，pid 必须在循环之后取）。
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !traced('entry-compose-end')) await sleep(200)
  const entryPid = marks().find(entry => entry.mark === 'entry-start')?.pid
  const entryMarks = marks().filter(entry => entry.pid === entryPid)
  console.log(`boot marks: ${entryMarks.map(entry => `${entry.mark}@${entry.ms}`).join(' -> ')}`)

  if (fail === 'notrim') {
    // 新语义（收口）：`composeLite` 在 `!plan.trimmed` 时只 warn，然后继续整份
    // 组合（src/dsh-adapter/host-dsh.ts）。断言组合跑完、屏幕没有启动失败、
    // 进程还在，以及那条 warning 真的落到了 sink 上。
    await sleep(2500)
    const screen = await t.text()
    const state = await t.state().catch(() => undefined)
    const stderrText = existsSync(stderrLog) ? readFileSync(stderrLog, 'utf8') : ''
    const markNames = entryMarks.map(entry => entry.mark)
    check(markNames.includes('entry-compose-start') && markNames.includes('entry-compose-end'),
      'the composition ran to its end instead of failing (start -> end)', `marks: ${markNames.join(', ')}`)
    const warningLine = stderrText.split('\n').find(line => line.includes('light profile:')) ?? ''
    check(stderrText.includes('lists none of @deepseek-ai/dsh-base') && stderrText.includes('composing it whole'),
      'the untrimmable plan is named on the composition warning sink', `warning: ${warningLine.trim()}`)
    check(!screen.includes('dsh-tui startup failed:') && (state === undefined || state.exited === null),
      'no startup failure on the terminal, the entry is still running',
      `exited=${state?.exited} tail: ${lines(screen).slice(-3).join(' / ')}`)
    check(!readLines(join(root, '.dsh-tui', 'restart.log')).some(line => / pid=\d+ crash /.test(line)),
      'no crash in restart.log', readLines(join(root, '.dsh-tui', 'restart.log')).join('\n'))
  } else {
  // 组合内的异步尾巴（组合本身在 compose-end 之后还有 loader 的收尾，以及插件
  // 自己那一拍诊断）留够窗口。
  await sleep(2500)
  const screen = await t.text()
  const entries = readJsonLines(report)

  const markOf = name => entryMarks.find(entry => entry.mark === name)
  const flushed = markOf('entry-first-frame-flushed')
  const start = markOf('entry-compose-start')
  const end = markOf('entry-compose-end')
  check(flushed !== undefined && start !== undefined && end !== undefined,
    'the entry ran the light composition (first-frame-flushed / compose-start / compose-end)',
    `flushed=${flushed?.ms} start=${start?.ms} end=${end?.ms}`)
  check(flushed !== undefined && start !== undefined && flushed.ms <= start.ms, 'the first frame was flushed before the composition started')
  check(start !== undefined && end !== undefined && end.ms > start.ms, 'the composition interval is non-empty', `${(end?.ms ?? 0) - (start?.ms ?? 0)}ms`)

  const applied = entries.filter(entry => entry.event === 'apply')
  check(applied.length === 1, 'the third-party plugin row applied exactly once', `apply records: ${applied.length}`)
  const present = applied[0]?.present ?? {}
  check(present.tuiThemes === true && present.tuiPanels === true && present.tuiWorkspaces === true && present.tuiScenes === true,
    'the third-party plugin sees the tui* services it injects', JSON.stringify(present))
  check(present.llm === false && present.agents === false && present.workspaceRegistry === false,
    'the light composition left dsh-base out (no llm / agents / workspaceRegistry on the root)', JSON.stringify(present))
  const panels = entries.find(entry => entry.event === 'panels')
  check(panels?.registered === true && Array.isArray(panels.ids) && panels.ids.length === 1 && panels.ids.every(id => id.endsWith(':demo')),
    'the plugin registered its panel into the mounted root\'s panel store', JSON.stringify(panels))
  // 只记录，不断言：身份前缀取决于 `tuiPluginHost` 在那一次 apply 时是否已经在根上
  // （admission-loader 在 LOADING 同步准入，够不着就退到 `act<N>` 兜底并重试）。
  console.log(`     panel id: ${JSON.stringify(panels?.ids)} · tuiPluginHost at apply: ${present.tuiPluginHost === true} · later: ${JSON.stringify(entries.find(entry => entry.event === 'later'))}`)

  check(!readLines(join(root, '.dsh-tui', 'restart.log')).some(line => / pid=\d+ crash /.test(line)),
    'no crash in restart.log', readLines(join(root, '.dsh-tui', 'restart.log')).join('\n'))
  check(screen.includes('❯'), 'the screen is still the mounted Claude session after the composition', `tail: ${lines(screen).slice(-3).join(' / ')}`)
  }
} finally {
  await t.closeQuiet()
  if (before && fail === undefined) {
    // 反证模式：报告文件必须是空的（没有组合，插件就没有 apply）。
    check(readJsonLines(report).length === 0, 'before: the third-party plugin never applied (no composition)')
  }
  if (!flag('--keep')) rmSync(root, { recursive: true, force: true })
  else console.log(`(kept: ${root})`)
}

console.log(failures.length === 0 ? 'PROBE_LITE_ENTRY_OK' : `PROBE_LITE_ENTRY_MISMATCH (${failures.join(', ')})`)
process.exitCode = failures.length === 0 ? 0 : 1
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
