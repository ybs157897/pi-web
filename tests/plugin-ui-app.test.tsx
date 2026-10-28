// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PluginContextEntry, PluginUiPage, PluginUiSurfaceView } from '../src/shared/plugin-ui.ts'
import { pluginContextBlock } from '../src/shared/plugin-ui.ts'
import Inspector from '../src/web/Inspector.tsx'
import Composer from '../src/web/Composer.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const pages: PluginUiPage[] = [
  {
    id: 'conversation-1:alpha:call-1',
    pluginId: 'alpha',
    serverName: 'plugin_alpha_server',
    resourceUri: 'ui://alpha',
    title: 'Alpha Canvas',
    toolCallId: 'call-1',
  },
  {
    id: 'conversation-1:beta:ui://beta',
    pluginId: 'beta',
    serverName: 'plugin_beta_server',
    resourceUri: 'ui://beta',
    title: 'Beta Panel',
  },
]

function inspectorProps(overrides: Partial<ComponentProps<typeof Inspector>> = {}): ComponentProps<typeof Inspector> {
  return {
    view: 'plugin',
    onView: vi.fn(),
    onClose: vi.fn(),
    pluginPages: pages,
    activePluginPageId: pages[0]!.id,
    ...overrides,
  }
}

describe('inspector plugin tabs', () => {
  it('renders one tab per page and mounts every pane, hiding the inactive ones', () => {
    const { container } = render(<Inspector {...inspectorProps()} />)
    expect(screen.getByRole('button', { name: 'Alpha Canvas' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Beta Panel' }).getAttribute('aria-pressed')).toBe('false')

    const frames = container.querySelectorAll('[data-plugin-ui-page]')
    expect(frames).toHaveLength(2)
    expect(frames[0]?.getAttribute('data-plugin-ui-page')).toBe(pages[0]!.id)
    expect(frames[0]?.getAttribute('data-hidden')).toBeNull()
    expect(frames[1]?.getAttribute('data-plugin-ui-page')).toBe(pages[1]!.id)
    expect(frames[1]?.getAttribute('data-hidden')).toBe('true')
    // The active page's own frame URL names the plugin surface.
    expect(frames[0]?.getAttribute('src')).toContain('pluginId=alpha')
    expect(frames[0]?.getAttribute('src')).toContain('uri=ui%3A%2F%2Falpha')
  })

  it('selects a page tab and reports the plugin view without unloading the others', () => {
    const onSelectPluginPage = vi.fn()
    const onView = vi.fn()
    const { container } = render(<Inspector {...inspectorProps({ onSelectPluginPage, onView })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Beta Panel' }))
    expect(onSelectPluginPage).toHaveBeenCalledWith(pages[1]!.id)
    expect(onView).toHaveBeenCalledWith('plugin')
    expect(container.querySelectorAll('[data-plugin-ui-page]')).toHaveLength(2)
  })

  it('keeps the panes mounted when another inspector view is active', () => {
    const props = inspectorProps()
    const view = render(<Inspector {...props} />)
    view.rerender(<Inspector {...props} view="file" />)
    const host = view.container.querySelector('[data-plugin-surfaces]')
    expect(host).not.toBeNull()
    expect(host?.hasAttribute('hidden')).toBe(true)
    expect(view.container.querySelectorAll('[data-plugin-ui-page]')).toHaveLength(2)
  })

  it('closes one page from its tab and the active page from the header', () => {
    const onClosePluginPage = vi.fn()
    const onClose = vi.fn()
    render(<Inspector {...inspectorProps({ onClosePluginPage, onClose })} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭插件页面 Beta Panel' }))
    expect(onClosePluginPage).toHaveBeenCalledWith(pages[1]!.id)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '关闭插件页面' }))
    expect(onClosePluginPage).toHaveBeenLastCalledWith(pages[0]!.id)
  })

  it('appends an inline card host and keeps its own pane only for pages without one', () => {
    const host = document.createElement('div')
    const marker = document.createElement('span')
    marker.textContent = 'pooled frame'
    host.appendChild(marker)
    const { container } = render(<Inspector {...inspectorProps({
      pluginPageHosts: { [pages[0]!.id]: host },
      sidePageIds: new Set([pages[0]!.id]),
    })} />)
    const slot = container.querySelector(`[data-plugin-host-slot="${pages[0]!.id}"]`)
    expect(slot).not.toBeNull()
    expect(slot?.contains(host)).toBe(true)
    expect(slot?.hasAttribute('hidden')).toBe(false)
    expect(host.contains(marker)).toBe(true)
    // A pooled page must not grow a second iframe next to the transcript's own.
    expect(container.querySelector(`[data-plugin-ui-page="${pages[0]!.id}"]`)).toBeNull()
    // The page without a host (opened from the + menu) still renders its own pane.
    expect(container.querySelector(`[data-plugin-ui-page="${pages[1]!.id}"]`)).not.toBeNull()
  })

  it('hides a pooled host with its inactive tab and leaves it mounted', () => {
    const host = document.createElement('div')
    const { container } = render(<Inspector {...inspectorProps({
      activePluginPageId: pages[1]!.id,
      pluginPageHosts: { [pages[0]!.id]: host },
      sidePageIds: new Set([pages[0]!.id]),
    })} />)
    const slot = container.querySelector(`[data-plugin-host-slot="${pages[0]!.id}"]`)
    expect(slot?.hasAttribute('hidden')).toBe(true)
    expect(slot?.contains(host)).toBe(true)
  })

  it('refreshes and lists surfaces from the + menu, then opens the chosen one', async () => {
    const surface: PluginUiSurfaceView = {
      id: 'alpha:canvas',
      pluginId: 'alpha',
      pluginName: 'Alpha Plugin',
      title: 'Alpha Canvas',
      serverName: 'plugin_alpha_server',
      resourceUri: 'ui://alpha',
    }
    const onRefreshPluginSurfaces = vi.fn(async () => {})
    const onOpenPluginSurface = vi.fn()
    const { container } = render(<Inspector {...inspectorProps({
      pluginSurfaces: [surface], onRefreshPluginSurfaces, onOpenPluginSurface,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '打开插件页面' }))
    expect(onRefreshPluginSurfaces).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(container.querySelector('[data-plugin-surface="alpha:canvas"]')).not.toBeNull())
    fireEvent.click(container.querySelector('[data-plugin-surface="alpha:canvas"]') as HTMLElement)
    expect(onOpenPluginSurface).toHaveBeenCalledWith(surface)
  })

  it('points at settings when no plugin surface is enabled', async () => {
    render(<Inspector {...inspectorProps({
      pluginSurfaces: [], onRefreshPluginSurfaces: vi.fn(async () => {}), onOpenPluginSurface: vi.fn(),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '打开插件页面' }))
    expect(await screen.findByText('去设置里安装插件')).toBeTruthy()
  })
})

describe('composer plugin context chips', () => {
  function composerProps(overrides: Partial<ComponentProps<typeof Composer>> = {}): ComponentProps<typeof Composer> {
    return {
      value: '', images: [], catalog: null, thinkingLevel: 'off', busy: false, queue: [],
      sendMode: 'followUp', sending: false,
      onChange: vi.fn(), onAddImages: vi.fn(), onRemoveImage: vi.fn(), onSend: vi.fn(),
      onStop: vi.fn(), onRemoveQueue: vi.fn(), onSelectModel: vi.fn(), onThinkingLevel: vi.fn(), onSendMode: vi.fn(),
      ...overrides,
    }
  }

  it('renders a chip per entry with a truncated preview and removes by the app key', () => {
    const onRemovePluginContext = vi.fn()
    const longText = `选中的图形 ${'x'.repeat(120)}`
    const entries: PluginContextEntry[] = [
      { pluginId: 'alpha', toolCallId: 'call-1', text: '画布内容' },
      { pluginId: 'beta', text: longText },
    ]
    const { container } = render(<Composer {...composerProps({ pluginContexts: entries, onRemovePluginContext })} />)

    expect(screen.getByRole('group', { name: '插件上下文' })).toBeTruthy()
    expect(container.querySelector('[data-plugin-context="alpha:call-1"]')?.textContent).toContain('画布内容')
    const preview = container.querySelector('[data-plugin-context="beta:"] span:nth-child(2)')
    expect(preview?.textContent?.endsWith('…')).toBe(true)
    expect(preview?.getAttribute('title')).toBe(longText)

    fireEvent.click(screen.getByRole('button', { name: '移除插件上下文 alpha' }))
    expect(onRemovePluginContext).toHaveBeenCalledWith('alpha:call-1')
  })

  it('renders nothing above the input without context entries', () => {
    render(<Composer {...composerProps()} />)
    expect(screen.queryByRole('group', { name: '插件上下文' })).toBeNull()
  })
})

describe('plugin context block', () => {
  it('appends a # Plugin context block joined to the operator text with a blank line', () => {
    const entries: PluginContextEntry[] = [
      {
        pluginId: 'excalidraw@my-market',
        toolCallId: 'call_123',
        text: 'selected rectangle',
        structuredContent: { shape: 'rect' },
      },
      { pluginId: 'canvas', text: 'no call id' },
    ]
    const block = pluginContextBlock(entries)
    expect(block).toBe([
      '# Plugin context:',
      '',
      '## Plugin excalidraw@my-market (call_123)',
      '',
      'selected rectangle',
      '',
      '```json',
      '{',
      '  "shape": "rect"',
      '}',
      '```',
      '',
      '## Plugin canvas',
      '',
      'no call id',
    ].join('\n'))
    expect(`${'帮我修这个'}\n\n${block}`.startsWith('帮我修这个\n\n# Plugin context:')).toBe(true)
    expect(pluginContextBlock([])).toBe('')
  })
})
