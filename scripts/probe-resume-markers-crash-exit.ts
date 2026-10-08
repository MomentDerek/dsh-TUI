/**
 * P0-1 probe, now a regression sentinel (docs/standalone-host-design.md,
 * "Phase 1 遗留"): the exit funnel's crash tail must reach the DSH registry on
 * a root that may not carry it — without throwing, and without losing the
 * last-run record.
 *
 * The claim it was written against: the crash branch's `writeResumeMarkers`
 * called `ctx.agents.get(...)` unconditionally, and the standalone entry's
 * Claude kernel hangs the runtime on a bare root without `agents` — so a crash
 * there threw a second time inside the crash tail and (allegedly) swallowed the
 * original crash line or disturbed the terminal restore. The fix made that
 * lookup `ctx.get('agents')` (the shape liveDshAgent() uses), so a missing
 * service reads as undefined. Cases 2 and 3 pin the post-fix behaviour: the
 * registry lookup is still observable, and its absence costs nothing.
 *
 * No implementation is changed here: this drives the REAL createExitFunnel,
 * the REAL runCrashExit and the REAL writeCrashResumeMarkers, and records
 * every way the crash tail reaches the registry (a Proxy traces both the
 * `agents` property band and the `ctx.get('agents')` service lookup). Every
 * case prints one `CASE <name>: <verdict>` line plus its decisive facts.
 *
 * Run: node --import tsx/esm scripts/probe-resume-markers-crash-exit.ts
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createExitFunnel, runCrashExit, writeCrashResumeMarkers } from '../src/dsh-adapter/plugin.js'

let failures = 0
const lines: string[] = []
const say = (line: string): void => { lines.push(line) }
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failures += 1
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  [${JSON.stringify(detail)}]`}`)
}

/**
 * Records every way the crash tail reaches the registry on the context handed
 * to it: the property band (`ctx.agents`) AND the service lookup
 * (`ctx.get('agents')`, the shape liveDshAgent() and the crash tail use now).
 * Only trapping the property band silently loses the lookup — the one the
 * implementation actually performs.
 */
const traced = (ctx: object, reads: string[]): Context => new Proxy(ctx, {
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver)
    if (key === 'agents') {
      reads.push('agents')
      return value
    }
    if (key !== 'get' || typeof value !== 'function') return value
    return (name: unknown, ...rest: unknown[]) => {
      reads.push(`get(${String(name)})`)
      return (value as (this: object, ...args: unknown[]) => unknown).call(target, name, ...rest)
    }
  },
}) as Context

/** Did the crash tail reach the registry at all, by either shape? */
const lookedUpAgents = (reads: readonly string[]): boolean =>
  reads.some(read => read === 'agents' || read === 'get(agents)')

type MarkerDeps = Parameters<typeof writeCrashResumeMarkers>[0]

interface Record_ {
  readonly reads: string[]
  readonly dshTargets: string[]
  readonly backendLast: string[]
  lastRunRefreshes: number
  readonly finish: string[]
  readonly logs: string[]
  accepted: boolean
  escaped: unknown
  markerError: string | undefined
}

/**
 * Drive one crash through the real funnel around the real marker write.
 * `backendStart` is given exactly as the wiring computes it: undefined on the
 * DSH kernel, the backend's startup handle on Claude/Codex.
 */
const crashThrough = (
  ctx: object,
  deps: Omit<MarkerDeps, 'ctx' | 'writeResumeTarget' | 'refreshLastRunRecord'>,
): Record_ => {
  const record: Record_ = {
    reads: [], dshTargets: [], backendLast: [], lastRunRefreshes: 0,
    finish: [], logs: [], accepted: false, escaped: undefined, markerError: undefined,
  }
  const funnel = createExitFunnel({
    onUserExit: error => {
      runCrashExit({
        error,
        logError: message => { record.logs.push(message) },
        appendLog: () => undefined,
        logRestart: () => undefined,
        logDebug: () => undefined,
        writeResumeMarkers: () => {
          writeCrashResumeMarkers({
            ...deps,
            ctx: traced(ctx, record.reads),
            writeResumeTarget: id => { record.dshTargets.push(String(id)) },
            refreshLastRunRecord: () => { record.lastRunRefreshes += 1 },
          })
        },
        finish: line => { record.finish.push(line) },
      })
    },
  })
  try {
    record.accepted = funnel.handleExit(new Error('render boom'))
  } catch (error) {
    record.escaped = error
  }
  return record
}

