/**
 * The light profile for non-DSH kernels: this package's layers plus the
 * profile's third-party bundles, composed into the entry's root without
 * `dsh-base`. One root, since a second root's rows stay pending unless every
 * entry service is copied over. Rows guarded by scripts/verify-lite-profile-rows.mjs.
 * Pure data and functions: no `@deepseek-ai/*` import, no I/O.
 */

/** `dsh-base` carries DSH's agent, llm, tools and workspace core rows. */
export const LITE_PROFILE_EXCLUDED_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

/** One row the light composition disables, and the services that make it inert. */
export interface LiteProfileRowDisable {
  /** The Loader entry id (`cordis.patch.yml` `insert` ids, process-global). */
  readonly id: string
  /** Injected services no remaining layer provides, as the Loader reports them. */
  readonly missing: readonly string[]
  /** Where the row comes from. */
  readonly from: string
}

/**
 * Rows trimmed out of a light composition: each injects a service only the
 * excluded bundles provide, so it would sit pending forever and turn "N
 * entries did not activate" into a permanent state instead of a fault.
 */
export const LITE_PROFILE_ROW_DISABLES: readonly LiteProfileRowDisable[] = [
  { id: 'dsh-tui-workspace', missing: ['sessionPersistence'], from: '@deepseek-ai/dsh-workspace, this package\'s patch layer' },
  { id: 'dsh-tui-agent-preset-registry', missing: ['sessionProjections'], from: '@deepseek-ai/dsh-agent-preset-registry, this package\'s patch layer' },
  { id: 'dsh-tui-cordis-host-runner', missing: ['tools'], from: '@deepseek-ai/dsh-cordis-host-runner, this package\'s patch layer' },
  { id: 'dsh-tui-auth', missing: ['llm', 'commands'], from: '@deepseek-harness-tui/dsh-tui/oauth, this package\'s patch layer' },
  { id: 'dsh-tui', missing: ['agents', 'workspaceRegistry'], from: '@deepseek-harness-tui/dsh-tui, this package\'s patch layer: the DSH front door, which the entry itself replaces on these kernels' },
]

/** A disable row in `cordis.patch.yml`'s entry shape; structural, assignable to `PatchOptions`. */
export interface LiteProfileDisableRow {
  readonly id: string
  readonly disabled: true
}

/** The least a profile layer must expose for the trim (an app-boot `ProfileLayer`). */
export interface LiteProfileLayer {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  readonly packageName: string
}

/** What a composition needs to mount a light profile. */
export interface LiteProfilePlan<Layer extends LiteProfileLayer = LiteProfileLayer> {
  readonly bundles: readonly string[]
  readonly layers: readonly Layer[]
  /** The excluded bundles that were present and therefore left out. */
  readonly excluded: readonly string[]
  /** The bundles this plan leaves out (the request, present or not). */
  readonly excludedBundles: readonly string[]
  readonly rowDisables: readonly LiteProfileRowDisable[]
  /** Appended after the profile's own patch layers. */
  readonly disableRows: readonly LiteProfileDisableRow[]
  /** Whether a loaded layer was left out; false lets the caller reuse the full composition. */
  readonly trimmed: boolean
}

/** The light composition plan for a loaded profile: which layers stay, which rows are disabled. */
export function liteProfilePlan<Layer extends LiteProfileLayer>(
  profile: { readonly layers: readonly Layer[] },
): LiteProfilePlan<Layer> {
  const excludedBundles = LITE_PROFILE_EXCLUDED_BUNDLES
  const excluded = new Set(excludedBundles)
  const layers = profile.layers.filter(layer => !excluded.has(layer.packageName))
  const dropped = profile.layers.filter(layer => excluded.has(layer.packageName))
  const trimmed = dropped.length > 0
  return {
    bundles: layers.map(layer => layer.packageName),
    layers,
    excluded: dropped.map(layer => layer.packageName),
    excludedBundles,
    // With every layer still there, the services exist and the rows work.
    rowDisables: trimmed ? LITE_PROFILE_ROW_DISABLES : [],
    disableRows: trimmed ? LITE_PROFILE_ROW_DISABLES.map(row => ({ id: row.id, disabled: true as const })) : [],
    trimmed,
  }
}

/** One line naming what was left out, for the composition's warning sink. */
export function liteProfileNotice(plan: LiteProfilePlan): string | undefined {
  if (!plan.trimmed) return undefined
  const rows = plan.rowDisables.map(row => row.id)
  return `dsh-tui: light profile: ${plan.excluded.join(', ')} left out of ${plan.bundles.length + plan.excluded.length} bundles; disabled ${rows.length === 0 ? 'no row' : rows.join(', ')} (their injected services come from the excluded bundles)\n`
}
