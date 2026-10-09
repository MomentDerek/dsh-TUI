/**
 * The installed DSH host, loaded into this package's own entry
 * (docs/standalone-host-design.md 5.4 and Phase 2 "single root"): the entry's
 * Cordis root is built from the host's own `cordis`, gets the host's module
 * resolution before any TUI module loads, and has a profile composed into it
 * after the screen mounted — the whole profile on the DSH kernel
 * (`HostRoot.compose`), and the light profile on the other kernels
 * (`HostRoot.composeLite`, ./lite-profile.ts: this package's rows plus the
 * profile's third-party bundles, without `dsh-base`). No `runProfile`, no
 * second root.
 *
 * Module identity. Everything comes from the `dsh` on PATH — by realpath, or
 * through the launcher script it is (npm / pnpm shims, Windows `.cmd` /
 * `.ps1`, a volta shim; `findHostDsh`) — never from this package's
 * own dependencies: the host's `cordis` is a nested copy, and the Loader
 * must be the one `dsh-app-boot` itself uses (resolved through app-boot's own
 * `createRequire`). These modules are imported by file URL only. This
 * package depends on them (optional peer + dev, ./host-contract.ts
 * HOST_TYPE_PACKAGES) for their types alone: every `@deepseek-ai/*` import
 * here is `import type` (verify:boundary holds it), and the module list with
 * the exports read from each is ./host-contract.ts HOST_MODULES — the probe
 * below and verify:contract both read it.
 *
 * What is reproduced from the host (@deepseek-ai/dsh 0.2.0-rc.2; keep in step
 * with it: ./host-contract.ts HOST_REPLICAS, fingerprinted by verify:contract
 * in host-replica.snapshot.json). Lines are the upstream function bodies:
 *
 * | here                         | upstream                                         | lines |
 * | ---------------------------- | ------------------------------------------------ | ----- |
 * | `loadLayeredEnv` call        | dsh `bin.js` runCli, before `runProfile`         | 1     |
 * | `prepareHostRoot` step 1–2   | dsh `profile-boot` composeProfile (no overlays)  | ~12   |
 * | `prepareHostRoot` step 4     | dsh-app-boot `boot()` prelude (baseUrl,          | ~12   |
 * |                              | dshHomePath, internal/update, Loader)            |       |
 * | `prepareHostRoot` step 5–7   | dsh `profile-boot` runProfile: proxy, appReady,  | ~40   |
 * |                              | fail-loud, profileContext, launch environment,   |       |
 * |                              | PluginPackages, provideCmdline                   |       |
 * | `createAppReady`             | dsh `profile-boot` createAppReady                | ~20   |
 * | `createProcessShutdown`      | dsh `profile-boot` createProcessShutdown         | ~45   |
 * | `HostRoot.compose`           | dsh-app-boot `boot()` tail (mountRootInclude,    | ~25   |
 * |                              | loader.await, auditStartupEntries, the startup   |       |
 * |                              | log exporter and `StartupError.startup`) +       |       |
 * |                              | runProfile appReady.commit                       |       |
 * | `writeStartupReport`         | dsh `bin.js` reportStartupFailure (file half)    | ~25   |
 *
 * One deviation: `bin.js` saves a report for a `StartupError` only and lets
 * any other startup error crash the process; the entry saves one for every
 * composition failure, because the screen stays up and shows its path.
 *
 * Deviations (./host-contract.ts HOST_DEVIATIONS, ADAPTER.md). Deliberately
 * not reproduced: `runProfile`'s SIGTERM/SIGINT handlers and
 * `createProcessShutdown().interrupt` (the entry owns signals and ends by the
 * signal through the TUI's exit funnel: ./process-exit.ts says why its exit
 * status differs from `interrupt`'s 0 / 130), the terminal half of
 * `reportStartupFailure` (the screen is up: the failure row names the report
 * instead), `--patch` overlays and `--from-default-profile` (the launcher passes
 * neither), and a `DSH_HOME` shim some installs carry in `bin.js` (it is not
 * upstream's; the launcher resolves `DSH_HOME` itself).
 *
 * Never writes to stdout. Before the screen mounts, host warnings go to
 * stderr as `dsh` prints them; the composition runs after the mount and
 * takes the caller's sink.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, join, posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type * as AppBoot from '@deepseek-ai/dsh-app-boot'
import type * as ProfileBoot from '@deepseek-ai/dsh/profile-boot'
import type * as HomePaths from '@deepseek-ai/dsh-home-paths'
import type * as Cmdline from '@deepseek-ai/dsh-cmdline'
import type * as HttpProxy from '@deepseek-ai/dsh-http-proxy'
import type * as LaunchEnvironment from '@deepseek-ai/dsh-launch-environment'
import { HOST_MODULES, HOST_PACKAGE } from './host-contract.js'
import { liteProfileNotice, liteProfilePlan } from './lite-profile.js'
import type { ProcessExitSeam } from './process-exit.js'

/** The diagnostic prefix the host's own boot uses. */
const BIN_NAME = 'dsh'
/** dsh `profile-boot` PROCESS_SHUTDOWN_TIMEOUT_MS (0.2.0-rc.2). */
const PROCESS_SHUTDOWN_TIMEOUT_MS = 5000
/** Cordis fiber state "active" (dsh-app-boot FIBER_ACTIVE). */
const FIBER_ACTIVE = 2

