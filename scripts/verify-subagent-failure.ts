#!/usr/bin/env node --import tsx/esm
/**
 * 子代理失败诊断门禁（issue #1791）。
 *
 * 一串里，某个 delegation provider 连续失败时，转录里只有一句不可拆的
 * 错误文本。`parseSubagentFailure` 把它拆成 `product/stage/category/exitCode`，
 * `summarizeChannelFailures` 按 provider 聚合，`isDegradedChannel` 决定值不值得
 * 弹横幅。本脚本钉住这三条纯函数的形状：
 *
 *   - 认标准产品失败句（含 exit code / 不含 exit code），且只靠 `exit code`
 *     不成诊断（普通子进程失败必须保持不透明）；
 *   - 句子截在分隔符或换行：后面的 stack trace 不得被吞进 `category`；
 *   - 聚合只统计有 provider 的已结算行，`cancelled` 计结算、`running` 不计；
 *   - 横幅阈值：单次失败不弹、内建 `subagent` 桶不弹、多数失败才弹。
 *
 * 只读源码里的纯函数，不启宿主、不碰网络。
 */
import { isDegradedChannel, parseSubagentFailure, summarizeChannelFailures } from '../src/channel/subagent-failure.js'

let failed = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
    return
  }
  failed += 1
  console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const PRODUCT_FAILURE = 'Error: subagent-claude-code: Product subagent failure (product: Claude Code; stage: query-run; category: invalid-result; exit code: 1)'
const START_FAILURE = 'Error: subagent-claude-code: Product subagent failure (product: Claude Code; stage: query-start; category: unknown)'

const full = parseSubagentFailure(PRODUCT_FAILURE)
check('parses product/stage/category/exitCode', full?.product === 'Claude Code'
  && full.stage === 'query-run' && full.category === 'invalid-result' && full.exitCode === 1, JSON.stringify(full))
check('parses a diagnostic without exit code', (() => {
  const start = parseSubagentFailure(START_FAILURE)
  return start?.stage === 'query-start' && start.category === 'unknown' && start.exitCode === undefined
})())
check('keeps unrelated errors opaque', parseSubagentFailure('Error: Team member limit 8 reached') === undefined)
check('ignores empty input', parseSubagentFailure('') === undefined && parseSubagentFailure(undefined) === undefined)

// `exit code` alone must not fabricate a diagnostic: `reason` also carries
// plain subprocess failures, and a bogus "channel diagnostic" line is worse
// than no line.
check('exit code alone is not a diagnostic', parseSubagentFailure('Bash command failed with exit code: 127') === undefined)
check('exit code may be negative', parseSubagentFailure(`${PRODUCT_FAILURE.replace('exit code: 1', 'exit code: -1')}`)?.exitCode === -1)

// A stack trace after the sentence must stop at the newline, not widen `category`.
const WITH_TRACE = 'Error: subagent-claude-code: Product subagent failure (product: Claude Code; stage: query-run; category: invalid-result)\n    at Query.run (file:///x/y.js:12:3)\n    at async main'
check('stops at the newline before a stack trace', parseSubagentFailure(WITH_TRACE)?.category === 'invalid-result', JSON.stringify(parseSubagentFailure(WITH_TRACE)))
check('keeps a product name containing a paren', parseSubagentFailure('Product subagent failure (product: Claude Code (CLI); stage: query-run; category: invalid-result)')?.product === 'Claude Code (CLI)')

const claudeFail = { provider: 'claude-code', status: 'failed' }
const claudeOk = { provider: 'claude-code', status: 'completed' }
const spawnOk = { provider: 'spawn', status: 'completed' }
const noProvider = { status: 'failed' }
const summaries = summarizeChannelFailures([claudeFail, claudeFail, claudeOk, spawnOk, noProvider])
check('groups by provider only', summaries.length === 1 && summaries[0]?.provider === 'claude-code', JSON.stringify(summaries))
check('counts settled and failed', summaries[0]?.failed === 2 && summaries[0]?.settled === 3, JSON.stringify(summaries[0]))
check('drops providers with no failure', !summaries.some(summary => summary.provider === 'spawn'))

const mixed = summarizeChannelFailures([
  { provider: 'mixed', status: 'failed' },
  { provider: 'mixed', status: 'failed' },
  { provider: 'mixed', status: 'cancelled' },
  { provider: 'mixed', status: 'running' },
  { provider: 'mixed', status: 'unknown' },
])
check('counts cancelled as settled and running/unknown as not settled', mixed[0]?.failed === 2 && mixed[0]?.settled === 3, JSON.stringify(mixed))

const ordered = summarizeChannelFailures([
  { provider: 'b', status: 'failed' },
  { provider: 'a', status: 'failed' },
  { provider: 'a', status: 'failed' },
])
check('orders by failure count', ordered[0]?.provider === 'a' && ordered[1]?.provider === 'b', JSON.stringify(ordered))

check('one failure is not a degraded channel', !isDegradedChannel({ provider: 'claude-code', failed: 1, settled: 1 }))
check('the default provider is never bannered', !isDegradedChannel({ provider: 'subagent', failed: 9, settled: 9 }))
check('a channel failing most runs is degraded', isDegradedChannel({ provider: 'claude-code', failed: 9, settled: 9 })
  && isDegradedChannel({ provider: 'claude-code', failed: 3, settled: 5 })
  && !isDegradedChannel({ provider: 'claude-code', failed: 2, settled: 9 }))

if (failed > 0) {
  console.error(`\n子代理失败诊断门禁：${failed} 项失败`)
  process.exit(1)
}
console.log('\n子代理失败诊断门禁：全部通过')
