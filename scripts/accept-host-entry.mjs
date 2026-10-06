#!/usr/bin/env node
/**
 * Phase 1 acceptance for the standalone host (docs/standalone-host-design.md,
 * the checklist at the end of "Phase 1 第 3 块"), driven in a real terminal
 * emulator: @microsoft/tui-test runs this checkout's launcher in a PTY whose
 * screen model answers terminal queries (DA1 and friends) like a real one.
 * The launcher runs inside an isolated copy of the installed profile
 * (scripts/lib/isolated-profile.mjs), so the real profile and ~/.dsh-tui stay
 * untouched.
 *
 * Opt-in, not a CI gate. Needs the installed `dsh` and its dsh-tui profile,
 * the `claude` CLI on PATH, `pnpm compile`, and Linux or macOS (the TUI is
 * started under `env -i` so the case's environment is exact).
 *
 * Credentials: the isolated HOME gets a link to ~/.claude/.credentials.json
 * (a link, so a token refresh lands in the real file) and a copy of
 * ~/.claude.json; the isolated DSH_HOME a link to the DeepSeek
 * .credentials.yaml. `--no-auth` skips all three. No case sends a
 * model request unless DSH_TUI_CLAUDE_LIVE=1 (then `live-send` sends one
 * short prompt).
 *
 * A slow or failing session open comes from a fake `claude`
 * (CLAUDE_CODE_EXECUTABLE) that answers `--version` from the real CLI and,
 * for a session, waits FAKE_CLAUDE_DELAY seconds and refuses while
 * FAKE_CLAUDE_FAIL_FILE exists before exec'ing the real CLI.
 *
 * Cases (`--only a,b` picks some). `-landing` starts on the landing page (a
 * fresh launch), `-chat` on the chat page (DSH_TUI_NO_LAUNCHPAD=1): each has
 * its own Enter and command paths.
 *   startup-fullscreen     first frame, alt screen, adoption, /quit restores
 *   startup-inline         the same in inline mode at 60 columns (chat page:
 *                          the landing page takes the alt screen in any mode)
 *   startup-not-ready-*    Enter during the open keeps the draft and queues
 *                          nothing, a session command is refused, /help runs
 *   open-failed-*          the failure and the /new hint are on screen; /new
 *                          then opens a session
 *   initial-prompt-held    a command-line prompt reaches the entry and waits
 *                          for the session (here one that fails to open)
 *   quit-while-starting    /quit before adoption: exit 0, terminal restored,
 *                          no claude process left
 *   ctrlc-while-starting   Ctrl+C twice before adoption: the same
 *   sigterm-while-starting SIGTERM to the entry before adoption: the same,
 *                          ending by the signal (no safe-mode prompt)
 *   restart-*              /restart comes back through the entry on Claude
 *   kernel-to-dsh-*        /kernel → DSH hands over to `dsh --profile`: the
 *                          DSH screen comes up, the old process keeps
 *                          supervising, /quit there restores the terminal
 *   dsh-to-claude          a DSH launch, /kernel → Claude restarts into the
 *                          entry and adopts a Claude session
 *   live-send              DSH_TUI_CLAUDE_LIVE=1 only: one prompt round-trip
 *   live-initial-prompt    DSH_TUI_CLAUDE_LIVE=1 only: a command-line prompt
 *                          is sent once the session is adopted
 *
 * Every case checks the terminal state after exit (alt screen left, cursor
 * shown, bracketed paste, focus reporting and mouse tracking off) and, on
 * Linux (/proc), that no process carrying the case's marker variable is
 * left; elsewhere that check is reported as skipped.
 *
 * DSH_TUI_DEBUG_MOUSE=1 is passed through to the TUI: alt-screen enter/exit
 * and 1049 writes land in <isolated root>/.dsh-tui/mouse-debug.log (with
 * `--keep`).
 *
 * Run: pnpm compile && node scripts/accept-host-entry.mjs [--only a,b] [--keep] [--no-auth]
 * `--keep` keeps the isolated root (credentials link included) and prints it.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TuiTest } from '@microsoft/tui-test'
import { buildIsolatedProfile, executable } from './lib/isolated-profile.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
if (process.platform === 'win32') throw new Error('accept-host-entry: Linux or macOS only (env -i)')
const live = process.env.DSH_TUI_CLAUDE_LIVE === '1'
const only = option('--only')?.split(',')

const repo = fileURLToPath(new URL('..', import.meta.url))
const { root, dshHome, launcher, dshBin } = buildIsolatedProfile({ repo, prefix: 'dsh-tui-accept-' })
const realClaude = executable('claude')
if (!flag('--no-auth')) {
  mkdirSync(join(root, '.claude'), { recursive: true })
  const credentials = join(homedir(), '.claude', '.credentials.json')
  if (existsSync(credentials)) symlinkSync(credentials, join(root, '.claude', '.credentials.json'))
  const state = join(homedir(), '.claude.json')
  if (existsSync(state)) copyFileSync(state, join(root, '.claude.json'))
  // The DSH kernel's DeepSeek credentials, linked the same way.
  const dshCredentials = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  if (existsSync(dshCredentials)) symlinkSync(dshCredentials, join(dshHome, '.credentials.yaml'))
}
const fakeClaude = join(root, 'fake-claude.sh')
writeFileSync(fakeClaude, `#!/bin/sh
case "$1" in --version|-v) exec '${realClaude}' "$@";; esac
sleep "\${FAKE_CLAUDE_DELAY:-0}"
if [ -n "$FAKE_CLAUDE_FAIL_FILE" ] && [ -e "$FAKE_CLAUDE_FAIL_FILE" ]; then
  echo "fake claude: refusing to start" >&2
  exit 1
fi
exec '${realClaude}' "$@"
`)
chmodSync(fakeClaude, 0o755)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lines = text => text.split('\n').filter(line => line.trim() !== '')
const readLines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []

/** Processes whose environment carries `marker` (Linux /proc only). */
function markedProcesses(marker) {
  if (!existsSync('/proc/self/environ')) return []
  const found = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'latin1').includes(marker)) {
        found.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'latin1').replaceAll('\0', ' ').slice(0, 120)}`)
      }
    } catch { /* gone or not ours */ }
  }
  return found
}

/** One TUI run: a fresh ~/.dsh-tui and session store, its own trace and marker. */
async function launch(name, { env = {}, cols = 100, rows = 30, settings, landing = true, args = [], backend = 'claude' } = {}) {
  rmSync(join(root, '.dsh-tui'), { recursive: true, force: true })
  rmSync(join(root, 'sessions'), { recursive: true, force: true })
  // Past the first-run guide (the DSH kernel opens on it otherwise).
  mkdirSync(join(root, '.dsh-tui'), { recursive: true })
  writeFileSync(join(root, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
  if (settings !== undefined) {
    mkdirSync(join(root, '.dsh-tui'), { recursive: true })
    writeFileSync(join(root, '.dsh-tui', 'settings.json'), JSON.stringify({ version: 1, values: settings, imported: { from: 'none', at: 0 } }))
    // Without this marker the first boot clears a `fullscreen: false` as a
    // leftover of the old factory default.
    writeFileSync(join(root, '.dsh-tui', 'migrations.json'), JSON.stringify({ 'fullscreen-factory-default': new Date(0).toISOString() }))
  }
  const trace = join(root, `trace-${name}.jsonl`)
  rmSync(trace, { force: true })
  const marker = `accept-${randomUUID()}`
  const full = {
    HOME: root,
    // The relocated dsh first (see scripts/lib/isolated-profile.mjs).
    PATH: `${dshBin}:${process.env.PATH ?? ''}`,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DSH_HOME: dshHome,
    DSH_TUI_SESSION_ROOT: join(root, 'sessions'),
    DSH_TUI_WORKSPACE_TARGET: repo,
    ...(backend === undefined ? {} : { DSH_TUI_BACKEND: backend }),
    DSH_TUI_LANG: 'en',
    DSH_TUI_BOOT_TRACE: trace,
    DSH_TELEMETRY_MODE: 'DISABLED',
    NODE_ENV: 'production',
    DSH_TUI_ACCEPT_MARKER: marker,
    ...(process.env.DSH_TUI_DEBUG_MOUSE ? { DSH_TUI_DEBUG_MOUSE: '1' } : {}),
    CLAUDE_CODE_EXECUTABLE: fakeClaude,
    // A fresh launch opens on the landing page; without it, on the chat page.
    ...(landing ? {} : { DSH_TUI_NO_LAUNCHPAD: '1' }),
    ...env,
  }
  const t = TuiTest.ephemeral(`accept-${name}`)
  const startedAt = Date.now()
  await t.run('/usr/bin/env', ['-i', ...Object.entries(full).map(([key, value]) => `${key}=${value}`), process.execPath, launcher, ...args], { cols, rows, cwd: repo })
  const marks = () => readLines(trace).map(line => JSON.parse(line))
  return {
    t,
    marker,
    startedAt,
    marks,
    traced: (mark, predicate = () => true) => marks().some(entry => entry.mark === mark && predicate(entry)),
    restartLog: () => readLines(join(root, '.dsh-tui', 'restart.log')),
    screen: async () => await t.text(),
    /** Empty the prompt (Ctrl+U is not a clear in every surface). The
     *  landing page drops keys that arrive in one input batch, so there
     *  each Backspace gets its own tick. */
    async clear(count = 40) {
      for (let index = 0; index < count; index += 1) {
        await t.press('Backspace')
        if (landing) await sleep(20)
      }
      await sleep(200)
    },
    async command(text) {
      await t.type(text)
      // The command menu opens on the typed name; Enter then runs its row.
      await sleep(400)
      await t.press('Enter')
    },
  }
}

const results = []
async function runCase(name, body) {
  if (only !== undefined && !only.includes(name)) return
  const checks = []
  let status = 'pass'
  const check = (label, ok, detail) => {
    checks.push({ label, ok, ...(ok || detail === undefined ? {} : { detail }) })
    if (!ok) status = 'fail'
  }
  let run
  const started = Date.now()
  try {
    await body({
      check,
      launch: async (options) => (run = await launch(name, options)),
    })
  } catch (error) {
    status = 'fail'
    checks.push({ label: 'case threw', ok: false, detail: `${error instanceof Error ? error.message : String(error)}${run === undefined ? '' : `\n--- screen ---\n${lines(await run.screen().catch(() => '')).slice(-20).join('\n')}`}` })
  } finally {
    await run?.t.closeQuiet()
  }
  results.push({ name, status, ms: Date.now() - started, checks })
  const mark = status === 'pass' ? 'PASS' : 'FAIL'
  console.log(`${mark} ${name} (${Date.now() - started}ms)`)
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok ' : 'NO '} ${item.label}`)
    if (item.detail !== undefined) console.log(item.detail.split('\n').map(line => `      ${line}`).join('\n'))
  }
}

