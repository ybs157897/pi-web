import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitWorktree } from '../src/server/workspace/git/worktree.ts'
import type { WorkspaceSummary } from '../src/shared/types.ts'

let parent = ''
let root = ''
let worktree: GitWorktree
const workspaceId = 'workspace-1'

/**
 * 在工作区仓库根目录同步执行 git 命令。
 * @param args git 参数列表
 * @returns 命令标准输出
 */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 在仓库根目录写一个文件。
 * @param path 相对路径
 * @param content 文件内容
 */
async function write(path: string, content: string): Promise<void> {
  await writeFile(join(root, path), content)
}

/** 每个用例前：建父目录（供上游测试放一个 bare origin.git），并在其下创建工作区 repo 目录。 */
beforeEach(async () => {
  // 父目录让分支相关测试能在工作区仓库旁边放一个 bare `origin.git`。
  parent = await mkdtemp(join(tmpdir(), 'pi-web-worktree-'))
  root = join(parent, 'repo')
  await mkdir(root, { recursive: true })
  const workspace: WorkspaceSummary = { id: workspaceId, name: 'repo', path: root, createdAt: 1, updatedAt: 1 }
  worktree = new GitWorktree(() => [workspace])
})

/** 每个用例后：递归删除整个临时父目录。 */
afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
})

/**
 * 初始化一个只有一个 main 分支单提交（note.txt: a\nb\nc\n）的测试仓库。
 * @returns 无返回值；副作用是 root 下的 git 仓库被初始化
 */
async function initRepository(): Promise<void> {
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'pi-web@example.test')
  git('config', 'user.name', 'Pi Web Test')
  git('config', 'commit.gpgsign', 'false')
  await write('note.txt', 'a\nb\nc\n')
  git('add', 'note.txt')
  git('commit', '-q', '-m', 'init')
}

/**
 * 初始化仓库并挂一个 bare origin 上游：在父目录创建 origin.git、加 remote、推送 main 建立跟踪。
 * @returns 无返回值
 */
async function initRepositoryWithUpstream(): Promise<void> {
  await initRepository()
  const origin = join(parent, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: ['ignore', 'pipe', 'pipe'] })
  git('remote', 'add', 'origin', origin)
  git('push', '-q', '-u', 'origin', 'main')
}

/**
 * GitWorktree 工作区状态与 diff 测试（基于真实 git 的临时仓库）。
 *
 * 关键契约：
 * - 普通目录与 git 二进制不可用要区分报告；
 * - status 汇总暂存/未暂存行数（added/removed），untracked 文件可见；
 * - diff 对已跟踪文件给 patch、对 untracked 文件给全文（newText）；
 * - commit 提交索引，includeUnstaged 可先暂存整个工作区；索引为空报「没有可提交的改动」；
 * - push 无上游时返回结构化失败而非抛异常；
 * - staged 状态标记以索引为准（工作区又改了也保留 staged 标记）；
 * - 无上游时无跟踪分支、无 branchFiles，branch 来源 diff 报「当前分支没有上游分支」；
 * - staged 来源 diff 对比 HEAD 与索引，与后续工作区改动无关；无 HEAD blob 的暂存文件回退 patch；
 * - branch 来源 diff 提交对上游，只给 patch 不给全文。
 */
