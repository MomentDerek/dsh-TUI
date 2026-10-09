#!/usr/bin/env node
/**
 * Bundle `lib/types` in place (docs/standalone-host-design.md 6.1).
 *
 * Why: the entry loads this package's ~870 ESM module files before the first
 * frame, and resolving and linking them dominates that stretch — the CPU
 * profile is `compileSourceTextModule` / `internalModuleStat` / `ModuleWrap` /
 * `lstat` / `realpathSync` / `readPackageManifest`, while I/O was measured at
 * 72ms for 887 modules. Folding them into a handful of chunks removes the
 * per-module cost without touching the source.
 *
 * The entry set is deliberately wide. `bin/dsh-tui.js` loads
 * `lib/types/update.js` and `lib/types/dsh-adapter/migrate/cli.js` by path, the
 * sixel renderer spawns `lib/types/ink/sixel-worker.js` as a Worker by URL, and
 * ~110 focused verify scripts import one module each by path. Every one of them
 * must land on a bundle output, otherwise it would load a second copy of the
 * module graph next to the entry's chunk (two Cordis singletons, and the plugin
 * row does not activate).
 *
 * So this is not "inline the entry": every path that something outside the
 * bundle can reach becomes an entry, and everything they share is extracted
 * into `lib/types/chunks/`. An entry whose module is shared becomes a facade
 * (`export { x } from '../chunks/…js'`) at its original path, which is what
 * keeps `DSH_TUI_HOST_ENTRY_PATH`, the package `exports` map and every verify
 * import working unchanged.
 *
 * Measured against a same-window baseline the first frame drops ~20% (real
 * HOME: 1064ms → 852ms; isolated without the timing hook: 1555ms → 1223ms).
 * Larger deltas quoted with the ESM load hook installed are inflated — the
 * hook's per-module cost lands on the baseline's 2322 modules much harder than
 * on the bundle's 1705. Shrinking the 7.7MB product does not help either: a
 * comment-stripped 5.25MB build measured *slower* across three same-window
 * rounds, so the cost is the per-module work, not the bytes.
 *
 * `.d.ts` files are untouched: `tsc` stays the type checker and the published
 * `types` conditions keep pointing at the same paths.
 *
 * Usage: node scripts/bundle-lib.mjs [--out <dir>] [--report <file>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rollup } from 'rollup'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libRoot = join(repo, 'lib', 'types')
const MANIFEST_NAME = '@deepseek-harness-tui/dsh-tui'
/** Written next to the bundle: the shape `verify:lib-bundle` checks. */
const MANIFEST_FILE = 'bundle-manifest.json'

/** Modules reached at runtime by path/URL rather than through the `exports`
 *  map. Keep in sync with the loaders named in the header. */
const EXTRA_ENTRIES = [
  // bin/dsh-tui.js `hostEntry` / DSH_TUI_HOST_ENTRY_PATH (/restart, /kernel).
  './lib/types/dsh-adapter/host-entry.js',
  // new Worker(new URL('./sixel-worker.js', import.meta.url)) in sixel-graphics.
  './lib/types/ink/sixel-worker.js',
]

const SOURCE_DIRS = ['scripts', 'bin']
const LIB_PATH_RE = /lib\/types\/[A-Za-z0-9_./-]+\.js/gu

/**
 * Every existing `lib/types/...js` path mentioned by the launcher or a script.
 * Matches strings, not imports: a path only has to be reachable by path to
 * need a bundle output at that path. Absent paths are skipped on purpose —
 * verify-compat-removal.ts lists removed modules as strings to assert they are
 * gone, and comments contain abbreviated examples.
 * @returns {Set<string>} Repo-relative paths.
 */
function referencedLibPaths() {
  const found = new Set()
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(mjs|js|ts|tsx)$/u.test(entry.name)) {
        for (const match of readFileSync(full, 'utf8').matchAll(LIB_PATH_RE)) {
          if (existsSync(join(repo, match[0]))) found.add(match[0])
        }
      }
    }
  }
  for (const dir of SOURCE_DIRS) {
    const full = join(repo, dir)
    if (existsSync(full)) walk(full)
  }
  return found
}

/** The `import`/`default` target of every `exports` subpath: every external
 *  load path that resolves through the package map. */
function exportTargets() {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const targets = []
  for (const value of Object.values(pkg.exports ?? {})) {
    const target = typeof value === 'string' ? value : (value?.import ?? value?.default)
    if (typeof target === 'string') targets.push(target)
  }
  return targets
}

/** Rollup entry name for a repo-relative lib path (no extension, POSIX). */
const entryName = repoRel => relative(libRoot, join(repo, repoRel)).split(sep).join('/').replace(/\.js$/u, '')

