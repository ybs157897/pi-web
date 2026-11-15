import { execFile, type ExecFileException } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  GitChangeSourceId,
  GitCommitInput,
  GitCommitResult,
  GitHeadRefType,
  GitPushResult,
  GitWorktreeDiff,
  GitWorktreeFile,
  GitWorktreeFileStatus,
  GitWorktreeStatus,
  WorkspaceSummary,
} from '../../../shared/types.ts'
import { RuntimeError } from '../../runtime-errors.ts'

const GIT_TIMEOUT_MS = 15_000
const GIT_PUSH_TIMEOUT_MS = 60_000
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_DIFF_BYTES = 512 * 1024
const MAX_COMMIT_MESSAGE = 10_000
const MAX_COMMIT_CONTEXT_BYTES = 24 * 1024

/** 一次 git 命令的结果；unavailable 表示 git 本体不存在。 */
interface GitCommandResult { stdout: string; stderr: string; code: number; unavailable: boolean }

const UNAVAILABLE: GitCommandResult = { stdout: '', stderr: '', code: -1, unavailable: true }

/**
 * 功能：运行一条 git 命令，永不 reject——错误收敛为结果对象。
 * 平台差异与安全：统一 `execFile` 不经 shell；GIT_TERMINAL_PROMPT=0 禁止交互式
 * 凭据提示（远端操作永不挂起）；windowsHide 隐藏控制台窗口；git 不存在返回 UNAVAILABLE。
 */
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

/** 构造「非仓库 / git 不可用」的空状态。 */
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
    trackingBranchName: null,
  }
}

/** porcelain 状态里 `##` 分支行解析出的头部信息。 */
interface BranchHeader {
  branchName: string | null
  headRefType: GitHeadRefType
  ahead: number
  behind: number
}

/** 解析 `git status --porcelain=v1 --branch -z` 最先输出的 `##` 头（含 ahead/behind、无提交、detached）。 */
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

/** 把 porcelain 两字符状态码映射为展示状态；`!!`（忽略）返回 undefined 直接丢弃。 */
function statusKind(code: string): GitWorktreeFileStatus | undefined {
  if (code === '??') return 'untracked'
  if (code === '!!') return undefined
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  return 'modified'
}

/** 解析 `git status --porcelain=v1 -z` 的 NUL 分隔流：头部 + 全部改动路径。 */
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
    // -z 模式下 rename/copy 写作 `XY 新路径\0旧路径\0`，跳过旧路径 token。
    if (code.includes('R') || code.includes('C')) index += 1
    const kind = statusKind(code)
    if (kind === undefined) continue
    files.push({ path: token.slice(3), status: kind })
  }
  return { branch, files }
}

/** 解析 `git diff --numstat -z`：`added\tremoved\tpath`，rename 时为 `added\tremoved\t\0旧\0新`。 */
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

/** 取错误文案：stderr 优先，stdout 兜底，截断到 2000 字符。 */
function errorText(result: GitCommandResult): string {
  return (result.stderr.trim() || result.stdout.trim() || 'Git 命令执行失败').slice(0, 2_000)
}

/** `git diff --cached --name-only -z`：仅当前暂存区持有的路径。 */
function parseNameOnly(stdout: string): string[] {
  return stdout.split('\0').filter(name => name !== '')
}

/** 当前分支跟踪上游时返回 `origin/main` 这类名字；无上游时命令失败返回 null。 */
async function upstreamName(repoRoot: string): Promise<string | null> {
  const upstream = await runGit(repoRoot, ['rev-parse', '--abbrev-ref', '@{upstream}'])
  const name = upstream.stdout.trim()
  return upstream.code === 0 && name !== '' ? name : null
}

/** ZCode 的「分支来源」文件清单：本分支相对上游新增的行数，按路径计。 */
async function branchFileList(repoRoot: string, upstream: string): Promise<GitWorktreeFile[]> {
  const range = await runGit(repoRoot, ['diff', '--numstat', '-z', `${upstream}...HEAD`])
  const counts = parseNumstat(range.stdout)
  return [...counts.entries()]
    .map(([path, count]) => ({ path, status: 'modified' as const, added: count.added, removed: count.removed, staged: false }))
    .sort((first, second) => first.path.localeCompare(second.path))
}

/** `git show <revision>:<path>`；该修订没有对应 blob 时返回 undefined。 */
async function showRevision(repoRoot: string, path: string, revision: string): Promise<string | undefined> {
  const shown = await runGit(repoRoot, ['show', `${revision}:${path}`])
  return shown.code === 0 ? shown.stdout : undefined
}

