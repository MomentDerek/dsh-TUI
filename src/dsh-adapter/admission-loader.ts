/**
 * v0.15 admission loader: the product-side half of the Component identity
 * path (docs/standalone-host-design.md §2.7 遗留 1).
 *
 * The dsh CLI Loader owns discovery and loading — the profile's boundary
 * statement puts it outside this package ("插件的发现、安装与加载由 dsh CLI
 * 负责，加载时强制不在 dsh-TUI"), so the TUI never imports plugin modules
 * itself. What it does own is the identity step. A third-party row's `apply`
 * runs without any manifest: until someone reads its package-root
 * `dsh-plugin.json` and calls `getHostAdmission()`, that activation has no
 * verified Component identity — panels fall back to the `act<N>` namespace
 * (`./panels.ts` pluginIdFor) and every mediated capability refuses the
 * caller (`requireComponentIdentity`: DecisionEvents, storage.local,
 * commands). Verified with the acceptance fixtures, which had to call
 * admission themselves to exercise the path.
 *
 * This module is that loader, and nothing more: it observes the composition
 * for plugin activations, resolves each entry's package root through the
 * Loader's own entry tree, reads the manifest, and admits the activation
 * through the host-only accessor.
 *
 * The result is the load decision this side owns:
 *
 * - admitted -> the verified identity is bound to the plugin's own Cordis
 *   activation (`bindComponentIdentity` -> `bindCallerEffect`), so it lives
 *   and dies with that fiber;
 * - refused -> no identity. The plugin keeps running — loading belongs to the
 *   dsh CLI, and "rejecting" by unloading the row would rewrite the user's
 *   profile (`cordis-plugin-loader` marks an unloaded entry `disabled` and
 *   writes the tree back) — it simply stays outside every mediated
 *   capability, logged once through the debug channel.
 *
 * Listeners and the retry timer are registered with `ctx.effect` on the
 * caller's row, so the existing teardown (and the exit funnel that drives it)
 * releases them.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { componentIdentityOf } from './component-identity.js'
import { compositionRoot, withHostRootCapability } from './host-access.js'
import { getHostAdmission, type TuiPluginHost } from './plugin-host.js'
import { logForDebugging } from '../utils/debug.js'

/** Retry window for an activation whose admission is not decidable yet: a
 *  required contract only appears on the host descriptor once its source is
 *  live (DecisionEvents needs the channel's dispatch, which on the profile
 *  path exists only after every row applied). Mirrors the acceptance
 *  fixture's own retry loop.
 *
 *  The same bound covers the host-wait path (the row is registered but
 *  `tuiPluginHost` or its admission seam is not up yet): a host that never
 *  arrives (issue #183 — stale patch, host row incompatible) would otherwise
 *  keep `pending` non-empty forever and the flush timer re-arming itself with
 *  no limit. Exhausting it settles the activation as `refused` with a
 *  diagnostic, loud enough to see and bounded enough to stop ticking. */
const RETRY_INTERVAL_MS = 200
const RETRY_ATTEMPTS = 100

/** The Cordis loader entry that owns a fiber (`cordis-plugin-loader`). */
interface LoaderEntryLike {
  readonly options?: { readonly name?: string }
  readonly ctx?: { readonly baseUrl?: string }
  readonly fiber?: { readonly state?: number } | null
}

interface LoaderLike {
  locate?(fiber?: object): string | undefined
  resolve?(id: string): LoaderEntryLike | undefined
  entries?(): Iterable<LoaderEntryLike>
}

interface FiberLike {
  readonly state?: number
  readonly ctx?: Context
}

type ActivationState = 'pending' | 'admitted' | 'skipped' | 'refused'

/**
 * Watch `ctx`'s composition and admit every third-party activation that
 * carries a package-root `dsh-plugin.json`. Returns a release function; the
 * listeners and the retry timer are also bound to `ctx`'s own teardown.
 */
