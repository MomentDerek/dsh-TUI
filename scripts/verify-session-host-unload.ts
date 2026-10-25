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
 *      agent sees no call and the text is held in the dock [C1-C3]
 *   D. a session unsubscribed before its context unloads reports nothing
 *      [D1]; a session on a context that stays is untouched [D2]; one whose
 *      screen unloads with it leaves the agent's queue alone [D3]
 *   E. the delivered `agent/disposed` path is unchanged, and a submit after
 *      it is refused too [E1, E2]
 *
 * Queued inputs must not vanish with the session either:
 *
 *   G. the follow-up queued before the unload is held in the dock [G1] and
 *      taken back from an agent that outlives the row [G3]; sending the dock
 *      while the session is gone keeps it [G2]
 *   F. the DSH session tells its own discards (cancel, retraction) from the
 *      kernel's (teardown, hook or parent cancel): only the latter go out as
 *      `dropped` [F1-F3]
 *   H. on any backend's channel: a `dropped` input is held [H1]; held rows
 *      survive `/new` [H2] and the dock delivers each once to the new
 *      session [H3]; an interrupt's dock still ends with its session [H4]
 *   I. texts a `/restart` carried over are parked as held rows [I1, I2]
 *   K. the end of a session closes its automatic compaction row [K1]; a
 *      draft swapped in for a held row is held too and survives /new [K2, K3];
 *      a held row keeps its images into the next session [K4]
 *   R. the carry-over file is taken once, and only a file it wrote [R1-R4];
 *      only its owner can read it [R5]; a restart that ended early names it
 *      in the resume command [R6, R7]; the replacement holds what it took once
 *      its channel is ready [R8, R9]
 *
 * Run: node --import tsx/esm scripts/verify-session-host-unload.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentInput, AgentSession, SubmitPlacement } from '../src/agent/session.js'
