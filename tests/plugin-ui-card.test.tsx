// @vitest-environment jsdom
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatMessage, ContentBlock } from '../src/shared/types.ts'
import type { PluginContextEntry, PluginUiPage } from '../src/shared/plugin-ui.ts'
import type { ToolItem } from '../src/web/render-model.ts'
import ToolCard from '../src/web/ToolCard.tsx'
import { PluginUiCard } from '../src/web/PluginUiCard.tsx'
import { PluginUiPane } from '../src/web/PluginUiPane.tsx'
import { PluginPageHostContext } from '../src/web/plugin-page-pool.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

const t = (zh: string) => zh

const descriptor = {
  pluginId: 'excalidraw@market',
  serverName: 'plugin_excalidraw_canvas',
  resourceUri: 'ui://canvas',
  title: 'Excalidraw',
}

const callName = 'mcp__plugin_excalidraw_canvas__create_view'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function toolItem(details: unknown, overrides: Partial<ChatMessage> = {}): ToolItem {
  const call: ContentBlock = { type: 'toolCall', id: 'call-1', name: callName, arguments: {} }
  const message: ChatMessage = {
    id: 'assistant-1',
    role: 'assistant',
    timestamp: 1,
    blocks: [call],
  }
  const result: ChatMessage = {
    id: 'result-1',
    role: 'tool',
    timestamp: 2,
    toolCallId: 'call-1',
    toolName: callName,
    status: 'completed',
    blocks: [{ type: 'text', text: '画布已生成' }],
    details,
    ...overrides,
  }
  return { key: 'call-1', message, call, result, children: [], order: 0 }
}

function expandRow(): void {
  const toggle = screen.queryByRole('button', { name: '展开工具详情' })
  if (toggle !== null) fireEvent.click(toggle)
}

function pluginFrame(): HTMLIFrameElement | null {
  return document.querySelector('[data-plugin-ui-page]')
}

const noop = (): void => {}

/**
 * The app's pool contract in miniature: the side owner takes the card's host when the page opens
 * there, and the card takes it back when the side page closes.
 */
function PagePoolHarness({ page }: { page: PluginUiPage }) {
  const [sidePageIds, setSidePageIds] = useState<ReadonlySet<string>>(() => new Set())
  const [host, setHost] = useState<HTMLElement | undefined>(undefined)
  const sideOwner = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (host === undefined || !sidePageIds.has(page.id) || sideOwner.current === null) return
    sideOwner.current.appendChild(host)
  }, [host, page.id, sidePageIds])
  return (
    <PluginPageHostContext.Provider value={{
      sidePageIds,
      openSide: (opened, element) => {
        setHost(element)
        setSidePageIds(new Set([opened.id]))
      },
      hold: () => {},
    }}>
      <PluginUiCard page={page} onContext={noop} onMessage={noop} onOpenLink={noop} />
      <div data-testid="side-owner" ref={sideOwner} />
      <button type="button" onClick={() => { setSidePageIds(new Set()) }}>移回内联</button>
    </PluginPageHostContext.Provider>
  )
}

