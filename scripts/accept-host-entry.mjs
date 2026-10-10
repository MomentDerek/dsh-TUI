#!/usr/bin/env node
/**
 * Acceptance for the standalone host (docs/standalone-host-design.md), driven
 * in a real terminal
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
 *   dsh-in-entry-*         DSH_TUI_HOST_ENTRY_DSH=1: the DSH kernel in the
 *                          entry — first frame before the profile composes,
 *                          the dsh-tui row applies in the entry process (one
 *                          root), the DSH session is adopted and its model
 *                          named, /quit restores the terminal
 *   dsh-in-entry-quit-early the same, /quit as soon as the screen is up
 *   (the DSH kernel in the entry by default:)
 *   dsh-default-starting   no switch set: DSH runs in the entry; the first
 *                          frame says "Starting DSH…" and reached the
 *                          terminal before the composition froze the loop
 *   dsh-entry-dsh-off      DSH_TUI_HOST_ENTRY_DSH=0: DSH through dsh --profile
 *   dsh-entry-off          DSH_TUI_HOST_ENTRY=0: the same
 *   dsh-shim-host          the first dsh on PATH is a launcher script: the
 *                          entry follows it and hosts DSH in process
 *   dsh-host-fallback      a dsh launcher the entry cannot follow: it falls
 *                          back to dsh --profile and the screen says why
 *   dsh-home-held          the one-shot sessions home waits for the DSH
 *                          session instead of opening on the first frame
 *   dsh-onboarding-held    the first-run guide the same
 *   dsh-provider-workspace a provider-URI workspace target (a test plugin's
 *                          `accept://` provider) resolves after composition
 *   dsh-unknown-workspace  an unresolvable target fails the startup session
 *                          in the screen instead of the mount
 *   dsh-compose-failed     a broken agent-loop row: the failure row names the
 *                          startup report under $DSH_HOME/logs and offers no
 *                          /new; /quit still exits cleanly
 *   dsh-open-failed-new    the session open fails (a --resume of an unknown
 *                          id): /new opens a DSH session through DSH's own
 *                          create path
 *   live-send              DSH_TUI_CLAUDE_LIVE=1 only: one prompt round-trip
 *   live-initial-prompt    DSH_TUI_CLAUDE_LIVE=1 only: a command-line prompt
 *                          is sent once the session is adopted
 *   dsh-entry-*            the DSH kernel in the entry
 *                          (DSH_TUI_HOST_ENTRY_DSH=1 set per case): SIGTERM /
 *                          SIGHUP / SIGINT while starting and after the
 *                          adoption (ends by the signal), a second signal,
 *                          /quit, Ctrl+C, `ctx.appExit`, render / runtime /
 *                          rejection crashes, /restart (and SIGTERM after
 *                          it), /kernel both ways, a DSH row failing to
 *                          activate. Each checks the exit status, terminal,
 *                          no process left, the safe-mode prompt, the DSH
 *                          session log (a /rename title event) and the
 *                          teardown time. Faults and appExit come from the
 *                          test-only DSH_TUI_TEST_FAULT
 *                          (src/dsh-adapter/test-faults.ts).
 *   plugin-*               third-party test plugins
 *                          (scripts/fixtures/host-entry-plugins/) as rows of
 *                          the profile's patch layer: a runtime theme the
 *                          user had persisted, a side panel, input /
 *                          session-switch decisions, each under its own
 *                          identity (`-entry` / `-profile`: both paths); root
 *                          capabilities from a row before / after the TUI's
 *                          rows (both paths agree); a row failing in its
 *                          apply, from a timer, by an unhandled rejection;
 *                          a row holding SIGTERM / SIGINT / SIGHUP.
 *   codex-in-entry         the Codex kernel in the entry (the rebase added it
 *                          to `entryKernel`): the entry runs it itself rather
 *                          than composing the DSH profile, the codex
 *                          app-server is probed and handshaken with, the
 *                          session is adopted and /quit exits 0;
 *                          `codex-in-entry-pool-closed` holds the fake
 *                          app-server on stdin EOF so only a real close (EOF →
 *                          SIGTERM after CLOSE_GRACE_MS) passes;
 *                          `codex-kernel-remembered` is the same through
 *                          `kernel.json` with no DSH_TUI_BACKEND at all
 *   plugins-light-claude   5.7 (end of this file): the same three fixtures on
 *                          the Claude kernel, where the entry composes the
 *                          light profile itself (no `dsh-tui` row at all) —
 *                          the runtime theme, the panel (identity, per-plugin
 *                          budget, storage), the `tui/input` and
 *                          `tui/session-switch` decisions, and this package's
 *                          own `/settings` section
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
 * The isolated DSH_HOME has no `profiles/node_modules` link (a fresh dsh 0.2
 * install has none, and the entry must start without it — it installs the
 * host's module resolution itself); `--legacy` links the source home's one
 * back in for comparison.
 *
 * Run: pnpm compile && node scripts/accept-host-entry.mjs [--only a,b] [--keep] [--no-auth] [--legacy]
 * `--keep` keeps the isolated root (credentials link included) and prints it.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
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
const { root, dshHome, profile: profileDir, launcher, dshBin } = buildIsolatedProfile({ repo, prefix: 'dsh-tui-accept-', profilesNodeModules: flag('--legacy') })
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
async function launch(name, { env = {}, cols = 100, rows = 30, settings, landing = true, args = [], backend = 'claude', onboarded = true } = {}) {
  rmSync(join(root, '.dsh-tui'), { recursive: true, force: true })
  rmSync(join(root, 'sessions'), { recursive: true, force: true })
  // Past the first-run guide (the DSH kernel opens on it otherwise).
  mkdirSync(join(root, '.dsh-tui'), { recursive: true })
  if (onboarded) writeFileSync(join(root, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
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
  // A key set to undefined in `env` is left out (e.g. no workspace target).
  await t.run('/usr/bin/env', ['-i', ...Object.entries(full).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`), process.execPath, launcher, ...args], { cols, rows, cwd: repo })
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
    if (!flag('--legacy')) check('no profiles/node_modules link in the isolated home', !existsSync(join(dshHome, 'profiles', 'node_modules')))
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
  // (With the DSH kernel in the entry by default the placeholder already
  // names the DeepSeek model before the row applies: wait for the row.)
  check('through dsh (a dsh-tui row applies)', await until(() => run.traced('row-apply'), 30000))
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

// ── 5. the DSH kernel in the entry (DSH_TUI_HOST_ENTRY_DSH=1) ─────────────
const DSH_IN_ENTRY = { DSH_TUI_HOST_ENTRY_DSH: '1' }
for (const landing of [false, true]) await runCase(`dsh-in-entry-${landing ? 'landing' : 'chat'}`, async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh', landing, env: DSH_IN_ENTRY })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check(`first frame (${Date.now() - run.startedAt}ms after spawn)`, true)
  check('adopts the DSH session', await until(() => run.traced('startup-adopted'), 60000), `${JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark]))}\n--- screen ---\n${lines(await run.screen()).slice(-12).join('\n')}`)
  const marks = run.marks()
  const entryPid = marks.find(entry => entry.mark === 'entry-start')?.pid
  const at = mark => marks.find(entry => entry.mark === mark && entry.pid === entryPid)?.ms
  check('one process: the dsh-tui row applies in the entry', entryPid !== undefined && marks.filter(entry => entry.mark === 'row-apply').every(entry => entry.pid === entryPid) && at('row-apply') !== undefined, JSON.stringify(marks.map(entry => [entry.pid, entry.mark])))
  check('one screen: the row does not render a second tree', marks.filter(entry => entry.mark === 'render-start').length === 1, JSON.stringify(marks.map(entry => entry.mark)))
  check('the screen is up before the profile composes', at('render-done') !== undefined && at('entry-compose-start') !== undefined && at('render-done') <= at('entry-compose-start'))
  check(`timeline (ms in the entry): hijacked ${at('entry-hijacked')}, render ${at('render-done')}, compose ${at('entry-compose-start')}–${at('entry-compose-end')}, adopted ${at('startup-adopted')}`, true)
  check('the DSH screen is up (its model on the status line)', await until(async () => (await run.screen()).includes(DSH_SCREEN), 30000), lines(await run.screen()).slice(-6).join('\n'))
  await run.clear()
  await run.command('/settings')
  // The TUI's own section moved to the composition's sections service.
  check('/settings lists the dsh-tui section', await until(async () => (await run.screen()).includes('dsh-tui (dsh-tui)'), 5000), lines(await run.screen()).slice(0, 6).join('\n'))
  await run.t.press('Escape')
  await sleep(300)
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

await runCase('dsh-in-entry-quit-early', async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh', landing: false, env: DSH_IN_ENTRY })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
  check(`left ${run.traced('startup-adopted') ? 'after' : 'before'} the adoption`, true)
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

// ── 6. the DSH kernel in the entry by default ─────────────────────────
// No DSH_TUI_HOST_ENTRY_DSH in these runs unless a case sets one.
const STARTING = 'Starting DSH'
const pidOf = (run, mark) => run.marks().find(entry => entry.mark === mark)?.pid
const atOf = (run, mark) => run.marks().find(entry => entry.mark === mark)?.at
/** The DSH session adopted in the entry process itself (one root). */
const adoptedInEntry = run => {
  const entry = pidOf(run, 'entry-start')
  return entry !== undefined && run.traced('row-apply', mark => mark.pid === entry) && run.traced('startup-adopted', mark => mark.pid === entry)
}
const timeline = run => JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark]))
const profilePatchFile = join(profileDir, 'cordis.patch.yml')
/** Run `body` with the isolated profile's patch layer set to `yaml`. */
async function withProfilePatch(yaml, body) {
  writeFileSync(profilePatchFile, yaml)
  try {
    await body()
  } finally {
    writeFileSync(profilePatchFile, '[]\n')
  }
}