/** The marker write on its own, with the error text the crash tail swallows. */
const markerErrorOf = (
  ctx: object,
  deps: Omit<MarkerDeps, 'ctx' | 'writeResumeTarget' | 'refreshLastRunRecord'>,
): string | undefined => {
  try {
    writeCrashResumeMarkers({
      ...deps,
      ctx: ctx as Context,
      writeResumeTarget: () => undefined,
      refreshLastRunRecord: () => undefined,
    })
    return undefined
  } catch (error) {
    return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)
  }
}

// ── 0. The Cordis service-access semantics this probe relies on ────────────
const bare = new Context()
let bareAccess = 'value'
let bareValue: unknown
try {
  bareValue = (bare as unknown as { agents?: unknown }).agents
} catch (error) {
  bareAccess = `threw ${(error as Error).constructor.name}`
}
say(`INFO  bare Cordis root: ctx.agents -> ${bareAccess === 'value' ? String(bareValue) : bareAccess}`)
const provided = new Context()
provided.provide('agents' as never, { get: () => ({ tag: 'live-agent' }) } as never)
const providedValue = (provided as unknown as { agents?: { get(id: string): unknown } }).agents
say(`INFO  root with a provided agents service: ctx.agents.get('x') -> ${JSON.stringify(providedValue?.get('x'))}`)
await provided.fiber.dispose()
let disposedAccess = 'value'
try {
  disposedAccess = `value ${String((provided as unknown as { agents?: unknown }).agents)}`
} catch (error) {
  disposedAccess = `threw ${(error as Error).constructor.name}: ${(error as Error).message}`
}
say(`INFO  disposed root (agents had been provided): ctx.agents -> ${disposedAccess}`)

// ── 1. Claude kernel / entry shape: bare root, backendStart present ───────
// host-entry.ts:215 applies the runtime with deferBackendOpen, and plugin.ts
// 715-745 sets `backendStart` from the backend's `prepare` BEFORE the funnel
// exists (1975). This is that shape, exactly.
{
  const claudeCtx = new Context()
  const lastSessions: string[] = []
  const record = crashThrough(claudeCtx, {
    backendStart: {
      persisted: (_id: string, rows: readonly { readonly kind: string }[]) => rows.some(row => row.kind === 'user'),
      sessionPrefs: { setLastSession: (id: string) => { lastSessions.push(id) } },
    },
    channel: { agentId: 'claude-session-1', pending: [], rows: [{ kind: 'user' }] },
    startupAgent: undefined,
  })
  say(`CASE  claude-entry(no-ctx.agents): reads=${JSON.stringify(record.reads)} lastRun=${record.lastRunRefreshes} backendLast=${lastSessions.length} finish=${record.finish.length}`)
  check('claude-entry: the crash tail never touches the DSH registry', !lookedUpAgents(record.reads), record.reads)
  check('claude-entry: the crash line reaches finish intact',
    record.finish.length === 1 && record.finish[0] === 'dsh-tui crashed: render boom', record.finish)
  check('claude-entry: the backend last-session marker is written', lastSessions.length === 1)
  check('claude-entry: the last-run record is refreshed', record.lastRunRefreshes === 1)
  check('claude-entry: no DSH resume target, nothing escapes the funnel',
    record.dshTargets.length === 0 && record.escaped === undefined && record.accepted)
}

// ── 2. DSH kernel shape: backendStart undefined, agents on the root ───────
{
  const dshCtx = new Context()
  const userMessage = { type: 'user/message', seq: 1, time: 0, data: { source: { kind: 'user' } } }
  dshCtx.provide('agents' as never, { get: () => ({ session: { events: [userMessage] } }) } as never)
  const record = crashThrough(dshCtx, {
    backendStart: undefined,
    channel: { agentId: 'dsh-session-1', pending: [], rows: [] },
    startupAgent: undefined,
  })
  say(`CASE  dsh-kernel(with-ctx.agents): reads=${JSON.stringify(record.reads)} targets=${JSON.stringify(record.dshTargets)} lastRun=${record.lastRunRefreshes} finish=${record.finish.length}`)
  check("dsh-kernel: the crash tail looks the live session up through ctx.get('agents')",
    lookedUpAgents(record.reads), record.reads)
  check('dsh-kernel: the resumable session becomes the resume target',
    record.dshTargets.length === 1 && record.dshTargets[0] === 'dsh-session-1', record.dshTargets)
  check('dsh-kernel: the last-run record is refreshed', record.lastRunRefreshes === 1)
  check('dsh-kernel: the crash line reaches finish intact',
    record.finish.length === 1 && record.finish[0] === 'dsh-tui crashed: render boom', record.finish)
}

