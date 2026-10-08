/**
 * A child-process stand-in for the `codex` executable, for the acceptance
 * that runs this package's entry with `DSH_TUI_BACKEND=codex`
 * (docs/standalone-host-design.md, the "Codex 内核与入口" open item). It
 * answers `--version` the way the real CLI does and speaks the app-server's
 * newline-delimited JSON-RPC over stdio, driven by the in-process fake
 * (scripts/lib/codex-fake-app-server.ts) — so `resolveCodexExecutable`, the
 * real transport, hub and session all run unchanged, and only the executable
 * itself is replaced.
 *
 * Only what an open needs is scripted (the same list
 * scripts/lib/codex-session-harness.ts uses for a live session); every other
 * method answers -32601, like an app-server without that capability. Nothing
 * here talks to a model, the network or the user's Codex home.
 *
 * `FAKE_CODEX_LOG` records the argv, every method in each direction, and why
 * the child ended: that is how the case proves the app-server child was
 * spawned, was handshaken with, and was closed on the way out.
 *
 * Run through the `codex` shim `scripts/accept-host-entry.mjs` writes:
 *   <node> <tsx> scripts/fixtures/codex/fake-app-server-child.ts app-server
 */
import { appendFileSync } from 'node:fs'
import { createFakeAppServer, type FakeAppServer } from '../../lib/codex-fake-app-server.js'

type Rec = Record<string, unknown>

/** Inside the validated range (src/backends/codex/contract.ts). */
const VERSION = '0.160.1'
const THREAD = '019a0000-0000-7000-8000-0000000000c0'

const logPath = process.env.FAKE_CODEX_LOG ?? ''
function log(line: string): void {
  if (logPath === '') return
  try { appendFileSync(logPath, `${Date.now()} ${line}\n`) } catch { /* the case's own detail, never fatal */ }
}

/** One `codex --version`-shaped line (`parseCodexVersion`). */
function versionLine(): void {
  log('version')
  process.stdout.write(`codex-cli ${VERSION}\n`)
}

/** A `thread/start`-shaped answer (scripts/lib/codex-session-harness.ts). */
function threadAnswer(cwd: string): Rec {
  return {
    thread: { id: THREAD, cwd, status: { type: 'idle' }, turns: [], name: null, model: 'gpt-fixture', modelProvider: 'relay' },
    cwd,
    model: 'gpt-fixture',
    modelProvider: 'relay',
    approvalPolicy: 'on-request',
    sandbox: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    reasoningEffort: 'low',
  }
}

/** Everything the open path asks for (`openCodexSession`, the auth probe). */
function scriptHandlers(fake: FakeAppServer, cwd: string): void {
  const answer = threadAnswer(cwd)
  for (const method of ['thread/start', 'thread/resume']) fake.on(method, () => answer)
  const answers: Readonly<Record<string, unknown>> = {
    'thread/unsubscribe': {},
    'thread/read': { thread: { id: THREAD, cwd, status: { type: 'idle' }, name: null } },
    'thread/loaded/list': { data: [] },
    'thread/list': { data: [], nextCursor: null },
    'thread/turns/list': { data: [], nextCursor: null },
    'thread/name/set': {},
    'thread/settings/update': {},
    'thread/goal/get': { goal: null },
    'thread/goal/clear': {},
    'model/list': {
      data: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }],
      nextCursor: null,
    },
    'collaborationMode/list': { data: [{ mode: 'default' }, { mode: 'plan' }] },
    'permissionProfile/list': { data: [] },
    'backgroundTerminals/list': { data: [], nextCursor: null },
    'skills/list': { data: [] },
    'mcpServerStatus/list': { data: [] },
    // An empty first-party config: `codexAuthRoute` stays first-party and the
    // status probe sees a credential instead of starting a login.
    'config/read': { config: {} },
    'account/read': { account: { type: 'apiKey' }, requiresOpenaiAuth: false },
    'account/rateLimits/read': {},
    'turn/interrupt': {},
    'gitDiffToRemote': {},
  }
  for (const [method, value] of Object.entries(answers)) fake.on(method, () => value)
}

function main(): void {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    versionLine()
    return
  }
  log(`start ${process.argv.slice(2).join(' ')}`)
  const cwd = process.cwd()
  const fake = createFakeAppServer()
  scriptHandlers(fake, cwd)
  const transport = fake.transportFactory({
    executable: process.execPath,
    args: process.argv.slice(2),
    env: {},
    cwd,
    onLine: line => {
      let method = 'message'
      try {
        const parsed = JSON.parse(line) as Rec
        method = typeof parsed.method === 'string' ? parsed.method : typeof parsed.id === 'number' ? `#${parsed.id}` : 'message'
      } catch { /* recorded as-is */ }
      log(`out ${method}`)
      process.stdout.write(`${line}\n`)
    },
    onStderr: line => log(`our-stderr ${line}`),
    onExit: () => log('fake-transport-exit'),
  })
  // The app-server's own framing: one JSON-RPC message per line.
  let partial = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    partial += chunk
    for (let index = partial.indexOf('\n'); index !== -1; index = partial.indexOf('\n')) {
      const line = partial.slice(0, index).replace(/\r$/u, '')
      partial = partial.slice(index + 1)
      if (line.trim() === '') continue
      let method = 'message'
      try {
        const parsed = JSON.parse(line) as Rec
        method = typeof parsed.method === 'string' ? parsed.method : typeof parsed.id === 'number' ? `#${parsed.id}` : 'message'
      } catch { /* recorded as-is */ }
      log(`in ${method}`)
      transport.write(line)
    }
  })
  // The real app-server exits on stdin EOF (C0 V1); `Transport.close` relies
  // on it. FAKE_CODEX_HOLD_ON_EOF=1 refuses to (a child that outlives its
  // parent's death): a close that is real then escalates to SIGTERM and
  // SIGKILL, while a parent that only dies leaves an EOF and nothing else —
  // which is how the case tells "the pool was closed" from "the pipe ended".
  process.stdin.on('end', () => {
    log('stdin-eof')
    if (process.env.FAKE_CODEX_HOLD_ON_EOF !== '1') { process.exitCode = 0; return }
    log('hold-on-eof')
    setTimeout(() => { log('hold-timeout'); process.exit(0) }, 30_000)
  })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => { log(signal); process.exit(0) })
  }
}

main()
