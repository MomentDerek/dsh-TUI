/**
 * Agent Teams on and off at run time (issue #1241, see
 * docs/agent-teams-design.md「开关机制」).
 *
 * The switch is the upstream team bundle itself: `/team on|off` selects or
 * drops its layer through the host plugin manager (the same write
 * `/plugin enable|disable` makes), which persists to the profile and, with
 * `hmr` mounted, applies at once. The team tool plugin installs into every
 * live root Agent and uninstalls on disposal, so the sessions already running
 * follow. What stays here is the one decision that cannot live in a preset —
 * which legacy delegation tools a request carries — and the `/team` command.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { t } from '../i18n.js'
import { resolveDshProfileName } from '../update.js'
import { installedKernelVersion, UPSTREAM_VALIDATED_VERSION } from './contract.js'
import { createPluginManageFlow, type PluginManageFlow, type PluginManageSink } from './plugin-manage.js'
import { pluginManagerOf } from './plugin-manager.js'
import { cell } from './plugins-info.js'
import { TEAM_BUNDLE } from './team-roster.js'

/**
 * The install spec the hints name. The team packages ship in lockstep with
 * DSH and pin their DSH peers exactly, so only the bundle of the running
 * kernel's own version installs into this host (npm `latest` and `next`
 * both name other lines).
 * @param kernel - The installed DSH version; unknown falls back to the validated line.
 * @returns `<bundle>@<version>`.
 */
export function teamBundleSpec(kernel: string | undefined): string {
  return `${TEAM_BUNDLE}@${kernel ?? UPSTREAM_VALIDATED_VERSION}`
}

/** The team's own delegation tool; its presence is what "team on" means to a request. */
const TEAM_SPAWN_TOOL = 'spawn_teammate'

/**
 * Legacy delegation tools that `spawn_teammate` replaces. The four control
 * tools the team shares names with (`send_message`, `list_agents`,
 * `interrupt_agent`, `wait_agent`) need no entry: the team copies live in the
 * Agent's own scope and shadow the preset's, in the assembly and at execution.
 */
const TEAM_REPLACED_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork'])

/**
 * Keep one delegation tool set per request. Presets keep their legacy rows,
 * so whether the team replaces them is decided where the tools are known: an
 * assembly carrying `spawn_teammate` drops `subagent` / `subagent_fork`. This
 * follows a bundle toggled at run time into the sessions already joined (a
 * preset revision cannot), and a team service that never activated leaves the
 * legacy tools in place. The agent loop diffs these final tools against the
 * logged request header, so the model is told about each swap.
 * @param assembly - Fully assembled prompt inputs for one model request.
 * @returns The original assembly, or a copy without the replaced tools.
 */
export function filterTeamReplacedTools(assembly: PromptAssembly): PromptAssembly {
  if (!assembly.tools.some(tool => tool.name === TEAM_SPAWN_TOOL)) return assembly
  if (!assembly.tools.some(tool => TEAM_REPLACED_TOOLS.has(tool.name))) return assembly
  return { ...assembly, tools: assembly.tools.filter(tool => !TEAM_REPLACED_TOOLS.has(tool.name)) }
}

/** What `/team` was asked. */
export type TeamCommand =
  | { readonly kind: 'on' | 'off' | 'status' }
  | { readonly kind: 'unknown'; readonly sub: string }

export function parseTeamArgs(args: string): TeamCommand {
  const sub = args.trim().split(/\s+/)[0] ?? ''
  if (sub === '' || sub === 'status') return { kind: 'status' }
  if (sub === 'on' || sub === 'off') return { kind: sub }
  return { kind: 'unknown', sub }
}

/** What the screen supplies: the plugin flow's sink, plus the team's live state. */
export interface TeamCommandSink extends PluginManageSink {
  /** Teammates of the bound session, and how many are running or provisioning. */
  readonly members: () => { readonly total: number; readonly active: number }
}

/** What one `/team` input turned into. */
export type TeamCommandOutcome =
  | { readonly kind: 'flow'; readonly flow: PluginManageFlow }
  | { readonly kind: 'lines'; readonly lines: Promise<readonly string[]> }

/**
 * Wire `/team` to the running composition.
 * @param ctx - Host context of the composition root.
 * @param options - The profile a manual route names.
 * @returns the command entry the screen calls.
 */
