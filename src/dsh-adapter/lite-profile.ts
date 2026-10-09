/**
 * The light profile (docs/standalone-host-design.md 5.7; ruling of 2026-10-09:
 * "light profile is required for the Claude and Codex kernels").
 *
 * The gap this closes. The entry owns a bare Cordis root on every kernel
 * (`host-entry.ts` Phase 1), but on the non-DSH kernels nothing composes the
 * profile into it: no row registers the `tui*` services and no third-party
 * plugin row is mounted, so the plugin ecosystem is absent. The DSH kernel
 * closes it with the whole profile (`dsh-base` included, `HostRoot.compose`).
 * The light profile closes it for the other kernels: the layers of this
 * package's own bundle plus the profile's declared third-party bundles, with
 * `dsh-base` — DSH's agent / llm / tools / workspace core rows — left out.
 *
 * Why trim already-loaded layers instead of composing a second root. On the
 * entry root this package's rows and the profile's third-party rows share one
 * context: a plugin row injecting `tuiWorkspaces` … activates there, and one
 * `root.fiber.dispose()` takes everything with it. That shape is what the
 * checked-in probe measures on the real implementation path
 * (`scripts/probe-lite-profile-claude.mjs`: round A mounts a third-party row
 * that injects `tuiPanels`/`tuiThemes`, registers a panel and lands in the
 * composition's effect ledger, then disposes the root once; rounds B–E cover
 * the trim table, the DSH kernel's prepare face, an unresolvable bundle and
 * the real profile's bundle list). One `cordis` and one `react` come with the
 * same shape. A second root is the alternative this module rejects: its rows
 * stay pending unless every entry service is copied over, and its effects need
 * a second dispose point.
 *
 * Two facts drive the trim:
 *
 *  1. the profile's `dsh.profile.bundles` (`$DSH_HOME/profiles/<name>/package.json`)
 *     — which bundles are in the composition at all. This package's rows live
 *     in this package's own `cordis.patch.yml` (`dsh.bundle.patch`), and a
 *     third-party plugin's rows live in its own bundle patch; both arrive with
 *     their layer, so filtering the layers filters the rows;
 *  2. the service surface `dsh-base` provides. Without it, the rows listed in
 *     {@link LITE_PROFILE_ROW_DISABLES} can never activate: their `inject`
 *     names services only `dsh-base` rows supply, so they would sit `pending`
 *     (fiber state 0) and make "N entries did not activate" a permanent state
 *     of the non-DSH kernels instead of a fault. The ids and missing names
 *     below are the measured values, not a guess —
 *     `scripts/probe-lite-profile-claude.mjs` re-derives them from a real
 *     composition (its round B) and fails when this table drifts.
 *
 * Deliberately not done here: no assertion that the registries must live in
 * the Cordis tree. Where the plugin registry belongs is still open against the
 * upstream plugin contract (issue #1247, design 5.7), so the row ids are data
 * in one table, movable without touching the composition.
 *
 * Pure data and pure functions: no `@deepseek-ai/*` import (not even a type),
 * no I/O. `verify:boundary` therefore has nothing to police here.
 */

/**
 * The bundles a light composition leaves out: `dsh-base` carries DSH's agent,
 * llm, tools and workspace core rows, none of which a non-DSH kernel mounts a
 * backend for. Excluding it is what makes the composition "light"; everything
 * else in `dsh.profile.bundles` still comes in.
 */
export const LITE_PROFILE_EXCLUDED_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

/** One row the light composition disables, and the services that make it inert. */
export interface LiteProfileRowDisable {
  /** The Loader entry id (`cordis.patch.yml` `insert` ids, process-global). */
  readonly id: string
  /**
   * The services the row injects that no remaining layer provides, as the
   * Loader reports them (`pending (waiting for services: …)`).
   */
  readonly missing: readonly string[]
  /** Where the row comes from, so a review can check the claim. */
  readonly from: string
}

/**
 * Rows trimmed out of a light composition. Every one of them injects a service
 * the excluded bundles provide, so leaving them in only produces pending
 * entries and audit noise — they can never activate on a kernel with no DSH
 * backend behind it.
 *
 * Not listed here on purpose: the rows that *do* work without `dsh-base`
 * (`dsh-tui-panels`, `dsh-tui-scenes`, `dsh-tui-extensions`,
 * `dsh-tui-plugin-host`, `dsh-tui-workspaces`, `dsh-tui-command-trees`,
 * `dsh-tui-settings-sections`, the scoped storage rows). They are the whole
 * point of the light profile: they register the `tui*` services third-party
 * plugins inject.
 */
