/**
 * Failure facts carried by a delegation provider's error text.
 *
 * A failed child arrives as one opaque sentence
 * (`Product subagent failure (product: Claude Code; stage: query-run;
 * category: invalid-result; exit code: 1)`). The sentence stays verbatim in
 * the transcript; the fields derived here are only what the channel needs to
 * group failures per provider, so one broken channel cannot read as "every
 * subagent is broken". Parsing is deliberately conservative: text that does
 * not carry the diagnostic shape yields nothing rather than a guess, and the
 * fields are recomputed from `error` at render time rather than stored, so a
 * fresh run can never inherit a stale diagnostic.
 */
import type { SubagentFailure } from '../adapter/ports/channel-view.js'

/** `product: X; stage: Y; category: Z` — the shape every product provider
 *  failure carries, whichever provider wrote it. Every group stops at a
 *  separator or a newline: a stack trace after the sentence must not be
 *  swallowed into `category`, and `product` may legitimately contain `)`. */
const DIAGNOSTIC = /product:\s*([^;\n]+?)\s*;\s*stage:\s*([^;)\n]+?)\s*;\s*category:\s*([^;)\n]+?)\s*(?=[;)\n]|$)/i
const EXIT_CODE = /\bexit code:\s*(-?\d+)/i

export function parseSubagentFailure(text: string | undefined): SubagentFailure | undefined {
  if (text === undefined || text === '') return undefined
  const diagnostic = DIAGNOSTIC.exec(text)
  // `exit code` alone is not a provider diagnostic: a plain subprocess failure
  // (`Bash command failed with exit code: 127`) must stay opaque.
  if (diagnostic === null) return undefined
  const exit = EXIT_CODE.exec(text)
  const exitCode = exit === null ? undefined : Number.parseInt(exit[1] ?? '', 10)
  return {
    product: diagnostic[1],
    stage: diagnostic[2],
    category: diagnostic[3],
    ...exitCode === undefined || Number.isNaN(exitCode) ? {} : { exitCode },
  }
}

export interface ChannelFailureSummary {
  readonly provider: string
  readonly failed: number
  readonly settled: number
}

/**
 * Settled children grouped by the provider that ran them. A settled row is
 * one the provider answered for, so a provider that keeps naming itself in
 * failures can be told apart from one that never ran. `provider` is absent on
 * rows discovered from a durable catalog without a provider name; those are
 * skipped rather than bucketed under a guess.
 *
 * This is a plain count — callers decide what is worth surfacing. The default
 * provider (`subagent`) and one-off failures are ordinary events, not a
 * degraded channel.
 */
export function summarizeChannelFailures(
  rows: readonly { readonly provider?: string | undefined; readonly status: string }[],
): ChannelFailureSummary[] {
  const buckets = new Map<string, { failed: number; settled: number }>()
  for (const row of rows) {
    const provider = row.provider
    if (provider === undefined || provider === '') continue
    if (row.status !== 'failed' && row.status !== 'completed' && row.status !== 'cancelled') continue
    const bucket = buckets.get(provider) ?? { failed: 0, settled: 0 }
    bucket.settled += 1
    if (row.status === 'failed') bucket.failed += 1
    buckets.set(provider, bucket)
  }
  return Array.from(buckets, ([provider, bucket]) => ({ provider, ...bucket }))
    .filter(summary => summary.failed > 0)
    .sort((left, right) => right.failed - left.failed || left.provider.localeCompare(right.provider))
}

/**
 * Whether a summary is worth a banner: at least two failures, and failures at
 * least half of the settled runs on that channel. One failed child on a busy
 * channel is business as usual; a channel failing most of what it runs is not.
 * The default provider is skipped — "switch provider" is not advice anyone can
 * act on for the built-in route.
 */
export function isDegradedChannel(summary: ChannelFailureSummary): boolean {
  if (summary.provider === 'subagent') return false
  return summary.failed >= 2 && summary.failed * 2 >= summary.settled
}
