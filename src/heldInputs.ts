/**
 * `/restart` carry-over of the composer queue (#1651): the queued and held
 * texts the old process still showed are written to a per-process file whose
 * path rides the replacement's env, and the replacement parks them as held
 * dock rows. The backend copies die with the old process (the kernel records
 * them as canceled), so nothing re-sends them until the user sends the dock.
 * Text only: staged images live in the old process's memory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

/** env marker naming the file the replacement takes its held texts from. */
export const HELD_INPUTS_ENV = 'DSH_TUI_HELD_INPUTS'

const HELD_INPUTS_FILE = /^held-inputs-\d+\.json$/u
/** A restart that stalled leaves its file for the printed resume command; one
 *  nobody resumed within this long is swept at a later launch. */
const HELD_INPUTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Write the texts for a replacement process to take.
 * @returns The env marker to hand the replacement, or undefined when there
 *   is nothing to carry or the write failed (best effort: a restart never
 *   waits on it).
 */
export function writeHeldInputs(texts: readonly string[], dir: string = DATA_DIR, pid: number = process.pid): Record<string, string> | undefined {
  const kept = texts.filter(text => text.trim() !== '')
  if (kept.length === 0) return undefined
  const file = join(dir, `held-inputs-${pid}.json`)
  try {
    mkdirSync(dir, { recursive: true })
    // The user's own prompt text: readable by them alone.
    writeFileSync(file, JSON.stringify({ texts: kept }), { mode: 0o600 })
    return { [HELD_INPUTS_ENV]: file }
  } catch {
    return undefined
  }
}

/**
 * The replacement's side: park the texts a `/restart` handed this process as
 * held rows once the screen's channel is ready (never sent by themselves).
 * @returns What stops waiting for a channel that is not ready yet.
 */
export function adoptHeldInputs(
  channel: { readonly ready: boolean; subscribe(listener: () => void): () => void; holdInputs(texts: readonly string[]): number },
  env: NodeJS.ProcessEnv = process.env,
  dir: string = DATA_DIR,
): (() => void) | undefined {
  const texts = takeHeldInputs(env)
  sweepHeldInputs(dir)
  if (texts.length === 0) return undefined
  if (channel.ready) {
    channel.holdInputs(texts)
    return undefined
  }
  const unsubscribe = channel.subscribe(() => {
    if (!channel.ready) return
    unsubscribe()
    channel.holdInputs(texts)
  })
  return unsubscribe
}

/**
 * The resume command after a restart that ended before any replacement took
 * the held texts (a stall, a failed spawn): their file stays, and the command
 * hands it to the next launch. A Windows command takes no env prefix: there
 * it is the PowerShell form that sets the marker first.
 */
export function heldInputsResumeCommand(command: string, env: Readonly<Record<string, string>> | undefined, platform: NodeJS.Platform = process.platform): string {
  const file = env?.[HELD_INPUTS_ENV]
  if (file === undefined || !existsSync(file)) return command
  if (platform === 'win32') return `$env:${HELD_INPUTS_ENV}='${file.replaceAll('\'', '\'\'')}'; ${command}`
  return `${HELD_INPUTS_ENV}='${file.replaceAll('\'', '\'\\\'\'')}' ${command}`
}

/**
 * Take (read and delete) the texts a `/restart` handed this process. One
 * shot: the env marker is consumed too, so no child inherits it.
 */
export function takeHeldInputs(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = env[HELD_INPUTS_ENV]
  delete env[HELD_INPUTS_ENV]
  // Only ever a file writeHeldInputs named: the marker is env input, and
  // this deletes what it names.
  if (file === undefined || !HELD_INPUTS_FILE.test(basename(file))) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const texts = parsed !== null && typeof parsed === 'object' ? (parsed as { texts?: unknown }).texts : undefined
    return Array.isArray(texts) ? texts.filter((text): text is string => typeof text === 'string' && text.trim() !== '') : []
  } catch {
    return []
  } finally {
    rmSync(file, { force: true })
  }
}

/** Remove held-input files older than the resume window (best effort). */
export function sweepHeldInputs(dir: string = DATA_DIR, now: number = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!HELD_INPUTS_FILE.test(name)) continue
    const file = join(dir, name)
    try {
      if (now - statSync(file).mtimeMs > HELD_INPUTS_MAX_AGE_MS) rmSync(file, { force: true })
    } catch {
    }
  }
}
