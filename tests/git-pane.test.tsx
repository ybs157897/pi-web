// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { GitWorktreeStatus } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/** api 层 mock：只覆盖 GitPane 用到的工作区状态与 diff 两个接口。 */
const apiMock = vi.hoisted(() => ({ gitWorktreeStatus: vi.fn(), gitWorktreeDiff: vi.fn() }))
vi.mock('../src/web/api.ts', () => ({
  api: apiMock,
  ApiFailure: class ApiFailure extends Error {},
}))

import GitPane, {
  diffCacheKey, lastTurnDiffTexts, paneEmptyState, sortLastTurnChanges, sourceFileList, sourceOptions,
} from '../src/web/GitPane.tsx'

/** 每个用例前：搭建渲染 DOM、重置并给两个接口默认的成功响应（状态用 statusFixture）。 */
beforeEach(() => {
  setupRenderingDom()
  apiMock.gitWorktreeStatus.mockReset()
  apiMock.gitWorktreeDiff.mockReset()
  apiMock.gitWorktreeStatus.mockResolvedValue(statusFixture())
  apiMock.gitWorktreeDiff.mockResolvedValue({ path: 'src/web/GitPane.tsx', diff: '-a\n+b\n' })
})
/** 每个用例后：卸载组件、恢复 mock、移除全局 stub。 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/**
 * 构造工作区状态快照：4 个脏文件（未暂存/未跟踪/已暂存混合），branch 来源含 2 个乱序文件。
 * @param overrides 需要覆盖的状态字段（isRepository/files/branchFiles 等）
 * @returns 完整的 GitWorktreeStatus
 */
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

/**
 * 渲染 GitPane，默认 workspaceId=ws-1、activeSource=unstaged。
 * @param overrides 组件属性覆盖项（activeSource/lastTurnChanges 等）
 * @returns onSelectSource spy 与 render 结果
 */
function renderPane(overrides: Partial<ComponentProps<typeof GitPane>> = {}) {
  const onSelectSource = vi.fn()
  const view = render(<GitPane workspaceId="ws-1" activeSource="unstaged" onSelectSource={onSelectSource}
    onNotice={() => {}} {...overrides} />)
  return { onSelectSource, ...view }
}

/** 按文件 title 定位文件行元素（文件行以 path 作为 title 属性）。 */
const row = (path: string) => screen.getByTitle(path)

/**
 * GitPane 纯辅助函数测试（不渲染组件）。
 *
 * 关键契约：
 * - diff 缓存键按「来源:路径」组合区分；
 * - sourceFileList 按来源切分快照：未暂存排除已暂存文件、未跟踪排最后；branch 来源按字母排序；非仓库/无快照返回空；
 * - sortLastTurnChanges 按字母排序；lastTurnDiffTexts 按变更类型给出旧/新文本（新增 oldText 空、删除 newText 空、renamed 无文本返回 null）；
 * - paneEmptyState 优先返回 last-turn 专属空态文案，再区分非仓库与通用空态；
 * - sourceOptions 仅在没有 last-turn 数据时禁用该选项。
 */
describe('GitPane pure helpers', () => {
  // 缓存键 = `${source}:${path}`，不同来源同路径的键互不相同。
  it('keys the diff cache per source and path', () => {
    expect(diffCacheKey('staged', 'src/a.ts')).toBe('staged:src/a.ts')
    expect(diffCacheKey('unstaged', 'src/a.ts')).not.toBe(diffCacheKey('branch', 'src/a.ts'))
  })

  // unstaged 来源排除已暂存文件且未跟踪（docs/plan.md）排最后；staged 只含已暂存文件；branch 行按字母排序（不管服务端顺序）；非仓库与 null 快照返回空。
  it('splits the status snapshot per source and sorts untracked last', () => {
    expect(sourceFileList('unstaged', statusFixture()).map(file => file.path))
      .toEqual(['README.md', 'src/web/GitPane.tsx', 'docs/plan.md'])
    expect(sourceFileList('staged', statusFixture()).map(file => file.path)).toEqual(['src/shared/types.ts'])
    // 分支行按字母排序，与服务端顺序无关。
    expect(sourceFileList('branch', statusFixture()).map(file => file.path)).toEqual(['a/first.ts', 'a/second.ts'])
    expect(sourceFileList('unstaged', statusFixture({ isRepository: false }))).toEqual([])
    expect(sourceFileList('unstaged', null)).toEqual([])
  })

  // last-turn 行按字母排序；diff 文本按类型：modified 前后文本、added 旧文本为空、deleted 新文本为空、renamed 返回 null（不渲染 diff）。
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

  // 空态优先级：有数据返回 null；last-turn 空数据用专属文案；非仓库用专属文案；来源下没有文件用通用文案。
  it('resolves the empty state with the last-turn copy first', () => {
    expect(paneEmptyState('unstaged', statusFixture(), undefined, 1)).toBeNull()
    expect(paneEmptyState('last-turn', statusFixture(), [], 0)).toBe('last-turn-empty')
    expect(paneEmptyState('unstaged', statusFixture({ isRepository: false }), undefined, 0)).toBe('not-repository')
    expect(paneEmptyState('unstaged', statusFixture({ files: [] }), undefined, 0)).toBe('generic')
    expect(paneEmptyState('branch', statusFixture({ branchFiles: [] }), undefined, 0)).toBe('generic')
  })

  // 来源选项里 last-turn 仅在没有任何 last-turn 数据集时禁用；有数据则可选。
  it('disables the last-turn option only when no dataset exists', () => {
    expect(sourceOptions(false).at(-1)).toEqual({ id: 'last-turn', disabled: true })
    expect(sourceOptions(true).at(-1)).toEqual({ id: 'last-turn', disabled: false })
  })
})

