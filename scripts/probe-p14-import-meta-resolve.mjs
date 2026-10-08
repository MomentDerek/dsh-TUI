/**
 * P14 / 任务 C 探针：入口装上解析劫持（dsh-app-boot 的 PluginPackages +
 * createRuntimeResolution）之后，从「本包代码」里调 `import.meta.resolve`
 * 究竟解析到哪一份 `@deepseek-ai/*` 副本？
 *
 * 机制（静态已确证，见 docs/standalone-host-design.md 2.6 遗留与
 * src/dsh-adapter/host-dsh.ts:419 的 `ctx.plugin(appBoot.PluginPackages)`）：
 *  - dsh-app-boot 的 `installRuntimeInterception` 会把 Node 的
 *    `cascadedLoader.resolveSync` / `.resolve` 与 `Module._resolveFilename`
 *    一起换成包装（node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1730-1820）；
 *  - `import.meta.resolve(specifier)` 在 Node 侧就是调 `loader.resolveSync`
 *    （模块创建时绑定的那个 loader 对象，属性每次调用才求值），所以
 *    劫持**会**改变本包源码里 `import.meta.resolve` 的答案；
 *  - 包装先看父 URL 落在哪一层：`findInterceptionLayer` 判定「该文件在
 *    profiles 树内 / 活动 profile 内 / linked root 内」才算被拦截；
 *  - 被拦截时，profile 本地 node_modules 有同名包 → 用本地那份（native），
 *    否则落到 resolution.entries 里 scope === 'installation' 的那条，也就是
 *    **宿主安装里**的副本。
 *
 * 真实部署下本包的位置正是 profiles 树内
 * （`$DSH_HOME/profiles/<profile>/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/…`），
 * 而 `@deepseek-ai/dsh-app-boot` 这类宿主类型包是 optional peer、profile 里
 * 不自动安装（src/dsh-adapter/contract.ts:117-127 的注释），于是
 * `installedUpstreamVersions()` / `installedKernelVersion()`
 * （src/dsh-adapter/contract.ts:172-178、229-238）读到的版本来自宿主副本，
 * 而不是 profile 邻居（`$DSH_HOME/profiles/node_modules/@deepseek-ai/…`）。
 *
 * 本探针在临时目录里复刻这个布局（不碰任何真实用户目录）：
 *  - `<scratch>/profiles/node_modules/@deepseek-ai/dsh-app-boot`：profile 邻居副本，
 *    版本号故意写成 `0.0.0-p14-profile-neighbour`，便于一眼分辨来源；
 *  - `<scratch>/profiles/p14/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/contract-probe.mjs`：
 *    被测模块，与 src/dsh-adapter/contract.ts 的 `resolvePackageJson` 同调用形状；
 *  - 宿主副本用仓库 dev 副本（node_modules/@deepseek-ai/dsh-app-boot）。
 *
 * 输出：劫持前 / 劫持后的解析路径与版本；两条不同即复现成立（退出码 0），
 * 相同即反证（退出码 1）。同一次调用也从探针脚本自身（不在 profiles 树内）
 * 解析一次，作为「位置决定是否被拦截」的对照。
 *
 * Run: node scripts/probe-p14-import-meta-resolve.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG = '@deepseek-ai/dsh-app-boot'
const NEIGHBOUR_VERSION = '0.0.0-p14-profile-neighbour'

const scratch = mkdtempSync(join(tmpdir(), 'probe-p14-resolve-'))
const profilesDir = join(scratch, 'profiles')
const profileDir = join(profilesDir, 'p14')
const hostCopyDir = join(repo, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
const hostCopyVersion = JSON.parse(readFileSync(join(hostCopyDir, 'package.json'), 'utf8')).version

/** 造 profile 邻居副本（真实的 `$DSH_HOME/profiles/node_modules/@deepseek-ai/…`）。 */
const neighbourDir = join(profilesDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
mkdirSync(neighbourDir, { recursive: true })
writeFileSync(join(neighbourDir, 'package.json'), `${JSON.stringify({ name: PKG, version: NEIGHBOUR_VERSION }, null, 2)}\n`)

/** 被测模块：与 src/dsh-adapter/contract.ts:172-178 的 resolvePackageJson 同形状。 */
const victimDir = join(profileDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'lib', 'types', 'dsh-adapter')
mkdirSync(victimDir, { recursive: true })
const victimPath = join(victimDir, 'contract-probe.mjs')
const victimSource = [
  "import { readFileSync } from 'node:fs'",
  "import { fileURLToPath } from 'node:url'",
  '',
  '/** src/dsh-adapter/contract.ts:172-178 resolvePackageJson（同调用形状）。 */',
  'export function resolvePackageJson(packageName) {',
  '  try {',
  '    const path = import.meta.resolve(`${packageName}/package.json`)',
  "    return path.startsWith('file:') ? fileURLToPath(path) : path",
  '  } catch {',
  '    return undefined',
  '  }',
  '}',
  '',
  'export function installedVersion(packageName) {',
  '  const path = resolvePackageJson(packageName)',
  '  if (path === undefined) return { path: undefined, version: undefined }',
  '  try {',
  "    return { path, version: JSON.parse(readFileSync(path, 'utf8')).version }",
  '  } catch {',
  '    return { path, version: undefined }',
  '  }',
  '}',
  '',
].join('\n')
writeFileSync(victimPath, victimSource)

const resolveFromOutside = () => {
  try {
    return fileURLToPath(import.meta.resolve(`${PKG}/package.json`))
  } catch {
    return undefined
  }
}

const report = line => process.stdout.write(`${line}\n`)
const fmt = probe => `${probe.path}  [version=${probe.version}]`

const victim = await import(pathToFileURL(victimPath).href)
const before = victim.installedVersion(PKG)
const outsideBefore = resolveFromOutside()
report(`scratch                 : ${scratch}`)
report(`profile 邻居副本         : ${neighbourDir}  [version=${NEIGHBOUR_VERSION}]`)
report(`宿主副本（installation） : ${hostCopyDir}  [version=${hostCopyVersion}]`)
report(`劫持前 · 本包模块解析     : ${fmt(before)}`)
report(`劫持前 · 探针脚本解析     : ${outsideBefore}`)

/** 与 prepareHostRoot 装的是同一个服务、同一种 resolution 形状。 */
const { Context } = await import('@deepseek-ai/cordis')
const appBoot = await import('@deepseek-ai/dsh-app-boot')
const ctx = new Context()
await ctx.plugin(appBoot.PluginPackages, {
  resolution: Object.freeze({
    profilesDir: profilesDir + sep,
    profileDir,
    localPackageNames: Object.freeze([]),
    linkedRoots: Object.freeze([]),
    entries: Object.freeze([Object.freeze({
      name: PKG,
      packageDir: hostCopyDir,
      version: hostCopyVersion,
      declarer: join(hostCopyDir, 'package.json'),
      scope: 'installation',
    })]),
  }),
})

const after = victim.installedVersion(PKG)
const outsideAfter = resolveFromOutside()
report(`劫持后 · 本包模块解析     : ${fmt(after)}`)
report(`劫持后 · 探针脚本解析     : ${outsideAfter}`)

await ctx.fiber.dispose()
rmSync(scratch, { recursive: true, force: true })

const routed = before.path !== after.path
// app-boot 会把 entries.packageDir 按 realpath 归一（pnpm 的 .pnpm 目录），所以
// 「落到宿主副本」用「与不在 profiles 树内的解析一致、且不再是 profile 邻居」判定。
const hitHostCopy = after.path === outsideAfter && after.path !== before.path
const outsideStable = outsideBefore === outsideAfter
report('')
report(`结论 1 · 劫持改变了本包 import.meta.resolve 的落点 : ${routed ? '是（复现成立）' : '否（反证）'}`)
report(`结论 2 · 落在宿主 installation 副本而非 profile 邻居 : ${hitHostCopy ? '是（复现成立）' : '否'}`)
report(`结论 3 · 不在 profiles 树内的模块不受影响（位置决定） : ${outsideStable ? '是' : '否'}`)
report(`结论 4 · 劫持前落点是 profile 邻居副本               : ${before.path === join(neighbourDir, 'package.json') ? '是' : '否'}`)

process.exit(routed && hitHostCopy ? 0 : 1)
