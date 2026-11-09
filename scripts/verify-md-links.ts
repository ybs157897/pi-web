/**
 * Verify that relative Markdown link, image, and definition targets resolve to
 * files that exist («引用代码用 Markdown 相对链接», owned by docs/AGENTS.md).
 * Scheme-qualified URLs (https:, mailto:, …), protocol-relative and
 * root-absolute targets, pure in-page anchors, and snapshot-template
 * placeholders (<ROOT>, <PLATFORM>, <DATE>, <TZ>, …) are skipped; for
 * `target#anchor` forms only the path part is probed — anchors are
 * renderer-owned and not judged. Documents under docs/history/ are frozen:
 * their outbound links are not checked, but links from other files into
 * history remain checked. Legacy dead links are grandfathered per entry — a
 * `file` entry suppresses a whole source file, a `file:line` entry a single
 * link — keeping the exemption list as small as possible.
 * The checker never rewrites.
 */

import assert from 'node:assert/strict'
import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')

/** Grandfathered legacy dead links: a `file` entry skips a whole source file, a `file:line` entry one link. */
const GRANDFATHERED: string[] = [
]

/** Snapshot-template placeholders in link targets (<ROOT>, <PLATFORM>, <DATE>, <TZ>, …). */
const PLACEHOLDER = /<[A-Z][A-Z0-9_-]*>/u

/** One broken relative link: a target path that resolves to no existing file. */
interface Violation {
  file: string
  /** 1-based line where the link/image/definition node starts. */
  line: number
  url: string
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
assert.ok(files.length > 0, 'verify-md-links: no Markdown files found — scope discovery is broken')

/**
 * True for targets this gate must not check: scheme-qualified URLs (`https:`,
 * `mailto:`, …), protocol-relative (`//host`), root-absolute (`/path`), and
 * pure in-page anchors (`#frag`). Only repository-relative targets are judged.
 */
function isExternalOrAnchor(url: string): boolean {
  if (url === '' || url.startsWith('#') || url.startsWith('//') || url.startsWith('/')) return true
  // A scheme like `https:` / `mailto:` — a colon before any slash, dot, or hash.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(url)
}

/** One Markdown link destination with its 1-based start line and raw source slice. */
interface Destination {
  url: string
  line: number
  /** Raw node source, so placeholder brackets mdast strips (e.g. `[x](<ROOT>)`) stay visible. */
  raw: string
}

/** Collect every link, image, and definition destination in one parse, in document order. */
function collectDestinations(source: string): Destination[] {
  const out: Destination[] = []
  visitMarkdown(parseMarkdown(source), (node: Nodes): void => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return
    const start = node.position?.start
    const end = node.position?.end
    if (start?.offset === undefined || end?.offset === undefined) return
    out.push({ url: node.url, line: start.line, raw: source.slice(start.offset, end.offset) })
  })
  return out
}

/** Strip the `#fragment` and `?query` from a link target, leaving its path part. */
function pathPart(url: string): string {
  return url.replace(/[?#].*$/u, '')
}

/** Find every broken relative link target in one Markdown file via its AST. */
function findViolations(absPath: string): Violation[] {
  const file = relativePath(absPath)
  const source = readFileSync(absPath, 'utf8')
  const out: Violation[] = []
  for (const destination of collectDestinations(source)) {
    if (isExternalOrAnchor(destination.url)) continue
    if (PLACEHOLDER.test(destination.url) || PLACEHOLDER.test(destination.raw)) continue
    const resolved = resolve(dirname(absPath), pathPart(destination.url))
    if (!existsSync(resolved)) out.push({ file, line: destination.line, url: destination.url })
  }
  return out
}

const violations = files.flatMap(file => findViolations(join(root, file)))
const key = (violation: Violation) => `${violation.file}:${violation.line}`
const exempt = (violation: Violation) => GRANDFATHERED.includes(violation.file) || GRANDFATHERED.includes(key(violation))
const fresh = violations.filter(violation => !exempt(violation))
const checkedSources = files.filter(file => !GRANDFATHERED.includes(file))
const stale = GRANDFATHERED.filter(entry => !violations.some(violation => entry === violation.file || entry === key(violation)))
if (stale.length > 0) console.error(`verify-md-links: stale grandfather entries (no current dead link, remove them): ${stale.join(', ')}`)

if (fresh.length === 0) {
  console.log(`verify-md-links: ${checkedSources.length} file(s) checked, all relative link targets exist (${files.length - checkedSources.length} file(s) grandfathered).`)
  process.exit(0)
}

console.error('verify-md-links: broken relative link targets found:')
for (const violation of fresh) {
  console.error(`  ${violation.file}:${violation.line} -> ${violation.url}`)
}
console.error(`verify-md-links: ${fresh.length} violation(s) in ${new Set(fresh.map(violation => violation.file)).size} file(s).`)
process.exit(1)
