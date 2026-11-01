// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PluginUiPage, PluginUiSurfaceView } from '../src/shared/plugin-ui.ts'
import type { InspectorTab } from '../src/web/inspector-tabs.ts'
import Inspector from '../src/web/Inspector.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Plain-text documents: their source view echoes the content verbatim, unlike Markdown.
function fileTab(id: string, title: string, path: string, content: string): InspectorTab {
  return { id, type: 'document', title, openedAt: 1, doc: { kind: 'file', file: { path, content, mimeType: 'text/plain' } } }
}

function newTab(): InspectorTab {
  return { id: 'new-tab', type: 'new-tab', title: '新标签页', openedAt: 1 }
}

const pages: PluginUiPage[] = [{
  id: 'conversation-1:alpha:call-1',
  pluginId: 'alpha',
  serverName: 'plugin_alpha_server',
  resourceUri: 'ui://alpha',
  title: 'Alpha Canvas',
  toolCallId: 'call-1',
}]

const surface: PluginUiSurfaceView = {
  id: 'alpha:canvas',
  pluginId: 'alpha',
  pluginName: 'Alpha Plugin',
  title: 'Alpha Canvas',
  serverName: 'plugin_alpha_server',
  resourceUri: 'ui://alpha',
}

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

function trigger(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector(`[data-inspector-tab-trigger="${id}"]`)
  expect(element).not.toBeNull()
  return element as HTMLElement
}

describe('inspector tab strip', () => {
  it('renders one tab per entry with the active one highlighted', () => {
    const { container } = render(<Inspector {...shellProps()} />)

    expect(screen.getByRole('button', { name: 'a.txt' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'b.txt' }).getAttribute('aria-pressed')).toBe('false')
    expect(trigger(container, 'doc-a').getAttribute('data-active')).toBe('true')
    expect(trigger(container, 'doc-b').getAttribute('data-active')).toBe('false')
    // Every close affordance is in the DOM; CSS keeps inactive ones behind hover/focus.
    expect(screen.getByRole('button', { name: '关闭标签 a.txt' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭标签 b.txt' })).toBeTruthy()
  })

  it('selects a tab on click and closes it on a middle click', () => {
    const props = shellProps()
    const { container } = render(<Inspector {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'b.txt' }))
    expect(props.onSelectTab).toHaveBeenCalledWith('doc-b')

    // fireEvent has no auxclick helper; a native MouseEvent reaches React's onAuxClick.
    fireEvent(trigger(container, 'doc-b'), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
    expect(props.onCloseTab).toHaveBeenCalledWith('doc-b')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes the active tab from the header close button', () => {
    const props = shellProps()
    render(<Inspector {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭标签' }))
    expect(props.onCloseTab).toHaveBeenCalledWith('doc-a')
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('collapses the pane from the header when no tab is active', () => {
    const props = shellProps({ tabs: [], activeTabId: null })
    render(<Inspector {...props} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭标签' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

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

describe('inspector shell chrome', () => {
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

  it('hides the full-view toggle without a handler', () => {
    render(<Inspector {...shellProps()} />)

    expect(screen.queryByRole('button', { name: '进入完整视图' })).toBeNull()
  })

  it('shows the shell chrome without tabs when the launcher is reachable', () => {
    render(<Inspector {...shellProps({ tabs: [] })} />)

    expect(screen.getByRole('button', { name: '新增标签' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '关闭标签 a.txt' })).toBeNull()
  })
})

describe('new-tab launcher', () => {
  it('lists the five entries and the recommended plugin apps', () => {
    const { container } = render(<Inspector {...shellProps({ tabs: [newTab()], launcher: launcherProps() })} />)

    // The launcher heading shares its text with the new-tab trigger; scope to the heading element.
    expect(container.querySelector('h2')?.textContent).toBe('新标签页')
    for (const id of ['files', 'browser', 'review', 'trajectory', 'selection-chat']) {
      expect(container.querySelector(`[data-launcher-entry="${id}"]`)).not.toBeNull()
    }
    expect(screen.getByText('从目录中选择一个文件')).toBeTruthy()
    expect(container.querySelector('[data-launcher-surface="alpha:canvas"]')).not.toBeNull()
  })

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

  it('opens files and plugin surfaces from the launcher', () => {
    const launcher = launcherProps()
    const { container } = render(<Inspector {...shellProps({ tabs: [newTab()], launcher })} />)

    fireEvent.click(container.querySelector('[data-launcher-entry="files"]') as HTMLElement)
    expect(launcher.onOpenFiles).toHaveBeenCalledTimes(1)

    fireEvent.click(container.querySelector('[data-launcher-surface="alpha:canvas"]') as HTMLElement)
    expect(launcher.onOpenSurface).toHaveBeenCalledWith(surface)
  })
})

describe('inspector shell content', () => {
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

  it('renders an empty state for a git tab without git state', () => {
    const { container } = render(<Inspector {...shellProps({
      tabs: [{ id: 'git', type: 'git', title: '审查', openedAt: 3 }],
      activeTabId: 'git',
    })} />)

    const gitSurface = container.querySelector('[data-inspector-tab="git"]') as HTMLElement
    expect(gitSurface.textContent).toContain('没有可审查的代码变更')
  })
})

describe('inspector legacy fallback', () => {
  it('keeps the single-slot rendering when no tabs and no launcher are provided', () => {
    const { container } = render(<Inspector file={{ path: 'notes.md', content: '# Notes' }} onClose={vi.fn()} />)

    expect(screen.getByText('notes.md')).toBeTruthy()
    expect(container.querySelector('[data-inspector-shell]')).toBeNull()
    expect(container.querySelector('[data-inspector-tab]')).toBeNull()
    expect(screen.queryByRole('button', { name: '新增标签' })).toBeNull()
  })
})
