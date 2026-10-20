import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { RuntimeError } from './runtime-errors.ts'

export const RESEARCH_TOOL_NAMES = ['list_files', 'search_files'] as const

const MAX_PATH_LENGTH = 1_024
const MAX_QUERY_LENGTH = 200
const MAX_SCAN_NODES = 2_000
const MAX_FILE_BYTES = 512 * 1_024
const MAX_TOTAL_READ_BYTES = 4 * 1_024 * 1_024
const MAX_LIST_ENTRIES = 100
const MAX_SEARCH_RESULTS = 50
const MAX_RESULT_PATH_LENGTH = 512
const MAX_EXCERPT_LENGTH = 200
const MAX_TOOL_OUTPUT_BYTES = 48 * 1_024

const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', '.data'])
const PRIVATE_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore'])
const PRIVATE_FILE_NAME = /^(?:(?:credentials?|secrets?|tokens?|private[-_]?key)\.(?:json|ya?ml|toml|txt)|id_rsa|id_ed25519)$/i

type ListedEntry = { path: string; type: 'file' | 'directory' }
type SearchMatch = { path: string; line: number; excerpt: string }
type WorkspacePath = { path: string; absolute: string; info: Awaited<ReturnType<typeof lstat>> }
type WalkEntry = WorkspacePath & { type: 'file' | 'directory' }
type SearchRead =
  | { kind: 'text'; content: string; bytes: number }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'binary'; bytes: number }
  | { kind: 'unreadable'; bytes: number }

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || value.includes('\u0000') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new RuntimeError('INVALID_INPUT', `Workspace paths must be relative and no longer than ${MAX_PATH_LENGTH} characters.`)
  }
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) throw new RuntimeError('FORBIDDEN', 'A research tool cannot access paths outside the current workspace.')
  if (segments.some(isRestrictedName)) throw new RuntimeError('FORBIDDEN', 'Hidden and credential-related paths are excluded from workspace research.')
  return segments.join('/')
}

function isRestrictedName(name: string): boolean {
  if (name.startsWith('.') || OMITTED_DIRECTORIES.has(name.toLowerCase())) return true
  const lower = name.toLowerCase()
  const extension = lower.slice(lower.lastIndexOf('.'))
  return PRIVATE_FILE_NAME.test(name) || PRIVATE_FILE_EXTENSIONS.has(extension)
}

function requireWorkspace(api: ToolExecutionApi): string {
  const cwd = api.env?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '' || !isAbsolute(cwd)) {
    throw new RuntimeError('UNSUPPORTED', 'The current conversation has no bound workspace directory.')
  }
  return cwd
}

function abortIfRequested(context: Context): void {
  context.abortSignal?.throwIfAborted()
}

async function workspaceRoot(api: ToolExecutionApi, context: Context): Promise<string> {
  abortIfRequested(context)
  let root: string
  try {
    root = await realpath(resolve(requireWorkspace(api)))
  } catch (error) {
    if (isMissing(error)) throw new RuntimeError('NOT_FOUND', 'The bound workspace directory is unavailable.')
    throw error
  }
  abortIfRequested(context)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RuntimeError('INVALID_INPUT', 'The bound workspace must be a directory.')
  return root
}

/** Resolve only existing paths, checking each component so a symlink cannot redirect a read. */
async function checkedPath(root: string, path: unknown, context: Context): Promise<WorkspacePath> {
  const normalized = safeRelativePath(path ?? '')
  const absolute = resolve(root, normalized)
  if (!isWithin(root, absolute)) throw new RuntimeError('FORBIDDEN', 'A research tool cannot access paths outside the current workspace.')
  let cursor = root
  const segments = normalized === '' ? [] : normalized.split('/')
  let info = await lstat(root)
  for (const [index, segment] of segments.entries()) {
    abortIfRequested(context)
    cursor = resolve(cursor, segment)
    try {
      info = await lstat(cursor)
    } catch (error) {
      if (isMissing(error)) throw new RuntimeError('NOT_FOUND', 'The requested workspace path does not exist.')
      throw error
    }
    if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Research tools do not follow symbolic links.')
    if (index < segments.length - 1 && !info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'Every parent in a workspace path must be a directory.')
  }
  const canonical = await realpath(absolute)
  if (!isWithin(root, canonical)) throw new RuntimeError('FORBIDDEN', 'A research tool cannot access paths outside the current workspace.')
  abortIfRequested(context)
  return { path: normalized, absolute: canonical, info }
}

