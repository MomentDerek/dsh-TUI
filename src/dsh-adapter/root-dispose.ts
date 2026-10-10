/**
 * Disposing the entry's root (./plugin.ts `disposeRootAndThen`, ./host-entry.ts)
 * while the profile may still be composing into it. @deepseek-ai/dsh-hmr
 * deadlocks when its fiber is disposed while its init is still starting config
 * watchers, so a root dispose first lets the Loader settle, and the composition
 * skips its audit and readiness once a dispose is waiting.
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
