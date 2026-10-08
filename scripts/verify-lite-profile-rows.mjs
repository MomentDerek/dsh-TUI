#!/usr/bin/env node
/**
 * 轻量 profile 的**裁剪表 ↔ patch 行 id** 静态对口门禁。
 *
 * `src/dsh-adapter/lite-profile.ts` 的 `LITE_PROFILE_ROW_DISABLES` 是一张常量表，
 * 每条的 `id` 必须是 `cordis.patch.yml` 里真实存在的 Loader 行 id（`insert` 的
 * `id`）。这张表的失效方式是**静默**的：patch 里的 id 被改名后，表里那条 disable
 * 指向一个不存在的行，被裁掉的服务没人管，于是那一行重新 pending —— 而
 * `verify:patch-surface`（只看 insert/override 快照）与 `verify:build` 都不会红。
 * 现有的漂移检测在 `scripts/probe-lite-profile-claude.mjs`（跑真实组合、逐条对
 * 实测 pending），但它是一次几十秒的加载型探针；本脚本补一条**秒级、纯静态**的
 * 断言，让改名在最近的关口就红。
 *
 * 解析方式与 `scripts/verify-patch-surface.ts` 的 `parsePatch` 同口径：`yaml` 包 +
 * 「顶层是 list，`insert: [...]` 里的每项取 `id`」，不自造 YAML 解析器（该文件
 * 是仓库里 patch 语义的唯一权威读法）。
 *
 * 断言：
 *   1. 表非空且 id 不重复（空表/重复表本身就让裁剪静默失效）；
 *   2. 表里每个 id 都能在 `cordis.patch.yml` 的 insert id 集合里找到；
 *   3. 每条 `missing` 非空（missing 为空 = 这条 disable 的依据没了，行该被重新评估）。
 *
 * 跑法：node --import tsx/esm scripts/verify-lite-profile-rows.mjs
 * 退出码：0 = 全部对上；1 = 有 id 在 patch 里找不到（逐条打印）。
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
for (const row of LITE_PROFILE_ROW_DISABLES) {
  if (seen.has(row.id)) failures.push(`duplicate table id: ${row.id}`)
  seen.add(row.id)
  if (!insertIds.has(row.id)) failures.push(`${row.id} — not an insert id in cordis.patch.yml (from ${row.from})`)
  if (row.missing.length === 0) failures.push(`${row.id} — no missing service recorded, the disable has no stated reason`)
}

if (failures.length > 0) {
  console.error(`lite-profile-rows: ${failures.length} problem(s)`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error('Renamed an insert id in cordis.patch.yml? Update LITE_PROFILE_ROW_DISABLES in src/dsh-adapter/lite-profile.ts to match (and re-run scripts/probe-lite-profile-claude.mjs for the measured pending rows).')
  process.exit(1)
}
console.log(`lite-profile-rows OK (${LITE_PROFILE_ROW_DISABLES.length} rows, all present among ${insertIds.size} patch inserts)`)
