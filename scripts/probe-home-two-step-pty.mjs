#!/usr/bin/env node
/**
 * Measures the DSH home's two-step appearance in a real PTY (the home shows
 * 1–2s after the adoption; docs/standalone-host-design.md, ruling 3 of 2026-10-09).
 *
 * On the entry-hosted DSH kernel the screen mounts on a placeholder session
 * (`channel.ready === false`), so Chat holds the two DSH boot screens
 * (Chat.tsx `heldBootScreensRef`) and opens them from the effect that watches
 * `channel.ready`. This probe measures, per run and in wall-clock ms from the
 * spawn of the profile launcher:
 *
 *   firstText   the first non-blank screen text (the mounted first frame)
 *   starting    "Starting DSH…" reaches the screen (the placeholder status line)
 *   prompt      the composer prompt is painted
 *   home        "This terminal hosts several sessions" (the sessions home)
 *
 * and the same run's boot marks (DSH_TUI_BOOT_TRACE), so the wait can be split
 * into: render-done → entry-dsh-open → entry-dsh-opened → entry-dsh-owned →
 * startup-adopted (the real compose/open pipeline) and startup-adopted → home
 * (the React effect plus the renderer's frames).
 *
 * The scenario is the one `accept-host-entry.mjs` case `dsh-home-held` uses: an
 * ordinary first launch — no workspace target, no resume, chat page
 * (DSH_TUI_NO_LAUNCHPAD=1), no onboarding, a fresh ~/.dsh-tui (so the one-shot
 * `home.json` marker is absent). `--entry profile` (DSH_TUI_HOST_ENTRY=0) is the
 * control: there the session is bound at construction, `ready` is true on the
 * first frame, and the home opens with it.
 *
 * Run: pnpm compile && node scripts/probe-home-two-step-pty.mjs [--runs 3]
 *      [--rows 44] [--cols 100] [--entry host|profile] [--text '<marker>']
 *
 * Rows default to 44: 30 rows is the known-failing height for the landing page
 * (accept-host-entry's dsh-in-entry-landing / dsh-default-starting-landing) and
 * is not this probe's question. `--text` overrides the home marker (e.g. the
 * landing page: it is painted on the first frame, so it measures nothing).
 *
 * Opt-in, not a CI gate. Needs the installed `dsh` with its dsh-tui profile,
 * `pnpm compile`, and Linux or macOS. PROBE_KEEP=1 keeps the isolated root and
 * prints its path; PROBE_TIMEOUT_MS bounds one run (default 60000).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const runs = Number(option('--runs', '3'))
const COLS = Number(option('--cols', '100'))
const ROWS = Number(option('--rows', '44'))
const entryMode = option('--entry', 'host')
if (!['host', 'profile'].includes(entryMode)) throw new Error(`--entry host|profile, got ${entryMode}`)
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 60000)
/** The sessions home's subtitle (src/i18n.ts 'supervisor-subtitle', en). */
const homeMarker = option('--text', 'This terminal hosts several sessions')
const repo = fileURLToPath(new URL('..', import.meta.url))
const { root, dshHome, launcher, dshEntry, dshBin } = buildIsolatedProfile({ repo, prefix: 'dsh-tui-home-step-' })
const pty = createRequire(dshEntry)('node-pty')

