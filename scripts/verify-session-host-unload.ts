/**
 * Regression for #1651: a foreground DSH session whose listener context
 * unloads must stop projecting its turn.
 *
 * On the DSH kernel the entry owns the screen and the Channel, while the
 * profile's `dsh-tui` row opens the startup session on its own context. That
 * row injects `agents`: when the service goes away (a profile reload that
 * drops it), the row unloads and Cordis removes every listener the session
 * installed there. The agent's closing `agent/status idle` / `agent/disposed`
 * then reach nobody, so the screen kept the turn busy forever, and a
 * follow-up still reported success while it went to an agent that was gone.
 *
 * The fixture mirrors that split with a real Cordis tree: the Channel on the
 * root (the entry), the session on a `row` plugin. Only the agent is a stub.
 *
 *   A. the row unloads mid-turn: the Channel converges to disposed (busy,
 *      cancel window and tool count released) without any agent event [A1-A3]
 *   B. events the agent sends after the unload change nothing [B1]
 *   C. a submit after the unload is refused with the disposed reason: the
 *      agent sees no call and no preview is left queued [C1-C3]
 *   D. a session unsubscribed before its context unloads reports nothing
 *      [D1]; a session on a context that stays is untouched [D2]
 *   E. the delivered `agent/disposed` path is unchanged, and a submit after
 *      it is refused too [E1, E2]
 *
 * Run: node --import tsx/esm scripts/verify-session-host-unload.ts
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { AgentEvent } from '../src/agent/events.js'
import { createDshSession } from '../src/dsh-adapter/backend/session.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { setLang, t } from '../src/i18n.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
async function settled(predicate: () => boolean, rounds = 50): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    if (predicate()) return true
    await tick()
  }
  return predicate()
}

/** A DSH agent stub: the surface `createDshSession` and the Channel read,
 *  plus a record of every input the kernel would have received. */
function stubAgent(root: Context, id: string) {
  const session = { id: `${id}-session`, seq: 0, events: [], header: { cwd: '/tmp' } }
  const calls: string[] = []
  let scope: ReturnType<typeof createScope>
  const agent = {
    id,
    status: 'idle' as 'idle' | 'running',
    options: {},
    get ctx() { return scope.ctx },
    session,
    followup(message: { id: string }) { calls.push(`followup:${message.id}`) },
    steer(message: { id: string }) { calls.push(`steer:${message.id}`) },
    cancel() { calls.push('cancel') },
    inbox: { remove: () => false },
  }
  scope = createScope(root, agent as never)
  return { agent, session, calls }
}

/** Mount a `row` plugin and resolve with its context once it applied. */
async function mountRow(root: Context, name: string): Promise<{ ctx: Context; unload(): Promise<void> }> {
  let rowCtx: Context | undefined
  const fiber = root.plugin({ name, apply(ctx: Context) { rowCtx = ctx } } as never) as unknown as { dispose(): Promise<void> | void }
  assert.ok(await settled(() => rowCtx !== undefined), `${name} applied`)
  return { ctx: rowCtx!, unload: async () => { await fiber.dispose() } }
}

const root = new Context()

// ── A–C: the Channel on the root, its startup session on the row ─────────
{
  const row = await mountRow(root, 'dsh-tui-row')
  const { agent, session, calls } = stubAgent(root, 'foreground')
  const channel = createChannel(root as never, createDshSession(row.ctx, { agent: agent as never, handle: undefined }), {
    provider: 'test',
    model: 'test-model',
    cwd: '/tmp',
    activity: false,
  })
  const emitSession = (event: object): void => { root.emit('session/event', session as never, event as never) }
  agent.status = 'running'
  root.emit('agent/status', { agent, status: 'running' } as never)
  emitSession({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  emitSession({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } })
  assert.ok(channel.working, 'fixture: the turn is open before the unload')
  channel.submit('queued while the turn runs')
  assert.ok(await settled(() => calls.some(call => call.startsWith('followup:'))), 'fixture: the follow-up reached the agent')
  const pendingBefore = channel.pending.length
  const callsBefore = calls.length

  await row.unload()
  check('A1 the row unload converges the session to disposed', await settled(() => channel.status === 'disposed'), channel.status)
  check('A2 the open turn is released: not working, no cancel window', !channel.working && !channel.cancelPending, { working: channel.working, cancelPending: channel.cancelPending })
  check('A3 no tool is left counted as running', channel.activeToolCount === 0, channel.activeToolCount)

  // The agent closes the turn after its listeners are gone (the observed
  // order: the row unloads first, the agent goes idle and disposed later).
  agent.status = 'idle'
  root.emit('agent/status', { agent, status: 'idle' } as never)
  root.emit('agent/disposed', { agent } as never)
  emitSession({ type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
  await tick()
  check('B1 events after the unload change nothing', channel.status === 'disposed' && !channel.working, { status: channel.status, working: channel.working })

  const notified = channel.notifications.length
  channel.submit('sent after the unload')
  const refusal = t('input-session-disposed')
  check('C1 a submit after the unload is refused with the disposed reason',
    await settled(() => channel.notifications.slice(notified).some(item => item.text === refusal)),
    channel.notifications.map(item => item.text))
  check('C2 the agent never sees that input', calls.length === callsBefore, calls)
  check('C3 no preview is left queued for it', channel.pending.length === pendingBefore && !channel.pending.some(item => item.text === 'sent after the unload'), channel.pending)
}

// ── D: an unsubscribed session, and a session on a context that stays ────
{
  const row = await mountRow(root, 'unsubscribed-row')
  const { agent } = stubAgent(root, 'unsubscribed')
  const batches: (readonly AgentEvent[])[] = []
  const unsubscribed = createDshSession(row.ctx, { agent: agent as never, handle: undefined })
  const unsubscribe = unsubscribed.subscribe(batch => { batches.push(batch) })
  unsubscribe()
  await row.unload()
  check('D1 an unsubscribed session reports nothing when its context unloads', batches.length === 0 && unsubscribed.status !== 'disposed', { batches, status: unsubscribed.status })

  const sibling = await mountRow(root, 'sibling-row')
  const { agent: staying } = stubAgent(root, 'staying')
  const kept: (readonly AgentEvent[])[] = []
  const onRoot = createDshSession(root, { agent: staying as never, handle: undefined })
  const release = onRoot.subscribe(batch => { kept.push(batch) })
  await sibling.unload()
  check('D2 a session on a context that stays is untouched by another unload', kept.length === 0 && onRoot.status === 'idle', { kept, status: onRoot.status })
  release()
}

// ── E: the delivered agent/disposed path ─────────────────────────────────
{
  const { agent, calls } = stubAgent(root, 'delivered')
  const statuses: string[] = []
  const delivered = createDshSession(root, { agent: agent as never, handle: undefined })
  const release = delivered.subscribe(batch => {
    for (const event of batch) if (event.type === 'session.status') statuses.push(event.status)
  })
  root.emit('agent/disposed', { agent } as never)
  check('E1 a delivered agent/disposed still reports disposed once', statuses.join(',') === 'disposed' && delivered.status === 'disposed', statuses)
  const result = await delivered.submit({ text: 'late', clientMessageId: 'late-1' }, 'followup')
  check('E2 a submit after a delivered disposal is refused and never reaches the agent',
    result.accepted === false && result.reason === t('input-session-disposed') && calls.length === 0, { result, calls })
  release()
}

await root.fiber.dispose()
console.log(`\n${passed} checks passed`)
