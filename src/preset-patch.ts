/**
 * Declarative row config for the agent presets dsh-tui registers
 * (`standard`, `ptc`, `minimal`, `cordis`, `liangshen`).
 *
 * Rows inside a preset live in its own realm, out of reach of an id-targeted
 * cordis patch. A profile or bundle row naming this module reaches them
 * instead: `config.config` maps a row id inside the preset to the config that
 * replaces that row's `config` wholesale, the same semantics as a cordis
 * patch. dsh-tui reads these rows from the composed loader tree before it
 * registers presets, so plugin load order does not matter; the row does
 * nothing when it activates. Presets a profile declares itself are its own
 * and are left alone.
 *
 * ```yaml
 * - insert:
 *     - id: my-plugin-standard
 *       name: '@deepseek-harness-tui/dsh-tui/preset-patch'
 *       config:
 *         preset: standard
 *         config:
 *           compaction-basic: { auto: false }
 * ```
 *
 * @module
 */

export const name = 'dsh-tui-preset-patch'

/** Module name a preset-patch row uses. */
export const PRESET_PATCH_MODULE = '@deepseek-harness-tui/dsh-tui/preset-patch'

/** The config of one preset-patch row. */
export interface PresetPatchConfig {
  /** Preset id, e.g. `standard`. */
  preset: string
  /** Row id inside the preset → replacement `config` for that row. */
  config: Record<string, unknown>
}

export function apply(): void {}
