/**
 * An isolated copy of the installed dsh-tui profile running this checkout's
 * `bin/` and `lib/`, shared by probe-startup-baseline.mjs and
 * accept-host-entry.mjs. Never touches the real profile.
 *
 * Requires the installed `dsh` on PATH and its `dsh-tui` profile (under
 * `$DSH_HOME`, default `~/.dsh`), and `pnpm compile` in this checkout.
 *
 * Layout under a fresh temp root:
 *   .dsh/profiles/dsh-tui/   package.json (dsh-purge dropped), an empty
 *                            patch layer, the profile's cordis.yml;
 *     node_modules/          every installed package linked, the host's
 *                            schemastery, this checkout's Claude Agent SDK
 *                            linked, and dsh-tui as a real copy with this
 *                            checkout's bin/ and lib/ — so its imports
 *                            resolve through this profile (one Cordis).
 *
 * dsh-purge (when the profile bundles it) patches the GLOBAL dsh bin.js on
 * every start (autoApplyOnStart): an isolated run must never load it. The
 * profile's own patch layer goes too; its rows only configure it.
 *
 * This is not the pnpm-installed shape (there dsh-tui is a link into the
 * virtual store), so it cannot stand in for a real `dsh plugin add` install.
 *
 * `dshBin` must lead PATH for anything that starts dsh against this profile.
 * dsh routes a profile's shared packages (react) itself, and run from its
 * global install it routes this hand-assembled profile's react to the copy
 * inside the globally installed dsh-tui launcher package: two Reacts, and the
 * DSH-kernel TUI never mounts (empty frames, no raw mode). A dsh whose `lib/`
 * sits outside the global install (its `node_modules` still linked) routes
 * correctly. A dsh-installed profile is unaffected.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, relative } from 'node:path'

const EXCLUDED = new Set(['dsh-purge'])

/** The real path of a launcher on PATH. */
export function executable(name) {
  const path = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, name)).find(existsSync)
  if (path === undefined) throw new Error(`missing launcher: ${name}`)
  return realpathSync(path)
}

/**
 * Build the isolated profile.
 * @param {{ repo: string, prefix?: string, profilesNodeModules?: boolean }} options - `repo`: this checkout;
 *   `profilesNodeModules: false` leaves out the link to the source home's
 *   `profiles/node_modules` (a fresh dsh 0.2 install may have none).
 * @returns {{ root: string, dshHome: string, profile: string, launcher: string, dshEntry: string, dshBin: string }}
 */
export function buildIsolatedProfile({ repo, prefix = 'dsh-tui-isolated-', profilesNodeModules = true }) {
  if (!existsSync(join(repo, 'lib', 'types', 'index.js'))) throw new Error('run pnpm compile first')
  const dshEntry = executable('dsh')
  const sourceHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const sourceProfile = join(sourceHome, 'profiles', 'dsh-tui')
  const root = mkdtempSync(join(tmpdir(), prefix))
  const dshHome = join(root, '.dsh')
  const profile = join(dshHome, 'profiles', 'dsh-tui')
  const modules = join(profile, 'node_modules')
  mkdirSync(modules, { recursive: true, mode: 0o700 })
  const manifest = JSON.parse(readFileSync(join(sourceProfile, 'package.json'), 'utf8'))
  for (const name of EXCLUDED) delete manifest.dependencies?.[name]
  if (Array.isArray(manifest.dsh?.profile?.bundles)) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => !EXCLUDED.has(name))
  }
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  if (existsSync(join(sourceProfile, 'cordis.yml'))) cpSync(join(sourceProfile, 'cordis.yml'), join(profile, 'cordis.yml'))
  for (const entry of readdirSync(join(sourceProfile, 'node_modules'))) {
    if (entry === '@deepseek-harness-tui' || entry === '@anthropic-ai' || entry === '@deepseek-ai' || EXCLUDED.has(entry)) continue
    symlinkSync(join(sourceProfile, 'node_modules', entry), join(modules, entry), 'dir')
  }
  // A profile installed before DSH 0.2 can hold a schemastery without
  // volatile Config support, which the TUI refuses; take the host's own copy
  // (what a fresh profile install resolves).
  mkdirSync(join(modules, '@deepseek-ai'))
  const hostRequire = createRequire(dshEntry)
  for (const entry of readdirSync(join(sourceProfile, 'node_modules', '@deepseek-ai'))) {
    const target = entry === 'schemastery'
      ? dirname(hostRequire.resolve('@deepseek-ai/schemastery/package.json'))
      : join(sourceProfile, 'node_modules', '@deepseek-ai', entry)
    symlinkSync(target, join(modules, '@deepseek-ai', entry), 'dir')
  }
  const tuiPackage = join(modules, '@deepseek-harness-tui', 'dsh-tui')
  cpSync(join(sourceProfile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'), tuiPackage, { recursive: true, dereference: false })
  for (const dir of ['bin', 'lib']) {
    rmSync(join(tuiPackage, dir), { recursive: true, force: true })
    cpSync(join(repo, dir), join(tuiPackage, dir), { recursive: true })
  }
  mkdirSync(join(modules, '@anthropic-ai'))
  symlinkSync(realpathSync(join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')), join(modules, '@anthropic-ai', 'claude-agent-sdk'), 'dir')
  const fallback = join(sourceHome, 'profiles', 'node_modules')
  if (profilesNodeModules && existsSync(fallback)) symlinkSync(fallback, join(dshHome, 'profiles', 'node_modules'), 'dir')
  return { root, dshHome, profile, launcher: join(tuiPackage, 'bin', 'dsh-tui.js'), dshEntry, dshBin: relocateDsh(root, dshEntry) }
}

/** A `dsh` on `<root>/dsh-bin` whose `lib/` is a copy outside the global
 *  install (see the header); everything else links back. Returns the bin dir. */
function relocateDsh(root, dshEntry) {
  let packageDir = dirname(dshEntry)
  while (!existsSync(join(packageDir, 'package.json'))) packageDir = dirname(packageDir)
  const host = join(root, 'dsh-host')
  rmSync(host, { recursive: true, force: true })
  mkdirSync(host)
  for (const entry of readdirSync(packageDir)) {
    if (entry === 'lib') cpSync(join(packageDir, 'lib'), join(host, 'lib'), { recursive: true })
    else symlinkSync(join(packageDir, entry), join(host, entry))
  }
  const bin = join(root, 'dsh-bin')
  mkdirSync(bin, { recursive: true })
  const entry = join(host, relative(packageDir, dshEntry))
  // A link, as npm installs a bin: the package entry finds the host package
  // from the realpath of the `dsh` on PATH (src/dsh-adapter/host-dsh.ts).
  chmodSync(entry, 0o755)
  symlinkSync(entry, join(bin, 'dsh'))
  return bin
}
