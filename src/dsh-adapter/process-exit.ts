/**
 * Process ownership in this package's entry: signals and exit go through the
 * TUI's exit funnel (./plugin.ts) whenever it is up; without an owner the
 * entry disposes the root itself, bounded. Either way a termination signal ends the
 * process by that signal: the launcher treats a numeric non-zero exit as a
 * crash, and exit 0 would hide the termination from `timeout`, tmux and
 * service managers — so `runProfile`'s 0 / 130 is not reproduced. A second
 * signal forces the exit at once.
 */

export type TerminationSignal = 'SIGTERM' | 'SIGHUP' | 'SIGINT'
export const TERMINATION_SIGNALS: readonly TerminationSignal[] = ['SIGTERM', 'SIGHUP', 'SIGINT']

export type ExitRequest =
  | { readonly kind: 'signal'; readonly signal: TerminationSignal }
  /** `ctx.appExit(code)` (dsh-cmdline): a plugin asked the app to exit. */
  | { readonly kind: 'code'; readonly code: number }

/**
 * The owner's answer: `exiting` (the funnel ends the process) and `pending`
 * (an exit already in flight) arm the backstop; `supervising` follows a
 * replacement that may run for hours, so no backstop; `refused` makes the
 * entry dispose the root itself.
 */
export type ExitRequestAnswer = 'exiting' | 'pending' | 'supervising' | 'refused'

export interface ProcessExitSeam {
  request?: (request: ExitRequest) => ExitRequestAnswer
}

/** dsh's PROCESS_SHUTDOWN_TIMEOUT_MS: the dispose bound. */
export const DISPOSE_BOUND_MS = 5000
/** Last-resort bound for a funnel exit: outlasts its terminal cleanup plus the dispose bound. */
const BACKSTOP_MS = DISPOSE_BOUND_MS + 2000
/** How long a re-raised signal may be held by foreign listeners before they go. */
const RERAISE_GRACE_MS = 500

const installed = new Map<TerminationSignal, () => void>()

/**
 * End the process by `signal`. Only the entry's own listeners come off, so the
 * renderer's signal-exit hook still restores the terminal; a foreign listener
 * would keep the process alive, so after a short grace every listener goes.
 */
export function dieBySignal(signal: TerminationSignal): void {
  for (const [name, listener] of installed) process.removeListener(name, listener)
  installed.clear()
  setTimeout(() => {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }, RERAISE_GRACE_MS)
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

/** Once per process. */
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
    setTimeout(() => {
      options.log?.('signal: backstop reached, forcing the exit', { signal })
      dieBySignal(signal)
    }, answer === 'refused' ? DISPOSE_BOUND_MS : BACKSTOP_MS)
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
