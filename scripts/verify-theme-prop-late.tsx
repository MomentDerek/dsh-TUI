/**
 * `ThemeProvider` 的 `theme` prop 三态回归（取代 tmp-theme-prop-probe.tsx）。
 *
 * 被保护的那条改动是 ThemeProvider 里「prop 的**变化**」那个 effect：`theme` prop
 * 可能挂载后才到（独立入口先挂载、profile 装配完的那次 rerender 才把定好的主题
 * 传进来）。只在挂载时读一次（`useState` 初始化）会让屏幕停在检测配色上，所以
 * prop 一到就要落成当前请求并立即生效。与它相邻的是既有的
 * `[active, redetectAutoBase, runtimeThemeSnapshot]` 恢复 effect（职责：请求的名字
 * 在运行时插件里暂时消失/晚注册时，注册回来要接上）。
 *
 * 本脚本钉住三件事，缺一个都可能让「迟到生效」悄悄退化：
 *   1. prop 迟到生效（含 stdout 真的重绘，不只是 hook 里的名字变了）；
 *   2. prop 撤走不跳回：撤走不是一次请求变更，当前有效主题必须保持；
 *   3. prop 是不可用名（插件主题此刻还没注册）时不崩、不改当前主题，且**请求被
 *      暂存**——随后该主题注册上来时必须被接上。第 3 条是这条改动唯一多覆盖的
 *      语义，也是它 vs 恢复 effect 的分界线，所以用真 Cordis `TuiThemeRuntime`
 *      做 oracle，而不是只看名字没变。
 *
 * 判别力：`verify-theme-prop-late.mjs` 的姊妹门禁（B）之外，这条脚本在 effect
 * 缺席时的行为已实测（见提交说明）：状态 1 与 3b 会红。
 *
 * Run: node --import tsx/esm scripts/verify-theme-prop-late.tsx
 * 退出码：0 = 全部通过；1 = 有断言失败（逐条打印）。
 */
import './lib/fake-home.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
delete process.env.DSH_TUI_THEME

const [{ PassThrough, Writable }, React, ui] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
])
const { render, ThemeProvider, Box, Text, useTheme } = ui

/** 没有静态文件主题前缀，避免与用户目录撞名；`probe:late` 通过运行时名字校验。 */
const RUNTIME_THEME = 'probe:late'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failures++
}

const frames: string[] = []
class FakeStdout extends Writable {
  isTTY = true
  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    frames.push(String(chunk))
    cb()
  }
}
class FakeStderr extends Writable {
  isTTY = true
  override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void {
    cb()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(next: boolean): this {
    this.isRaw = next
    return this
  }
  override setEncoding(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
/** 轮询等待而不是定长 sleep：并行负载下渲染落点会慢，定长等待会假红。 */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20) // 固定窗:pacing 轮询步进间隔；等待条件本身是 predicate，不是这 20ms
  }
  return predicate()
}

let seen = ''
function Fixture(): React.ReactNode {
  const [name] = useTheme()
  seen = name
  return <Box flexDirection="column"><Text>{`theme=${name}`}</Text></Box>
}

// 状态 3 的 oracle 需要一个能「事后注册」真主题的宿主：真 Cordis 根 + 真
// TuiThemeRuntime（同 verify-theme-hotswap.tsx 的挂法）。
const [{ Context }, { TuiThemeRuntime, getHostThemes }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/themes.js'),
])
const root = new Context()
await root.plugin(TuiThemeRuntime)
const host = getHostThemes(root.get('tuiThemes'))
if (host === undefined) throw new Error('tuiThemes host did not mount')
let pluginContext: Context | undefined
await root.plugin({
  name: 'theme-prop-late-probe',
  inject: ['tuiThemes'],
  apply: (context: Context) => { pluginContext = context },
})

const app = await render(<ThemeProvider themeHost={host}><Fixture /></ThemeProvider>, {
  stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})

try {
  // 无 prop、无 env、伪 HOME 下无持久化偏好 → 检测兜底落在 `dark`（假 stdin 没有
  // querier，`settle('dark', …)` 立即落地）。这是后面「跳回」判据的基线。
  await waitFor(() => seen !== '')
  const before = seen
  check('挂载无 prop 时落在检测配色上', before === 'dark', before)

  // ── 状态 1：prop 迟到生效 ───────────────────────────────────────────────
  const beforeFrames = frames.length
  app.rerender(<ThemeProvider theme="light" themeHost={host}><Fixture /></ThemeProvider>)
  const switched = await waitFor(() => seen === 'light')
  const painted = frames.slice(beforeFrames).join('')
  check('状态 1a：挂载后到达的 `theme` prop 立即生效', switched, `theme=${seen}`)
  check('状态 1b：并且真的重绘到 stdout', painted.includes('light') && !painted.includes('dark'),
    JSON.stringify(painted.slice(-80)))

  // ── 状态 2：prop 撤走不跳回 ─────────────────────────────────────────────
  app.rerender(<ThemeProvider themeHost={host}><Fixture /></ThemeProvider>)
  // 固定窗:探针 断的是「撤走后当前主题不得改变」——不变量，等观察窗再断言
  await sleep(300)
  check('状态 2：prop 撤走保持当前有效主题（不退回检测配色）', seen === 'light', `theme=${seen}`)

  // ── 状态 3：不可用名不崩 + 请求被暂存 ─────────────────────────────────────
  app.rerender(<ThemeProvider theme={RUNTIME_THEME} themeHost={host}><Fixture /></ThemeProvider>)
  // 固定窗:探针 断的是「不可用名不得改当前主题」——不变量，等观察窗再断言
  await sleep(300)
  check('状态 3a：未注册的 `theme` prop 不崩、也不改当前主题', seen === 'light', `theme=${seen}`)

  pluginContext!.tuiThemes.register(
    { name: RUNTIME_THEME, base: 'dark', colors: { accent: '#CC0000' } },
    pluginContext!,
  )
  const restored = await waitFor(() => seen === RUNTIME_THEME)
  check('状态 3b：该主题随后注册时暂存的请求被接上', restored, `theme=${seen}`)

  // ── 状态 4：插件主题生效后 prop 撤走仍保持 ───────────────────────────────
  app.rerender(<ThemeProvider themeHost={host}><Fixture /></ThemeProvider>)
  // 固定窗:探针 断的是「插件主题生效后撤走仍保持」——不变量，等观察窗再断言
  await sleep(300)
  check('状态 4：插件主题生效后 prop 撤走仍保持', seen === RUNTIME_THEME, `theme=${seen}`)
} finally {
  app.unmount()
  await root.fiber.dispose()
}

if (failures > 0) {
  console.error(`\nverify-theme-prop-late: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nverify-theme-prop-late: all checks passed')
