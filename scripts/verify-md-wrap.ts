/**
 * Reject Markdown prose paragraphs spanning multiple physical lines («一段一行»,
 * owned by docs/AGENTS.md). The GFM AST distinguishes paragraphs — including
 * those inside list items and block quotes — from structural nodes, so code
 * blocks, tables, and frontmatter need no special casing. Frozen documents
 * under docs/history/ are out of scope. Known legacy violations are grandfathered
 * by exact `file:line` entries, so the gate is green today while any new
 * violation still bites. The checker never rewrites.
 */

import assert from 'node:assert/strict'
import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')

/** Known legacy hard-wrapped paragraphs that do not block the gate; exact `file:line` entries. */
const GRANDFATHERED: string[] = []

/** One located hard-wrap: a prose paragraph spanning more than one source line. */
interface Violation {
  file: string
  /** 1-based line where the hard-wrapped paragraph starts. */
  line: number
  text: string
}

const relativePath = (absPath: string) => relative(root, absPath).replaceAll('\\', '/')

/** Collect every Markdown file under one directory tree; a missing directory yields none. */
function walkMarkdown(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(...walkMarkdown(join(dir, entry.name)))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(join(dir, entry.name))
  }
  return out
}

const files = [
  ...['README.md', 'AGENTS.md'].map(name => join(root, name)).filter(path => existsSync(path)),
  ...['docs', '.agents/notes'].flatMap(dir => walkMarkdown(join(root, dir))),
]
  .map(relativePath)
  .filter(file => !file.startsWith('docs/history/'))
  .sort()
assert.ok(files.length > 0, 'verify-md-wrap: no Markdown files found — scope discovery is broken')

/** Find every hard-wrapped prose paragraph in one Markdown file via its AST. */
function findViolations(absPath: string): Violation[] {
  const file = relativePath(absPath)
  const source = readFileSync(absPath, 'utf8')
  const lines = source.split('\n')
  const out: Violation[] = []
  visitMarkdown(parseMarkdown(source), (node: Nodes): boolean | void => {
    if (node.type !== 'paragraph' || node.position === undefined) return
    const { start, end } = node.position
    if (end.line > start.line) {
      out.push({ file, line: start.line, text: (lines[start.line - 1] ?? '').trim() })
    }
    // Paragraph children are phrasing content, so no nested paragraph exists below.
    return false
  })
  return out
}

const violations = files.flatMap(file => findViolations(join(root, file)))
const key = (violation: Violation) => `${violation.file}:${violation.line}`
const fresh = violations.filter(violation => !GRANDFATHERED.includes(key(violation)))
const stale = GRANDFATHERED.filter(entry => !violations.some(violation => key(violation) === entry))
if (stale.length > 0) console.error(`verify-md-wrap: stale grandfather entries (no current violation, remove them): ${stale.join(', ')}`)

if (fresh.length === 0) {
  console.log(`verify-md-wrap: ${files.length} file(s) checked, no hard-wrapped prose paragraphs (${violations.length} grandfathered).`)
  process.exit(0)
}

console.error('verify-md-wrap: hard-wrapped prose paragraphs found (write one physical line per paragraph):')
for (const violation of fresh) {
  console.error(`  ${violation.file}:${violation.line}  ${violation.text.slice(0, 60)}${violation.text.length > 60 ? '…' : ''}`)
}
console.error(`verify-md-wrap: ${fresh.length} violation(s), ${violations.length - fresh.length} grandfathered.`)
process.exit(1)
