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

if (process.env[PREBOOT_ENV] === '1' && process.stdout.isTTY === true && process.stdin.isTTY === true) {
  try {
    const { mountPreboot } = await import('./mount.js')
    await mountPreboot()
  } catch (error) {
    if (process.env.DSH_TUI_DEBUG !== undefined && process.env.DSH_TUI_DEBUG !== '') {
      process.stderr.write(`[dsh-tui] preboot skipped: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}
