/**
 * The hand-off between this package's own entry and the profile's `dsh-tui`
 * row when both run in one Cordis root (docs/standalone-host-design.md,
 * Phase 2 single root; host-entry.ts with `DSH_TUI_HOST_ENTRY_DSH=1`).
 *
 * The entry mounts the screen first and publishes this slot; then it
 * composes the profile into the same root. The `dsh-tui` row finds the slot
 * and does not render a second screen: it only runs the DSH side (agent,
 * DSH session) through `attachDsh` and hands the session to the mounted
 * channel. Without a slot (`dsh --profile dsh-tui`, `DSH_TUI_HOST_ENTRY=0`)
 * the row takes its usual path.
 *
 * `globalThis` + `Symbol.for`, as the preload branch did: the entry and the
 * row load this package through one module graph today, but a profile that
 * resolves the row from another copy must still meet the entry here.
 * Dependency-free, so the row module can read it cheaply.
 */

/** What the row does in the entry's place. */
export interface EntrySlot {
  /** Set by the row as soon as it applies, so the entry can tell after the
   *  composition settled whether a `dsh-tui` row is there at all. */
  rowSeen: boolean
  /**
   * The DSH side, filled by the entry's runtime once the screen is mounted.
   * The row calls it once, from its own runtime fiber, after the Loader has
   * settled (the row's entry-level inject guarantees the DSH services).
   * It never throws: a failure lands in the mounted screen.
   */
  attachDsh?: (ctx: unknown, runtimeConfig: unknown, configOwner: unknown) => Promise<void>
  /** A host warning while the profile composes (the screen is up: never the
   *  terminal). Filled by the entry's runtime. */
  composeWarning?: (line: string) => void
  /** The composition failed, or settled without a `dsh-tui` row: the
   *  startup session will never come. Filled by the entry's runtime. */
  composeFailed?: (error: unknown) => void
}

export const ENTRY_SLOT_KEY = Symbol.for('@deepseek-harness-tui/dsh-tui:host-entry')

type SlotHost = typeof globalThis & { [ENTRY_SLOT_KEY]?: EntrySlot }

/** Publish the entry's slot (the entry, before it composes the profile). */
export function publishEntrySlot(): EntrySlot {
  const slot: EntrySlot = { rowSeen: false }
  ;(globalThis as SlotHost)[ENTRY_SLOT_KEY] = slot
  return slot
}

/** The published slot, if this process's entry mounted the screen. */
export function peekEntrySlot(): EntrySlot | undefined {
  return (globalThis as SlotHost)[ENTRY_SLOT_KEY]
}

/** Take the DSH-side hook once: a second row (or a recompose) finds none. */
export function takeEntryAttach(): EntrySlot['attachDsh'] {
  const slot = peekEntrySlot()
  const attach = slot?.attachDsh
  if (slot !== undefined) slot.attachDsh = undefined
  return attach
}
