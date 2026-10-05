/**
 * SPIKE (docs/standalone-host-design.md, Phase 1 upper-bound measurement) —
 * not a deliverable, not committed. Mounts the TUI runtime on a bare Cordis
 * root without composing any DSH profile: the cordis.patch.yml dsh-tui row's
 * config is rebuilt from the environment and handed straight to the runtime
 * apply (skipping index.ts's Loader wait). Settings use the schema defaults,
 * read-only.
 *
 * Run: node lib/types/dsh-adapter/spike-entry.js (inside a profile whose
 * node_modules resolve @deepseek-ai/cordis and the Claude Agent SDK).
 */
import '../force-production-react.js'
import { markBoot } from '../utils/bootTrace.js'
import type { Config as TuiConfig } from './index.js'

markBoot('entry-start')
const [{ Context }, { Config }, { apply, handleStartupError }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('./index.js'),
  import('./plugin.js'),
])
markBoot('entry-modules')
const ctx = new Context()
const env = process.env
const config = Config({
  provider: 'deepseek-official',
  fullscreen: true,
  terminalImages: true,
  effort: 'max',
  ...(env.DSH_TUI_PRESET === undefined ? {} : { preset: env.DSH_TUI_PRESET }),
  ...(env.DSH_TUI_WORKSPACE_TARGET === undefined ? {} : { workspace: env.DSH_TUI_WORKSPACE_TARGET }),
  ...(env.DSH_TUI_RESUME_SESSION === undefined ? {} : { sessionId: env.DSH_TUI_RESUME_SESSION }),
  ...(env.DSH_TUI_BACKEND === undefined ? {} : { backend: env.DSH_TUI_BACKEND as TuiConfig['backend'] }),
})
markBoot('entry-config')
try {
  await apply(ctx, config, ctx)
} catch (error) {
  handleStartupError(ctx, error)
}
