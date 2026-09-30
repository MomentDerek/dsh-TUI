/**
 * verify-preboot — the `dst` fast start: one Chat, mounted before dsh, made
 * live in place.
 *
 * `dst` starts dsh with `--import lib/types/preboot/entry.js`; the preload
 * mounts the real root tree against a boot channel (`ready === false`) and
 * publishes the slot; the plugin later calls `slot.ready(live)` and the live
 * channel slides in underneath the running Chat. Pinned here, headless:
 *
 *   1. SETTINGS: renderer decisions come from the `dsh-tui:` layer of
 *      `$DSH_HOME/settings.yaml`, defaulting like the plugin schema.
 *   2. DEFERRED CHANNEL: one object for life — properties and methods follow
 *      the backing channel, `version` stays monotonic across the swap, and a
 *      listener subscribed against the boot channel keeps firing afterwards.
 *   3. BOOT CHANNEL: every port member has a boot answer (the inventory is
 *      covered at runtime too, not only by the compiler); actions refuse with
 *      a notice; notices expire.
 *   4. BOOT PHASE: the real Chat paints with the boot status hint; typing,
 *      Backspace and bracketed paste work; Enter refuses and keeps the text.
 *   5. GOING LIVE: after `ready()` the same Chat shows the live model, the
 *      hint is gone, the draft is still in the composer, a live-channel
 *      notification reaches the screen through the pre-live subscription,
 *      and Enter now submits.
 *   6. FALLBACK + EXIT: `draft()` + `dispose()` carry the text into a fresh
 *      slot mounted already live (renderer mismatch path); a double Ctrl+C in
 *      the boot phase exits with 0 (a user exit, like the live funnel); the published slot is taken exactly once.
 *   7. FATAL: an uncaught error while dsh is still loading tears the boot
 *      screen down, reaches stderr and exits 1 (the #185 process guard must
 *      not rethrow it from its listener — exit 7, terminal left in alt-screen).
 *
 * Run: node --import tsx/esm scripts/verify-preboot.tsx
 */
import { fileURLToPath } from 'node:url'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
const home = fileURLToPath(new URL('../node_modules/.cache/dsh-tui-preboot-home', import.meta.url))
process.env.HOME = home
process.env.USERPROFILE = home

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import xterm from '@xterm/headless'
import type { ChannelUi } from '../src/adapter/ports/channel-ui.js'
import { settled, sleep } from './lib/term-test.mjs'

mkdirSync(home, { recursive: true })
const dshHome = join(home, '.dsh')
mkdirSync(dshHome, { recursive: true })
writeFileSync(join(dshHome, 'settings.yaml'), [
  'dsh-tui:',
  '  fullscreen: false',
  '  pageMargin: none',
  '  whale: false',
  '  effortDefault: high',
  '  statusBar:',
  '    compact: true',
  '',
].join('\n'))