describe('tool card plugin UI branch', () => {
  it('renders the sandboxed plugin page inline instead of the generic details dump', () => {
    const onOpenPluginUi = vi.fn<(page: PluginUiPage) => void>()
    const { container } = render(
      <ToolCard item={toolItem({ ui: { ...descriptor, heightHint: 900, toolCallId: 'call-1' } })}
        runRunning={false} t={t} onOpenPluginUi={onOpenPluginUi} />,
    )
    expandRow()
    const frame = pluginFrame()
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame?.getAttribute('src')).toContain('/api/plugins/ui/page?')
    expect(frame?.getAttribute('src')).toContain('pluginId=excalidraw%40market')
    expect(frame?.getAttribute('src')).toContain('serverName=plugin_excalidraw_canvas')
    expect(frame?.getAttribute('src')).toContain('uri=ui%3A%2F%2Fcanvas')
    expect(frame?.getAttribute('title')).toBe('Excalidraw')
    // heightHint is capped at 640.
    expect(frame?.parentElement?.getAttribute('style')).toContain('height: 640px')
    // The compact card replaces the generic details JSON and the tool output text.
    expect(screen.queryByText('工具详情')).toBeNull()
    expect(screen.queryByText('画布已生成')).toBeNull()
    expect(screen.getByRole('button', { name: '在右侧打开' })).toBeTruthy()
    expect(onOpenPluginUi).not.toHaveBeenCalled()
    expect(container.querySelector('[data-plugin-ui-card]')).not.toBeNull()
  })

  it('opens a fullscreen surface in the inspector exactly once', () => {
    const onOpenPluginUi = vi.fn<(page: PluginUiPage) => void>()
    const item = toolItem({ ui: { ...descriptor, preferredDisplayMode: 'fullscreen', toolCallId: 'call-1' } })
    const view = render(<ToolCard item={item} runRunning={false} t={t} onOpenPluginUi={onOpenPluginUi} />)
    expect(onOpenPluginUi).toHaveBeenCalledTimes(1)
    const page = onOpenPluginUi.mock.calls[0]![0]
    expect(page.pluginId).toBe('excalidraw@market')
    expect(page.serverName).toBe('plugin_excalidraw_canvas')
    expect(page.resourceUri).toBe('ui://canvas')
    expect(page.toolCallId).toBe('call-1')
    // A fullscreen surface is not inlined.
    expandRow()
    expect(pluginFrame()).toBeNull()

    view.rerender(<ToolCard item={item} runRunning={false} t={t} onOpenPluginUi={onOpenPluginUi} />)
    expect(onOpenPluginUi).toHaveBeenCalledTimes(1)
  })

  it('keeps the generic output when showInline is false', () => {
    render(<ToolCard item={toolItem({ ui: { ...descriptor, showInline: false } })} runRunning={false} t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
    expect(screen.getByText('画布已生成')).toBeTruthy()
    expect(screen.getByText(/工具详情/u)).toBeTruthy()
  })

  it('falls back to the generic row when the tool failed', () => {
    render(<ToolCard item={toolItem({ ui: descriptor }, { isError: true, status: 'error' })} runRunning={false} t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
    expect(screen.getByText('工具执行失败')).toBeTruthy()
    expect(screen.getByText(/工具详情/u)).toBeTruthy()
  })

  it('ignores a malformed details.ui descriptor', () => {
    render(<ToolCard item={toolItem({ ui: { pluginId: 'excalidraw@market' } })} runRunning={false} t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
    expect(screen.getByText(/工具详情/u)).toBeTruthy()
  })

  it('does not render a page while the tool is still running', () => {
    render(<ToolCard item={toolItem({ ui: descriptor }, { streaming: true, status: 'running' })}
      runRunning t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
  })
})

describe('plugin UI card', () => {
  const page: PluginUiPage = { ...descriptor, id: 'excalidraw@market:call-1', heightHint: 200 }

  it('renders the compact page at its hint height and opens the side pane', () => {
    const onOpenSidePane = vi.fn<(page: PluginUiPage) => void>()
    const onContext = vi.fn<(entry: PluginContextEntry) => void>()
    render(<PluginUiCard page={page} onOpenSidePane={onOpenSidePane}
      onContext={onContext} onMessage={noop} onOpenLink={noop} />)
    const frame = pluginFrame()
    expect(frame).not.toBeNull()
    expect(frame?.parentElement?.getAttribute('style')).toContain('height: 200px')
    expect(frame?.parentElement?.getAttribute('style')).not.toContain('display: none')
    fireEvent.click(screen.getByRole('button', { name: '在右侧打开' }))
    expect(onOpenSidePane).toHaveBeenCalledWith(page)
  })

  it('defaults to 320px and disables the side-pane action without a handler', () => {
    render(<PluginUiCard page={{ ...page, heightHint: undefined }} onContext={noop} onMessage={noop} onOpenLink={noop} />)
    expect(pluginFrame()?.parentElement?.getAttribute('style')).toContain('height: 320px')
    expect(screen.getByRole('button', { name: '在右侧打开' })).toHaveProperty('disabled', true)
  })

  it('keeps the same iframe when the page moves into the side pane and back', () => {
    const pooled: PluginUiPage = { ...page, id: 'excalidraw@market:call-pool' }
    render(<PagePoolHarness page={pooled} />)
    const inline = pluginFrame()
    expect(inline).not.toBeNull()
    expect(inline?.closest('[data-plugin-ui-card]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '在右侧打开' }))
    // The card keeps the portal mounted; only the host's parent changes.
    expect(pluginFrame()).toBe(inline)
    expect(inline?.isConnected).toBe(true)
    expect(inline?.closest('[data-plugin-ui-card]')).toBeNull()
    expect(inline?.closest('[data-testid="side-owner"]')).not.toBeNull()
    expect(document.querySelector('[data-plugin-ui-side-placeholder]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '移回内联' }))
    expect(pluginFrame()).toBe(inline)
    expect(inline?.isConnected).toBe(true)
    expect(inline?.closest('[data-plugin-ui-card]')).not.toBeNull()
    expect(document.querySelector('[data-plugin-ui-side-placeholder]')).toBeNull()
  })

  it('keeps an inactive pane mounted but hidden with CSS', () => {
    const { container } = render(<PluginUiPane page={{ ...page, id: 'excalidraw@market:call-2' }} hidden
      onContext={noop} onMessage={noop} onOpenLink={noop} />)
    const frame = container.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect((frame as HTMLIFrameElement).style.display).toBe('none')
    expect(frame?.getAttribute('data-hidden')).toBe('true')
    expect(frame?.getAttribute('src')).toContain('/api/plugins/ui/page?')
  })

  it('bridges messages from its own frame only and posts the response back', async () => {
    const onOpenLink = vi.fn()
    const { container } = render(<PluginUiPane page={{ ...page, id: 'excalidraw@market:call-3' }}
      onContext={noop} onMessage={noop} onOpenLink={onOpenLink} />)
    const frame = container.querySelector('iframe') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    window.dispatchEvent(new MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 5, method: 'ui/open-link', params: { url: 'https://example.com/docs' } },
      source: frame.contentWindow,
    }))
    await waitFor(() => expect(onOpenLink).toHaveBeenCalledWith('https://example.com/docs'))
    await waitFor(() => expect(post).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 5, result: {} }, '*'))

    onOpenLink.mockClear()
    window.dispatchEvent(new MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 6, method: 'ui/open-link', params: { url: 'https://evil.example' } },
      source: window,
    }))
    await Promise.resolve()
    expect(onOpenLink).not.toHaveBeenCalled()
  })
})
