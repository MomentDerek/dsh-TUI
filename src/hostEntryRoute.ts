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

/** The kernel this launch boots on, by the same ranking as the plugin
 *  (handoff → Config row → DSH_TUI_BACKEND → kernel.json → dsh). Both halves of
 *  the parse are here, as in the boot (`plugin.ts`): the syntax gate first, then
 *  the registry — an id that is syntactically valid but not installed falls back
 *  to dsh exactly like a typo does (P0 D1), so the entry never mounts the
 *  runtime on a kernel this process cannot load. */
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
  /** Run this kernel in this process. `dsh` composes the profile into the
   *  entry's root afterwards; every other kernel stops after the mount. */
  | { readonly kind: 'entry'; readonly kernel: KernelBackendId }
  /** Hand the launch to `dsh --profile <profile>` unchanged. */
  | { readonly kind: 'delegate' }

/**
 * How the entry routes a launch whose kernel {@link entryKernel} already
 * found. Only the DSH kernel composes the profile into the entry's root, and
 * only while Phase 2's default holds (`DSH_TUI_HOST_ENTRY_DSH=0` hands DSH
 * back to `dsh --profile`). Claude and Codex alike mount the runtime on the
 * entry's own root without a profile, so the runtime resolves the kernel
 * itself — deriving it here again would drop the one input only this process
 * reads (the profile patch's Config row).
 */
export function entryRoute(kernel: KernelBackendId, env: NodeJS.ProcessEnv = process.env): EntryRoute {
  if (kernel !== 'dsh') return { kind: 'entry', kernel }
  return hostEntryDshEnabled(env) ? { kind: 'entry', kernel } : { kind: 'delegate' }
}