function collectInputs() {
  const inputs = {}
  const missing = []
  const add = repoRel => {
    const path = join(repo, repoRel)
    if (!path.startsWith(libRoot + sep) || !existsSync(path)) {
      missing.push(repoRel)
      return
    }
    inputs[entryName(repoRel)] = path
  }
  for (const target of exportTargets()) {
    if (target.startsWith('./lib/types/') && target.endsWith('.js')) add(target.slice(2))
  }
  for (const target of EXTRA_ENTRIES) add(target.slice(2))
  for (const target of referencedLibPaths()) add(target)
  return { inputs, missing }
}

/**
 * `import.meta.url` restored to the *source* module's location.
 *
 * A bundled module runs from `chunks/`, so its own `import.meta.url` would
 * point there and silently break every locator built on it: the spec root
 * probes, `packagedPresetRoot`, the companion art paths, `resolveOwnBin`, the
 * `createRequire` bases. The replacement resolves the same URL from the
 * package root, so module-relative arithmetic keeps working after bundling.
 */
const ORIGIN_ID = '\0dsh-tui-origin'
const ORIGIN_SOURCE = `
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const findRoot = start => {
  let dir = start
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === ${JSON.stringify(MANIFEST_NAME)}) return dir
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}
const packageRoot = findRoot(dirname(fileURLToPath(import.meta.url)))
export const originUrl = relativePath => pathToFileURL(join(packageRoot, relativePath)).href
`

function originPlugin() {
  return {
    name: 'dsh-tui-origin-url',
    resolveId: source => (source === ORIGIN_ID ? ORIGIN_ID : null),
    load: id => (id === ORIGIN_ID ? ORIGIN_SOURCE : null),
    transform(code, id) {
      if (!id.startsWith(libRoot + sep) || !id.endsWith('.js')) return null
      if (!code.includes('import.meta.url')) return null
      const repoRel = `lib/types/${relative(libRoot, id).split(sep).join('/')}`
      const replaced = code.replace(/\bimport\.meta\.url\b/gu, `__originUrl(${JSON.stringify(repoRel)})`)
      return {
        code: `import { originUrl as __originUrl } from ${JSON.stringify(ORIGIN_ID)}\n${replaced}`,
        map: null,
      }
    },
  }
}

