/**
 * The installed DSH host, loaded into this package's own entry
 * (docs/standalone-host-design.md 5.4 and Phase 2 "single root"): the entry's
 * Cordis root is built from the host's own `cordis`, gets the host's module
 * resolution before any TUI module loads, and — for the DSH kernel — has the
 * profile composed into it after the screen mounted. No `runProfile`, no
 * second root.
 *
 * Module identity. Everything comes from the `dsh` on PATH, by realpath (a
 * Windows `dsh.cmd` shim: the package beside it), never from this package's
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
 * | `HostRoot.compose`           | dsh-app-boot `boot()` tail (mountRootInclude,    | ~6    |
 * |                              | loader.await, auditStartupEntries) + runProfile  |       |
 * |                              | appReady.commit                                  |       |
 *
 * Deliberately not reproduced: `runProfile`'s SIGTERM/SIGINT handlers and
 * `createProcessShutdown().interrupt` (the entry owns signals and ends by the
 * signal through the TUI's exit funnel: ./process-exit.ts says why its exit
 * status differs from `interrupt`'s 0 / 130), `boot()`'s startup-log capture for `StartupError`
 * reports (a composition failure lands in the mounted screen instead),
 * `--patch` overlays and `--from-default-profile` (the launcher passes
 * neither), and the `dsh-purge` `DSH_HOME` shim of `bin.js` (the launcher
 * resolves `DSH_HOME` itself).
 *
 * Never writes to stdout. Before the screen mounts, host warnings go to
 * stderr as `dsh` prints them; the composition runs after the mount and
 * takes the caller's sink.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
 *   resolve into it.
 */
export function locateHostDsh(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const names = platform === 'win32' ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      // npm's Windows shims sit beside the global node_modules.
      if (platform === 'win32') {
        const beside = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
        if (isHostPackage(beside)) return beside
      }
      // The first `dsh` on PATH is the one a launch would run: it is the host
      // or there is none (a wrapper script that is not the package).
      let real: string
      try {
        real = realpathSync(candidate)
      } catch {
        return undefined
      }
      for (let up = dirname(real); ; up = dirname(up)) {
        if (isHostPackage(up)) return up
        if (dirname(up) === up) break
      }
      return undefined
    }
  }
  return undefined
}

function isHostPackage(dir: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null && (manifest as { name?: unknown }).name === HOST_PACKAGE
  } catch {
    return false
  }
}

/** Load the host modules by realpath; throws naming what is missing. */
export async function loadHostDsh(packageDir: string | undefined = locateHostDsh()): Promise<HostDsh> {
  if (packageDir === undefined) throw new Error('dsh-tui: no installed dsh found on PATH')
  const hostRequire = createRequire(join(packageDir, 'package.json'))
  const hostImport = (specifier: string): Promise<unknown> => import(pathToFileURL(hostRequire.resolve(specifier)).href)
  // The Loader and the home paths are app-boot's own dependencies (the
  // Loader's builtins must be the instance app-boot mounts includes with).
  const appBootRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-app-boot'))
  const appBootImport = (specifier: string): Promise<unknown> => import(pathToFileURL(appBootRequire.resolve(specifier)).href)
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
    if (value === undefined) throw new Error(`dsh-tui: the installed dsh lacks ${what}.${name}`)
    return value
  }
  for (const name of ['loadLayeredEnv', 'createRuntimeResolution', 'PluginPackages', 'installFailLoud', 'readProfilePatches', 'mountRootInclude', 'auditStartupEntries']) field(appBoot, name, 'dsh-app-boot')
  for (const name of ['prepareProfile', 'INSTALL_ANCHOR', 'PROFILE_ROOT_FILENAME']) field(profileBoot, name, 'dsh/profile-boot')
  field(cmdline, 'provideCmdline', 'dsh-cmdline')
  field(httpProxy, 'installProxyFromEnvironment', 'dsh-http-proxy')
  field(homePaths, 'dshHomePath', 'dsh-home-paths')
  field(homePaths, 'resolveDshHome', 'dsh-home-paths')
  return {
    packageDir,
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
      // boot() tail: mount the profile's patch stack over its empty root
      // config, wait for the tree, audit it; runProfile then commits ready.
      await appBoot.mountRootInclude(ctx, rootConfig, appBoot.readProfilePatches(BIN_NAME, profileContext, profile), undefined, BIN_NAME)
      const loader = (): { await(): Promise<unknown> } | undefined => ctx.get('loader' as never) as { await(): Promise<unknown> } | undefined
      await loader()?.await()
      // A surface disposed the tree while it was starting.
      if (loader() === undefined) return
      await appBoot.auditStartupEntries(ctx, BIN_NAME, warn)
      if (ctx.fiber.state === FIBER_ACTIVE && loader() !== undefined) appReady.commit()
    },
  }
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
