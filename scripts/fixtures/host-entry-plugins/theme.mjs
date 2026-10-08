/**
 * Test plugin (accept-host-entry section 8): one runtime theme through
 * `tuiThemes`, its palette keys one odd colour (#ab12cd) so the screen's
 * cells tell whether it is the theme in use.
 */
import { messageOf, report } from './common.mjs'

export const name = 'accept-theme'
export const inject = ['tuiThemes']

const KEYS = 'autoAccept bashBorder accent toolNameMutate toolNameExec accentShimmer activity activityShimmer permission permissionShimmer planMode ide promptBorder promptBorderShimmer text inverseText inactive inactiveShimmer subtle suggestion remember success error warning merged warningShimmer userPromptLabel'.split(' ')

export function apply(ctx, config) {
  try {
    const dispose = ctx.tuiThemes.register({
      name: 'accept-theme',
      displayName: 'Accept Theme',
      base: 'dark',
      colors: Object.fromEntries(KEYS.map(key => [key, '#ab12cd'])),
    })
    report(config, 'theme', 'registered', { ok: typeof dispose === 'function' })
  } catch (error) {
    report(config, 'theme', 'register-failed', { error: messageOf(error) })
  }
}