export function armAdmissionLoader(
  ctx: Context,
  options: {
    host?: () => TuiPluginHost | undefined
    /** @internal retry bound; production always uses RETRY_ATTEMPTS. The
     *  regression drives both exhaustion paths down to a few ticks instead of
     *  spending the real 20 s window. */
    retryAttempts?: number
  } = {},
): () => void {
  const root = compositionRoot(ctx)
  const retryAttempts = options.retryAttempts ?? RETRY_ATTEMPTS
  const loader = root.get('loader' as never, false) as LoaderLike | undefined
  if (loader === undefined || typeof loader.locate !== 'function' || typeof loader.resolve !== 'function') {
    logForDebugging('dsh-tui: admission loader not armed — this composition has no cordis loader')
    return () => undefined
  }

  const state = new WeakMap<object, ActivationState>()
  const manifests = new WeakMap<object, string | undefined>()
  const attempts = new WeakMap<object, number>()
  const pending = new Set<object>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const host = options.host ?? ((): TuiPluginHost | undefined => ctx.get('tuiPluginHost', false) as TuiPluginHost | undefined)

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const settle = (fiber: object, next: ActivationState): void => {
    state.set(fiber, next)
    pending.delete(fiber)
  }

  const attempt = (fiber: FiberLike): void => {
    const pluginCtx = fiber.ctx
    // LOADING (1) is the decisive moment, not ACTIVE (2): Cordis emits the
    // transition before the row's callback runs, so admitting here means the
    // plugin already has its identity while its own `apply` registers panels
    // or subscribes (verified: the panel lands under the manifest id instead
    // of the `act<N>` fallback). ACTIVE stays as the catch-up path for rows
    // that activated before this loader was armed.
    if (!Context.is(pluginCtx) || (fiber.state !== 1 && fiber.state !== 2)) {
      settle(fiber, 'skipped')
      return
    }
    // Already admitted (the row called admission itself, or a previous pass
    // of this loader did): the manifest identity is host-owned and single.
    if (componentIdentityOf(pluginCtx) !== undefined) {
      settle(fiber, 'admitted')
      return
    }
    // The manifest lookup is one synchronous walk per activation, cached for
    // the fiber's lifetime (a restart reuses it; the package cannot move).
    if (!manifests.has(fiber)) manifests.set(fiber, manifestPathOf(loader, fiber))
    const resolved = manifests.get(fiber)
    // Not a Community v0.15 component (no manifest at its package root):
    // nothing to admit, and no retry will change that.
    if (resolved === undefined) {
      settle(fiber, 'skipped')
      return
    }
    const live = host()
    const admission = live === undefined ? undefined : getHostAdmission(live)
    if (admission === undefined) {
      const waited = (attempts.get(fiber) ?? 0) + 1
      attempts.set(fiber, waited)
      // The host has not arrived (or exposes no admission seam). Bounded on
      // purpose: an absent host is indistinguishable from a late one, so this
      // waits, then settles and says so instead of re-arming the timer for
      // ever. Nothing is swallowed — the refusal is logged.
      if (waited >= retryAttempts) {
        settle(fiber, 'refused')
        logForDebugging(
          `dsh-tui: admission loader refused a Component after waiting ${waited} ticks for `
          + `tuiPluginHost / its admission seam (host ${live === undefined ? 'missing' : 'without getHostAdmission'})`,
          { manifest: resolved },
        )
      }
      return
    }
    let source: string
    try {
      source = readFileSync(resolved, 'utf8')
    } catch (error) {
      settle(fiber, 'skipped')
      logForDebugging(`dsh-tui: admission loader could not read ${resolved} (${messageOf(error)})`)
      return
    }
    const count = (attempts.get(fiber) ?? 0) + 1
    attempts.set(fiber, count)
    try {
      const identity = admission.admit(pluginCtx, source, { source: resolved })
      settle(fiber, 'admitted')
      logForDebugging('dsh-tui: admission loader admitted a Component', {
        componentId: identity.componentId,
        activationId: identity.activationId,
        manifest: resolved,
      })
    } catch (error) {
      if (count >= retryAttempts) {
        settle(fiber, 'refused')
        logForDebugging(`dsh-tui: admission loader refused a Component after ${count} attempts (${messageOf(error)})`, {
          manifest: resolved,
        })
      }
    }
  }

  const consider = (fiber: unknown): void => {
    if (typeof fiber !== 'object' || fiber === null) return
    const activation = fiber as FiberLike
    if (activation.state !== 1 && activation.state !== 2) return
    const current = state.get(fiber)
    if (current === 'admitted' || current === 'refused') return
    // Synchronous on purpose: the row's own callback runs one microtask after
    // LOADING, so a timer or a promise hop here would let `apply` register its
    // panel before the identity exists (that is exactly the `act<N>`
    // fallback). Retries are the exception — they go through the timer.
    pending.add(fiber)
    attempt(activation)
    if (pending.has(fiber) && timer === undefined) timer = setTimeout(flush, RETRY_INTERVAL_MS)
  }

  const flush = (): void => {
    stopTimer()
    for (const fiber of [...pending]) attempt(fiber as FiberLike)
    if (pending.size > 0) timer = setTimeout(flush, RETRY_INTERVAL_MS)
  }

  // Rows that activated before this loader was armed (the profile path
  // applies plugin rows before the TUI row) come from the entry tree; every
  // later activation arrives through the lifecycle event.
  const seed = (): void => {
    if (typeof loader.entries !== 'function') return
    try {
      for (const entry of loader.entries()) {
        const fiber = entry.fiber
        if (fiber === undefined || fiber === null) continue
        if (fiber.state !== 1 && fiber.state !== 2) continue
        consider(fiber)
      }
    } catch (error) {
      logForDebugging(`dsh-tui: admission loader could not walk the entry tree (${messageOf(error)})`)
    }
  }

  const releaseStatus = ctx.effect(() => {
    const listener = (fiber: unknown): void => {
      if (typeof fiber !== 'object' || fiber === null) return
      const activation = fiber as FiberLike
      // A fiber that leaves the running states loses the identity with its
      // own effects (restart): forget the pass so a re-activation is admitted
      // again.
      if (activation.state === 5 || activation.state === 4 || activation.state === 3) {
        state.delete(fiber)
        pending.delete(fiber)
        attempts.delete(fiber)
        return
      }
      consider(fiber)
    }
    // The composition root, not this row: plugin rows hang off the loader's
    // context, so their lifecycle events never travel through the TUI row.
    // `global` keeps child filters from hiding them (// ./host-access.ts).
    //
    // Registering that subscription is a host-side act: this function runs
    // inside the `dsh-tui` row's activation, where the root capability guard
    // (installed with the first TUI row) refuses `root.events.on` outright —
    // "dsh-tui: root.events.on is unavailable from a plugin activation".
    // The listener and its cleanup are the host's own bookkeeping about which
    // third-party activations exist, not a plugin reaching into the root, so
    // they run in the host capability (same shape as the kernel refresh in
    // ./plugin-host.ts). Both the subscription and its disposer are wrapped:
    // teardown runs from a plugin activation too.
    const disposer = withHostRootCapability(
      () => root.on('internal/status', listener, { global: true }) as unknown,
    )
    return () => {
      if (typeof disposer === 'function') {
        withHostRootCapability(() => (disposer as () => void)())
      }
    }
  })
  const releaseTimer = ctx.effect(() => stopTimer)
  seed()

  return () => {
    stopTimer()
    pending.clear()
    releaseStatus()
    releaseTimer()
  }
}

