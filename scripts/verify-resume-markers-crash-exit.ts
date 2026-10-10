/**
 * The exit funnel's crash tail (`writeCrashResumeMarkers`) must read the DSH
 * registry as `ctx.get('agents')`: the Claude/Codex kernels mount on a root
 * that may not carry `agents`. Drives the real funnel; a Proxy records both
 * access shapes.
 *
 * Run: node --import tsx/esm scripts/verify-resume-markers-crash-exit.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { createExitFunnel, runCrashExit, writeCrashResumeMarkers } from '../src/dsh-adapter/plugin.js'

let failures = 0
const lines: string[] = []
const say = (line: string): void => { lines.push(line) }
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) failures += 1
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  [${JSON.stringify(detail)}]`}`)
}

/** Records both registry access shapes: `ctx.agents` and `ctx.get('agents')`. */
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

const lookedUpAgents = (reads: readonly string[]): boolean =>
  reads.some(read => read === 'agents' || read === 'get(agents)')

type Deps = Omit<Parameters<typeof writeCrashResumeMarkers>[0], 'ctx' | 'writeResumeTarget' | 'refreshLastRunRecord'>

/**
 * Drive one crash through the real funnel around the real marker write.
 * `backendStart` is undefined on the DSH kernel, the startup handle otherwise.
 */
const crashThrough = (ctx: object, deps: Deps) => {
  const record = {
    reads: [] as string[], dshTargets: [] as string[], lastRunRefreshes: 0,
    finish: [] as string[], accepted: false, escaped: undefined as unknown,
  }
  const funnel = createExitFunnel({
    onUserExit: error => {
      runCrashExit({
        error,
        logError: () => undefined,
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
const markerErrorOf = (ctx: object, deps: Deps): string | undefined => {
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

// ── 1. Claude kernel / entry shape: bare root, backendStart present ───────
// The entry applies the runtime with deferBackendOpen, so `backendStart` is
// settled from the backend's `prepare` before the funnel exists.
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
// The crash tail asks for `agents` on a root that never provided it: the
// lookup must read undefined instead of throwing.
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

say('')
console.log(lines.join('\n'))
const info = lines.filter(line => line.startsWith('CASE') || line.startsWith('INFO'))
console.log(`\nverify-resume-markers-crash-exit: ${failures === 0 ? 'OK' : 'FAILED'} (${info.length} observations, ${failures} failed checks)`)
if (failures > 0) process.exit(1)
