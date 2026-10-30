import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { Pair, isMap, parseDocument } from 'yaml'

/** The index is injected into every request, so it is bounded independently of the fact files. */
export const MEMORY_INDEX_LINE_LIMIT = 200
export const MEMORY_INDEX_CHARACTER_LIMIT = 25_000
export const MAX_MEMORY_INDEX_BYTES = 256 * 1024

/**
 * Path segments a memory write may never touch. Mirrors ZCode's list; the names are normalized
 * before comparison so invisible characters, Windows ADS syntax, and trailing dots/spaces cannot
 * smuggle a protected directory past the check.
 */
export const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([
  '.git', 'hooks', '.husky', '.githooks', 'node_modules', '.vscode', '.idea', 'head', 'config',
  'objects', 'refs', '.claude', '.zcode', 'skills', 'commands', 'agents', '.cargo', '.devcontainer',
  '.yarn', '.mvn',
])

export interface MemoryRootInput {
  dataDir: string
  workspacePath: string
}

/** `<dataDir>/memories/projects/<slug>-<hash16>/memory`, keyed by the canonical workspace path. */
export function resolveMemoryRoot(input: MemoryRootInput): string {
  const normalized = resolve(input.workspacePath)
  const keySource = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const hash = createHash('sha256').update(keySource).digest('hex').slice(0, 16)
  const slug = sanitizeProjectSlug(basename(normalized) || 'project')
  return join(input.dataDir, 'memories', 'projects', `${slug}-${hash}`, 'memory')
}

function sanitizeProjectSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug.length > 0 ? slug : 'project'
}

function isContainedRelativePath(value: string): boolean {
  return value !== ''
    && value !== '..'
    && !value.startsWith(`..${sep}`)
    && !value.startsWith('../')
    && !value.startsWith('..\\')
    && !isAbsolute(value)
}

/** True when the resolved path stays inside the memory root, regardless of file type. */
export function isContainedMemoryPath(filePath: string, rootDir: string): boolean {
  return isContainedRelativePath(relative(rootDir, resolve(filePath)))
}

/** Contained, a Markdown file, plus no protected segment anywhere in the relative path. */
export function resolveSafeMemoryPath(filePath: string, rootDir: string): string | undefined {
  const candidate = resolve(filePath)
  if (!candidate.endsWith('.md')) return undefined
  const rel = relative(rootDir, candidate)
  if (!isContainedRelativePath(rel)) return undefined
  if (containsSensitiveMemoryPathSegment(rel)) return undefined
  return candidate
}

function containsSensitiveMemoryPathSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .filter(segment => segment !== '')
    .some(segment => SENSITIVE_MEMORY_PATH_SEGMENTS.has(normalizeSensitiveSegment(segment)))
}

function normalizeSensitiveSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, '')
    .split(':', 1)[0]!
    .replace(/[. ]+$/u, '')
}

const FRONTMATTER = /^(\uFEFF?)---[ \t]*(\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/u

/** Strip a leading YAML frontmatter block; anything else is returned unchanged. */
export function stripFrontmatter(content: string): string {
  const match = FRONTMATTER.exec(content)
  return match === null ? content : content.slice(match[0].length)
}

/**
 * Remove top-level HTML comments only. Comments inside code fences or block quotes are part of the
 * rendered document and must stay provider-visible, so the mdast tree (which nests them) decides.
 */
function stripTopLevelHtmlComments(content: string): string {
  if (!content.includes('<!--')) return content
  let tree
  try {
    tree = fromMarkdown(content)
  } catch {
    return content
  }
  let output = ''
  let last = 0
  for (const node of tree.children) {
    if (node.type !== 'html') continue
    if (!node.value.trimStart().startsWith('<!--') || !node.value.includes('-->')) continue
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) continue
    output += content.slice(last, start)
    last = end
  }
  return output + content.slice(last)
}