/** Exit, the terminal state the shell gets back, and no marked process left. */
async function checkExit(run, check, { code } = {}) {
  await run.t.waitExit({ timeout: 20000 })
  const state = await run.t.state()
  if (code !== undefined) check(`exit code ${code}`, state.exited === code, `exited=${state.exited} signal=${state.exit_signal}`)
  const modes = state.modes
  check('terminal restored (alt screen, cursor, paste, focus, mouse)',
    modes.alternate_screen === false && modes.cursor_visible === true && modes.bracketed_paste === false && modes.focus_events === false && state.mouse_mode === 'none',
    JSON.stringify({ ...modes, mouse_mode: state.mouse_mode }))
  if (!existsSync('/proc/self/environ')) {
    check('no process left behind (skipped: no /proc)', true)
    return
  }
  // The Claude CLI exits on its own once stdin closes; give it a moment.
  let left = markedProcesses(run.marker)
  for (let waited = 0; left.length > 0 && waited < 5000; waited += 250) {
    await sleep(250)
    left = markedProcesses(run.marker)
  }
  check('no process left behind', left.length === 0, left.join('\n'))
}

const until = async (predicate, timeoutMs, stepMs = 100) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return await predicate()
}

const NOT_READY = 'is still starting'
const PROMPT = '❯'

