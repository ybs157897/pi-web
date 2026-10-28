import { execFile, type ExecFileException } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  GitCommitInput,
  GitCommitResult,
  GitHeadRefType,
  GitPushResult,
  GitWorktreeDiff,
  GitWorktreeFile,
  GitWorktreeFileStatus,
  GitWorktreeStatus,
  WorkspaceSummary,
} from '../shared/types.ts'
import { RuntimeError } from './runtime-errors.ts'

const GIT_TIMEOUT_MS = 15_000
const GIT_PUSH_TIMEOUT_MS = 60_000
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_DIFF_BYTES = 512 * 1024
const MAX_COMMIT_MESSAGE = 10_000
const MAX_COMMIT_CONTEXT_BYTES = 24 * 1024

interface GitCommandResult { stdout: string; stderr: string; code: number; unavailable: boolean }

const UNAVAILABLE: GitCommandResult = { stdout: '', stderr: '', code: -1, unavailable: true }

function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  return new Promise(resolveGit => {
    execFile('git', args, { cwd, timeout, maxBuffer: GIT_MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error: ExecFileException | null, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          resolveGit(UNAVAILABLE)
          return
        }
        const code = typeof error?.code === 'number' ? error.code : error === null ? 0 : 1
        resolveGit({ stdout: stdout ?? '', stderr: stderr ?? '', code, unavailable: false })
      })
  })
}

function emptyStatus(isGitAvailable: boolean): GitWorktreeStatus {
  return {
    isGitAvailable,
    isRepository: false,
    repoRoot: null,
    branchName: null,
    headRefType: 'detached',
    ahead: 0,
    behind: 0,
    dirtyFileCount: 0,
    added: 0,
    removed: 0,
    files: [],
  }
}

interface BranchHeader {
  branchName: string | null
  headRefType: GitHeadRefType
  ahead: number
  behind: number
}

/** Parses the `##` header `git status --porcelain=v1 --branch -z` emits first. */
function parseBranchHeader(line: string): BranchHeader {
  const text = line.slice(3)
  if (text.startsWith('HEAD (no branch)')) {
    return { branchName: null, headRefType: 'detached', ahead: 0, behind: 0 }
  }
  const noCommits = /^No commits yet on (.+)$/u.exec(text)
  const name = noCommits?.[1] ?? text.split('...')[0] ?? ''
  const ahead = Number(/ahead (\d+)/u.exec(text)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/u.exec(text)?.[1] ?? 0)
  return {
    branchName: name.trim() || null,
    headRefType: 'branch',
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  }
}

function statusKind(code: string): GitWorktreeFileStatus | undefined {
  if (code === '??') return 'untracked'
  if (code === '!!') return undefined
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  return 'modified'
}

/** One `git status --porcelain=v1 -z` stream: the branch header plus every changed path. */
function parseStatus(stdout: string): { branch: BranchHeader; files: Array<{ path: string; status: GitWorktreeFileStatus }> } {
  const tokens = stdout.split('\0')
  let branch: BranchHeader = { branchName: null, headRefType: 'detached', ahead: 0, behind: 0 }
  const files: Array<{ path: string; status: GitWorktreeFileStatus }> = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '') continue
    if (token.startsWith('## ')) {
      branch = parseBranchHeader(token)
      continue
    }
    if (token.length < 4) continue
    const code = token.slice(0, 2)
    // With -z a rename/copy writes `XY new-path\0old-path\0`; skip the old-path token.
    if (code.includes('R') || code.includes('C')) index += 1
    const kind = statusKind(code)
    if (kind === undefined) continue
    files.push({ path: token.slice(3), status: kind })
  }
  return { branch, files }
}

/** `git diff --numstat -z`: `added\tremoved\tpath`, or `added\tremoved\t\0old\0new` for a rename. */
function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>()
  const tokens = stdout.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '') continue
    const first = token.indexOf('\t')
    const second = token.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = Number.parseInt(token.slice(0, first), 10)
    const removed = Number.parseInt(token.slice(first + 1, second), 10)
    let path = token.slice(second + 1)
    if (path === '') {
      const newPath = tokens[index + 2] ?? ''
      index += 2
      path = newPath
    }
    if (path === '') continue
    const previous = counts.get(path) ?? { added: 0, removed: 0 }
    counts.set(path, {
      added: previous.added + (Number.isFinite(added) ? added : 0),
      removed: previous.removed + (Number.isFinite(removed) ? removed : 0),
    })
  }
  return counts
}

function errorText(result: GitCommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || 'Git 命令执行失败').slice(0, 2_000)
}

function normalizeRelativePath(root: string, rawPath: string): string {
  const target = resolve(root, rawPath)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new RuntimeError('INVALID_INPUT', '文件路径不在工作区内')
  }
  return rel.split('\\').join('/')
}

/**
 * Worktree-level Git support for the status card: status + line counts, one file diff,
 * commit and push. All calls use `execFile` with the repository root as cwd; no shell.
 */
export class GitWorktree {
  constructor(private readonly workspaces: () => readonly WorkspaceSummary[]) {}

  private workspacePath(id: string): string {
    const workspace = this.workspaces().find(item => item.id === id)
    if (!workspace) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return workspace.path
  }

  async status(id: string): Promise<GitWorktreeStatus> {
    return await this.readStatus(this.workspacePath(id))
  }

