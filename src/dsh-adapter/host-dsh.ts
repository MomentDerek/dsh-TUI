/**
 * The installed DSH host, loaded into this package's own entry
 * (docs/standalone-host-design.md 5.4 and Phase 2 "single root"): the entry's
 * Cordis root is built from the host's own `cordis`, gets the host's module
 * resolution before any TUI module loads, and — for the DSH kernel — has the
 * profile composed into it after the screen mounted. No `runProfile`, no
 * second root.
 *
 * Module identity. Everything comes from the `dsh` on PATH — by realpath, or
 * through the launcher script it is (npm / pnpm shims, Windows `.cmd` /
 * `.ps1`, a volta shim; `findHostDsh`) — never from this package's
 * own dependencies: the host's `cordis` is a nested copy, and the Loader
 * must be the one `dsh-app-boot` itself uses (resolved through app-boot's own
 * `createRequire`). These modules are imported by file URL only — none of
 * them is a dependency of this package (adding them is the maintainers' call,
 * design §10.7), so their shapes are described here structurally and checked
 * on load.
 *
 * What is reproduced from the host (@deepseek-ai/dsh 0.2.0-rc.2; keep in step
 * with it, design 2.6). Lines are the upstream function bodies:
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
 * Deliberately not reproduced: `runProfile`'s SIGTERM/SIGINT handlers and
 * `createProcessShutdown().interrupt` (the entry owns signals and ends by the
 * signal through the TUI's exit funnel: ./process-exit.ts says why its exit
 * status differs from `interrupt`'s 0 / 130), the terminal half of
 * `reportStartupFailure` (the screen is up: the failure row names the report
 * instead), `--patch` overlays and `--from-default-profile` (the launcher passes
 * neither), and the `dsh-purge` `DSH_HOME` shim of `bin.js` (the launcher
 * resolves `DSH_HOME` itself).
 *
 * Never writes to stdout. Before the screen mounts, host warnings go to
 * stderr as `dsh` prints them; the composition runs after the mount and
 * takes the caller's sink.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { ProcessExitSeam } from './process-exit.js'

/** The host package name whose installation the entry loads. */
const HOST_PACKAGE = '@deepseek-ai/dsh'
/** The diagnostic prefix the host's own boot uses. */
const BIN_NAME = 'dsh'
/** dsh `profile-boot` PROCESS_SHUTDOWN_TIMEOUT_MS (0.2.0-rc.2). */
const PROCESS_SHUTDOWN_TIMEOUT_MS = 5000
/** Cordis fiber state "active" (dsh-app-boot FIBER_ACTIVE). */
const FIBER_ACTIVE = 2

type Warn = (line: string) => void

/** A loaded profile, as dsh `prepareProfile` returns it (the parts read here). */
interface HostProfile {
  readonly dir: string
  readonly patchPath: string
  readonly layers: readonly { readonly packageName: string }[]
}

interface AppBootModule {
  loadLayeredEnv(binName: string, cwd?: string, warn?: Warn): unknown
  createRuntimeResolution(options: { installAnchor: string; profile: HostProfile }): Promise<unknown>
  readonly PluginPackages: unknown
  installFailLoud(binName: string, proc: NodeJS.Process, release?: () => Promise<void>): () => void
  readProfilePatches(binName: string, profileContext: unknown, profile: HostProfile): unknown[]
  mountRootInclude(ctx: Context, absoluteConfigPath: string, patches: unknown[], bareModuleBaseUrl: undefined, binName: string): Promise<unknown>
  auditStartupEntries(ctx: Context, binName: string, warn: Warn): Promise<void>
  /** The audit's failure class (boot() attaches `startup` to it). */
  readonly StartupError: abstract new (...args: never[]) => Error
  getDshRuntimeVersion(): string
}

interface ProfileBootModule {
  prepareProfile(name: string, userLayer: boolean, fromDefaultProfile: undefined): HostProfile
  readonly INSTALL_ANCHOR: string
  readonly PROFILE_ROOT_FILENAME: string
}

interface HomePathsModule {
  readonly dshHomePath: unknown
  resolveDshHome(): string
}

interface CmdlineModule {
  provideCmdline(ctx: Context, host: { args: readonly string[]; exit: (code: number) => void; ready: AppReadyService }): void
}

interface HttpProxyModule {
  installProxyFromEnvironment(environment: unknown, report: Warn): Promise<(() => Promise<void> | void) | undefined>
}

interface AppReadyService {
  onReady(listener: () => void): () => void
}

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

