/**
 * Fingerprints of the upstream bodies the standalone entry reproduces
 * (host-contract.ts HOST_REPLICAS): cuts one top-level `function`/`const` by
 * name out of a package's bundled `lib/*.js` text (never imported) and hashes
 * it. Bundler output is stable per version, so a hash change means the body changed.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostReplica } from '../../src/dsh-adapter/host-contract.js'

/** Index just past the token that closes the one opening at `open` (`(`, `{`). */
function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const stack: string[] = []
  let lastSignificant = ''
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
      continue
    }
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
      lastSignificant = c
      continue
    }
    if (c === '`') {
      i = skipTemplate(text, i)
      lastSignificant = '`'
      continue
    }
    if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant))) {
      let inClass = false
      for (i++; i < text.length; i++) {
        const r = text[i]
        if (r === '\\') i++
        else if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
      }
      lastSignificant = '/'
      continue
    }
    if (pairs[c] !== undefined) stack.push(pairs[c]!)
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) throw new Error(`unbalanced ${c} at ${i}`)
      if (stack.length === 0) return i + 1
    }
    if (!/\s/u.test(c)) lastSignificant = c
  }
  throw new Error(`no close for the token at ${open}`)
}

/** Index of the closing backtick of the template starting at `start`. */
function skipTemplate(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') i++
    else if (c === '`') return i
    else if (c === '$' && text[i + 1] === '{') i = matchClose(text, i + 1) - 1
  }
  throw new Error(`unterminated template at ${start}`)
}

/** The source text of one top-level symbol in `text`, or undefined. */
export function cutSymbol(text: string, symbol: string, kind: HostReplica['kind']): string | undefined {
  if (kind === 'const') {
    const match = new RegExp(`^(?:export\\s+)?const\\s+${symbol}\\s*=[^\\n]*$`, 'mu').exec(text)
    return match?.[0]
  }
  const match = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${symbol}\\s*\\(`, 'mu').exec(text)
  if (match === null) return undefined
  const params = match.index + match[0].length - 1
  const afterParams = matchClose(text, params)
  const body = text.indexOf('{', afterParams)
  return text.slice(match.index, matchClose(text, body))
}

/** The sha256 of `replica` inside the package installed at `packageDir`. */
export function fingerprintReplica(packageDir: string, replica: HostReplica): string {
  const libDir = join(packageDir, 'lib')
  const hits: { file: string; source: string }[] = []
  for (const file of readdirSync(libDir).filter(name => name.endsWith('.js')).sort()) {
    const source = cutSymbol(readFileSync(join(libDir, file), 'utf8'), replica.symbol, replica.kind)
    if (source !== undefined) hits.push({ file, source })
  }
  // A chunk and an entry can both carry a body only if the bundle duplicated
  // it; identical copies count as one.
  const distinct = [...new Set(hits.map(hit => hit.source))]
  if (distinct.length === 0) throw new Error(`${replica.package}: no top-level ${replica.kind} ${replica.symbol} in lib/*.js`)
  if (distinct.length > 1) throw new Error(`${replica.package}: ${distinct.length} different ${replica.symbol} bodies (${hits.map(hit => hit.file).join(', ')})`)
  return createHash('sha256').update(distinct[0]!).digest('hex')
}
