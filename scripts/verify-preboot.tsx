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
 *      Enter now submits, and the handoff writes no scrollback/screen clear
 *      (a later real session switch still repaints).
 *   6. FALLBACK + EXIT: `draft()` + `dispose()` carry the text into a fresh
 *      slot mounted already live (renderer mismatch path); a double Ctrl+C in
 *      the boot phase exits with 0 (a user exit, like the live funnel); the published slot is taken exactly once.
 *   7. FATAL: an uncaught error while dsh is still loading tears the boot
 *      screen down, reaches stderr and exits 1 (the #185 process guard must
 *      not rethrow it from its listener — exit 7, terminal left in alt-screen).
 *   8. BOOT SCREENS: during boot only purely local slash commands run (a
 *      menu-selected /model or /settings is refused with the text kept, /vim
 *      runs); the session screen opened during boot gains its foreign-source
 *      tabs at ready; a draft (vim mode, or text parked via the prompt row's
 *      ⌸ in fullscreen) survives Esc back to the composer after ready.
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
  /** Every byte written, for escape-sequence assertions. */
  written = ''
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.written += String(chunk)
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
  let agentId = 'live-agent-0001'
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
    agentId: { enumerable: true, get: () => agentId },
    sessionId: { enumerable: true, value: 'live-agent-0001' },
    model: { enumerable: true, value: 'live-model-x' },
    // Non-zero, unlike the boot channel's 0: a draft stored under the boot
    // owner must be rebound, not merely re-keyed by agent id.
    agentBindingGeneration: { enumerable: true, value: 7 },
    listForeignSources: { enumerable: true, value: () => Promise.resolve([{ agentId: 'claude-code', label: 'Claude Code' }]) },
    listForeignSessions: { enumerable: true, value: () => Promise.resolve([]) },
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
  /** A real session switch on the live channel (resume, /new). */
  const switchAgent = (id: string): void => {
    agentId = id
    emit()
  }
  return { channel: Object.freeze(live) as unknown as ChannelUi, submitted, emit, switchAgent, listenerCount: () => listeners.size }
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
const bytesBeforeReady = stdout.written.length
slot.ready({ channel: live.channel, props: { questionStore: new QuestionStore(), onExit: () => { exitCode = 0 } } })
check('live: phase and channel flip in place', slot.phase === 'ready' && slot.channel.ready === true && slot.channel.version > versionBefore)
check('live: same instance, no re-mount', instances.get(stdout as never) === liveInstance)
check('live: boot hint gone', await settled(() => !screen().includes(BOOT_HINT), { timeoutMs: 2000 }), screen())
check('live: live model on the status line', await settled(() => screen().includes('live-model-x'), { timeoutMs: 2000 }), screen())
check('live: draft survived the session arriving', slot.draft() === 'hell 世界' && screen().includes('hell 世界'), slot.draft())
// The live id arriving is adoption, not a session switch: the switch path's
// scrollback clear (CSI 3J + 2J) would wipe inline scrollback and flash the
// screen at the handoff. Give its setTimeout(0) repaint time to fire.
await sleep(150) // 固定窗:探针 断言切换路径的 setTimeout(0) 重绘不发生
const handoffBytes = stdout.written.slice(bytesBeforeReady)
check('live: handoff writes no scrollback/screen clear', !handoffBytes.includes('\x1b[3J') && !handoffBytes.includes('\x1b[2J'), JSON.stringify(handoffBytes.slice(0, 200)))
live.channel.notify('LIVE NOTICE ARRIVED', { timeoutMs: 0 })
check('live: a live notification reaches the screen (pre-live subscription)', await settled(() => screen().includes('LIVE NOTICE ARRIVED'), { timeoutMs: 2000 }), screen())
await type('\r')
check('live: Enter now submits the draft', await settled(() => live.submitted[0] === 'hell 世界', { timeoutMs: 2000 }), JSON.stringify(live.submitted))
check('live: composer cleared after the send', await settled(() => slot.draft() === '', { timeoutMs: 2000 }), slot.draft())
const bytesBeforeSwitch = stdout.written.length
live.switchAgent('live-agent-0002')
check('live: a real session switch afterwards still repaints', await settled(() => stdout.written.slice(bytesBeforeSwitch).includes('\x1b[3J'), { timeoutMs: 2000 }))
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

