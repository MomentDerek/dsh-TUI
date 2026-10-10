/**
 * Process ownership in this package's own entry (docs/standalone-host-design.md
 * 5.5): the entry process owns its signals and its exit,
 * and both go through the TUI's exit funnel (./plugin.ts) whenever it is up.
 *
 * Exit status. A termination signal ends the process **by that signal**
 * (SIGTERM, SIGHUP and SIGINT alike), after the funnel restored the terminal
 * and the root (the DSH session included) was disposed. The launcher
 * (bin/dsh-tui.js `settleFirstResult`) passes a signal death on and treats
 * every numeric non-zero exit as a crash that offers safe mode — so dsh
 * `runProfile`'s own choice (0.2.0-rc.2: SIGTERM → exit 0, SIGINT → exit 130,
 * via `createProcessShutdown().interrupt`) is not reproduced: 130 reads as a
 * crash to the launcher (latent on the `dsh --profile` path too), and 0 hides
 * the termination from `timeout`, tmux and service managers. Phase 1 fix G
 * already chose the signal death for SIGTERM / SIGHUP; SIGINT joins them.
 * A second signal while the first is still being handled forces the exit at
 * once (as `interrupt` does on a pending shutdown).
 *
 * Who owns what:
 *  - `installEntrySignals` (the entry, before anything else can start): the
 *    process listeners, the second-signal escalation and the backstop timer.
 *  - `ProcessExitSeam.request` (filled by the runtime once its funnel exists,
 *    cleared on its teardown; a `/restart` supervisor fills it again): takes
 *    a signal or an app exit request (`ctx.appExit`) into the funnel.
 *  - Without an owner (before the mount, after the teardown) the entry
 *    disposes the root itself, bounded, then dies by the signal.
 */

/** The signals the entry turns into an orderly exit. */
export type TerminationSignal = 'SIGTERM' | 'SIGHUP' | 'SIGINT'
export const TERMINATION_SIGNALS: readonly TerminationSignal[] = ['SIGTERM', 'SIGHUP', 'SIGINT']

/** What asked the process to end. */
export type ExitRequest =
  | { readonly kind: 'signal'; readonly signal: TerminationSignal }
  /** `ctx.appExit(code)` (dsh-cmdline): a plugin asked the app to exit. */
  | { readonly kind: 'code'; readonly code: number }

/**
 * The owner's answer:
 *  - `exiting`: the funnel took it and ends the process (the entry arms its
 *    backstop);
 *  - `pending`: an exit is already in flight (a `/quit`, a crash, a
 *    handoff's teardown) and ends the process on its own (backstop armed);
 *  - `supervising`: this process now only follows a replacement and exits
 *    with it (no backstop: the replacement may legitimately run for hours);
 *  - `refused`: the owner cannot take it (its tree is being torn down) — the
 *    entry falls back to disposing the root itself.
 */
export type ExitRequestAnswer = 'exiting' | 'pending' | 'supervising' | 'refused'

/** The entry's process-exit seam, shared with the runtime it mounts. */
export interface ProcessExitSeam {
  request?: (request: ExitRequest) => ExitRequestAnswer
}

/** dsh `profile-boot` PROCESS_SHUTDOWN_TIMEOUT_MS (0.2.0-rc.2): the dispose bound. */
export const DISPOSE_BOUND_MS = 5000
/**
 * The entry's last-resort bound for a funnel exit: the funnel's terminal
 * cleanup (a write bounded at 1s plus its 150ms settle) runs before the
 * dispose bound starts, so this outlasts both.
 */
const BACKSTOP_MS = DISPOSE_BOUND_MS + 2000
/** How long a re-raised signal may be held by foreign listeners before they go. */
const RERAISE_GRACE_MS = 500

const installed = new Map<TerminationSignal, () => void>()

/**
 * End the process by `signal`. Only the entry's own listeners come off: the
 * renderer's signal-exit hook stays, runs its synchronous terminal cleanup if
 * the funnel has not already detached the renderer, and re-raises the signal
 * once it is the last listener. Another listener (a plugin's) would keep the
 * process alive, so after a short grace every listener goes and the signal
 * is raised again.
 */
export function dieBySignal(signal: TerminationSignal): void {
  for (const [name, listener] of installed) process.removeListener(name, listener)
  installed.clear()
  const grace = setTimeout(() => {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }, RERAISE_GRACE_MS)
  // Referenced: an empty event loop must not turn this into exit 0.
  void grace
  process.kill(process.pid, signal)
}

export interface EntrySignalOptions {
  readonly seam: ProcessExitSeam
  /** Dispose the root without the funnel (no owner, or it refused). */
  readonly disposeRoot: () => Promise<unknown>
  /** restart.log / debug breadcrumb; must not write to the terminal. */
  readonly log?: (event: string, data?: Record<string, unknown>) => void
  /** Where the process was when the signal came (a boot mark), for the log. */
  readonly where?: () => string | undefined
}

/** Install the entry's signal handling (once per process). */
export function installEntrySignals(options: EntrySignalOptions): void {
  let first: TerminationSignal | undefined
  const onSignal = (signal: TerminationSignal): void => {
    if (first !== undefined) {
      options.log?.('signal: second signal, forcing the exit', { first, signal })
      dieBySignal(signal)
      return
    }
    first = signal
    const answer = options.seam.request?.({ kind: 'signal', signal }) ?? 'refused'
    options.log?.('signal: received', { signal, answer, ...(options.where === undefined ? {} : { at: options.where() }) })
    if (answer === 'supervising') {
      // The replacement decides; a second signal still forces this process.
      return
    }
    const backstop = setTimeout(() => {
      options.log?.('signal: backstop reached, forcing the exit', { signal })
      dieBySignal(signal)
    }, answer === 'refused' ? DISPOSE_BOUND_MS : BACKSTOP_MS)
    void backstop
    if (answer === 'refused') {
      void options.disposeRoot().then(() => { dieBySignal(signal) }, () => { dieBySignal(signal) })
    }
  }
  for (const signal of TERMINATION_SIGNALS) {
    const listener = (): void => { onSignal(signal) }
    installed.set(signal, listener)
    process.on(signal, listener)
  }
}
