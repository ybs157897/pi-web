import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkspaceFile, WorkspaceFileEntry, WorkspaceSummary } from '../../shared/types.ts'
import { RuntimeError } from '../runtime-errors.ts'

/** 用户上传的一个附件（Base64 内容）。 */
export interface AttachmentInput { name: string; mimeType: string; data: string }
/** 附件保存后的引用（含工作区内相对路径）。 */
export type AttachmentReference = { name: string; mimeType: string; size: number; path: string }

const MAX_FILE_PREVIEW_BYTES = 8 * 1024 * 1024
const MAX_FILE_TEXT_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_FILES = 5_000
/** 常见扩展名到 MIME 的映射表。 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.c': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.css': 'text/css', '.csv': 'text/csv',
  '.go': 'text/x-go', '.html': 'text/html', '.java': 'text/x-java', '.js': 'text/javascript', '.json': 'application/json',
  '.md': 'text/markdown', '.mjs': 'text/javascript', '.pdf': 'application/pdf', '.py': 'text/x-python', '.rs': 'text/x-rust',
  '.sh': 'text/x-shellscript', '.sql': 'application/sql', '.svg': 'image/svg+xml', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.txt': 'text/plain', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml',
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
}
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/
/** 无扩展名的文本文件（`Makefile` 取不到 extname，扩展名表永远看不到它）。 */
const TEXT_FILE_NAMES = new Set([
  'makefile', 'dockerfile', 'containerfile', 'justfile', 'procfile', 'rakefile', 'gemfile', 'brewfile', 'vagrantfile',
  'license', 'licence', 'readme', 'notice', 'changelog', 'changes', 'contributing', 'authors', 'contributors',
  'code_of_conduct', 'security', 'install', 'uninstall', 'todo', 'news',
  '.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.editorconfig', '.eslintignore', '.prettierignore',
  '.npmignore', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.babelrc', '.stylelintrc', '.browserslistrc', '.env',
])

/** 判断 target 是否位于 root 内（含等于 root），防路径逃逸。 */
function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** 判断错误是否为 ENOENT（路径不存在）。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * 把「文件不存在」从底层的 ENOENT 变成 404。
 *
 * 模型写进回答里的路径常常指向另一个项目，文件被删掉也是常事；这两种都不该
 * 变成服务器故障（500 internal server error），而该告诉用户文件不在工作区里。
 */
async function existing<T>(operation: () => Promise<T>, path: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isMissing(error)) throw new RuntimeError('NOT_FOUND', `文件不存在或已被删除：${path}`)
    throw error
  }
}

/** 清洗上传文件名：取 basename、路径分隔符替换为 `_`、剔除控制字符；空名/点/超 200 字符抛错。 */
function safeFileName(value: string): string {
  const name = basename(value.split('/').join('_').split(String.fromCharCode(92)).join('_'))
    .split('')
    .filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
  if (!name || name === '.' || name === '..' || name.length > 200) throw new RuntimeError('INVALID_INPUT', '文件名无效')
  return name
}

/** 工作区相对路径安全化：拒绝超长、NUL、反斜杠、绝对路径与盘符；`..` 上跳抛 FORBIDDEN。 */
function safeRelativePath(path: string): string {
  if (path.length > 2048 || path.includes('\u0000') || path.includes('\\') || isAbsolute(path) || WINDOWS_DRIVE_PREFIX.test(path)) {
    throw new RuntimeError('INVALID_INPUT', '工作区路径无效')
  }
  const segments = path.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) throw new RuntimeError('FORBIDDEN', '不能访问工作区以外的路径')
  return segments.join('/')
}

/**
 * Reads a requested path with the rules of the host it runs on. A drive letter only
 * names a location on Windows, so elsewhere such a path stays an unresolvable name
 * instead of being guessed into a file of the workspace.
 */
function platformAbsolutePath(path: string): string | undefined {
  if (WINDOWS_DRIVE_PREFIX.test(path)) {
    if (process.platform !== 'win32') return undefined
    return resolve(path)
  }
  return isAbsolute(path) ? resolve(path) : undefined
}

/**
 * 功能：把请求路径转成安全的工作区相对路径。
 * @param root 工作区根（已 realpath）
 * @param requested 原始请求路径（工具可能回报绝对路径或反斜杠分隔符）
 * @param declared 添加工作区时的原始路径，作为第二个可接受的根
 * @returns 以 `/` 分隔的相对路径
 * 内部逻辑：反斜杠统一成 `/` 后先判长度与 NUL；按宿主平台解析绝对路径（Windows
 * 盘符路径只在 win32 上有效，其他平台视为不可解析的名字），指向工作区内（根或
 * declared 任一命中）就映射回相对路径，逃出工作区保持原拒绝行为。
 */
