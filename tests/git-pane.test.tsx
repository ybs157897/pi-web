// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { GitWorktreeStatus } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

const apiMock = vi.hoisted(() => ({ gitWorktreeStatus: vi.fn(), gitWorktreeDiff: vi.fn() }))
vi.mock('../src/web/api.ts', () => ({
  api: apiMock,
  ApiFailure: class ApiFailure extends Error {},
}))

import GitPane, {
  diffCacheKey, lastTurnDiffTexts, paneEmptyState, sortLastTurnChanges, sourceFileList, sourceOptions,
} from '../src/web/GitPane.tsx'

beforeEach(() => {
  setupRenderingDom()
  apiMock.gitWorktreeStatus.mockReset()
  apiMock.gitWorktreeDiff.mockReset()
  apiMock.gitWorktreeStatus.mockResolvedValue(statusFixture())
  apiMock.gitWorktreeDiff.mockResolvedValue({ path: 'src/web/GitPane.tsx', diff: '-a\n+b\n' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function statusFixture(overrides: Partial<GitWorktreeStatus> = {}): GitWorktreeStatus {
  return {
    isGitAvailable: true,
    isRepository: true,
    repoRoot: '/repo',
    branchName: 'main',
    headRefType: 'branch',
    ahead: 0,
    behind: 0,
    dirtyFileCount: 4,
    added: 6,
    removed: 2,
    files: [
      { path: 'src/web/GitPane.tsx', status: 'modified', added: 3, removed: 1, staged: false },
      { path: 'docs/plan.md', status: 'untracked', added: 0, removed: 0, staged: false },
      { path: 'src/shared/types.ts', status: 'modified', added: 2, removed: 1, staged: true },
      { path: 'README.md', status: 'modified', added: 1, removed: 0, staged: false },
    ],
    trackingBranchName: 'origin/main',
    branchFiles: [
      { path: 'a/second.ts', status: 'modified', added: 4, removed: 0, staged: false },
      { path: 'a/first.ts', status: 'modified', added: 1, removed: 0, staged: false },
    ],
    ...overrides,
  }
}

function renderPane(overrides: Partial<ComponentProps<typeof GitPane>> = {}) {
  const onSelectSource = vi.fn()
  const view = render(<GitPane workspaceId="ws-1" activeSource="unstaged" onSelectSource={onSelectSource}
    onNotice={() => {}} {...overrides} />)
  return { onSelectSource, ...view }
}

const row = (path: string) => screen.getByTitle(path)

describe('GitPane pure helpers', () => {
  it('keys the diff cache per source and path', () => {
    expect(diffCacheKey('staged', 'src/a.ts')).toBe('staged:src/a.ts')
    expect(diffCacheKey('unstaged', 'src/a.ts')).not.toBe(diffCacheKey('branch', 'src/a.ts'))
  })

  it('splits the status snapshot per source and sorts untracked last', () => {
    expect(sourceFileList('unstaged', statusFixture()).map(file => file.path))
      .toEqual(['README.md', 'src/web/GitPane.tsx', 'docs/plan.md'])
    expect(sourceFileList('staged', statusFixture()).map(file => file.path)).toEqual(['src/shared/types.ts'])
    // Branch rows sort alphabetically regardless of the server order.
    expect(sourceFileList('branch', statusFixture()).map(file => file.path)).toEqual(['a/first.ts', 'a/second.ts'])
    expect(sourceFileList('unstaged', statusFixture({ isRepository: false }))).toEqual([])
    expect(sourceFileList('unstaged', null)).toEqual([])
  })

  it('sorts last-turn rows alphabetically and shapes the local diff texts', () => {
    const changes = [
      { path: 'b.md', added: 1, removed: 0, after: 'x\n', kind: 'added' as const },
      { path: 'a.md', added: 1, removed: 1, before: 'x\n', after: 'y\n', kind: 'modified' as const },
    ]
    expect(sortLastTurnChanges(changes).map(change => change.path)).toEqual(['a.md', 'b.md'])
    expect(lastTurnDiffTexts(changes[1]!)).toEqual({ oldText: 'x\n', newText: 'y\n' })
    expect(lastTurnDiffTexts(changes[0]!)).toEqual({ oldText: '', newText: 'x\n' })
    expect(lastTurnDiffTexts({ path: 'c.md', added: 0, removed: 2, before: 'z\n', kind: 'deleted' }))
      .toEqual({ oldText: 'z\n', newText: '' })
    expect(lastTurnDiffTexts({ path: 'd.md', added: 0, removed: 0, kind: 'renamed' })).toBeNull()
  })

  it('resolves the empty state with the last-turn copy first', () => {
    expect(paneEmptyState('unstaged', statusFixture(), undefined, 1)).toBeNull()
    expect(paneEmptyState('last-turn', statusFixture(), [], 0)).toBe('last-turn-empty')
    expect(paneEmptyState('unstaged', statusFixture({ isRepository: false }), undefined, 0)).toBe('not-repository')
    expect(paneEmptyState('unstaged', statusFixture({ files: [] }), undefined, 0)).toBe('generic')
    expect(paneEmptyState('branch', statusFixture({ branchFiles: [] }), undefined, 0)).toBe('generic')
  })

  it('disables the last-turn option only when no dataset exists', () => {
    expect(sourceOptions(false).at(-1)).toEqual({ id: 'last-turn', disabled: true })
    expect(sourceOptions(true).at(-1)).toEqual({ id: 'last-turn', disabled: false })
  })
})

describe('GitPane', () => {
  it('lists the unstaged rows, lazy-loads a diff once and serves repeats from the cache', async () => {
    renderPane()
    expect(await screen.findByTitle('docs/plan.md')).toBeTruthy()
    expect(apiMock.gitWorktreeDiff).not.toHaveBeenCalled()

    fireEvent.click(row('src/web/GitPane.tsx'))
    await waitFor(() => expect(apiMock.gitWorktreeDiff).toHaveBeenCalledTimes(1))
    expect(apiMock.gitWorktreeDiff).toHaveBeenCalledWith('ws-1', 'src/web/GitPane.tsx', 'unstaged')
    await waitFor(() => expect(document.querySelector('[data-diff-body="src/web/GitPane.tsx"]')?.textContent).toContain('-a'))

    fireEvent.click(row('src/web/GitPane.tsx'))
    fireEvent.click(row('src/web/GitPane.tsx'))
    await waitFor(() => expect(document.querySelector('[data-diff-body="src/web/GitPane.tsx"]')?.textContent).toContain('-a'))
    expect(apiMock.gitWorktreeDiff).toHaveBeenCalledTimes(1)
  })

  it('keeps a single row open, reports request failures inline and clears on source change', async () => {
    apiMock.gitWorktreeDiff
      .mockResolvedValueOnce({ path: 'src/web/GitPane.tsx', diff: '-a\n+b\n' })
      .mockRejectedValueOnce(new Error('git 失败'))
    const { rerender } = renderPane()
    await screen.findByTitle('docs/plan.md')

    fireEvent.click(row('src/web/GitPane.tsx'))
    await waitFor(() => expect(document.querySelector('[data-diff-body="src/web/GitPane.tsx"]')).toBeTruthy())
    fireEvent.click(row('README.md'))
    await waitFor(() => expect(document.querySelector('[data-diff-body="README.md"]')?.textContent).toContain('git 失败'))
    expect(document.querySelector('[data-diff-body="src/web/GitPane.tsx"]')).toBeNull()

    // Switching the source collapses the open row and points new requests at the new source.
    rerender(<GitPane workspaceId="ws-1" activeSource="staged" onSelectSource={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-diff-body]')).toBeNull()
    fireEvent.click(row('src/shared/types.ts'))
    await waitFor(() => expect(apiMock.gitWorktreeDiff).toHaveBeenCalledWith('ws-1', 'src/shared/types.ts', 'staged'))
  })

  it('renders the branch source from the upstream file list', async () => {
    renderPane({ activeSource: 'branch' })
    expect(await screen.findByTitle('a/first.ts')).toBeTruthy()
    fireEvent.click(row('a/first.ts'))
    await waitFor(() => expect(apiMock.gitWorktreeDiff).toHaveBeenCalledWith('ws-1', 'a/first.ts', 'branch'))
  })

  it('renders last-turn changes locally without any diff request', async () => {
    const lastTurnChanges = [
      { path: 'b.md', added: 1, removed: 0, after: 'x\n', kind: 'added' as const },
      { path: 'a.md', added: 1, removed: 1, before: 'x\n', after: 'y\n', kind: 'modified' as const },
    ]
    renderPane({ activeSource: 'last-turn', lastTurnChanges })
    expect(await screen.findByTitle('b.md')).toBeTruthy()
    fireEvent.click(row('a.md'))
    await waitFor(() => expect(document.querySelector('[data-diff-body="a.md"]')?.textContent).toContain('y'))
    expect(apiMock.gitWorktreeDiff).not.toHaveBeenCalled()
  })

  it('shows the dedicated last-turn empty state for an empty dataset', async () => {
    renderPane({ activeSource: 'last-turn', lastTurnChanges: [] })
    expect(await screen.findByText('上一轮没有文件更改')).toBeTruthy()
    expect(apiMock.gitWorktreeStatus).toHaveBeenCalled()
  })

  it('distinguishes the not-a-repository empty state from the generic one', async () => {
    apiMock.gitWorktreeStatus.mockResolvedValue(statusFixture({ branchFiles: [] }))
    const first = renderPane({ activeSource: 'branch' })
    expect(await screen.findByText('当前来源下没有可展示的改动')).toBeTruthy()
    expect(screen.queryByText('当前目录不是 Git 仓库')).toBeNull()
    first.unmount()

    apiMock.gitWorktreeStatus.mockResolvedValue(statusFixture({ isRepository: false, files: [], dirtyFileCount: 0 }))
    renderPane({ activeSource: 'branch' })
    expect(await screen.findByText('当前目录不是 Git 仓库')).toBeTruthy()
  })

  it('wires the select to onSelectSource and disables the last-turn option without data', async () => {
    const first = renderPane()
    await screen.findByTitle('docs/plan.md')
    const select = screen.getByLabelText('更改来源') as HTMLSelectElement
    expect((select.querySelector('option[value="last-turn"]') as HTMLOptionElement | null)?.disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'branch' } })
    expect(first.onSelectSource).toHaveBeenCalledWith('branch')
    first.unmount()

    const second = renderPane({ lastTurnChanges: [] })
    await screen.findByTitle('docs/plan.md')
    const nextSelect = screen.getByLabelText('更改来源') as HTMLSelectElement
    expect((nextSelect.querySelector('option[value="last-turn"]') as HTMLOptionElement | null)?.disabled).toBe(false)
    fireEvent.change(nextSelect, { target: { value: 'last-turn' } })
    expect(second.onSelectSource).toHaveBeenCalledWith('last-turn')
  })

  it('surfaces a failed status load as an inline alert', async () => {
    apiMock.gitWorktreeStatus.mockRejectedValue(new Error('git 超时'))
    renderPane()
    expect(await screen.findByText('git 超时')).toBeTruthy()
  })

  it('collapses the open row when its file leaves the list after a refresh', async () => {
    renderPane()
    await screen.findByTitle('docs/plan.md')
    fireEvent.click(row('src/web/GitPane.tsx'))
    await waitFor(() => expect(document.querySelector('[data-diff-body="src/web/GitPane.tsx"]')).toBeTruthy())

    apiMock.gitWorktreeStatus.mockResolvedValue(statusFixture({
      files: [{ path: 'README.md', status: 'modified', added: 1, removed: 0, staged: false }],
      dirtyFileCount: 1,
    }))
    fireEvent.click(screen.getByLabelText('刷新'))
    await waitFor(() => expect(screen.getByTitle('README.md')).toBeTruthy())
    expect(document.querySelector('[data-diff-body]')).toBeNull()
  })
})
