/**
 * Opt-in boot timeline for startup measurements
 * (docs/standalone-host-design.md). With
 * `DSH_TUI_BOOT_TRACE=<file>` each mark appends one JSON line to that file:
 * `{"mark","ms","at","pid"}`, where `ms` counts from this process's start and
 * `at` is the wall clock (for lining up with the launcher). Otherwise it does
 * nothing. Never writes to stdout/stderr.
 */
import { appendFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

/** The latest mark this process passed (kept with or without a trace file). */
let lastMark: string | undefined

/** The latest boot mark, for diagnostics that want to say where a boot was. */
export function lastBootMark(): string | undefined {
  return lastMark
}

export function markBoot(mark: string): void {
  lastMark = mark
  const file = process.env.DSH_TUI_BOOT_TRACE
  if (file === undefined || file === '') return
  try {
    appendFileSync(file, `${JSON.stringify({ mark, ms: Math.round(performance.now()), at: Date.now(), pid: process.pid })}\n`)
  } catch {
    // A measurement aid must never affect the boot.
  }
}
