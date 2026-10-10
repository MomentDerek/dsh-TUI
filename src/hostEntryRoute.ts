/**
 * Which process hosts a launch (docs/standalone-host-design.md 5.8): every
 * kernel runs in this package's entry by default, DSH included unless
 * `DSH_TUI_HOST_ENTRY_DSH=0` hands it back to `dsh --profile`. The launcher
 * repeats the cheap half inline; the entry decides again here with the
 * profile patch's Config row, which only it can afford to read.
 */
import { existsSync, readFileSync } from 'node:fs'
import { KERNEL_SWITCH_HANDOFF_ENV, hostEntryDshEnabled, parseBackendId, readKernelPrefs, resolveRememberedBackend, type KernelBackendId } from './kernelPrefs.js'
import { isRegisteredBackend, parseBackendChoice } from './dsh-adapter/backend-registry.js'
import { profilePatchPath, readProfileTuiSettings } from './tuiSettingsFile.js'

export { hostEntryDshEnabled } from './kernelPrefs.js'

/** The profile the launcher would have started (`dsh --profile <name>`). */
export const HOST_PROFILE_ENV = 'DSH_TUI_PROFILE'

/** The profile a launch belongs to. */
export function hostProfile(env: NodeJS.ProcessEnv = process.env): string {
  const name = env[HOST_PROFILE_ENV]?.trim()
  return name === undefined || name === '' ? 'dsh-tui' : name
}

/** The `backend` the profile patch's dsh-tui row pins, if any (the Config
 *  row a DSH composition would read). */
export function configuredBackend(profile: string, patchFile: string = profilePatchPath(profile)): KernelBackendId | undefined {
  // Most patches never mention it: skip the YAML parse then.
  try {
    if (!existsSync(patchFile) || !readFileSync(patchFile, 'utf8').includes('backend')) return undefined
  } catch {
    return undefined
  }
  return parseBackendChoice(readProfileTuiSettings(patchFile, ['backend'])?.backend)
}

/** The kernel this launch boots on, ranked as in the plugin (handoff → Config
 *  row → DSH_TUI_BACKEND → kernel.json → dsh). An id that is not installed
 *  falls back to dsh like a typo, so the entry never mounts an unloadable kernel. */
export function entryKernel(env: NodeJS.ProcessEnv = process.env, input: {
  readonly configured?: KernelBackendId
  readonly memoryFile?: string
} = {}): KernelBackendId {
  const handoff = parseBackendId(env[KERNEL_SWITCH_HANDOFF_ENV])
  const memory = readKernelPrefs(input.memoryFile).backend
  return resolveRememberedBackend({
    ...(handoff === undefined ? {} : { handoff }),
    ...(input.configured === undefined ? {} : { configured: input.configured }),
    envRaw: env.DSH_TUI_BACKEND,
    envKnown: isRegisteredBackend,
    memory: isRegisteredBackend(memory) ? memory : undefined,
  })
}

/** Where the entry sends a launch (docs/standalone-host-design.md 5.8). */
export type EntryRoute =
  /** Run this kernel in this process: DSH composes the profile, the others
   *  the light profile (given a usable installed dsh). */
  | { readonly kind: 'entry'; readonly kernel: KernelBackendId }
  /** Hand the launch to `dsh --profile <profile>` unchanged. */
  | { readonly kind: 'delegate' }

/** How the entry routes the kernel {@link entryKernel} found: only DSH can be delegated. */
export function entryRoute(kernel: KernelBackendId, env: NodeJS.ProcessEnv = process.env): EntryRoute {
  if (kernel !== 'dsh') return { kind: 'entry', kernel }
  return hostEntryDshEnabled(env) ? { kind: 'entry', kernel } : { kind: 'delegate' }
}
