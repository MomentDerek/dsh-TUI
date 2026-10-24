/**
 * `/restart` carry-over of the composer queue (#1651): the queued and held
 * texts the old process still showed are written to a per-process file whose
 * path rides the replacement's env, and the replacement parks them as held
 * dock rows. The backend copies die with the old process (the kernel records
 * them as canceled), so nothing re-sends them until the user sends the dock.
 * Text only: staged images live in the old process's memory.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

/** env marker naming the file the replacement takes its held texts from. */
export const HELD_INPUTS_ENV = 'DSH_TUI_HELD_INPUTS'

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
    writeFileSync(file, JSON.stringify({ texts: kept }))
    return { [HELD_INPUTS_ENV]: file }
  } catch {
    return undefined
  }
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
  if (file === undefined || !/^held-inputs-\d+\.json$/u.test(basename(file))) return []
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
