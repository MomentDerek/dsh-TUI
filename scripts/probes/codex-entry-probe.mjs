#!/usr/bin/env node
/**
 * Probe: this package's entry with the Codex kernel
 * (docs/standalone-host-design.md, the "Codex 内核与入口" open item).
 *
 * Runs the real launcher in a PTY with `DSH_TUI_BACKEND=codex` and a fake
 * `codex` (scripts/fixtures/codex/fake-app-server-child.ts through
 * CODEX_EXECUTABLE), then reports what actually happened:
 *
 *  - the boot trace (was the route the entry, or `dsh --profile`? did the
 *    DSH profile compose, which the Codex route must not do?);
 *  - the screen (first frame, session, any failure row);
 *  - the fake app-server's own log (--version probe, initialize,
 *    config/read, thread/start, and HOW the child ended: stdin EOF, a
 *    signal, or nothing at all);
 *  - the exit (code, terminal restored, marked processes left behind, and
 *    whether the fake app-server child outlived the entry).
 *
 * Opt-in and Linux/macOS only. Requires the installed `dsh` and its dsh-tui
 * profile plus `pnpm compile`, like scripts/accept-host-entry.mjs.
 *
 * Run: node scripts/probes/codex-entry-probe.mjs [--quit|--sigterm] [--keep]
 *      [--sessions] [--alt-home] [--with-claude] [--assert] [--stale-route]
 *      --sessions    pre-pin the kernel in <root>/.dsh-tui/kernel.json
 *      --alt-home    the same pin on a HOME of its own
 *      --with-claude also inject CLAUDE_CODE_EXECUTABLE, as the acceptance does
 *      --assert      print the acceptance's dispatch verdicts
 *      --stale-route patch the isolated entry back to the two-branch dispatch
 *                    (`claude`, else `dsh`) — the "would this go red without
 *                    the route fix" mutation; only the temp profile is touched
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TuiTest } from '@microsoft/tui-test'
import { buildIsolatedProfile, executable } from '../lib/isolated-profile.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const mode = flag('--sigterm') ? 'sigterm' : 'quit'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const { root, dshHome, launcher, dshBin } = buildIsolatedProfile({ repo, prefix: `dsh-tui-probe-codex-${mode}-` })
mkdirSync(join(root, '.dsh-tui'), { recursive: true })
writeFileSync(join(root, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
if (flag('--sessions')) {
  // The other way a launch lands on Codex: the remembered kernel.
  writeFileSync(join(root, '.dsh-tui', 'kernel.json'), `${JSON.stringify({ backend: 'codex' }, null, 2)}\n`)
}
// The same pin, but on a HOME of its own (what the acceptance case does).
const altHome = flag('--alt-home') ? join(root, 'alt-home') : undefined
if (altHome !== undefined) {
  mkdirSync(join(altHome, '.dsh-tui'), { recursive: true })
  writeFileSync(join(altHome, '.dsh-tui', 'kernel.json'), `${JSON.stringify({ backend: 'codex' }, null, 2)}\n`)
  writeFileSync(join(altHome, '.dsh-tui', 'onboarding.json'), JSON.stringify({ completed: true, version: 1 }))
  console.log(`(alt home: ${altHome}, kernel.json written)`)
}

// The mutation for "would the assertion go red without the route fix?": the
// isolated profile's copy of this checkout goes back to the two-branch
// dispatch (`claude`, else `dsh`), which is what ran Codex through the DSH
// profile. Only the temp profile is touched.
if (flag('--stale-route')) {
  const entryJs = join(dshHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'lib', 'types', 'dsh-adapter', 'host-entry.js')
  const before = readFileSync(entryJs, 'utf8')
  const after = before
    .replace(
      "import { configuredBackend, entryKernel, entryRoute, hostProfile } from '../hostEntryRoute.js';",
      "import { configuredBackend, entryKernel, hostEntryDshEnabled, hostProfile } from '../hostEntryRoute.js';",
    )
    .replace(
      `const route = entryRoute(entryKernel(process.env, { configured: configuredBackend(profile) }));
if (route.kind === 'entry')
    await runInEntry(route.kernel);
else
    delegateToDsh();`,
      `const kernel = entryKernel(process.env, { configured: configuredBackend(profile) });
if (kernel === 'claude')
    await runInEntry('claude');
else if (hostEntryDshEnabled())
    await runInEntry('dsh');
else
    delegateToDsh();`,
    )
  if (after === before) throw new Error('--stale-route: the dispatch patch did not apply')
  writeFileSync(entryJs, after)
  console.log('(stale route: the isolated entry dispatches claude / else dsh)')
}

const node = process.execPath
const child = join(repo, 'scripts', 'fixtures', 'codex', 'fake-app-server-child.ts')
const fakeCodex = join(root, 'fake-codex.sh')
writeFileSync(fakeCodex, `#!/bin/sh
exec '${node}' '${repo}/node_modules/tsx/dist/cli.mjs' '${child}' "$@"
`)
chmodSync(fakeCodex, 0o755)

const logPath = join(root, 'fake-codex.log')
const trace = join(root, 'trace.jsonl')
const marker = `probe-codex-${randomUUID()}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readLines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
const lines = text => text.split('\n').filter(line => line.trim() !== '')

/** Processes whose environment carries `marker` (Linux /proc only). */
function markedProcesses(marker) {
  if (!existsSync('/proc/self/environ')) return []
  const found = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'latin1').includes(marker)) {
        found.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'latin1').replaceAll('\0', ' ').slice(0, 140)}`)
      }
    } catch { /* gone */ }
  }
  return found
}

const full = {
  HOME: altHome ?? root,
  PATH: `${dshBin}:${process.env.PATH ?? ''}`,
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  DSH_HOME: dshHome,
  DSH_TUI_SESSION_ROOT: join(root, 'sessions'),
  DSH_TUI_WORKSPACE_TARGET: repo,
  DSH_TUI_BACKEND: flag('--sessions') || altHome !== undefined ? undefined : 'codex',
  DSH_TUI_LANG: 'en',
  DSH_TUI_BOOT_TRACE: trace,
  DSH_TELEMETRY_MODE: 'DISABLED',
  NODE_ENV: 'production',
  DSH_TUI_PROBE_MARKER: marker,
  DSH_TUI_NO_LAUNCHPAD: '1',
  CODEX_EXECUTABLE: fakeCodex,
  FAKE_CODEX_LOG: logPath,
  // detectCodexAuth reads the environment, not the app-server: without one
  // the TUI would refuse to open a session and never reach the spawn.
  OPENAI_API_KEY: 'fixture',
  CODEX_HOME: join(root, '.codex'),
  // Passed through when set: a child that refuses to exit on stdin EOF, so a
  // real close (SIGTERM/SIGKILL) is distinguishable from the pipe ending.
  FAKE_CODEX_HOLD_ON_EOF: process.env.FAKE_CODEX_HOLD_ON_EOF,
  // The acceptance's launch() injects this unconditionally; here it is opt-in
  // so the two environments can be compared.
  ...(flag('--with-claude') ? { CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? executable('claude') } : {}),
}
mkdirSync(join(root, '.codex'), { recursive: true })

const t = TuiTest.ephemeral(`probe-codex-${mode}`)
const startedAt = Date.now()
await t.run('/usr/bin/env', ['-i', ...Object.entries(full).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`), process.execPath, launcher], { cols: 100, rows: 30, cwd: repo })

