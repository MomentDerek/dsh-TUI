/**
 * This package's own entry (docs/standalone-host-design.md, Phase 1): the
 * Claude kernel without a DSH profile. The launcher starts it as
 * `node lib/types/dsh-adapter/host-entry.js <app args>` instead of
 * `dsh --profile <profile> -- <app args>` when the kernel resolves to Claude
 * (bin/dsh-tui.js; `DSH_TUI_HOST_ENTRY=0` switches that off).
 *
 * It decides the kernel again with the profile patch's Config row
 * (../hostEntryRoute.ts). A launch that lands on DSH after all (a pinned
 * row, a `/kernel` switch relaunching through this file) is handed to
 * `dsh --profile <profile>` unchanged: env, stdio and the kernel-switch ACK
 * pipe (fd 3) pass through, and this process only forwards the exit.
 *
 * On Claude it mounts the TUI runtime (./plugin.ts) on a bare Cordis root:
 * the dsh-tui Config row is rebuilt from the environment the way
 * cordis.patch.yml's row reads it, the TUI's settings come from
 * ~/.dsh-tui/settings.json, and the screen mounts before the backend
 * session has opened (`deferBackendOpen`). Signals dispose the root (the
 * exit funnel restores the terminal) before the process exits.
 */
import '../force-production-react.js'
import { spawn } from 'node:child_process'
import { markBoot } from '../utils/bootTrace.js'
import { configuredBackend, entryKernel, hostProfile } from '../hostEntryRoute.js'
import { HANDOFF_ACK_FD_ENV } from '../handoffAck.js'
import type { Config as TuiConfig } from './index.js'

markBoot('entry-start')
const profile = hostProfile()
const kernel = entryKernel(process.env, { configured: configuredBackend(profile) })
if (kernel === 'claude') await runClaude()
else delegateToDsh()

/** Hand the launch to `dsh --profile <profile> -- <app args>` and mirror its exit. */
function delegateToDsh(): void {
  const args = ['--profile', profile, '--', ...process.argv.slice(2)]
  // A kernel-switch replacement carries the ACK pipe on fd 3 (src/handoffAck.ts):
  // the dsh process is the one that adopts the screen, so it gets the pipe.
  const ack = process.env[HANDOFF_ACK_FD_ENV] === '3'
  const windows = process.platform === 'win32'
  const child = spawn('dsh', windows ? args.map(quoteForCmd) : args, {
    stdio: ack ? ['inherit', 'inherit', 'inherit', 3] : 'inherit',
    env: process.env,
    ...(windows ? { shell: true } : {}),
  })
  // The terminal's own signals reach dsh through the process group; one sent
  // to this pid alone is passed on.
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => { child.kill(signal) })
  }
  process.on('SIGINT', () => undefined)
  child.on('error', error => {
    process.stderr.write(`dsh-tui: cannot start dsh (${error.message})\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

/** cmd.exe joins arguments with spaces and does not escape (bin/dsh-tui.js shellQuote). */
function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"^]/u.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

async function runClaude(): Promise<void> {
  const [{ Context }, { Config }, { apply, handleStartupError }] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('./index.js'),
    import('./plugin.js'),
  ])
  markBoot('entry-modules')
  const ctx = new Context()
  const env = process.env
  // The dsh-tui row of cordis.patch.yml, as a DSH composition would build it
  // from the same environment. The editable fields come from the TUI's own
  // settings document on top (./tui-settings.ts).
  const config = Config({
    provider: 'deepseek-official',
    fullscreen: true,
    terminalImages: true,
    effort: 'max',
    ...(env.DSH_TUI_PRESET === undefined ? {} : { preset: env.DSH_TUI_PRESET }),
    ...(env.DSH_TUI_WORKSPACE_TARGET === undefined ? {} : { workspace: env.DSH_TUI_WORKSPACE_TARGET }),
    ...(env.DSH_TUI_RESUME_SESSION === undefined ? {} : { sessionId: env.DSH_TUI_RESUME_SESSION }),
    ...(env.DSH_TUI_BACKEND === undefined ? {} : { backend: env.DSH_TUI_BACKEND as TuiConfig['backend'] }),
  })
  // Signals: dispose the tree (the TUI's exit funnel restores the terminal
  // and closes the backend session), bounded, then die by the signal itself.
  // A numeric 143/129 reads as a crash to the launcher (the safe-mode
  // prompt); a signal death is passed on.
  // Only this handler comes off: the renderer's own signal cleanup stays and
  // re-raises the signal once it is the last listener.
  let leaving = false
  const handlers = {
    SIGTERM: () => { leave('SIGTERM') },
    SIGHUP: () => { leave('SIGHUP') },
  }
  const leave = (signal: keyof typeof handlers): void => {
    if (leaving) return
    leaving = true
    const die = (): void => {
      process.removeListener(signal, handlers[signal])
      process.kill(process.pid, signal)
    }
    const timer = setTimeout(die, 3000)
    timer.unref()
    void ctx.root.fiber.dispose().finally(die)
  }
  process.on('SIGTERM', handlers.SIGTERM)
  process.on('SIGHUP', handlers.SIGHUP)
  try {
    await apply(ctx, config, ctx, { deferBackendOpen: true, profile })
  } catch (error) {
    handleStartupError(ctx, error)
  }
}
