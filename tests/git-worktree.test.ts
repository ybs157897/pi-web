import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitWorktree } from '../src/server/git-worktree.ts'
import type { WorkspaceSummary } from '../src/shared/types.ts'

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
  root = await mkdtemp(join(tmpdir(), 'pi-web-worktree-'))
  const workspace: WorkspaceSummary = { id: workspaceId, name: 'repo', path: root, createdAt: 1, updatedAt: 1 }
  worktree = new GitWorktree(() => [workspace])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
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
      { path: 'note.txt', status: 'modified', added: 2, removed: 1 },
      { path: 'new.txt', status: 'untracked', added: 0, removed: 0 },
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
})
