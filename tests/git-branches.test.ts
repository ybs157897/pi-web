import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitBranches } from '../src/server/workspace/git/branches.ts'
import type { WorkspaceSummary } from '../src/shared/types.ts'

let root = ''
let branches: GitBranches
const workspaceId = 'workspace-1'

/**
 * 在临时仓库根目录同步执行 git 命令。
 * @param args git 参数列表
 * @returns 命令标准输出
 */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 在临时仓库根目录写一个文件。
 * @param path 相对路径
 * @param content 文件内容
 */
async function write(path: string, content: string): Promise<void> {
  await writeFile(join(root, path), content)
}

/** 每个用例前：创建临时目录作为仓库根，并让 GitBranches 只看到这个 workspace。 */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-web-git-'))
  const workspace: WorkspaceSummary = { id: workspaceId, name: 'repo', path: root, createdAt: 1, updatedAt: 1 }
  branches = new GitBranches(() => [workspace])
})

/** 每个用例后：递归删除临时目录。 */
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * 初始化一个有两个分支的测试仓库：`main` 已提交，`feature` 指向同一提交。
 * @returns 无返回值；副作用是 root 下的 git 仓库被初始化
 */
async function initRepository(): Promise<void> {
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'pi-web@example.test')
  git('config', 'user.name', 'Pi Web Test')
  git('config', 'commit.gpgsign', 'false')
  await write('note.txt', 'main\n')
  git('add', 'note.txt')
  git('commit', '-q', '-m', 'init')
  git('branch', 'feature')
}

/**
 * GitBranches 分支管理测试（基于真实 git 的临时仓库）。
 *
 * 关键契约：
 * - 普通目录与 git 二进制不可用要区分报告（isGitAvailable / isRepository）；
 * - 本地分支列表当前分支排第一，带 40 位 commit hash 与提交时间戳；
 * - 切换分支区分 didChange 与 no-op，detached HEAD 下 currentBranchName 为 null 但分支仍可读；
 * - create 在 HEAD 建分支并切换；非法名/重复名/不存在的分支返回结构化 issue code；
 * - 未提交改动会被目标分支覆盖时（tracked-changes-would-be-overwritten）与索引有未解决冲突时
 *   （conflicts-present）都阻止切换并给出阻塞路径；
 * - 未知 workspace 抛 NOT_FOUND。
 */