export const LITE_PROFILE_ROW_DISABLES: readonly LiteProfileRowDisable[] = [
  { id: 'dsh-tui-workspace', missing: ['sessionPersistence'], from: '@deepseek-ai/dsh-workspace, this package\'s patch layer' },
  { id: 'dsh-tui-agent-preset-registry', missing: ['sessionProjections'], from: '@deepseek-ai/dsh-agent-preset-registry, this package\'s patch layer' },
  { id: 'dsh-tui-cordis-host-runner', missing: ['tools'], from: '@deepseek-ai/dsh-cordis-host-runner, this package\'s patch layer' },
  { id: 'dsh-tui-auth', missing: ['llm', 'commands'], from: '@deepseek-harness-tui/dsh-tui/oauth, this package\'s patch layer' },
  { id: 'dsh-tui', missing: ['agents', 'workspaceRegistry'], from: '@deepseek-harness-tui/dsh-tui, this package\'s patch layer: the DSH front door, which the entry itself replaces on these kernels' },
]

/**
 * A disable row in the patch-entry shape `cordis.patch.yml` already uses
 * (`profile-context.ts` `resolveTelemetryPatch` writes the same shape). Typed
 * structurally rather than as `PatchOptions`: this module imports no vendor
 * type, and the object is assignable where `PatchOptions` is expected.
 */
export interface LiteProfileDisableRow {
  readonly id: string
  readonly disabled: true
}

/** The least a profile layer must expose for the trim (an app-boot `ProfileLayer`). */
export interface LiteProfileLayer {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  readonly packageName: string
}

/** Options for {@link liteProfilePlan}. */
export interface LiteProfileOptions {
  /** Bundles to leave out. Defaults to {@link LITE_PROFILE_EXCLUDED_BUNDLES}. */
  readonly exclude?: readonly string[]
}

/** What a composition needs to mount a light profile. */
export interface LiteProfilePlan<Layer extends LiteProfileLayer = LiteProfileLayer> {
  /** Bundle names actually composed, in profile order. */
  readonly bundles: readonly string[]
  /** The layers to compose, in profile order. */
  readonly layers: readonly Layer[]
  /** The names of `exclude` that were present and therefore left out. */
  readonly excluded: readonly string[]
  /** The bundles this plan leaves out (the request, present or not). */
  readonly excludedBundles: readonly string[]
  /** The rows the composition disables, with why (for the warning sink). */
  readonly rowDisables: readonly LiteProfileRowDisable[]
  /** The disable rows to append after the profile's own patch layers. */
  readonly disableRows: readonly LiteProfileDisableRow[]
  /**
   * Whether this plan actually left a loaded layer out. False means the
   * profile has no layer to trim (a profile without the excluded bundles): the
   * caller can then reuse the full composition instead.
   */
  readonly trimmed: boolean
}

/**
 * The light composition plan for a loaded profile: which layers stay, and
 * which rows must be disabled to match.
 *
 * @param profile - the profile `profile-boot` already loaded (its layers are
 *   the bundle patch layers in `dsh.profile.bundles` order).
 * @param options - `exclude` overrides the default bundle exclusion.
 * @returns the plan; `trimmed: false` when nothing was left out.
 */
export function liteProfilePlan<Layer extends LiteProfileLayer>(
  profile: { readonly layers: readonly Layer[] },
  options: LiteProfileOptions = {},
): LiteProfilePlan<Layer> {
  const excludedBundles = options.exclude ?? LITE_PROFILE_EXCLUDED_BUNDLES
  const excluded = new Set(excludedBundles)
  const layers = profile.layers.filter(layer => !excluded.has(layer.packageName))
  const dropped = profile.layers.filter(layer => excluded.has(layer.packageName))
  const trimmed = dropped.length > 0
  return {
    bundles: layers.map(layer => layer.packageName),
    layers,
    excluded: dropped.map(layer => layer.packageName),
    excludedBundles,
    // Only a real trim needs the rows disabled: on a profile that still has
    // every layer (a DSH composition), the services are there and disabling
    // them would remove working rows.
    rowDisables: trimmed ? LITE_PROFILE_ROW_DISABLES : [],
    disableRows: trimmed ? LITE_PROFILE_ROW_DISABLES.map(row => ({ id: row.id, disabled: true as const })) : [],
    trimmed,
  }
}

/**
 * One line naming what the light composition left out, for the warning sink of
 * a composition that keeps its terminal silent otherwise. Empty when nothing
 * was trimmed.
 */
export function liteProfileNotice(plan: LiteProfilePlan): string | undefined {
  if (!plan.trimmed) return undefined
  const rows = plan.rowDisables.map(row => row.id)
  return `dsh-tui: light profile: ${plan.excluded.join(', ')} left out of ${plan.bundles.length + plan.excluded.length} bundles; disabled ${rows.length === 0 ? 'no row' : rows.join(', ')} (their injected services come from the excluded bundles)\n`
}
