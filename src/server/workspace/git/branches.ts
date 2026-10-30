import { execFile, type ExecFileException } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type {
  CreateGitBranchInput,
  GitBranchIssue,
  GitBranchMutation,
  GitBranchSnapshot,
  GitHeadRefType,
  GitLocalBranch,
  SwitchGitBranchInput,
  WorkspaceSummary,
} from '../../../shared/types.ts'
import { RuntimeError } from '../../runtime-errors.ts'

const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const OPERATION_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'] as const
const NO_REPOSITORY_ISSUE: GitBranchIssue = { code: 'not-a-repository', message: '工作区不在 Git 仓库中，无法切换分支' }

interface GitCommandResult { stdout: string; stderr: string; code: number; unavailable: boolean }

const UNAVAILABLE: GitCommandResult = { stdout: '', stderr: '', code: -1, unavailable: true }

function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (error: ExecFileException | null, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          resolve(UNAVAILABLE)
          return
        }
        const code = typeof error?.code === 'number' ? error.code : error === null ? 0 : 1
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code, unavailable: false })
      })
  })
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false)
}

function outputLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\s+$/g, ''))
}

/** ZCode reads the overwritten paths from the indented block Git prints under its own message. */
function indentedPaths(lines: readonly string[], header: RegExp): string[] {
  const start = lines.findIndex(line => header.test(line.toLowerCase()))
  if (start < 0) return []
  const paths: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line === '') continue
    if (!/^\s+/.test(line)) break
    const value = line.trim()
    if (value !== '') paths.push(value.split('\\').join('/'))
  }
  return paths
}

/** Maps `git switch` stderr onto ZCode's stable issue vocabulary (`gitCliHelpers.ts:64`). */
function parseIssues(result: GitCommandResult): GitBranchIssue[] {
  const detail = result.stderr.trim() || result.stdout.trim() || null
  const lines = outputLines(detail ?? '')
  const normalized = (detail ?? '').toLowerCase()
  const tracked = indentedPaths(lines, /your local changes to the following files would be overwritten by (checkout|switch)/)
  if (tracked.length > 0) {
    return [{ code: 'tracked-changes-would-be-overwritten', message: '本地已跟踪文件的修改会被切换覆盖', paths: tracked, detail }]
  }
  const untracked = indentedPaths(lines, /the following untracked working tree files would be overwritten by (checkout|switch)/)
  if (untracked.length > 0) {
    return [{ code: 'untracked-changes-would-be-overwritten', message: '未跟踪文件会被切换覆盖', paths: untracked, detail }]
  }
  if (normalized.includes('already exists')) return [{ code: 'branch-already-exists', message: '分支已存在', detail }]
  if (normalized.includes('invalid reference:')) return [{ code: 'target-branch-not-found', message: '目标分支不存在', detail }]
  if (normalized.includes('is already used by worktree at')) return [{ code: 'branch-in-other-worktree', message: '该分支已在其他 worktree 中检出', detail }]
  if (normalized.includes('resolve your current index first')) return [{ code: 'conflicts-present', message: '仓库仍有未解决的冲突', detail }]
  if (/cannot switch branch while (merging|rebasing|cherry-picking|reverting|bisecting)/.test(normalized) ||
    normalized.includes('you have not concluded your merge') || normalized.includes('rebase in progress')) {
    return [{ code: 'operation-in-progress', message: '有其他 Git 操作尚未结束', detail }]
  }
  return [{ code: 'unknown', message: detail ?? '分支操作失败', detail }]
}

function parseBranches(stdout: string, currentBranchName: string | null): GitLocalBranch[] {
  return outputLines(stdout)
    .filter(line => line !== '')
    .flatMap(line => {
      const [name, upstreamName, commitHash, commitTimestamp] = line.split('\0')
      if (!name) return []
      const seconds = commitTimestamp ? Number.parseInt(commitTimestamp, 10) : Number.NaN
      return [{
        name,
        isCurrent: name === currentBranchName,
        upstreamName: upstreamName || null,
        commitHash: commitHash || null,
        commitTimestampMs: Number.isNaN(seconds) ? null : seconds * 1000,
      }]
    })
    .sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1
      const leftTime = left.commitTimestampMs ?? Number.NEGATIVE_INFINITY
      const rightTime = right.commitTimestampMs ?? Number.NEGATIVE_INFINITY
      if (leftTime !== rightTime) return rightTime - leftTime
      return left.name.localeCompare(right.name)
    })
}

function emptySnapshot(isGitAvailable: boolean): GitBranchSnapshot {
  return { isGitAvailable, isRepository: false, repoRoot: null, headRefType: 'detached', currentBranchName: null, branches: [] }
}

function failure(action: GitBranchMutation['action'], branchName: string | null, snapshot: GitBranchSnapshot, issues: GitBranchIssue[]): GitBranchMutation {
  return { ok: false, action, branchName, didChange: false, created: false, snapshot, issues }
}