type Warn = (line: string) => void

/**
 * The exports the contract lists for one host module (./host-contract.ts):
 * picking them from the real module type fails the build when the contract
 * names an export the pinned host does not declare.
 */
type ContractExports<K extends (typeof HOST_MODULES)[number]['key']> = Extract<(typeof HOST_MODULES)[number], { key: K }>['exports'][number]

type AppBootModule = Pick<typeof AppBoot, ContractExports<'appBoot'>>
type ProfileBootModule = Pick<typeof ProfileBoot, ContractExports<'profileBoot'>>
type HomePathsModule = Pick<typeof HomePaths, ContractExports<'homePaths'>>
type CmdlineModule = Pick<typeof Cmdline, ContractExports<'cmdline'>>
type HttpProxyModule = Pick<typeof HttpProxy, ContractExports<'httpProxy'>>
type LaunchEnvironmentModule = Pick<typeof LaunchEnvironment, ContractExports<'launchEnvironment'>>
type AppReadyService = NonNullable<Cmdline.CmdlineHost['ready']>

/** The module whose `createRequire` resolves the `via: 'app-boot'` modules. */
const APP_BOOT = HOST_MODULES.find(spec => spec.key === 'appBoot')!.specifier

/** The host modules the entry uses, all from one installation. */
export interface HostDsh {
  /** The host package directory (`@deepseek-ai/dsh`). */
  readonly packageDir: string
  /** Its `package.json` version (reported, not gated on: the exports are). */
  readonly version: string
  readonly Context: new () => Context
  readonly appBoot: AppBootModule
  readonly Loader: unknown
  readonly homePaths: HomePathsModule
  readonly launchEnvironmentKey: string
  readonly cmdline: CmdlineModule
  readonly profileBoot: ProfileBootModule
  readonly httpProxy: HttpProxyModule
}

/**
 * Find the installed host package from the first `dsh` on PATH.
 * @returns the package directory, or undefined when that `dsh` does not
 *   resolve into it ({@link findHostDsh} says why).
 */
export function locateHostDsh(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const found = findHostDsh(env, platform)
  return 'packageDir' in found ? found.packageDir : undefined
}

/** Where the host came from, or why there is none (shown to the user). */
export type HostDshLocation =
  | { readonly packageDir: string; readonly launcher: string; readonly via: 'link' | 'shim' | 'beside' | 'volta' }
  | { readonly reason: string }

/**
 * Find the installed host package from the first `dsh` on PATH, following
 * what a launch would run: a link (npm on Unix) by its realpath, an npm /
 * pnpm / yarn launcher script (sh, `.cmd`, `.ps1`) by the script path it
 * starts, a volta shim through volta's package image. A launcher that
 * cannot be followed is no host: the reason says what was found.
 */
