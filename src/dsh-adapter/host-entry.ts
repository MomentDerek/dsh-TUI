/**
 * This package's own entry (docs/standalone-host-design.md 5.8, Phase 1 and
 * Phase 2): the TUI on a Cordis root of its own. The launcher starts it as
 * `node lib/types/dsh-adapter/host-entry.js <app args>` instead of
 * `dsh --profile <profile> -- <app args>` for both kernels (bin/dsh-tui.js;
 * `DSH_TUI_HOST_ENTRY_DSH=0` keeps DSH on `dsh --profile`,
 * `DSH_TUI_HOST_ENTRY=0` switches all of it off).
 *
 * It decides the kernel again with the profile patch's Config row
 * (../hostEntryRoute.ts). A launch that lands on DSH while
 * `DSH_TUI_HOST_ENTRY_DSH=0`, or whose installed dsh the entry cannot use
 * (said on stderr and in the delegated screen), is handed to
 * `dsh --profile <profile>` unchanged: env, stdio and the kernel-switch ACK
 * pipe (fd 3) pass through, and this process only forwards the exit.
 *
 * Otherwise, in this order (Phase 2 "hijack, mount, compose"):
 *  1. the installed dsh's modules by realpath, its root and module
 *     resolution (./host-dsh.ts) — before any TUI module is imported, so the
 *     TUI resolves react and the `@deepseek-ai/*` peers the way the DSH
 *     plugins will;
 *  2. the TUI runtime (./plugin.ts) mounts on that root before any backend
 *     session opened (`deferBackendOpen`): the dsh-tui Config row is rebuilt
 *     from the environment the way cordis.patch.yml's row reads it, the
 *     TUI's settings come from ~/.dsh-tui/settings.json;
 *  3. DSH only: the dsh-tui profile is composed into the same root. Its
 *     dsh-tui row finds the mounted screen (./entry-slot.ts), opens the DSH
 *     session and hands it to the channel, which adopts it.
 * The Claude kernel stops after 2 (no profile, no `tui*` services).
 * This process owns its signals and its exit (./process-exit.ts): SIGTERM,
 * SIGHUP and SIGINT go through the TUI's exit funnel (terminal restored,
 * root and DSH session disposed) and end the process by the signal.
 */
import '../force-production-react.js'
import { spawn } from 'node:child_process'
import { markBoot } from '../utils/bootTrace.js'
import { configuredBackend, entryKernel, hostEntryDshEnabled, hostProfile } from '../hostEntryRoute.js'
import { HANDOFF_ACK_FD_ENV } from '../handoffAck.js'
import { HOST_NOTICE_ENV } from '../kernelPrefs.js'
import { logForDebugging } from '../utils/debug.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config as TuiConfig } from './index.js'
import { HostComposeError, loadHostDsh, prepareHostRoot, type HostRoot } from './host-dsh.js'
import { installEntrySignals, type ProcessExitSeam } from './process-exit.js'

markBoot('entry-start')
// Diagnostic reports without the network section: DSH's native flock loader
// reads `process.report.getReport()` for the libc flavor, and with sockets
// already open (the screen mounts before DSH opens its session here) the
// report's reverse lookups of their endpoints blocked the event loop for
// ~10s. Reports are not otherwise used in this process.
if (process.report !== undefined) (process.report as { excludeNetwork?: boolean }).excludeNetwork = true
const profile = hostProfile()
const kernel = entryKernel(process.env, { configured: configuredBackend(profile) })
if (kernel === 'claude') await runInEntry('claude')
else if (hostEntryDshEnabled()) await runInEntry('dsh')
else delegateToDsh()

