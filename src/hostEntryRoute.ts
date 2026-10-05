/**
 * Which process hosts a launch (docs/standalone-host-design.md 5.8): the
 * Claude kernel runs in this package's own entry
 * (`lib/types/dsh-adapter/host-entry.js`) without composing a DSH profile;
 * the DSH kernel keeps running inside `dsh --profile <profile>`.
 *
 * The launcher (bin/dsh-tui.js, which must not import lib/) repeats the
 * cheap half of this decision inline; the entry decides again here with the
 * profile patch's Config row as well, because only the entry can afford to
 * read it, and hands a DSH-pinned launch on to dsh.
 */
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { KERNEL_SWITCH_HANDOFF_ENV, isKernelId, readKernelPrefs, resolveRememberedBackend, type KernelBackendId } from './kernelPrefs.js'
import { profilePatchPath, readProfileTuiSettings } from './tuiSettingsFile.js'

export { HOST_ENTRY_ENV, HOST_ENTRY_PATH_ENV, hostEntryDisabled } from './kernelPrefs.js'

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
  const value = readProfileTuiSettings(patchFile, ['backend'])?.backend
  if (typeof value !== 'string') return undefined
  const id = value.trim().toLowerCase()
  return isKernelId(id) ? id : undefined
}

/** The kernel this launch boots on, by the same ranking as the plugin
 *  (handoff → Config row → DSH_TUI_BACKEND → kernel.json → dsh). */
export function entryKernel(env: NodeJS.ProcessEnv = process.env, input: {
  readonly configured?: KernelBackendId
  readonly memoryFile?: string
} = {}): KernelBackendId {
  const handoff = env[KERNEL_SWITCH_HANDOFF_ENV]?.trim().toLowerCase()
  return resolveRememberedBackend({
    ...(isKernelId(handoff) ? { handoff } : {}),
    ...(input.configured === undefined ? {} : { configured: input.configured }),
    envRaw: env.DSH_TUI_BACKEND,
    memory: readKernelPrefs(input.memoryFile).backend,
  })
}

/** The entry's path inside an installed package (from this module's dir). */
export function hostEntryPath(packageRoot: string): string {
  return join(packageRoot, 'lib', 'types', 'dsh-adapter', 'host-entry.js')
}