describe('GitWorktree', () => {
  // 空目录（非仓库）报告 isGitAvailable=true、isRepository=false，文件为空、脏文件计数为 0。
  it('distinguishes a plain directory from an unavailable git binary', async () => {
    const status = await worktree.status(workspaceId)
    expect(status).toMatchObject({ isGitAvailable: true, isRepository: false, files: [], dirtyFileCount: 0 })
  })

  // status 汇总未暂存改动的行数（note.txt +2/-1）与脏文件计数（2，含 untracked new.txt），untracked 文件保留在列表里。
  it('summarizes staged and unstaged line counts and keeps untracked files visible', async () => {
    await initRepository()
    await write('note.txt', 'a\nB\nc\nd\n')
    await write('new.txt', 'one\ntwo\n')

    const status = await worktree.status(workspaceId)
    expect(status).toMatchObject({
      isRepository: true,
      branchName: 'main',
      headRefType: 'branch',
      dirtyFileCount: 2,
      added: 2,
      removed: 1,
    })
    expect(status.files).toEqual(expect.arrayContaining([
      { path: 'note.txt', status: 'modified', added: 2, removed: 1, staged: false },
      { path: 'new.txt', status: 'untracked', added: 0, removed: 0, staged: false },
    ]))
  })

  // 已跟踪文件返回 patch（-b/+B）；untracked 文件返回文件全文 newText。
  it('returns a patch for tracked files and the text for untracked files', async () => {
    await initRepository()
    await write('note.txt', 'a\nB\nc\n')
    await write('new.txt', 'one\ntwo\n')

    const tracked = await worktree.diff(workspaceId, 'note.txt')
    expect(tracked.diff).toContain('-b')
    expect(tracked.diff).toContain('+B')
    const untracked = await worktree.diff(workspaceId, 'new.txt')
    expect(untracked.newText).toBe('one\ntwo\n')
  })

  // 索引为空提交失败（错误含「没有可提交的改动」）；git add 后提交成功返回 7+ 位 hash 且脏文件归零；includeUnstaged=true 会把 untracked 一并提交。
  it('commits the index and optionally stages the whole worktree first', async () => {
    await initRepository()
    await write('note.txt', 'a\nB\nc\n')

    const empty = await worktree.commit(workspaceId, { message: 'try', includeUnstaged: false })
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('没有可提交的改动')

    git('add', 'note.txt')
    const committed = await worktree.commit(workspaceId, { message: 'update note', includeUnstaged: false })
    expect(committed.ok).toBe(true)
    expect(committed.commitHash).toMatch(/^[0-9a-f]{7,}$/)
    expect(committed.status.dirtyFileCount).toBe(0)

    await write('new.txt', 'one\n')
    const withUntracked = await worktree.commit(workspaceId, { message: 'add new', includeUnstaged: true })
    expect(withUntracked.ok).toBe(true)
    expect(withUntracked.status.dirtyFileCount).toBe(0)
  })

  // 没有上游分支时 push 返回 ok=false 的结构化结果与错误文案，而不是抛出异常。
  it('reports push failures instead of throwing when no upstream exists', async () => {
    await initRepository()
    const pushed = await worktree.push(workspaceId)
    expect(pushed.ok).toBe(false)
    expect((pushed.error ?? '').length).toBeGreaterThan(0)
  })

  // staged 标记以索引为准：note.txt 暂存后工作区又改一行，staged 仍为 true；从未暂存的 fresh.txt 是 untracked 且 staged=false。
  it('flags index paths as staged even when the worktree adds more edits', async () => {
    await initRepository()
    await write('note.txt', 'a\nB\nc\n')
    git('add', 'note.txt')
    // 暂存之后工作区又改了一行，文件仍要标为 staged。
    await write('note.txt', 'a\nB\nc\nD\n')
    await write('fresh.txt', 'one\n')

    const status = await worktree.status(workspaceId)
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'note.txt', status: 'modified', staged: true }),
      expect.objectContaining({ path: 'fresh.txt', status: 'untracked', staged: false }),
    ]))
  })

  // 无上游时 trackingBranchName=null、branchFiles=[]，branch 来源 diff 直接报「当前分支没有上游分支」。
  it('reports no tracking branch and no branch files without an upstream', async () => {
    await initRepository()
    const status = await worktree.status(workspaceId)
    expect(status.trackingBranchName).toBeNull()
    expect(status.branchFiles).toEqual([])
    await expect(worktree.diff(workspaceId, 'note.txt', 'branch')).rejects.toThrow('当前分支没有上游分支')
  })

  // 推送后与上游同步（branchFiles=[]）；再提交一次后 ahead=1，branchFiles 列出领先上游的文件及增删行数。
  it('reports the tracking branch and lists branch-ahead files against it', async () => {
    await initRepositoryWithUpstream()
    const synced = await worktree.status(workspaceId)
    expect(synced.trackingBranchName).toBe('origin/main')
    expect(synced.branchFiles).toEqual([])

    await write('note.txt', 'a\nB\nc\n')
    git('add', 'note.txt')
    git('commit', '-q', '-m', 'edit note')
    const ahead = await worktree.status(workspaceId)
    expect(ahead.ahead).toBe(1)
    expect(ahead.branchFiles).toEqual([
      { path: 'note.txt', status: 'modified', added: 1, removed: 1, staged: false },
    ])
  })

  // staged 来源 diff 对比 HEAD 与索引（含 oldText/newText），与后续工作区改动无关：再改一行也不会出现 +E。
  it('diffs the index against HEAD for the staged source and keeps worktree edits out', async () => {
    await initRepository()
    await write('note.txt', 'a\nB\nc\nd\n')
    git('add', 'note.txt')

    const staged = await worktree.diff(workspaceId, 'note.txt', 'staged')
    expect(staged.diff).toContain('-b')
    expect(staged.diff).toContain('+B')
    expect(staged.oldText).toBe('a\nb\nc\n')
    expect(staged.newText).toBe('a\nB\nc\nd\n')

    // 即使工作区随后又改了，staged 视图仍锁定在索引上。
    await write('note.txt', 'a\nB\nc\nd\nE\n')
    const still = await worktree.diff(workspaceId, 'note.txt', 'staged')
    expect(still.diff).not.toContain('+E')
    expect(still.newText).toBe('a\nB\nc\nd\n')
  })

  // 新暂存的文件没有 HEAD blob 可比：回退为 patch（+one），oldText/newText 为 undefined。
  it('falls back to the patch when a staged file has no HEAD blob yet', async () => {
    await initRepository()
    await write('fresh.txt', 'one\ntwo\n')
    git('add', 'fresh.txt')

    const staged = await worktree.diff(workspaceId, 'fresh.txt', 'staged')
    expect(staged.diff).toContain('+one')
    expect(staged.oldText).toBeUndefined()
    expect(staged.newText).toBeUndefined()
  })

  // branch 来源 diff 的是已提交内容对上游；只返回 patch，oldText/newText 全文只保留给 staged 来源。
  it('diffs committed work against the upstream for the branch source', async () => {
    await initRepositoryWithUpstream()
    await write('note.txt', 'a\nB\nc\n')
    git('add', 'note.txt')
    git('commit', '-q', '-m', 'edit note')

    const branch = await worktree.diff(workspaceId, 'note.txt', 'branch')
    expect(branch.diff).toContain('-b')
    expect(branch.diff).toContain('+B')
    // branch 来源只给 patch；全文文本留给 staged 来源。
    expect(branch.oldText).toBeUndefined()
    expect(branch.newText).toBeUndefined()
  })
})
