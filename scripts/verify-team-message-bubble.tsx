/**
 * Agent Teams peer-message bubble (src/components/messages/TeamMessageBubble.tsx,
 * issue #1241): a `✉ <sender> · team message` line, then the body with a
 * hanging indent that holds under wrapping — at a normal and a narrow
 * terminal width, with a wide-character sender and body.
 *
 * Run: node --import tsx/esm scripts/verify-team-message-bubble.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
const [{ mkdtempSync, rmSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
])
const dataDir = mkdtempSync(join(tmpdir(), 'verify-team-bubble-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, termTest, bubble, width] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/components/messages/TeamMessageBubble.js'),
  import('../src/ink/stringWidth.js'),
])
const { settled, viewportLines } = termTest
const { render } = ui

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

async function frame(cols: number, sender: string, text: string): Promise<string[]> {
  const rows = 12
  const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class Sink extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const instance = await render(
    <bubble.TeamMessageBubble sender={sender} text={text} marginTopOnTurn={false} />,
    { stdout: new FakeStdout(), stdin: new FakeStdin(), stderr: new Sink(), exitOnCtrlC: false, patchConsole: false },
  )
  await settled(() => viewportLines(term, rows).some((line: string) => line.includes('✉')))
  const lines = viewportLines(term, rows).map((line: string) => line.trimEnd()).filter((line: string) => line !== '')
  instance.unmount()
  return lines
}

try {
  const wide = await frame(80, 'reviewer', 'diff ok\nsecond line of the report')
  check('sender line carries mark, name and tag', wide[0] === '✉ reviewer · team message', JSON.stringify(wide[0]))
  check('body lines hang under the sender', wide[1] === '  diff ok' && wide[2] === '  second line of the report', JSON.stringify(wide.slice(1)))

  const narrow = await frame(24, '审阅者', '这是一条需要在窄终端里换行的团队消息内容')
  check('narrow: the sender line stays one row', narrow[0]?.startsWith('✉ 审阅者') === true, JSON.stringify(narrow[0]))
  const body = narrow.slice(1)
  check('narrow: the wrapped body keeps its indent', body.length > 1 && body.every(line => line.startsWith('  ') && !line.startsWith('   ')), JSON.stringify(body))
  check('narrow: no row overflows the terminal', narrow.every(line => width.stringWidth(line) <= 24), JSON.stringify(narrow))
  check('narrow: every body character is shown', body.map(line => line.trim()).join('') === '这是一条需要在窄终端里换行的团队消息内容', JSON.stringify(body))
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
if (failed > 0) {
  console.log(`${failed} FAILED`)
  process.exit(1)
}
console.log('ALL PASS')
process.exit(0)