/** The package-root `dsh-plugin.json` of the entry that owns `fiber`, if any.
 *
 *  Both loader calls are fences: `locate` can return an entry id this loader
 *  cannot look up, and `EntryTree.resolve` **throws** (`cannot resolve entry
 *  <id>`) instead of returning undefined for anything but a plain top-level
 *  id. A real profile nests rows behind group ids separated by `:`
 *  (`include:<group>:<row>`), and `dsh-tui-agent-preset-registry` is exactly
 *  such a child row — so a bare `resolve(entryId)` took the whole process down
 *  from inside the `internal/status` listener. "Not an entry we can inspect"
 *  and "not a Component" are the same answer here: no manifest, skip. Real
 *  admission failures are unaffected — they surface from `admission.admit`
 *  and still settle as `refused` with a diagnostic. */
function manifestPathOf(loader: LoaderLike, fiber: object): string | undefined {
  let entryId: string | undefined
  try {
    entryId = loader.locate?.(fiber)
  } catch {
    return undefined
  }
  if (entryId === undefined) return undefined
  let entry: LoaderEntryLike | undefined
  try {
    entry = loader.resolve?.(entryId)
  } catch {
    return undefined
  }
  const name = entry?.options?.name
  if (typeof name !== 'string' || name === '') return undefined
  const entryFile = resolveEntryFile(name, entry?.ctx?.baseUrl)
  return entryFile === undefined ? undefined : findManifest(entryFile)
}

/** The module file an entry `name` resolves to, following the same rules the
 *  loader's own import uses (file URL, relative to `baseUrl`, bare
 *  specifier relative to the profile). */
function resolveEntryFile(name: string, baseUrl: string | undefined): string | undefined {
  try {
    // Builtin rows (loader groups, timers) have no package directory.
    if (name.startsWith('cordis:')) return undefined
    if (name.startsWith('file:')) return fileURLToPath(name)
    if (isAbsolute(name)) return name
    if (name.startsWith('.')) {
      return baseUrl === undefined || baseUrl === '' ? undefined : fileURLToPath(new URL(name, baseUrl))
    }
    const require = createRequire(requireBase(baseUrl))
    try {
      return require.resolve(`${name}/package.json`)
    } catch {
      // A subpath specifier (`pkg/sub`): fall back to the package root.
      const trimmed = name.replace(/\/[^/]+$/u, '')
      if (trimmed === name || trimmed === '') return undefined
      return require.resolve(`${trimmed}/package.json`)
    }
  } catch {
    return undefined
  }
}

function requireBase(baseUrl: string | undefined): string | URL {
  if (baseUrl === undefined || baseUrl === '') return pathToFileURL(join(process.cwd(), 'index.js'))
  try {
    return baseUrl.startsWith('file:') ? new URL(baseUrl) : pathToFileURL(join(baseUrl, 'index.js'))
  } catch {
    return pathToFileURL(join(process.cwd(), 'index.js'))
  }
}

/** Walk up from the entry module to its package root. The walk stops at the
 *  first `package.json`: a manifest lives at the package root, never deeper,
 *  so DSH's own rows (a `package.json` one level up from their entry) cost
 *  one lookup instead of a climb to the filesystem root. */
function findManifest(from: string): string | undefined {
  let dir = dirname(resolvePath(from))
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(dir, 'dsh-plugin.json')
    if (existsSync(candidate)) return candidate
    if (existsSync(join(dir, 'package.json'))) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
