#!/usr/bin/env node
/**
 * `lib/types` must be the bundled shape the build step produces, not a
 * leftover `tsc` tree (docs/standalone-host-design.md 6.1).
 *
 * `pnpm compile` runs `tsc` and then `scripts/bundle-lib.mjs`, which folds
 * every module into `chunks/` and removes the originals. A `tsc` run on its own
 * — an editor's watch, a hand-run `tsc -p tsconfig.json`, an interrupted
 * compile — puts those 1600+ files back next to the bundle. They still import
 * each other by relative path, so anything that reached one of them would load
 * a second copy of the graph beside the entry's chunk: two Cordis singletons,
 * the plugin row never activates, and the entry silently stops being the only
 * instance. Nothing about that failure is visible from the outside, so it is
 * checked structurally here.
 *
 * The gate compares the tree against the manifest the bundle step wrote: the
 * set of files must be exactly the entries plus the chunks.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libRoot = join(repo, 'lib', 'types')
const manifestPath = join(libRoot, 'bundle-manifest.json')

const failures = []
const fail = message => failures.push(message)

if (!existsSync(join(libRoot, 'index.js'))) {
  fail('lib/types/index.js is missing — run `pnpm compile`')
} else if (!existsSync(manifestPath)) {
  fail('lib/types/bundle-manifest.json is missing — `tsc` ran without scripts/bundle-lib.mjs')
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const onDisk = new Set()
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) onDisk.add(relative(libRoot, full).split(sep).join('/'))
    }
  }
  walk(libRoot)
  const expected = new Set([...manifest.entries.map(entry => `${entry}.js`), ...manifest.chunks])
  const unexpected = [...onDisk].filter(file => !expected.has(file)).sort()
  const missing = [...expected].filter(file => !onDisk.has(file)).sort()
  const strays = unexpected.filter(file => !file.startsWith('chunks/'))
  if (strays.length > 0) {
    fail(
      `${strays.length} module file(s) are back outside the bundle (the second-copy state):\n` +
        strays.slice(0, 10).map(file => `    lib/types/${file}`).join('\n') +
        (strays.length > 10 ? `\n    … and ${strays.length - 10} more` : ''),
    )
  }
  if (missing.length > 0) {
    fail(`manifest lists ${missing.length} file(s) that are not on disk: ${missing.slice(0, 10).join(', ')}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log('✓ lib/types matches the bundle manifest')