/** Snapshot every lib file so the report can say what was folded in. */
function libFiles() {
  const out = new Set()
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.add(full)
    }
  }
  walk(libRoot)
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const outDir = outIndex === -1 ? libRoot : resolve(argv[outIndex + 1])
  const reportIndex = argv.indexOf('--report')
  const reportPath = reportIndex === -1 ? undefined : resolve(argv[reportIndex + 1])

  if (!existsSync(join(libRoot, 'index.js'))) throw new Error('lib/types is missing — run tsc first')
  const before = libFiles()
  // Bundling a bundle nests chunk names and drops the modules tsc has not
  // re-emitted yet. `pnpm compile` cleans `lib/` first, so this only catches a
  // hand-run second pass.
  const previousManifest = join(libRoot, MANIFEST_FILE)
  if (existsSync(previousManifest)) {
    const previous = JSON.parse(readFileSync(previousManifest, 'utf8'))
    const known = new Set([...previous.entries.map(entry => `${entry}.js`), ...previous.chunks])
    const alreadyBundled = [...before].every(path => known.has(relative(libRoot, path).split(sep).join('/')))
    if (alreadyBundled) {
      throw new Error('lib/types is already bundled — run `pnpm compile` (it starts from a clean lib) rather than bundling twice')
    }
  }
  const { inputs, missing } = collectInputs()
  if (missing.length > 0) throw new Error(`entry outside lib/types or absent: ${missing.join(', ')}`)
  if (outDir !== libRoot) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const warnings = []
  /** Module id → its export names, read while the bundle is open. */
  const moduleExports = new Map()
  const bundle = await rollup({
    input: inputs,
    plugins: [
      originPlugin(),
      {
        name: 'dsh-tui-entry-exports',
        buildEnd() {
          for (const id of this.getModuleIds()) {
            const exports = this.getModuleInfo(id)?.exports
            if (exports != null && exports.length > 0) moduleExports.set(id, exports)
          }
        },
      },
    ],
    // A bare specifier stays external (react, @deepseek-ai/*, @dsh-std/*, the
    // `#tui-profile/*` imports, the optional peers): the profile must keep
    // resolving one copy, and the DSH host's own module identity is what the
    // Cordis root is built on. Everything under lib/types is ours and folds in.
    external: (id, _parent, isResolved) => {
      if (id.startsWith('node:')) return true
      if (isResolved) return !(id === libRoot || id.startsWith(libRoot + sep))
      return !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('file:')
    },
    onwarn: warning => {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return
      if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
      warnings.push(`${warning.code ?? 'WARNING'}: ${warning.message}`)
    },
    // Module side effects are load-bearing here (Cordis rows, registries,
    // React's dev-build guard), so nothing may be dropped. Turning it on was
    // measured at 7.68MB → 7.62MB, i.e. nothing.
    treeshake: false,
    // Entry modules keep their own exports: `lib/types/index.js` is the Cordis
    // row's entry and every path-loaded module is somebody's import target.
    preserveEntrySignatures: 'exports-only',
  })

  const { output } = await bundle.generate({
    dir: outDir,
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
    compact: true,
    hoistTransitiveImports: false,
  })
  await bundle.close()

  // getModuleIds is only valid while the bundle is open; mirror it from the
  // generated output instead: every lib module that produced no file of its
  // own was folded into a chunk.
  const written = new Set(output.filter(c => c.type === 'chunk').map(c => c.fileName))
  let bytes = 0
  for (const chunk of output) {
    if (chunk.type !== 'chunk') continue
    const path = join(outDir, chunk.fileName)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, chunk.code)
    bytes += Buffer.byteLength(chunk.code)
  }
  const chunks = output.filter(c => c.type === 'chunk')
  const entryFiles = chunks.filter(c => c.isEntry)
  const sharedFiles = chunks.filter(c => !c.isEntry)
  // An entry file stands at the original module's path for everyone outside
  // the bundle, so dropping an export would break a loader that cannot see the
  // chunk it moved to (the Cordis row, a verify import, the launcher's
  // `update`/`migrate`). Compare against the module's own export set.
  const lostExports = []
  for (const chunk of entryFiles) {
    const expected = moduleExports.get(chunk.facadeModuleId ?? '')
    if (expected === undefined) continue
    const emitted = new Set(chunk.exports)
    // A bare `export *` re-export shim reports `*`, not the names it forwards.
    const missing = expected.filter(name => name !== '*' && !emitted.has(name))
    if (missing.length > 0) lostExports.push(`${chunk.fileName}: ${missing.join(', ')}`)
  }
  const foldedIn = outDir === libRoot
    ? [...before].filter(path => !written.has(relative(libRoot, path).split(sep).join('/')))
    : []
  // A folded-in module must not survive at its original path: what stays there
  // is the untransformed tsc output, so anything reaching it by path would
  // build a second copy of the graph next to the chunks — two Cordis
  // singletons and a plugin row that never activates. Nothing outside the
  // bundle reaches these files (their paths are what the entry set was
  // collected from), and declarations stay: tsc owns types and the `exports`
  // "types" conditions still point at the same paths.
  const removed = []
  for (const path of foldedIn) {
    rmSync(path, { force: true })
    rmSync(`${path}.map`, { force: true })
    removed.push(path)
  }
  const stats = {
    entries: entryFiles.length,
    sharedChunks: sharedFiles.length,
    outputBytes: bytes,
    foldedIn: foldedIn.length,
    removed: removed.length,
    libFilesBefore: before.size,
    lostExports,
    largest: [...chunks].map(c => ({ file: c.fileName, bytes: Buffer.byteLength(c.code) })).sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    warnings,
  }
  if (reportPath !== undefined) writeFileSync(reportPath, `${JSON.stringify(stats, null, 2)}\n`)
  // The shape this step produced, for verify-lib-bundle: a `tsc` run without
  // this step leaves the original 1634 module files back on disk, which is the
  // second-copy state this whole step exists to remove.
  if (outDir === libRoot) {
    writeFileSync(join(libRoot, MANIFEST_FILE), `${JSON.stringify({
      entries: Object.keys(inputs).sort(),
      chunks: sharedFiles.map(c => c.fileName).sort(),
      bytes,
    }, null, 2)}\n`)
  }
  console.log(
    `bundle-lib: ${stats.entries} entries, ${stats.sharedChunks} shared chunks, ` +
      `${(bytes / 1048576).toFixed(2)}MB, ${stats.removed} folded-in files removed of ${stats.libFilesBefore} inputs`,
  )
  for (const entry of stats.largest) console.log(`  ${entry.file}  ${(entry.bytes / 1048576).toFixed(2)}MB`)
  for (const warning of warnings.slice(0, 10)) console.log(`  warn ${warning}`)
  for (const lost of lostExports.slice(0, 10)) console.log(`  LOST EXPORTS ${lost}`)
  if (stats.entries !== Object.keys(inputs).length) {
    throw new Error(`rollup produced ${stats.entries} entries for ${Object.keys(inputs).length} inputs`)
  }
  if (lostExports.length > 0) throw new Error(`${lostExports.length} entry file(s) lost exports`)
}

await main()