/**
 * Local branch listing, switching and creation for one workspace, following ZCode's branch service:
 * `git switch` stays the authority on whether a switch is blocked, and its stderr is normalized into
 * structured issues (`packages/services/src/git/repo/gitCliHelpers.ts:64`). No stash, force or remote
 * browsing — the same non-goals as ZCode's `docs/git/branch-switching-service-design.md`.
 */
export class GitBranches {
  constructor(private readonly workspaces: () => readonly WorkspaceSummary[]) {}

  private workspacePath(id: string): string {
    const workspace = this.workspaces().find(item => item.id === id)
    if (!workspace) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return workspace.path
  }

  async snapshot(id: string): Promise<GitBranchSnapshot> {
    return await this.readSnapshot(this.workspacePath(id))
  }

  async switch(id: string, input: SwitchGitBranchInput): Promise<GitBranchMutation> {
    return await this.mutate(id, 'switch', input.branchName, false)
  }

  async create(id: string, input: CreateGitBranchInput): Promise<GitBranchMutation> {
    return await this.mutate(id, 'create-and-switch', input.branchName, true)
  }

  private async readSnapshot(path: string): Promise<GitBranchSnapshot> {
    const root = await runGit(path, ['rev-parse', '--show-toplevel'])
    if (root.unavailable) return emptySnapshot(false)
    const repoRoot = root.stdout.trim()
    if (root.code !== 0 || repoRoot === '') return emptySnapshot(true)
    const head = await runGit(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
    const currentBranchName = head.code === 0 ? head.stdout.trim() || null : null
    const headRefType: GitHeadRefType = currentBranchName === null ? 'detached' : 'branch'
    const refs = await runGit(repoRoot, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)'])
    return {
      isGitAvailable: true,
      isRepository: true,
      repoRoot,
      headRefType,
      currentBranchName,
      branches: refs.code === 0 ? parseBranches(refs.stdout, currentBranchName) : [],
    }
  }

  private async mutate(id: string, action: GitBranchMutation['action'], rawName: string, create: boolean): Promise<GitBranchMutation> {
    const target = rawName.trim()
    const snapshot = await this.readSnapshot(this.workspacePath(id))
    if (!snapshot.isGitAvailable || !snapshot.isRepository || snapshot.repoRoot === null) {
      return failure(action, target || null, snapshot, [NO_REPOSITORY_ISSUE])
    }
    if (target === '') {
      return failure(action, null, snapshot, [{ code: 'invalid-branch-name', message: '分支名不能为空', detail: null }])
    }
    if (!create && snapshot.headRefType === 'branch' && snapshot.currentBranchName === target) {
      return { ok: true, action, branchName: target, didChange: false, created: false, snapshot, issues: [] }
    }
    const conflicts = await runGit(snapshot.repoRoot, ['diff', '--name-only', '--diff-filter=U'])
    const conflictedPaths = conflicts.code === 0 ? outputLines(conflicts.stdout).filter(line => line !== '') : []
    if (conflictedPaths.length > 0) {
      return failure(action, target, snapshot, [{ code: 'conflicts-present', message: '仓库仍有未解决的冲突', paths: conflictedPaths, detail: null }])
    }
    if (await this.hasOperationInProgress(snapshot.repoRoot)) {
      return failure(action, target, snapshot, [{ code: 'operation-in-progress', message: '有其他 Git 操作尚未结束', detail: null }])
    }
    const valid = await runGit(snapshot.repoRoot, ['check-ref-format', '--branch', target])
    if (valid.code !== 0) {
      return failure(action, target, snapshot, [{ code: 'invalid-branch-name', message: '分支名不合法', detail: valid.stderr.trim() || null }])
    }
    const result = await runGit(snapshot.repoRoot, create ? ['switch', '--no-guess', '-c', target] : ['switch', '--no-guess', target])
    if (result.unavailable) return failure(action, target, snapshot, [NO_REPOSITORY_ISSUE])
    if (result.code !== 0) return failure(action, target, snapshot, parseIssues(result))
    return {
      ok: true,
      action,
      branchName: target,
      didChange: true,
      created: create,
      snapshot: await this.readSnapshot(this.workspacePath(id)),
      issues: [],
    }
  }

  private async hasOperationInProgress(repoRoot: string): Promise<boolean> {
    const markers = await runGit(repoRoot, ['rev-parse', ...OPERATION_MARKERS.flatMap(marker => ['--git-path', marker])])
    if (markers.code !== 0) return false
    const candidates = outputLines(markers.stdout)
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(line => isAbsolute(line) ? line : resolve(repoRoot, line))
    const found = await Promise.all(candidates.map(path => pathExists(path)))
    return found.some(Boolean)
  }
}
