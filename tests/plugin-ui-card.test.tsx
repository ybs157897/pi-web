// @vitest-environment jsdom
/**
 * 插件 UI 卡片渲染与页面池（host 移动）测试。
 *
 * 覆盖 ToolCard 的插件 UI 分支与 PluginUiCard/PluginUiPane 组件：
 * - 工具结果带合法 ui 描述时渲染沙箱 iframe（sandbox=allow-scripts、no-referrer、
 *   src 携带 pluginId/serverName/uri 参数），heightHint 上限 640，紧凑卡替代通用工具详情；
 * - fullscreen 模式走 inspector 打开（恰好一次）、showInline=false / 工具失败 / 描述畸形 /
 *   工具仍在运行时回退通用行；
 * - PluginUiCard 按高度提示渲染（缺省 320px）、无 onOpenSidePane 时按钮禁用；
 * - 页面池契约：卡片到侧栏往返移动时保持同一个 iframe（只换宿主父节点，页面状态不丢失）；
 * - 非激活窗格保持挂载仅 CSS 隐藏；消息桥只响应来自自己 iframe 的消息并把响应 post 回去。
 */
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

/** 文案函数直通：zh 文本原样返回。 */
const t = (zh: string) => zh

/** 插件 UI 描述 fixture（excalidraw 画布）。 */
const descriptor = {
  pluginId: 'excalidraw@market',
  serverName: 'plugin_excalidraw_canvas',
  resourceUri: 'ui://canvas',
  title: 'Excalidraw',
}

/** 插件 MCP 工具调用名。 */
const callName = 'mcp__plugin_excalidraw_canvas__create_view'

/** 每个用例前补齐 jsdom 缺失 API；结束后清理 mock 与全局 stub。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/**
 * 构造含一个插件 MCP 工具调用及其结果的 ToolItem。
 * @param details 工具结果的 details（通常含 ui 描述）
 * @param overrides 覆盖结果消息的字段（isError/status/streaming 等）
 * @returns ToolItem 渲染模型条目
 */
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

/** 展开当前工具行的详情（若存在折叠开关则点击）。 */
function expandRow(): void {
  const toggle = screen.queryByRole('button', { name: '展开工具详情' })
  if (toggle !== null) fireEvent.click(toggle)
}

/** 查询文档中的插件 UI iframe（data-plugin-ui-page 标记）。 */
function pluginFrame(): HTMLIFrameElement | null {
  return document.querySelector('[data-plugin-ui-page]')
}

/** 空回调，供不需要断言的桥回调占位。 */
const noop = (): void => {}