const report = async label => {
  const screen = await t.text().catch(() => '')
  console.log(`\n===== ${label} @ +${Date.now() - startedAt}ms =====`)
  console.log(lines(screen).slice(-24).join('\n'))
  console.log(`--- fake codex log (${existsSync(logPath) ? readLines(logPath).length : 0} lines) ---`)
  console.log(readLines(logPath).map(line => line.replace(/^(\d+)/u, (_, ms) => `+${Number(ms) - startedAt}ms`)).join('\n'))
  const marks = readLines(trace).map(line => JSON.parse(line))
  console.log(`--- boot marks: ${marks.map(entry => entry.mark).join(', ')} ---`)
}
await sleep(15000)
await report('after 15s')

// The same dispatch facts the acceptance asserts, so the mutation (--stale-route)
// shows which of them go red.
if (flag('--assert')) {
  const marks = readLines(trace).map(line => JSON.parse(line)).map(entry => entry.mark)
  const sent = readLines(logPath)
  const screen = await t.text().catch(() => '')
  const verdicts = [
    ['the entry ran itself, not `dsh --profile`', marks.includes('entry-start') && marks.includes('entry-hijacked')],
    ['the DSH profile was not composed for this kernel', !marks.some(mark => mark.startsWith('entry-compose'))],
    ['the session was adopted', marks.includes('startup-adopted')],
    ['the Codex session is on screen', screen.includes('gpt-fixture')],
    ['the app-server was handshaken with', sent.some(line => line.includes('in initialize')) && sent.some(line => line.includes('in thread/start'))],
  ]
  console.log('\n===== assertions =====')
  for (const [label, ok] of verdicts) console.log(`${ok ? 'ok ' : 'NO '} ${label}`)
  console.log(`--- ${verdicts.filter(([, ok]) => ok).length}/${verdicts.length} hold ---`)
}

if (mode === 'quit') {
  await t.type('/quit')
  await sleep(500)
  await t.press('Enter')
} else {
  const marked = markedProcesses(marker)
  console.log(`\n--- SIGTERM to ${JSON.stringify(marked)} ---`)
  const pid = Number(marked[0]?.split(' ')[0])
  if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM')
}
try {
  await t.waitExit({ timeout: 25000 })
} catch (error) {
  console.log(`waitExit: ${error instanceof Error ? error.message : String(error)}`)
}
const exitedAt = Date.now()
const state = await t.state().catch(error => ({ error: String(error) }))
console.log(`\n===== exit =====`)
console.log(JSON.stringify(state, null, 2))
await sleep(1000)
console.log(`--- fake codex log after exit (${readLines(logPath).length} lines) ---`)
console.log(readLines(logPath).map(line => line.replace(/^(\d+)/u, (_, ms) => `+${Number(ms) - startedAt}ms`)).join('\n'))
let left = markedProcesses(marker)
for (let waited = 0; left.length > 0 && waited < 5000; waited += 250) {
  await sleep(250)
  left = markedProcesses(marker)
}
console.log(`--- marked processes left: ${left.length === 0 ? 'none' : left.join(' | ')} ---`)
console.log(`--- exit at +${exitedAt - startedAt}ms ---`)
console.log(`--- isolated root: ${root} ---`)
await t.closeQuiet()
if (!flag('--keep')) rmSync(root, { recursive: true, force: true })
else console.log('(--keep: root left in place)')
