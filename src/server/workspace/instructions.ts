import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/** 工作区根的项目指令文件名。 */
export const PROJECT_INSTRUCTIONS_FILE = 'AGENTS.md'
/** 项目指令文件的大小上限（32 KB）。 */
export const MAX_PROJECT_INSTRUCTIONS_BYTES = 32 * 1024

/** 加载失败的归因码（进入诊断与提示词的安全措辞）。 */
export type ProjectInstructionsReason =
  | 'workspace-not-provided'
  | 'workspace-not-absolute'
  | 'workspace-unavailable'
  | 'workspace-symlink'
  | 'workspace-not-directory'
  | 'workspace-path-not-canonical'
  | 'source-outside-workspace'
  | 'source-symlink'
  | 'source-not-regular-file'
  | 'source-too-large'
  | 'source-changed-during-read'
  | 'source-invalid-utf8'
  | 'source-read-failed'

/** 项目指令加载结果：状态、来源、指纹与内容（或归因码）。 */
export interface ProjectInstructionsRecord {
  status: 'loaded' | 'missing' | 'error' | 'unavailable'
  workspaceRoot: string | null
  source: string | null
  scope: 'workspace-root' | 'unknown'
  sha256: string | null
  bytes: number | null
  content?: string
  reason?: ProjectInstructionsReason
}

/** 判断 target 是否位于 root 内（含等于 root），防路径逃逸。 */
function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** 取 Node 错误对象的 code 字符串。 */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/** 构造「工作区本身不可用」的记录（未进入读取阶段）。 */
function unavailable(reason: ProjectInstructionsReason): ProjectInstructionsRecord {
  return {
    status: 'unavailable',
    workspaceRoot: null,
    source: null,
    scope: 'unknown',
    sha256: null,
    bytes: null,
    reason,
  }
}

/** 构造「已定位到文件但读取失败」的记录。 */
function failed(workspaceRoot: string, source: string, reason: ProjectInstructionsReason): ProjectInstructionsRecord {
  return {
    status: 'error',
    workspaceRoot,
    source,
    scope: 'workspace-root',
    sha256: null,
    bytes: null,
    reason,
  }
}

/** 两个 stat 结果是否指向同一文件（dev + inode 比较）。 */
function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** 逐段检查路径上是否存在符号链接组件（从根走到底）。 */
async function containsSymlinkComponent(path: string): Promise<boolean> {
  const pathRoot = parse(path).root
  let current = pathRoot
  for (const part of relative(pathRoot, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) return true
  }
  return false
}

/**
 * 功能：只读取所选工作区根的 AGENTS.md，不做任何父目录或后代目录发现。
 * @param workspacePath 工作区路径（必须绝对、非符号链接、canonical）
 * @returns ProjectInstructionsRecord：loaded / missing / error / unavailable 四态
 * 内部逻辑：工作区先经 lstat + 逐段符号链接检查 + realpath 校验（路径非 canonical
 * 时按 unavailable 处理）；文件必须是非链接常规文件且 ≤ 32 KB；读取用 O_NOFOLLOW
 * （Windows 缺失时以打开前后两次 lstat + dev/ino/mtime/ctime 比对近似替代），读完
 * 再核对文件未被换走；最后严格 UTF-8 解码并拒绝 NUL。
 */