  async diff(id: string, rawPath: string): Promise<GitWorktreeDiff> {
    const status = await this.readStatus(this.workspacePath(id))
    if (!status.isRepository || status.repoRoot === null) {
      throw new RuntimeError('INVALID_INPUT', '工作区不在 Git 仓库中')
    }
    const path = normalizeRelativePath(status.repoRoot, rawPath)
    const patch = await runGit(status.repoRoot, ['diff', 'HEAD', '--no-color', '--unified=3', '--', path])
    if (patch.unavailable) throw new RuntimeError('INVALID_INPUT', '未找到 Git')
    if (patch.stdout !== '') return { path, diff: patch.stdout.slice(0, MAX_DIFF_BYTES) }
    // Untracked files have no HEAD entry, so the inspector gets their current text instead.
    const target = resolve(status.repoRoot, path)
    const info = await lstat(target).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size > MAX_DIFF_BYTES) return { path }
    // A symlink can point outside the workspace; only read the real path when it stays inside.
    const real = await realpath(target).catch(() => undefined)
    if (real === undefined) return { path }
    const insideRoot = relative(status.repoRoot, real)
    if (insideRoot.startsWith('..') || isAbsolute(insideRoot)) return { path }
    const text = await readFile(real, 'utf8').catch(() => undefined)
    return text === undefined ? { path } : { path, newText: text }
  }

  /** The diff a commit would contain, capped for the model-based message generator. */
  async commitContext(id: string, includeUnstaged: boolean): Promise<{ status: GitWorktreeStatus; diff: string }> {
    const status = await this.readStatus(this.workspacePath(id))
    if (!status.isRepository || status.repoRoot === null) return { status, diff: '' }
    const diff = await runGit(status.repoRoot, includeUnstaged
      ? ['diff', 'HEAD', '--no-color', '--unified=3']
      : ['diff', '--cached', '--no-color', '--unified=3'])
    return { status, diff: diff.code === 0 ? diff.stdout.slice(0, MAX_COMMIT_CONTEXT_BYTES) : '' }
  }

  async commit(id: string, input: GitCommitInput): Promise<GitCommitResult> {
    const status = await this.readStatus(this.workspacePath(id))
    if (!status.isRepository || status.repoRoot === null) {
      return { ok: false, commitHash: null, status, error: '工作区不在 Git 仓库中' }
    }
    const message = input.message.trim()
    if (message === '' || message.length > MAX_COMMIT_MESSAGE) {
      return { ok: false, commitHash: null, status, error: '请输入 1–10000 字符的提交信息' }
    }
    if (input.includeUnstaged) {
      const staged = await runGit(status.repoRoot, ['add', '-A'])
      if (staged.unavailable || staged.code !== 0) {
        return { ok: false, commitHash: null, status, error: errorText(staged) }
      }
    }
    const pending = await runGit(status.repoRoot, ['diff', '--cached', '--quiet'])
    if (pending.unavailable) return { ok: false, commitHash: null, status, error: '未找到 Git' }
    if (pending.code === 0) {
      return { ok: false, commitHash: null, status, error: '没有可提交的改动' }
    }
    const committed = await runGit(status.repoRoot, ['commit', '-m', message])
    if (committed.unavailable) return { ok: false, commitHash: null, status, error: '未找到 Git' }
    if (committed.code !== 0) {
      return { ok: false, commitHash: null, status, error: errorText(committed) }
    }
    const hash = await runGit(status.repoRoot, ['rev-parse', '--short', 'HEAD'])
    return {
      ok: true,
      commitHash: hash.code === 0 ? hash.stdout.trim() || null : null,
      status: await this.readStatus(this.workspacePath(id)),
    }
  }

  async push(id: string): Promise<GitPushResult> {
    const status = await this.readStatus(this.workspacePath(id))
    if (!status.isRepository || status.repoRoot === null) {
      return { ok: false, error: '工作区不在 Git 仓库中' }
    }
    const pushed = await runGit(status.repoRoot, ['push'], GIT_PUSH_TIMEOUT_MS)
    if (pushed.unavailable) return { ok: false, error: '未找到 Git' }
    if (pushed.code !== 0) return { ok: false, error: errorText(pushed) }
    return { ok: true }
  }

  private async readStatus(path: string): Promise<GitWorktreeStatus> {
    const inside = await runGit(path, ['rev-parse', '--is-inside-work-tree'])
    if (inside.unavailable) return emptyStatus(false)
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return emptyStatus(true)
    const root = await runGit(path, ['rev-parse', '--show-toplevel'])
    const repoRoot = root.stdout.trim()
    if (root.code !== 0 || repoRoot === '') return emptyStatus(true)

    const porcelain = await runGit(repoRoot, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z'])
    if (porcelain.code !== 0) return { ...emptyStatus(true), isRepository: true, repoRoot }

    const parsed = parseStatus(porcelain.stdout)
    const numstat = await runGit(repoRoot, ['diff', 'HEAD', '--numstat', '-z'])
    const counts = parseNumstat(numstat.stdout)
    const files: GitWorktreeFile[] = parsed.files.map(file => {
      const count = counts.get(file.path)
      return { path: file.path, status: file.status, added: count?.added ?? 0, removed: count?.removed ?? 0 }
    })
    const added = files.reduce((sum, file) => sum + file.added, 0)
    const removed = files.reduce((sum, file) => sum + file.removed, 0)
    return {
      isGitAvailable: true,
      isRepository: true,
      repoRoot,
      branchName: parsed.branch.branchName,
      headRefType: parsed.branch.headRefType,
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
      dirtyFileCount: files.length,
      added,
      removed,
      files,
    }
  }
}
