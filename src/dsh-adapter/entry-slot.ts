/**
 * The hand-off between this package's entry and the profile's `dsh-tui` row
 * in one Cordis root (docs/standalone-host-design.md 3, 5.4): the entry mounts
 * the screen and publishes the slot, and the row then runs only the DSH side
 * through `attachDsh`. Without a slot the row takes its usual path. On
 * `globalThis` + `Symbol.for` so a row loaded from another copy of this
 * package still meets the entry. Dependency-free, so the row reads it cheaply.
 */

/** What the row does in the entry's place. Hooks are filled by the entry's runtime. */
export interface EntrySlot {
  /** Set by the row as soon as it applies, so the entry can tell whether a
   *  `dsh-tui` row exists once the composition settled. */
  rowSeen: boolean
  /** The DSH side. The row calls it once, after the Loader settled; it never
   *  throws (a failure lands in the mounted screen). */
  attachDsh?: (ctx: unknown, runtimeConfig: unknown, configOwner: unknown) => Promise<void>
  /** A host warning while the profile composes (never to the terminal). */
  composeWarning?: (line: string) => void
  /** The composition failed or had no `dsh-tui` row: the startup session will
   *  never come. `logPath` is the saved startup report, if any. */
  composeFailed?: (error: unknown, logPath?: string) => void
  /** The composition settled with a `dsh-tui` row: a startup open that failed
   *  meanwhile is that open's failure, not the composition's. */
  composeSucceeded?: () => void
  /** Resolves once the screen's first frame reached the terminal; awaited
   *  before the composition's synchronous stretch. */
  firstFrameFlushed?: () => Promise<void>
}

/**
 * The same hand-off for kernels with no `dsh-tui` row (Claude, Codex: the
 * entry composes the light profile itself, design 5.7). Passed in through
 * `RuntimeApplyOptions.composeSeam`, so no global symbol. Filled by the runtime.
 */
export interface HostComposeSeam {
  /** As {@link EntrySlot.firstFrameFlushed}. */
  firstFrameFlushed?: () => Promise<void>
  /**
   * The light composition settled and was audited: the runtime re-reads what
   * it resolved at mount time (runtime themes, the `/settings` section) and
   * re-renders once. Never called on a failed composition.
   */
  composeSucceeded?: () => void
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
