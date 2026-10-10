/**
 * The standalone entry's process ownership (docs/standalone-host-design.md
 * 5.5, src/dsh-adapter/process-exit.ts), headless. Each case runs in a
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
 *  - a foreign listener on the signal (a plugin's) cannot keep it alive;
 *  - the entry's own, owner-less dispose closes what the funnel's teardown
 *    closes as well (the process-wide codex hub pool), and it routes the
 *    kernel it found rather than a literal backend.
 *
 * And the root dispose during the profile composition
 * (src/dsh-adapter/root-dispose.ts): a minimal root from the host packages
 * this package depends on (@deepseek-ai/dsh 0.2.0-rc.2: its cordis, Loader,
 * timer and dsh-hmr rows, a profile whose readiness never comes), disposed
 * right after dsh-hmr's fiber starts loading. Disposed directly the root
 * never settles (dsh-hmr's deadlock, at least once in a few tries — if that
 * stops reproducing, the host fixed it and the wait can be reconsidered);
 * through `disposeRootSettled` with the composition tracked it settles every
 * time.
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

// ── child mode: dispose a composing root (raw | settled, delay ms) ───────
if (process.argv[2] === '--hmr-child') {
  const mode = process.argv[3]
  const delay = Number(process.argv[4] ?? 0)
  const { loadHostDsh } = await import('../src/dsh-adapter/host-dsh.js')
  const { disposeRootSettled, trackComposition } = await import('../src/dsh-adapter/root-dispose.js')
  const { realpathSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const dshDir = realpathSync(join(here, '../node_modules/@deepseek-ai/dsh'))
  const host = await loadHostDsh(dshDir)
  const hostRequire = createRequire(join(dshDir, 'package.json'))
  const dir = mkdtempSync(join(tmpdir(), 'verify-entry-hmr-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"verify-entry-hmr","private":true}\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: timer', `  name: '${pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis-plugin-timer')).href}'`,
    '- id: hmr', `  name: '${pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-hmr')).href}'`, '  config:', '    root: []', ''].join('\n'))
  const ctx = new host.Context() as import('@deepseek-ai/cordis').Context & { baseUrl?: string }
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  ctx.provide('profileContext' as never, { name: 'verify', dir, patchPath: join(dir, 'cordis.patch.yml'), home: dir, startedBundles: [], overlays: [] } as never)
  // Readiness never comes: the composition is cut short by the dispose.
  ctx.provide('appReady' as never, { onReady: () => () => undefined } as never)
  await ctx.plugin(host.Loader as never, undefined as never)
  if (mode === 'settled') trackComposition(ctx, async () => { await (ctx.get('loader' as never) as { await(): Promise<unknown> }).await() })
  let fired = false
  ctx.on('internal/status' as never, ((fiber: { name: string; state: number }) => {
    if (fiber.name !== 'Hmr' || fiber.state !== 1 || fired) return
    fired = true
    setTimeout(() => {
      const startedAt = Date.now()
      // Referenced: the deadlock is a promise cycle that holds no handle, so
      // the process would otherwise just drain and end.
      setTimeout(() => { process.stdout.write('hang\n'); process.exit(2) }, 1500)
      const dispose = mode === 'settled' ? disposeRootSettled(ctx) : ctx.root.fiber.dispose()
      void dispose.then(() => { process.stdout.write(`disposed ${Date.now() - startedAt}\n`); process.exit(0) })
    }, delay)
  }) as never)
  void host.appBoot.mountRootInclude(ctx, join(dir, 'cordis.yml'), [], undefined, 'dsh')
} else if (process.argv[2] === '--child') {
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

  // ── a root dispose while the profile composes ─────────────────────────
  const runHmr = (mode: 'raw' | 'settled', delay: number): Promise<{ code: number | null; out: string }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--hmr-child', mode, String(delay)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`hmr ${mode}: child did not end; output:\n${out}`)) }, 20000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out += chunk })
    child.on('exit', code => { clearTimeout(killer); resolve({ code, out: out.trim() }) })
  })
  const raw = []
  for (const delay of [0, 0, 0]) {
    raw.push(await runHmr('raw', delay))
    if (raw.at(-1)?.out === 'hang') break
  }
  check('the trigger reaches dsh-hmr\'s deadlock: a root disposed while HMR starts does not settle', raw.some(outcome => outcome.out === 'hang'), raw)
  const settled = []
  for (const delay of [0, 0, 0, 1, 5, 20]) settled.push(await runHmr('settled', delay))
  check('disposeRootSettled: the composition settles first, the root dispose then settles every time',
    settled.every(outcome => outcome.code === 0 && /^disposed \d+$/.test(outcome.out) && Number(outcome.out.split(' ')[1]) < 1000), settled)

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
  check('a root dispose lets a composition in progress settle first (the funnel and the entry\'s own)',
    /disposeRootSettled\(ctx, \(\) => withHostRootCapability\(\(\) => ctx\.root\.fiber\.dispose\(\)\)\)/.test(plugin)
    && /disposeRoot: \(\) => disposeEntryRoot\(ctx\)/.test(entry) && /await disposeRootSettled\(ctx\)/.test(entry))
  // A signal that lands before the runtime filled `exitSeam.request` takes the
  // entry's own dispose instead of the funnel's, so it must close what the
  // funnel's teardown closes: the codex hub pool is process-wide and no
  // session's own dispose closes it (src/backends/codex/rpc/hub.ts).
  check('the entry\'s own dispose closes the backend resources the funnel also closes',
    /disposeRootSettled\(ctx\)\n  \} finally \{/.test(entry)
    && /const \{ unloadBackends \} = await import\('\.\/backend-registry\.js'\)\n      await unloadBackends\(\)/.test(entry))
  check('the entry tracks its composition, which stops short of the audit and readiness once a dispose waits',
    /const composition = trackComposition\(ctx, /.test(entry) && /await root\.compose\([^\n]*\(\) => composition\.disposing\)/.test(entry)
      && /if \(loader\(\) === undefined \|\| stopping\(\)\) return/.test(hostDsh) && /&& !stopping\(\)\) appReady\.commit\(\)/.test(hostDsh))
  check('the dsh-tui row opens no DSH session once the exit started',
    /if \(compositionFailed \|\| exited\) return/.test(plugin))
  // The entry routes the kernel it found and hands it to `runInEntry` as it
  // is: only DSH composes the profile and so publishes the slot, while Claude
  // and Codex mount without it and let the runtime resolve the kernel itself.
  // Passing the literal 'dsh' into `runInEntry` is what silently degraded
  // Codex to DSH (`dshInEntry` then pins the runtime's backend choice).
  check('the entry runs the kernel its route found, not a literal backend (only DSH then publishes the slot)',
    /const route = entryRoute\(entryKernel\(process\.env, \{ configured: configuredBackend\(profile\) \}\)\)/.test(entry)
    && /if \(route\.kind === 'entry'\) await runInEntry\(route\.kernel\)/.test(entry)
    && /else delegateToDsh\(\)/.test(entry)
    && /const slot = kernel === 'dsh' && root !== undefined \? publishEntrySlot\(\) : undefined/.test(entry))
  check('/restart and /update supervise their replacement through the seam',
    /const supervision = superviseReplacement\(exitSeam, options\)/.test(plugin) && /superviseReplacement\(exitSeam, \{\}\)/.test(plugin))

  console.log(`\nverify-entry-process-exit: ${passed} checks passed`)
}
