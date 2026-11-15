import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { searchWithRipgrep } from './search/native.ts'
import { boundedSearch, MAX_TOOL_OUTPUT_BYTES, makeExcerpt, type SearchMatch } from './search/format.ts'
import { RuntimeError } from '../runtime-errors.ts'

/** 四个检索工具名：list_files / search_files / glob / grep。 */
export const RESEARCH_TOOL_NAMES = ['list_files', 'search_files', 'glob', 'grep'] as const

/** 相对路径参数的最大长度。 */
const MAX_PATH_LENGTH = 1_024
/** search_files 查询词的最大长度。 */
const MAX_QUERY_LENGTH = 200
/** glob/grep 模式的最大长度。 */
const MAX_PATTERN_LENGTH = 1_024
/** 目录遍历的节点（条目）上限。 */
const MAX_SCAN_NODES = 2_000
/** glob 遍历的节点上限（含隐藏路径故放宽）。 */
const MAX_GLOB_SCAN_NODES = 5_000
/** 单个文件读入的字节上限。 */
const MAX_FILE_BYTES = 512 * 1_024
/** 单次搜索累计读取的字节上限。 */
const MAX_TOTAL_READ_BYTES = 4 * 1_024 * 1_024
/** list_files 返回条目上限。 */
const MAX_LIST_ENTRIES = 100
/** search_files/grep 的结果数上限。 */
const MAX_SEARCH_RESULTS = 50
/** glob 的结果数上限。 */
const MAX_GLOB_RESULTS = 100
/** 单条结果路径的长度上限（超长计入截断）。 */
const MAX_RESULT_PATH_LENGTH = 512

/** 默认遍历排除的目录：隐藏路径、node_modules、运行时数据目录。 */
const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', '.data'])
/** glob 遍历排除的目录（含隐藏路径，只排除 VCS 元数据、生成树与数据目录）。 */
const GLOB_OMITTED_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', 'dist', '.data'])
/** 视为敏感凭据的文件扩展名。 */
const PRIVATE_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore'])
/** 视为敏感凭据的文件名模式（credentials/secrets/tokens/私钥等）。 */
const PRIVATE_FILE_NAME = /^(?:(?:credentials?|secrets?|tokens?|private[-_]?key)\.(?:json|ya?ml|toml|txt)|id_rsa|id_ed25519)$/i

/** list_files 的一条结果：相对路径与条目类型。 */
type ListedEntry = { path: string; type: 'file' | 'directory' }
/** glob 的一条命中：相对路径与修改时间。 */
type GlobMatch = { path: string; mtimeMs: number }
/** 工作区内一个已校验的路径：相对路径、绝对路径（规范化）与 lstat 信息。 */
type WorkspacePath = { path: string; absolute: string; info: Awaited<ReturnType<typeof lstat>> }
/** 遍历中的一个条目：WorkspacePath 再加类型与修改时间。 */
type WalkEntry = WorkspacePath & { type: 'file' | 'directory'; mtimeMs: number }
/** 搜索时读一个文件的结果：文本/超大/二进制/不可读四种。 */
type SearchRead =
  | { kind: 'text'; content: string; bytes: number }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'binary'; bytes: number }
  | { kind: 'unreadable'; bytes: number }

/** 判断 target 是否位于 root 之内（相对路径不为 `..` 开头且非绝对）。 */
function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** 判断错误是否为文件不存在（ENOENT）。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * 功能：校验并规范化相对路径参数。
 * 输入校验：必须为相对、无反斜杠、无 NUL、无盘符、长度 ≤ MAX_PATH_LENGTH；含 `..`
 * 段抛 FORBIDDEN；命中隐藏/敏感名抛 FORBIDDEN。
 * @param value 调用方传入的路径。
 * @returns 规范化后的相对路径（去除空段与 `.`）。
 */
function safeRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || value.includes('\u0000') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new RuntimeError('INVALID_INPUT', `Workspace paths must be relative and no longer than ${MAX_PATH_LENGTH} characters.`)
  }
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) throw new RuntimeError('FORBIDDEN', 'A research tool cannot access paths outside the current workspace.')
  if (segments.some(isRestrictedName)) throw new RuntimeError('FORBIDDEN', 'Hidden and credential-related paths are excluded from workspace research.')
  return segments.join('/')
}

/** 判断文件名是否属于敏感凭据文件（按扩展名或名称模式）。 */
function isPrivateFile(name: string): boolean {
  const extension = name.toLowerCase().slice(name.toLowerCase().lastIndexOf('.'))
  return PRIVATE_FILE_NAME.test(name) || PRIVATE_FILE_EXTENSIONS.has(extension)
}