/**
 * 应用页面池契约的微缩版：openSide 时侧栏容器接管卡片的宿主元素，
 * 关闭侧页（"移回内联"）时卡片重新接管宿主，验证 iframe 在往返中保持同一节点。
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

/** ToolCard 的插件 UI 分支（何时内联渲染 iframe、何时回退通用行）。 */
describe('tool card plugin UI branch', () => {
  // 验证内联渲染：iframe 沙箱属性（allow-scripts/no-referrer）、src 携带页面参数（URL 编码）、
  // title 为插件标题；heightHint 900 被钳到 640；通用"工具详情"JSON 与输出文本被紧凑卡替代；
  // 出现"在右侧打开"按钮且未自动触发 onOpenPluginUi。
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

  // 验证 fullscreen 模式：首次渲染即调用 onOpenPluginUi（在 inspector 打开）且只调用一次
  // （rerender 不重复触发），携带完整页面描述；行内不渲染 iframe。
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
    // fullscreen 页面不内联渲染。
    expandRow()
    expect(pluginFrame()).toBeNull()

    view.rerender(<ToolCard item={item} runRunning={false} t={t} onOpenPluginUi={onOpenPluginUi} />)
    expect(onOpenPluginUi).toHaveBeenCalledTimes(1)
  })

  // 验证 showInline=false 时不内联 iframe，保留通用输出文本与"工具详情"。
  it('keeps the generic output when showInline is false', () => {
    render(<ToolCard item={toolItem({ ui: { ...descriptor, showInline: false } })} runRunning={false} t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
    expect(screen.getByText('画布已生成')).toBeTruthy()
    expect(screen.getByText(/工具详情/u)).toBeTruthy()
  })

  // 验证失败回退：工具执行失败（isError）时不渲染插件页面，展示"工具执行失败"与通用详情。
  it('falls back to the generic row when the tool failed', () => {
    render(<ToolCard item={toolItem({ ui: descriptor }, { isError: true, status: 'error' })} runRunning={false} t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
    expect(screen.getByText('工具执行失败')).toBeTruthy()
    expect(screen.getByText(/工具详情/u)).toBeTruthy()
  })

  // 验证畸形描述兜底：details.ui 缺必填字段时按无 UI 处理，回退通用工具详情行。
  it('ignores a malformed details.ui descriptor', () => {
    render(<ToolCard item={toolItem({ ui: { pluginId: 'excalidraw@market' } })} runRunning={false} t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
    expect(screen.getByText(/工具详情/u)).toBeTruthy()
  })

  // 验证运行中抑制：工具结果还在 streaming 时即使描述合法也不渲染 iframe（页面等完成后再出现）。
  it('does not render a page while the tool is still running', () => {
    render(<ToolCard item={toolItem({ ui: descriptor }, { streaming: true, status: 'running' })}
      runRunning t={t} />)
    expandRow()
    expect(pluginFrame()).toBeNull()
  })
})

/** PluginUiCard 与 PluginUiPane 的尺寸、页面池与消息桥测试。 */
describe('plugin UI card', () => {
  /** 卡片测试共用的页面描述（heightHint=200）。 */
  const page: PluginUiPage = { ...descriptor, id: 'excalidraw@market:call-1', heightHint: 200 }

  // 验证紧凑卡按 heightHint 渲染高度、容器可见（无 display:none）、
  // 点击"在右侧打开"以完整页面对象触发 onOpenSidePane。
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

  // 验证缺省值：无 heightHint 时高度回退 320px；未提供 onOpenSidePane 时"在右侧打开"按钮禁用。
  it('defaults to 320px and disables the side-pane action without a handler', () => {
    render(<PluginUiCard page={{ ...page, heightHint: undefined }} onContext={noop} onMessage={noop} onOpenLink={noop} />)
    expect(pluginFrame()?.parentElement?.getAttribute('style')).toContain('height: 320px')
    expect(screen.getByRole('button', { name: '在右侧打开' })).toHaveProperty('disabled', true)
  })

  // 验证页面池契约（iframe 状态保持）：打开侧栏时同一个 iframe DOM 节点被移入侧栏容器
  // （卡片处留占位符），移回内联时同一节点回到卡片内——iframe 不重建，页面状态不丢失。
  it('keeps the same iframe when the page moves into the side pane and back', () => {
    const pooled: PluginUiPage = { ...page, id: 'excalidraw@market:call-pool' }
    render(<PagePoolHarness page={pooled} />)
    const inline = pluginFrame()
    expect(inline).not.toBeNull()
    expect(inline?.closest('[data-plugin-ui-card]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '在右侧打开' }))
    // 卡片保持 portal 挂载，只改变宿主的父节点。
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

  // 验证非激活窗格：hidden 时 iframe 仍挂载（保状态）仅 display:none + data-hidden 标记，src 保持加载。
  it('keeps an inactive pane mounted but hidden with CSS', () => {
    const { container } = render(<PluginUiPane page={{ ...page, id: 'excalidraw@market:call-2' }} hidden
      onContext={noop} onMessage={noop} onOpenLink={noop} />)
    const frame = container.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect((frame as HTMLIFrameElement).style.display).toBe('none')
    expect(frame?.getAttribute('data-hidden')).toBe('true')
    expect(frame?.getAttribute('src')).toContain('/api/plugins/ui/page?')
  })

  // 验证消息桥来源校验：来自自己 iframe（source 匹配）的 ui/open-link 请求被处理并把空 result
  // postMessage 回去；来自 window 自身（伪造 source）的请求被忽略——防其他窗口冒充插件页面。
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
