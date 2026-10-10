/**
 * Disposing the entry's root (./plugin.ts `disposeRootAndThen`, the entry's
 * own fallback in ./host-entry.ts) while the profile may still be composing
 * into it, and the diagnostics for a dispose that does not settle.
 *
 * Why a dispose waits for the composition (a signal during the composition
 * used to stall the root dispose for the full 5s). @deepseek-ai/dsh-hmr
 * 0.2.0-rc.2 deadlocks when its fiber is disposed while its service init is
 * still starting the profile's config watchers: a watcher's initial `add`
 * starts a refresh that waits for application readiness, the watcher setup
 * then fails on the disposed fiber and awaits that refresh, and readiness is
 * only released by a disposer Cordis runs after the init has returned. The
 * fiber never settles, the root dispose waits for it, and the exit takes the
 * 5s fallback. A signal or `/quit` in the first few hundred milliseconds of
 * the composition hits it (dsh's own `runProfile` would too; its 5s
 * shutdown bound hides it). So while the entry composes, a root dispose first
 * lets the Loader settle — every row finishes activating, HMR's included, and
 * its disposers then release each other — and the composition skips its audit
 * and readiness once a dispose is waiting (a ready commit would start HMR's
 * profile refresh on a tree being torn down). Bounded by the caller's dispose
 * timer, as before.
 *
 * The diagnostics read Cordis internals structurally (`registry.values()`,
 * `runtime.fibers`, `fiber.state` / `inertia` / `entry`): a host that changes
 * them yields an empty list, never a throw.
 */
import type { Context } from '@deepseek-ai/cordis'

/** A composition in progress on a root (./host-entry.ts registers it). */
interface Composition {
  /** Resolves once the Loader has no pending activation (`loader.await()`). */
  readonly settle: () => Promise<unknown>
  /** A root dispose is waiting for this composition. */
  disposing: boolean
}

const compositions = new WeakMap<object, Composition>()

/** The entry's handle on its composition. */
export interface CompositionTracker {
  /** True once a root dispose waits for the composition: stop short of the audit and readiness. */
  readonly disposing: boolean
  /** The composition ended (composed, failed or stopped). */
  done(): void
}

/**
 * Register the composition running on `root` from now on: a root dispose
 * waits for `settle` first ({@link disposeRootSettled}).
 */
export function trackComposition(root: Context, settle: () => Promise<unknown>): CompositionTracker {
  const key = root.root
  const composition: Composition = { settle, disposing: false }
  compositions.set(key, composition)
  return {
    get disposing() { return composition.disposing },
    done() {
      if (compositions.get(key) === composition) compositions.delete(key)
    },
  }
}

/**
 * Dispose the root of `ctx` with `dispose` (default: the root fiber's), once
 * a composition in progress on it has let its Loader settle. Without one this
 * is `dispose()` itself.
 */
export async function disposeRootSettled(ctx: Context, dispose: () => Promise<unknown> = () => ctx.root.fiber.dispose()): Promise<unknown> {
  const composition = compositions.get(ctx.root)
  if (composition !== undefined) {
    composition.disposing = true
    try {
      await composition.settle()
    } catch {
      // A failed activation is the composition's to report; dispose anyway.
    }
  }
  return dispose()
}

/** Cordis fiber state "disposed" (uid cleared, unload done). */
const FIBER_DISPOSED = 4

interface FiberLike {
  readonly name?: unknown
  readonly state?: unknown
  readonly inertia?: unknown
  readonly uid?: unknown
  readonly entry?: { readonly id?: unknown; readonly options?: { readonly name?: unknown } }
  getEffects?(): Array<{ readonly label?: unknown }>
}

export interface PendingFiber {
  readonly name: string
  readonly entry?: string
  readonly state: number
  readonly inertia: boolean
  /** The labels of the effects the fiber still holds. */
  readonly effects?: string[]
}

/** Every fiber the tree has right now (dispose removes them from the registry). */
function listFibers(ctx: Context): FiberLike[] {
  const fibers: FiberLike[] = []
  try {
    fibers.push(ctx.root.fiber as unknown as FiberLike)
    const registry = (ctx.root as unknown as { registry?: { values?(): Iterable<unknown> } }).registry
    for (const runtime of registry?.values?.() ?? []) {
      const list = (runtime as { fibers?: Iterable<unknown> }).fibers
      for (const fiber of list ?? []) fibers.push(fiber as FiberLike)
    }
  } catch {
    // A diagnostic must never affect the dispose.
  }
  return fibers
}

function describe(fiber: FiberLike): PendingFiber {
  let name = 'unknown'
  try {
    name = String(fiber.name)
  } catch {
    // name walks the parents; keep 'unknown'.
  }
  const entryId = fiber.entry?.id
  const entryName = fiber.entry?.options?.name
  let effects: string[] | undefined
  try {
    const labels = fiber.getEffects?.().map(effect => String(effect.label))
    if (labels !== undefined && labels.length > 0) effects = labels.slice(0, 12)
  } catch {
    // keep undefined
  }
  return {
    name,
    ...(entryId === undefined ? {} : { entry: `${String(entryId)}${entryName === undefined ? '' : ` (${String(entryName)})`}` }),
    state: typeof fiber.state === 'number' ? fiber.state : -1,
    inertia: fiber.inertia !== undefined && fiber.inertia !== null,
    ...(effects === undefined ? {} : { effects }),
  }
}

/**
 * Take the tree's fibers now (call right before disposing the root); the
 * returned function lists those that have not finished disposing.
 */
export function watchDisposal(ctx: Context): () => PendingFiber[] {
  const before = new Set(listFibers(ctx))
  return () => {
    const pending: PendingFiber[] = []
    // The fibers the dispose started from, and any that joined the tree since
    // (a composition settling first keeps activating rows).
    for (const fiber of new Set([...before, ...listFibers(ctx)])) {
      try {
        const settled = fiber.inertia === undefined || fiber.inertia === null
        // The root fiber restarts instead of disposing: settled is enough.
        if (settled && (fiber.state === FIBER_DISPOSED || fiber.uid === 0)) continue
        const described = describe(fiber)
        pending.push(before.has(fiber) ? described : { ...described, name: `${described.name} (new)` })
      } catch {
        // A diagnostic must never affect the exit.
      }
    }
    return pending.slice(0, 40)
  }
}

/** What keeps the event loop busy, counted by kind (`process.getActiveResourcesInfo`). */
export function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {}
  try {
    for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1
  } catch {
    // diagnostics only
  }
  return counts
}
