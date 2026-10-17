/** Registry bridge regression, including relocated assets through the real Loader/Registry/Include. Run after build. */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { parse } from 'yaml'
import { settled } from './lib/term-test.mjs'
import { registerBundledPresets } from '../lib/types/dsh-adapter/bundled-presets.js'

function harness(declared = []) {
  const registrations = []
  const effects = []
  const disposed = []
  const makeContext = baseUrl => ({
    baseUrl,
    get(name) {
      if (name === 'loader') return { entries: () => declared }
      if (name === 'agentPresets') return {
        async register(definition) {
          registrations.push({ definition, baseUrl })
          return async () => { disposed.push(definition.id) }
        },
      }
    },
    extend({ baseUrl: next }) { return makeContext(next) },
    effect(effect) { effects.push(effect()) },
  })
  return { ctx: makeContext(new URL('../cordis.patch.yml', import.meta.url).href), registrations, effects, disposed }
}

assert.equal(await registerBundledPresets({ get: () => ({ list() {} }) }), false,
  'legacy directory discovery remains on its existing path')
const fresh = harness()
assert.equal(await registerBundledPresets(fresh.ctx), true)
assert.deepEqual(fresh.registrations.map(row => row.definition.id), ['standard', 'ptc', 'minimal', 'cordis', 'liangshen'])
const standard = fresh.registrations[0]
assert.match(standard.baseUrl, /standard\.patch\.yml$/u)
assert.equal(typeof standard.definition.plugins.find(row => row.id === 'tool-bash').disabled.__jsExpr, 'string',
  'platform expressions must remain unevaluated for the upstream Loader')
const liangshen = fresh.registrations.at(-1).definition
assert.equal(new URL(liangshen.plugins[0].config.path).protocol, 'file:')
assert.equal(fileURLToPath(liangshen.plugins[0].config.path), fileURLToPath(new URL('../presets/liangshen/agent.cordis.yml', import.meta.url)))
const metadata = parse(readFileSync(new URL('../presets/liangshen/preset.yml', import.meta.url), 'utf8'))
assert.deepEqual({ name: liangshen.name, description: liangshen.description, order: liangshen.order }, metadata)
for (const dispose of fresh.effects) await dispose()
assert.deepEqual(fresh.disposed, ['standard', 'ptc', 'minimal', 'cordis', 'liangshen'])

