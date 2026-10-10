#!/usr/bin/env node
/**
 * 门禁：`LITE_PROFILE_ROW_DISABLES` 的每个 `id` 必须是 `cordis.patch.yml` 里真实的
 * insert 行 id——改名后 disable 静默失效，而 `verify:patch-surface` 不会红。
 *
 * 跑法：node --import tsx/esm scripts/verify-lite-profile-rows.mjs
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { LITE_PROFILE_ROW_DISABLES } from '../src/dsh-adapter/lite-profile.ts'

const root = resolve(import.meta.dirname, '..')
const patchPath = join(root, 'cordis.patch.yml')

/**
 * 与 verify-patch-surface.ts 的 parsePatch 同口径：只取 `insert:` 块里的 `id`。
 * `logLevel: 'silent'` 只关掉 `!!js` 标签的解析告警（本门禁不 evaluate 这些值，
 * 26 条 `Unresolved tag` 会把 CI 日志刷满），解析结果与默认档逐字节相同。
 */
function parseInsertIds(text) {
  const doc = parseYaml(text, { logLevel: 'silent' })
  if (!Array.isArray(doc)) throw new Error('patch root is not a list')
  const ids = []
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    if (!Array.isArray(item.insert)) continue
    for (const row of item.insert) {
      if (row !== null && typeof row === 'object' && typeof row.id === 'string') ids.push(row.id)
    }
  }
  return ids
}

const insertIds = new Set(parseInsertIds(readFileSync(patchPath, 'utf8')))
const failures = []

if (LITE_PROFILE_ROW_DISABLES.length === 0) failures.push('LITE_PROFILE_ROW_DISABLES is empty')
const seen = new Set()
for (const id of LITE_PROFILE_ROW_DISABLES) {
  if (seen.has(id)) failures.push(`duplicate table id: ${id}`)
  seen.add(id)
  if (!insertIds.has(id)) failures.push(`${id} — not an insert id in cordis.patch.yml`)
}

if (failures.length > 0) {
  console.error(`lite-profile-rows: ${failures.length} problem(s)`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error('Renamed an insert id in cordis.patch.yml? Update LITE_PROFILE_ROW_DISABLES in src/dsh-adapter/lite-profile.ts to match.')
  process.exit(1)
}
console.log(`lite-profile-rows OK (${LITE_PROFILE_ROW_DISABLES.length} rows, all present among ${insertIds.size} patch inserts)`)
