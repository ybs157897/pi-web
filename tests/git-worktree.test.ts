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

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function write(path: string, content: string): Promise<void> {
  await writeFile(join(root, path), content)
}

beforeEach(async () => {
  // A parent directory lets branch tests host a bare `origin.git` beside the workspace repo.
  parent = await mkdtemp(join(tmpdir(), 'pi-web-worktree-'))
  root = join(parent, 'repo')
  await mkdir(root, { recursive: true })
  const workspace: WorkspaceSummary = { id: workspaceId, name: 'repo', path: root, createdAt: 1, updatedAt: 1 }
  worktree = new GitWorktree(() => [workspace])
})

afterEach(async () => {
  await rm(parent, { recursive: true, force: true })
})

async function initRepository(): Promise<void> {
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'pi-web@example.test')
  git('config', 'user.name', 'Pi Web Test')
  git('config', 'commit.gpgsign', 'false')
  await write('note.txt', 'a\nb\nc\n')
  git('add', 'note.txt')
  git('commit', '-q', '-m', 'init')
}

async function initRepositoryWithUpstream(): Promise<void> {
  await initRepository()
  const origin = join(parent, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: ['ignore', 'pipe', 'pipe'] })
  git('remote', 'add', 'origin', origin)
  git('push', '-q', '-u', 'origin', 'main')
}

describe('GitWorktree', () => {
  it('distinguishes a plain directory from an unavailable git binary', async () => {
    const status = await worktree.status(workspaceId)
    expect(status).toMatchObject({ isGitAvailable: true, isRepository: false, files: [], dirtyFileCount: 0 })
  })

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

  it('reports push failures instead of throwing when no upstream exists', async () => {
    await initRepository()
    const pushed = await worktree.push(workspaceId)
    expect(pushed.ok).toBe(false)
    expect((pushed.error ?? '').length).toBeGreaterThan(0)
  })

  it('flags index paths as staged even when the worktree adds more edits', async () => {
    await initRepository()
    await write('note.txt', 'a\nB\nc\n')
    git('add', 'note.txt')
    // A second worktree edit on top of the staged one must keep the file marked staged.
    await write('note.txt', 'a\nB\nc\nD\n')
    await write('fresh.txt', 'one\n')

    const status = await worktree.status(workspaceId)
    expect(status.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'note.txt', status: 'modified', staged: true }),
      expect.objectContaining({ path: 'fresh.txt', status: 'untracked', staged: false }),
    ]))
  })

  it('reports no tracking branch and no branch files without an upstream', async () => {
    await initRepository()
    const status = await worktree.status(workspaceId)
    expect(status.trackingBranchName).toBeNull()
    expect(status.branchFiles).toEqual([])
    await expect(worktree.diff(workspaceId, 'note.txt', 'branch')).rejects.toThrow('当前分支没有上游分支')
  })

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

  it('diffs the index against HEAD for the staged source and keeps worktree edits out', async () => {
    await initRepository()
    await write('note.txt', 'a\nB\nc\nd\n')
    git('add', 'note.txt')

    const staged = await worktree.diff(workspaceId, 'note.txt', 'staged')
    expect(staged.diff).toContain('-b')
    expect(staged.diff).toContain('+B')
    expect(staged.oldText).toBe('a\nb\nc\n')
    expect(staged.newText).toBe('a\nB\nc\nd\n')

    // The staged view stays pinned to the index even after further worktree edits.
    await write('note.txt', 'a\nB\nc\nd\nE\n')
    const still = await worktree.diff(workspaceId, 'note.txt', 'staged')
    expect(still.diff).not.toContain('+E')
    expect(still.newText).toBe('a\nB\nc\nd\n')
  })

  it('falls back to the patch when a staged file has no HEAD blob yet', async () => {
    await initRepository()
    await write('fresh.txt', 'one\ntwo\n')
    git('add', 'fresh.txt')

    const staged = await worktree.diff(workspaceId, 'fresh.txt', 'staged')
    expect(staged.diff).toContain('+one')
    expect(staged.oldText).toBeUndefined()
    expect(staged.newText).toBeUndefined()
  })

  it('diffs committed work against the upstream for the branch source', async () => {
    await initRepositoryWithUpstream()
    await write('note.txt', 'a\nB\nc\n')
    git('add', 'note.txt')
    git('commit', '-q', '-m', 'edit note')

    const branch = await worktree.diff(workspaceId, 'note.txt', 'branch')
    expect(branch.diff).toContain('-b')
    expect(branch.diff).toContain('+B')
    // The branch source ships patches only; the texts stay for the staged source.
    expect(branch.oldText).toBeUndefined()
    expect(branch.newText).toBeUndefined()
  })
})
