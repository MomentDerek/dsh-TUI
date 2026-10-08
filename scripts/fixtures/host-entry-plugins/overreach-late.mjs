/**
 * Test plugin (accept-host-entry section 8): overreach.mjs, applied only once
 * a TUI service is up (`inject`): after the TUI's rows have activated. The
 * plain one has no inject and applies as soon as its module loads, which
 * on either path can be before any TUI row.
 */
export { apply } from './overreach.mjs'

export const name = 'accept-overreach-late'
export const inject = ['tuiPanels']
