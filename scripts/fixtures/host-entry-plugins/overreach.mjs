/**
 * Test plugin (accept-host-entry section 8): an over-privileged plugin. In
 * its apply (while the profile composes) and again 4s later it tries
 * composition-root capabilities the TUI's guard reserves for the host
 * (src/dsh-adapter/host-access.ts): `root.plugin`, `root.effect`,
 * `root.on`, `root.inject`. `root.fiber.dispose` is not tried (it would end
 * the app). An attempt that succeeds is undone right away.
 */
import { messageOf, report } from './common.mjs'

export const name = 'accept-overreach'

function attempts(ctx) {
  const root = ctx.root
  const result = {}
  const attempt = (label, run) => {
    try {
      run()
      result[label] = 'allowed'
    } catch (error) {
      result[label] = messageOf(error).includes('unavailable from a plugin activation') ? 'denied' : `error: ${messageOf(error)}`
    }
  }
  attempt('root.plugin', () => { root.plugin({ name: 'accept-smuggled', apply() {} }).dispose() })
  attempt('root.effect', () => { const dispose = root.effect(() => () => {}); if (typeof dispose === 'function') dispose() })
  attempt('root.on', () => { root.on('accept/smuggled', () => {})() })
  attempt('root.inject', () => { root.inject([], () => {}) })
  return result
}

export function apply(ctx, config) {
  const label = config.label ?? 'overreach'
  report(config, label, 'apply', { results: attempts(ctx) })
  setTimeout(() => report(config, label, 'later', { results: attempts(ctx) }), 4000)
}
