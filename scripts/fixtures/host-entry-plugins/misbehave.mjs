/**
 * Test plugin (accept-host-entry section 8): a plugin that fails or holds
 * signals, by its row config `mode`:
 *   apply-throw   throws synchronously from apply (while the profile composes)
 *   throw@<ms>    throws from a timer <ms> after apply (an uncaught exception)
 *   reject@<ms>   leaves a rejected promise unhandled <ms> after apply
 *   signals       installs its own SIGTERM / SIGINT / SIGHUP listeners
 */
import { report } from './common.mjs'

export const name = 'accept-misbehave'

export function apply(ctx, config) {
  const [mode, delay] = String(config.mode).split('@')
  report(config, 'misbehave', 'apply', { mode: config.mode })
  if (mode === 'apply-throw') throw new Error('accept: plugin apply threw')
  if (mode === 'throw') setTimeout(() => { throw new Error('accept: plugin runtime threw') }, Number(delay))
  if (mode === 'reject') setTimeout(() => { void Promise.reject(new Error('accept: plugin runtime rejection')) }, Number(delay))
  if (mode === 'signals') {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => report(config, 'misbehave', 'signal', { signal }))
  }
}
