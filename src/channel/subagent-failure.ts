/**
 * Failure facts carried by a delegation provider's error text.
 *
 * A failed child arrives as one opaque sentence
 * (`Product subagent failure (product: Claude Code; stage: query-run;
 * category: invalid-result; exit code: 1)`). The sentence stays verbatim in
 * the transcript; these fields are the compact form the detail header shows
 * instead of pasting the sentence again, and the channel counts below say
 * whether a provider is failing enough runs to be worth a banner — one broken
 * channel must not read as "every subagent is broken".
 *
 * Parsing is deliberately conservative: text without the diagnostic shape
 * yields nothing rather than a guess, and the fields are recomputed from
 * `error` at render time rather than stored, so a fresh run can never inherit
 * a stale diagnostic.
 */
import type { SubagentStatus } from '../adapter/ports/channel-view.js'

export interface SubagentFailure {
  readonly product?: string
  readonly stage?: string
  readonly category?: string
  readonly exitCode?: number
}

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
  const exitCode = exit === null ? undefined : Number.parseInt(exit[1], 10)
  return {
    product: diagnostic[1],
    stage: diagnostic[2],
    category: diagnostic[3],
    ...(exitCode === undefined ? {} : { exitCode }),
  }
}

export interface ChannelFailureSummary {
  readonly provider: string
  readonly failed: number
  /** Runs the provider answered for: `failed + completed`. A user-cancelled
   *  child did not get an answer, so cancelling must not dilute the rate that
   *  decides a banner. */
  readonly settled: number
}

/**
 * Children the provider answered for, grouped by that provider. `provider` is
 * absent on rows discovered from a durable catalog without a provider name;
 * `''` reaches here from a host registry that reported an empty name. Both are
 * skipped rather than bucketed under a guess.
 *
 * This is a plain count — callers decide what is worth surfacing.
 */
export function summarizeChannelFailures(
  rows: readonly { readonly provider?: string | undefined; readonly status: SubagentStatus }[],
): ChannelFailureSummary[] {
  const buckets = new Map<string, { failed: number; settled: number }>()
  for (const row of rows) {
    const provider = row.provider
    if (provider === undefined || provider === '') continue
    if (row.status !== 'failed' && row.status !== 'completed') continue
    const bucket = buckets.get(provider) ?? { failed: 0, settled: 0 }
    bucket.settled += 1
    if (row.status === 'failed') bucket.failed += 1
    buckets.set(provider, bucket)
  }
  return Array.from(buckets, ([provider, bucket]) => ({ provider, ...bucket }))
    .filter(summary => summary.failed > 0)
    .sort((left, right) => right.failed - left.failed || left.provider.localeCompare(right.provider))
}

/** Buckets that are not switchable delegation routes: the built-in `subagent`
 *  default (`onSpawned`'s `provider = 'subagent'`) and the workflow member lane
 *  (`subagent-projection.ts` writes `provider: 'workflow'`). "Switch provider"
 *  is not advice anyone can act on for either. */
const SYNTHETIC_BUCKETS = new Set(['subagent', 'workflow'])

/**
 * Whether a summary is worth a banner: at least two failures, and failures at
 * least half of the runs that got an answer. One failed child is business as
 * usual; a channel failing most of what it runs is not.
 */
export function isDegradedChannel(summary: ChannelFailureSummary): boolean {
  if (SYNTHETIC_BUCKETS.has(summary.provider)) return false
  return summary.failed >= 2 && summary.failed * 2 >= summary.settled
}
