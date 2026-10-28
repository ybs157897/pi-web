import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export const PROJECT_INSTRUCTIONS_FILE = 'AGENTS.md'
export const MAX_PROJECT_INSTRUCTIONS_BYTES = 32 * 1024

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

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

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

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function containsSymlinkComponent(path: string): Promise<boolean> {
  const pathRoot = parse(path).root
  let current = pathRoot
  for (const part of relative(pathRoot, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) return true
  }
  return false
}

/** Read only the selected workspace's root AGENTS.md. No parent or descendant discovery is performed. */
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

    // Windows may not provide O_NOFOLLOW. In that case, verify the opened handle
    // matches the checked regular path before reading any bytes, then check it again after.
    // This detects path swaps around the read but cannot make path lookup atomic without kernel support.
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
 * Render the record as one status line plus the Markdown body inside a delimiter tag. A literal
 * closing tag inside the body is escaped so quoted content cannot end the block early. Provenance
 * internals (sha256, byte count) stay in the record and out of the prompt.
 */
export function renderProjectInstructions(record: ProjectInstructionsRecord): string {
  const source = record.source ?? PROJECT_INSTRUCTIONS_FILE
  if (record.status === 'loaded' && typeof record.content === 'string') {
    const body = record.content.split(`</${BODY_TAG}`).join(`<\\/${BODY_TAG}`)
    return [
      `Workspace ${source} applies to the workspace root and its descendants:`,
      `<${BODY_TAG}>`,
      body,
      `</${BODY_TAG}>`,
    ].join('\n')
  }
  if (record.status === 'missing') return `No AGENTS.md at ${source}; no workspace project instructions apply.`
  return `AGENTS.md at ${source} could not be loaded (${record.reason ?? record.status}); its rules are unknown — do not claim to follow them.`
}