export function createTeamCommandEntry(
  ctx: Context,
  options: { readonly profileName?: string | undefined } = {},
): (args: string, sink: TeamCommandSink) => TeamCommandOutcome {
  const profile = (): string => options.profileName ?? resolveDshProfileName() ?? 'dsh-tui'
  return (args, sink) => {
    const parsed = parseTeamArgs(args)
    if (parsed.kind === 'unknown') {
      return { kind: 'lines', lines: Promise.resolve([t('team-cmd-usage', { sub: cell(parsed.sub) })]) }
    }
    const manager = pluginManagerOf(ctx)
    if (parsed.kind === 'status') return { kind: 'lines', lines: teamStatusLines(ctx, sink, profile()) }
    if (manager === undefined) {
      return { kind: 'lines', lines: Promise.resolve([t('team-cmd-no-manager', { profile: cell(profile()), bundle: teamBundleSpec(installedKernelVersion()) })]) }
    }
    const flow = createPluginManageFlow({
      manager,
      action: parsed.kind === 'on' ? 'enable' : 'disable',
      target: TEAM_BUNDLE,
      binding: sink.binding,
      busy: sink.busy,
      onLines: sink.onLines,
      profileName: profile(),
      teamActiveMembers: () => sink.members().active,
    })
    if (parsed.kind === 'off') return { kind: 'flow', flow }
    // `on` without the package: the lifecycle flow would answer with its
    // generic "no such target" and every addressable name. Say what is
    // missing and how to install it instead; installing stays an explicit
    // `/plugin install` (it runs third-party code behind its own trust step).
    const bindingAtStart = sink.binding()
    return {
      kind: 'flow',
      flow: {
        ...flow,
        async begin() {
          let installed = true
          let enabled = false
          try {
            const bundle = (await manager.listBundles()).find(candidate => candidate.name === TEAM_BUNDLE)
            installed = bundle !== undefined
            enabled = bundle?.enabled === true
          } catch {
            // A failing read is the flow's to report: it reads the same list.
          }
          // Already selected: no trust question about code already running,
          // no no-op write. Say whether it is actually running.
          if (installed && !enabled) return flow.begin()
          if (sink.binding() === bindingAtStart) {
            sink.onLines(!installed
              ? [t('team-cmd-not-installed', { profile: cell(profile()), bundle: teamBundleSpec(installedKernelVersion()) })]
              : [t('team-cmd-already-on'), ...ctx.get('agentTeams', false) === undefined ? [t('team-cmd-pending-on')] : []])
          }
          return { kind: 'done' }
        },
      },
    }
  }
}

/**
 * `/team` and `/team status`: whether the profile selects the bundle, whether
 * the team service is running in this process, and the bound session's team.
 */
async function teamStatusLines(ctx: Context, sink: TeamCommandSink, profile: string): Promise<readonly string[]> {
  const manager = pluginManagerOf(ctx)
  const service = ctx.get('agentTeams', false) !== undefined
  const lines: string[] = []
  if (manager === undefined) {
    lines.push(t('team-cmd-service', { state: t(service ? 'team-cmd-running' : 'team-cmd-stopped') }))
    lines.push(t('team-cmd-no-manager', { profile: cell(profile), bundle: teamBundleSpec(installedKernelVersion()) }))
  } else {
    let selected: boolean | undefined
    let installed = false
    try {
      const bundle = (await manager.listBundles()).find(candidate => candidate.name === TEAM_BUNDLE)
      installed = bundle !== undefined
      selected = bundle?.enabled
    } catch (error) {
      lines.push(t('plugins-service-error', { err: cell(error instanceof Error ? error.message : String(error)) }))
    }
    if (selected !== undefined || installed) {
      lines.push(t('team-cmd-bundle', { state: t(selected === true ? 'team-cmd-on' : 'team-cmd-off') }))
    } else if (lines.length === 0) {
      lines.push(t('team-cmd-not-installed', { profile: cell(profile), bundle: teamBundleSpec(installedKernelVersion()) }))
    }
    lines.push(t('team-cmd-service', { state: t(service ? 'team-cmd-running' : 'team-cmd-stopped') }))
    // The profile says on but nothing runs (a startup-only profile, or the
    // service failed to activate), or the reverse: say which one wins now.
    if (selected === true && !service) lines.push(t('team-cmd-pending-on'))
    if (selected === false && service) lines.push(t('team-cmd-pending-off'))
  }
  const { total, active } = sink.members()
  lines.push(total === 0 ? t('team-cmd-no-members') : t('team-cmd-members', { total: String(total), active: String(active) }))
  return lines
}
