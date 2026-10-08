/**
 * Shared helpers for the third-party test plugins of
 * scripts/accept-host-entry.mjs (section 8). Repository-internal test
 * fixtures: not shipped (package.json `files`), never loaded by a product
 * path. Each plugin gets its row `config` from the acceptance script:
 *   report   a JSONL file every plugin appends its observations to
 *   adapter  file URL of the running dsh-tui copy's
 *            lib/types/dsh-adapter/plugin-host.js (admission, see below)
 */
import { appendFileSync } from 'node:fs'

/** Append one observation (`plugin`, `event`, the rest) to the report. */
export function report(config, plugin, event, data = {}) {
  try {
    appendFileSync(config.report, `${JSON.stringify({ plugin, event, pid: process.pid, at: Date.now(), ...data })}\n`)
  } catch { /* the acceptance script reads what is there */ }
}

/** The message of a caught value. */
export const messageOf = error => error instanceof Error ? error.message : String(error)

/** A Community v0.15 manifest (scripts/lib/plugin-test-utils.ts testManifest). */
export function manifest({ id, requires = [], permissions = [] }) {
  return JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    id,
    name: id,
    version: '0.1.0',
    manifestVersion: '0.15',
    facets: { host: { entry: 'dist/main.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: requires },
    permissions,
    contributes: { commands: [] },
    subscriptions: [],
    license: 'MIT',
    source: { repository: 'https://example.com/accept-host-entry' },
  })
}

/**
 * Admit this activation as the Component `source` describes and return its
 * verified identity. The product has no admission loader yet (no product
 * code calls `getHostAdmission`): without this step a plugin has no verified
 * identity on either path — panels fall back to an `act<N>` prefix, and
 * DecisionEvents / storage.local refuse it. The fixture plays that loader,
 * through the same adapter module instance the TUI runs (a second instance
 * would not know the host: "host state is unavailable").
 *
 * Retries a refused admission for up to 20s: a required contract is only on
 * the host descriptor once its source is live (DecisionEvents: the channel's
 * dispatch, which on the profile path exists only after every row applied).
 * The activation's async context carries over to the timer, as it does for
 * any plugin callback.
 */
export async function admit(ctx, config, plugin, source) {
  let getHostAdmission
  let host
  try {
    ({ getHostAdmission } = await import(config.adapter))
    host = ctx.get('tuiPluginHost', false)
    if (host === undefined) throw new Error('tuiPluginHost is not mounted')
  } catch (error) {
    report(config, plugin, 'admission-failed', { error: messageOf(error) })
    throw error
  }
  let lastError
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const identity = getHostAdmission(host).admit(ctx, source, { source: `accept:${plugin}/dsh-plugin.json` })
      report(config, plugin, 'admitted', { componentId: identity.componentId, activationId: identity.activationId, attempt })
      return identity
    } catch (error) {
      lastError = error
      if (attempt === 0) report(config, plugin, 'admission-retry', { error: messageOf(error) })
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  report(config, plugin, 'admission-failed', { error: messageOf(lastError) })
  throw lastError
}