describe('GitBranches', () => {
  // 空目录（非仓库）报告 isGitAvailable=true 但 isRepository=false，分支为空、当前分支为 null。
  it('reports a plain directory as not a repository and an unavailable git binary distinctly', async () => {
    const snapshot = await branches.snapshot(workspaceId)
    expect(snapshot).toMatchObject({ isGitAvailable: true, isRepository: false, currentBranchName: null, branches: [] })
  })

  // 分支列表当前分支排最前（main 在 feature 前），带 isCurrent/upstreamName/40 位 hash/正数提交时间戳。
  it('lists local branches with the current branch first and commit metadata', async () => {
    await initRepository()
    const snapshot = await branches.snapshot(workspaceId)
    expect(snapshot.isRepository).toBe(true)
    expect(snapshot.headRefType).toBe('branch')
    expect(snapshot.currentBranchName).toBe('main')
    expect(snapshot.branches.map(branch => branch.name)).toEqual(['main', 'feature'])
    expect(snapshot.branches[0]).toMatchObject({ isCurrent: true, upstreamName: null })
    expect(snapshot.branches[0]?.commitHash).toMatch(/^[0-9a-f]{40}$/)
    expect(snapshot.branches[0]?.commitTimestampMs).toBeGreaterThan(0)
  })

  // 切到 feature 成功（didChange=true）；重复切同一分支是 no-op（didChange=false）；detach 后 currentBranchName 为 null 且 headRefType=detached。
  it('switches branches, treats the current branch as a no-op, and keeps detached HEAD readable', async () => {
    await initRepository()
    const switched = await branches.switch(workspaceId, { branchName: 'feature' })
    expect(switched).toMatchObject({ ok: true, action: 'switch', branchName: 'feature', didChange: true, issues: [] })
    expect(switched.snapshot.currentBranchName).toBe('feature')

    const noop = await branches.switch(workspaceId, { branchName: 'feature' })
    expect(noop.ok).toBe(true)
    expect(noop.didChange).toBe(false)

    git('checkout', '-q', '--detach')
    const detached = await branches.snapshot(workspaceId)
    expect(detached.headRefType).toBe('detached')
    expect(detached.currentBranchName).toBeNull()
    expect(detached.branches.map(branch => branch.name)).toEqual(['feature', 'main'])
  })

  // create 在当前 HEAD 上新建 pi/topic 并直接切换过去，结果标记 created=true、didChange=true。
  it('creates a branch at HEAD and switches to it', async () => {
    await initRepository()
    const created = await branches.create(workspaceId, { branchName: 'pi/topic' })
    expect(created).toMatchObject({ ok: true, action: 'create-and-switch', branchName: 'pi/topic', created: true, didChange: true })
    expect(created.snapshot.currentBranchName).toBe('pi/topic')
    expect(created.snapshot.branches[0]).toMatchObject({ name: 'pi/topic', isCurrent: true })
  })

  // 三类失败各返回专属 issue code：非法名 invalid-branch-name、重复名 branch-already-exists、切到不存在分支 target-branch-not-found。
  it('rejects invalid, duplicated and missing branch names with structured issues', async () => {
    await initRepository()
    const invalid = await branches.create(workspaceId, { branchName: 'bad name' })
    expect(invalid.ok).toBe(false)
    expect(invalid.issues[0]?.code).toBe('invalid-branch-name')

    const duplicate = await branches.create(workspaceId, { branchName: 'feature' })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.issues[0]?.code).toBe('branch-already-exists')

    const missing = await branches.switch(workspaceId, { branchName: 'nope' })
    expect(missing.ok).toBe(false)
    expect(missing.issues[0]?.code).toBe('target-branch-not-found')
  })

  // 未提交改动会被目标分支覆盖时阻止切换，issue 带被阻塞的文件路径，且实际分支未变（仍在 main）。
  it('maps tracked-file overwrites to the ZCode issue code with the blocking paths', async () => {
    await initRepository()
    git('switch', '-q', 'feature')
    await write('note.txt', 'feature\n')
    git('commit', '-q', '-am', 'feature version')
    git('switch', '-q', 'main')
    await write('note.txt', 'uncommitted\n')
    const blocked = await branches.switch(workspaceId, { branchName: 'feature' })
    expect(blocked.ok).toBe(false)
    expect(blocked.issues[0]).toMatchObject({ code: 'tracked-changes-would-be-overwritten', paths: ['note.txt'] })
    expect(git('branch', '--show-current').trim()).toBe('main')
  })

  // 索引里有未解决合并冲突时阻止切换，issue code=conflicts-present 并列出冲突文件。
  it('blocks switching while the index still has unresolved conflicts', async () => {
    await initRepository()
    git('switch', '-q', 'feature')
    await write('note.txt', 'feature\n')
    git('commit', '-q', '-am', 'feature version')
    git('switch', '-q', 'main')
    await write('note.txt', 'main version\n')
    git('commit', '-q', '-am', 'main version')
    expect(() => git('merge', 'feature')).toThrow()
    const blocked = await branches.switch(workspaceId, { branchName: 'feature' })
    expect(blocked.ok).toBe(false)
    expect(blocked.issues[0]).toMatchObject({ code: 'conflicts-present', paths: ['note.txt'] })
    git('merge', '--abort')
  })

  // 查询未注册的 workspace 直接抛 NOT_FOUND 错误。
  it('rejects an unknown workspace', async () => {
    await expect(branches.snapshot('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
