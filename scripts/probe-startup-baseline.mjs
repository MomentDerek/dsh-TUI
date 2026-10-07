/**
 * Opt-in startup timing probe (docs/standalone-host-design.md, Phase 0
 * baseline), not a CI check.
 *
 * Run: pnpm compile && node scripts/probe-startup-baseline.mjs [--backend dsh|claude] [--entry host|host-dsh|profile] [--runs 5]
 *
 * Requires the installed dsh and dsh-tui profile (like
 * verify-installed-startup.mjs) and the host's node-pty. Copies the profile
 * into an isolated HOME (scripts/lib/isolated-profile.mjs: this checkout's
 * `bin/` and `lib/`, its Claude Agent SDK linked in), and starts the
 * profile launcher in a PTY with `DSH_TUI_BOOT_TRACE`. Each run waits for the
 * post-render injection endpoint and the painted prompt, then sends /quit.
 * Never submits a model request and never touches the real profile; the
 * dsh-purge bundle is left out because it rewrites the global dsh bin.js.
 *
 * Prints, per run and as medians, milliseconds from spawn to: the dsh
 * process start, the dsh-tui row's apply, session open start/end, render
 * start/done, the injection endpoint, and the painted prompt. A run ends
 * once the trace shows `render-done` (plus up to 1.5s for the screen
 * columns), then the TUI gets SIGTERM.
 *
 * Known gap (2026-10-06, WSL): under this PTY the TUI renders only empty
 * frames — with this checkout's lib and with the installed one alike — so
 * `inject`/`prompt` stay empty there; the trace columns do not depend on it.
 *
 * Debug switches: PROBE_TIMEOUT_MS (per-run wait for render, default 90000),
 * PROBE_DEBUG=1 (byte counter on stderr), PROBE_SCREEN=1 (print each run's
 * final screen on stderr), PROBE_KEEP=1 (keep the isolated
 * root and print its path).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import xterm from '@xterm/headless'
import { buildIsolatedProfile } from './lib/isolated-profile.mjs'
import { settled } from './lib/term-test.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const backend = option('--backend', 'dsh')
// `--entry host` (default): the launcher routes as shipped, so the Claude
// kernel runs in the package's own entry (lib/types/dsh-adapter/host-entry.js).
// `--entry profile`: DSH_TUI_HOST_ENTRY=0, every kernel inside `dsh --profile`
// (the Phase 0 baseline path). `--entry host-dsh`: as `host`, plus
// DSH_TUI_HOST_ENTRY_DSH=1, so the DSH kernel runs in the entry too (Phase 2
// single root: the screen first, then the profile composes into the same
// root). All count from spawning the launcher.
const entryMode = option('--entry', 'host')
if (entryMode !== 'host' && entryMode !== 'host-dsh' && entryMode !== 'profile') throw new Error(`--entry host|host-dsh|profile, got ${entryMode}`)
const runs = Number(option('--runs', '5'))
const repo = fileURLToPath(new URL('..', import.meta.url))
const { root, dshHome: targetHome, launcher, dshEntry, dshBin } = buildIsolatedProfile({ repo, prefix: 'dsh-tui-baseline-' })
const pty = createRequire(dshEntry)('node-pty')

// ── one run ────────────────────────────────────────────────────────────────
const COLS = 100
const ROWS = 32
async function run(index) {
  rmSync(join(root, '.dsh-tui'), { recursive: true, force: true })
  rmSync(join(root, 'sessions'), { recursive: true, force: true })
  const trace = join(root, `trace-${index}.jsonl`)
  const env = {
    ...process.env,
    HOME: root,
    // The relocated dsh first (see scripts/lib/isolated-profile.mjs).
    PATH: `${dshBin}${delimiter}${process.env.PATH ?? ''}`,
    USERPROFILE: root,
    DSH_HOME: targetHome,
    DSH_TUI_SESSION_ROOT: join(root, 'sessions'),
    DSH_TUI_WORKSPACE_TARGET: process.cwd(),
    DSH_TUI_BACKEND: backend,
    ...(entryMode === 'profile' ? { DSH_TUI_HOST_ENTRY: '0' } : {}),
    ...(entryMode === 'host-dsh' ? { DSH_TUI_HOST_ENTRY_DSH: '1' } : {}),
    DSH_TUI_BOOT_TRACE: trace,
    DSH_TUI_LANG: 'en',
    DSH_TELEMETRY_MODE: 'DISABLED',
    NODE_ENV: 'production',
    TERM: 'xterm-256color',
  }
  for (const key of ['DSH_TUI_RESUME_SESSION', 'DSH_TUI_RESTART_CHILD', 'DSH_TUI_RESTART_SESSION', 'DSH_TUI_PREBOOT', 'DSH_TUI_DEBUG', 'DSH_TUI_BACKEND_HANDOFF', 'DSH_TUI_HOST_ENTRY_PATH', 'DSH_TUI_PROFILE', ...(entryMode === 'profile' ? [] : ['DSH_TUI_HOST_ENTRY']), ...(entryMode === 'host-dsh' ? [] : ['DSH_TUI_HOST_ENTRY_DSH'])]) delete env[key]
  const terminal = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
  const startedAt = Date.now()
  const child = pty.spawn(process.execPath, [launcher], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(), env })
  let exit
  let output = ''
  terminal.onData(data => { if (exit === undefined) child.write(data) })
  child.onData(data => { output = (output + data).slice(-256 * 1024); terminal.write(data) })
  child.onExit(event => { exit = event })
  const screen = () => {
    const buffer = terminal.buffer.active
    return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').join('\n')
  }
  const discovery = join(root, '.dsh-tui', 'inject', 'servers.json')
  const injected = () => {
    try { return JSON.parse(readFileSync(discovery, 'utf8')).length > 0 } catch { return false }
  }
  const at = {}
  const debug = process.env.PROBE_DEBUG === '1' ? setInterval(() => { console.error(`[probe] +${Date.now() - startedAt}ms bytes=${output.length} exit=${exit?.exitCode}`) }, 1000) : undefined
  const watch = setInterval(() => {
    if (at.inject === undefined && injected()) at.inject = Date.now() - startedAt
    if (at.prompt === undefined && screen().includes('❯')) at.prompt = Date.now() - startedAt
  }, 5)
  const traced = name => existsSync(trace) && readFileSync(trace, 'utf8').includes(`"mark":"${name}"`)
  try {
    // The trace is the measurement; the screen columns are best effort (see
    // the header: in some PTY setups the TUI paints nothing).
    const ok = await settled(() => exit !== undefined || (traced('render-done') && (!traced('entry-modules') || traced('startup-adopted'))), { timeoutMs: Number(process.env.PROBE_TIMEOUT_MS ?? 90000) })
    if (!ok || exit !== undefined) throw new Error(`run ${index}: no render (exit ${exit?.exitCode})\ntrace: ${existsSync(trace) ? readFileSync(trace, 'utf8') : 'none'}\nraw(${output.length}): ${JSON.stringify(output.slice(-1500))}`)
    await settled(() => at.inject !== undefined && at.prompt !== undefined, { timeoutMs: 1500 })
    if (process.env.PROBE_SCREEN === '1') console.error(`[probe] screen of run ${index}:\n${screen()}`)
    child.kill('SIGTERM')
    await settled(() => exit !== undefined, { timeoutMs: 10000 })
  } finally {
    clearInterval(watch)
    if (debug !== undefined) clearInterval(debug)
    if (exit === undefined) child.kill('SIGKILL')
    terminal.dispose()
  }
  const marks = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const first = marks[0]
  const result = { ...at }
  if (first !== undefined) result['dsh-process'] = first.at - first.ms - startedAt
  for (const mark of marks) result[mark.mark] ??= mark.at - startedAt
  return result
}

const COLUMNS = ['dsh-process', 'entry-start', 'entry-hijacked', 'entry-modules', 'entry-config', 'entry-compose-start', 'entry-compose-end', 'entry-dsh-attach', 'row-apply', 'runtime-apply', 'session-open-start', 'session-open-end', 'settings-wait-start', 'settings-wait-end', 'render-start', 'render-done', 'inject', 'prompt', 'startup-adopted']
const results = []
try {
  for (let index = 0; index < runs; index += 1) {
    const result = await run(index)
    results.push(result)
    console.log(`run ${index + 1}: ${COLUMNS.map(name => `${name}=${result[name] ?? '-'}`).join(' ')}`)
  }
} finally {
  if (process.env.PROBE_KEEP === '1') console.error(`[probe] kept ${root}`)
  else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) // a CLI that just got TERM may still be writing
}
const median = values => {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b)
  return sorted.length === 0 ? '-' : sorted[Math.floor(sorted.length / 2)]
}
console.log(`\nbackend=${backend} entry=${entryMode} runs=${runs} (ms from spawn of the profile launcher, median)`)
for (const name of COLUMNS) console.log(`  ${name.padEnd(20)} ${median(results.map(result => result[name]))}`)
process.exit(0)
