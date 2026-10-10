/**
 * `ThemeProvider` 的 `theme` prop 迟到与暂不可用回归：独立入口先挂载，profile
 * 装配完才把主题传进来。不可用名用真 Cordis `TuiThemeRuntime` 做 oracle，验证
 * 请求被暂存、主题注册后接上。去掉 prop 变化 effect 时迟到与接上两条会红。
 *
 * Run: node --import tsx/esm scripts/verify-theme-prop-late.tsx
 */
import './lib/fake-home.mjs'
import type { Context } from '@deepseek-ai/cordis'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
delete process.env.DSH_TUI_THEME

const [{ PassThrough, Writable }, React, ui, { settled, sleep }, cordis, themes] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/themes.js'),
])
const { render, ThemeProvider, Text, useTheme } = ui

/** 没有静态文件主题前缀，避免与用户目录撞名。 */
const RUNTIME_THEME = 'probe:late'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failures++
}

const sink = (): NodeJS.WriteStream => Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { isTTY: true }) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new PassThrough(), {
  isTTY: true, isRaw: false,
  setRawMode() { return stdin }, ref() { return stdin }, unref() { return stdin },
}) as unknown as NodeJS.ReadStream

let seen = ''
function Fixture(): React.ReactNode {
  const [name] = useTheme()
  seen = name
  return <Text>{`theme=${name}`}</Text>
}

// 「事后注册」真主题的宿主：真 Cordis 根 + 真 TuiThemeRuntime（同 verify-theme-hotswap.tsx）。
const root = new cordis.Context()
await root.plugin(themes.TuiThemeRuntime)
const host = themes.getHostThemes(root.get('tuiThemes'))
if (host === undefined) throw new Error('tuiThemes host did not mount')
let pluginContext: Context | undefined
await root.plugin({ name: 'theme-prop-late-probe', inject: ['tuiThemes'], apply: (context: Context) => { pluginContext = context } })

const app = await render(<ThemeProvider themeHost={host}><Fixture /></ThemeProvider>, {
  stdout: sink(), stdin, stderr: sink(), exitOnCtrlC: false, patchConsole: false,
})

try {
  // 无 prop、无 env、伪 HOME 无偏好 → 检测兜底落在 `dark`。
  check('挂载无 prop 时落在检测配色上', await settled(() => seen === 'dark'), seen)

  app.rerender(<ThemeProvider theme="light" themeHost={host}><Fixture /></ThemeProvider>)
  check('挂载后到达的 `theme` prop 立即生效', await settled(() => seen === 'light'), seen)

  app.rerender(<ThemeProvider theme={RUNTIME_THEME} themeHost={host}><Fixture /></ThemeProvider>)
  // 固定窗:探针 断的是「不可用名不得改当前主题」——不变量，等观察窗再断言
  await sleep(300)
  check('未注册的 `theme` prop 不崩、也不改当前主题', seen === 'light', seen)

  pluginContext!.tuiThemes.register({ name: RUNTIME_THEME, base: 'dark', colors: { accent: '#CC0000' } }, pluginContext!)
  check('该主题随后注册时暂存的请求被接上', await settled(() => seen === RUNTIME_THEME), seen)
} finally {
  app.unmount()
  await root.fiber.dispose()
}

if (failures > 0) {
  console.error(`\nverify-theme-prop-late: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nverify-theme-prop-late: all checks passed')
