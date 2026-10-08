/**
 * Test plugin (accept-host-entry section 8): admitted as the Component
 * `accept-panels`, registers a side panel through `tuiPanels`, opens it, and
 * writes one key through `tuiPluginStorage`. The report records the panel ids
 * the host assigned (prefix = the plugin's own id, not a fallback `act<N>`)
 * and the storage write (the namespace file is named after the identity).
 */
import { admit, manifest, messageOf, report } from './common.mjs'

const PLUGIN = 'panels'

export const name = 'accept-panels'
export const inject = ['tuiPanels']

const SOURCE = manifest({
  id: 'accept-panels',
  requires: [{ apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' }],
  permissions: [
    { name: 'storage.local.read', scope: 'accept-panels' },
    { name: 'storage.local.write', scope: 'accept-panels' },
  ],
})

export function apply(ctx, config) {
  // Detached: an apply that awaits holds the composition (on the profile
  // path the dsh-tui row renders only once every row applied).
  void run(ctx, config).catch(error => report(config, PLUGIN, 'failed', { error: messageOf(error) }))
}

async function run(ctx, config) {
  const identity = await admit(ctx, config, 'panels', SOURCE)
  const dispose = ctx.tuiPanels.register({
    apiVersion: 1,
    id: 'demo',
    title: 'AcceptPanel',
    component: ({ React, ui }) => React.createElement(ui.Text, null, 'ACCEPT-PANEL-BODY'),
  })
  const ids = ctx.tuiPanels.list().map(panel => panel.id)
  report(config, 'panels', 'registered', { ok: typeof dispose === 'function', ids, componentId: identity.componentId })
  // The per-plugin budget (4) counts this activation's panels: three more
  // fit, a fifth is refused. The extras go again right away.
  const extras = ['two', 'three', 'four', 'five'].map(id => ctx.tuiPanels.register({ apiVersion: 1, id, title: id, component: () => null }))
  report(config, 'panels', 'budget', { accepted: extras.filter(entry => typeof entry === 'function').length, fifthRefused: extras[3] === undefined })
  for (const extra of extras) extra?.()
  try {
    const handle = ctx.get('tuiPluginStorage', false).open(ctx)
    await handle.set({ key: 'accept', value: { pid: process.pid } })
    const back = await handle.get({ key: 'accept' })
    report(config, 'panels', 'storage', { ok: back.value?.pid === process.pid })
  } catch (error) {
    report(config, 'panels', 'storage-failed', { error: messageOf(error) })
  }
  // Open it once a screen consumes the request (false until then, without
  // using up the rate-limit window). Not right at the first frame: on the
  // profile path an open accepted ~50ms after the first render was not shown
  // (observed; a screen still settling), and the window is spent then.
  await new Promise(resolve => setTimeout(resolve, 1500))
  const id = ids[0]
  for (let attempt = 0; id !== undefined && attempt < 60; attempt += 1) {
    if (ctx.tuiPanels.open(id)) {
      report(config, 'panels', 'opened', { id, attempt })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  report(config, 'panels', 'open-failed', { id })
}