// ── 8. boot-phase screens and commands ─────────────────────────────────────
// Slash commands during boot: only the purely local ones run; the rest are
// refused like a plain prompt (text kept, not-ready notice) on EVERY dispatch
// path, including the menu's selected row. A session screen opened during
// boot lists its foreign-source tabs once the live channel arrives, and a
// draft parked while it was open comes back after ready.
{
  exitCode = undefined
  const sixth = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
  await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
  await type('/mo')
  await settled(() => screen().includes('commands ·'), { timeoutMs: 2000 })
  await type('\r')
  check('boot cmd: menu-selected /model refused with the notice', await settled(() => screen().includes('Not ready yet'), { timeoutMs: 2000 }), screen())
  check('boot cmd: menu-selected /model keeps the draft', sixth.draft() === '/mo', JSON.stringify(sixth.draft()))
  await type('\x7f\x7f\x7f')
  await settled(() => sixth.draft() === '', { timeoutMs: 2000 })
  await type('/settings')
  await type('\r')
  await sleep(100) // 固定窗:探针 断言 /settings 不开空设置屏
  check('boot cmd: /settings refused, draft kept', sixth.draft() === '/settings' && !screen().includes('Settings unavailable'), `${JSON.stringify(sixth.draft())}\n${screen()}`)
  for (let i = 0; i < '/settings'.length; i++) await type('\x7f')
  await settled(() => sixth.draft() === '', { timeoutMs: 2000 })
  await type('/vim')
  await type('\r')
  check('boot cmd: /vim runs during boot', await settled(() => sixth.draft() === '' && screen().includes('vim mode on') && screen().includes('INSERT'), { timeoutMs: 2000 }), `${JSON.stringify(sixth.draft())}\n${screen()}`)
  // The keyboard door to the session screen. The line itself is consumed, but
  // vim mode rides the parked draft snapshot even with no text.
  await type('/resume')
  await type('\r')
  check('boot screen: /resume opens the session screen during boot', await settled(() => !screen().includes('INSERT'), { timeoutMs: 2000 }), screen())
  const liveSix = makeLiveChannel()
  takePrebootSlot()
  sixth.ready({ channel: liveSix.channel, props: { questionStore: new QuestionStore(), onExit: () => { exitCode = 0 } } })
  check('boot screen: foreign-source tab appears after ready', await settled(() => screen().includes('Claude Code'), { timeoutMs: 3000 }), screen())
  await type('\x1b')
  if (!(await settled(() => screen().includes('❯'), { timeoutMs: 800 }))) await type('\x1b')
  check('boot screen: vim mode parked during boot survives Esc after ready', await settled(() => screen().includes('❯') && screen().includes('INSERT'), { timeoutMs: 2000 }), screen())
  sixth.dispose()
}

// The prompt row's ⌸ is the door that keeps TEXT in the composer while the
// session screen is open (it needs mouse tracking, so a fullscreen home).
{
  const fullHome = join(home, '.dsh-full')
  mkdirSync(fullHome, { recursive: true })
  writeFileSync(join(fullHome, 'settings.yaml'), 'dsh-tui:\n  fullscreen: true\n  whale: false\n')
  exitCode = undefined
  const seventh = await mountPreboot({ dshHome: fullHome, renderOptions, exit: code => { exitCode = code } })
  check('boot screen (fullscreen): mounted', await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 }), screen())
  await type('keep me')
  await settled(() => seventh.draft() === 'keep me', { timeoutMs: 2000 })
  const lines = screen().split('\n')
  const homeRow = lines.findIndex(line => line.includes('⌸') && line.includes('keep me'))
  const homeCol = homeRow < 0 ? -1 : lines[homeRow]!.indexOf('⌸')
  check('boot screen (fullscreen): ⌸ on the prompt row', homeRow >= 0, screen())
  stdin.write(`\x1b[<0;${homeCol + 1};${homeRow + 1}M`)
  stdin.write(`\x1b[<0;${homeCol + 1};${homeRow + 1}m`)
  check('boot screen (fullscreen): ⌸ opens the session screen during boot', await settled(() => !screen().includes('keep me'), { timeoutMs: 2000 }), screen())
  const liveSeven = makeLiveChannel()
  takePrebootSlot()
  seventh.ready({ channel: liveSeven.channel, props: { questionStore: new QuestionStore(), onExit: () => { exitCode = 0 } } })
  await settled(() => screen().includes('Claude Code'), { timeoutMs: 3000 })
  await type('\x1b')
  if (!(await settled(() => screen().includes('keep me'), { timeoutMs: 800 }))) await type('\x1b')
  check('boot screen (fullscreen): text draft parked during boot survives Esc after ready', await settled(() => seventh.draft() === 'keep me' && screen().includes('keep me'), { timeoutMs: 2000 }), `${JSON.stringify(seventh.draft())}\n${screen()}`)
  seventh.dispose()
  takePrebootSlot()
}

// /exit during boot is a deliberate exit like the double Ctrl+C: 0, boot
// screen torn down.
{
  exitCode = undefined
  const exiting = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
  await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
  // /lang would lose its settings-layer mirror (the boot channel has no
  // settings host), so it waits for the session like any other command.
  await type('/lang en ')
  await type('\r')
  await sleep(100) // 固定窗:探针 断言 /lang 不执行、文字留在输入框
  check('boot cmd: /lang refused, draft kept', exiting.draft() === '/lang en ' && exitCode === undefined, JSON.stringify(exiting.draft()))
  for (let i = 0; i < '/lang en '.length; i++) await type('\x7f')
  await settled(() => exiting.draft() === '', { timeoutMs: 2000 })
  await type('/exit')
  await type('\r')
  check('boot cmd: /exit during boot exits 0', await settled(() => exitCode === 0, { timeoutMs: 2000 }), `${String(exitCode)}\n${screen()}`)
  check('boot cmd: /exit tears the boot screen down', exiting.phase === 'disposed', exiting.phase)
  takePrebootSlot()
}

terminal.dispose()
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
process.exit(0)
