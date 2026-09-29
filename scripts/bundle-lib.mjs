#!/usr/bin/env node
/**
 * 把 tsc 产出的 lib/types/*.js 用 rolldown 静态打包到 lib/bundle/（启动加速）。
 *
 * 为什么：dsh-tui 启动期要加载 ~1300 个自有/第三方模块文件（lib/types 500+、
 * lodash-es 640、yaml、marked、highlight.js…）。每个文件都要走一遍 Node 的
 * resolve/stat/read/link，并且在 DSH 下还要额外经过 dsh-app-boot 的运行时
 * 解析路由（ResolutionRouter 接管了 ESM/CJS resolver）。模块“个数”才是成本，
 * 编译本身很便宜——所以把它们合成少数几个 chunk。
 *
 * 语义保持规则：
 *   - 多入口 + 共享 chunk：package.json `exports` 的每个 import 目标一个入口。
 *     cordis.patch.yml 把多个子路径当独立 Cordis 插件加载，公共模块必须落在
 *     同一个共享 chunk 里，模块级单例（注册表、store）才不会复制。
 *   - 外部化：官方 @deepseek-ai/*、@dsh-std/*、dsh-working-activity、dsh-auth
 *     （要经 DSH 路由且与其他插件共享身份）、react 家族（与第三方 TUI 插件共享
 *     同一 React 实例）、#dsh-ecosystem-spec/*（本包 imports 映射；第三方包自己的 #imports 照常打包），以及运行时
 *     按路径找自身文件的第三方包（见 PATH_SENSITIVE）。
 *   - import.meta.url 改写：每个被打包的 lib/types 模块里的 `import.meta.url`
 *     改成指回它原本的 lib/types 位置（lib/types 仍随包分发），资产定位、
 *     createRequire、worker 路径等位置敏感逻辑与未打包时完全一致。
 *   - 不定义 process.env.NODE_ENV：force-production-react.js 在运行时设置它，
 *     react-reconciler 的 dev/prod 选择必须留到运行时。
 *   - strictExecutionOrder：否则 rolldown 会把 force-production-react.js 内联进
 *     入口 chunk，排在被提升的静态 import 之后执行，react-reconciler 于是按
 *     dev 构建加载（b1e06d8 的长会话 OOM）。
 *   - 被打包的第三方模块若引用 import.meta / __dirname / __filename /
 *     require.resolve，构建直接失败——它们的路径语义在打包后会漂移，应加入
 *     PATH_SENSITIVE 外部化。
 *
 * 用法：node scripts/bundle-lib.mjs（需要先 tsc 产出 lib/types）。
 */
import { readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'rolldown'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const typesDir = join(root, 'lib', 'types')
const outDir = join(root, 'lib', 'bundle')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Entry name → absolute lib/types file. Every `exports` runtime target is
 * `./lib/bundle/<name>.js`, and its `types` sibling names the tsc module the
 * entry is built from (`./lib/types/**\/<name>.d.ts` → `.js`).
 */
const input = {}
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (typeof target !== 'object' || target === null) continue
  const runtime = target.import ?? target.default
  if (typeof runtime !== 'string' || !runtime.startsWith('./lib/bundle/')) continue
  const name = basename(runtime, '.js')
  if (runtime !== `./lib/bundle/${name}.js` || typeof target.types !== 'string' || !target.types.startsWith('./lib/types/') || basename(target.types, '.d.ts') !== name) {
    throw new Error(`exports[${JSON.stringify(subpath)}] must pair ./lib/bundle/<name>.js with ./lib/types/**/<name>.d.ts`)
  }
  input[name] = join(root, target.types.replace(/\.d\.ts$/, '.js'))
}
if (pkg.main !== 'lib/bundle/index.js' || input.index === undefined) {
  throw new Error('package.json main must be lib/bundle/index.js, built from the "." export')
}

/** Third-party packages that locate their own files at runtime. */
const PATH_SENSITIVE = ['sharp', 'koffi', 'lovely-mermaid', 'sixel']

const EXTERNAL = [
  /^node:/,
  /^#dsh-ecosystem-spec\//,
  /^@deepseek-ai\//,
  /^@dsh-std\//,
  /^@deepseek-harness-tui\//,
  /^dsh-working-activity(\/|$)/,
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  new RegExp(`^(${PATH_SENSITIVE.join('|')})(/|$)`),
]

const PATH_TOKENS = /\bimport\.meta\b|\b__dirname\b|\b__filename\b|\brequire\.resolve\b/

/** @type {import('rolldown').Plugin} */
const preserveModuleLocation = {
  name: 'dsh-tui:preserve-module-location',
  transform: {
    filter: { id: /\.[cm]?js$/ },
    handler(code, id) {
      if (id.startsWith(typesDir + sep)) {
        if (!code.includes('import.meta.url')) return null
        const original = relative(outDir, id).split(sep).join('/')
        return {
          code: code.replaceAll('import.meta.url', `new URL(${JSON.stringify(original)}, import.meta.url).href`),
          map: null,
        }
      }
      if (id.includes(`${sep}node_modules${sep}`) && PATH_TOKENS.test(code)) {
        this.error(`bundled dependency references its own location: ${relative(root, id)} — add its package to PATH_SENSITIVE`)
      }
      return null
    },
  },
}

rmSync(outDir, { recursive: true, force: true })
await build({
  input,
  platform: 'node',
  external: EXTERNAL,
  plugins: [preserveModuleLocation],
  // Leave process.env.NODE_ENV to runtime (force-production-react.js).
  transform: { define: {} },
  treeshake: true,
  output: {
    dir: outDir,
    format: 'esm',
    // ESM hoisting must not reorder module bodies: force-production-react.js
    // has to run before anything requires react-reconciler.
    strictExecutionOrder: true,
    entryFileNames: '[name].js',
    chunkFileNames: '[name]-[hash].js',
    sourcemap: false,
    minify: false,
    comments: { legal: true, annotation: true, jsdoc: false },
  },
})
