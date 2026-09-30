/**
 * Mount the root tree in its boot phase and publish the slot.
 *
 * Runs inside the dsh process from the `--import` preload, BEFORE dsh reads
 * the profile. Nothing here may import `@deepseek-ai/*` directly: the point
 * is to paint before that module graph loads (Chat's own adapter modules do
 * pull a few upstream packages in, ~70ms, which dsh would load anyway).
 * Renderer-affecting choices that the plugin later resolves through the
 * settings service (fullscreen, terminal images, page margin, minimal UI,
 * splash options, language) are read here straight from
 * `$DSH_HOME/settings.yaml` and the `~/.dsh-tui` preference files; the plugin
 * mounts a fresh slot if its own resolution disagrees (see plugin.ts).
 */
import { readFileSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspect } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { QuestionStore } from '../dsh-adapter/questions.js'
import { readEffortPref } from '../effortPrefs.js'
import { isLang, resolveStartupLang, setLang } from '../i18n.js'
import { fatalReasonForExit, registerProcessGuardFatalSink } from '../ink/update-overflow-guard.js'
import { setMinimalUiMode } from '../minimalUiMode.js'
import { readModelPref } from '../modelPrefs.js'
import { applyPageMargin, normalizePageMargin } from '../tuiDisplayPrefs.js'
import type { RenderOptions } from '../ui.js'
import { resolveSessionCwd } from '../utils/workspaceRoot.js'
import { createBootChannel } from './bootChannel.js'
import { publishPrebootSlot } from './handle.js'
import { mountChatHost, type BootSlot } from './host.js'

/** The `dsh-tui:` section of settings.yaml, loosely typed. */
export type TuiSettingsLayer = Readonly<Record<string, unknown>>

/** `$DSH_HOME`, defaulting like the launcher and dsh-home-paths do. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

/**
 * Read the `dsh-tui` namespace of the DSH settings document. A missing or
 * malformed file yields an empty layer — the boot screen must never be the
 * reason a launch fails.
 */
export function readTuiSettingsLayer(dshHome: string = resolveDshHome()): TuiSettingsLayer {
  try {
    const document: unknown = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
    if (document === null || typeof document !== 'object') return {}
    const layer = (document as Record<string, unknown>)['dsh-tui']
    return layer !== null && typeof layer === 'object' ? layer as TuiSettingsLayer : {}
  } catch {
    return {}
  }
}

const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback
const str = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

/** Renderer decisions and route hints derived from the settings layer, exported for the regression. */
export interface PrebootDecisions {
  fullscreen: boolean
  terminalImages: boolean
  minimalUi: boolean
  effort: string | undefined
  model: string
}

/**
 * Current branch of a git checkout, read from `.git/HEAD` (following a
 * worktree's `gitdir:` pointer). Detached HEAD and non-repos yield undefined
 * — the same cases where the channel's `git branch --show-current` shows
 * nothing. A file read instead of a spawn: this runs before the first frame.
 */
export function readGitBranch(root: string): string | undefined {
  try {
    let gitDir = join(root, '.git')
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(gitDir, 'utf8'))
      if (pointer === null) return undefined
      gitDir = resolve(root, pointer[1]!.trim())
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/u.exec(head)
    return ref === null ? undefined : ref[1]
  } catch {
    return undefined
  }
}

export function decidePreboot(layer: TuiSettingsLayer): PrebootDecisions {
  return {
    // Schema defaults from src/dsh-adapter/index.ts: both renderer flags
    // default to on; the settings user layer overrides when set.
    fullscreen: bool(layer.fullscreen, true),
    terminalImages: bool(layer.terminalImages, true),
    minimalUi: bool(layer.minimal, false),
    effort: str(layer.effortDefault) ?? readEffortPref(),
    model: readModelPref()?.model ?? 'DeepSeek',
  }
}

export interface MountPrebootOptions {
  dshHome?: string
  /** Process exit used by Chat's double Ctrl+C; injectable for tests. */
  exit?: (code: number) => void
  /** Renderer stream/console overrides (headless regressions). */
  renderOptions?: Pick<RenderOptions, 'stdout' | 'stdin' | 'stderr' | 'patchConsole'>
}