async function walkDirectory(
  root: string,
  start: WorkspacePath,
  recursive: boolean,
  context: Context,
  visit: (entry: WalkEntry) => Promise<boolean>,
): Promise<{ examined: number; truncated: boolean }> {
  if (!start.info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'list_files requires a workspace directory.')
  const pending: WorkspacePath[] = [start]
  let examined = 0
  let truncated = false
  let stop = false
  while (pending.length > 0) {
    abortIfRequested(context)
    const current = pending.shift()
    if (current === undefined) continue
    const currentInfo = await lstat(current.absolute)
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) continue
    const currentCanonical = await realpath(current.absolute)
    if (!isWithin(root, currentCanonical)) continue
    const directory = await opendir(current.absolute)
    try {
      for await (const entry of directory) {
        abortIfRequested(context)
        examined += 1
        if (examined > MAX_SCAN_NODES) {
          truncated = true
          stop = true
          break
        }
        if (isRestrictedName(entry.name)) continue
        const relativePath = [current.path, entry.name].filter(Boolean).join('/')
        if (relativePath.length > MAX_RESULT_PATH_LENGTH) {
          truncated = true
          continue
        }
        const childAbsolute = resolve(current.absolute, entry.name)
        let childInfo: Awaited<ReturnType<typeof lstat>>
        try {
          childInfo = await lstat(childAbsolute)
        } catch (error) {
          if (isMissing(error)) continue
          throw error
        }
        if (childInfo.isSymbolicLink() || (!childInfo.isFile() && !childInfo.isDirectory())) continue
        const childCanonical = await realpath(childAbsolute)
        if (!isWithin(root, childCanonical)) continue
        const type = childInfo.isDirectory() ? 'directory' : 'file'
        const shouldContinue = await visit({
          path: relativePath,
          absolute: childCanonical,
          info: childInfo,
          type,
        })
        if (!shouldContinue) {
          truncated = true
          stop = true
          break
        }
        if (type === 'directory' && recursive) pending.push({ path: relativePath, absolute: childCanonical, info: childInfo })
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
    if (stop) break
  }
  return { examined: Math.min(examined, MAX_SCAN_NODES), truncated }
}

function textOutput(text: string) {
  return [{ type: 'text' as const, text }]
}

function boundedListing(scope: string, recursive: boolean, examined: number, entries: ListedEntry[], truncated: boolean): string {
  while (true) {
    const lines = entries.map(entry => `- ${entry.type} ${JSON.stringify(entry.path)}`)
    const text = [
      `Listed ${entries.length} workspace entries under ${JSON.stringify(scope)}${recursive ? ' recursively' : ''} (${examined} entries examined).`,
      ...lines,
      ...(truncated ? ['TRUNCATED: workspace research limits omitted additional entries.'] : []),
    ].join('\n')
    if (Buffer.byteLength(text) <= MAX_TOOL_OUTPUT_BYTES || entries.length === 0) return text
    entries.pop()
    truncated = true
  }
}

function cleanExcerpt(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function makeExcerpt(line: string, matchIndex: number): string {
  const clean = cleanExcerpt(line)
  if (clean.length <= MAX_EXCERPT_LENGTH) return clean
  const originalPrefix = line.slice(0, matchIndex)
  const cleanIndex = cleanExcerpt(originalPrefix).length
  const half = Math.floor((MAX_EXCERPT_LENGTH - 2) / 2)
  let start = Math.max(0, cleanIndex - half)
  let end = Math.min(clean.length, start + MAX_EXCERPT_LENGTH - 2)
  if (end - start < MAX_EXCERPT_LENGTH - 2) start = Math.max(0, end - (MAX_EXCERPT_LENGTH - 2))
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}

async function yieldToAbort(): Promise<void> {
  await new Promise<void>(resolveNext => setImmediate(resolveNext))
}

async function readSearchFile(
  root: string,
  entry: WalkEntry,
  context: Context,
  remainingBytes: number,
): Promise<SearchRead> {
  abortIfRequested(context)
  if (entry.info.size > MAX_FILE_BYTES || entry.info.size > remainingBytes) return { kind: 'oversize', bytes: 0 }
  const checked = await checkedPath(root, entry.path, context)
  if (!checked.info.isFile()) return { kind: 'unreadable', bytes: 0 }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let bytesRead = 0
  try {
    handle = await open(checked.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile() || openedInfo.dev !== checked.info.dev || openedInfo.ino !== checked.info.ino) {
      return { kind: 'unreadable', bytes: 0 }
    }
    if (openedInfo.size > MAX_FILE_BYTES || openedInfo.size > remainingBytes) return { kind: 'oversize', bytes: 0 }
    const allowedBytes = Math.min(MAX_FILE_BYTES, remainingBytes)
    const chunks: Buffer[] = []
    while (bytesRead < allowedBytes) {
      abortIfRequested(context)
      const length = Math.min(64 * 1_024, allowedBytes - bytesRead)
      const chunk = Buffer.alloc(length)
      const read = await handle.read(chunk, 0, length, bytesRead)
      if (read.bytesRead === 0) break
      chunks.push(chunk.subarray(0, read.bytesRead))
      bytesRead += read.bytesRead
    }
    abortIfRequested(context)
    if ((await handle.stat()).size > bytesRead) return { kind: 'oversize', bytes: bytesRead }
    const buffer = Buffer.concat(chunks, bytesRead)
    if (buffer.includes(0)) return { kind: 'binary', bytes: bytesRead }
    return { kind: 'text', content: buffer.toString('utf8'), bytes: buffer.length }
  } catch (error) {
    abortIfRequested(context)
    if (error instanceof RuntimeError) throw error
    return { kind: 'unreadable', bytes: bytesRead }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function findMatches(
  content: string,
  query: string,
  caseSensitive: boolean,
  maxResults: number,
  path: string,
  context: Context,
): Promise<{ matches: SearchMatch[]; hasMore: boolean }> {
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: SearchMatch[] = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (index % 256 === 0) {
      abortIfRequested(context)
      if (index > 0) await yieldToAbort()
    }
    const line = lines[index] ?? ''
    const haystack = caseSensitive ? line : line.toLowerCase()
    const matchIndex = haystack.indexOf(needle)
    if (matchIndex < 0) continue
    if (matches.length >= maxResults) return { matches, hasMore: true }
    matches.push({ path, line: index + 1, excerpt: makeExcerpt(line, matchIndex) })
  }
  return { matches, hasMore: false }
}

function boundedSearch(
  values: {
    scope: string
    query: string
    caseSensitive: boolean
    scannedFiles: number
    skippedOversize: number
    skippedBinary: number
    skippedUnreadable: number
    matches: SearchMatch[]
    truncated: boolean
  },
): string {
  while (true) {
    const lines = values.matches.map(match => `- ${JSON.stringify(match.path)}:${match.line}: ${match.excerpt}`)
    const text = [
      `Found ${values.matches.length} literal match${values.matches.length === 1 ? '' : 'es'} for ${JSON.stringify(values.query)} under ${JSON.stringify(values.scope)}; searched ${values.scannedFiles} files; skipped ${values.skippedUnreadable} unreadable, ${values.skippedBinary} binary, and ${values.skippedOversize} oversized files.`,
      ...lines,
      ...(values.truncated ? ['TRUNCATED: the search is incomplete or results were omitted by workspace limits.'] : []),
    ].join('\n')
    if (Buffer.byteLength(text) <= MAX_TOOL_OUTPUT_BYTES || values.matches.length === 0) return text
    values.matches.pop()
    values.truncated = true
  }
}

const listFilesTool = defineTool({
  name: 'list_files',
  description: `List relative file and directory paths from the current workspace. path defaults to "."; recursive defaults to false; maxEntries is an integer from 1 to ${MAX_LIST_ENTRIES} (default ${MAX_LIST_ENTRIES}). Hidden paths, node_modules, common secret files, and symlinks are excluded. Read-only; does not invoke a shell.`,
  parameters: Type.Object({
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    recursive: Type.Optional(Type.Boolean()),
    maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_ENTRIES })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  execute: async (args, api, context) => {
    abortIfRequested(context)
    const root = await workspaceRoot(api, context)
    const start = await checkedPath(root, args.path, context)
    if (!start.info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'list_files requires a workspace directory.')
    const recursive = args.recursive === true
    const maxEntries = args.maxEntries === undefined
      ? MAX_LIST_ENTRIES
      : Math.max(1, Math.min(MAX_LIST_ENTRIES, Math.floor(args.maxEntries)))
    const entries: ListedEntry[] = []
    const walked = await walkDirectory(root, start, recursive, context, async entry => {
      if (entries.length >= maxEntries) return false
      entries.push({ path: entry.path, type: entry.type })
      return true
    })
    entries.sort((left, right) => left.path.localeCompare(right.path))
    return { output: textOutput(boundedListing(start.path || '.', recursive, walked.examined, entries, walked.truncated)) }
  },
})

const searchFilesTool = defineTool({
  name: 'search_files',
  description: `Search workspace text files for a single-line literal phrase of 1 to ${MAX_QUERY_LENGTH} characters (case-insensitive by default). Returns relative paths, one-based line numbers, and excerpts. path defaults to "."; recursive defaults to true; maxResults is an integer from 1 to ${MAX_SEARCH_RESULTS} (default ${MAX_SEARCH_RESULTS}). Skips hidden paths, common secret files, binary/oversized files and symlinks. Read-only; no shell.`,
  parameters: Type.Object({
    query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    recursive: Type.Optional(Type.Boolean()),
    caseSensitive: Type.Optional(Type.Boolean()),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  execute: async (args, api, context) => {
    abortIfRequested(context)
    const query = args.query.trim()
    if (query === '' || query.length > MAX_QUERY_LENGTH || /[\u0000\r\n]/.test(query)) {
      throw new RuntimeError('INVALID_INPUT', `query must be a single-line literal of 1 to ${MAX_QUERY_LENGTH} characters.`)
    }
    const root = await workspaceRoot(api, context)
    const start = await checkedPath(root, args.path, context)
    const recursive = args.recursive !== false
    const caseSensitive = args.caseSensitive === true
    const maxResults = args.maxResults === undefined
      ? MAX_SEARCH_RESULTS
      : Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(args.maxResults)))
    const matches: SearchMatch[] = []
    let scannedFiles = 0
    let skippedOversize = 0
    let skippedBinary = 0
    let skippedUnreadable = 0
    let bytesRead = 0
    let truncated = false

    const searchEntry = async (entry: WalkEntry): Promise<boolean> => {
      if (entry.type !== 'file') return true
      const read = await readSearchFile(root, entry, context, MAX_TOTAL_READ_BYTES - bytesRead)
      bytesRead += read.bytes
      if (read.kind === 'oversize') {
        skippedOversize += 1
        truncated = true
        return true
      }
      if (read.kind === 'binary') {
        skippedBinary += 1
        truncated = true
        return true
      }
      if (read.kind === 'unreadable') {
        skippedUnreadable += 1
        truncated = true
        return true
      }
      scannedFiles += 1
      const found = await findMatches(read.content, query, caseSensitive, maxResults - matches.length, entry.path, context)
      matches.push(...found.matches)
      if (found.hasMore || matches.length >= maxResults) {
        truncated ||= found.hasMore
        return !found.hasMore
      }
      return true
    }

    if (start.info.isFile()) {
      const result = await searchEntry({ ...start, type: 'file' })
      if (!result) truncated = true
    } else if (start.info.isDirectory()) {
      if (recursive) {
        const walked = await walkDirectory(root, start, true, context, searchEntry)
        truncated ||= walked.truncated
      } else {
        const walked = await walkDirectory(root, start, false, context, searchEntry)
        truncated ||= walked.truncated
      }
    } else {
      throw new RuntimeError('INVALID_INPUT', 'search_files requires a regular file or workspace directory.')
    }

    const text = boundedSearch({
      scope: start.path || '.',
      query,
      caseSensitive,
      scannedFiles,
      skippedOversize,
      skippedBinary,
      skippedUnreadable,
      matches,
      truncated,
    })
    return { output: textOutput(text) }
  },
})

export const ResearchTools: Extension = defineExtension({
  name: 'research-tools',
  tools: [listFilesTool, searchFilesTool],
})