export function findHostDsh(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): HostDshLocation {
  const names = platform === 'win32' ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      // npm's Windows shims sit beside the global node_modules.
      if (platform === 'win32') {
        const beside = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
        if (isHostPackage(beside)) return { packageDir: beside, launcher: candidate, via: 'beside' }
      }
      // The first `dsh` on PATH is the one a launch would run: it is the host
      // or there is none.
      let real: string
      try {
        real = realpathSync(candidate)
      } catch (error) {
        return { reason: `${candidate} cannot be resolved (${error instanceof Error ? error.message : String(error)})` }
      }
      const linked = hostPackageAbove(real)
      if (linked !== undefined) return { packageDir: linked, launcher: candidate, via: 'link' }
      return followLauncher(candidate, real, env, platform)
    }
  }
  return { reason: 'no dsh on PATH' }
}

/** The host package containing `path`, walking up. */
function hostPackageAbove(path: string): string | undefined {
  for (let up = dirname(path); ; up = dirname(up)) {
    if (isHostPackage(up)) return up
    if (dirname(up) === up) return undefined
  }
}

/** The largest launcher script read (npm / pnpm shims are well under 2 KiB). */
const LAUNCHER_SCRIPT_MAX = 64 * 1024

/**
 * A `dsh` that is not a link into the package: a launcher script (read the
 * script path it starts) or a volta shim (volta's package image).
 */
function followLauncher(candidate: string, real: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): HostDshLocation {
  if (/^volta-shim(?:\.exe)?$/iu.test(basename(real))) {
    const volta = env.VOLTA_HOME ?? join(env.HOME ?? env.USERPROFILE ?? '', '.volta')
    const image = join(volta, 'tools', 'image', 'packages', '@deepseek-ai', 'dsh')
    for (const packageDir of [join(image, 'lib', 'node_modules', '@deepseek-ai', 'dsh'), join(image, 'node_modules', '@deepseek-ai', 'dsh')]) {
      if (isHostPackage(packageDir)) return { packageDir, launcher: candidate, via: 'volta' }
    }
    return { reason: `${candidate} is a volta shim and volta's image has no @deepseek-ai/dsh under ${image}` }
  }
  let text: string
  try {
    const content = readFileSync(real)
    if (content.length > LAUNCHER_SCRIPT_MAX || content.subarray(0, 4096).includes(0)) {
      return { reason: `${candidate} is neither a link into @deepseek-ai/dsh nor a launcher script` }
    }
    text = content.toString('utf8')
  } catch (error) {
    return { reason: `${candidate} cannot be read (${error instanceof Error ? error.message : String(error)})` }
  }
  const base = dirname(real)
  for (const script of launcherScriptPaths(text)) {
    const path = resolveLauncherPath(script, base, platform)
    if (path === undefined || !existsSync(path)) continue
    let target: string
    try {
      target = realpathSync(path)
    } catch {
      continue
    }
    const packageDir = hostPackageAbove(target)
    if (packageDir !== undefined) return { packageDir, launcher: candidate, via: 'shim' }
  }
  return { reason: `${candidate} is a launcher script that starts no @deepseek-ai/dsh script found on disk` }
}

/**
 * The script paths a launcher starts: quoted or bare tokens ending in
 * `.js` / `.mjs` / `.cjs` (npm and pnpm cmd-shim, `.cmd` and `.ps1` shims,
 * a hand-written `exec node …/bin.js` wrapper).
 */
export function launcherScriptPaths(text: string): string[] {
  const found: string[] = []
  const token = /"([^"\r\n]+?\.[cm]?js)"|'([^'\r\n]+?\.[cm]?js)'|((?:[^\s"'`;|&<>()]+?)\.[cm]?js)(?=[\s"';|&)]|$)/gmu
  for (const match of text.matchAll(token)) {
    const path = match[1] ?? match[2] ?? match[3]
    if (path !== undefined && !found.includes(path)) found.push(path)
  }
  return found
}

