/**
 * The host entry's routing (docs/standalone-host-design.md 5.8), pure parts:
 *
 *  - `entryKernel` ranks a kernel-switch handoff over the profile patch's
 *    Config row over DSH_TUI_BACKEND over kernel.json, like the plugin;
 *  - `configuredBackend` reads the dsh-tui row's `backend` from the profile
 *    patch (and nothing else's), tolerating `!!js` and a missing file;
 *  - `restartArgv` relaunches a replacement on the Claude kernel through the
 *    host entry (only the app arguments after dsh's `--` carry over; a
 *    kernel switch drops resume flags), leaves every other relaunch on its
 *    own script, and never re-targets the entry onto itself; with
 *    `DSH_TUI_HOST_ENTRY_DSH=1` (`dshInEntry`) a DSH replacement goes to the
 *    entry too.
 *
 * The launcher half (bin/dsh-tui.js) is covered by verify-launcher.mjs §7.
 *
 * Run: node --import tsx/esm scripts/verify-host-entry.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configuredBackend, entryKernel } from '../src/hostEntryRoute.js'
import { stripResumeArgs } from '../src/sessionHistory.js'
import { restartArgv } from '../src/update.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'verify-host-entry-'))
const memory = join(root, 'kernel.json')
const noMemory = join(root, 'absent.json')
writeFileSync(memory, JSON.stringify({ backend: 'claude' }))

// ── entryKernel ───────────────────────────────────────────────────────
check('nothing set: dsh', entryKernel({}, { memoryFile: noMemory }) === 'dsh')
check('kernel.json: claude', entryKernel({}, { memoryFile: memory }) === 'claude')
check('DSH_TUI_BACKEND beats kernel.json', entryKernel({ DSH_TUI_BACKEND: 'dsh' }, { memoryFile: memory }) === 'dsh')
check('an invalid DSH_TUI_BACKEND means dsh, not the memory', entryKernel({ DSH_TUI_BACKEND: 'nope' }, { memoryFile: memory }) === 'dsh')
check('the Config row beats DSH_TUI_BACKEND', entryKernel({ DSH_TUI_BACKEND: 'claude' }, { configured: 'dsh', memoryFile: noMemory }) === 'dsh')
check('a handoff beats the Config row', entryKernel({ DSH_TUI_BACKEND_HANDOFF: 'claude' }, { configured: 'dsh', memoryFile: noMemory }) === 'claude')

// ── configuredBackend ─────────────────────────────────────────────────
const patch = join(root, 'cordis.patch.yml')
check('no patch file: no pin', configuredBackend('x', patch) === undefined)
writeFileSync(patch, '- id: other\n  config: { backend: claude }\n- id: dsh-tui\n  config:\n    preset: !!js process.env.DSH_TUI_PRESET\n    backend: Claude\n')
check('the dsh-tui row\'s backend, normalized', configuredBackend('x', patch) === 'claude')
writeFileSync(patch, '- id: dsh-tui\n  config:\n    backend: !!js process.env.DSH_TUI_BACKEND\n')
check('a !!js backend is no pin', configuredBackend('x', patch) === undefined)
writeFileSync(patch, '- id: dsh-tui\n  config:\n    lang: en\n')
check('a row without backend is no pin', configuredBackend('x', patch) === undefined)

// ── restartArgv ───────────────────────────────────────────────────────
const entry = '/pkg/lib/types/dsh-adapter/host-entry.js'
const dshArgv = ['/node', '/dsh/lib/bin.js', '--profile', 'dsh-tui', '--', '--resume', 'abc', 'foo']
check('a switch to Claude from dsh relaunches the entry with the app args, resume dropped',
  JSON.stringify(restartArgv({ execArgv: ['--x'], argv: dshArgv, kernel: 'claude', switching: true, hostEntry: entry })) === JSON.stringify(['--x', entry, 'foo']),
  restartArgv({ execArgv: ['--x'], argv: dshArgv, kernel: 'claude', switching: true, hostEntry: entry }))
check('a /restart on Claude under dsh moves to the entry, resume kept',
  JSON.stringify(restartArgv({ execArgv: [], argv: dshArgv, kernel: 'claude', switching: false, hostEntry: entry })) === JSON.stringify([entry, '--resume', 'abc', 'foo']))
check('without the entry path the dsh argv is replayed as before',
  JSON.stringify(restartArgv({ execArgv: [], argv: dshArgv, kernel: 'claude', switching: true, hostEntry: undefined })) === JSON.stringify(stripResumeArgs(dshArgv.slice(1))))
check('a DSH relaunch stays on dsh',
  JSON.stringify(restartArgv({ execArgv: [], argv: dshArgv, kernel: 'dsh', switching: false, hostEntry: entry })) === JSON.stringify(dshArgv.slice(1)))
const entryArgv = ['/node', entry, '--resume', 'abc', 'foo']
check('the entry relaunches itself (it hands a DSH kernel on to dsh)',
  JSON.stringify(restartArgv({ execArgv: [], argv: entryArgv, kernel: 'dsh', switching: true, hostEntry: entry })) === JSON.stringify([entry, 'foo']))
check('the entry on Claude is not re-targeted',
  JSON.stringify(restartArgv({ execArgv: [], argv: entryArgv, kernel: 'claude', switching: false, hostEntry: entry })) === JSON.stringify(entryArgv.slice(1)))
check('with DSH in the entry (DSH_TUI_HOST_ENTRY_DSH=1) a DSH relaunch under dsh moves to the entry',
  JSON.stringify(restartArgv({ execArgv: [], argv: dshArgv, kernel: 'dsh', switching: false, hostEntry: entry, dshInEntry: true })) === JSON.stringify([entry, '--resume', 'abc', 'foo']))
check('with DSH in the entry the entry relaunches itself on DSH',
  JSON.stringify(restartArgv({ execArgv: [], argv: entryArgv, kernel: 'dsh', switching: true, hostEntry: entry, dshInEntry: true })) === JSON.stringify([entry, 'foo']))
const noSeparator = ['/node', '/dsh/lib/bin.js', '--profile', 'dsh-tui']
check('a dsh argv without app args gives the entry none',
  JSON.stringify(restartArgv({ execArgv: [], argv: noSeparator, kernel: 'claude', switching: true, hostEntry: entry })) === JSON.stringify([entry]))

console.log(`\nverify-host-entry: ${passed} checks passed`)
