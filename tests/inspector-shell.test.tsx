// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PluginUiPage, PluginUiSurfaceView } from '../src/shared/plugin-ui.ts'
import type { InspectorTab } from '../src/web/inspector-tabs.ts'
import Inspector from '../src/web/Inspector.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** 每个用例前：搭建渲染 DOM 环境。 */
beforeEach(setupRenderingDom)
/** 每个用例后：卸载组件、恢复 mock、移除全局 stub。 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/**
 * 构造一个纯文本文档标签：源码视图按原样回显内容（区别于 Markdown 渲染）。
 * @param id 标签 id
 * @param title 标签标题
 * @param path 文件路径
 * @param content 文件内容
 * @returns document 类型的 InspectorTab
 */
function fileTab(id: string, title: string, path: string, content: string): InspectorTab {
  return { id, type: 'document', title, openedAt: 1, doc: { kind: 'file', file: { path, content, mimeType: 'text/plain' } } }
}

/** 构造一个「新标签页」启动页标签。 */
function newTab(): InspectorTab {
  return { id: 'new-tab', type: 'new-tab', title: '新标签页', openedAt: 1 }
}

/** 插件 UI 页面夹具：一个来自 alpha 插件的 Canvas 页面。 */
const pages: PluginUiPage[] = [{
  id: 'conversation-1:alpha:call-1',
  pluginId: 'alpha',
  serverName: 'plugin_alpha_server',
  resourceUri: 'ui://alpha',
  title: 'Alpha Canvas',
  toolCallId: 'call-1',
}]

/** 插件应用表面夹具：启动页推荐列表里的一项。 */
const surface: PluginUiSurfaceView = {
  id: 'alpha:canvas',
  pluginId: 'alpha',
  pluginName: 'Alpha Plugin',
  title: 'Alpha Canvas',
  serverName: 'plugin_alpha_server',
  resourceUri: 'ui://alpha',
}

/**
 * 构造启动页属性：带一个推荐表面、全部入口可用（review/trajectory/selection-chat）。
 * @param overrides 需要覆盖的启动页字段（canOpenReview/surfaces 等）
 * @returns 完整的 launcher 属性对象
 */
function launcherProps(overrides: Partial<ComponentProps<typeof Inspector>['launcher']> = {}): NonNullable<ComponentProps<typeof Inspector>['launcher']> {
  return {
    surfaces: [surface],
    surfacesLoading: false,
    onRefreshSurfaces: vi.fn(),
    onOpenSurface: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenReview: vi.fn(),
    onOpenBrowser: vi.fn(),
    onOpenTrajectory: vi.fn(),
    onOpenSelectionChat: vi.fn(),
    canOpenReview: true,
    canOpenTrajectory: true,
    canOpenSelectionChat: true,
    ...overrides,
  }
}

/**
 * 构造 Inspector 外壳属性：两个文档标签（doc-a 激活）、各回调均为 vi.fn。
 * @param overrides 需要覆盖的字段（tabs/activeTabId/launcher 等）
 * @returns 完整的组件属性
 */
function shellProps(overrides: Partial<ComponentProps<typeof Inspector>> = {}): ComponentProps<typeof Inspector> {
  return {
    onClose: vi.fn(),
    tabs: [
      fileTab('doc-a', 'a.txt', 'docs/a.txt', 'alpha line'),
      fileTab('doc-b', 'b.txt', 'docs/b.txt', 'bravo line'),
    ],
    activeTabId: 'doc-a',
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseOtherTabs: vi.fn(),
    onCloseAllTabs: vi.fn(),
    onOpenNewTab: vi.fn(),
    ...overrides,
  }
}

/**
 * 按标签 id 查找标签触发器元素（data-inspector-tab-trigger 属性）。
 * @param container 渲染容器
 * @param id 标签 id
 * @returns 触发器元素；找不到时断言失败
 */