// ── 3. Regression sentinel: bare root AND backendStart undefined ─────────
// (Not the Claude path's shape — that is case 1.) This is the window the
// P0-1 claim named: the crash tail asks for `agents` on a root that never
// provided it. The lookup is now `ctx.get('agents')` — the shape
// liveDshAgent() uses — so a missing service reads as undefined instead of
// throwing, and the marker write completes without costing anything.
{
  const bareRoot = new Context()
  const markerDeps = {
    backendStart: undefined,
    channel: { agentId: 'claude-session-1', pending: [], rows: [{ kind: 'user' }] },
    startupAgent: undefined,
  } as const
  const markerError = markerErrorOf(bareRoot, markerDeps)
  const record = crashThrough(bareRoot, markerDeps)
  say(`CASE  bare-root+backendStart-undefined: markerError=${markerError ?? 'none'} reads=${JSON.stringify(record.reads)} lastRun=${record.lastRunRefreshes} finish=${JSON.stringify(record.finish)} escaped=${record.escaped === undefined ? 'none' : 'yes'}`)
  check('bare+undefined: the marker write no longer throws on a root without agents', markerError === undefined, markerError)
  check('bare+undefined: no throw means the crash line still reaches finish intact',
    record.finish.length === 1 && record.finish[0] === 'dsh-tui crashed: render boom', record.finish)
  check('bare+undefined: no error escapes the funnel (the terminal cleanup is not skipped)',
    record.escaped === undefined && record.accepted)
  check('bare+undefined: the missing service no longer costs the last-run record', record.lastRunRefreshes === 1,
    record.lastRunRefreshes)
}

// ── 4. Tomographic case: the root is disposed when the crash arrives ─────
{
  const disposed = new Context()
  disposed.provide('agents' as never, { get: () => undefined } as never)
  await disposed.fiber.dispose()
  const deps = {
    // A DSH-kernel crash during teardown: backendStart is undefined and the
    // service it looks up is already gone.
    backendStart: undefined,
    channel: { agentId: 'dsh-session-1', pending: [], rows: [] },
    startupAgent: undefined,
  } as const
  const markerError = markerErrorOf(disposed, deps)
  const record = crashThrough(disposed, deps)
  say(`CASE  disposed-root: markerError=${markerError ?? 'none'} lastRun=${record.lastRunRefreshes} finish=${record.finish.length}`)
  check('disposed root: the crash tail is unaffected by the service being gone',
    record.finish.length === 1 && record.escaped === undefined)
}

// ── 5. Static structure: where the funnel is created vs where the kernel
//       (and therefore backendStart) is settled ─────────────────────────
{
  const plugin = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const lineOf = (needle: string): number => plugin.split('\n').findIndex(line => line.includes(needle)) + 1
  const assignments = plugin.split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(entry => /^\s*backendStart = /.test(entry.line))
  const funnelLine = lineOf('const funnel = createExitFunnel({')
  const entry = readFileSync(new URL('../src/dsh-adapter/host-entry.ts', import.meta.url), 'utf8')
  say(`INFO  plugin.ts: backendStart assigned at line(s) ${assignments.map(a => a.number).join(', ')}; funnel created at line ${funnelLine}`)
  check('structure: every backendStart assignment precedes the funnel',
    assignments.length > 0 && assignments.every(a => a.number < funnelLine), assignments.map(a => a.number))
  check('structure: the entry defers the backend open (so backendStart is settled before the funnel)',
    entry.includes('deferBackendOpen: true'))
}