export function resolveWorkspacePath(root: string, requested: string, declared?: string): string {
  const normalized = requested.replace(/\\/g, '/')
  if (normalized.length > 2048 || normalized.includes('\u0000')) throw new RuntimeError('INVALID_INPUT', '工作区路径无效')
  const absolute = platformAbsolutePath(normalized)
  if (absolute === undefined) return safeRelativePath(normalized)
  // 工作区可能以「添加时的路径」或「resolved 后的路径」被引用，工具回报的是前者，
  // 所以两个根都接受。
  for (const base of declared === undefined ? [root] : [root, declared]) {
    if (!isWithin(base, absolute)) continue
    return safeRelativePath(relative(base, absolute).split(sep).join('/'))
  }
  throw new RuntimeError('INVALID_INPUT', '工作区路径无效')
}

/**
 * 功能：把相对路径解析为根内的规范绝对路径，逐段拦截符号链接。
 * @param allowMissingFinal 允许最后一段不存在（保存附件的新文件用）
 * @returns realpath 后的规范路径； realpath 失败且允许缺失时退回 resolve 结果
 * 内部逻辑：先安全化相对路径并整体 isWithin 校验；再逐段 lstat——任何一段是符号
 * 链接即 FORBIDDEN，中间段不是目录报错；最后 realpath 再核一次仍在根内（防根
 * 自身或尾部链接被换走）。
 */
async function checkedPath(root: string, relativePath: string, allowMissingFinal = false): Promise<string> {
  const safePath = safeRelativePath(relativePath)
  const target = resolve(root, safePath)
  if (!isWithin(root, target)) throw new RuntimeError('FORBIDDEN', '不能访问工作区以外的路径')
  let cursor = root
  const segments = safePath ? safePath.split('/') : []
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', '工作区文件路径不能经过符号链接')
      if (index < segments.length - 1 && !info.isDirectory()) throw new RuntimeError('INVALID_INPUT', '工作区路径中的目录无效')
    } catch (error) {
      if (!(allowMissingFinal && index === segments.length - 1 && isMissing(error))) throw error
    }
  }
  let canonical: string
  try {
    canonical = await realpath(target)
  } catch (error) {
    if (!allowMissingFinal || !isMissing(error)) throw error
    canonical = resolve(target)
  }
  if (!isWithin(root, canonical)) throw new RuntimeError('FORBIDDEN', '不能访问工作区以外的路径')
  return canonical
}

/** 按扩展名/已知文件名推断 MIME；未命中回退 application/octet-stream。 */
function mimeType(path: string): string {
  if (TEXT_FILE_NAMES.has(basename(path).toLocaleLowerCase())) return 'text/plain'
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** 超过该字节数的样本，只靠控制字符扫描判断（不再做 UTF-8 解码验证）。 */
const TEXT_SNIFF_LIMIT = 8 * 1024

/**
 * 功能：判断未知类型的文件是否按文本读。
 * 内部逻辑：头部（≤ TEXT_SNIFF_LIMIT）除 tab/换行/回车外不得有控制字节；头部还
 * 必须以严格 UTF-8 解码通过。样本可能截断在多字节序列中间，会把合法文本误报成
 * 替换字符，所以大文件只解码到最后一个序列边界为止。
 */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, TEXT_SNIFF_LIMIT))
  for (let index = 0; index < sample.length; index += 1) {
    const byte = sample[index]!
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 32 || byte === 127) return false
  }
  const end = buffer.length <= sample.length ? sample.length : sample.length - 3
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, end)))
    return true
  } catch {
    return false
  }
}

/** 扩展名表叫不出 `Makefile` 这类文件；类型未知时由内容嗅探决定。 */
function effectiveMimeType(path: string, buffer: Buffer): string {
  const type = mimeType(path)
  if (type !== 'application/octet-stream') return type
  return looksLikeText(buffer) ? 'text/plain' : type
}

