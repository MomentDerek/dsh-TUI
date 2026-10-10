/**
 * Test-only fault injection for the entry's exit paths
 * (scripts/accept-host-entry.mjs, docs/standalone-host-design.md 5.5).
 * Off unless `DSH_TUI_TEST_FAULT` is set; never set it outside a test.
 *
 * `DSH_TUI_TEST_FAULT=<kind>[@<ms>]`, the delay counted from the mount
 * (default 4000ms, after a DSH session is normally adopted):
 *  - `render`     a component throws while rendering (the Ink root boundary);
 *  - `runtime`    a timer throws (uncaughtException);
 *  - `rejection`  a promise rejects unhandled (unhandledRejection);
 *  - `app-exit:<code>` the root's `appExit` (dsh-cmdline's `ctx.appExit`, what
 *    a DSH plugin calls to end the app) is called with `<code>`.
 */
import React from 'react'

export type TestFault =
  | { readonly kind: 'render' | 'runtime' | 'rejection'; readonly delayMs: number }
  | { readonly kind: 'app-exit'; readonly code: number; readonly delayMs: number }

export const TEST_FAULT_ENV = 'DSH_TUI_TEST_FAULT'

/** The configured fault, if any. */
export function readTestFault(env: NodeJS.ProcessEnv = process.env): TestFault | undefined {
  const raw = env[TEST_FAULT_ENV]
  if (raw === undefined || raw === '') return undefined
  const [spec = '', delay] = raw.split('@')
  const delayMs = delay === undefined ? 4000 : Number(delay)
  if (!Number.isFinite(delayMs) || delayMs < 0) return undefined
  if (spec === 'render' || spec === 'runtime' || spec === 'rejection') return { kind: spec, delayMs }
  const appExit = /^app-exit:(\d+)$/u.exec(spec)
  if (appExit !== null) return { kind: 'app-exit', code: Number(appExit[1]), delayMs }
  return undefined
}

/** Arm the process-level faults (`runtime`, `rejection`, `app-exit`). */
export function armProcessTestFault(fault: TestFault | undefined, appExit: () => ((code: number) => void) | undefined): void {
  if (fault === undefined || fault.kind === 'render') return
  const exitCode = fault.kind === 'app-exit' ? fault.code : undefined
  const timer = setTimeout(() => {
    if (fault.kind === 'runtime') throw new Error('dsh-tui test fault: runtime throw')
    if (fault.kind === 'rejection') {
      void Promise.reject(new Error('dsh-tui test fault: unhandled rejection'))
      return
    }
    if (exitCode !== undefined) appExit()?.(exitCode)
  }, fault.delayMs)
  timer.unref()
}

/** A component that throws while rendering once the delay passed (`render`). */
export function RenderTestFault({ delayMs }: { readonly delayMs: number }): React.ReactElement | null {
  const [armed, setArmed] = React.useState(false)
  React.useEffect(() => {
    const timer = setTimeout(() => { setArmed(true) }, delayMs)
    return () => { clearTimeout(timer) }
  }, [delayMs])
  if (armed) throw new Error('dsh-tui test fault: render throw')
  return null
}