// ── 6. The REAL root shapes (approximation, not end-to-end) ──────────────
// host-entry.ts builds the runtime's context exactly like this: `root.ctx`
// from prepareHostRoot, or a bare `new Context()` when there is no usable
// installed dsh. Prepared here for both kernels; the profile is NOT composed
// (that is entry step 3), so this observes the root the runtime mounts on.
// Skipped (SKIP, never a failure) when the machine has no installed dsh or
// no `dsh-tui` profile.
{
  const skip = (why: string): void => { say(`CASE  real-roots: SKIP (${why})`) }
  try {
    const { loadHostDsh, prepareHostRoot } = await import('../src/dsh-adapter/host-dsh.js')
    const host = await loadHostDsh()
    const probeRoot = async (dsh: boolean): Promise<string> => {
      const root = await prepareHostRoot(host, { profile: 'dsh-tui', args: [], dsh })
      let seen = 'value'
      try {
        const value = (root.ctx as unknown as { agents?: unknown }).agents
        seen = value === undefined ? 'undefined' : typeof value
      } catch (error) {
        seen = `threw ${(error as Error).constructor.name}`
      }
      await root.ctx.fiber.dispose().catch(() => undefined)
      return seen
    }
    const claudeRoot = await probeRoot(false)
    say(`CASE  real-roots: prepareHostRoot(claude kernel).ctx.agents -> ${claudeRoot}`)
    check('real roots: the Claude kernel root carries no agents service (what the crash tail would read)',
      claudeRoot === 'undefined', claudeRoot)
    const dshRoot = await probeRoot(true)
    say(`CASE  real-roots: prepareHostRoot(dsh kernel, BEFORE compose).ctx.agents -> ${dshRoot}`)
    check('real roots: the DSH root has no agents either until the profile composes (entry step 3)',
      dshRoot === 'undefined', dshRoot)
    // Opt-in: compose the real profile and read the same property again. The
    // window the hypothesis needs is "funnel exists, agents does not" — this
    // shows the two ends of it on a real root.
    if (process.env.PROBE_RESUME_MARKERS_COMPOSE === '1') {
      const root = await prepareHostRoot(host, { profile: 'dsh-tui', args: [], dsh: true })
      const readAgents = (): string => {
        try {
          const value = (root.ctx as unknown as { agents?: unknown }).agents
          return value === undefined ? 'undefined' : typeof value
        } catch (error) {
          return `threw ${(error as Error).constructor.name}`
        }
      }
      const before = readAgents()
      let composed = 'composed'
      try {
        await Promise.race([
          root.compose(() => undefined),
          new Promise((_resolve, reject) => { setTimeout(() => { reject(new Error('compose timeout 30s')) }, 30_000).unref() }),
        ])
      } catch (error) {
        composed = error instanceof Error ? `failed: ${error.message.split('\n')[0]}` : String(error)
      }
      say(`CASE  real-compose: ctx.agents before compose -> ${before}; after (${composed}) -> ${readAgents()}`)
      await root.ctx.fiber.dispose().catch(() => undefined)
    }
  } catch (error) {
    skip(error instanceof Error ? `${error.constructor.name}: ${error.message.split('\n')[0]}` : String(error))
  }
}

// ── 7. The lookup primitive the fix adopted: ctx.get('agents') when gone ──
// `liveDshAgent()` (plugin.ts:1029) and the crash tail (plugin.ts:3019) both
// read the service this way now, so a root that never provided it is a plain
// undefined instead of a throw.
{
  const readService = (ctx: Context): string => {
    try {
      return String((ctx as unknown as { get(name: string): unknown }).get('agents'))
    } catch (error) {
      return `threw ${(error as Error).constructor.name}: ${(error as Error).message}`
    }
  }
  const noAgents = new Context()
  say(`INFO  ctx.get('agents') on a bare root -> ${readService(noAgents)}`)
  check('lookup primitive: ctx.get reads a missing service without throwing',
    readService(noAgents) === 'undefined')
  const disposedProvided = new Context()
  disposedProvided.provide('agents' as never, { get: () => undefined } as never)
  await disposedProvided.fiber.dispose()
  say(`INFO  ctx.get('agents') on a disposed root that had agents -> ${readService(disposedProvided)}`)
}

say('')
console.log(lines.join('\n'))
const info = lines.filter(line => line.startsWith('CASE') || line.startsWith('INFO'))
console.log(`\nprobe-resume-markers-crash-exit: ${failures === 0 ? 'OK' : 'FAILED'} (${info.length} observations, ${failures} failed checks)`)
if (failures > 0) process.exit(1)
