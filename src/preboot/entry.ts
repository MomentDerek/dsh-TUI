/**
 * `--import` preload for the fast launcher (`dst`).
 *
 * The launcher starts dsh as
 * `node --import <this file> <dsh/lib/bin.js> --profile dsh-tui`; Node
 * evaluates this module — top-level await included — before the dsh entry
 * runs, so the root tree is on screen (against a boot channel) before dsh
 * composes the profile and loads its plugin tree. `plugin.ts` later brings
 * the live session in through the slot (`./handle.ts`).
 *
 * Fail-soft by design: any problem here is swallowed and dsh boots exactly
 * as it would without the preload (the launcher only opts in when the
 * marker env is set and the terminal is interactive).
 */
import '../force-production-react.js'
import { PREBOOT_ENV } from './handle.js'

/**
 * dsh's own print-and-exit switches (the launcher's `dshSwitches`, in the
 * host prefix before `--`): those runs never mount dsh-tui, and a boot screen
 * would both hide their output and turn their success into a failed boot.
 */
const HOST_INFO_SWITCHES = new Set(['--dump-config', '--dump-default-config', '--dump-config-schema', '-V', '--version'])
const hostArgs = (() => {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf('--')
  return separator === -1 ? argv : argv.slice(0, separator)
})()

if (
  process.env[PREBOOT_ENV] === '1'
  && process.stdout.isTTY === true
  && process.stdin.isTTY === true
  && !hostArgs.some(arg => HOST_INFO_SWITCHES.has(arg))
) {
  try {
    const { mountPreboot } = await import('./mount.js')
    await mountPreboot()
  } catch (error) {
    if (process.env.DSH_TUI_DEBUG !== undefined && process.env.DSH_TUI_DEBUG !== '') {
      process.stderr.write(`[dsh-tui] preboot skipped: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}