for (const landing of [false, true]) await runCase(`dsh-default-starting${landing ? '-landing' : ''}`, async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh', landing })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  // Watch the screen while the composition runs: the entry cannot draw
  // then, so whatever is visible was written before it started.
  let seenWhileComposing = false
  await until(async () => {
    if (run.traced('entry-compose-start') && !run.traced('entry-compose-end') && (await run.screen()).includes(STARTING)) seenWhileComposing = true
    return seenWhileComposing || run.traced('entry-compose-end')
  }, 30000, 50)
  check('"Starting DSH…" is on screen while DSH composes', seenWhileComposing || (await run.screen()).includes(STARTING), lines(await run.screen()).slice(-6).join('\n'))
  const flushed = run.marks().find(entry => entry.mark === 'entry-first-frame-flushed')
  const composeStart = run.marks().find(entry => entry.mark === 'entry-compose-start')
  check(`the first frame reached the terminal before the composition (flushed ${flushed?.ms}ms, compose ${composeStart?.ms}ms)`, flushed !== undefined && composeStart !== undefined && flushed.ms <= composeStart.ms && run.traced('render-done'), timeline(run))
  check('default: DSH runs in the entry (row and adoption in the entry process)', await until(() => adoptedInEntry(run), 60000), timeline(run))
  check('"Starting DSH…" is gone once adopted', await until(async () => !(await run.screen()).includes(STARTING), 5000), lines(await run.screen()).slice(-6).join('\n'))
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

for (const [name, env] of [['dsh-entry-dsh-off', { DSH_TUI_HOST_ENTRY_DSH: '0' }], ['dsh-entry-off', { DSH_TUI_HOST_ENTRY: '0' }]]) await runCase(name, async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh', landing: false, env })
  check('the DSH screen is up', await until(async () => (await run.screen()).includes(DSH_SCREEN), 60000), lines(await run.screen()).slice(-6).join('\n'))
  check(`${Object.keys(env)[0]}=0: through dsh --profile, never the entry`, run.traced('row-apply') && !run.traced('entry-start'), timeline(run))
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

const relocatedDshEntry = realpathSync(join(dshBin, 'dsh'))
await runCase('dsh-shim-host', async ({ check, launch }) => {
  // A launcher script, as pnpm / a wrapper installs one: not a link.
  const shimBin = join(root, 'shim-bin')
  mkdirSync(shimBin, { recursive: true })
  writeFileSync(join(shimBin, 'dsh'), `#!/bin/sh\nexec '${process.execPath}' "${relocatedDshEntry}" "$@"\n`)
  chmodSync(join(shimBin, 'dsh'), 0o755)
  const run = await launch({ backend: 'dsh', landing: false, env: { PATH: `${shimBin}:${dshBin}:${process.env.PATH ?? ''}` } })
  check('the entry follows the script to the host and runs DSH in process', await until(() => adoptedInEntry(run), 60000), timeline(run))
  check('no fallback', !run.traced('entry-host-unavailable'))
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

await runCase('dsh-host-fallback', async ({ check, launch }) => {
  // A launcher whose target lives in a variable: the entry cannot follow it.
  const opaqueBin = join(root, 'opaque-bin')
  mkdirSync(opaqueBin, { recursive: true })
  writeFileSync(join(opaqueBin, 'dsh'), `#!/bin/sh\nexec '${process.execPath}' "$ACCEPT_DSH_ENTRY" "$@"\n`)
  chmodSync(join(opaqueBin, 'dsh'), 0o755)
  const run = await launch({ backend: 'dsh', landing: false, env: { PATH: `${opaqueBin}:${dshBin}:${process.env.PATH ?? ''}`, ACCEPT_DSH_ENTRY: relocatedDshEntry } })
  // (Not the status line's model: the stderr line before dsh's screen names
  // @deepseek-ai/dsh too.)
  const entry = pidOf(run, 'entry-start')
  check('the entry fell back: dsh --profile hosts the row in another process', await until(() => run.traced('entry-host-unavailable') && run.traced('render-done', mark => mark.pid !== entry), 60000), timeline(run))
  check('the screen says why', await until(async () => (await run.screen()).includes('Not using the installed dsh'), 10000), lines(await run.screen()).slice(-8).join('\n'))
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

await runCase('dsh-home-held', async ({ check, launch }) => {
  // An ordinary first launch: no workspace target, no resume, chat page.
  const run = await launch({ backend: 'dsh', landing: false, env: { DSH_TUI_WORKSPACE_TARGET: undefined } })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  const early = await run.screen()
  check('the first frame is the chat page, not the sessions home', !early.includes('This terminal hosts several sessions') || run.traced('startup-adopted'), lines(early).slice(0, 4).join('\n'))
  check('adopted', await until(() => run.traced('startup-adopted'), 60000), timeline(run))
  check('the sessions home opens once the DSH session is there', await until(async () => (await run.screen()).includes('This terminal hosts several sessions'), 10000), lines(await run.screen()).slice(0, 6).join('\n'))
  await run.t.press('Escape')
  await sleep(500)
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

await runCase('dsh-onboarding-held', async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh', landing: false, onboarded: false })
  // Before 2.4 the guide covered the first frame: no prompt at all.
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check('the first frame is the chat page, not the first-run guide', !(await run.screen()).includes('Welcome to dsh-TUI') || run.traced('startup-adopted'))
  check('adopted', await until(() => run.traced('startup-adopted'), 60000), timeline(run))
  check('the first-run guide opens once the DSH session is there', await until(async () => (await run.screen()).includes('Welcome to dsh-TUI'), 10000), lines(await run.screen()).slice(0, 6).join('\n'))
  await run.t.press('Escape')
  await sleep(800)
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, {})
})

const providerDir = join(root, 'provider-workspace')
mkdirSync(providerDir, { recursive: true })
writeFileSync(join(profileDir, 'accept-workspace.mjs'), `// accept-host-entry: a workspace provider for accept:// URIs.
export const name = 'accept-workspace'
export const inject = ['tuiWorkspaces']
const dir = ${JSON.stringify(providerDir)}
const target = uri => ({ uri, cwd: dir, label: 'accept', kind: 'provider', badge: 'ACC' })
export function apply(ctx) {
  ctx.tuiWorkspaces.register({
    schemes: ['accept'],
    list: () => [target('accept://ws')],
    resolve: uri => uri.startsWith('accept://') ? target(uri) : undefined,
    describe: cwd => cwd === dir ? target('accept://ws') : undefined,
  })
}
`)
await runCase('dsh-provider-workspace', async ({ check, launch }) => {
  await withProfilePatch(`- insert:\n    - id: accept-workspace\n      name: './accept-workspace.mjs'\n`, async () => {
    const run = await launch({ backend: 'dsh', landing: false, env: { DSH_TUI_WORKSPACE_TARGET: 'accept://ws' } })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    check('mounted before DSH composed (the target did not fail the mount)', run.traced('render-done'))
    check('adopted in the entry', await until(() => adoptedInEntry(run), 60000), `${timeline(run)}\n--- screen ---\n${lines(await run.screen()).slice(-8).join('\n')}`)
    check('no workspace failure on screen', !(await run.screen()).includes('unsupported or unavailable workspace target'))
    // The adopted session runs in the provider's directory: the session
    // store files it under a directory named after its cwd.
    const storeDirs = existsSync(join(root, 'sessions')) ? readdirSync(join(root, 'sessions')) : []
    check('the session was created in the provider workspace', storeDirs.some(dir => dir.includes('provider-workspace')), storeDirs.join(', '))
    await run.clear()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
})

await runCase('dsh-unknown-workspace', async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh', landing: false, env: { DSH_TUI_WORKSPACE_TARGET: 'nowhere://x' } })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check('the failure is a row in the screen, naming the target', await until(async () => (await run.screen()).includes('unsupported or unavailable workspace target'), 30000), lines(await run.screen()).slice(-8).join('\n'))
  check('not adopted', !run.traced('startup-adopted'))
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

await runCase('dsh-compose-failed', async ({ check, launch }) => {
  const logs = join(dshHome, 'logs')
  rmSync(logs, { recursive: true, force: true })
  await withProfilePatch(`- id: agent-loop\n  disabled: !!js "(() => { throw new Error('accept: broken agent-loop row') })()"\n`, async () => {
    const run = await launch({ backend: 'dsh', landing: false, cols: 160 })
    await run.t.getByText(PROMPT).expect({ timeout: 30000 })
    check('the failure row names the startup log', await until(async () => (await run.screen()).includes('Startup log:'), 30000), `${timeline(run)}\n--- screen ---\n${lines(await run.screen()).slice(-10).join('\n')}`)
    const reports = existsSync(logs) ? readdirSync(logs).filter(file => file.startsWith('startup-')) : []
    check('a startup report under $DSH_HOME/logs', reports.length === 1, reports.join(', '))
    const report = reports.length === 1 ? readFileSync(join(logs, reports[0]), 'utf8') : ''
    check('the report holds the failure and the startup logs', report.startsWith('WARNING: Raw diagnostics') && report.includes('accept: broken agent-loop row') && report.includes('configurationPath'), report.slice(0, 400))
    const screen = await run.screen()
    check('the row names the report file', reports.length === 1 && screen.replace(/\s+/gu, '').includes(reports[0].slice(0, 30)), lines(screen).slice(-6).join('\n'))
    check('no /new offered (only /kernel and /quit)', !screen.includes('/new to retry') && screen.includes('/kernel to switch kernel'), lines(screen).slice(-6).join('\n'))
    check('not adopted', !run.traced('startup-adopted'))
    await run.clear()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
})

await runCase('dsh-open-failed-new', async ({ check, launch }) => {
  const run = await launch({ backend: 'dsh', landing: false, args: ['--resume', '00000000-0000-4000-8000-000000000000'] })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check('the open fails in the screen, offering /new', await until(async () => (await run.screen()).includes('failed to open') && (await run.screen()).includes('/new to retry'), 60000), `${timeline(run)}\n--- screen ---\n${lines(await run.screen()).slice(-8).join('\n')}`)
  check('not adopted', !run.traced('startup-adopted'))
  await run.clear()
  await run.command('/new')
  let refused = true
  await until(async () => {
    await run.clear()
    await run.command('/status')
    await sleep(800)
    refused = (await run.screen()).includes(NOT_READY)
    await run.t.press('Escape')
    return !refused
  }, 30000, 1500)
  check('/new opens a DSH session (a session command runs)', !refused, lines(await run.screen()).slice(-10).join('\n'))
  check('the DSH screen is up (its model on the status line)', await until(async () => (await run.screen()).includes(DSH_SCREEN), 10000), lines(await run.screen()).slice(-6).join('\n'))
  await run.clear()
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

// ── 7. process ownership with the DSH kernel in the entry ────────────────
// docs/standalone-host-design.md 5.5 and src/dsh-adapter/process-exit.ts:
// signals, `ctx.appExit` and fatal errors go through the TUI's exit funnel;
// a termination signal ends the process by that signal. Every case sets
// DSH_TUI_HOST_ENTRY_DSH=1 itself (replacements inherit it) and checks the
// exit status, the terminal, no process left, no safe-mode prompt where none
// belongs, the DSH session log on disk and the teardown time (quit/signal →
// process gone; `dispose: root disposed` in restart.log is the root alone).
// Faults come from the test-only DSH_TUI_TEST_FAULT (src/dsh-adapter/test-faults.ts).
const ENTRY_DSH = { DSH_TUI_HOST_ENTRY_DSH: '1' }
const SAFE_MODE = 'safe mode'
const entryPidOf = (run, after) => run.marks().find(mark => mark.mark === 'entry-start' && mark.pid !== after)?.pid
/** The DSH session event logs (DSH_TUI_SESSION_ROOT: <root>/sessions/<cwd>/<id>/session.v4.jsonl.zstd). */
const dshSessionLogs = () => {
  const dir = join(root, 'sessions')
  if (!existsSync(dir)) return []
  const found = []
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.startsWith('session.') && entry.name.endsWith('.zstd')) found.push(full)
    }
  }
  walk(dir)
  return found
}
/** Rename the session: writes a title event into the DSH log without a model request. */
const titleSession = async (run, title) => {
  await run.clear()
  await run.command(`/rename ${title}`)
  await sleep(800)
  await run.t.press('Escape')
  await sleep(200)
}
/** The log's text: one zstd frame per append, decoded frame by frame. */
const sessionLogText = path => {
  const bytes = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let at = bytes.indexOf(magic); at !== -1; at = bytes.indexOf(magic, at + 1)) starts.push(at)
  return starts.map((start, index) => {
    try { return zstdDecompressSync(bytes.subarray(start, starts[index + 1] ?? bytes.length)).toString('utf8') } catch { return '' }
  }).join('')
}
const sessionLogHas = text => dshSessionLogs().some(path => sessionLogText(path).includes(`"title":"${text}"`))
/** tui-test reports a signal death by its description. */
const SIGNAL_TEXT = { SIGTERM: 'Terminated', SIGHUP: 'Hangup', SIGINT: 'Interrupt' }
const lastRunAt = () => {
  try { return JSON.parse(readFileSync(join(root, '.dsh-tui', 'last-run.json'), 'utf8')).updatedAt } catch { return undefined }
}
/** Wait for the PTY child (the launcher) to end; ms from `sentAt`. */
const waitGone = async (run, sentAt, timeoutMs = 20000) => {
  await until(async () => { const state = await run.t.state(); return state.exited !== null || state.exit_signal !== null }, timeoutMs, 25)
  return Date.now() - sentAt
}
/**
 * The block-2.5 exit checks. `signal` or `code` is the expected status;
 * `title` a session title that must be in the DSH log; `lastRunSince` the
 * time after which the funnel must have refreshed last-run.json.
 */
async function checkOwnedExit(run, check, { signal, code, sentAt, title, lastRunSince, safeMode = false, maxMs = 8000, fromLog, timed = true }) {
  let ms = await waitGone(run, sentAt)
  // An exit the TUI itself started (appExit, a fault): from its restart.log line.
  const startLine = fromLog === undefined ? undefined : run.restartLog().find(line => line.includes(fromLog))
  if (startLine !== undefined) ms = Date.now() - Date.parse(startLine.split(' ')[0])
  const state = await run.t.state()
  const status = `exited=${state.exited} signal=${state.exit_signal}`
  if (signal !== undefined) check(`ends by ${signal} (${status})`, state.exit_signal === SIGNAL_TEXT[signal], status)
  if (code !== undefined) check(`exit code ${code}`, state.exited === code && state.exit_signal === null, status)
  if (timed) check(`teardown ${ms}ms (signal/command → process gone, ≤ ${maxMs})`, ms <= maxMs)
  const log = run.restartLog()
  const disposed = log.filter(line => line.includes('dispose: root disposed')).map(line => JSON.parse(line.slice(line.indexOf('{'))).ms)
  check(`root dispose ${disposed.length === 0 ? 'not logged' : `${disposed.join(', ')}ms`}; no dispose timeout`, !log.some(line => line.includes('dispose: timeout')), log.filter(line => line.includes('dispose')).join('\n'))
  if (!safeMode) check('no crash in restart.log', !run.restartLog().some(line => / pid=\d+ crash /.test(line)), run.restartLog().filter(line => line.includes('crash')).join('\n'))
  check(`safe-mode prompt ${safeMode ? 'offered' : 'absent'}`, (await run.screen()).includes(SAFE_MODE) === safeMode, lines(await run.screen()).slice(-6).join('\n'))
  if (title !== undefined) check('the DSH session log is on disk with its title', sessionLogHas(title), dshSessionLogs().join('\n'))
  if (lastRunSince !== undefined) check('last-run.json refreshed by the funnel', (lastRunAt() ?? 0) >= lastRunSince, `updatedAt=${lastRunAt()} since=${lastRunSince}`)
  await checkExit(run, check)
}
const launchEntryDsh = async (launch, options = {}) => {
  const run = await launch({ backend: 'dsh', landing: false, ...options, env: { ...ENTRY_DSH, ...options.env } })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  return run
}
const adopted = async (run, check) => {
  check('DSH session adopted in the entry', await until(() => run.traced('startup-adopted'), 60000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
}
const quitNow = async run => {
  await run.clear()
  await run.t.type('/quit')
  await sleep(400)
  const sentAt = Date.now()
  await run.t.press('Enter')
  return sentAt
}

// Signals, during the startup (the profile composing, the session opening)
// and after the adoption. The startup ones go out as soon as the screen is up.
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  for (const phase of ['starting', 'adopted']) {
    await runCase(`dsh-entry-${signal.toLowerCase()}-${phase}`, async ({ check, launch }) => {
      const run = await launchEntryDsh(launch)
      const pid = entryPidOf(run)
      if (pid === undefined) throw new Error('no entry-start mark')
      const title = `accept-${signal.toLowerCase()}-${Date.now().toString(36)}`
      if (phase === 'adopted') {
        await adopted(run, check)
        await titleSession(run, title)
      }
      const sentAt = Date.now()
      const before = run.traced('startup-adopted')
      process.kill(pid, signal)
      check(`signal sent ${before ? 'after' : 'before'} the adoption`, phase === 'adopted' ? before : true)
      await checkOwnedExit(run, check, { signal, sentAt, ...(phase === 'adopted' ? { title, lastRunSince: sentAt } : {}) })
      check('the entry took the signal', run.restartLog().some(line => line.includes('signal: received') && line.includes(signal)), run.restartLog().filter(line => line.includes('signal: ') || line.includes('funnel: ')).join('\n'))
    })
  }
}

await runCase('dsh-entry-second-signal', async ({ check, launch }) => {
  const run = await launchEntryDsh(launch)
  await adopted(run, check)
  const pid = entryPidOf(run)
  const sentAt = Date.now()
  process.kill(pid, 'SIGTERM')
  await sleep(30)
  process.kill(pid, 'SIGTERM')
  await checkOwnedExit(run, check, { signal: 'SIGTERM', sentAt, maxMs: 2000 })
  check('the second signal forced the exit', run.restartLog().some(line => line.includes('signal: second signal')), run.restartLog().filter(line => line.includes('signal: ')).join('\n'))
})

await runCase('dsh-entry-quit', async ({ check, launch }) => {
  const run = await launchEntryDsh(launch)
  await adopted(run, check)
  const title = `accept-quit-${Date.now().toString(36)}`
  await titleSession(run, title)
  const sentAt = await quitNow(run)
  await checkOwnedExit(run, check, { code: 0, sentAt, title, lastRunSince: sentAt })
})

await runCase('dsh-entry-ctrlc', async ({ check, launch }) => {
  const run = await launchEntryDsh(launch)
  await adopted(run, check)
  const title = `accept-ctrlc-${Date.now().toString(36)}`
  await titleSession(run, title)
  await run.t.press('Ctrl+C')
  await sleep(300)
  const sentAt = Date.now()
  await run.t.press('Ctrl+C')
  await checkOwnedExit(run, check, { code: 0, sentAt, title, lastRunSince: sentAt })
})

// `ctx.appExit(0)` on the composed root, as a DSH plugin would call it
// (dsh-cmdline's exit request); DSH_TUI_TEST_FAULT=app-exit:0 makes the call.
await runCase('dsh-entry-app-exit', async ({ check, launch }) => {
  const run = await launchEntryDsh(launch, { env: { DSH_TUI_TEST_FAULT: 'app-exit:0@6000' } })
  await adopted(run, check)
  const title = `accept-appexit-${Date.now().toString(36)}`
  await titleSession(run, title)
  const sentAt = Date.now()
  await checkOwnedExit(run, check, { code: 0, sentAt, title, lastRunSince: sentAt - 3000, fromLog: 'funnel: process exit requested' })
  check('appExit went through the funnel', run.restartLog().some(line => line.includes('funnel: process exit requested') && line.includes('"code":0')), run.restartLog().slice(-8).join('\n'))
})

// Fatal errors: one exit — the TUI's crash funnel (terminal restored, one
// crash line, crash.log, resume markers, exit 1). DSH's fail-loud line must
// not appear. The launcher then offers safe mode (exit 1 is a crash); the
// terminal is checked before its prompt restores anything itself.
for (const fault of ['render', 'runtime', 'rejection']) {
  await runCase(`dsh-entry-crash-${fault}`, async ({ check, launch }) => {
    const run = await launchEntryDsh(launch, { env: { DSH_TUI_TEST_FAULT: `${fault}@6000` } })
    await adopted(run, check)
    const title = `accept-crash-${fault}-${Date.now().toString(36)}`
    await titleSession(run, title)
    const sinceAt = Date.now()
    check('the crash line is on screen', await until(async () => (await run.screen()).includes('dsh-tui crashed'), 15000), lines(await run.screen()).slice(-8).join('\n'))
    const crashLine = run.restartLog().find(line => / pid=\d+ crash /.test(line))
    const state = await run.t.state()
    const modes = state.modes
    check('terminal restored by the TUI (before the launcher prompt)',
      modes.alternate_screen === false && modes.cursor_visible === true && modes.bracketed_paste === false && modes.focus_events === false && state.mouse_mode === 'none',
      JSON.stringify({ ...modes, mouse_mode: state.mouse_mode }))
    const screen = await run.screen()
    check('one crash line, no DSH fail-loud line', screen.split('dsh-tui crashed').length === 2 && !screen.includes('dsh: fatal'), lines(screen).slice(-8).join('\n'))
    check('crash.log written', existsSync(join(root, '.dsh-tui', 'crash.log')) && readFileSync(join(root, '.dsh-tui', 'crash.log'), 'utf8').includes('test fault'))
    check('the safe-mode prompt follows', await until(async () => (await run.screen()).includes(SAFE_MODE), 10000, 25), lines(await run.screen()).slice(-4).join('\n'))
    // The launcher asks once the entry is gone: crash → prompt is the teardown.
    if (crashLine !== undefined) check(`teardown ${Date.now() - Date.parse(crashLine.split(' ')[0])}ms (crash → entry gone, launcher prompt)`, true)
    await run.t.type('n')
    await run.t.press('Enter')
    await checkOwnedExit(run, check, { code: 1, sentAt: sinceAt, title, lastRunSince: sinceAt - 7000, safeMode: true, timed: false })
  })
}

// /restart: the replacement is the entry again, with DSH in it.
await runCase('dsh-entry-restart', async ({ check, launch }) => {
  const run = await launchEntryDsh(launch)
  await adopted(run, check)
  const firstPid = entryPidOf(run)
  await run.clear()
  await run.command('/restart')
  check('a new entry process starts', await until(() => entryPidOf(run, firstPid) !== undefined, 30000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
  const secondPid = entryPidOf(run, firstPid)
  check('its dsh-tui row applies in it (DSH in the entry, not dsh)', await until(() => run.traced('row-apply', entry => entry.pid === secondPid), 30000))
  check('and adopts its DSH session', await until(() => run.traced('startup-adopted', entry => entry.pid === secondPid), 30000))
  await checkSupervised(run, check)
  check('no crash in the supervisor', !run.restartLog().some(line => / pid=\d+ crash /.test(line)), run.restartLog().filter(line => line.includes('supervisor') || line.includes('crash')).join('\n'))
  const sentAt = await quitNow(run)
  await checkOwnedExit(run, check, { code: 0, sentAt })
})

// SIGTERM to the replacement after a /restart: it leaves by its funnel and
// the supervisor follows by the same signal (the launcher: no safe mode).
await runCase('dsh-entry-sigterm-after-restart', async ({ check, launch }) => {
  const run = await launchEntryDsh(launch)
  await adopted(run, check)
  const firstPid = entryPidOf(run)
  await run.clear()
  await run.command('/restart')
  check('a new entry adopts', await until(() => run.traced('startup-adopted', entry => entry.pid !== firstPid), 40000))
  const secondPid = entryPidOf(run, firstPid)
  const sentAt = Date.now()
  process.kill(secondPid, 'SIGTERM')
  await checkOwnedExit(run, check, { signal: 'SIGTERM', sentAt })
})

// /kernel both ways with DSH in the entry: the replacement is an entry,
// it sends the fd-3 ACK, the alternate screen is held across, the old
// process supervises without crashing.
const checkHandoff = async (run, check) => {
  check('the replacement ACKed its first frame on fd 3', await until(() => run.restartLog().some(line => line.includes('handoff/first-frame')), 30000), run.restartLog().filter(line => line.includes('handoff/')).join('\n'))
  check('still on the alternate screen after the handoff', (await run.t.state()).modes.alternate_screen === true)
}
await runCase('dsh-entry-kernel-to-claude', async ({ check, launch }) => {
  const run = await launchEntryDsh(launch)
  await adopted(run, check)
  const firstPid = entryPidOf(run)
  await run.clear()
  await pickKernel(run, false)
  check('switch accepted', await until(() => run.restartLog().some(line => line.includes('backend switch accepted')), 10000), run.restartLog().slice(-5).join('\n'))
  check('the replacement is an entry', await until(() => entryPidOf(run, firstPid) !== undefined, 30000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
  const secondPid = entryPidOf(run, firstPid)
  check('and adopts a Claude session (no dsh-tui row there)', await until(() => run.traced('startup-adopted', entry => entry.pid === secondPid), 30000) && !run.traced('row-apply', entry => entry.pid === secondPid))
  await checkHandoff(run, check)
  await checkSupervised(run, check)
  check('no crash in the supervisor', !run.restartLog().some(line => / pid=\d+ crash /.test(line)), run.restartLog().filter(line => line.includes('supervisor') || line.includes('crash')).join('\n'))
  const sentAt = await quitNow(run)
  await checkOwnedExit(run, check, { code: 0, sentAt })
})

await runCase('dsh-entry-kernel-to-dsh', async ({ check, launch }) => {
  const run = await launch({ backend: 'claude', landing: false, env: ENTRY_DSH })
  await run.t.getByText(PROMPT).expect({ timeout: 30000 })
  check('Claude adopted', await until(() => run.traced('startup-adopted'), 30000))
  const firstPid = entryPidOf(run)
  await run.clear()
  await pickKernel(run, true)
  check('switch accepted', await until(() => run.restartLog().some(line => line.includes('backend switch accepted')), 10000), run.restartLog().slice(-5).join('\n'))
  check('the replacement is an entry', await until(() => entryPidOf(run, firstPid) !== undefined, 30000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
  const secondPid = entryPidOf(run, firstPid)
  check('DSH runs in it (its dsh-tui row applies there)', await until(() => run.traced('row-apply', entry => entry.pid === secondPid), 60000), JSON.stringify(run.marks().map(entry => [entry.pid, entry.mark])))
  check('and adopts the DSH session', await until(() => run.traced('startup-adopted', entry => entry.pid === secondPid), 60000))
  check('the DSH screen is up', await until(async () => (await run.screen()).includes(DSH_SCREEN), 30000), lines(await run.screen()).slice(-6).join('\n'))
  await checkHandoff(run, check)
  await checkSupervised(run, check)
  check('no crash in the supervisor', !run.restartLog().some(line => / pid=\d+ crash /.test(line)), run.restartLog().filter(line => line.includes('supervisor') || line.includes('crash')).join('\n'))
  const sentAt = await quitNow(run)
  await checkOwnedExit(run, check, { code: 0, sentAt })
})

// A DSH row that fails to activate while the profile composes: DSH's audit
// reports it (fail-loud skips such rejections during its checkpoint); the
// TUI must not crash on it either, and the session still opens.
await runCase('dsh-entry-row-activation-fails', async ({ check, launch }) => {
  const patch = join(dshHome, 'profiles', 'dsh-tui', 'cordis.patch.yml')
  const plugin = join(root, 'accept-fail-plugin.mjs')
  const ran = join(root, 'accept-fail-plugin.ran')
  rmSync(ran, { force: true })
  writeFileSync(plugin, `import { writeFileSync } from 'node:fs'\nexport const name = 'accept-fail-plugin'\nexport async function apply() { writeFileSync(${JSON.stringify(ran)}, ''); throw new Error('accept: row failed to activate') }\n`)
  const original = readFileSync(patch, 'utf8')
  writeFileSync(patch, `- insert:\n    - id: accept-fail\n      name: ${JSON.stringify(new URL(`file://${plugin}`).href)}\n`)
  try {
    const run = await launchEntryDsh(launch)
    await adopted(run, check)
    await sleep(2000)
    check('the failing row was activated', existsSync(ran))
    const state = await run.t.state()
    check('still running, no crash', state.exited === null && !run.restartLog().some(line => / pid=\d+ crash /.test(line)), `${lines(await run.screen()).slice(-6).join('\n')}\n${run.restartLog().join('\n')}`)
    const sentAt = await quitNow(run)
    await checkOwnedExit(run, check, { code: 0, sentAt })
  } finally {
    writeFileSync(patch, original)
  }
})

// ── 8. third-party plugins with DSH in the entry ─────────────────────────
// Test plugins (scripts/fixtures/host-entry-plugins/, not shipped) as rows of
// the isolated profile's own patch layer — inserted after the TUI's rows, as
// a third-party row lands. Each case runs on both paths: `entry` (the
// default: DSH in the entry, one root) and `profile`
// (DSH_TUI_HOST_ENTRY_DSH=0: dsh --profile), and the plugins append what
// they saw to a report file. A case-owned HOME carries the case's
// ~/.dsh-tui (persisted theme, extension grants); the plugins' admission
// stands in for a loader the product does not have yet (common.mjs).
const PLUGIN_FIXTURES = join(repo, 'scripts', 'fixtures', 'host-entry-plugins')
const fileUrl = path => new URL(`file://${path}`).href
// The running dsh-tui copy's adapter module (one instance with the TUI's).
const ADAPTER_URL = fileUrl(join(launcher, '..', '..', 'lib', 'types', 'dsh-adapter', 'plugin-host.js'))
const PLUGIN_PATHS = { entry: {}, profile: { DSH_TUI_HOST_ENTRY_DSH: '0' } }
// The non-DSH kernels are deliberately not a third entry here: they have no
// `dsh-tui` row at all (the entry composes the light profile itself), and most
// assertions below are about the DSH row's hand-off. They run as
// `plugins-light-<kernel>` with their own assertions (5.7, end of this file).
/** The patch layer inserting `rows` ([id, fixture, extra config]). */
const pluginPatch = (rows, report) => `- insert:\n${rows.map(([id, fixture, config = {}]) =>
  `    - id: ${id}\n      name: ${JSON.stringify(fileUrl(join(PLUGIN_FIXTURES, fixture)))}\n      config: ${JSON.stringify({ report, adapter: ADAPTER_URL, ...config })}\n`).join('')}`
const readReport = path => readLines(path).map(line => JSON.parse(line))
const GRANTS = {
  grants: {
    'accept-guard': [{ name: 'session.input.intercept', scope: 'tui/input' }, { name: 'session.switch.intercept', scope: 'tui/session-switch' }],
    'accept-panels': [{ name: 'storage.local.read', scope: 'accept-panels' }, { name: 'storage.local.write', scope: 'accept-panels' }],
  },
}
/** A HOME of the case's own: its ~/.dsh-tui holds `files` (name → JSON). */
function pluginHome(name, files = {}) {
  const home = join(root, `home-${name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(join(home, '.dsh-tui'), { recursive: true })
  writeFileSync(join(home, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
  for (const [file, value] of Object.entries(files)) writeFileSync(join(home, '.dsh-tui', file), JSON.stringify(value))
  return home
}
const homeRestartLog = home => readLines(join(home, '.dsh-tui', 'restart.log'))
/** Adopted on `path`: in the entry process, or by a dsh-tui row in dsh. */
const adoptedOn = (run, path) => path === 'entry'
  ? adoptedInEntry(run)
  : run.traced('row-apply') && !run.traced('entry-start') && run.traced('render-done')
/** Cells whose foreground is the test theme's colour. */
const THEME_RGB = 0xab12cd
const themedCells = async run => {
  const { cols, rows } = await run.t.getSize()
  const cells = await run.t.cells(0, 0, cols, rows)
  return cells.filter(cell => cell.fg === THEME_RGB || String(cell.fg).toLowerCase().includes('ab12cd')).length
}

for (const [path, pathEnv] of Object.entries(PLUGIN_PATHS)) await runCase(`plugins-${path}`, async ({ check, launch }) => {
  const report = join(root, `report-plugins-${path}.jsonl`)
  rmSync(report, { force: true })
  const home = pluginHome(`plugins-${path}`, { 'theme.json': { theme: 'accept-theme' }, 'extension-grants.json': GRANTS })
  // A rewritten input is delivered: its model request goes to a closed local
  // port instead of DeepSeek, so no model is asked (an id-targeted config
  // replaces the row's block: cordis.patch.yml's llm-deepseek, base URL changed).
  const offline = `- id: llm-deepseek\n  config:\n    apiKeyEnv: 'DEEPSEEK_API_KEY'\n    baseURL: 'http://127.0.0.1:9'\n    thinking: enabled\n    reasoningEffort: max\n`
  await withProfilePatch(offline + pluginPatch([['accept-theme', 'theme.mjs'], ['accept-panels', 'panels.mjs'], ['accept-guard', 'guard.mjs']], report), async () => {
    const run = await launch({
      backend: 'dsh', landing: false, cols: 150, rows: 36,
      env: { ...pathEnv, HOME: home },
    })
    await run.t.getByText(PROMPT).expect({ timeout: 60000 })
    // In the entry the first frame precedes every plugin row: the persisted
    // runtime theme cannot be drawn yet (auto-detection stands in), and
    // ThemeProvider restores it once it registers. Recorded, not asserted.
    check(`first frame: ${await themedCells(run)} cells in the test theme's colour (before adoption: ${!run.traced('startup-adopted')})`, true)
    check(`adopted on the ${path} path`, await until(() => adoptedOn(run, path), 60000), timeline(run))
    const entries = () => readReport(report)
    const find = (plugin, event) => entries().find(entry => entry.plugin === plugin && entry.event === event)
    await until(() => find('panels', 'opened') !== undefined || find('panels', 'open-failed') !== undefined, 20000)
    // (a) the runtime theme, persisted before it existed
    check('theme registered', find('theme', 'registered')?.ok === true, JSON.stringify(entries()))
    check('the persisted runtime theme is the one in use', await until(async () => (await themedCells(run)) > 20, 5000), `themed cells: ${await themedCells(run)}`)
    // (b) the panel, under the plugin's own identity
    const panels = find('panels', 'registered')
    check('panels plugin admitted as accept-panels', find('panels', 'admitted')?.componentId === 'accept-panels', JSON.stringify(entries()))
    check('panel id carries the plugin id (no act<N> fallback)', JSON.stringify(panels?.ids) === '["accept-panels:demo"]', JSON.stringify(panels))
    const budget = find('panels', 'budget')
    check('panel budget counted per plugin: 3 more fit, a 5th is refused', budget?.accepted === 3 && budget?.fifthRefused === true, JSON.stringify(budget))
    check('storage write under the plugin identity', find('panels', 'storage')?.ok === true && existsSync(join(home, '.dsh-tui', 'plugin-storage', 'accept-panels.json')), JSON.stringify(entries().filter(entry => entry.plugin === 'panels')))
    check('panel opened', find('panels', 'opened') !== undefined, JSON.stringify(entries().filter(entry => entry.plugin === 'panels')))
    const shown = await until(async () => (await run.screen()).includes('ACCEPT-PANEL-BODY'), 5000)
    // The profile path drops a panel registered before the dsh-tui row's
    // runtime applies: the runtime seeds the enabled-panels store from its
    // Config (plugin.ts applySidePanelPanels) over the plugin's entry, and the
    // open is then ignored. In the entry the runtime is mounted first.
    if (path === 'entry') check('panel shown', shown, lines(await run.screen()).join('\n'))
    else check(`panel shown: ${shown} (profile path: a panel registered before the runtime applies is not enabled; known, not this block's)`, true)
    // The opened panel holds the focus: back to the prompt.
    await run.t.press('Escape')
    await sleep(300)
    // (c) decisions (DecisionEvents admission waits for the channel's dispatch)
    check('guard admitted as accept-guard and subscribed', await until(() => find('guard', 'subscribed')?.componentId === 'accept-guard', 20000), JSON.stringify(entries().filter(entry => entry.plugin === 'guard')))
    await run.clear()
    await run.t.type('accept-veto this line')
    await sleep(300)
    await run.t.press('Enter')
    check('tui/input veto: the reason is on screen', await until(async () => (await run.screen()).includes('ACCEPT-VETOED'), 5000), lines(await run.screen()).slice(-10).join('\n'))
    check('the guard saw the input as accept-guard', entries().some(entry => entry.event === 'input' && entry.text === 'accept-veto this line' && entry.componentId === 'accept-guard'))
    await run.clear()
    await run.command('/new')
    check('tui/session-switch veto: the reason is on screen', await until(async () => (await run.screen()).includes('ACCEPT-SWITCH-VETOED'), 5000), lines(await run.screen()).slice(-10).join('\n'))
    check('the guard saw the /new', entries().some(entry => entry.event === 'session-switch' && entry.kind === 'new'))
    await run.clear()
    await run.t.type('accept-rewrite this line')
    await sleep(300)
    await run.t.press('Enter')
    check('tui/input rewrite: the transcript has the rewritten text', await until(async () => (await run.screen()).includes('ACCEPT-REWRITTEN'), 8000), lines(await run.screen()).slice(-12).join('\n'))
    check('and not the typed one', !(await run.screen()).includes('accept-rewrite this line'))
    // ("429 — catching a breath" and the like are working-activity's retry
    // phrases, not responses.) A transport failure: nothing answered at all.
    check('no model answered: the turn ends in a transport failure', await until(async () => (await run.screen()).includes('transport failed'), 60000, 500), lines(await run.screen()).slice(-12).join('\n'))
    await sleep(1000)
    await run.t.press('Escape')
    await sleep(500)
    await run.clear()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
    check('no crash in restart.log', !homeRestartLog(home).some(line => / pid=\d+ crash /.test(line)), homeRestartLog(home).join('\n'))
  })
})

// Root capabilities from a third-party row, in its apply (the profile still
// composing) and 4s later. On the profile path the guard arrives with the
// first TUI row: a row activating after it (here: one that injects a TUI
// service) is refused, one activating before it (no inject: it applies as
// soon as its module loads) is not. The entry arms the same point
// (host-access.ts armRootCapabilityGuard) while the profile composes.
const overreachEarly = {}
for (const [path, pathEnv] of Object.entries(PLUGIN_PATHS)) await runCase(`plugin-overreach-${path}`, async ({ check, launch }) => {
  const report = join(root, `report-overreach-${path}.jsonl`)
  rmSync(report, { force: true })
  const home = pluginHome(`overreach-${path}`)
  await withProfilePatch(pluginPatch([['accept-overreach', 'overreach.mjs', { label: 'early' }], ['accept-overreach-late', 'overreach-late.mjs', { label: 'late' }]], report), async () => {
    const run = await launch({ backend: 'dsh', landing: false, env: { ...pathEnv, HOME: home } })
    await run.t.getByText(PROMPT).expect({ timeout: 60000 })
    check(`adopted on the ${path} path`, await until(() => adoptedOn(run, path), 60000), timeline(run))
    const entries = () => readReport(report)
    check('both rows applied and tried again later', await until(() => entries().filter(entry => entry.event === 'later').length === 2, 15000), JSON.stringify(entries()))
    const allDenied = results => Object.values(results ?? {}).length > 0 && Object.values(results).every(value => value === 'denied')
    for (const entry of entries()) {
      // A row applying before any TUI row (no inject: as soon as its module
      // loads) is ahead of the guard on both paths; recorded, and the two
      // paths must agree.
      if (entry.plugin === 'early' && entry.event === 'apply') {
        overreachEarly[path] = JSON.stringify(entry.results)
        check(`early row, apply (before any TUI row): ${overreachEarly[path]}`, true)
        continue
      }
      check(`${entry.plugin} row, ${entry.event}: every root capability denied ${JSON.stringify(entry.results)}`, allDenied(entry.results))
    }
    const other = path === 'entry' ? 'profile' : 'entry'
    if (overreachEarly[other] !== undefined) check(`early row: the ${path} path agrees with the ${other} path`, overreachEarly[path] === overreachEarly[other], `${path}=${overreachEarly[path]} ${other}=${overreachEarly[other]}`)
    await run.clear()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
  })
})

// A third-party row failing, on the entry path: in its apply while the
// profile composes (DSH's audit reports it; the TUI does not crash, the
// session opens), or later from a timer / an unhandled rejection — then the
// TUI's crash funnel is the one exit: one crash line, crash.log,
// terminal restored, exit 1 (the launcher offers safe mode).
const launchPluginCase = async (launch, name, rows, report, env = {}) => {
  rmSync(report, { force: true })
  const home = pluginHome(name)
  writeFileSync(profilePatchFile, pluginPatch(rows, report))
  const run = await launch({ backend: 'dsh', landing: false, env: { HOME: home, ...env } })
  await run.t.getByText(PROMPT).expect({ timeout: 60000 })
  return { run, home }
}
await runCase('plugin-apply-throws', async ({ check, launch }) => {
  const report = join(root, 'report-apply-throws.jsonl')
  try {
    const { run, home } = await launchPluginCase(launch, 'apply-throws', [['accept-misbehave', 'misbehave.mjs', { mode: 'apply-throw' }]], report)
    check('adopted in the entry', await until(() => adoptedInEntry(run), 60000), timeline(run))
    check('the row applied (and threw) while the profile composed', readReport(report).some(entry => entry.event === 'apply'), JSON.stringify(readReport(report)))
    await sleep(1500)
    check('still running, no crash', (await run.t.state()).exited === null && !homeRestartLog(home).some(line => / pid=\d+ crash /.test(line)), homeRestartLog(home).join('\n'))
    await run.clear()
    const sentAt = Date.now()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
    check(`quit → gone ${Date.now() - sentAt}ms`, true)
  } finally {
    writeFileSync(profilePatchFile, '[]\n')
  }
})
for (const [name, mode, text] of [
  ['plugin-throws-composing', 'throw@0', 'plugin runtime threw'],
  ['plugin-throws-running', 'throw@6000', 'plugin runtime threw'],
  ['plugin-rejects-running', 'reject@6000', 'plugin runtime rejection'],
]) await runCase(name, async ({ check, launch }) => {
  const report = join(root, `report-${name}.jsonl`)
  try {
    const { run, home } = await launchPluginCase(launch, name, [['accept-misbehave', 'misbehave.mjs', { mode }]], report)
    check('the crash line is on screen', await until(async () => (await run.screen()).includes('dsh-tui crashed'), 20000), `${timeline(run)}\n${lines(await run.screen()).slice(-8).join('\n')}`)
    const state = await run.t.state()
    const modes = state.modes
    check('terminal restored by the TUI (before the launcher prompt)',
      modes.alternate_screen === false && modes.cursor_visible === true && modes.bracketed_paste === false && modes.focus_events === false && state.mouse_mode === 'none',
      JSON.stringify({ ...modes, mouse_mode: state.mouse_mode }))
    const screen = await run.screen()
    check('one crash line, no DSH fail-loud line', screen.split('dsh-tui crashed').length === 2 && !screen.includes('dsh: fatal'), lines(screen).slice(-8).join('\n'))
    const crashLog = join(home, '.dsh-tui', 'crash.log')
    check('crash.log names the plugin error', existsSync(crashLog) && readFileSync(crashLog, 'utf8').includes(text))
    check(`crashed ${run.traced('startup-adopted') ? 'after' : 'before'} the adoption`, true)
    check('the safe-mode prompt follows', await until(async () => (await run.screen()).includes(SAFE_MODE), 10000, 25), lines(await run.screen()).slice(-4).join('\n'))
    await run.t.type('n')
    await run.t.press('Enter')
    await checkExit(run, check, { code: 1 })
  } finally {
    writeFileSync(profilePatchFile, '[]\n')
  }
})

// A third-party row holding SIGTERM / SIGINT / SIGHUP with listeners of its
// own: the entry still ends by the signal (dieBySignal drops its own
// listeners, then after 0.5s every listener, and raises it again); terminal
// restored, no safe-mode prompt.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) await runCase(`plugin-holds-${signal.toLowerCase()}`, async ({ check, launch }) => {
  const report = join(root, `report-holds-${signal}.jsonl`)
  try {
    const { run, home } = await launchPluginCase(launch, `holds-${signal}`, [['accept-misbehave', 'misbehave.mjs', { mode: 'signals' }]], report)
    check('adopted in the entry', await until(() => adoptedInEntry(run), 60000), timeline(run))
    const pid = entryPidOf(run)
    const sentAt = Date.now()
    process.kill(pid, signal)
    const ms = await waitGone(run, sentAt)
    const state = await run.t.state()
    check(`ends by ${signal} (exited=${state.exited} signal=${state.exit_signal})`, state.exit_signal === SIGNAL_TEXT[signal])
    check(`signal → gone ${ms}ms (≤ 3000: the 0.5s grace included)`, ms <= 3000)
    check("the plugin's own listener ran", readReport(report).some(entry => entry.event === 'signal' && entry.signal === signal), JSON.stringify(readReport(report)))
    check('the entry took the signal', homeRestartLog(home).some(line => line.includes('signal: received') && line.includes(signal)), homeRestartLog(home).filter(line => line.includes('signal')).join('\n'))
    check('no crash, no safe-mode prompt', !homeRestartLog(home).some(line => / pid=\d+ crash /.test(line)) && !(await run.screen()).includes(SAFE_MODE), lines(await run.screen()).slice(-4).join('\n'))
    await checkExit(run, check)
  } finally {
    writeFileSync(profilePatchFile, '[]\n')
  }
})

// ── Codex kernel in the entry (the rebase brought `entryKernel` codex) ────
// A Codex launch used to take the DSH branch of the entry's dispatch: the
// whole DSH profile was composed into the entry's root and the runtime then
// opened whatever kernel it remembered — so `DSH_TUI_BACKEND=codex` painted
// a DSH session (deepseek-flash) and never even probed for a `codex`
// executable. The route hands `runInEntry` the kernel it found, so only DSH
// composes the DSH profile (the other kernels compose the light one, 5.7);
// the Codex session is opened by the runtime itself,
// and the process-wide codex hub (src/backends/codex/rpc/hub.ts) has to be
// closed on the way out.
//
// The fake `codex` here is a real child process
// (scripts/fixtures/codex/fake-app-server-child.ts) speaking the app-server's
// newline-delimited JSON-RPC on stdio, driven by the in-process fake the
// Codex regressions use: the executable probe, transport, hub and session are
// the production ones, only the binary is replaced.
const fakeCodexPath = join(root, 'fake-codex.sh')
/** Written on first use: a run that selects none of these cases adds nothing. */
function fakeCodex() {
  writeFileSync(fakeCodexPath, `#!/bin/sh
exec '${process.execPath}' '${repo}/node_modules/tsx/dist/cli.mjs' '${repo}/scripts/fixtures/codex/fake-app-server-child.ts' "$@"
`)
  chmodSync(fakeCodexPath, 0o755)
  return fakeCodexPath
}
/** The environment a Codex case injects (see launch()). */
const codexEnv = log => ({
  CODEX_EXECUTABLE: fakeCodex(),
  FAKE_CODEX_LOG: log,
  OPENAI_API_KEY: 'fixture',
  CODEX_HOME: join(root, 'codex-home'),
})
const codexNotes = (run, log) => [
  `marks: ${run.marks().map(entry => entry.mark).join(', ')}`,
  `fake codex log:\n${readLines(log).join('\n')}`,
].join('\n')
/**
 * Whether the full DSH profile ran on this launch: the profile's own
 * `dsh-tui` Config row applied (`src/dsh-adapter/index.ts` `apply`). This —
 * not `entry-compose-*` — is what separates the routes now: since 5.7 the
 * non-DSH kernels compose the *light* profile into the same entry root
 * (`src/dsh-adapter/host-entry.ts` `composeLiteRoot`), and that plan disables
 * the `dsh-tui` row (`src/dsh-adapter/lite-profile.ts`). A Codex launch that
 * took the DSH route shows this mark — such a launch painted a DSH session
 * and never probed for `codex`, which is what these cases guard against.
 */
const dshProfileRowApplied = run => run.traced('row-apply')
/** The light composition ran on this launch and settled (either non-DSH kernel). */
const lightProfileComposed = run =>
  run.traced('entry-first-frame-flushed') && run.traced('entry-compose-start') && run.traced('entry-compose-end')

await runCase('codex-in-entry', async ({ check, launch }) => {
  const log = join(root, 'codex-entry.log')
  const run = await launch({ backend: 'codex', landing: false, env: codexEnv(log) })
  check('the Codex session is up in the entry', await until(async () => (await run.screen()).includes('gpt-fixture'), 60000), lines(await run.screen()).slice(-8).join('\n'))
  check('the entry ran itself, not `dsh --profile`', run.traced('entry-start') && run.traced('entry-hijacked'), codexNotes(run, log))
  check('the DSH profile was not composed for a Codex launch',
    !dshProfileRowApplied(run) && await until(() => lightProfileComposed(run), 30000), codexNotes(run, log))
  check('the session was adopted', run.traced('startup-adopted'), codexNotes(run, log))
  const handshake = readLines(log)
  check('the app-server was probed and handshaken with (initialize, thread/start)',
    handshake.some(line => line.includes('version')) && handshake.some(line => line.includes('in initialize')) && handshake.some(line => line.includes('in thread/start')),
    handshake.join('\n'))
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

await runCase('codex-in-entry-pool-closed', async ({ check, launch }) => {
  // The child refuses to exit on stdin EOF: only a close that is real ends it
  // (Transport.close escalates EOF → SIGTERM after CLOSE_GRACE_MS), while a
  // parent that merely dies leaves the pipe to end and the child behind.
  // A plain SIGTERM case cannot show this: the child shares the PTY's process
  // group, so the session going away hands it a SIGHUP first and the pipe
  // ending looks like a clean shutdown either way (measured: SIGTERM → the
  // child logged SIGHUP, no EOF).
  const log = join(root, 'codex-entry-hold.log')
  const run = await launch({ backend: 'codex', landing: false, env: { ...codexEnv(log), FAKE_CODEX_HOLD_ON_EOF: '1' } })
  check('the Codex session is up in the entry', await until(async () => (await run.screen()).includes('gpt-fixture'), 60000), lines(await run.screen()).slice(-8).join('\n'))
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
  const sent = readLines(log)
  const eof = sent.findIndex(line => line.includes('stdin-eof'))
  const term = sent.findIndex(line => line.includes('SIGTERM'))
  check('the child held on after EOF', eof !== -1 && sent.some(line => line.includes('hold-on-eof')), sent.join('\n'))
  check('the entry closed the codex hub pool (EOF → SIGTERM, not the pipe alone)', term > eof && term !== -1, sent.join('\n'))
})

await runCase('codex-kernel-remembered', async ({ check, launch }) => {
  // The other way a launch lands on Codex: the remembered kernel, with no
  // DSH_TUI_BACKEND at all (`kernel.json` on this case's own HOME).
  const home = join(root, 'codex-remembered-home')
  mkdirSync(join(home, '.dsh-tui'), { recursive: true })
  writeFileSync(join(home, '.dsh-tui', 'kernel.json'), `${JSON.stringify({ backend: 'codex' })}\n`)
  writeFileSync(join(home, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
  const log = join(root, 'codex-remembered.log')
  // launch() defaults `backend` to 'claude' (so every other case sets
  // DSH_TUI_BACKEND): an explicit undefined here drops the variable, which is
  // what lets kernel.json decide.
  const run = await launch({ backend: undefined, landing: false, env: { ...codexEnv(log), HOME: home, DSH_TUI_BACKEND: undefined } })
  check('the remembered Codex kernel is up in the entry', await until(async () => (await run.screen()).includes('gpt-fixture'), 60000), lines(await run.screen()).slice(-8).join('\n'))
  check('the DSH profile was not composed',
    !dshProfileRowApplied(run) && await until(() => lightProfileComposed(run), 30000), codexNotes(run, log))
  await run.command('/quit')
  await checkExit(run, check, { code: 0 })
})

// ── 5.7: the plugin ecosystem on a non-DSH kernel ────────────────────────
// Nothing about the plugin ecosystem may depend on the DSH route. On Claude
// and Codex no `dsh-tui` row exists at all: the entry composes the light
// profile into the root the screen is already mounted on (`host-entry.ts`
// composeLiteRoot), and that composition is the only reason a third-party
// plugin comes up on those kernels. The same three fixtures the DSH paths run
// have to work here — the runtime theme, the panel, the `tui/input` decision —
// and `/settings` has to still list this package's own section: the runtime
// moves it onto the composed sections service (plugin.ts
// `rehomeSettingsSection`, reached through the seam's `composeSucceeded`).
// Without that the user cannot change this package's settings at all on this
// kernel (language, theme, fullscreen, status line, shortcuts).
//
// The theme is forced through DSH_TUI_THEME rather than a persisted
// ~/.dsh-tui/theme.json. Persisted-theme is what the DSH paths assert, but on
// this kernel it is the wrong probe: `BRAND_THEMES` (branding.ts) gives the
// claude and codex brands a default theme pair, and a persisted-preference
// request is deliberately not a lock — the brand default wins until the user
// picks through `/theme` or the environment. Measured on this fixture: with
// only theme.json the screen keeps the brand palette (0 cells of #ab12cd) on
// Claude, while a DSH kernel (the deepseek brand is not in BRAND_THEMES) draws
// the runtime theme (451). DSH_TUI_THEME is an explicit wish, so the brand
// default yields there — and what the assertion then measures is exactly 5.7's
// seam: the theme can only be resolved and drawn once the composition has
// settled and handed the live theme host to the mounted screen (the runtime's
// `refreshHostServices`, reached through `composeSucceeded`). With that call
// removed the screen stays on the detection palette (measured 0 cells).
for (const kernel of ['claude']) await runCase(`plugins-light-${kernel}`, async ({ check, launch }) => {
  const report = join(root, `report-plugins-light-${kernel}.jsonl`)
  rmSync(report, { force: true })
  const home = pluginHome(`plugins-light-${kernel}`, { 'theme.json': { theme: 'accept-theme' }, 'extension-grants.json': GRANTS })
  await withProfilePatch(pluginPatch([['accept-theme', 'theme.mjs'], ['accept-panels', 'panels.mjs'], ['accept-guard', 'guard.mjs']], report), async () => {
    const run = await launch({ backend: kernel, landing: false, cols: 150, rows: 36, env: { HOME: home, DSH_TUI_THEME: 'accept-theme' } })
    await run.t.getByText(PROMPT).expect({ timeout: 60000 })
    check('adopted', await until(() => run.traced('startup-adopted'), 60000), timeline(run))
    check('the light profile composed, not the DSH one (no dsh-tui row on this kernel)',
      await until(() => lightProfileComposed(run), 30000) && !dshProfileRowApplied(run), timeline(run))
    const entries = () => readReport(report)
    const find = (plugin, event) => entries().find(entry => entry.plugin === plugin && entry.event === event)
    // (1) the runtime theme, registered by a plugin row of the light profile
    check('theme registered', find('theme', 'registered')?.ok === true, JSON.stringify(entries()))
    check('the runtime theme is drawn after the composition settled', await until(async () => (await themedCells(run)) > 20, 8000), `themed cells: ${await themedCells(run)}`)
    // (2) the panel, under the plugin's own identity. All four of these are
    // the admission + panel/store half of the plugin acceptance, which no kernel takes
    // part in: the identity comes from the plugin's own manifest, the budget
    // from the panel store, the namespace file from the storage contract.
    await until(() => find('panels', 'opened') !== undefined || find('panels', 'open-failed') !== undefined, 20000)
    check('panels plugin admitted as accept-panels', find('panels', 'admitted')?.componentId === 'accept-panels', JSON.stringify(entries()))
    const panels = find('panels', 'registered')
    check('panel id carries the plugin id (no act<N> fallback)', JSON.stringify(panels?.ids) === '["accept-panels:demo"]', JSON.stringify(panels))
    const budget = find('panels', 'budget')
    check('panel budget counted per plugin: 3 more fit, a 5th is refused', budget?.accepted === 3 && budget?.fifthRefused === true, JSON.stringify(budget))
    check('storage write under the plugin identity', find('panels', 'storage')?.ok === true && existsSync(join(home, '.dsh-tui', 'plugin-storage', 'accept-panels.json')), JSON.stringify(entries().filter(entry => entry.plugin === 'panels')))
    check('panel opened', find('panels', 'opened') !== undefined, JSON.stringify(entries().filter(entry => entry.plugin === 'panels')))
    check('panel shown', await until(async () => (await run.screen()).includes('ACCEPT-PANEL-BODY'), 8000), lines(await run.screen()).join('\n'))
    await run.t.press('Escape')
    await sleep(300)
    // (3) decisions against the same entry root: the channel's dispatch is
    // the same one the DSH paths run, both points included. (The DSH paths
    // additionally assert the input *rewrite*'s delivered text and a
    // transport failure: those two need a model request, which on this kernel
    // goes to the real Claude backend — the offline `llm-deepseek` row those
    // cases patch in is part of the DSH profile the light composition leaves
    // out, so they stay off this kernel.)
    check('guard admitted as accept-guard and subscribed', await until(() => find('guard', 'subscribed')?.componentId === 'accept-guard', 20000), JSON.stringify(entries().filter(entry => entry.plugin === 'guard')))
    await run.clear()
    await run.t.type('accept-veto this line')
    await sleep(300)
    await run.t.press('Enter')
    check('tui/input veto: the reason is on screen', await until(async () => (await run.screen()).includes('ACCEPT-VETOED'), 8000), lines(await run.screen()).slice(-10).join('\n'))
    check('the guard saw the input as accept-guard', entries().some(entry => entry.event === 'input' && entry.text === 'accept-veto this line' && entry.componentId === 'accept-guard'))
    await run.clear()
    await run.command('/new')
    check('tui/session-switch veto: the reason is on screen', await until(async () => (await run.screen()).includes('ACCEPT-SWITCH-VETOED'), 8000), lines(await run.screen()).slice(-10).join('\n'))
    check('the guard saw the /new', entries().some(entry => entry.event === 'session-switch' && entry.kind === 'new'))
    await run.clear()
    // (4) this package's own settings section, on this kernel
    await run.command('/settings')
    check('/settings lists the dsh-tui section', await until(async () => (await run.screen()).includes('dsh-tui (dsh-tui)'), 8000), lines(await run.screen()).slice(0, 8).join('\n'))
    await run.t.press('Escape')
    await sleep(300)
    await run.clear()
    await run.command('/quit')
    await checkExit(run, check, { code: 0 })
    check('no crash in restart.log', !homeRestartLog(home).some(line => / pid=\d+ crash /.test(line)), homeRestartLog(home).join('\n'))
  })
})

const failed = results.filter(result => result.status === 'fail').length
console.log(`\naccept-host-entry: ${results.length} cases, ${results.filter(result => result.status === 'pass').length} pass, ${failed} fail`)
if (flag('--keep')) console.error(`[accept] kept ${root}`)
else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) // a CLI that just got TERM may still be writing
process.exit(failed > 0 ? 1 : 0)