/**
 * Expand a launcher's own-directory variables and resolve against it, with the
 * path rules of `platform` (the native ones in a launch; exported so the
 * win32 expansion is tested off Windows).
 */
export function resolveLauncherPath(script: string, base: string, platform: NodeJS.Platform): string | undefined {
  let path = script
    .replace(/^\$\{?basedir\}?/u, base)
    .replace(/^\$\(dirname\s+"?\$0"?\)/u, base)
    .replace(/^%~dp0%?/iu, base + '\\')
    .replace(/^%dp0%/iu, base)
    .replace(/^\$PSScriptRoot/iu, base)
  // Anything else still holding a variable is not a path this can follow.
  if (/[$%]/u.test(path)) return undefined
  if (platform !== 'win32') path = path.replaceAll('\\', '/')
  return (platform === 'win32' ? win32 : posix).resolve(base, path)
}

function isHostPackage(dir: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null && (manifest as { name?: unknown }).name === HOST_PACKAGE
  } catch {
    return false
  }
}

/**
 * Load the host modules by realpath; throws naming what is missing (no
 * host, a module that does not import, an export the entry needs). The
 * capability probe: the caller falls back on any throw and shows its
 * message.
 */
export async function loadHostDsh(packageDir: string | undefined = undefined): Promise<HostDsh> {
  if (packageDir === undefined) {
    const found = findHostDsh()
    if (!('packageDir' in found)) throw new Error(found.reason)
    packageDir = found.packageDir
  }
  let version = 'unknown'
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // isHostPackage read it a moment ago; a vanished file fails the imports below.
  }
  const hostRequire = createRequire(join(packageDir, 'package.json'))
  const importFrom = async (require: NodeJS.Require, specifier: string): Promise<unknown> => {
    try {
      return await import(pathToFileURL(require.resolve(specifier)).href)
    } catch (error) {
      throw new Error(`dsh ${version} at ${packageDir}: ${specifier} does not load (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`, { cause: error })
    }
  }
  // The Loader and the home paths are app-boot's own dependencies (the
  // Loader's builtins must be the instance app-boot mounts includes with).
  let appBootRequire: NodeJS.Require
  try {
    appBootRequire = createRequire(hostRequire.resolve(APP_BOOT))
  } catch (error) {
    throw new Error(`dsh ${version} at ${packageDir}: ${APP_BOOT} does not resolve (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`, { cause: error })
  }
  // ./host-contract.ts: every module, and every export read from it.
  const loaded = await Promise.all(HOST_MODULES.map(spec => importFrom(spec.via === 'app-boot' ? appBootRequire : hostRequire, spec.specifier)))
  const modules = new Map<string, unknown>(HOST_MODULES.map((spec, index) => [spec.key, loaded[index]]))
  for (const spec of HOST_MODULES) {
    const module = modules.get(spec.key) as Record<string, unknown> | undefined
    for (const name of spec.exports) {
      if (module?.[name] === undefined) throw new Error(`dsh ${version} at ${packageDir} lacks ${spec.specifier.replace(/^@deepseek-ai\//u, '')}.${name}`)
    }
  }
  const module = <T>(key: (typeof HOST_MODULES)[number]['key']): T => modules.get(key) as T
  return {
    packageDir,
    version,
    Context: module<{ Context: HostDsh['Context'] }>('cordis').Context,
    appBoot: module<AppBootModule>('appBoot'),
    Loader: module<{ default: unknown }>('loader').default,
    homePaths: module<HomePathsModule>('homePaths'),
    launchEnvironmentKey: module<LaunchEnvironmentModule>('launchEnvironment').DSH_LAUNCH_ENVIRONMENT_KEY,
    cmdline: module<CmdlineModule>('cmdline'),
    profileBoot: module<ProfileBootModule>('profileBoot'),
    httpProxy: module<HttpProxyModule>('httpProxy'),
  }
}

