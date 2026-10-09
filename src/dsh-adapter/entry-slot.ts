/**
 * The hand-off between this package's own entry and the profile's `dsh-tui`
 * row when both run in one Cordis root (docs/standalone-host-design.md,
 * Phase 2 single root; host-entry.ts on the DSH kernel, unless
 * `DSH_TUI_HOST_ENTRY_DSH=0`).
 *
 * The entry mounts the screen first and publishes this slot; then it
 * composes the profile into the same root. The `dsh-tui` row finds the slot
 * and does not render a second screen: it only runs the DSH side (agent,
 * DSH session) through `attachDsh` and hands the session to the mounted
 * channel. Without a slot (`dsh --profile dsh-tui`, `DSH_TUI_HOST_ENTRY=0`,
 * `DSH_TUI_HOST_ENTRY_DSH=0`, an installed dsh the entry cannot use)
 * the row takes its usual path.
 *
 * `globalThis` + `Symbol.for`, as the preload branch did: the entry and the
 * row load this package through one module graph today, but a profile that
 * resolves the row from another copy must still meet the entry here.
 * Dependency-free, so the row module can read it cheaply.
 *
 * {@link HostComposeSeam} is the same hand-off for the kernels that have no
 * row at all (Claude, Codex: the entry composes the light profile itself,
 * ./lite-profile.ts): the entry passes it in, so it needs neither a symbol nor
 * a second reader.
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
   *  startup session will never come. `logPath` is the startup report saved
   *  for it (host-dsh.ts writeStartupReport), when one was written. Filled
   *  by the entry's runtime. */
  composeFailed?: (error: unknown, logPath?: string) => void
  /** The composition settled, audited, with a `dsh-tui` row: a startup
   *  open that failed meanwhile is that open's failure, not the
   *  composition's. Filled by the entry's runtime. */
  composeSucceeded?: () => void
  /** Resolves once the mounted screen's first frame (which says DSH is
   *  starting) has been written to the terminal: the entry awaits it before
   *  the composition's synchronous stretch. Filled by the entry's runtime. */
  firstFrameFlushed?: () => Promise<void>
}

/**
 * The entry's composition seam where there is no {@link EntrySlot}: the entry
 * composes the light profile into the root it mounted the screen on when the
 * kernel is Claude or Codex (docs/standalone-host-design.md 5.7), and those
 * kernels have no `dsh-tui` row to hand the screen over to. Not a global
 * symbol: only one process's entry and runtime are involved, so the entry
 * passes the object in (`RuntimeApplyOptions.composeSeam`) and the runtime
 * fills it — no second process-wide identity, and no ordering problem about
 * who publishes first.
 */
export interface HostComposeSeam {
  /**
   * Resolves once the mounted screen's first frame has been written to the
   * terminal: the entry awaits it before the composition's stretch, exactly as
   * it does through the slot on the DSH kernel. Filled by the runtime.
   */
  firstFrameFlushed?: () => Promise<void>
  /**
   * The light composition settled and was audited: the services it mounted
   * (the `tui*` rows, third-party plugin rows) are up, so everything the
   * mounted screen took as a value at mount time is read again — the runtime
   * re-homes this package's `/settings` section onto the composition's
   * sections service and re-renders once. Without it the screen keeps the
   * values it resolved before the composition existed: a runtime theme
   * registers but is never drawn, and `/settings` shows no `dsh-tui` section
   * on a kernel with no `dsh-tui` row. The DSH kernel has the equivalent
   * through the slot's {@link EntrySlot.composeSucceeded}. Filled by the
   * runtime; the entry calls it after `composeLite` returned (host-entry.ts
   * composeLiteRoot), so it never runs on a failed composition.
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