/**
 * Upper bound on waiting for the first visible frame. Terminal background
 * detection (ThemeProvider, OSC 11) normally answers in ~10ms and times out
 * at 400ms; past this bound dsh starts loading regardless.
 */
export const FIRST_FRAME_WAIT_MS = 700

/**
 * Paint the boot-phase root and publish the slot. Resolves once the first
 * VISIBLE frame has been committed (bounded by FIRST_FRAME_WAIT_MS) so the
 * preload can let dsh start loading without racing the paint.
 */
export async function mountPreboot(options: MountPrebootOptions = {}): Promise<BootSlot> {
  const layer = readTuiSettingsLayer(options.dshHome)
  // Same precedence as plugin.ts before the first render: env → settings
  // user layer → persisted /lang choice → locale/zh. (cordis.yml `lang` is
  // not visible here; the plugin re-applies it, strings re-resolve live.)
  const envLang = process.env.DSH_TUI_LANG
  setLang(isLang(envLang) ? envLang : isLang(layer.lang) ? layer.lang : resolveStartupLang())
  const decisions = decidePreboot(layer)
  setMinimalUiMode(decisions.minimalUi)
  applyPageMargin(normalizePageMargin(layer.pageMargin))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const cwd = resolveSessionCwd(undefined)
  const channel = createBootChannel({
    model: decisions.model,
    effort: decisions.effort,
    cwd,
    gitBranch: readGitBranch(cwd),
    settings: layer,
  })
  let slot: BootSlot | undefined
  slot = await mountChatHost({
    fullscreen: decisions.fullscreen,
    terminalImages: decisions.terminalImages,
    renderOptions: options.renderOptions,
    firstFrameWaitMs: FIRST_FRAME_WAIT_MS,
    initial: {
      channel,
      props: {
        // Inert until the plugin's `ready(live)` replaces it: no ask can be
        // parked before a session exists.
        questionStore: new QuestionStore(),
        // Chat's double Ctrl+C while dsh is still loading is a user exit,
        // so it leaves with 0 like the plugin's exit funnel does. Any other
        // code reads as a crash to the launcher, which then prints the
        // profile-exited diagnosis and offers safe mode (twice, once per
        // delegating copy) — for a deliberate interrupt.
        onExit: () => {
          slot?.dispose()
          exit(0)
        },
      },
    },
  })
  // Constructing the Ink instance installed the #185 process guard, whose
  // listeners rethrow anything no sink claims — from inside the listener, so
  // Node exits 7 without an 'exit' event and the terminal keeps the
  // alt-screen, mouse tracking and hidden cursor. The plugin registers the
  // real sink deep inside apply; until then (dsh composing the profile,
  // loading plugins) a fatal error is dsh's, not ours: restore the terminal,
  // print it the way Node would, and exit 1 — the plain path's behavior. The
  // plugin's registration replaces this one before it takes the slot live.
  const bootSlot = slot
  const fatalOut = options.renderOptions?.stderr ?? process.stderr
  registerProcessGuardFatalSink((error, origin) => {
    if (bootSlot.phase !== 'booting') return false
    // Best-effort restore: a throw here (EIO on a revoked TTY, an effect
    // cleanup) would escape the listener as exit 7 and mask dsh's error.
    try {
      bootSlot.dispose()
    } catch {}
    // `Promise.reject()` / `throw undefined` would print a bare `undefined`.
    const text = `${inspect(fatalReasonForExit(error, origin))}\n`
    // Synchronous on the real fd: exit(1) follows immediately, and a stream
    // write to a redirected stderr can be dropped (macOS pipes/files).
    const fd = (fatalOut as { fd?: unknown }).fd
    try {
      if (typeof fd === 'number') writeSync(fd, text)
      else fatalOut.write(text)
    } catch {}
    exit(1)
    return true
  })
  publishPrebootSlot(slot)
  return slot
}