/** 默认遍历的名称过滤：隐藏名、OMITTED_DIRECTORIES、敏感凭据文件一律跳过。 */
function isRestrictedName(name: string): boolean {
  return name.startsWith('.') || OMITTED_DIRECTORIES.has(name.toLowerCase()) || isPrivateFile(name)
}

/** glob 的发现包含隐藏路径，但仍拒绝 VCS 元数据、生成树与凭据文件。 */
function isGlobExcluded(name: string): boolean {
  return GLOB_OMITTED_DIRECTORIES.has(name.toLowerCase()) || isPrivateFile(name)
}

/**
 * `path.matchesGlob` 会把开头的点视为"不被 * 匹配"。两侧的点段都用 NUL 前缀标记掩码
 * （路径里不可能有 NUL），使隐藏文件仍可被发现。
 */
const GLOB_DOT = '\u0000dot\u0000'

/** 掩码单个段：以点开头的段替换点为 GLOB_DOT 标记。 */
function maskGlobSegment(segment: string): string {
  return segment.startsWith('.') ? `${GLOB_DOT}${segment.slice(1)}` : segment
}

/** 掩码整条路径的每个段。 */
function maskGlobPath(value: string): string {
  return value.split('/').map(maskGlobSegment).join('/')
}

/**
 * 功能：校验并规范化 glob 模式。
 * 输入校验：必须为相对、非空、无反斜杠/NUL/盘符、长度 ≤ MAX_PATTERN_LENGTH；含 `..`
 * 段抛 FORBIDDEN。
 * @param value 调用方传入的模式。
 * @returns 规范化模式；不含 `/` 时自动加双星加斜杠前缀匹配任意深度。
 */
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

/**
 * 功能：构造 glob 匹配函数。
 * 内部逻辑：模式与路径两侧都先做点段掩码；引擎抛错时转成 INVALID_INPUT RuntimeError。
 * @param value 调用方传入的模式。
 * @returns 判定相对路径是否命中的谓词。
 */
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

/** grep 的 include 过滤：未传返回 undefined（不过滤），传了复用 glob 匹配。 */
function includeMatcher(value: unknown): ((path: string) => boolean) | undefined {
  if (value === undefined) return undefined
  return globMatcher(value)
}

/**
 * 功能：校验 grep 模式：非空单行字符串、无 NUL、长度 ≤ MAX_PATTERN_LENGTH。
 * @param value 调用方传入的正则模式。
 * @returns 原始模式字符串。
 */
function validateGrepPattern(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_PATTERN_LENGTH
    || value.includes('\u0000') || /[\r\n]/.test(value)) {
    throw new RuntimeError('INVALID_INPUT', `grep patterns must be a single-line non-empty string no longer than ${MAX_PATTERN_LENGTH} characters.`)
  }
  return value
}