/** One ordinary first launch; `--entry profile` is the same launch through `dsh --profile`. */
async function run(index) {
  rmSync(join(root, '.dsh-tui'), { recursive: true, force: true })
  rmSync(join(root, 'sessions'), { recursive: true, force: true })
  mkdirSync(join(root, '.dsh-tui'), { recursive: true })
  // Past the first-run guide: the home must be the only held screen.
  writeFileSync(join(root, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
  const trace = join(root, `trace-home-${index}.jsonl`)
  rmSync(trace, { force: true })
  const env = {
    HOME: root,
    PATH: `${dshBin}${delimiter}${process.env.PATH ?? ''}`,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DSH_HOME: dshHome,
    DSH_TUI_SESSION_ROOT: join(root, 'sessions'),
    DSH_TUI_BACKEND: 'dsh',
    DSH_TUI_NO_LAUNCHPAD: '1',
    DSH_TUI_LANG: 'en',
    DSH_TUI_BOOT_TRACE: trace,
    DSH_TELEMETRY_MODE: 'DISABLED',
    NODE_ENV: 'production',
    ...(entryMode === 'profile' ? { DSH_TUI_HOST_ENTRY: '0' } : {}),
  }
  const terminal = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
  const startedAt = Date.now()
  const child = pty.spawn(process.execPath, [launcher], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: repo, env })
  let exit
  let output = ''
  terminal.onData(data => { if (exit === undefined) child.write(data) })
  child.onData(data => { output = (output + data).slice(-256 * 1024); terminal.write(data) })
  child.onExit(event => { exit = event })
  const screen = () => {
    const buffer = terminal.buffer.active
    return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').join('\n')
  }
  const at = {}
  const debug = process.env.PROBE_DEBUG === '1' ? setInterval(() => {
    console.error(`[probe] +${Date.now() - startedAt}ms bytes=${output.length} exit=${exit?.exitCode}`)
  }, 1000) : undefined
  // 5ms: the question is a 1–2s gap, so the polling interval is noise.
  const watch = setInterval(() => {
    const now = Date.now() - startedAt
    const text = screen()
    if (at.firstText === undefined && text.trim() !== '') at.firstText = now
    if (at.starting === undefined && text.includes('Starting DSH')) at.starting = now
    if (at.prompt === undefined && text.includes('❯')) at.prompt = now
    if (at.home === undefined && text.includes(homeMarker)) at.home = now
  }, 5)
  try {
    const reached = await settled(() => exit !== undefined || at.home !== undefined, { timeoutMs })
    if (exit !== undefined) throw new Error(`run ${index}: exited early (code ${exit.exitCode})\nraw(${output.length}): ${JSON.stringify(output.slice(-1500))}`)
    if (!reached) {
      console.error(`[probe] run ${index}: "${homeMarker}" never reached the screen; last screen:\n${screen()}`)
    }
    if (process.env.PROBE_SCREEN === '1') console.error(`[probe] screen of run ${index}:\n${screen()}`)
    child.kill('SIGTERM')
    await settled(() => exit !== undefined, { timeoutMs: 10000 })
  } finally {
    clearInterval(watch)
    if (debug !== undefined) clearInterval(debug)
    if (exit === undefined) child.kill('SIGKILL')
    terminal.dispose()
  }
  const marks = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const first = marks[0]
  const result = { ...at }
  // The first mark carries the process's own clock start: spawn overhead is
  // the difference, like probe-startup-baseline.mjs.
  if (first !== undefined) result['dsh-process'] = first.at - first.ms - startedAt
  for (const mark of marks) result[mark.mark] ??= mark.at - startedAt
  return result
}

/** A mark two marks never saw (both absent, e.g. the profile path): '-'. */
const fmt = value => (typeof value === 'number' && Number.isFinite(value) ? value : '-')
const delta = (result, from, to) => {
  const a = result[from]
  const b = result[to]
  return typeof a === 'number' && typeof b === 'number' ? b - a : Number.NaN
}

const COLUMNS = [
  'dsh-process', 'entry-start', 'entry-modules', 'entry-compose-start', 'entry-compose-end',
  'entry-dsh-attach', 'entry-dsh-open', 'entry-dsh-opened', 'entry-dsh-owned',
  'render-start', 'render-done', 'firstText', 'starting', 'prompt', 'startup-adopted', 'home',
]
const DERIVED = [
  ['compose(compose-start→end)', result => delta(result, 'entry-compose-start', 'entry-compose-end')],
  ['attach(compose-end→dsh-open)', result => delta(result, 'entry-compose-end', 'entry-dsh-open')],
  ['open(dsh-open→opened)', result => delta(result, 'entry-dsh-open', 'entry-dsh-opened')],
  ['adopted(owned→adopted)', result => delta(result, 'entry-dsh-owned', 'startup-adopted')],
  ['STEP1(render-done→adopted)', result => delta(result, 'render-done', 'startup-adopted')],
  ['STEP2(adopted→home)', result => delta(result, 'startup-adopted', 'home')],
  ['TWO_STEP(firstText→home)', result => delta(result, 'firstText', 'home')],
  ['frame(firstText→prompt)', result => delta(result, 'firstText', 'prompt')],
]
const results = []
try {
  for (let index = 0; index < runs; index += 1) {
    const result = await run(index)
    results.push(result)
    console.log(`run ${index + 1}: ${COLUMNS.map(name => `${name}=${fmt(result[name])}`).join(' ')}`)
    console.log(`        ${DERIVED.map(([name, of]) => `${name}=${fmt(of(result))}`).join(' ')}`)
  }
} finally {
  if (process.env.PROBE_KEEP === '1') console.error(`[probe] kept ${root}`)
  else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
const median = values => {
  const sorted = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  return sorted.length === 0 ? '-' : sorted[Math.floor(sorted.length / 2)]
}
console.log(`\nDSH home two-step, entry=${entryMode} runs=${runs} rows=${ROWS} (ms from spawn of the profile launcher, median)`)
for (const name of COLUMNS) console.log(`  ${name.padEnd(28)} ${median(results.map(result => result[name]))}`)
for (const [name, of] of DERIVED) console.log(`  ${name.padEnd(28)} ${median(results.map(of))}`)
process.exit(0)