// ── 1. startup ───────────────────────────────────────────────────────────
for (const [name, settings, cols] of [['startup-fullscreen', undefined, 100], ['startup-inline', { fullscreen: false }, 60]]) {
  await runCase(name, async ({ check, launch }) => {
    // The landing page takes the alternate screen in inline mode too.
    const run = await launch({ settings, cols, landing: settings === undefined })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    check(`first frame (${Date.now() - run.startedAt}ms after spawn)`, true)
    check('runs in the package entry, not dsh', run.traced('entry-start') && !run.traced('row-apply'), JSON.stringify(run.marks().map(entry => entry.mark)))
    const state = await run.t.state()
    check(`alt screen ${settings === undefined ? 'on' : 'off'}`, state.modes.alternate_screen === (settings === undefined), JSON.stringify(state.modes))
    check('session adopted', await until(() => run.traced('startup-adopted'), 30000))
    const settingsFile = join(root, '.dsh-tui', 'settings.json')
    check('settings.json present', existsSync(settingsFile))
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
}

// ── 1b. Enter while the session is still opening ─────────────────────────
// On the landing page (a fresh launch) and on the chat page: each has its
// own Enter path.
for (const landing of [true, false]) {
  await runCase(`startup-not-ready-${landing ? 'landing' : 'chat'}`, async ({ check, launch }) => {
    const run = await launch({ env: { FAKE_CLAUDE_DELAY: '12' }, landing })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    await sleep(500)
    await run.t.type('hello early')
    await sleep(300)
    await run.t.press('Enter')
    check('Enter says the backend is still starting', await until(async () => (await run.screen()).includes(NOT_READY), 3000), lines(await run.screen()).slice(-8).join('\n'))
    check('the draft stays', (await run.screen()).includes('hello early'))
    check('nothing queued', !(await run.screen()).includes('Queued'))
    await run.clear()
    await run.command('/status')
    check('a session command is refused with the notice', await until(async () => (await run.screen()).includes(NOT_READY), 3000))
    check('the session command did not run', !(await run.screen()).includes('Status   '))
    await run.clear()
    await run.command('/help')
    check('/help runs while starting', await until(async () => (await run.screen()).includes('for this help'), 3000), lines(await run.screen()).slice(-8).join('\n'))
    await run.t.press('Escape')
    await sleep(300)
    check('still not adopted while checking', !run.traced('startup-adopted'))
    await run.clear()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
}

// ── 1c. a failed open, then /new ─────────────────────────────────────────
for (const landing of [true, false]) {
  await runCase(`open-failed-${landing ? 'landing' : 'chat'}`, async ({ check, launch }) => {
    const failFile = join(root, 'fail-claude')
    writeFileSync(failFile, '')
    const run = await launch({ env: { FAKE_CLAUDE_FAIL_FILE: failFile }, landing })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    // The CLI exits at once, so the failure lands within a few seconds; no
    // trace mark records it.
    check('the failure is on screen, naming /new', await until(async () => (await run.screen()).includes('failed to open') && (await run.screen()).includes('/new to retry'), 8000), lines(await run.screen()).slice(-8).join('\n'))
    check('not adopted', !run.traced('startup-adopted'))
    rmSync(failFile)
    await run.command('/new')
    // Ready shows as a session command running instead of the refusal.
    let refused = true
    await until(async () => {
      await run.clear()
      await run.command('/status')
      await sleep(800)
      refused = (await run.screen()).includes(NOT_READY)
      await run.t.press('Escape')
      return !refused
    }, 30000, 1500)
    check('/new opens a session (a session command runs)', !refused, lines(await run.screen()).slice(-10).join('\n'))
    await run.clear()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
}

// ── 1d. a command-line prompt waits for the session ──────────────────────
await runCase('initial-prompt-held', async ({ check, launch }) => {
  const failFile = join(root, 'fail-claude')
  writeFileSync(failFile, '')
  const run = await launch({ env: { FAKE_CLAUDE_FAIL_FILE: failFile }, args: ['hello from argv'] })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check('the prompt reaches the entry (no landing page)', await until(async () => (await run.screen()).includes('failed to open'), 8000), lines(await run.screen()).slice(-8).join('\n'))
  check('held while the session is not open (nothing queued)', !(await run.screen()).includes('Queued'))
  rmSync(failFile)
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

// ── 4. leaving before the session opens ──────────────────────────────────
for (const [name, leave] of [
  ['quit-while-starting', async run => { await run.command('/quit') }],
  ['ctrlc-while-starting', async run => { await run.t.press('Ctrl+C'); await sleep(300); await run.t.press('Ctrl+C') }],
  // To the entry process: the launcher does not forward signals (nor does
  // it for dsh on main), so a TERM to the launcher only ends the launcher.
  ['sigterm-while-starting', async run => {
    const entry = run.marks().find(mark => mark.mark === 'entry-start')
    if (entry === undefined) throw new Error('no entry-start mark: the entry process is not running')
    process.kill(entry.pid, 'SIGTERM')
  }],
]) {
  await runCase(name, async ({ check, launch }) => {
    const run = await launch({ env: { FAKE_CLAUDE_DELAY: '4' } })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    await sleep(500)
    check('still opening', !run.traced('startup-adopted'))
    await leave(run)
    await checkExit(run, check, name === 'sigterm-while-starting' ? {} : { code: 0 })
    const state = await run.t.state()
    // The entry dies by the signal after its cleanup; the launcher passes a
    // signal death on (a numeric 143 would read as a crash).
    if (name === 'sigterm-while-starting') check('ends by SIGTERM, no safe-mode prompt', state.exit_signal !== null && !(await run.screen()).includes('safe mode'), `exited=${state.exited} signal=${state.exit_signal}`)
  })
}

// ── 3. /restart on the Claude kernel ─────────────────────────────────────
for (const landing of [true, false]) await runCase(`restart-${landing ? 'landing' : 'chat'}`, async ({ check, launch }) => {
  const run = await launch({ landing })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check('adopted', await until(() => run.traced('startup-adopted'), 30000))
  const firstPid = run.marks().find(entry => entry.mark === 'entry-start')?.pid
  await run.command('/restart')
  check('restart accepted', await until(() => run.restartLog().some(line => line.includes('/restart accepted')), 10000), run.restartLog().slice(-5).join('\n'))
  check('a new entry process starts', await until(() => run.traced('entry-start', entry => entry.pid !== firstPid), 30000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
  check('and adopts its session', await until(() => run.traced('startup-adopted', entry => entry.pid !== firstPid), 30000))
  check('never through dsh', !run.traced('row-apply'))
  await run.t.getByText(PROMPT).expect({ timeout: 10000 })
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

// ── 2. /kernel both ways ──────────────────────────────────────────────────
// The DSH kernel's status line names its DeepSeek model.
const DSH_SCREEN = 'deepseek'
const pickKernel = async (run, up) => {
  await run.command('/kernel')
  await run.t.getByText('Choose kernel').expect({ timeout: 5000 })
  await run.t.press(up ? 'Up' : 'Down')
  await sleep(200)
  await run.t.press('Enter')
}
/** The old process stays as the replacement's supervisor: a late timer in
 *  its tree (the migration hint fires 12s after mount) once crashed it, the
 *  launcher offered safe mode and the replacement ran on in the background. */
const checkSupervised = async (run, check) => {
  await sleep(15000)
  check('the old process still supervises 15s later (no safe-mode prompt)', (await run.t.state()).exited === null && !(await run.screen()).includes('safe mode'), lines(await run.screen()).slice(-4).join('\n'))
}
for (const landing of [true, false]) await runCase(`kernel-to-dsh-${landing ? 'landing' : 'chat'}`, async ({ check, launch }) => {
  const run = await launch({ landing })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check('adopted', await until(() => run.traced('startup-adopted'), 30000))
  await pickKernel(run, true)
  check('switch accepted', await until(() => run.restartLog().some(line => line.includes('backend switch accepted')), 10000), run.restartLog().slice(-5).join('\n'))
  check('the entry hands over to dsh (a dsh-tui row applies)', await until(() => run.traced('row-apply'), 60000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
  check('the DSH screen is up', await until(async () => (await run.screen()).includes(DSH_SCREEN), 60000), lines(await run.screen()).slice(-6).join('\n'))
  check('still on the alternate screen after the handoff', (await run.t.state()).modes.alternate_screen === true)
  await checkSupervised(run, check)
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

await runCase('dsh-to-claude', async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh' })
  check('the DSH screen is up', await until(async () => (await run.screen()).includes(DSH_SCREEN), 60000), lines(await run.screen()).slice(-6).join('\n'))
  check('through dsh (a dsh-tui row applies)', run.traced('row-apply'))
  await pickKernel(run, false)
  check('switch accepted', await until(() => run.restartLog().some(line => line.includes('backend switch accepted')), 10000), run.restartLog().slice(-5).join('\n'))
  check('the replacement is the package entry', await until(() => run.traced('entry-start'), 30000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
  check('and adopts a Claude session', await until(() => run.traced('startup-adopted'), 30000))
  check('the Claude screen is up', await until(async () => !(await run.screen()).includes(DSH_SCREEN) && (await run.screen()).includes(PROMPT), 10000), lines(await run.screen()).slice(-6).join('\n'))
  // J: after the old dsh process released its root, a late Chat render threw
  // into the root error boundary and AlternateScreen's cleanup left the alt
  // screen before the replacement drew (a flash, then the main screen).
  check('still on the alternate screen after the handoff', (await run.t.state()).modes.alternate_screen === true)
  await checkSupervised(run, check)
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

// ── live: one prompt round-trip ──────────────────────────────────────────
if (live) {
  await runCase('live-send', async ({ check, launch }) => {
    const run = await launch({ env: { CLAUDE_CODE_EXECUTABLE: realClaude } })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    check('adopted', await until(() => run.traced('startup-adopted'), 30000))
    await run.t.type('Reply with exactly the word PINEAPPLE-OK and nothing else.')
    await sleep(300)
    await run.t.press('Enter')
    check('reply arrives', await until(async () => (await run.screen()).split('PINEAPPLE-OK').length > 2, 90000), lines(await run.screen()).slice(-10).join('\n'))
    await run.t.press('Escape')
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
  // A command-line prompt is submitted once the session is adopted: the
  // placeholder it would otherwise reach refuses it and nothing replays it.
  await runCase('live-initial-prompt', async ({ check, launch }) => {
    const run = await launch({ env: { CLAUDE_CODE_EXECUTABLE: realClaude }, args: ['Reply with exactly the word MANGO-OK and nothing else.'] })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    check('adopted', await until(() => run.traced('startup-adopted'), 30000))
    check('reply arrives', await until(async () => (await run.screen()).split('MANGO-OK').length > 2, 90000), lines(await run.screen()).slice(-10).join('\n'))
    check('nothing left queued', !(await run.screen()).includes('Queued'))
    // The replacement keeps the app arguments but must not send them again.
    const before = (await run.screen()).split('MANGO-OK').length
    await run.command('/restart')
    check('back after /restart', await until(() => run.marks().filter(entry => entry.mark === 'startup-adopted').length >= 2, 30000))
    await sleep(8000)
    check('the prompt is not sent again', (await run.screen()).split('MANGO-OK').length <= before, lines(await run.screen()).slice(-10).join('\n'))
    await run.t.press('Escape')
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
}

const failed = results.filter(result => result.status === 'fail').length
console.log(`\naccept-host-entry: ${results.length} cases, ${results.filter(result => result.status === 'pass').length} pass, ${failed} fail`)
if (flag('--keep')) console.error(`[accept] kept ${root}`)
else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) // a CLI that just got TERM may still be writing
process.exit(failed > 0 ? 1 : 0)