const mixed = harness(['standard', 'ptc', 'minimal', 'cordis', 'liangshen'].map(id => ({
  disabled: false, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id } },
})))
assert.equal(await registerBundledPresets(mixed.ctx), true)
assert.deepEqual(mixed.registrations, [], 'profile declarations own their seats before activation completes')
const disabled = harness([{ disabled: true, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard' } } }])
await registerBundledPresets(disabled.ctx)
assert.equal(disabled.registrations.length, 5)

// An enabled Agent Teams tool row (the upstream team bundle) disables the
// replaced delegation rows inside every preset the TUI registers.
const TEAM_REPLACED = ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']
function rowsById(rows, found = new Map()) {
  for (const row of rows) {
    if (typeof row.id === 'string') found.set(row.id, row)
    if (row.group === true && Array.isArray(row.config)) rowsById(row.config, found)
  }
  return found
}
const teamRow = { disabled: false, options: { name: '@deepseek-ai/dsh-experimental-tool-agent-team' } }
const team = harness([teamRow])
await registerBundledPresets(team.ctx)
for (const id of ['standard', 'ptc', 'cordis']) {
  const rows = rowsById(team.registrations.find(row => row.definition.id === id).definition.plugins)
  const original = rowsById(fresh.registrations.find(row => row.definition.id === id).definition.plugins)
  for (const replaced of TEAM_REPLACED) assert.equal(rows.get(replaced)?.disabled, true, `${id}: ${replaced} yields to the team tools`)
  for (const [rowId, row] of original) {
    if (!TEAM_REPLACED.includes(rowId)) assert.deepEqual(rows.get(rowId).disabled, row.disabled, `${id}: ${rowId} is untouched`)
  }
}
assert.deepEqual(team.registrations.find(row => row.definition.id === 'liangshen').definition.plugins[0].config.patches,
  TEAM_REPLACED.map(id => ({ id, disabled: true })))
for (const declared of [[], [{ ...teamRow, disabled: true }]]) {
  const plain = harness(declared)
  await registerBundledPresets(plain.ctx)
  const rows = rowsById(plain.registrations.find(row => row.definition.id === 'standard').definition.plugins)
  assert.equal(rows.get('tool-subagent')?.disabled, undefined, 'without enabled team tools, presets stay unchanged')
  assert.equal(plain.registrations.find(row => row.definition.id === 'liangshen').definition.plugins[0].config.patches, undefined)
}
// A real Cordis dependency appears after the TUI's registration attempt.
const delayed = new Context()
const delayedRegistrations = []
const delayedDisposals = []
try {
  delayed.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href
  await registerBundledPresets(delayed)
  assert.equal(delayedRegistrations.length, 0)
  await delayed.plugin(ctx => {
    ctx.provide('agentPresets', {
      async register(definition) {
        delayedRegistrations.push(definition.id)
        return async () => { delayedDisposals.push(definition.id) }
      },
    })
  })
  assert.ok(await settled(() => delayedRegistrations.length === 5), 'late registry must receive all bundled presets')
} finally {
  await delayed.fiber.dispose()
}
assert.deepEqual(delayedDisposals.sort(), ['cordis', 'liangshen', 'minimal', 'ptc', 'standard'])

// Relocate the unchanged production modules so asset paths contain URL-sensitive
// characters on every OS (and a drive letter on Windows). Keep this under the
// checkout so their normal package imports still resolve; no user profile is used.
// Sweep leftovers from earlier runs first: on Windows the imported module file
// can still be locked when the final rmSync runs (or the process was killed),
// and each run otherwise strands another `.preset-path # % 中文-*` here.
const checkoutRoot = fileURLToPath(new URL('..', import.meta.url))
for (const stale of readdirSync(checkoutRoot)) {
  if (stale.startsWith('.preset-path # % 中文-')) {
    try { rmSync(join(checkoutRoot, stale), { recursive: true, force: true }) } catch { /* still locked; next run retries */ }
  }
}
const relocatedRoot = mkdtempSync(join(checkoutRoot, '.preset-path # % 中文-'))
const runtime = new Context()
let mounted = 0
try {
  const modules = join(relocatedRoot, 'src', 'dsh-adapter')
  const assets = join(relocatedRoot, 'presets', 'liangshen')
  mkdirSync(modules, { recursive: true })
  mkdirSync(assets, { recursive: true })
  for (const name of ['bundled-presets.js', 'packaged-presets.js']) {
    copyFileSync(new URL(`../lib/types/dsh-adapter/${name}`, import.meta.url), join(modules, name))
  }
  copyFileSync(new URL('../lib/types/preset-patch.js', import.meta.url), join(relocatedRoot, 'src', 'preset-patch.js'))
  // Different metadata makes a hard-coded copy fail, including name and order.
  const relocatedMetadata = { name: 'Relocated 梁神', description: 'Metadata from preset.yml', order: 17 }
  writeFileSync(join(assets, 'preset.yml'), JSON.stringify(relocatedMetadata))
  writeFileSync(join(assets, 'agent.cordis.yml'), [
    '- id: fixture', '  name: cordis:fixture',
    '- id: tool-subagent', '  name: cordis:replaced', '',
  ].join('\n'))
  const { registerBundledPresets: registerRelocated } = await import(pathToFileURL(join(modules, 'bundled-presets.js')).href)
  const relocated = harness()
  await registerRelocated(relocated.ctx)
  const definition = relocated.registrations.find(row => row.definition.id === 'liangshen').definition
  assert.equal(fileURLToPath(definition.plugins[0].config.path), join(assets, 'agent.cordis.yml'))

  runtime.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href
  await runtime.plugin(Loader)
  await runtime.plugin(SessionProjectionRegistry)
  await runtime.plugin(AgentPresetRegistry, { default: 'liangshen' })
  runtime.loader.builtins.fixture = ctx => {
    mounted++
    ctx.effect(() => () => { mounted-- })
  }
  let replaced = 0
  runtime.loader.builtins.replaced = ctx => {
    replaced++
    ctx.effect(() => () => { replaced-- })
  }
  const teamRelocated = harness([{ disabled: false, options: { name: '@deepseek-ai/dsh-experimental-tool-agent-team' } }])
  await registerRelocated(teamRelocated.ctx)
  const disposeTeam = await runtime.agentPresets.register(teamRelocated.registrations.find(row => row.definition.id === 'liangshen').definition)
  assert.equal(mounted, 1)
  assert.equal(replaced, 0, 'the real Include applies the team patches')
  await disposeTeam()
  assert.equal(mounted, 0)
  const dispose = await runtime.agentPresets.register(definition)
  assert.equal(mounted, 1, 'the real Include must open the asset and activate its child')
  assert.equal(replaced, 1, 'without team tools the delegation rows mount')
  assert.deepEqual(await runtime.agentPresets.list(), [{ id: 'liangshen', ...relocatedMetadata }],
    'registration resolving is insufficient: the preset must have no broken diagnostic')
  const document = await runtime.agentPresets.readDocument('liangshen')
  assert.equal(document.name, relocatedMetadata.name)
  assert.equal(document.description, relocatedMetadata.description)
  await dispose()
  assert.equal(mounted, 0, 'registry disposal unmounts the included child')
  assert.deepEqual(await runtime.agentPresets.list(), [])
} finally {
  await runtime.fiber.dispose()
  rmSync(relocatedRoot, { recursive: true, force: true })
}
console.log('bundled presets OK (official definitions, expressions, ownership, legacy, team delegation rows, relocated Include, metadata, disposal)')
