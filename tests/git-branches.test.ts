import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitBranches } from '../src/server/git-branches.ts'
import type { WorkspaceSummary } from '../src/shared/types.ts'

let root = ''
let branches: GitBranches
const workspaceId = 'workspace-1'

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function write(path: string, content: string): Promise<void> {
  await writeFile(join(root, path), content)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-web-git-'))
  const workspace: WorkspaceSummary = { id: workspaceId, name: 'repo', path: root, createdAt: 1, updatedAt: 1 }
  branches = new GitBranches(() => [workspace])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A repository with `main` committed and `feature` pointing at the same commit. */
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

describe('GitBranches', () => {
  it('reports a plain directory as not a repository and an unavailable git binary distinctly', async () => {
    const snapshot = await branches.snapshot(workspaceId)
    expect(snapshot).toMatchObject({ isGitAvailable: true, isRepository: false, currentBranchName: null, branches: [] })
  })

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

  it('creates a branch at HEAD and switches to it', async () => {
    await initRepository()
    const created = await branches.create(workspaceId, { branchName: 'pi/topic' })
    expect(created).toMatchObject({ ok: true, action: 'create-and-switch', branchName: 'pi/topic', created: true, didChange: true })
    expect(created.snapshot.currentBranchName).toBe('pi/topic')
    expect(created.snapshot.branches[0]).toMatchObject({ name: 'pi/topic', isCurrent: true })
  })

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

  it('rejects an unknown workspace', async () => {
    await expect(branches.snapshot('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