/** 补丁形状化（各 diff 来源共用）：二进制标记与超长补丁转成 availability 提示。 */
function shapePatch(path: string, patch: GitCommandResult): GitWorktreeDiff {
  if (patch.stdout.startsWith('Binary files ')) return { path, diff: patch.stdout, availability: 'binary' }
  if (patch.stdout !== '') {
    const truncated = patch.stdout.length > MAX_DIFF_BYTES
    return { path, diff: patch.stdout.slice(0, MAX_DIFF_BYTES), ...(truncated ? { availability: 'truncated' } : {}) }
  }
  return { path }
}

/** 把原始路径解析为仓库根内的相对路径（`/` 分隔）；逃出根抛 INVALID_INPUT。 */
function normalizeRelativePath(root: string, rawPath: string): string {
  const target = resolve(root, rawPath)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new RuntimeError('INVALID_INPUT', '文件路径不在工作区内')
  }
  return rel.split('\\').join('/')
}

/**
 * 状态卡所需的工作树级 Git 能力：状态 + 行数统计、单文件 diff、提交与推送。
 * 全部调用走 `execFile`（cwd 为仓库根），不经 shell。
 */
export class GitWorktree {
  constructor(private readonly workspaces: () => readonly WorkspaceSummary[]) {}

  /** 按 ID 取工作区路径；不存在抛 NOT_FOUND。 */
  private workspacePath(id: string): string {
    const workspace = this.workspaces().find(item => item.id === id)
    if (!workspace) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return workspace.path
  }

  /** 读取工作树状态快照（git 不可用或非仓库时返回空状态）。 */
  async status(id: string): Promise<GitWorktreeStatus> {
    return await this.readStatus(this.workspacePath(id))
  }