/** Hand the launch to `dsh --profile <profile> -- <app args>` and mirror its exit. */
function delegateToDsh(): void {
  // As the launcher builds it: dsh's `--` only when there are app arguments.
  const appArgs = process.argv.slice(2)
  const args = ['--profile', profile, ...(appArgs.length > 0 ? ['--', ...appArgs] : [])]
  // A kernel-switch replacement carries the ACK pipe on fd 3 (src/handoffAck.ts):
  // the dsh process is the one that adopts the screen, so it gets the pipe.
  const ack = process.env[HANDOFF_ACK_FD_ENV] === '3'
  const windows = process.platform === 'win32'
  const child = spawn('dsh', windows ? args.map(quoteForCmd) : args, {
    stdio: ack ? ['inherit', 'inherit', 'inherit', 3] : 'inherit',
    env: process.env,
    ...(windows ? { shell: true } : {}),
  })
  // The terminal's own signals reach dsh through the process group; one sent
  // to this pid alone is passed on (SIGINT only by the group: Ctrl+C would
  // otherwise reach dsh twice).
  const forwarders = new Map<NodeJS.Signals, () => void>([
    ['SIGTERM', () => { child.kill('SIGTERM') }],
    ['SIGHUP', () => { child.kill('SIGHUP') }],
    ['SIGINT', () => undefined],
  ])
  for (const [signal, forward] of forwarders) process.on(signal, forward)
  child.on('error', error => {
    process.stderr.write(`dsh-tui: cannot start dsh (${error.message})\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal === null) {
      process.exit(code ?? 0)
      return
    }
    // Mirror a signal death: the forwarders above would catch (and swallow)
    // the re-raised signal, ending this process with 0 instead.
    for (const [name, forward] of forwarders) process.removeListener(name, forward)
    process.kill(process.pid, signal)
  })
}

/**
 * The installed dsh cannot host this launch (none on PATH, a launcher that
 * cannot be followed, a module that does not load, a missing export): say
 * so, then the caller falls back. Before anything renders, so stderr is
 * still the terminal's: the line stays above the screen that follows (the
 * delegated dsh's, or the entry's own). A kernel-switch replacement draws
 * over the old screen without a gap, so it only gets the notice. The notice
 * reaches the screen: in this process through `RuntimeApplyOptions`, in the
 * delegated dsh through the environment (plugin.ts reads it once).
 */
function noteHostUnavailable(kernel: 'claude' | 'dsh', error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
  const fallback = kernel === 'dsh' ? 'starting DSH through `dsh --profile`' : 'starting without its module resolution'
  const line = `dsh-tui: the installed dsh cannot host this launch (${reason}); ${fallback}`
  logForDebugging(line)
  if (process.env[HANDOFF_ACK_FD_ENV] === undefined && process.env.DSH_TUI_RESTART_CHILD !== '1') process.stderr.write(`${line}\n`)
  process.env[HOST_NOTICE_ENV] = reason
  return reason
}

/** cmd.exe joins arguments with spaces and does not escape (bin/dsh-tui.js shellQuote). */
function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"^]/u.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

async function runInEntry(kernel: 'claude' | 'dsh'): Promise<void> {
  // 1. The host's root and module resolution, before any TUI module loads.
  // Without a usable installed dsh (none on PATH, an unexpected shape) the
  // DSH kernel goes back to `dsh --profile`, and the Claude kernel to the
  // Phase 1 entry: this package's own cordis, no host resolution.
  let root: HostRoot | undefined
  /** Why the installed dsh is not used (shown in the screen; Claude only). */
  let hostNotice: string | undefined
  // The runtime's exit funnel fills it once mounted (signals, `ctx.appExit`).
  const exitSeam: ProcessExitSeam = {}
  try {
    root = await prepareHostRoot(await loadHostDsh(), { profile, args: process.argv.slice(2), dsh: kernel === 'dsh', exitSeam })
    markBoot('entry-hijacked')
  } catch (error) {
    markBoot('entry-host-unavailable')
    hostNotice = noteHostUnavailable(kernel, error)
    if (kernel === 'dsh') {
      delegateToDsh()
      return
    }
  }
  const [{ Config }, { apply, handleStartupError }, { publishEntrySlot }, { deferRootCapabilityGuard }, { processGuardActive }, { armProcessTestFault, readTestFault }, { logRestartEvent }] = await Promise.all([
    import('./index.js'),
    import('./plugin.js'),
    import('./entry-slot.js'),
    import('./host-access.js'),
    import('../ink/update-overflow-guard.js'),
    import('./test-faults.js'),
    import('../update.js'),
  ])
  markBoot('entry-modules')
  const ctx: Context = root?.ctx ?? new (await import('@deepseek-ai/cordis')).Context()
  const env = process.env
  // The dsh-tui row of cordis.patch.yml, as a DSH composition would build it
  // from the same environment. The editable fields come from the TUI's own
  // settings document on top (./tui-settings.ts).
  const config = Config({
    provider: 'deepseek-official',
    fullscreen: true,
    terminalImages: true,
    effort: 'max',
    ...(env.DSH_TUI_PRESET === undefined ? {} : { preset: env.DSH_TUI_PRESET }),
    ...(env.DSH_TUI_WORKSPACE_TARGET === undefined ? {} : { workspace: env.DSH_TUI_WORKSPACE_TARGET }),
    ...(env.DSH_TUI_RESUME_SESSION === undefined ? {} : { sessionId: env.DSH_TUI_RESUME_SESSION }),
    ...(env.DSH_TUI_BACKEND === undefined ? {} : { backend: env.DSH_TUI_BACKEND as TuiConfig['backend'] }),
  })
  // Signals (./process-exit.ts): through the TUI's exit funnel once it is up,
  // else a bounded dispose of the root; either way the process then dies by
  // the signal (a numeric 143/129/130 reads as a crash to the launcher). A
  // second signal forces the exit.
  installEntrySignals({
    seam: exitSeam,
    disposeRoot: () => ctx.root.fiber.dispose(),
    log: logRestartEvent,
  })
  // 2. Mount the screen. On DSH the slot tells the profile's dsh-tui row
  // that this screen exists (and receives the DSH side from the runtime).
  const slot = kernel === 'dsh' && root !== undefined ? publishEntrySlot() : undefined
  // DSH's plugins use root capabilities while they activate; the TUI's guard
  // on them arrives once the profile has composed, as on the profile path.
  const releaseRootGuard = slot === undefined ? undefined : deferRootCapabilityGuard(ctx)
  try {
    await apply(ctx, config, ctx, { deferBackendOpen: true, profile, exitSeam, ...(slot === undefined ? {} : { entrySlot: slot }), ...(hostNotice === undefined ? {} : { hostNotice }) })
  } catch (error) {
    handleStartupError(ctx, error)
    return
  }
  // One owner of a fatal error from here on: the TUI's process guard routes
  // it into the exit funnel (terminal restored, crash line, resume markers,
  // exit 1). DSH's fail-loud, installed first, would otherwise exit 1 before
  // the funnel ran and shadow the guard's absorbers (Phase 1 fix I). Without
  // the guard (DSH_TUI_NO_185_PROCESS_GUARD=1) fail-loud stays.
  if (root !== undefined && processGuardActive()) root.uninstallFailLoud()
  armProcessTestFault(readTestFault(), () => ctx.get('appExit' as never) as ((code: number) => void) | undefined)
  if (slot === undefined || root === undefined) return
  // 3. Compose the profile into this root. Past the mount nothing may write
  // to the terminal: host warnings go to the debug log, and a failure lands
  // in the screen (the startup notice) instead of ending the process.
  // The screen says DSH is starting (6.1): make sure that frame reached the
  // terminal before the composition's synchronous stretch freezes the loop.
  await slot.firstFrameFlushed?.()
  markBoot('entry-first-frame-flushed')
  markBoot('entry-compose-start')
  let composed = false
  try {
    await root.compose(line => { slot.composeWarning?.(line) })
    composed = true
  } catch (error) {
    if (error instanceof HostComposeError) slot.composeFailed?.(error.original, error.logPath)
    else slot.composeFailed?.(error)
  } finally {
    releaseRootGuard?.()
  }
  markBoot('entry-compose-end')
  if (!composed) return
  if (!slot.rowSeen) slot.composeFailed?.(new Error(`the ${profile} profile has no dsh-tui row`))
  else slot.composeSucceeded?.()
}
