/**
 * The standalone entry's process ownership (docs/standalone-host-design.md
 * block 2.5, src/dsh-adapter/process-exit.ts), headless. Each case runs in a
 * child process (it ends by a signal) that installs the entry's signal
 * handling with a scripted exit seam, then receives a signal from here:
 *
 *  - the funnel takes it (`exiting`): no fallback dispose; the process ends
 *    by the signal when the owner says so;
 *  - nobody owns the process (`refused`, or no seam yet): the root is
 *    disposed, then the process ends by the signal — SIGTERM, SIGHUP and
 *    SIGINT alike (a numeric 143/129/130 reads as a crash to the launcher);
 *  - a second signal ends it at once, the owner still busy;
 *  - `supervising` (a /restart supervisor) arms no backstop;
 *  - the owner stalls: the backstop ends it by the signal;
 *  - a foreign listener on the signal (a plugin's) cannot keep it alive.
 *
 * Plus the test-only fault switch parser (src/dsh-adapter/test-faults.ts) and
 * the source wiring the acceptance cases rely on.
 *
 * Run: node --import tsx/esm scripts/verify-entry-process-exit.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTestFault } from '../src/dsh-adapter/test-faults.js'

const here = dirname(fileURLToPath(import.meta.url))
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── child mode ────────────────────────────────────────────────────────
if (process.argv[2] === '--child') {
  const { installEntrySignals, dieBySignal } = await import('../src/dsh-adapter/process-exit.js')
  const mode = process.argv[3]
  const say = (line: string): void => { process.stdout.write(`${line}\n`) }
  const seam: import('../src/dsh-adapter/process-exit.js').ProcessExitSeam = {}
  if (mode === 'exiting') {
    seam.request = request => {
      say(`request ${request.kind === 'signal' ? request.signal : request.code}`)
      // The funnel's tail: restore, dispose, then die by the signal.
      setTimeout(() => { say('funnel done'); if (request.kind === 'signal') dieBySignal(request.signal) }, 100)
      return 'exiting'
    }
  } else if (mode === 'busy' || mode === 'stalled') {
    seam.request = () => { say('request'); return 'exiting' }
  } else if (mode === 'supervising') {
    seam.request = () => { say('request'); return 'supervising' }
  } else if (mode === 'refused') {
    seam.request = () => 'refused'
  }
  if (mode === 'foreign') process.on('SIGTERM', () => { say('foreign listener') })
  installEntrySignals({
    seam,
    disposeRoot: async () => { say('dispose'); await new Promise(resolve => setTimeout(resolve, 50)) },
    log: event => { say(`log ${event}`) },
  })
  say('ready')
  // Kept alive by a timer, as the real process is by its screen.
  setInterval(() => undefined, 1000)
} else {
  type Outcome = { code: number | null; signal: NodeJS.Signals | null; out: string; ms: number }
  const runChild = (mode: string, send: (child: ReturnType<typeof spawn>) => void, timeoutMs = 15000): Promise<Outcome> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--child', mode], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    let sentAt = 0
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${mode}: child did not end; output:\n${out}`)) }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const ready = !out.includes('ready') && (out + chunk).includes('ready')
      out += chunk
      if (ready) { sentAt = Date.now(); send(child) }
    })
    child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, ms: Date.now() - sentAt }) })
  })

  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    const unowned = await runChild('none', child => { child.kill(signal) })
    check(`no owner, ${signal}: the root is disposed, then the process ends by ${signal}`,
      unowned.signal === signal && unowned.code === null && unowned.out.includes('dispose'), unowned)
  }
  const refused = await runChild('refused', child => { child.kill('SIGTERM') })
  check('a refusing owner (tree torn down): the entry disposes the root itself and ends by the signal',
    refused.signal === 'SIGTERM' && refused.out.includes('dispose'), refused)

  const owned = await runChild('exiting', child => { child.kill('SIGINT') })
  check('the funnel takes SIGINT: no fallback dispose, the process ends by SIGINT after the funnel',
    owned.signal === 'SIGINT' && owned.out.includes('request SIGINT') && owned.out.includes('funnel done') && !owned.out.includes('dispose'), owned)

  const second = await runChild('busy', child => { child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGTERM') }, 200) })
  check('a second signal forces the exit at once while the owner is still busy',
    second.signal === 'SIGTERM' && second.out.includes('second signal') && second.ms < 2000, second)

  const stalled = await runChild('stalled', child => { child.kill('SIGHUP') })
  check('an owner that never ends the process: the backstop ends it by the signal (after the dispose bound)',
    stalled.signal === 'SIGHUP' && stalled.out.includes('backstop') && stalled.ms >= 5000, stalled)

  const supervising = await new Promise<{ alive: boolean; out: string }>(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--child', 'supervising'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const ready = !out.includes('ready') && (out + chunk).includes('ready')
      out += chunk
      if (ready) child.kill('SIGTERM')
    })
    setTimeout(() => {
      const alive = child.exitCode === null && child.signalCode === null
      child.kill('SIGTERM') // the second signal ends it
      child.on('exit', () => { resolve({ alive, out }) })
      if (!alive) resolve({ alive, out })
    }, 7500)
  })
  check('a supervising owner arms no backstop (the replacement decides; a second signal still ends it)', supervising.alive && supervising.out.includes('request'), supervising)

  const foreign = await runChild('foreign', child => { child.kill('SIGTERM') })
  check('a foreign SIGTERM listener cannot keep the process alive', foreign.signal === 'SIGTERM' && foreign.out.includes('foreign listener'), foreign)

  // ── delegateToDsh (DSH without the in-entry path) ─────────────────────
  // The entry hands the launch to `dsh` and mirrors its exit. A fake `dsh`
  // on PATH ends as told; the entry must end the same way — by the signal
  // when dsh died by one (its own SIGINT/SIGTERM/SIGHUP forwarders used to
  // catch the re-raised signal and end it with 0) — and pass a SIGTERM sent
  // to it alone on to dsh.
  const sandbox = mkdtempSync(join(tmpdir(), 'verify-entry-delegate-'))
  const bin = join(sandbox, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'dsh'), `#!/bin/sh
case "$FAKE_DSH" in
  exit7) exit 7 ;;
  sig*) kill -"\${FAKE_DSH#sig}" $$ ; sleep 5 ;;
  wait) trap 'echo dsh-got-term; exit 0' TERM; echo dsh-ready; while :; do sleep 0.1; done ;;
esac
`)
  chmodSync(join(bin, 'dsh'), 0o755)
  const runDelegate = (fake: string, send?: (child: ReturnType<typeof spawn>) => void): Promise<Outcome> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', join(here, '../src/dsh-adapter/host-entry.ts')], {
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: join(here, '..'),
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: sandbox,
        DSH_HOME: join(sandbox, '.dsh'),
        DSH_TUI_BACKEND: 'dsh',
        DSH_TUI_HOST_ENTRY_DSH: '0',
        FAKE_DSH: fake,
      },
    })
    let out = ''
    const startedAt = Date.now()
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`delegate ${fake}: did not end; output:\n${out}`)) }, 20000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const ready = !out.includes('dsh-ready') && (out + chunk).includes('dsh-ready')
      out += chunk
      if (ready) send?.(child)
    })
    child.on('exit', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, ms: Date.now() - startedAt }) })
  })
  for (const signal of ['INT', 'TERM', 'HUP'] as const) {
    const outcome = await runDelegate(`sig${signal}`)
    check(`delegate: dsh dies by SIG${signal}, the entry dies by it too (not 0)`, outcome.signal === `SIG${signal}` && outcome.code === null, outcome)
  }
  const exited = await runDelegate('exit7')
  check('delegate: a numeric dsh exit is passed on', exited.code === 7 && exited.signal === null, exited)
  const forwarded = await runDelegate('wait', child => { child.kill('SIGTERM') })
  check('delegate: SIGTERM to the entry alone reaches dsh, whose exit the entry mirrors', forwarded.out.includes('dsh-got-term') && forwarded.code === 0, forwarded)

  // ── the test-only fault switch ───────────────────────────────────────
  check('DSH_TUI_TEST_FAULT unset: no fault', readTestFault({}) === undefined)
  check('render@1500 parses', JSON.stringify(readTestFault({ DSH_TUI_TEST_FAULT: 'render@1500' })) === JSON.stringify({ kind: 'render', delayMs: 1500 }))
  check('app-exit:3 parses with the default delay', JSON.stringify(readTestFault({ DSH_TUI_TEST_FAULT: 'app-exit:3' })) === JSON.stringify({ kind: 'app-exit', code: 3, delayMs: 4000 }))
  check('an unknown fault is ignored', readTestFault({ DSH_TUI_TEST_FAULT: 'boom' }) === undefined)

  // ── wiring ─────────────────────────────────────────────────────────────
  const entry = readFileSync(join(here, '../src/dsh-adapter/host-entry.ts'), 'utf8')
  const plugin = readFileSync(join(here, '../src/dsh-adapter/plugin.ts'), 'utf8')
  const hostDsh = readFileSync(join(here, '../src/dsh-adapter/host-dsh.ts'), 'utf8')
  check('the entry installs the signal handling with the seam it hands to apply',
    /installEntrySignals\(\{\s*seam: exitSeam/.test(entry) && /apply\(ctx, config, ctx, \{[^}]*exitSeam/.test(entry))
  check('the entry drops DSH fail-loud once the TUI process guard is up (one owner of a fatal error)',
    /processGuardActive\(\)\) root\.uninstallFailLoud\(\)/.test(entry) && entry.indexOf('root.uninstallFailLoud()') > entry.indexOf('await apply(ctx, config'))
  check('appExit goes to the seam first, the bounded shutdown only when refused',
    /exitSeam\?\.request\?\.\(\{ kind: 'code', code \}\)/.test(hostDsh) && /if \(answer === 'refused'\) void shutdown\(code\)/.test(hostDsh))
  check('the funnel fills the seam and clears it on teardown',
    /exitSeam\.request = requestProcessExit/.test(plugin) && /if \(exitSeam\?\.request === requestProcessExit\) exitSeam\.request = undefined/.test(plugin))
  check('a signal exit dies by the signal after the root dispose, the stalled case too',
    /disposeRootAndThen\(ctx, \(\) => \{ dieBySignal\(request\.signal\) \}, \(\) => \{ dieBySignal\(request\.signal\) \}\)/.test(plugin))
  check('/restart and /update supervise their replacement through the seam',
    /const supervision = superviseReplacement\(exitSeam, options\)/.test(plugin) && /superviseReplacement\(exitSeam, \{\}\)/.test(plugin))

  console.log(`\nverify-entry-process-exit: ${passed} checks passed`)
}