function sizeDescription(overLines: boolean, overCharacters: boolean): string {
  if (overLines && overCharacters) {
    return `超过 ${MEMORY_INDEX_LINE_LIMIT} 行且超过 ${MEMORY_INDEX_CHARACTER_LIMIT} 字符`
  }
  if (overCharacters) {
    return `超过 ${MEMORY_INDEX_CHARACTER_LIMIT} 字符（上限 ${MEMORY_INDEX_CHARACTER_LIMIT}）——索引行过长`
  }
  return `超过 ${MEMORY_INDEX_LINE_LIMIT} 行`
}

/** Normalize MEMORY.md into the bounded index the model sees. */
export function formatMemoryIndex(content: string): string {
  const body = stripFrontmatter(content)
  const stripped = stripTopLevelHtmlComments(body).trim()
  if (stripped === '') return ''
  const lines = stripped.split(/\r?\n/u)
  const overLines = lines.length > MEMORY_INDEX_LINE_LIMIT
  let formatted = overLines ? lines.slice(0, MEMORY_INDEX_LINE_LIMIT).join('\n') : stripped
  let overCharacters = false
  if (formatted.length > MEMORY_INDEX_CHARACTER_LIMIT) {
    overCharacters = true
    const newline = formatted.lastIndexOf('\n', MEMORY_INDEX_CHARACTER_LIMIT)
    formatted = newline >= 0 ? formatted.slice(0, newline) : formatted.slice(0, MEMORY_INDEX_CHARACTER_LIMIT)
  }
  if (!overLines && !overCharacters) return formatted
  return [
    formatted,
    '',
    `> 警告：MEMORY.md ${sizeDescription(overLines, overCharacters)}，仅加载了部分内容。索引行保持一行 ~200 字符以内，细节移入主题文件。`,
  ].join('\n')
}

export type MemoryFileReason =
  | 'source-symlink'
  | 'source-not-regular-file'
  | 'source-too-large'
  | 'source-changed-during-read'
  | 'source-invalid-utf8'
  | 'source-read-failed'

export type MemoryFileRecord =
  | { status: 'loaded'; content: string; bytes: number; sha256: string }
  | { status: 'missing' }
  | { status: 'error'; reason: MemoryFileReason }

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Bounded, tamper-resistant UTF-8 read used for MEMORY.md, fact files, and the manifest.
 * The memory root is host-managed, so there is no workspace-symlink preamble: the source file
 * itself must be a regular, non-symlink file that does not change while it is read.
 */
