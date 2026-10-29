/**
 * Channel-level failure counts for delegation children.
 *
 * A failed child's own error text stays where the backend put it; this module
 * only counts how many runs a provider answered and how many of those failed,
 * so one broken channel cannot read as "every subagent is broken". It never
 * invents a diagnosis: the per-item `product/stage/category` sentence a
 * product provider emits reaches the transcript as a tool result, not as
 * `SubagentState.error`, so parsing it here would be parsing a field that
 * never carries it.
 */
import type { SubagentStatus } from '../adapter/ports/channel-view.js'

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
 * This is a plain count — callers decide what is worth surfacing. It counts
 * rows, not attempts: a continuable child that is respawned under a new
 * `runId` resets to `running`, so repeated failures of one child collapse into
 * whatever its last settlement was. Every failure in #1791 was a distinct
 * child, which is the case this covers; the retry-of-one-child case does not
 * accumulate, and the banner therefore stays quiet there.
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

/**
 * Product delegation routes whose provider a user can actually swap: the
 * `provider:` values of the shipped `tool-subagent-*` preset rows for the
 * Claude Code and Codex products.
 *
 * Everything else is excluded on purpose. The built-in `subagent` default, the
 * workflow member lane (`subagent-projection.ts` writes `provider:
 * 'workflow'`), and the Claude backend's per-child `subagent_type` (`Explore`,
 * `general-purpose`, …) are not switchable routes, so a banner offering
 * "switch provider" would be advice nobody can act on. This is a positive
 * list, not an exclusion list: a new backend inventing a provider name must
 * opt in rather than start bannering by default.
 */
const SWITCHABLE_PRODUCT_PROVIDERS = new Set(['claude-code', 'codex'])

/**
 * Whether a summary is worth a banner: a switchable product route, at least
 * two failures, and failures at least half of the runs that got an answer.
 * One failed child is business as usual; a channel failing most of what it
 * runs is not.
 */
export function isDegradedChannel(summary: ChannelFailureSummary): boolean {
  if (!SWITCHABLE_PRODUCT_PROVIDERS.has(summary.provider)) return false
  return summary.failed >= 2 && summary.failed * 2 >= summary.settled
}
