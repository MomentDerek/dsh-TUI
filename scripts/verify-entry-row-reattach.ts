/**
 * Regression for #1651: a `dsh-tui` row that comes back under the entry's
 * screen after the previous one unloaded takes over the DSH side.
 *
 * On the DSH kernel the entry owns the screen; the profile's `dsh-tui` row
 * runs only the DSH side (`attachDsh`), and everything it mounts (presets,
 * ask_user, approvals, the assembly filters, the startup session's
 * listeners) lives on that row. When the row unloads (its `agents` service
 * went away) and applies again, the new row must mount those seams again and
 * reopen the ended session; a row applied while the previous one is still
 * mounted stays idle.
 *
 * The routing runs through the real `dsh-adapter/index.ts` `apply` on a real
 * Cordis tree with a published entry slot whose hooks record their calls (the
 * entry's runtime needs a terminal). What those hooks do in `plugin.ts` is
 * pinned on its source.
 *
 *   A. the first row gets `attachDsh` in a runtime fiber of its own [A1]
 *   B. a second row while the first is mounted stays idle [B1]
 *   C. after the first row unloads, a new row gets the reattach hook with its
 *      runtime context and config, in a fiber that unloads with it [C1, C2]
 *   P. plugin.ts: the reattach hook reads the new row's config, mounts the
 *      row seams the first attach mounts, and only then reopens the ended
 *      session, outside the row's activation; it is refused while a row is
 *      mounted [P1-P4]
 *
 * Run: node --import tsx/esm scripts/verify-entry-row-reattach.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createEntrySlot, type EntrySlot } from '../src/dsh-adapter/entry-slot.js'
import { apply } from '../src/dsh-adapter/index.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
async function settled(predicate: () => boolean, rounds = 100): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    if (predicate()) return true
    await tick()
  }
  return predicate()
}

type Call = { hook: 'attach' | 'reattach'; ctx: Context; config: unknown; row: string }
const calls: Call[] = []
const slot: EntrySlot = createEntrySlot(true)
// The entry's contract (plugin.ts): a row is "mounted" from its attach until
// its runtime context unloads, and only an unmounted row is taken over.
let rowMounted = false
const mount = (ctx: Context): void => {
  rowMounted = true
  ctx.effect(() => () => { rowMounted = false })
}
let currentRow = ''
slot.attachDsh = async (ctx, config) => {
  calls.push({ hook: 'attach', ctx: ctx as Context, config, row: currentRow })
  mount(ctx as Context)
}
slot.reattachDsh = () => rowMounted ? undefined : async (ctx, config) => {
  calls.push({ hook: 'reattach', ctx: ctx as Context, config, row: currentRow })
  mount(ctx as Context)
}

const root = new Context()
const rowConfig = (model: string) => ({ model }) as never
async function mountRow(name: string, model: string): Promise<{ unload(): Promise<void> }> {
  currentRow = name
  const fiber = root.plugin({ name, apply: (ctx: Context) => apply(ctx, rowConfig(model)) } as never) as unknown as { dispose(): Promise<void> | void }
  await settled(() => false, 20)
  return { unload: async () => { await fiber.dispose() } }
}

try {
  const first = await mountRow('row-1', 'first-model')
  check('A1 the first row gets attachDsh, in a runtime fiber of its own',
    await settled(() => calls.length === 1) && calls[0]!.hook === 'attach' && calls[0]!.ctx !== root && slot.attachDsh === undefined,
    calls.map(call => call.hook))

  const second = await mountRow('row-2', 'second-model')
  check('B1 a second row while the first is mounted stays idle', calls.length === 1 && rowMounted, calls.map(call => call.hook))
  await second.unload()

  await first.unload()
  check('fixture: the first row\'s unload ended its mount', !rowMounted)
  const third = await mountRow('row-3', 'third-model')
  const taken = await settled(() => calls.length === 2) ? calls[1] : undefined
  check('C1 after the first row unloaded, a new row gets the reattach hook with its own config',
    taken?.hook === 'reattach' && (taken.config as { model?: string } | undefined)?.model === 'third-model' && rowMounted,
    calls.map(call => ({ hook: call.hook, config: call.config })))
  await third.unload()
  check('C2 the reattached runtime unloads with its row', !rowMounted)
} finally {
  await root.fiber.dispose()
}

// ── P: what the hooks do in plugin.ts ────────────────────────────────────
{
  const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const start = plugin.indexOf('entrySlot.reattachDsh = () => {')
  const end = plugin.indexOf('entrySlot.attachDsh = async', start)
  const reattach = start >= 0 && end > start ? plugin.slice(start, end) : ''
  const attachEnd = plugin.indexOf('const rowRoute', end)
  const attach = end >= 0 && attachEnd > end ? plugin.slice(end, attachEnd) : ''
  const at = (pattern: RegExp): number => reattach.search(pattern)
  check('P1 the reattach hook is refused while a row is mounted, and once the screen is gone',
    /if \(compositionFailed \|\| exited \|\| rowMounted \|\| !channel\.ready\) return undefined/.test(reattach))
  check('P2 it reads the new row\'s config, then mounts the row seams, then reopens',
    at(/rowFacts\.config = configValues/) >= 0 && at(/rowFacts\.config = configValues/) < at(/await mountRowSeams\(rowCtx as Context\)/)
      && at(/await mountRowSeams\(rowCtx as Context\)/) < at(/channel\.resumeTo\(channel\.sessionId\)/))
  check('P3 it reopens only an ended session, as the entry (outside the row\'s activation)',
    /if \(channel\.status !== 'disposed'\) return/.test(reattach) && /outsideActivation\(\(\) => channel\.resumeTo\(channel\.sessionId\)\)/.test(reattach)
      && plugin.split('outsideActivation(').length - 1 === 1)
  check('P4 the first attach mounts the same row seams, and they mark the row mounted until it unloads',
    /await mountRowSeams\(dshCtx\)/.test(attach)
      && /const mountRowSeams = async \(dshCtx: Context\): Promise<void> => \{\s*rowMounted = true\s*dshCtx\.effect\(\(\) => \(\) => \{ rowMounted = false \}\)\s*await installPresets\(dshCtx\)\s*const seams = mountDshQuestionSeams\(dshCtx\)[\s\S]*?mountDshApprovals\(dshCtx\)/.test(plugin))
}

console.log(`\n${passed} checks passed`)
