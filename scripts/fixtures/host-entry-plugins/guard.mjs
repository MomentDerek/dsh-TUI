/**
 * Test plugin (accept-host-entry section 8): admitted as the Component
 * `accept-guard`, intercepts `tui/input` (rewrites "accept-rewrite", vetoes
 * "accept-veto") and `tui/session-switch` (vetoes every switch). Plain
 * `ctx.on`: the host mediates it into its DecisionEvents registry by the
 * verified identity and the grants file.
 */
import { admit, manifest, messageOf, report } from './common.mjs'

const PLUGIN = 'guard'

export const name = 'accept-guard'
// Without an inject the row applies as soon as its module loads, which can
// be before the host's rows have (no `tuiPluginHost` yet): wait for it.
export const inject = ['tuiPluginHost']

const SOURCE = manifest({
  id: 'accept-guard',
  requires: [{ apiVersion: 'tui.dsh/v1alpha1', kind: 'DecisionEvents' }],
  permissions: [
    { name: 'session.input.intercept', scope: 'tui/input' },
    { name: 'session.switch.intercept', scope: 'tui/session-switch' },
  ],
})

export function apply(ctx, config) {
  // Detached: an apply that awaits holds the composition (on the profile
  // path the dsh-tui row renders only once every row applied).
  void run(ctx, config).catch(error => report(config, PLUGIN, 'failed', { error: messageOf(error) }))
}

async function run(ctx, config) {
  report(config, 'guard', 'apply')
  const identity = await admit(ctx, config, 'guard', SOURCE)
  ctx.on('tui/input', payload => {
    const text = String(payload.text ?? '')
    report(config, 'guard', 'input', { text, componentId: identity.componentId })
    if (text.startsWith('accept-rewrite')) return { text: 'ACCEPT-REWRITTEN' }
    if (text.startsWith('accept-veto')) return { cancel: true, reason: 'ACCEPT-VETOED by accept-guard' }
    return undefined
  })
  ctx.on('tui/session-switch', payload => {
    report(config, 'guard', 'session-switch', { kind: payload.kind, componentId: identity.componentId })
    return { cancel: true, reason: 'ACCEPT-SWITCH-VETOED by accept-guard' }
  })
  report(config, 'guard', 'subscribed', { componentId: identity.componentId })
}