/** The entry's root, prepared; for the DSH kernel, ready to compose. */
export interface HostRoot {
  readonly ctx: Context
  /**
   * Compose the profile into `ctx` (DSH kernel only): the same root the
   * screen is mounted on. Rejects with the Loader's or the audit's error;
   * the tree stays up (the caller decides what the screen shows).
   * `stopping`: a root dispose waits for this composition
   * (./root-dispose.ts): once the Loader settled, skip the audit and the
   * readiness commit and return.
   */
  compose(warn: Warn, stopping?: () => boolean): Promise<void>
  /**
   * Compose the light profile into `ctx` (the non-DSH kernels only): this
   * package's rows and the profile's third-party bundles, with `dsh-base`
   * left out and the rows that only its services can activate disabled
   * (./lite-profile.ts, design 5.7). What the screen is missing on those
   * kernels is exactly this: the `tui*` services and the plugin rows, which
   * the entry root holds but nothing composes in.
   * Same contract as {@link compose}: rejects with the Loader's or the
   * audit's error (wrapped, with the startup report saved), the tree stays up,
   * and `stopping` short-circuits once the Loader settled.
   * Throws when the root was prepared for DSH — that kernel composes the whole
   * profile through {@link compose} — or when the profile has none of the
   * excluded bundles (nothing to trim: the caller composes normally instead).
   */
  composeLite(warn: Warn, stopping?: () => boolean): Promise<void>
  /**
   * Remove the fail-loud handlers (DSH kernel; a no-op otherwise). The entry
   * calls it once the TUI's process guard and crash funnel are up: from then
   * on they are the single owner of a fatal error (./process-exit.ts, design
   * block 2.5), and fail-loud listening first would exit before the funnel
   * restored the terminal.
   */
  readonly uninstallFailLoud: () => void
  /** The bounded process shutdown `appExit` requests (dsh createProcessShutdown). */
  readonly shutdown: (code: number) => Promise<void>
}

export interface PrepareHostRootOptions {
  /** The profile the launch belongs to. */
  readonly profile: string
  /** The app arguments (`ctx.cmdlineArgs`). */
  readonly args: readonly string[]
  /** Compose the profile later (the DSH kernel); else only the resolution. */
  readonly dsh: boolean
  /**
   * The entry's process-exit seam: `ctx.appExit(code)` goes to the TUI's exit
   * funnel through it once the runtime filled it, and to the bounded
   * `shutdown` before that (or when the funnel refuses).
   */
  readonly exitSeam?: ProcessExitSeam
}

/**
 * Build the entry's Cordis root from the host's `cordis` and install the
 * host's module resolution on it — before the caller imports any TUI
 * module, so the TUI and the DSH plugins composed later resolve shared
 * packages (react, schemastery, the `@deepseek-ai/*` peers) the same way.
 * Both kernels do this: without it the TUI's `@deepseek-ai/*` peers resolve
 * only through `$DSH_HOME/profiles/node_modules`, which a fresh install may
 * not have. The DSH kernel also gets the rest of `runProfile`'s prepare.
 */