import { createDshSession } from '../src/dsh-adapter/backend/session.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { adoptHeldInputs, HELD_INPUTS_ENV, heldInputsResumeCommand, takeHeldInputs, writeHeldInputs } from '../src/heldInputs.js'
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
  const channel = createChannel(root as never, createDshSession(row.ctx, { agent: agent as never, handle: undefined }, { screenOutlivesContext: true }), {
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
  // The agent outlives the row here (it is borrowed: no handle): its inbox
  // still holds the follow-up, and a removal reports the discard synchronously.
  const retracted: string[] = []
  agent.inbox.remove = ((id: string) => {
    retracted.push(id)
    root.emit('agent/inbox/discarded', { agent, message: { id } } as never)
    return true
  }) as never

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
  const refusal = t('input-refused-held', { reason: t('input-session-disposed') })
  check('C1 a submit after the unload is refused with the disposed reason',
    await settled(() => channel.notifications.slice(notified).some(item => item.text === refusal)),
    channel.notifications.map(item => item.text))
  check('C2 the agent never sees that input', calls.length === callsBefore, calls)
  const refused = channel.pending.find(item => item.text === 'sent after the unload')
  check('C3 the refused input is held in the dock, not queued and not lost',
    channel.pending.length === pendingBefore + 1 && refused?.docked === true && refused.orphaned === true, channel.pending)

  const queued = channel.pending.find(item => item.text === 'queued while the turn runs')
  check('G1 the follow-up queued before the unload is held in the dock, with a notice',
    queued?.docked === true && queued.orphaned === true && channel.notifications.some(item => item.text === t('input-orphans-held-disposed', { count: 1 }) && item.text.endsWith('sends it after /new')),
    { queued, notices: channel.notifications.map(item => item.text) })
  check('G3 the unload takes that follow-up back from an agent that outlives the row, so the held row is never also run',
    retracted.length === 1 && retracted[0] === queued?.id, { retracted, queued })
  const beforeSend = calls.length
  check('G2 sending the dock while the session is gone keeps it and says why',
    channel.deliverDocked() === 0 && channel.pending.some(item => item.id === queued?.id && item.docked === true)
      && calls.length === beforeSend && channel.notifications.some(item => item.text === t('input-dock-session-disposed')),
    { pending: channel.pending, calls })

  const rows = channel.pending.length
  check('I1 texts a /restart carried over are parked as held rows, blanks skipped, with a notice',
    channel.holdInputs(['carried over', '   ']) === 1 && channel.pending.length === rows + 1
      && channel.pending.at(-1)?.text === 'carried over' && channel.pending.at(-1)?.docked === true && channel.pending.at(-1)?.orphaned === true
      && channel.notifications.at(-1)?.text === t('input-orphans-held', { count: 1 }),
    channel.pending)
  check('I2 nothing reaches the agent for them', calls.length === beforeSend, calls)
}

// ── R: the /restart carry-over file ──────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-held-'))
  try {
    check('R1 an empty queue writes nothing', writeHeldInputs(['', '  '], dir, 42) === undefined && readdirSync(dir).length === 0)
    const env: NodeJS.ProcessEnv = { ...writeHeldInputs(['one', 'two\nlines', ' '], dir, 42) }
    check('R2 the replacement takes the texts once, and the file and marker go', JSON.stringify(takeHeldInputs(env)) === '["one","two\\nlines"]'
      && env[HELD_INPUTS_ENV] === undefined && readdirSync(dir).length === 0)
    check('R3 a second take finds nothing', takeHeldInputs({ ...env }).length === 0)
    if (process.platform !== 'win32') {
      const marker = writeHeldInputs(['private'], dir, 43)?.[HELD_INPUTS_ENV]
      check('R5 the file is readable by its owner alone', marker !== undefined && (statSync(marker).mode & 0o077) === 0, marker)
      takeHeldInputs({ [HELD_INPUTS_ENV]: marker })
    }
    const kept = writeHeldInputs(['kept'], join(dir, 'it\'s here'), 44)
    const file = kept?.[HELD_INPUTS_ENV] ?? ''
    const line = heldInputsResumeCommand('dsh-tui --resume s1', kept, 'linux')
    check('R6 a restart that ended early names the kept file in the resume command, quoted, and that command takes it',
      line === `${HELD_INPUTS_ENV}='${file.replaceAll('\'', '\'\\\'\'')}' dsh-tui --resume s1`
        && heldInputsResumeCommand('dsh-tui --resume s1', kept, 'win32') === `dsh-tui --resume s1\n(queued messages kept in ${file})`
        && JSON.stringify(takeHeldInputs({ ...kept })) === '["kept"]',
      line)
    check('R7 with nothing kept the resume command is unchanged',
      heldInputsResumeCommand('dsh-tui --resume s1', kept, 'linux') === 'dsh-tui --resume s1'
        && heldInputsResumeCommand('dsh-tui --resume s1', undefined, 'linux') === 'dsh-tui --resume s1')
    // The replacement's boot, against a channel that becomes ready later.
    const carried = { ...writeHeldInputs(['first', 'second'], dir, 45) } as NodeJS.ProcessEnv
    const held: string[][] = []
    const listeners = new Set<() => void>()
    const later = {
      ready: false,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      holdInputs(texts: readonly string[]) { held.push([...texts]); return texts.length },
    }
    const stop = adoptHeldInputs(later, carried)
    const waited = held.length === 0 && stop !== undefined
    later.ready = true
    for (const listener of [...listeners]) listener()
    check('R8 a replacement takes the carried texts and holds them once its channel is ready, then stops listening',
      waited && JSON.stringify(held) === '[["first","second"]]' && listeners.size === 0 && carried[HELD_INPUTS_ENV] === undefined,
      { held, listeners: listeners.size })
    check('R9 a boot with nothing carried holds nothing', adoptHeldInputs(later, {}) === undefined && held.length === 1)
    const foreign = join(dir, 'notes.json')
    writeFileSync(foreign, JSON.stringify({ texts: ['x'] }))
    check('R4 a marker naming any other file is ignored and the file is kept', takeHeldInputs({ [HELD_INPUTS_ENV]: foreign }).length === 0 && existsSync(foreign))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── F: own discards vs the kernel's ──────────────────────────────────────
{
  const { agent } = stubAgent(root, 'discards')
  const changes: AgentEvent[] = []
  const session = createDshSession(root, { agent: agent as never, handle: undefined })
  const release = session.subscribe(batch => { for (const event of batch) if (event.type === 'pending.changed') changes.push(event) })
  const queue: string[] = []
  const discard = (id: string): void => { root.emit('agent/inbox/discarded', { agent, message: { id } } as never) }
  // The kernel reports a discard synchronously, inside the call that made it.
  agent.followup = (message: { id: string }) => { queue.push(message.id) }
  agent.cancel = () => { for (const id of queue.splice(0)) discard(id) }
  agent.inbox.remove = ((id: string) => { const at = queue.indexOf(id); if (at < 0) return false; queue.splice(at, 1); discard(id); return true }) as never
  const submit = async (text: string): Promise<string> => {
    const id = `${text}-id`
    await session.submit({ text, clientMessageId: id, native: { id, content: [{ type: 'text', text }] } } as never, 'followup')
    return id
  }
  const kinds = (event: AgentEvent): string => event.type !== 'pending.changed' ? '' : Object.keys(event).filter(key => key === 'discarded' || key === 'dropped' || key === 'claimed').join()

  const retracted = await submit('retract me')
  session.capabilities.pendingRetraction!.remove(retracted)
  check('F1 a retraction is the session\'s own discard', changes.length === 1 && kinds(changes[0]!) === 'discarded', changes)

  await submit('interrupt me')
  await session.cancel('interrupt')
  check('F2 an interrupt drops its queue as the session\'s own discard', changes.length === 2 && kinds(changes[1]!) === 'discarded', changes)

  const lost = await submit('lose me')
  queue.splice(queue.indexOf(lost), 1)
  discard(lost)
  check('F3 a discard the session did not ask for goes out as dropped', changes.length === 3 && kinds(changes[2]!) === 'dropped'
    && (changes[2] as { dropped?: readonly string[] }).dropped?.[0] === lost, changes)
  release()
}

// ── H: held rows on any backend's channel, across /new ───────────────────
{
  interface Fake extends AgentSession {
    readonly sent: string[]
    /** Images each submit carried, in order. */
    readonly sentImages: number[]
    emit(events: readonly AgentEvent[]): void
  }
  const IMAGES = { limits: { maxImageBytes: 5e6, maxImagesPerMessage: 10, maxImageDimension: 8000, maxImagePixels: 1e8, mediaTypes: ['image/png'] } }
  const fake = (sessionId: string, images = false): Fake => {
    const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
    const session: Fake = {
      ref: { backendId: 'fake', sessionId },
      cwd: '/tmp',
      status: 'idle',
      capabilities: { native: {}, ...(images ? { images: IMAGES } : {}) } as Fake['capabilities'],
      sent: [],
      sentImages: [],
      history: () => Promise.resolve([]),
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      submit(input: AgentInput, _placement: SubmitPlacement) {
        session.sent.push(input.text)
        session.sentImages.push((input as { images?: readonly unknown[] }).images?.length ?? 0)
        return Promise.resolve({ accepted: true })
      },
      cancel: () => Promise.resolve({ stillQueued: [], outcome: 'confirmed' }),
      dispose: () => Promise.resolve(),
      emit(events) { for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync' }) },
    }
    return session
  }
  const first = fake('33333333-3333-4333-8333-333333333333')
  const opened: Fake[] = []
  const bare = { on: () => () => undefined, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } } as never
  const channel = createChannel(bare, first, {
    model: 'm', provider: '', cwd: '/tmp', activity: false,
    openSession: () => { const next = fake(`44444444-4444-4444-8444-44444444444${opened.length}`); opened.push(next); return Promise.resolve(next) },
  })
  const idOf = (text: string): string | undefined => channel.pending.find(item => item.text === text)?.id
  first.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }])
  channel.submit('dropped by the backend')
  channel.submit('kept by an interrupt')
  assert.ok(await settled(() => first.sent.length === 2), 'fixture: both inputs reached the first session')
  const dropped = idOf('dropped by the backend')!
  first.emit([{ type: 'pending.changed', items: [], dropped: [dropped] }])
  const held = channel.pending.find(item => item.id === dropped)
  check('H1 a dropped input is held in the dock, not retired', held?.docked === true && held.orphaned === true, channel.pending)

  // An interrupt docks the other row the usual way: its dock is the session's.
  assert.ok(channel.interruptAndDock() >= 1, 'fixture: the interrupt docked a row')
  await tick()
  first.emit([{ type: 'turn.end', turn: 1, reason: { kind: 'interrupted' }, time: 2 }])
  assert.ok(await channel.newSession() === true && opened.length === 1, 'fixture: /new opened the next session')
  check('H2 the held row survives /new', channel.pending.some(item => item.id === dropped && item.docked === true), channel.pending)
  check('H4 an interrupt\'s dock still ends with its session', !channel.pending.some(item => item.text === 'kept by an interrupt'), channel.pending)
  const next = opened[0]!
  check('H3 the dock delivers the held row once, to the new session',
    channel.deliverDocked() === 1 && await settled(() => next.sent.length === 1) && next.sent[0] === 'dropped by the backend'
      && first.sent.length === 2 && !channel.pending.some(item => item.docked === true),
    { next: next.sent, first: first.sent, pending: channel.pending })

  // ── K: what the end of a session leaves on screen ──
  const ending = fake('55555555-5555-4555-8555-555555555555')
  const after: Fake[] = []
  const screen = createChannel(bare, ending, {
    model: 'm', provider: '', cwd: '/tmp', activity: false,
    openSession: () => { const next = fake('66666666-6666-4666-8666-666666666666'); after.push(next); return Promise.resolve(next) },
  })
  ending.emit([{ type: 'compaction.start', trigger: 'auto', cancellable: false, time: 1 }])
  assert.ok(screen.compaction !== undefined, 'fixture: the automatic compaction row is open')
  screen.submit('queued before the end')
  assert.ok(await settled(() => ending.sent.length === 1), 'fixture: the input reached the session')
  ending.emit([{ type: 'session.status', status: 'disposed' }])
  check('K1 the end of a session closes its automatic compaction row', screen.compaction === undefined, screen.compaction)
  const heldId = screen.pending.find(item => item.text === 'queued before the end')?.id
  check('K2 a draft swapped in for a held row is held too',
    heldId !== undefined && screen.swapDockedForDraft(heldId, { text: 'my unsent draft' })
      && screen.pending.some(item => item.text === 'my unsent draft' && item.docked === true && item.orphaned === true),
    screen.pending)
  assert.ok(await screen.newSession() === true && after.length === 1, 'fixture: /new opened the next session')
  check('K3 that draft survives /new and the dock sends it once',
    screen.pending.some(item => item.text === 'my unsent draft') && screen.deliverDocked() === 1
      && await settled(() => after[0]!.sent.length === 1) && after[0]!.sent[0] === 'my unsent draft',
    { pending: screen.pending, sent: after[0]?.sent })

  // A held row keeps its images into the next session.
  const pictured = fake('77777777-7777-4777-8777-777777777777', true)
  const later: Fake[] = []
  const withImages = createChannel(bare, pictured, {
    model: 'm', provider: '', cwd: '/tmp', activity: false,
    openSession: () => { const next = fake('88888888-8888-4888-8888-888888888888', true); later.push(next); return Promise.resolve(next) },
  })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const token = await withImages.stageImage({ data: png, mediaType: 'image/png', name: 'dot.png' } as never)
  pictured.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }])
  withImages.submit(`look at ${token}`)
  assert.ok(await settled(() => pictured.sent.length === 1) && pictured.sentImages[0] === 1, 'fixture: the image reached the first session')
  pictured.emit([{ type: 'pending.changed', items: [], dropped: [withImages.pending[0]!.id] }])
  pictured.emit([{ type: 'turn.end', turn: 1, reason: { kind: 'interrupted' }, time: 2 }])
  assert.ok(await withImages.newSession() === true && later.length === 1, 'fixture: /new opened the next session')
  const noticesBefore = withImages.notifications.length
  check('K4 a held row keeps its image across /new and the dock sends it with the image',
    withImages.deliverDocked() === 1 && await settled(() => later[0]!.sent.length === 1)
      && later[0]!.sentImages[0] === 1 && withImages.notifications.length === noticesBefore,
    { sent: later[0]?.sent, images: later[0]?.sentImages, notices: withImages.notifications.slice(noticesBefore).map(item => item.text) })
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

  // The plugin's own screen unloads with its context: a surviving agent
  // keeps what it queued (the remounted screen adopts that agent again).
  const shared = await mountRow(root, 'shared-row')
  const { agent: surviving } = stubAgent(root, 'surviving')
  const removed: string[] = []
  surviving.inbox.remove = ((id: string) => { removed.push(id); return true }) as never
  const together = createDshSession(shared.ctx, { agent: surviving as never, handle: undefined })
  const releaseTogether = together.subscribe(() => undefined)
  await together.submit({ text: 'stays queued', clientMessageId: 'stays-1', native: { id: 'stays-1', content: [{ type: 'text', text: 'stays queued' }] } } as never, 'followup')
  await shared.unload()
  check('D3 a screen that unloads with the context leaves the agent\'s queue alone', removed.length === 0 && together.status === 'disposed', { removed, status: together.status })
  releaseTogether()
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
