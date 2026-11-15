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
/** 标记「有其他 Git 操作进行中」的仓库内文件（merge/rebase/cherry-pick/revert/bisect）。 */
const OPERATION_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'] as const
const NO_REPOSITORY_ISSUE: GitBranchIssue = { code: 'not-a-repository', message: '工作区不在 Git 仓库中，无法切换分支' }

/** 一次 git 命令的结果；unavailable 表示 git 本体不存在。 */
interface GitCommandResult { stdout: string; stderr: string; code: number; unavailable: boolean }

const UNAVAILABLE: GitCommandResult = { stdout: '', stderr: '', code: -1, unavailable: true }

/**
 * 功能：运行一条 git 命令，永不 reject——错误一律收敛为结果对象。
 * 平台差异：windowsHide 隐藏控制台窗口；git 不存在（ENOENT）返回 UNAVAILABLE，
 * 由上层决定如何呈现。
 */
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

/** 路径是否存在（access 探测）。 */
async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false)
}

/** 把命令输出拆成行：统一 CRLF 为 LF 并去掉每行尾随空白（Windows git 输出兼容）。 */
function outputLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\s+$/g, ''))
}

/** 从 Git 在自身消息下方打印的缩进块里读出被覆盖的文件路径列表。 */
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

/** 把 `git switch` 的 stderr 映射为 ZCode 的稳定 issue 词表（参照 gitCliHelpers.ts:64）。 */
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

/** 解析 for-each-ref 的 NUL 分隔输出为分支列表：当前分支排最前，其余按提交时间倒序、名称兜底。 */
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

/** 构造「不是仓库 / git 不可用」的空快照。 */
function emptySnapshot(isGitAvailable: boolean): GitBranchSnapshot {
  return { isGitAvailable, isRepository: false, repoRoot: null, headRefType: 'detached', currentBranchName: null, branches: [] }
}

/** 构造一条失败的变更结果（didChange/created 均为 false）。 */
function failure(action: GitBranchMutation['action'], branchName: string | null, snapshot: GitBranchSnapshot, issues: GitBranchIssue[]): GitBranchMutation {
  return { ok: false, action, branchName, didChange: false, created: false, snapshot, issues }
}

/**
 * 单个工作区的本地分支列出、切换与创建，对齐 ZCode 的分支服务：
 * 切换是否被阻塞以 `git switch` 为准，其 stderr 被归一化为结构化 issue
 * （参照 packages/services/src/git/repo/gitCliHelpers.ts:64）。不做 stash、force
 * 与远端浏览——与 ZCode 的 branch-switching-service-design.md 非目标一致。
 */
export class GitBranches {
  constructor(private readonly workspaces: () => readonly WorkspaceSummary[]) {}

  /** 按 ID 取工作区路径；不存在抛 NOT_FOUND。 */
  private workspacePath(id: string): string {
    const workspace = this.workspaces().find(item => item.id === id)
    if (!workspace) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return workspace.path
  }

  /** 读取工作区当前分支快照（git 不可用或非仓库时返回空快照）。 */
  async snapshot(id: string): Promise<GitBranchSnapshot> {
    return await this.readSnapshot(this.workspacePath(id))
  }

  /** 切换到已有分支（等价于 mutate('switch', create=false)）。 */
  async switch(id: string, input: SwitchGitBranchInput): Promise<GitBranchMutation> {
    return await this.mutate(id, 'switch', input.branchName, false)
  }

  /** 创建并切换到新分支（等价于 mutate('create-and-switch', create=true)）。 */
  async create(id: string, input: CreateGitBranchInput): Promise<GitBranchMutation> {
    return await this.mutate(id, 'create-and-switch', input.branchName, true)
  }

  /**
   * 功能：读取分支快照。
   * 内部逻辑：rev-parse 找仓库根 → symbolic-ref 读当前分支（失败即 detached）→
   * for-each-ref 列本地分支；各步失败分别降级为「git 不可用 / 非仓库 / 分支为空」。
   */
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

  /**
   * 功能：切换/创建分支的统一变更流程。
   * @param id 工作区 ID
   * @param action 变更动作名（switch / create-and-switch）
   * @param rawName 目标分支名（trim 后使用）
   * @param create true 时用 `switch -c` 创建
   * @returns 变更结果（成功携带刷新后的快照）
   * 内部逻辑：前置校验依次为——非仓库、空分支名、目标即当前分支（幂等 no-op）、
   * 存在未解决冲突、有其他操作进行中、check-ref-format 验名；全部通过才执行
   * `git switch --no-guess`，失败把 stderr 交给 parseIssues 归一化。
   */
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

  /** 用 rev-parse --git-path 逐个探测 OPERATION_MARKERS 文件是否存在，判断是否有进行中的 Git 操作。 */
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