/**
 * GitPane 组件集成测试（jsdom + mock API）。
 *
 * 关键契约：
 * - 文件行点击才懒加载 diff，且同一文件重复点击命中缓存只请求一次；
 * - 展开的行保持唯一：点开新文件收起旧文件；请求失败把错误内联渲染到该行；
 * - branch 来源读上游文件列表；last-turn 来源完全用本地文本渲染，不发 diff 请求；
 * - 空数据与「非仓库」用不同空态文案区分；
 * - 来源 select 变化回调 onSelectSource，last-turn 无数据时禁用；
 * - 状态加载失败以提示形式内联展示；刷新后文件从列表消失时其展开行自动收起。
 */
describe('GitPane', () => {
  // 行列表先渲染（不发 diff 请求）；点文件行才请求一次 diff 并渲染；随后重复点击两次仍只有一次请求（缓存生效）。
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

  // 同一时间只展开一行：点新文件收起旧文件；失败请求把错误文案内联进该行；切换来源收起展开行并把后续请求指向新来源。
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

    // 切换来源会收起展开的行，并把新的请求指向新来源。
    rerender(<GitPane workspaceId="ws-1" activeSource="staged" onSelectSource={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-diff-body]')).toBeNull()
    fireEvent.click(row('src/shared/types.ts'))
    await waitFor(() => expect(apiMock.gitWorktreeDiff).toHaveBeenCalledWith('ws-1', 'src/shared/types.ts', 'staged'))
  })

  // branch 来源直接用快照里的 branchFiles（a/first.ts 等），点击行请求 source=branch 的 diff。
  it('renders the branch source from the upstream file list', async () => {
    renderPane({ activeSource: 'branch' })
    expect(await screen.findByTitle('a/first.ts')).toBeTruthy()
    fireEvent.click(row('a/first.ts'))
    await waitFor(() => expect(apiMock.gitWorktreeDiff).toHaveBeenCalledWith('ws-1', 'a/first.ts', 'branch'))
  })

  // last-turn 来源用传入的本地变更数据渲染 diff，全程不发起 gitWorktreeDiff 请求。
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

  // last-turn 数据为空时展示专属空态文案「上一轮没有文件更改」（状态请求本身仍会发出以取文件列表）。
  it('shows the dedicated last-turn empty state for an empty dataset', async () => {
    renderPane({ activeSource: 'last-turn', lastTurnChanges: [] })
    expect(await screen.findByText('上一轮没有文件更改')).toBeTruthy()
    expect(apiMock.gitWorktreeStatus).toHaveBeenCalled()
  })

  // branch 来源有文件（branchFiles 空、files 有）时用通用空态，不误报「非仓库」；isRepository=false 才展示非仓库文案。
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

  // select 变化触发 onSelectSource('branch')；有 last-turn 数据时该 option 可用并能选中 last-turn。
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

  // 状态接口本身失败时，错误文案以提示形式出现在面板内，而不是白屏。
  it('surfaces a failed status load as an inline alert', async () => {
    apiMock.gitWorktreeStatus.mockRejectedValue(new Error('git 超时'))
    renderPane()
    expect(await screen.findByText('git 超时')).toBeTruthy()
  })

  // 刷新后原文件不在新列表里时，其展开的 diff 行自动收起，避免留下悬空的展开行。
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