/** Expand a launcher's own-directory variables and resolve against it. */
function resolveLauncherPath(script: string, base: string, platform: NodeJS.Platform): string | undefined {
  let path = script
    .replace(/^\$\{?basedir\}?/u, base)
    .replace(/^\$\(dirname\s+"?\$0"?\)/u, base)
    .replace(/^%~dp0%?/iu, base + '\\')
    .replace(/^%dp0%/iu, base)
    .replace(/^\$PSScriptRoot/iu, base)
  // Anything else still holding a variable is not a path this can follow.
  if (/[$%]/u.test(path)) return undefined
  if (platform !== 'win32') path = path.replaceAll('\\', '/')
  return resolve(base, path)
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
  const hostImport = (specifier: string): Promise<unknown> => importFrom(hostRequire, specifier)
  // The Loader and the home paths are app-boot's own dependencies (the
  // Loader's builtins must be the instance app-boot mounts includes with).
  let appBootRequire: NodeJS.Require
  try {
    appBootRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-app-boot'))
  } catch (error) {
    throw new Error(`dsh ${version} at ${packageDir}: @deepseek-ai/dsh-app-boot does not resolve (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`, { cause: error })
  }
  const appBootImport = (specifier: string): Promise<unknown> => importFrom(appBootRequire, specifier)
  const [cordis, appBoot, loader, homePaths, launchEnvironment, cmdline, profileBoot, httpProxy] = await Promise.all([
    hostImport('@deepseek-ai/cordis'),
    hostImport('@deepseek-ai/dsh-app-boot'),
    appBootImport('@deepseek-ai/cordis-plugin-loader'),
    appBootImport('@deepseek-ai/dsh-home-paths'),
    hostImport('@deepseek-ai/dsh-launch-environment'),
    hostImport('@deepseek-ai/dsh-cmdline'),
    hostImport('@deepseek-ai/dsh/profile-boot'),
    hostImport('@deepseek-ai/dsh-http-proxy'),
  ])
  const field = (module: unknown, name: string, what: string): unknown => {
    const value = (module as Record<string, unknown> | undefined)?.[name]
    if (value === undefined) throw new Error(`dsh ${version} at ${packageDir} lacks ${what}.${name}`)
    return value
  }
  for (const name of ['loadLayeredEnv', 'createRuntimeResolution', 'PluginPackages', 'installFailLoud', 'readProfilePatches', 'mountRootInclude', 'auditStartupEntries', 'StartupError', 'getDshRuntimeVersion']) field(appBoot, name, 'dsh-app-boot')
  for (const name of ['prepareProfile', 'INSTALL_ANCHOR', 'PROFILE_ROOT_FILENAME']) field(profileBoot, name, 'dsh/profile-boot')
  field(cmdline, 'provideCmdline', 'dsh-cmdline')
  field(httpProxy, 'installProxyFromEnvironment', 'dsh-http-proxy')
  field(homePaths, 'dshHomePath', 'dsh-home-paths')
  field(homePaths, 'resolveDshHome', 'dsh-home-paths')
  return {
    packageDir,
    version,
    Context: field(cordis, 'Context', 'cordis') as HostDsh['Context'],
    appBoot: appBoot as AppBootModule,
    Loader: field(loader, 'default', 'cordis-plugin-loader'),
    homePaths: homePaths as HomePathsModule,
    launchEnvironmentKey: field(launchEnvironment, 'DSH_LAUNCH_ENVIRONMENT_KEY', 'dsh-launch-environment') as string,
    cmdline: cmdline as CmdlineModule,
    profileBoot: profileBoot as ProfileBootModule,
    httpProxy: httpProxy as HttpProxyModule,
  }
}

/** The entry's root, prepared; for the DSH kernel, ready to compose. */
export interface HostRoot {
  readonly ctx: Context
  /**
   * Compose the profile into `ctx` (DSH kernel only): the same root the
   * screen is mounted on. Rejects with the Loader's or the audit's error;
   * the tree stays up (the caller decides what the screen shows).
   */
  compose(warn: Warn): Promise<void>
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
  // 4. boot() prelude (boot() itself always creates its own root).
  if (options.dsh) {
    ;(ctx as Context & { baseUrl?: string }).baseUrl = pathToFileURL(dirname(rootConfig)).href + '/'
    ctx.provide('dshHomePath', host.homePaths.dshHomePath)
    ctx.on('internal/update' as never, ((_config: unknown, _noSave: unknown, next: () => unknown) => {
      Promise.resolve(next()).catch((error: unknown) => { ctx.logger.error(error) })
    }) as never, { global: true, prepend: true } as never)
    await ctx.plugin(host.Loader as never, undefined as never)
  }
  const shutdown = createProcessShutdown(() => ctx.fiber.dispose())
  const appReady = createAppReady()
  let uninstallFailLoud = (): void => undefined
  let profileContext: unknown
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
    async compose(warn) {
      if (!options.dsh) throw new Error('dsh-tui: this root was prepared without the DSH profile')
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
        // A surface disposed the tree while it was starting.
        if (loader() === undefined) return
        await appBoot.auditStartupEntries(ctx, BIN_NAME, warn)
        if (ctx.fiber.state === FIBER_ACTIVE && loader() !== undefined) appReady.commit()
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