const { Terminal: XTerm } = xterm
const [
  { decidePreboot, mountPreboot, readTuiSettingsLayer },
  { peekPrebootSlot, takePrebootSlot },
  { mountChatHost },
  { createBootChannel },
  { createDeferredChannel },
  { CHANNEL_UI_EFFECTS, CHANNEL_UI_PROPERTIES },
  { QuestionStore },
  { default: instances },
] = await Promise.all([
  import('../src/preboot/mount.js'),
  import('../src/preboot/handle.js'),
  import('../src/preboot/host.js'),
  import('../src/preboot/bootChannel.js'),
  import('../src/adapter/channel/deferred.js'),
  import('../src/adapter/channel/ui-policy.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 100
const ROWS = 30
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  text = ''
  _write(chunk: unknown, _e: BufferEncoding, callback: () => void): void {
    this.text += String(chunk)
    callback()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}
const terminal = new XTerm({ cols: COLS, rows: ROWS, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const stdin = new FakeStdin()
const stderr = new FakeStderr()
const screen = (): string => {
  const buffer = terminal.buffer.active
  return Array.from({ length: ROWS }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '').join('\n')
}
const type = async (data: string): Promise<void> => {
  stdin.write(data)
  await sleep(40)
}
const renderOptions = { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false }
const BOOT_HINT = 'DeepSeek Harness is starting'

/**
 * A stand-in live channel: the boot channel's shape with a live identity, its
 * own version/subscribe, and recording `submit`/`notify`.
 */
function makeLiveChannel() {
  const base = createBootChannel({ model: 'boot', effort: undefined, cwd: '/tmp/live', gitBranch: undefined, settings: {} })
  const listeners = new Set<() => void>()
  let version = 500
  let notifications: { id: number; text: string; timeoutMs: number }[] = []
  const submitted: string[] = []
  const emit = (): void => {
    version += 1
    for (const listener of [...listeners]) listener()
  }
  const live = Object.create(null) as Record<string, unknown>
  // The boot channel is frozen: re-open its descriptors so the live identity
  // below can override them.
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(base))) {
    Object.defineProperty(live, key, { ...descriptor, configurable: true })
  }
  Object.defineProperties(live, {
    version: { enumerable: true, get: () => version },
    notifications: { enumerable: true, get: () => notifications },
    ready: { enumerable: true, value: true },
    status: { enumerable: true, value: 'idle' },
    agentId: { enumerable: true, value: 'live-agent-0001' },
    sessionId: { enumerable: true, value: 'live-agent-0001' },
    model: { enumerable: true, value: 'live-model-x' },
    subscribe: {
      enumerable: true,
      value: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    submit: {
      enumerable: true,
      value: (text: string) => {
        submitted.push(text)
        emit()
      },
    },
    notify: {
      enumerable: true,
      value: (text: string, options?: { timeoutMs?: number }) => {
        const id = notifications.length + 1
        notifications = [...notifications, { id, text, timeoutMs: options?.timeoutMs ?? 4000 }]
        emit()
        return () => {
          notifications = notifications.filter(item => item.id !== id)
          emit()
        }
      },
    },
  })
  return { channel: Object.freeze(live) as unknown as ChannelUi, submitted, emit, listenerCount: () => listeners.size }
}

// ── 1. settings layer → decisions ───────────────────────────────────────────
const layer = readTuiSettingsLayer(dshHome)
const decided = decidePreboot(layer)
check('settings: fullscreen false read from the user layer', decided.fullscreen === false)
check('settings: terminalImages defaults on', decided.terminalImages === true)
check('settings: effortDefault wins', decided.effort === 'high', String(decided.effort))
const defaults = decidePreboot(readTuiSettingsLayer(join(home, 'no-such-dsh-home')))
check('settings: missing file → schema defaults', defaults.fullscreen && defaults.terminalImages && !defaults.minimalUi)

// ── 2. deferred channel ─────────────────────────────────────────────────────
{
  const boot = createBootChannel({ model: 'boot-model', effort: 'low', cwd: '/tmp/boot', gitBranch: 'main', settings: {} })
  const deferred = createDeferredChannel(boot)
  const view = deferred.channel
  check('deferred: boot properties read through', view.ready === false && view.model === 'boot-model' && view.gitBranch === 'main')
  let wakeups = 0
  const unsubscribe = view.subscribe(() => { wakeups += 1 })
  boot.notify('boot notice', { timeoutMs: 0 })
  check('deferred: boot-channel bump reaches a listener', wakeups === 1 && view.notifications.length === 1)
  const before = view.version
  const live = makeLiveChannel()
  deferred.resolve(live.channel)
  check('deferred: same object, live properties now', view.ready === true && view.model === 'live-model-x' && view.agentId === 'live-agent-0001')
  check('deferred: version advances by exactly one at the swap', view.version === before + 1, `${before} → ${view.version}`)
  check('deferred: resolve notifies existing listeners once', wakeups === 2, String(wakeups))
  check('deferred: listener moved to the live channel', live.listenerCount() === 1)
  live.emit()
  check('deferred: live bump reaches the pre-live listener', wakeups === 3 && view.version === before + 2)
  view.submit('through the view')
  check('deferred: methods forward to the live channel', live.submitted[0] === 'through the view')
  boot.notify('stale', { timeoutMs: 0 })
  check('deferred: the boot channel no longer wakes the view', wakeups === 4, String(wakeups))
  unsubscribe()
  check('deferred: unsubscribe detaches', live.listenerCount() === 0)
  let threw = false
  try { deferred.resolve(live.channel) } catch { threw = true }
  check('deferred: a second resolve throws', threw)
}

// ── 3. boot channel ─────────────────────────────────────────────────────────
{
  const boot = createBootChannel({ model: 'm', effort: undefined, cwd: '/tmp/x', gitBranch: undefined, settings: { whaleGirl: true, expandEditor: false } })
  const missingProps = CHANNEL_UI_PROPERTIES.filter(key => !(key in boot))
  const missingMethods = (Object.keys(CHANNEL_UI_EFFECTS) as (keyof typeof CHANNEL_UI_EFFECTS)[]).filter(key => typeof boot[key] !== 'function')
  check('boot: every inventoried property is present', missingProps.length === 0, missingProps.join(','))
  check('boot: every inventoried method is a function', missingMethods.length === 0, missingMethods.join(','))
  check('boot: settings layer shapes display properties', boot.whaleGirl === true && boot.expandEditor === false && boot.whale === true)
  check('boot: not ready, empty transcript, no agent', boot.ready === false && boot.rows.length === 0 && boot.agentId === '')
  const v0 = boot.version
  boot.submit('nope')
  check('boot: submit refuses with a notice', boot.notifications.some(item => item.text.includes('Not ready')) && boot.version > v0)
  const dismiss = boot.notify('short', { timeoutMs: 60 })
  check('boot: notify returns a dismiss handle', typeof dismiss === 'function')
  await sleep(120)
  check('boot: notices expire on their timeout', !boot.notifications.some(item => item.text === 'short'))
  check('boot: completions come from the local catalog', boot.commandCompletions('/mod').length > 0)
  check('boot: queries answer neutrally', (await boot.listSessions()).length === 0 && boot.settingsHost() === undefined && (await boot.resumeTo('x')).ok === false)
}

// ── 4. boot phase on the real Chat ──────────────────────────────────────────
let exitCode: number | undefined
const slot = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
check('mount: slot published on globalThis', peekPrebootSlot() === slot)
check('mount: slot mirrors renderer decisions', slot.fullscreen === false && slot.terminalImages === true && slot.phase === 'booting')
check('mount: boot status hint painted', await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 }), screen())
check('mount: prompt painted', screen().includes('❯'))
check('mount: effort from settings on the status line', screen().includes('high'), screen())
const liveInstance = instances.get(stdout as never)
check('mount: instance registered by stdout', liveInstance !== undefined && slot.instance !== undefined)

await type('/mo')
check('edit: slash menu opens from the local catalog', await settled(() => screen().includes('commands ·') && screen().includes('model'), { timeoutMs: 2000 }), screen())
await type('\x7f\x7f\x7f')
check('edit: menu text removed again', await settled(() => slot.draft() === '', { timeoutMs: 2000 }), slot.draft())
await type('hello')
check('edit: typed text shows', await settled(() => screen().includes('hello'), { timeoutMs: 2000 }), screen())
await type('\r')
check('edit: Enter shows the not-ready notice', await settled(() => screen().includes('Not ready yet'), { timeoutMs: 2000 }), screen())
check('edit: Enter keeps the text', screen().includes('hello') && slot.draft() === 'hello')
await type('\x7f')
check('edit: Backspace deletes', await settled(() => slot.draft() === 'hell', { timeoutMs: 2000 }), slot.draft())
await type('\x1b[200~ 世界\x1b[201~')
check('edit: bracketed paste inserts (wide chars)', await settled(() => slot.draft() === 'hell 世界', { timeoutMs: 2000 }), slot.draft())

// ── 5. going live ───────────────────────────────────────────────────────────
const live = makeLiveChannel()
const versionBefore = slot.channel.version
check('live: taking the slot removes it', takePrebootSlot() === slot && takePrebootSlot() === undefined)
slot.ready({ channel: live.channel, props: { questionStore: new QuestionStore(), onExit: () => { exitCode = 0 } } })
check('live: phase and channel flip in place', slot.phase === 'ready' && slot.channel.ready === true && slot.channel.version > versionBefore)
check('live: same instance, no re-mount', instances.get(stdout as never) === liveInstance)
check('live: boot hint gone', await settled(() => !screen().includes(BOOT_HINT), { timeoutMs: 2000 }), screen())
check('live: live model on the status line', await settled(() => screen().includes('live-model-x'), { timeoutMs: 2000 }), screen())
check('live: draft survived the session arriving', slot.draft() === 'hell 世界' && screen().includes('hell 世界'), slot.draft())
live.channel.notify('LIVE NOTICE ARRIVED', { timeoutMs: 0 })
check('live: a live notification reaches the screen (pre-live subscription)', await settled(() => screen().includes('LIVE NOTICE ARRIVED'), { timeoutMs: 2000 }), screen())
await type('\r')
check('live: Enter now submits the draft', await settled(() => live.submitted[0] === 'hell 世界', { timeoutMs: 2000 }), JSON.stringify(live.submitted))
check('live: composer cleared after the send', await settled(() => slot.draft() === '', { timeoutMs: 2000 }), slot.draft())
let readyTwiceThrew = false
try { slot.ready({ channel: live.channel, props: { questionStore: new QuestionStore(), onExit: () => {} } }) } catch { readyTwiceThrew = true }
check('live: ready() is one-shot', readyTwiceThrew)
slot.dispose()
check('dispose: unmount clears the registry', instances.get(stdout as never) === undefined)
slot.dispose()
check('dispose: idempotent', slot.phase === 'disposed')

// ── 6. mismatch fallback + Ctrl+C exit ──────────────────────────────────────
exitCode = undefined
const second = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
check('remount: fresh slot published', peekPrebootSlot() === second && instances.get(stdout as never) !== undefined)
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
await type('carry me')
await settled(() => second.draft() === 'carry me', { timeoutMs: 2000 })
const carried = second.draft()
takePrebootSlot()
second.dispose()
const fresh = await mountChatHost({
  fullscreen: false,
  terminalImages: true,
  renderOptions,
  initial: {
    channel: makeLiveChannel().channel,
    props: { questionStore: new QuestionStore(), onExit: () => {}, initialDraft: { value: carried, cursor: carried.length } },
  },
})
check('fallback: fresh slot mounts already live', fresh.phase === 'ready')
check('fallback: carried draft restored into the composer', await settled(() => fresh.draft() === 'carry me' && screen().includes('carry me'), { timeoutMs: 3000 }), fresh.draft())
fresh.dispose()

exitCode = undefined
const third = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
await type('\x03')
check('ctrl+c: first press only arms', await settled(() => screen().includes('again'), { timeoutMs: 2000 }) && exitCode === undefined, screen())
await type('\x03')
check('ctrl+c: second press exits 0 (user exit, not a crash)', await settled(() => exitCode === 0, { timeoutMs: 2000 }), String(exitCode))
check('ctrl+c: renderer torn down', third.phase === 'disposed' && instances.get(stdout as never) === undefined)
takePrebootSlot()

// ── 7. fatal error while dsh is still loading ───────────────────────────────
// The preboot Ink instance installs the #185 process guard before dsh runs;
// without a boot-phase sink the guard rethrows from its listener (exit 7, no
// terminal restore). An error dsh throws while composing must restore the
// terminal, reach stderr, and exit 1 like the plain path.
exitCode = undefined
stderr.text = ''
const fourth = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
let rethrown: unknown
try {
  process.emit('uncaughtException', new Error('profile does-not-exist-xyz not found'), 'uncaughtException')
} catch (error) {
  rethrown = error
}
check('fatal: boot-phase error claimed, not rethrown', rethrown === undefined, String(rethrown))
check('fatal: exits 1 like the plain path', exitCode === 1, String(exitCode))
check('fatal: boot screen torn down first', fourth.phase === 'disposed' && instances.get(stdout as never) === undefined)
check('fatal: error reaches stderr', stderr.text.includes('profile does-not-exist-xyz not found'), JSON.stringify(stderr.text))
takePrebootSlot()

exitCode = undefined
stderr.text = ''
const fifth = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
rethrown = undefined
try {
  process.emit('unhandledRejection', undefined, Promise.resolve())
} catch (error) {
  rethrown = error
}
check('fatal: undefined rejection claimed and exits 1', rethrown === undefined && exitCode === 1 && fifth.phase === 'disposed', `${String(rethrown)} ${String(exitCode)}`)
check('fatal: undefined reason named on stderr', stderr.text.includes('unhandledRejection with undefined reason'), JSON.stringify(stderr.text))
takePrebootSlot()

terminal.dispose()
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
process.exit(0)