/** 为 JavaScript 回退编译正则；原生路径直接使用 ripgrep 语法。 */
function grepPattern(value: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(value, caseSensitive ? '' : 'i')
  } catch (error) {
    throw new RuntimeError('INVALID_INPUT', `grep pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 功能：取当前会话绑定的 workspace 目录。
 * 输入校验：cwd 缺失、为空或非绝对路径抛 UNSUPPORTED。
 * @param api 工具执行 API。
 * @returns workspace 目录路径。
 */
function requireWorkspace(api: ToolExecutionApi): string {
  const cwd = api.env?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '' || !isAbsolute(cwd)) {
    throw new RuntimeError('UNSUPPORTED', 'The current conversation has no bound workspace directory.')
  }
  return cwd
}

/** 已请求中止时立即抛 AbortError。 */
function abortIfRequested(context: Context): void {
  context.abortSignal?.throwIfAborted()
}

/**
 * 功能：解析并校验 workspace 根目录。
 * 输入校验：检查中止信号（解析前后各一次）；目录不存在抛 NOT_FOUND；不是目录抛
 * INVALID_INPUT。
 * @param api 工具执行 API。
 * @param context 执行上下文。
 * @returns realpath 规范化后的 workspace 根。
 */
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

/**
 * 功能：把相对路径解析为 workspace 内的已校验路径，只解析存在的路径。
 * 权限检查：逐段 lstat——任一段是符号链接抛 FORBIDDEN；中间段不是目录抛
 * INVALID_INPUT；缺失抛 NOT_FOUND；越出 workspace（解析前后各查一次 isWithin）抛
 * FORBIDDEN。
 * @param root workspace 根。
 * @param path 相对路径（可为 undefined，表示根本身）。
 * @param context 执行上下文。
 * @returns 规范化的 WorkspacePath。
 */
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

/**
 * 功能：广度优先遍历 workspace 目录，逐条目回调 visit。
 * 权限检查：目录与子项均拒绝符号链接；每层 realpath 校验不越出 root。
 * 边界：按 filter 跳过受限名； examined 超过 maxNodes 或 visit 返回 false（配额满）
 * 即停止并标记 truncated；相对路径超 MAX_RESULT_PATH_LENGTH 也计入截断。
 * @param root workspace 根。
 * @param start 遍历起点。
 * @param recursive 是否递归子目录。
 * @param context 执行上下文。
 * @param visit 逐条目回调，返回 false 停止遍历。
 * @param filter 名称过滤器，默认 isRestrictedName。
 * @param maxNodes 节点上限。
 * @returns 检查的条目数与是否被截断。
 */
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

/** 构造标准的单段文本输出块。 */
function textOutput(text: string) {
  return [{ type: 'text' as const, text }]
}

/**
 * 功能：在工具输出字节预算内渲染 list_files 结果。
 * 内部逻辑：循环从尾部逐条丢弃并标记 truncated，直到文本落入 MAX_TOOL_OUTPUT_BYTES。
 */
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

/**
 * 功能：在工具输出字节预算内渲染 glob 结果（同 boundedListing 的裁剪策略）。
 */
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

/** 让出一个事件循环节拍（setImmediate），使长扫描期间的 abort 信号有机会被处理。 */
async function yieldToAbort(): Promise<void> {
  await new Promise<void>(resolveNext => setImmediate(resolveNext))
}

/**
 * 功能：为搜索安全地读一个文件。
 * 输入校验/边界：先按 lstat 大小判断超大（MAX_FILE_BYTES 或剩余配额不足）；
 * checkedPath 逐段校验路径；用 O_NOFOLLOW 打开并比对 dev/ino 防止打开期间被换成
 * 符号链接；分块读取（每块 64 KiB）并周期性检查中止；读完再确认文件没有在读取期间
 * 变大（否则归为 oversize）；内容含 NUL 判为二进制；打开/读取失败归为 unreadable。
 * @param root workspace 根。
 * @param entry 遍历条目。
 * @param context 执行上下文。
 * @param remainingBytes 本次搜索剩余的可读字节配额。
 * @returns SearchRead 四类结果之一。
 */
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

/**
 * 功能：在文件内容中做字面量子串匹配（逐行）。
 * 边界：每 256 行检查一次中止并让出事件循环；达到 maxResults 即停止并标记 hasMore；
 * 摘录经 makeExcerpt 以命中位置居中截取。
 * @param content 文件文本内容。
 * @param query 字面量查询词。
 * @param caseSensitive 是否区分大小写。
 * @param maxResults 本文件允许的最大命中数。
 * @param path 相对路径（写入结果）。
 * @param context 执行上下文。
 * @returns 命中列表与是否还有更多。
 */
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

/**
 * 功能：在文件内容中做正则匹配（逐行，JavaScript 回退引擎）。
 * 边界：与 findMatches 相同——每 256 行让出事件循环；达到 maxResults 标记 hasMore。
 * @param content 文件文本内容。
 * @param regex 已编译的正则。
 * @param maxResults 本文件允许的最大命中数。
 * @param path 相对路径（写入结果）。
 * @param context 执行上下文。
 * @returns 命中列表与是否还有更多。
 */
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

/** `list_files` 工具：列出工作区文件与目录相对路径，边界见 execute 注释。 */
const listFilesTool = defineTool({
  name: 'list_files',
  description: `列出当前工作区中的文件和目录相对路径。path 默认 "."；recursive 默认 false；maxEntries 为 1 到 ${MAX_LIST_ENTRIES} 的整数（默认 ${MAX_LIST_ENTRIES}）。排除隐藏路径、node_modules、常见敏感文件及符号链接。只读，不调用 shell。`,
  parameters: Type.Object({
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    recursive: Type.Optional(Type.Boolean()),
    maxEntries: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_ENTRIES })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  /**
   * 功能：列出工作区条目。
   * 输入校验：path 必须指向 workspace 内目录；maxEntries 夹取到 1–MAX_LIST_ENTRIES。
   * 边界：walkDirectory 限节点数与符号链接；结果按路径排序，输出受字节预算裁剪。
   */
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

/** `search_files` 工具：工作区字面量文本搜索，边界见 execute 注释。 */
const searchFilesTool = defineTool({
  name: 'search_files',
  description: `在工作区文本文件中搜索长度为 1 到 ${MAX_QUERY_LENGTH} 字符的单行字面量短语，默认忽略大小写。返回相对路径、从 1 开始的行号和片段。path 默认 "."；recursive 默认 true；maxResults 为 1 到 ${MAX_SEARCH_RESULTS} 的整数（默认 ${MAX_SEARCH_RESULTS}）。跳过隐藏路径、常见敏感文件、二进制或过大文件及符号链接。只读，不使用 shell。`,
  parameters: Type.Object({
    query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    recursive: Type.Optional(Type.Boolean()),
    caseSensitive: Type.Optional(Type.Boolean()),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  /**
   * 功能：在工作区文本文件中做字面量搜索。
   * 输入校验：query 为单行、1–MAX_QUERY_LENGTH 字符、无 NUL；path 可为文件或目录。
   * 边界：累计读取不超 MAX_TOTAL_READ_BYTES（超配额文件计 oversize）；跳过二进制/
   * 不可读文件并计数；达到 maxResults 停止；结果经 boundedSearch 裁剪到字节预算。
   */
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

/** `glob` 工具：按 glob 模式查文件（含隐藏路径），边界见 execute 注释。 */
const globTool = defineTool({
  name: 'glob',
  description: `查找路径匹配 glob 模式的文件。模式不含 "/" 时匹配任意深度的文件名；"**" 匹配任意深度。包含隐藏路径；排除 VCS 元数据、node_modules、dist、.data、常见敏感文件及符号链接。按修改时间从新到旧返回最多 ${MAX_GLOB_RESULTS} 个路径。只读，不使用 shell。优先使用本工具，不用 find 或 ls -R。`,
  parameters: Type.Object({
    pattern: Type.String({ minLength: 1, maxLength: MAX_PATTERN_LENGTH }),
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GLOB_RESULTS })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  /**
   * 功能：按 glob 模式查找文件。
   * 输入校验：pattern 经 globMatcher（含相对/长度/越界校验）。
   * 边界：递归遍历用 isGlobExcluded 过滤、节点上限 MAX_GLOB_SCAN_NODES；命中按修改
   * 时间新到旧排序后截取 maxResults；输出经 boundedGlob 裁剪到字节预算。
   */
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

/** `grep` 工具：正则文本搜索（原生 ripgrep 优先，JavaScript 回退），边界见 execute 注释。 */
const grepTool = defineTool({
  name: 'grep',
  description: `使用正则表达式搜索工作区文本文件（原生 ripgrep，可回退到 JavaScript；默认忽略大小写）。用于查找未知内容或文件位置；已知文件路径时直接用 read。不要通过 shell 运行 \`grep\` 或 \`rg\`，它们会绕过工作区策略、输出限制和敏感文件过滤。原生引擎使用 ripgrep 正则语法；ripgrep 拒绝模式时会尝试 JavaScript 回退。path 默认 "."；include 可按 glob 过滤文件（如 "*.ts"）；maxResults 为 1 到 ${MAX_SEARCH_RESULTS} 的整数（默认 ${MAX_SEARCH_RESULTS}）。跳过隐藏路径、node_modules、常见敏感文件、二进制或过大文件及符号链接。只读，不使用 shell。`,
  parameters: Type.Object({
    pattern: Type.String({ minLength: 1, maxLength: MAX_PATTERN_LENGTH }),
    path: Type.Optional(Type.String({ maxLength: MAX_PATH_LENGTH })),
    include: Type.Optional(Type.String({ maxLength: MAX_PATTERN_LENGTH })),
    caseSensitive: Type.Optional(Type.Boolean()),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
  }),
  outputLimits: { maxBytes: MAX_TOOL_OUTPUT_BYTES },
  /**
   * 功能：用正则在 workspace 内搜索文本文件。
   * 输入校验：pattern 单行非空限长；include 为可选 glob；path 为文件或目录。
   * 权限/边界：原生 ripgrep 带 abort 信号；失败时写 info 诊断并回退到 JavaScript
   * 遍历（同样的符号链接/敏感文件/字节配额约束）；结果经 boundedSearch 裁剪到字节预算。
   */
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

/** research 工具扩展：贡献 list_files / search_files / glob / grep 四个只读工具，不贡献 section。 */
export const ResearchTools: Extension = defineExtension({
  name: 'research-tools',
  tools: [listFilesTool, searchFilesTool, globTool, grepTool],
})