function trigger(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector(`[data-inspector-tab-trigger="${id}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

/**
 * 检查器标签条（tab strip）测试。
 *
 * 关键契约：
 * - 每个标签渲染一个触发按钮，激活项带 aria-pressed/data-active 标记；所有关闭按钮都在 DOM 中（CSS 控制悬停显隐）；
 * - 点击选标签（onSelectTab）、中键 auxclick 关闭标签（onCloseTab，不触发面板关闭）；
 * - 头部「关闭标签」按钮关激活标签；无激活标签时同一按钮折叠整个面板（onClose）；
 * - 右键菜单含关闭标签/关闭其他/关闭全部，单个标签时「关闭其他」禁用；点菜单项后菜单消失。
 */
describe('inspector tab strip', () => {
  // 每个标签一个按钮；激活项 aria-pressed=true、data-active=true；两个标签各自的关闭按钮都存在于 DOM。
  it('renders one tab per entry with the active one highlighted', () => {
    const { container } = render(<Inspector {...shellProps()} />)

    expect(screen.getByRole('button', { name: 'a.txt' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'b.txt' }).getAttribute('aria-pressed')).toBe('false')
    expect(trigger(container, 'doc-a').getAttribute('data-active')).toBe('true')
    expect(trigger(container, 'doc-b').getAttribute('data-active')).toBe('false')
    // 所有关闭入口都在 DOM 里；非激活项由 CSS 藏到 hover/focus 之后。
    expect(screen.getByRole('button', { name: '关闭标签 a.txt' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭标签 b.txt' })).toBeTruthy()
  })

  // 左键点击触发 onSelectTab('doc-b')；中键（auxclick，button=1）触发 onCloseTab('doc-b') 且不折叠面板。
  it('selects a tab on click and closes it on a middle click', () => {
    const props = shellProps()
    const { container } = render(<Inspector {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'b.txt' }))
    expect(props.onSelectTab).toHaveBeenCalledWith('doc-b')

    // fireEvent 没有 auxclick 辅助方法；用原生 MouseEvent 到达 React 的 onAuxClick。
    fireEvent(trigger(container, 'doc-b'), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
    expect(props.onCloseTab).toHaveBeenCalledWith('doc-b')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  // 头部「关闭标签」按钮关闭当前激活标签 doc-a，不折叠面板。
  it('closes the active tab from the header close button', () => {
    const props = shellProps()
    render(<Inspector {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭标签' }))
    expect(props.onCloseTab).toHaveBeenCalledWith('doc-a')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  // 没有激活标签时，同一「关闭标签」按钮的语义变为折叠面板（onClose）。
  it('collapses the pane from the header when no tab is active', () => {
    const props = shellProps({ tabs: [], activeTabId: null })
    render(<Inspector {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭标签' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  // 右键菜单三项齐全；只有一个标签时「关闭其他标签」禁用；点「关闭所有标签」触发回调且菜单关闭。
  it('opens the context menu, disables close-others for a single tab, and closes all', () => {
    const props = shellProps({ tabs: [fileTab('doc-a', 'a.txt', 'docs/a.txt', 'alpha line')] })
    const { container } = render(<Inspector {...props} />)

    fireEvent.contextMenu(trigger(container, 'doc-a'))
    expect(screen.getByRole('menuitem', { name: '关闭标签' })).toBeTruthy()
    expect((screen.getByRole('menuitem', { name: '关闭其他标签' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('menuitem', { name: '关闭所有标签' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: '关闭所有标签' }))
    expect(props.onCloseAllTabs).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menuitem', { name: '关闭所有标签' })).toBeNull()
  })

  // 多个标签时右键菜单的「关闭其他标签」可用，点击后以右键的标签 id 调用 onCloseOtherTabs。
  it('closes other tabs from the context menu when several tabs are open', () => {
    const props = shellProps()
    const { container } = render(<Inspector {...props} />)

    fireEvent.contextMenu(trigger(container, 'doc-a'))
    const closeOthers = screen.getByRole('menuitem', { name: '关闭其他标签' }) as HTMLButtonElement
    expect(closeOthers.disabled).toBe(false)
    fireEvent.click(closeOthers)
    expect(props.onCloseOtherTabs).toHaveBeenCalledWith('doc-a')
  })
})

/**
 * 检查器外壳 chrome（头部控件）测试。
 *
 * 关键契约：
 * - 「+」新增标签触发 onOpenNewTab；完整视图切换按钮用 aria-pressed 表达状态且文案随状态变化；
 * - 未提供 onToggleFullView 时不渲染切换按钮；
 * - 启动页可达时即使没有标签也显示外壳 chrome（新增按钮存在、无标签关闭按钮）。
 */
describe('inspector shell chrome', () => {
  // 「+」触发新增标签；完整视图按钮初始 aria-pressed=false，点击触发 onToggleFullView，rerender 为 fullView 后按钮文案与 pressed 状态翻转。
  it('opens a new tab from `+` and toggles full view with aria-pressed', () => {
    const props = shellProps({ onToggleFullView: vi.fn() })
    const { rerender } = render(<Inspector {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '新增标签' }))
    expect(props.onOpenNewTab).toHaveBeenCalledTimes(1)

    const full = screen.getByRole('button', { name: '进入完整视图' })
    expect(full.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(full)
    expect(props.onToggleFullView).toHaveBeenCalledTimes(1)

    rerender(<Inspector {...props} fullView />)
    expect(screen.getByRole('button', { name: '退出完整视图' }).getAttribute('aria-pressed')).toBe('true')
  })

  // 未传 onToggleFullView 时完整视图切换按钮不渲染（能力探测）。
  it('hides the full-view toggle without a handler', () => {
    render(<Inspector {...shellProps()} />)

    expect(screen.queryByRole('button', { name: '进入完整视图' })).toBeNull()
  })

  // 标签列表为空但启动页可达：新增标签按钮仍显示，且不出现针对标签的关闭按钮。
  it('shows the shell chrome without tabs when the launcher is reachable', () => {
    render(<Inspector {...shellProps({ tabs: [] })} />)

    expect(screen.getByRole('button', { name: '新增标签' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '关闭标签 a.txt' })).toBeNull()
  })
})

/**
 * 新标签页启动页测试。
 *
 * 关键契约：
 * - 启动页列出五个固定入口（files/browser/review/trajectory/selection-chat）与推荐插件应用；
 * - 无权限的入口（canOpenReview 等 false）隐藏，空应用列表给专门文案；
 * - 点击入口/应用卡触发对应回调（onOpenFiles、onOpenSurface(surface)）。
 */
describe('new-tab launcher', () => {
  // 标题是 h2（与触发按钮同名，需限定元素范围）；五个入口节点齐全；文件入口文案与推荐应用 alpha:canvas 都出现。
  it('lists the five entries and the recommended plugin apps', () => {
    const { container } = render(<Inspector {...shellProps({ tabs: [newTab()], launcher: launcherProps() })} />)

    // 启动页标题与新标签触发按钮共用同一文本；限定到标题元素。
    expect(container.querySelector('h2')?.textContent).toBe('新标签页')
    for (const id of ['files', 'browser', 'review', 'trajectory', 'selection-chat']) {
      expect(container.querySelector(`[data-launcher-entry="${id}"]`)).not.toBeNull()
    }
    expect(screen.getByText('从目录中选择一个文件')).toBeTruthy()
    expect(container.querySelector('[data-launcher-surface="alpha:canvas"]')).not.toBeNull()
  })

  // 无权限入口（review/trajectory/selection-chat）不渲染，files/browser 保留；无推荐表面时显示空列表文案。
  it('hides gated entries and shows the empty app list', () => {
    const { container } = render(<Inspector {...shellProps({
      tabs: [newTab()],
      launcher: launcherProps({ canOpenReview: false, canOpenTrajectory: false, canOpenSelectionChat: false, surfaces: [] }),
    })} />)

    expect(container.querySelector('[data-launcher-entry="files"]')).not.toBeNull()
    expect(container.querySelector('[data-launcher-entry="browser"]')).not.toBeNull()
    expect(container.querySelector('[data-launcher-entry="review"]')).toBeNull()
    expect(container.querySelector('[data-launcher-entry="trajectory"]')).toBeNull()
    expect(container.querySelector('[data-launcher-entry="selection-chat"]')).toBeNull()
    expect(screen.getByText('暂无推荐的应用插件')).toBeTruthy()
  })

  // 点击文件入口触发 onOpenFiles；点击插件应用卡触发 onOpenSurface 且传入完整的 surface 对象。
  it('opens files and plugin surfaces from the launcher', () => {
    const launcher = launcherProps()
    const { container } = render(<Inspector {...shellProps({ tabs: [newTab()], launcher })} />)

    fireEvent.click(container.querySelector('[data-launcher-entry="files"]') as HTMLElement)
    expect(launcher.onOpenFiles).toHaveBeenCalledTimes(1)

    fireEvent.click(container.querySelector('[data-launcher-surface="alpha:canvas"]') as HTMLElement)
    expect(launcher.onOpenSurface).toHaveBeenCalledWith(surface)
  })
})

/**
 * 检查器内容分发测试。
 *
 * 关键契约：
 * - 所有标签保持挂载，非激活的只靠 hidden 属性隐藏（切换标签不重挂载、内容不丢）；
 * - plugin 与 browse 标签分发到既有渲染器（插件页有 data-plugin-ui-page 节点）；
 * - git 标签没有 git 状态数据时渲染专门空态文案。
 */
describe('inspector shell content', () => {
  // 两个标签都挂载：非激活的带 hidden 但内容仍在 DOM；切激活后 hidden 状态互换、内容不变（不重挂载）。
  it('keeps every tab mounted and only hides the inactive ones', () => {
    const props = shellProps()
    const { container, rerender } = render(<Inspector {...props} />)

    const active = container.querySelector('[data-inspector-tab="doc-a"]') as HTMLElement
    const inactive = container.querySelector('[data-inspector-tab="doc-b"]') as HTMLElement
    expect(active.hasAttribute('hidden')).toBe(false)
    expect(inactive.hasAttribute('hidden')).toBe(true)
    expect(inactive.textContent).toContain('bravo line')

    rerender(<Inspector {...props} activeTabId="doc-b" />)
    expect((container.querySelector('[data-inspector-tab="doc-a"]') as HTMLElement).hasAttribute('hidden')).toBe(true)
    expect((container.querySelector('[data-inspector-tab="doc-a"]') as HTMLElement).textContent).toContain('alpha line')
    expect((container.querySelector('[data-inspector-tab="doc-b"]') as HTMLElement).hasAttribute('hidden')).toBe(false)
  })

  // plugin 标签由插件 UI 渲染器接管（data-plugin-ui-page 节点存在）；browse 标签节点存在且按非激活隐藏。
  it('dispatches plugin and browse tabs to their existing renderers', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    const { container } = render(<Inspector {...shellProps({
      tabs: [
        { id: pages[0]!.id, type: 'plugin', title: 'Alpha Canvas', openedAt: 1, pageId: pages[0]!.id },
        { id: 'browse', type: 'browse', title: 'demo', openedAt: 2, workspaceId: 'ws-1' },
      ],
      activeTabId: pages[0]!.id,
      pluginPages: pages,
      browse: {
        workspace: { id: 'ws-1', name: 'demo', path: '/tmp/demo', createdAt: 1, updatedAt: 1 },
        onOpenFile: vi.fn(),
      },
    })} />)

    expect(container.querySelector('[data-plugin-ui-page]')).not.toBeNull()
    const browseSurface = container.querySelector('[data-inspector-tab="browse"]') as HTMLElement
    expect(browseSurface).not.toBeNull()
    expect(browseSurface.hasAttribute('hidden')).toBe(true)
  })

  // git 标签没有任何 git 状态输入时渲染「没有可审查的代码变更」空态。
  it('renders an empty state for a git tab without git state', () => {
    const { container } = render(<Inspector {...shellProps({
      tabs: [{ id: 'git', type: 'git', title: '审查', openedAt: 3 }],
      activeTabId: 'git',
    })} />)

    const gitSurface = container.querySelector('[data-inspector-tab="git"]') as HTMLElement
    expect(gitSurface.textContent).toContain('没有可审查的代码变更')
  })
})

/**
 * 旧版单文件回退测试：只有 file 属性、无 tabs/launcher 时退回单槽渲染（无外壳结构）。
 */
describe('inspector legacy fallback', () => {
  // 只传 file 时显示文件名，但不渲染外壳（data-inspector-shell）、标签容器与新增按钮。
  it('keeps the single-slot rendering when no tabs and no launcher are provided', () => {
    const { container } = render(<Inspector file={{ path: 'notes.md', content: '# Notes' }} onClose={vi.fn()} />)

    expect(screen.getByText('notes.md')).toBeTruthy()
    expect(container.querySelector('[data-inspector-shell]')).toBeNull()
    expect(container.querySelector('[data-inspector-tab]')).toBeNull()
    expect(screen.queryByRole('button', { name: '新增标签' })).toBeNull()
  })
})