export async function readMemoryFile(source: string, limit = MAX_MEMORY_INDEX_BYTES): Promise<MemoryFileRecord> {
  let info
  try {
    info = await lstat(source)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { status: 'missing' }
    return { status: 'error', reason: 'source-read-failed' }
  }
  if (info.isSymbolicLink()) return { status: 'error', reason: 'source-symlink' }
  if (!info.isFile()) return { status: 'error', reason: 'source-not-regular-file' }
  if (info.size > limit) return { status: 'error', reason: 'source-too-large' }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  let handle
  try {
    handle = await open(source, constants.O_RDONLY | noFollow | nonBlock)
  } catch (error) {
    return { status: 'error', reason: codeOf(error) === 'ELOOP' ? 'source-symlink' : 'source-read-failed' }
  }

  try {
    const before = await handle.stat()
    if (!before.isFile()) return { status: 'error', reason: 'source-not-regular-file' }
    if (!sameFile(info, before)) return { status: 'error', reason: 'source-changed-during-read' }
    if (before.size > limit) return { status: 'error', reason: 'source-too-large' }

    // Windows may not provide O_NOFOLLOW, so verify the opened handle still matches the path
    // before and after reading. This detects path swaps but cannot be atomic without kernel support.
    let pathBefore
    try {
      pathBefore = await lstat(source)
    } catch {
      return { status: 'error', reason: 'source-changed-during-read' }
    }
    if (pathBefore.isSymbolicLink()) return { status: 'error', reason: 'source-symlink' }
    if (!pathBefore.isFile() || !sameFile(before, pathBefore)) {
      return { status: 'error', reason: 'source-changed-during-read' }
    }

    const buffer = Buffer.alloc(limit + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > limit) return { status: 'error', reason: 'source-too-large' }

    const after = await handle.stat()
    let pathAfter
    try {
      pathAfter = await lstat(source)
    } catch {
      return { status: 'error', reason: 'source-changed-during-read' }
    }
    if (
      !pathAfter.isFile()
      || !sameFile(before, after)
      || !sameFile(after, pathAfter)
      || before.size !== after.size
      || after.size !== bytesRead
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      return { status: 'error', reason: 'source-changed-during-read' }
    }

    const bytes = buffer.subarray(0, bytesRead)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { status: 'error', reason: 'source-invalid-utf8' }
    }
    if (content.includes('\0')) return { status: 'error', reason: 'source-invalid-utf8' }
    return {
      status: 'loaded',
      content,
      bytes: bytesRead,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch {
    return { status: 'error', reason: 'source-read-failed' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const ensuredDirectories = new Set<string>()

/** Create the memory root once per process; a failure never blocks the request that needed it. */
export async function ensureMemoryDirectory(root: string): Promise<void> {
  if (ensuredDirectories.has(root)) return
  ensuredDirectories.add(root)
  try {
    await mkdir(root, { recursive: true })
  } catch (error) {
    console.warn(`Pi Web could not create the memory directory ${root}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The path argument of a tool call, tolerating the field names different tools use. */
export function argumentPath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * Stamp the conversation that wrote a fact file. Pure string transform: the frontmatter AST keeps
 * comments and key order, `metadata.node_type` is forced to the first metadata key, and an
 * existing non-empty `originSessionId` wins (stamping is idempotent).
 */
export function stampOriginSessionId(content: string, filePath: string, rootDir: string, sessionId: string): string {
  if (resolveSafeMemoryPath(filePath, rootDir) === undefined) return content
  const match = FRONTMATTER.exec(content)
  if (match === null) return content
  const [, bom = '', lineEnding = '\n', frontmatter = '', closing = ''] = match
  const document = parseDocument(frontmatter)
  if (document.errors.length > 0) return content

  let metadata = document.get('metadata')
  if (!document.has('metadata')) {
    document.set('metadata', document.createNode({ node_type: 'memory' }))
    metadata = document.get('metadata')
  }
  if (!isMap(metadata)) return content

  const existing = metadata.get('originSessionId')
  if (typeof existing === 'string' && existing.trim() !== '') return content

  metadata.delete('node_type')
  metadata.items.unshift(new Pair('node_type', 'memory'))
  metadata.set('originSessionId', sessionId)

  const serialized = document.toString().replace(/\r?\n$/u, '')
  const restored = lineEnding === '\r\n' ? serialized.replace(/\n/gu, '\r\n') : serialized
  return `${bom}---${lineEnding}${restored}${closing}${content.slice(match[0].length)}`
}

/** Whether an existing fact file still lacks its stamp; unreadable or unparseable files need none. */
export async function fileNeedsOriginStamp(source: string): Promise<boolean> {
  const record = await readMemoryFile(source)
  if (record.status !== 'loaded') return false
  const match = FRONTMATTER.exec(record.content)
  if (match === null) return false
  const document = parseDocument(match[3] ?? '')
  if (document.errors.length > 0) return false
  if (!document.has('metadata')) return true
  const metadata = document.get('metadata')
  if (!isMap(metadata)) return false
  const existing = metadata.get('originSessionId')
  return !(typeof existing === 'string' && existing.trim() !== '')
}

/** Best-effort write-back used by the post-edit stamp path; callers swallow its errors. */
export async function stampExistingFile(source: string, rootDir: string, sessionId: string): Promise<void> {
  if (resolveSafeMemoryPath(source, rootDir) === undefined) return
  const record = await readMemoryFile(source)
  if (record.status !== 'loaded') return
  const stamped = stampOriginSessionId(record.content, source, rootDir, sessionId)
  if (stamped === record.content) return
  const temporary = join(dirname(source), `.tmp-stamp-${process.pid}-${Date.now()}`)
  try {
    await writeFile(temporary, stamped, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, source)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