export async function prepareHostRoot(host: HostDsh, options: PrepareHostRootOptions): Promise<HostRoot> {
  const { appBoot, profileBoot } = host
  // bin.js: the `.env` layers fill unset variables before anything reads them
  // (the dsh-tui row's `!!js process.env.DSH_TUI_*` included).
  const environment = appBoot.loadLayeredEnv(BIN_NAME)
  // 1–2. composeProfile: load the profile, rewrite its empty root config, and
  // compute the runtime resolution (no `--patch` overlays from the launcher).
  const profile = profileBoot.prepareProfile(options.profile, true, undefined)
  const resolution = await appBoot.createRuntimeResolution({ installAnchor: profileBoot.INSTALL_ANCHOR, profile })
  const rootConfig = join(profile.dir, profileBoot.PROFILE_ROOT_FILENAME)
  // 3. runProfile: the proxy policy before anything opens a connection (DSH
  // only: the Claude kernel never had it in the entry).
  const disposeProxy = options.dsh
    ? await host.httpProxy.installProxyFromEnvironment(environment, message => { process.stderr.write(`${BIN_NAME}: ${message}\n`) })
    : undefined
  const ctx = new host.Context()
  if (disposeProxy !== undefined) ctx.effect(() => () => { void Promise.resolve(disposeProxy()).catch(() => undefined) }, 'dsh-tui host proxy')
  // 4. boot() prelude (boot() itself always creates its own root). Both
  // kernels: the light profile mounts a Loader include on the non-DSH kernels
  // too (`composeLite`), and its patch expressions read `dshHomePath` and
  // resolve bare package names against `baseUrl` (./lite-profile.ts).
  ;(ctx as Context & { baseUrl?: string }).baseUrl = pathToFileURL(dirname(rootConfig)).href + '/'
  ctx.provide('dshHomePath', host.homePaths.dshHomePath)
  ctx.on('internal/update' as never, ((_config: unknown, _noSave: unknown, next: () => unknown) => {
    Promise.resolve(next()).catch((error: unknown) => { ctx.logger.error(error) })
  }) as never, { global: true, prepend: true } as never)
  await ctx.plugin(host.Loader as never, undefined as never)
  const shutdown = createProcessShutdown(() => ctx.fiber.dispose())
  const appReady = createAppReady()
  let uninstallFailLoud = (): void => undefined
  let profileContext: AppBoot.ProfileContext | undefined
  if (options.dsh) {
    // 5. runProfile: fail-loud (removable here, unlike runProfile's), then the
    // profile facts and the launch environment.
    uninstallFailLoud = appBoot.installFailLoud(BIN_NAME, process, async () => { await ctx.fiber.dispose() })
    profileContext = {
      name: options.profile,
      dir: profile.dir,
      patchPath: profile.patchPath,
      installAnchor: profileBoot.INSTALL_ANCHOR,
      startedBundles: profile.layers.map(layer => layer.packageName),
      cwd: process.cwd(),
      home: host.homePaths.resolveDshHome(),
      overlays: [],
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    ctx.provide('profileContext', profileContext)
    ctx.provide(host.launchEnvironmentKey, environment)
  }
  try {
    // 6. runProfile: the resolution hijack (both kernels).
    await ctx.plugin(appBoot.PluginPackages as never, { resolution } as never)
    // 7. runProfile: the app arguments and the exit / readiness seams.
    if (options.dsh) {
      host.cmdline.provideCmdline(ctx, {
        args: options.args,
        exit: code => {
          const answer = options.exitSeam?.request?.({ kind: 'code', code }) ?? 'refused'
          if (answer === 'refused') void shutdown(code)
        },
        ready: appReady.service,
      })
    }
  } catch (error) {
    // The caller falls back to another launch path in this same process:
    // leave nothing of this root behind (runProfile disposes on failure too).
    uninstallFailLoud()
    await ctx.fiber.dispose().catch(() => undefined)
    throw error
  }
  return {
    ctx,
    uninstallFailLoud: () => { uninstallFailLoud() },
    shutdown,
    async compose(warn, stopping = () => false) {
      if (!options.dsh || profileContext === undefined) throw new Error('dsh-tui: this root was prepared without the DSH profile')
      // boot(): the warnings and errors logged while the tree starts, kept
      // for the startup report (a logger exporter on a throwaway context,
      // removed with it).
      const startupLogs: unknown[] = []
      const diagnostics = new host.Context() as Context & { logger: { exporter(exporter: unknown): unknown } }
      diagnostics.logger = (ctx as Context & { logger: { exporter(exporter: unknown): unknown } }).logger
      diagnostics.logger.exporter({
        levels: { default: 2 },
        export: ({ ts, name, type, args }: { ts: unknown; name: unknown; type: unknown; args: unknown }) => {
          if (type === 'warn' || type === 'error') startupLogs.push({ ts, name, type, args })
        },
      })
      try {
        // boot() tail: mount the profile's patch stack over its empty root
        // config, wait for the tree, audit it; runProfile then commits ready.
        await appBoot.mountRootInclude(ctx, rootConfig, appBoot.readProfilePatches(BIN_NAME, profileContext, profile), undefined, BIN_NAME)
        const loader = (): { await(): Promise<unknown> } | undefined => ctx.get('loader' as never) as { await(): Promise<unknown> } | undefined
        await loader()?.await()
        // A surface disposed the tree while it was starting, or is about to
        // (a signal or /quit while composing): no audit, and above all no
        // readiness (HMR would start its profile refresh on a dying tree).
        if (loader() === undefined || stopping()) return
        await appBoot.auditStartupEntries(ctx, BIN_NAME, warn)
        if (ctx.fiber.state === FIBER_ACTIVE && loader() !== undefined && !stopping()) appReady.commit()
      } catch (error) {
        // boot() attaches the root config and the startup logs to an audit
        // failure; bin.js then saves the report under $DSH_HOME/logs. The
        // entry saves one for every composition failure (bin.js lets any
        // other error crash the process; here the screen stays up and shows
        // the report's path instead).
        if (error instanceof appBoot.StartupError) {
          Object.defineProperty(error, 'startup', { value: { configurationPath: rootConfig, messages: startupLogs }, enumerable: false, configurable: true, writable: true })
        }
        const logPath = await writeStartupReport(error, {
          home: host.homePaths.resolveDshHome(),
          version: hostVersion(host),
          profile: options.profile,
          ...(error instanceof appBoot.StartupError ? {} : { configurationPath: rootConfig, messages: startupLogs }),
        })
        throw new HostComposeError(error, logPath)
      } finally {
        await diagnostics.fiber.dispose().catch(() => undefined)
      }
    },
    async composeLite(warn, stopping = () => false) {
      if (options.dsh) throw new Error('dsh-tui: this root was prepared for DSH; compose the whole profile instead')
      const plan = liteProfilePlan(profile)
      if (!plan.trimmed) {
        // Nothing to trim: the profile lists none of `excludedBundles` (one
        // that does not carry dsh-base at all). Its layers are the whole
        // profile then, so composing them IS the full composition the caller
        // would otherwise reuse (./lite-profile.ts `trimmed`), and
        // `rowDisables` is empty: no working row is disabled. This must not be
        // fatal — the screen is already mounted and the exit is loud (exit 1),
        // which a launcher turns into its safe-mode prompt: a profile that is
        // merely whole would cost the kernel its whole plugin ecosystem. Warn
        // on the caller's sink and compose it.
        warn(`dsh-tui: light profile: ${options.profile} lists none of ${plan.excludedBundles.join(', ')}; composing it whole\n`)
      }
      // What was left out, on the caller's warning sink: the composition is
      // otherwise silent, and the row list is the reviewable half of the
      // decision (./lite-profile.ts). Before the mount, so nothing may write
      // to the terminal yet.
      const notice = liteProfileNotice(plan)
      if (notice !== undefined) warn(notice)
      // runProfile's profile facts, narrowed to the light bundle list: the
      // patch expressions and the Loader resolve from the same profile
      // directory, but `startedBundles` must name what is really composed.
      const liteContext: AppBoot.ProfileContext = {
        name: options.profile,
        dir: profile.dir,
        patchPath: profile.patchPath,
        installAnchor: profileBoot.INSTALL_ANCHOR,
        startedBundles: plan.bundles,
        cwd: process.cwd(),
        home: host.homePaths.resolveDshHome(),
        overlays: [],
        telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
      }
      // readProfilePatches over the trimmed layers, then the disable rows:
      // patch entries in the profile's own shape, applied last the way the
      // profile's user layer is (a static disable in cordis.patch.yml would
      // also hit the DSH kernel's composition, so this must stay runtime-side).
      const patches = appBoot.readProfilePatches(BIN_NAME, liteContext, { ...profile, layers: [...plan.layers] })
      patches.push(...plan.disableRows)
      try {
        await appBoot.mountRootInclude(ctx, rootConfig, patches, undefined, BIN_NAME)
        const loader = (): { await(): Promise<unknown> } | undefined => ctx.get('loader' as never) as { await(): Promise<unknown> } | undefined
        await loader()?.await()
        if (loader() === undefined || stopping()) return
        await appBoot.auditStartupEntries(ctx, BIN_NAME, warn)
      } catch (error) {
        // Same failure contract as compose: the screen is up on these kernels
        // too, so the report is saved and the path travels on the error.
        // Difference from compose: no startup-log exporter, so `messages` is
        // empty (the light composition has no DSH boot to log through).
        if (error instanceof appBoot.StartupError) {
          Object.defineProperty(error, 'startup', { value: { configurationPath: rootConfig, messages: [] }, enumerable: false, configurable: true, writable: true })
        }
        const logPath = await writeStartupReport(error, {
          home: host.homePaths.resolveDshHome(),
          version: hostVersion(host),
          profile: options.profile,
          ...(error instanceof appBoot.StartupError ? {} : { configurationPath: rootConfig, messages: [] }),
        })
        throw new HostComposeError(error, logPath)
      }
    },
  }
}

/** A composition failure, with the startup report saved for it. */
export class HostComposeError extends Error {
  /** The report's path; undefined when it could not be written. */
  readonly logPath: string | undefined
  constructor(readonly original: unknown, logPath: string | undefined) {
    super(original instanceof Error ? original.message : String(original), { cause: original })
    this.name = 'HostComposeError'
    this.logPath = logPath
  }
}

function hostVersion(host: HostDsh): string {
  try {
    return host.appBoot.getDshRuntimeVersion()
  } catch {
    return host.version
  }
}

/**
 * dsh `bin.js` reportStartupFailure (0.2.0-rc.2), the file half: a private,
 * uniquely named report under `$DSH_HOME/logs`. The terminal half is the
 * caller's (the screen is up: never stderr).
 * @returns the report's path, or undefined when it could not be written.
 */
export async function writeStartupReport(error: unknown, context: {
  readonly home: string
  readonly version: string
  readonly profile: string
  /** For a non-audit failure: what boot() would have attached to one. */
  readonly configurationPath?: string
  readonly messages?: readonly unknown[]
}): Promise<string | undefined> {
  const now = new Date().toISOString()
  const report = 'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.\n\n' + inspect({
    timestamp: now,
    dshVersion: context.version,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    profile: context.profile,
    ...(context.configurationPath === undefined ? {} : { startup: { configurationPath: context.configurationPath, messages: context.messages ?? [] } }),
    error,
  }, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    showHidden: true,
    customInspect: false,
    getters: false,
    colors: false,
  }) + '\n'
  const logDir = join(context.home, 'logs')
  const logPath = join(logDir, `startup-${now.replaceAll(':', '-')}-${randomUUID()}.log`)
  try {
    await mkdir(logDir, { recursive: true, mode: 0o700 })
    await writeFile(logPath, report, { flag: 'wx', mode: 0o600 })
  } catch {
    return undefined
  }
  return logPath
}

/**
 * dsh `profile-boot` createAppReady (0.2.0-rc.2): the readiness signal
 * committed once boot and host setup succeeded.
 */
function createAppReady(): { readonly service: AppReadyService; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => undefined
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * dsh `profile-boot` createProcessShutdown (0.2.0-rc.2), the `shutdown` half:
 * dispose, then set the exit code; a stalled dispose exits after the bound.
 * It serves `appExit` only before the TUI's funnel can take it. The
 * `interrupt` half (the signal path: dispose then force-exit 0 / 130, a
 * second signal at once) is replaced by ./process-exit.ts, which ends by the
 * signal itself after the funnel restored the terminal.
 */
function createProcessShutdown(dispose: () => Promise<unknown>, timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS): (code: number) => Promise<void> {
  let pending: Promise<void> | undefined
  let settled = false
  return code => {
    if (pending !== undefined) return pending
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      process.exit(code)
    }, timeoutMs)
    pending = Promise.resolve().then(dispose).then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.exitCode = code
    }, () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.exit(code)
    })
    return pending
  }
}