/** 永远不会有读者想点开的目录（构建产物、依赖、缓存）。 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target',
  '.dist', '.generated', '.output', '.vercel', '.parcel-cache', '.svelte-kit',
])
const MAX_SUFFIX_SCAN = 20_000
const MAX_SUFFIX_CANDIDATES = 200

/**
 * 功能：按「路径后缀」在工作区里找请求文件。
 * @param root 工作区根
 * @param requested 相对请求路径，如 `webpush-protocol.html`
 * @returns 匹配的相对路径列表（≤ MAX_SUFFIX_CANDIDATES，按名称排序）
 * 内部逻辑：BFS 遍历（跳过 SKIPPED_DIRECTORIES 与符号链接），比较用整段路径
 * （needle 带前导 `/`），因此 `a.md` 不会匹配 `ba.md`；扫描文件数与候选数都有上限。
 */
async function findBySuffix(root: string, requested: string): Promise<string[]> {
  if (requested === '') return []
  const needle = `/${requested.toLocaleLowerCase()}`
  const matches: string[] = []
  const pending: string[] = ['']
  let examined = 0
  while (pending.length > 0 && examined < MAX_SUFFIX_SCAN && matches.length < MAX_SUFFIX_CANDIDATES) {
    const directory = pending.shift()!
    const absolute = directory === '' ? root : join(root, directory)
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      examined += 1
      if (examined > MAX_SUFFIX_SCAN) break
      if (entry.isSymbolicLink()) continue
      const relativePath = directory === '' ? entry.name : `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        if (`/${relativePath.toLocaleLowerCase()}`.endsWith(needle)) matches.push(relativePath)
        pending.push(relativePath)
        continue
      }
      if (entry.isFile() && `/${relativePath.toLocaleLowerCase()}`.endsWith(needle)) matches.push(relativePath)
    }
  }
  return matches.sort((left, right) => left.localeCompare(right))
}

/** 判断 MIME 是否按文本展示。 */
function isTextType(type: string): boolean {
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || type === 'application/sql'
}

/** 提供有上限、规范化的工作区读取，并把用户上传文件存进其会话的工作区。 */
export class WorkspaceFiles {
  constructor(private readonly workspaces: () => readonly WorkspaceSummary[]) {}

  /** 按 ID 查工作区；不存在抛 NOT_FOUND。 */
  workspace(id: string): WorkspaceSummary {
    const item = this.workspaces().find(candidate => candidate.id === id)
    if (!item) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return item
  }

  /**
   * 功能：把一个本地目录登记为新工作区（构造 WorkspaceSummary，不落盘）。
   * @param path 目录路径；不存在或不是目录即抛错
   * @param name 可选显示名，缺省取目录 basename
   * @returns 新工作区摘要（随机 UUID 作为 id）；重复路径抛 CONFLICT
   */
  async addWorkspace(path: string, name?: string, now = Date.now()): Promise<WorkspaceSummary> {
    const canonical = await realpath(resolve(path)).catch(() => {
      throw new RuntimeError('NOT_FOUND', '工作区目录不存在或无法读取')
    })
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', '工作区路径必须是已有目录')
    if (this.workspaces().some(item => item.path === canonical)) throw new RuntimeError('CONFLICT', '这个目录已经添加为工作区')
    const normalizedName = name?.trim() || basename(canonical)
    if (!normalizedName || normalizedName.length > 120) throw new RuntimeError('INVALID_INPUT', '工作区名称长度必须在 1 到 120 个字符之间')
    return { id: randomUUID(), name: normalizedName, path: canonical, createdAt: now, updatedAt: now }
  }

  /**
   * 功能：列出一层目录；带 query 时改为全工作区模糊搜索（路径包含该词即命中）。
   * @param id 工作区 ID
   * @param path 相对目录路径（空为根）
   * @param query 搜索词（≤ 200 字符，不区分大小写）
   * @returns 条目列表；无 query 按目录优先排序，有 query 按路径排序，扫描 ≤ 5000 文件、结果 ≤ 500 条
   */
  async list(id: string, path = '', query?: string): Promise<WorkspaceFileEntry[]> {
    const workspace = this.workspace(id)
    const root = await realpath(workspace.path)
    const baseRelative = resolveWorkspacePath(root, path, workspace.path)
    const base = await existing(() => checkedPath(root, baseRelative), baseRelative)
    const baseInfo = await stat(base)
    if (!baseInfo.isDirectory()) throw new RuntimeError('INVALID_INPUT', '工作区路径不是目录')
    const needle = query?.trim().toLocaleLowerCase()
    if (!needle) return this.listDirectory(base, baseRelative)
    if (needle.length > 200) throw new RuntimeError('INVALID_INPUT', '搜索词过长')
    const results: WorkspaceFileEntry[] = []
    const pending = [base]
    let examined = 0
    while (pending.length && examined < MAX_SEARCH_FILES && results.length < 500) {
      const directory = pending.shift()
      if (!directory) continue
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        examined += 1
        if (examined > MAX_SEARCH_FILES || entry.isSymbolicLink()) continue
        const target = join(directory, entry.name)
        const relativePath = relative(root, target).split(sep).join('/')
        const item = await lstat(target)
        if (item.isDirectory()) {
          pending.push(target)
          if (relativePath.toLocaleLowerCase().includes(needle)) {
            results.push({ name: entry.name, path: relativePath, type: 'directory', modifiedAt: item.mtimeMs })
          }
        } else if (item.isFile() && relativePath.toLocaleLowerCase().includes(needle)) {
          results.push({ name: entry.name, path: relativePath, type: 'file', size: item.size, modifiedAt: item.mtimeMs, mimeType: mimeType(target) })
        }
      }
    }
    return results.sort((left, right) => left.path.localeCompare(right.path))
  }

  /**
   * 功能：读取一个工作区文件/目录用于预览。
   * @returns 按类型返回 image（内联 base64）/ text（UTF-8，≤ 2 MiB 且无 NUL）/ binary（base64）/ directory（列目录）
   * 内部逻辑：路径先经 resolveEntry 兜底后缀匹配；预览上限 8 MiB；目录请求返回
   * 其内容列表让检查器直接展示。
   */
  async read(id: string, path: string): Promise<WorkspaceFile> {
    const workspace = this.workspace(id)
    const root = await realpath(workspace.path)
    const requested = resolveWorkspacePath(root, path, workspace.path)
    const resolved = await this.resolveEntry(root, requested)
    const info = await stat(resolved.canonical)
    // 回答里的路径有时指向一个目录；给出目录内容，让检查器直接列出它。
    if (info.isDirectory()) {
      return {
        path: resolved.path, kind: 'directory', mimeType: 'inode/directory', size: 0, modifiedAt: info.mtimeMs,
        entries: await this.listDirectory(resolved.canonical, resolved.path),
      }
    }
    if (!info.isFile()) throw new RuntimeError('INVALID_INPUT', '只能预览普通文件')
    if (info.size > MAX_FILE_PREVIEW_BYTES) throw new RuntimeError('INVALID_INPUT', '文件超过 8 MiB，无法在浏览器预览')
    const buffer = await readFile(resolved.canonical)
    const type = effectiveMimeType(resolved.canonical, buffer)
    const common = { path: resolved.path, mimeType: type, size: info.size, modifiedAt: info.mtimeMs }
    if (INLINE_IMAGE_TYPES.has(type)) return { ...common, kind: 'image', data: buffer.toString('base64') }
    if (isTextType(type) && info.size <= MAX_FILE_TEXT_BYTES && !buffer.includes(0)) {
      return { ...common, kind: 'text', content: buffer.toString('utf8') }
    }
    return { ...common, kind: 'binary', data: buffer.toString('base64') }
  }

  /**
   * 把一个请求路径落到工作区里真实存在的文件或目录上。
   *
   * 模型在回答里常常只写文件名（`webpush-protocol.html`），而文件其实躺在
   * `docs/` 下面；按工作区根目录去找必然落空。所以先按原路径找，找不到就按
   * **路径后缀**在工作区里找同名文件：唯一命中就打开它，多个命中说明路径写得
   * 不够具体，把候选列出来而不是替用户猜一个。
   */
  private async resolveEntry(root: string, requested: string): Promise<{ path: string; canonical: string }> {
    try {
      return { path: requested, canonical: await checkedPath(root, requested) }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const candidates = await findBySuffix(root, requested)
    if (candidates.length === 0) throw new RuntimeError('NOT_FOUND', `文件不存在或已被删除：${requested}`)
    if (candidates.length > 1) {
      const shown = candidates.slice(0, 5).join('、')
      throw new RuntimeError('NOT_FOUND', `工作区里有多个同名文件（例如 ${shown}），请在回答里写完整路径`)
    }
    const path = candidates[0]!
    return { path, canonical: await checkedPath(root, path) }
  }

  /**
   * 功能：把工作区文件作为资源读取（图像内联等）。
   * @returns MIME 与原始字节；只读普通文件且 ≤ 8 MiB，路径同样经后缀兜底
   */
  async asset(id: string, path: string): Promise<{ mimeType: string; data: Uint8Array }> {
    const workspace = this.workspace(id)
    const root = await realpath(workspace.path)
    const requested = resolveWorkspacePath(root, path, workspace.path)
    const resolved = await this.resolveEntry(root, requested)
    const info = await stat(resolved.canonical)
    if (!info.isFile()) throw new RuntimeError('INVALID_INPUT', '只能读取工作区中的普通文件')
    if (info.size > MAX_FILE_PREVIEW_BYTES) throw new RuntimeError('INVALID_INPUT', '文件超过 8 MiB，无法内联读取')
    const data = await readFile(resolved.canonical)
    return { mimeType: effectiveMimeType(resolved.canonical, data), data }
  }

  /**
   * 功能：把一条消息的附件（Base64）保存到工作区的 `.attachments/<会话ID>/` 下。
   * @param requestId 请求 ID：哈希后作为文件名前缀，实现幂等——同请求同内容重复提交不报错
   * @returns 保存后的引用列表
   * 内部逻辑：最多 8 个、总量 ≤ 16 MiB、单文件 ≤ 8 MiB；校验 MIME 形状与 Base64
   * 规范性（重编码必须一致）；文件名 `请求哈希前16位-序号-清洗后的原名`；用
   * O_CREAT|O_EXCL|O_NOFOLLOW 独占写入，EEXIST 时比对已有内容一致才视为重复。
   */
  async saveAttachments(id: string, conversationId: string, requestId: string, files: readonly AttachmentInput[]): Promise<AttachmentReference[]> {
    if (files.length > 8) throw new RuntimeError('INVALID_INPUT', '单条消息最多附加 8 个文件')
    const workspace = this.workspace(id)
    const root = await realpath(workspace.path)
    const requestKey = createHash('sha256').update(requestId).digest('hex')
    const directoryRelative = `.attachments/${conversationId}`
    const directoryPath = resolve(root, directoryRelative)
    if (!isWithin(root, directoryPath)) throw new RuntimeError('FORBIDDEN', '附件目录无效')
    await mkdir(directoryPath, { recursive: true, mode: 0o700 })
    const directory = await checkedPath(root, directoryRelative)
    const directoryInfo = await stat(directory)
    if (!directoryInfo.isDirectory()) throw new RuntimeError('CONFLICT', '附件目录无效')
    let totalBytes = 0
    const saved: AttachmentReference[] = []
    for (const [index, file] of files.entries()) {
      const name = safeFileName(file.name)
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) || file.mimeType.length > 128) {
        throw new RuntimeError('INVALID_INPUT', '附件类型无效')
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
        throw new RuntimeError('INVALID_INPUT', '附件内容必须是 Base64')
      }
      const bytes = Buffer.from(file.data, 'base64')
      if (bytes.toString('base64') !== file.data) throw new RuntimeError('INVALID_INPUT', '附件 Base64 内容无效')
      totalBytes += bytes.length
      if (bytes.length > MAX_FILE_PREVIEW_BYTES || totalBytes > 16 * 1024 * 1024) {
        throw new RuntimeError('INVALID_INPUT', '附件总大小不能超过 16 MiB')
      }
      const storedName = `${requestKey.slice(0, 16)}-${index}-${name}`
      const relativePath = `${directoryRelative}/${storedName}`
      const canonicalTarget = await checkedPath(root, relativePath, true)
      try {
        const fileHandle = await open(canonicalTarget, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await fileHandle.writeFile(bytes) } finally { await fileHandle.close() }
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
        const existing = await readFile(canonicalTarget)
        if (!existing.equals(bytes)) throw new RuntimeError('CONFLICT', '同一请求编号对应了不同附件内容')
      }
      saved.push({ name, mimeType: file.mimeType, size: bytes.length, path: relativePath })
    }
    return saved
  }

  /** 列一层目录的普通条目：跳过符号链接，目录排前、其余按名称排序。 */
  private async listDirectory(directory: string, relativeDirectory: string): Promise<WorkspaceFileEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const result: WorkspaceFileEntry[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const target = join(directory, entry.name)
      const item = await lstat(target)
      const relativePath = [relativeDirectory, entry.name].filter(Boolean).join('/')
      if (item.isDirectory()) result.push({ name: entry.name, path: relativePath, type: 'directory', modifiedAt: item.mtimeMs })
      else if (item.isFile()) result.push({ name: entry.name, path: relativePath, type: 'file', size: item.size, modifiedAt: item.mtimeMs, mimeType: mimeType(target) })
    }
    return result.sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory') || left.name.localeCompare(right.name))
  }
}
