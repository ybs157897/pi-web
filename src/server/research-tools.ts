import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { searchWithRipgrep } from './native-search.ts'
import { boundedSearch, MAX_TOOL_OUTPUT_BYTES, makeExcerpt, type SearchMatch } from './search-format.ts'
import { RuntimeError } from './runtime-errors.ts'

export const RESEARCH_TOOL_NAMES = ['list_files', 'search_files', 'glob', 'grep'] as const

const MAX_PATH_LENGTH = 1_024
const MAX_QUERY_LENGTH = 200
const MAX_PATTERN_LENGTH = 1_024
const MAX_SCAN_NODES = 2_000
const MAX_GLOB_SCAN_NODES = 5_000
const MAX_FILE_BYTES = 512 * 1_024
const MAX_TOTAL_READ_BYTES = 4 * 1_024 * 1_024
const MAX_LIST_ENTRIES = 100
const MAX_SEARCH_RESULTS = 50
const MAX_GLOB_RESULTS = 100
const MAX_RESULT_PATH_LENGTH = 512

const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', '.data'])
const GLOB_OMITTED_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', 'dist', '.data'])
const PRIVATE_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore'])
const PRIVATE_FILE_NAME = /^(?:(?:credentials?|secrets?|tokens?|private[-_]?key)\.(?:json|ya?ml|toml|txt)|id_rsa|id_ed25519)$/i

type ListedEntry = { path: string; type: 'file' | 'directory' }
type GlobMatch = { path: string; mtimeMs: number }
type WorkspacePath = { path: string; absolute: string; info: Awaited<ReturnType<typeof lstat>> }
type WalkEntry = WorkspacePath & { type: 'file' | 'directory'; mtimeMs: number }
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

function isPrivateFile(name: string): boolean {
  const extension = name.toLowerCase().slice(name.toLowerCase().lastIndexOf('.'))
  return PRIVATE_FILE_NAME.test(name) || PRIVATE_FILE_EXTENSIONS.has(extension)
}

function isRestrictedName(name: string): boolean {
  return name.startsWith('.') || OMITTED_DIRECTORIES.has(name.toLowerCase()) || isPrivateFile(name)
}

/** Glob discovery includes hidden paths but still refuses VCS metadata, generated trees, and credential files. */
function isGlobExcluded(name: string): boolean {
  return GLOB_OMITTED_DIRECTORIES.has(name.toLowerCase()) || isPrivateFile(name)
}

/**
 * `path.matchesGlob` treats a leading dot as "not matched by *". Mask dot segments on both
 * sides with a NUL-prefixed marker (paths cannot contain NUL) so hidden files stay discoverable.
 */
const GLOB_DOT = '\u0000dot\u0000'

function maskGlobSegment(segment: string): string {
  return segment.startsWith('.') ? `${GLOB_DOT}${segment.slice(1)}` : segment
}

function maskGlobPath(value: string): string {
  return value.split('/').map(maskGlobSegment).join('/')
}

function globPattern(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_PATTERN_LENGTH
    || value.includes('\u0000') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new RuntimeError('INVALID_INPUT', `Glob patterns must be relative, non-empty, and no longer than ${MAX_PATTERN_LENGTH} characters.`)
  }
  const pattern = value.trim()
  if (pattern.split('/').some(segment => segment === '..')) {
    throw new RuntimeError('FORBIDDEN', 'A research tool cannot match paths outside the current workspace.')
  }
  return pattern.includes('/') ? pattern : `**/${pattern}`
}

