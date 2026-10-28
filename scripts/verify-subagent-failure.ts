#!/usr/bin/env node --import tsx/esm
/**
 * 子代理失败诊断门禁（issue #1791）。
 *
 * 一串里，某个 delegation provider 连续失败时，转录里只有一句不可拆的
 * 错误文本。`parseSubagentFailure` 把它拆成 `product/stage/category/exitCode`，
 * `summarizeChannelFailures` 再按 provider 聚合，让界面能把「这条通道坏了」
 * 和「所有子代理都坏了」区分开。本脚本钉住这两条纯函数的形状：
 *
 *   - 认标准产品失败句（含 exit code / 不含 exit code）；
 *   - 不把无关错误（限员、空串、普通异常）编造成诊断；
 *   - 聚合只统计有 provider 的已结算行，失败数降序，且不跨 provider 串味。
 *
 * 只读源码里的纯函数，不启宿主、不碰网络。
 */
import { parseSubagentFailure, summarizeChannelFailures } from '../src/channel/subagent-failure.js'

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

const claudeFail = { provider: 'claude-code', status: 'failed', failure: full }
const claudeFail2 = { provider: 'claude-code', status: 'failed', failure: full }
const spawnOk = { provider: 'spawn', status: 'completed' }
const noProvider = { status: 'failed', failure: full }
const summaries = summarizeChannelFailures([claudeFail, claudeFail2, spawnOk, noProvider])
check('groups by provider only', summaries.length === 1 && summaries[0]?.provider === 'claude-code', JSON.stringify(summaries))
check('counts settled and failed', summaries[0]?.failed === 2 && summaries[0]?.settled === 2, JSON.stringify(summaries[0]))
check('drops providers with no failure', !summaries.some(summary => summary.provider === 'spawn'))
const ordered = summarizeChannelFailures([
  { provider: 'b', status: 'failed', failure: full },
  { provider: 'a', status: 'failed', failure: full },
  { provider: 'a', status: 'failed', failure: full },
])
check('orders by failure count', ordered[0]?.provider === 'a' && ordered[1]?.provider === 'b', JSON.stringify(ordered))

if (failed > 0) {
  console.error(`\n子代理失败诊断门禁：${failed} 项失败`)
  process.exit(1)
}
console.log('\n子代理失败诊断门禁：全部通过')