  /**
   * 功能：为审查面板取一个文件的 diff。
   * @param sourceId 来源：`staged` 比较暂存区与 HEAD（附带新旧文本供并排渲染）；
   * `branch` 比较上游与 HEAD；缺省保持 `diff HEAD` 合并视图
   * @returns shapePatch 处理后的 diff；缺省来源下未跟踪文件附带当前全文（newText）
   * 内部逻辑：untracked 没有 HEAD 条目，取文件现文本替代——真实路径必须仍在工作
   * 区内（符号链接可能指到外面），超过 MAX_DIFF_BYTES 就放弃。
   */
  async diff(id: string, rawPath: string, sourceId?: GitChangeSourceId): Promise<GitWorktreeDiff> {
    const status = await this.readStatus(this.workspacePath(id))
    if (!status.isRepository || status.repoRoot === null) {
      throw new RuntimeError('INVALID_INPUT', '工作区不在 Git 仓库中')
    }
    const path = normalizeRelativePath(status.repoRoot, rawPath)
    if (sourceId === 'staged') return await this.stagedDiff(status.repoRoot, path)
    if (sourceId === 'branch') return await this.branchDiff(status, path)
    const patch = await runGit(status.repoRoot, ['diff', 'HEAD', '--no-color', '--unified=3', '--', path])
    if (patch.unavailable) throw new RuntimeError('INVALID_INPUT', '未找到 Git')
    const shaped = shapePatch(path, patch)
    if (shaped.diff !== undefined) return shaped
    // 未跟踪文件没有 HEAD 条目，检查器改拿它的当前文本。
    const target = resolve(status.repoRoot, path)
    const info = await lstat(target).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.size > MAX_DIFF_BYTES) return { path }
    // 符号链接可能指向工作区外；真实路径仍在里面时才读。
    const real = await realpath(target).catch(() => undefined)
    if (real === undefined) return { path }
    const insideRoot = relative(status.repoRoot, real)
    if (insideRoot.startsWith('..') || isAbsolute(insideRoot)) return { path }
    const text = await readFile(real, 'utf8').catch(() => undefined)
    return text === undefined ? { path } : { path, newText: text }
  }

  /** 暂存区与 HEAD 的比较；附带新旧文本让面板渲染完整 diff 视图而非补丁。 */
  private async stagedDiff(root: string, path: string): Promise<GitWorktreeDiff> {
    const patch = await runGit(root, ['diff', '--cached', '--no-color', '--unified=3', '--', path])
    if (patch.unavailable) throw new RuntimeError('INVALID_INPUT', '未找到 Git')
    const shaped = shapePatch(path, patch)
    if (shaped.availability === 'binary') return shaped
    // 新增文件没有 HEAD blob、删除的文件没有 index blob，任一缺失就不带文本。
    const indexText = await showRevision(root, path, '')
    const headText = await showRevision(root, path, 'HEAD')
    if (indexText !== undefined && headText !== undefined
      && indexText.length <= MAX_DIFF_BYTES && headText.length <= MAX_DIFF_BYTES) {
      return { ...shaped, oldText: headText, newText: indexText }
    }
    return shaped.diff !== undefined ? shaped : { path, availability: 'unavailable' }
  }

  /** 本分支相对上游的 diff；只给补丁，与 ZCode 的 branch 来源一致。 */
  private async branchDiff(status: GitWorktreeStatus, path: string): Promise<GitWorktreeDiff> {
    if (status.repoRoot === null) throw new RuntimeError('INVALID_INPUT', '工作区不在 Git 仓库中')
    const upstream = status.trackingBranchName
    if (upstream === null) throw new RuntimeError('INVALID_INPUT', '当前分支没有上游分支')
    const patch = await runGit(status.repoRoot, ['diff', '--no-color', '--unified=3', `${upstream}...HEAD`, '--', path])
    if (patch.unavailable) throw new RuntimeError('INVALID_INPUT', '未找到 Git')
    const shaped = shapePatch(path, patch)
    return shaped.diff !== undefined || shaped.availability !== undefined ? shaped : { path, availability: 'unavailable' }
  }

  /**
   * 功能：取「这次提交将包含的」diff，供模型生成提交说明（截断到 24 KB）。
   * @param includeUnstaged true 取 `diff HEAD`（含未暂存改动），false 取 `diff --cached`
   * @returns 状态与 diff 文本；非仓库或命令失败时 diff 为空串
   */
  async commitContext(id: string, includeUnstaged: boolean): Promise<{ status: GitWorktreeStatus; diff: string }> {
    const status = await this.readStatus(this.workspacePath(id))
    if (!status.isRepository || status.repoRoot === null) return { status, diff: '' }
    const diff = await runGit(status.repoRoot, includeUnstaged
      ? ['diff', 'HEAD', '--no-color', '--unified=3']
      : ['diff', '--cached', '--no-color', '--unified=3'])
    return { status, diff: diff.code === 0 ? diff.stdout.slice(0, MAX_COMMIT_CONTEXT_BYTES) : '' }
  }

  /**
   * 功能：提交工作树改动。
   * @param input.message 提交信息（1–10000 字符，trim 后校验）
   * @param input.includeUnstaged true 时先 `git add -A` 把未暂存改动一并暂存
   * @returns 提交结果：成功带短哈希与刷新后的状态；各失败分支带中文 error
   * 内部逻辑：暂存后用 `diff --cached --quiet` 探测——退出码 0 说明暂存区为空
   * （没有可提交的改动）；commit 成功后再 rev-parse 取短哈希。
   */
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

  /** 推送当前分支到其上游（裸 `git push`，60 秒超时）；失败带 git 错误文案。 */
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

  /**
   * 功能：组装工作树状态：分支头、改动文件、行数统计、暂存标记与上游分支文件。
   * 内部逻辑：rev-parse 判仓库与根 → porcelain -z 解析状态与分支头 → 并行取
   * numstat（行数）、cached name-only（暂存标记）、上游名；上游存在时再算
   * branchFiles（相对上游新增的行）。各步失败按「git 不可用 / 非仓库 / 空状态」降级。
   */
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
    const [numstat, stagedNames, upstream] = await Promise.all([
      runGit(repoRoot, ['diff', 'HEAD', '--numstat', '-z']),
      runGit(repoRoot, ['diff', '--cached', '--name-only', '-z']),
      upstreamName(repoRoot),
    ])
    const counts = parseNumstat(numstat.stdout)
    const stagedPaths = new Set(parseNameOnly(stagedNames.stdout))
    const files: GitWorktreeFile[] = parsed.files.map(file => {
      const count = counts.get(file.path)
      return {
        path: file.path,
        status: file.status,
        added: count?.added ?? 0,
        removed: count?.removed ?? 0,
        staged: stagedPaths.has(file.path),
      }
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
      trackingBranchName: upstream,
      branchFiles: upstream === null ? [] : await branchFileList(repoRoot, upstream),
    }
  }
}