function globMatcher(value: unknown): (path: string) => boolean {
  const pattern = maskGlobPath(globPattern(value))
  return (path) => {
    try {
      return posix.matchesGlob(maskGlobPath(path), pattern)
    } catch (error) {
      throw new RuntimeError('INVALID_INPUT', `Invalid glob pattern: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function includeMatcher(value: unknown): ((path: string) => boolean) | undefined {
  if (value === undefined) return undefined
  return globMatcher(value)
}

function validateGrepPattern(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_PATTERN_LENGTH
    || value.includes('\u0000') || /[\r\n]/.test(value)) {
    throw new RuntimeError('INVALID_INPUT', `grep patterns must be a single-line non-empty string no longer than ${MAX_PATTERN_LENGTH} characters.`)
  }
  return value
}

/** Compile a pattern for the JavaScript fallback; the native path uses ripgrep syntax directly. */
function grepPattern(value: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(value, caseSensitive ? '' : 'i')
  } catch (error) {
    throw new RuntimeError('INVALID_INPUT', `grep pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
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
  filter: (name: string) => boolean = isRestrictedName,
  maxNodes = MAX_SCAN_NODES,
): Promise<{ examined: number; truncated: boolean }> {
  if (!start.info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'This tool requires a workspace directory.')
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
        if (examined > maxNodes) {
          truncated = true
          stop = true
          break
        }
        if (filter(entry.name)) continue
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
          mtimeMs: childInfo.mtimeMs,
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
  return { examined: Math.min(examined, maxNodes), truncated }
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

function boundedGlob(scope: string, pattern: string, examined: number, entries: GlobMatch[], truncated: boolean): string {
  while (true) {
    const lines = entries.map(entry => `- ${JSON.stringify(entry.path)}`)
    const text = [
      `Found ${entries.length} files matching ${JSON.stringify(pattern)} under ${JSON.stringify(scope)} in modification-time order (newest first; ${examined} entries examined).`,
      ...lines,
      ...(truncated ? ['TRUNCATED: workspace research limits omitted additional files or reordered the complete list.'] : []),
    ].join('\n')
    if (Buffer.byteLength(text) <= MAX_TOOL_OUTPUT_BYTES || entries.length === 0) return text
    entries.pop()
    truncated = true
  }
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

async function findRegexMatches(
  content: string,
  regex: RegExp,
  maxResults: number,
  path: string,
  context: Context,
): Promise<{ matches: SearchMatch[]; hasMore: boolean }> {
  const matches: SearchMatch[] = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (index % 256 === 0) {
      abortIfRequested(context)
      if (index > 0) await yieldToAbort()
    }
    const line = lines[index] ?? ''
    const matchIndex = line.search(regex)
    if (matchIndex < 0) continue
    if (matches.length >= maxResults) return { matches, hasMore: true }
    matches.push({ path, line: index + 1, excerpt: makeExcerpt(line, matchIndex) })
  }
  return { matches, hasMore: false }
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
      const result = await searchEntry({ ...start, type: 'file', mtimeMs: Number(start.info.mtimeMs) })
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
      kind: 'literal',
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

const globTool = defineTool({
  name: 'glob',
  description: `Find files whose paths match a glob pattern. A pattern without "/" matches the basename at any depth; "**" matches any depth. Includes hidden paths; excludes VCS metadata, node_modules, dist, .data, common secret files, and symlinks. Returns up to ${MAX_GLOB_RESULTS} paths in modification-time order (newest first). Read-only; no shell. Prefer this over find or ls -R.`,
  parameters: Type.Object({
    pattern: Type.String({ minLength: 1, maxLength: MAX_PATTERN_LENGTH }),
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GLOB_RESULTS })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  execute: async (args, api, context) => {
    abortIfRequested(context)
    const matchesPattern = globMatcher(args.pattern)
    const root = await workspaceRoot(api, context)
    const start = await checkedPath(root, args.path, context)
    const maxResults = args.maxResults === undefined
      ? MAX_GLOB_RESULTS
      : Math.max(1, Math.min(MAX_GLOB_RESULTS, Math.floor(args.maxResults)))
    const entries: GlobMatch[] = []
    const walked = await walkDirectory(root, start, true, context, async entry => {
      if (entry.type === 'file' && matchesPattern(entry.path)) {
        entries.push({ path: entry.path, mtimeMs: entry.mtimeMs })
      }
      return true
    }, isGlobExcluded, MAX_GLOB_SCAN_NODES)
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    const limited = entries.slice(0, maxResults)
    const truncated = walked.truncated || entries.length > limited.length
    return { output: textOutput(boundedGlob(start.path || '.', args.pattern, walked.examined, limited, truncated)) }
  },
})

const grepTool = defineTool({
  name: 'grep',
  description: `Search workspace text files with a regular expression (native ripgrep, with a JavaScript fallback; case-insensitive by default). Use this to find unknown content or file locations; use read directly when you know the file path. Do not run \`grep\` or \`rg\` via shell: they bypass workspace policy, output limits, and sensitive-file filtering. Patterns use ripgrep regex syntax when the native engine runs; if ripgrep rejects a pattern, the JavaScript fallback is tried. path defaults to "."; include optionally filters files by glob (for example "*.ts"); maxResults is an integer from 1 to ${MAX_SEARCH_RESULTS} (default ${MAX_SEARCH_RESULTS}). Skips hidden paths, node_modules, common secret files, binary/oversized files and symlinks. Read-only; no shell.`,
  parameters: Type.Object({
    pattern: Type.String({ minLength: 1, maxLength: MAX_PATTERN_LENGTH }),
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    include: Type.Optional(Type.String({ maxLength: MAX_PATTERN_LENGTH })),
    caseSensitive: Type.Optional(Type.Boolean()),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  execute: async (args, api, context) => {
    abortIfRequested(context)
    const pattern = validateGrepPattern(args.pattern)
    const include = includeMatcher(args.include)
    const root = await workspaceRoot(api, context)
    const start = await checkedPath(root, args.path, context)
    const recursive = true
    const maxResults = args.maxResults === undefined
      ? MAX_SEARCH_RESULTS
      : Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(args.maxResults)))
    if (!start.info.isFile() && !start.info.isDirectory()) {
      throw new RuntimeError('INVALID_INPUT', 'grep requires a regular file or workspace directory.')
    }

    const native = await searchWithRipgrep({
      root,
      searchPath: start.absolute,
      pattern,
      include: args.include,
      caseSensitive: args.caseSensitive === true,
      maxResults,
      signal: context.abortSignal,
    })
    abortIfRequested(context)
    if (native.kind === 'ok') {
      return {
        output: textOutput(boundedSearch({
          scope: start.path || '.',
          query: args.pattern,
          kind: 'regex',
          include: args.include,
          scannedFiles: native.scannedFiles,
          skippedOversize: 0,
          skippedBinary: 0,
          skippedUnreadable: 0,
          matches: native.matches,
          truncated: native.truncated,
        })),
      }
    }
    if (native.kind === 'failed') {
      api.diagnostic({
        severity: 'info',
        code: 'native_search_fallback',
        message: `Native ripgrep search failed (${native.reason}); used the JavaScript walker instead.`,
      })
    }

    const regex = grepPattern(pattern, args.caseSensitive === true)
    const matches: SearchMatch[] = []
    let scannedFiles = 0
    let skippedOversize = 0
    let skippedBinary = 0
    let skippedUnreadable = 0
    let bytesRead = 0
    let truncated = false

    const searchEntry = async (entry: WalkEntry): Promise<boolean> => {
      if (entry.type !== 'file' || (include !== undefined && !include(entry.path))) return true
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
      const found = await findRegexMatches(read.content, regex, maxResults - matches.length, entry.path, context)
      matches.push(...found.matches)
      if (found.hasMore || matches.length >= maxResults) {
        truncated ||= found.hasMore
        return !found.hasMore
      }
      return true
    }

    if (start.info.isFile()) {
      const result = await searchEntry({ ...start, type: 'file', mtimeMs: Number(start.info.mtimeMs) })
      if (!result) truncated = true
    } else if (start.info.isDirectory()) {
      const walked = await walkDirectory(root, start, recursive, context, searchEntry)
      truncated ||= walked.truncated
    } else {
      throw new RuntimeError('INVALID_INPUT', 'grep requires a regular file or workspace directory.')
    }

    const text = boundedSearch({
      scope: start.path || '.',
      query: args.pattern,
      kind: 'regex',
      include: args.include,
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
  tools: [listFilesTool, searchFilesTool, globTool, grepTool],
})