export async function loadProjectInstructions(workspacePath: string | undefined): Promise<ProjectInstructionsRecord> {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    return unavailable('workspace-not-provided')
  }
  if (!isAbsolute(workspacePath)) return unavailable('workspace-not-absolute')

  const requestedRoot = resolve(workspacePath)
  let rootInfo
  try {
    rootInfo = await lstat(requestedRoot)
  } catch {
    return unavailable('workspace-unavailable')
  }
  if (rootInfo.isSymbolicLink()) return unavailable('workspace-symlink')
  if (!rootInfo.isDirectory()) return unavailable('workspace-not-directory')
  try {
    if (await containsSymlinkComponent(requestedRoot)) return unavailable('workspace-symlink')
  } catch {
    return unavailable('workspace-unavailable')
  }

  let root: string
  try {
    root = await realpath(requestedRoot)
  } catch {
    return unavailable('workspace-unavailable')
  }
  if (root !== requestedRoot) {
    try {
      if (!sameFile(rootInfo, await lstat(root))) return unavailable('workspace-path-not-canonical')
    } catch {
      return unavailable('workspace-unavailable')
    }
  }

  const source = join(root, PROJECT_INSTRUCTIONS_FILE)
  if (!isWithin(root, source)) return failed(root, source, 'source-outside-workspace')

  let sourceInfo
  try {
    sourceInfo = await lstat(source)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return {
        status: 'missing',
        workspaceRoot: root,
        source,
        scope: 'workspace-root',
        sha256: null,
        bytes: null,
      }
    }
    return failed(root, source, 'source-read-failed')
  }
  if (sourceInfo.isSymbolicLink()) return failed(root, source, 'source-symlink')
  if (!sourceInfo.isFile()) return failed(root, source, 'source-not-regular-file')
  if (sourceInfo.size > MAX_PROJECT_INSTRUCTIONS_BYTES) return failed(root, source, 'source-too-large')

  const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlockFlag = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0

  let handle
  try {
    handle = await open(source, constants.O_RDONLY | noFollowFlag | nonBlockFlag)
  } catch (error) {
    return failed(root, source, codeOf(error) === 'ELOOP' ? 'source-symlink' : 'source-read-failed')
  }

  try {
    const before = await handle.stat()
    if (!before.isFile()) return failed(root, source, 'source-not-regular-file')
    if (!sameFile(sourceInfo, before)) return failed(root, source, 'source-changed-during-read')
    if (before.size > MAX_PROJECT_INSTRUCTIONS_BYTES) return failed(root, source, 'source-too-large')

    // Windows 可能没有 O_NOFOLLOW。此时在真正读字节前先验证打开的句柄与已检查的
    // 常规路径一致，读完后再核对一次。这能发现读取前后的路径替换，但没有内核
    // 支持就无法让路径查找完全原子。
    let pathBeforeRead
    try {
      pathBeforeRead = await lstat(source)
    } catch {
      return failed(root, source, 'source-changed-during-read')
    }
    if (pathBeforeRead.isSymbolicLink()) return failed(root, source, 'source-symlink')
    if (!pathBeforeRead.isFile() || !sameFile(before, pathBeforeRead)) {
      return failed(root, source, 'source-changed-during-read')
    }

    const buffer = Buffer.alloc(MAX_PROJECT_INSTRUCTIONS_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > MAX_PROJECT_INSTRUCTIONS_BYTES) return failed(root, source, 'source-too-large')

    const after = await handle.stat()
    let currentPathInfo
    try {
      currentPathInfo = await lstat(source)
    } catch {
      return failed(root, source, 'source-changed-during-read')
    }
    if (
      !currentPathInfo.isFile() ||
      !sameFile(before, after) ||
      !sameFile(after, currentPathInfo) ||
      before.size !== after.size ||
      after.size !== bytesRead ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return failed(root, source, 'source-changed-during-read')
    }

    const bytes = buffer.subarray(0, bytesRead)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return failed(root, source, 'source-invalid-utf8')
    }
    if (content.includes('\0')) return failed(root, source, 'source-invalid-utf8')

    return {
      status: 'loaded',
      workspaceRoot: root,
      source,
      scope: 'workspace-root',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytesRead,
      content,
    }
  } catch {
    return failed(root, source, 'source-read-failed')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

const BODY_TAG = 'project_instructions'

/**
 * 功能：把记录渲染为一行状态说明加分隔标签包住的 Markdown 正文。
 * @returns loaded：适用范围声明 + 标签包裹的正文（正文里出现字面 `</project_instructions`
 * 会被转义，防止引用内容提前结束块）；missing：未找到提示；其余：无法加载说明，
 * 明确「规则未知、不要声称已遵循」。sha256 与字节数等溯源细节只留在记录里，不进提示词。
 */
export function renderProjectInstructions(record: ProjectInstructionsRecord): string {
  const source = record.source ?? PROJECT_INSTRUCTIONS_FILE
  if (record.status === 'loaded' && typeof record.content === 'string') {
    const body = record.content.split(`</${BODY_TAG}`).join(`<\\/${BODY_TAG}`)
    return [
      `工作区 ${source} 适用于工作区根目录及其后代：`,
      `<${BODY_TAG}>`,
      body,
      `</${BODY_TAG}>`,
    ].join('\n')
  }
  if (record.status === 'missing') return `未找到 ${source}；没有适用的工作区项目指令。`
  return `无法加载 ${source} 的 AGENTS.md（${record.reason ?? record.status}）；其规则未知，不要声称已遵循。`
}
