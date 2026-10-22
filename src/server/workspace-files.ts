import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkspaceFile, WorkspaceFileEntry, WorkspaceSummary } from '../shared/types.ts'
import { RuntimeError } from './runtime-errors.ts'

export interface AttachmentInput { name: string; mimeType: string; data: string }
export type AttachmentReference = { name: string; mimeType: string; size: number; path: string }

const MAX_FILE_PREVIEW_BYTES = 8 * 1024 * 1024
const MAX_FILE_TEXT_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_FILES = 5_000
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

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

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

function safeFileName(value: string): string {
  const name = basename(value.split('/').join('_').split(String.fromCharCode(92)).join('_'))
    .split('')
    .filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
  if (!name || name === '.' || name === '..' || name.length > 200) throw new RuntimeError('INVALID_INPUT', '文件名无效')
  return name
}

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
 * Turns a requested path into a safe workspace relative path. Tools report the paths
 * of the machine they ran on, so they arrive as absolute paths or with backslash
 * separators; both are mapped back onto the workspace when they point inside it.
 * A path that leaves the workspace keeps the rejection it had before.
 */
export function resolveWorkspacePath(root: string, requested: string, declared?: string): string {
  const normalized = requested.replace(/\\/g, '/')
  if (normalized.length > 2048 || normalized.includes('\u0000')) throw new RuntimeError('INVALID_INPUT', '工作区路径无效')
  const absolute = platformAbsolutePath(normalized)
  if (absolute === undefined) return safeRelativePath(normalized)
  // The workspace may be addressed by the path it was added with or by its resolved
  // form, and tools report the former, so both are accepted as the workspace root.
  for (const base of declared === undefined ? [root] : [root, declared]) {
    if (!isWithin(base, absolute)) continue
    return safeRelativePath(relative(base, absolute).split(sep).join('/'))
  }
  throw new RuntimeError('INVALID_INPUT', '工作区路径无效')
}

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

function mimeType(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function isTextType(type: string): boolean {
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || type === 'application/sql'
}

/** Serves bounded, canonical workspace reads and stores incoming user files under their conversation's workspace. */
export class WorkspaceFiles {
  constructor(private readonly workspaces: () => readonly WorkspaceSummary[]) {}

  workspace(id: string): WorkspaceSummary {
    const item = this.workspaces().find(candidate => candidate.id === id)
    if (!item) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return item
  }

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

  async read(id: string, path: string): Promise<WorkspaceFile> {
    const workspace = this.workspace(id)
    const root = await realpath(workspace.path)
    const relativePath = resolveWorkspacePath(root, path, workspace.path)
    const canonical = await existing(() => checkedPath(root, relativePath), relativePath)
    const info = await existing(() => stat(canonical), relativePath)
    if (!info.isFile()) throw new RuntimeError('INVALID_INPUT', '只能预览普通文件')
    if (info.size > MAX_FILE_PREVIEW_BYTES) throw new RuntimeError('INVALID_INPUT', '文件超过 8 MiB，无法在浏览器预览')
    const type = mimeType(canonical)
    const buffer = await readFile(canonical)
    const common = { path: relativePath, mimeType: type, size: info.size, modifiedAt: info.mtimeMs }
    if (INLINE_IMAGE_TYPES.has(type)) return { ...common, kind: 'image', data: buffer.toString('base64') }
    if (isTextType(type) && info.size <= MAX_FILE_TEXT_BYTES && !buffer.includes(0)) {
      return { ...common, kind: 'text', content: buffer.toString('utf8') }
    }
    return { ...common, kind: 'binary', data: buffer.toString('base64') }
  }

  async asset(id: string, path: string): Promise<{ mimeType: string; data: Uint8Array }> {
    const workspace = this.workspace(id)
    const root = await realpath(workspace.path)
    const relativePath = resolveWorkspacePath(root, path, workspace.path)
    const canonical = await existing(() => checkedPath(root, relativePath), relativePath)
    const info = await existing(() => stat(canonical), relativePath)
    if (!info.isFile()) throw new RuntimeError('INVALID_INPUT', '只能读取工作区中的普通文件')
    if (info.size > MAX_FILE_PREVIEW_BYTES) throw new RuntimeError('INVALID_INPUT', '文件超过 8 MiB，无法内联读取')
    return { mimeType: mimeType(canonical), data: await readFile(canonical) }
  }

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
