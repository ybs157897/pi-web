// @vitest-environment jsdom
/**
 * 插件 UI 的应用级集成测试：Inspector 插件页签、Composer 插件上下文 chips 与提示词上下文块。
 *
 * 关键契约：
 * - Inspector：每页一个 tab、所有窗格保持挂载（非激活仅 CSS 隐藏，iframe 状态不丢）；
 *   切页不卸载其他页；切走 inspector 视图时窗格容器 hidden 但仍挂载；
 *   tab 关闭按钮只关对应页、头部关闭按钮关激活页；
 *   已被池化的页面（有宿主元素）在 inspector 内只渲染槽位不再长第二个 iframe；
 *   "+" 菜单刷新并列出插件 surface、选中即打开；无可用 surface 时提示去设置；
 * - Composer：每条插件上下文渲染一个 chip（超长预览截断、title 保留全文）、按 app key 移除；
 * - pluginContextBlock：把上下文条目拼成 "# Plugin context:" Markdown 块（含工具调用标注与结构化 JSON）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PluginContextEntry, PluginUiPage, PluginUiSurfaceView } from '../src/shared/plugin-ui.ts'
import { pluginContextBlock } from '../src/shared/plugin-ui.ts'
import Inspector from '../src/web/Inspector.tsx'
import Composer from '../src/web/Composer.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** 每个用例前补齐 jsdom 缺失 API；结束后清理 mock 与全局 stub。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 两个插件页面 fixture：Alpha（带 toolCallId）与 Beta（以 resourceUri 作 id）。 */
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

/**
 * 构造 Inspector 默认 props：plugin 视图、两个插件页面、激活第一页。
 * @param overrides 覆盖个别 props
 * @returns 完整 props 对象
 */
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

/** Inspector 插件页签行为测试。 */
describe('inspector plugin tabs', () => {
  // 验证页签与窗格：激活页 aria-pressed=true、其余 false；两个 iframe 都挂载，
  // 非激活 iframe 仅 data-hidden 标记；激活页 iframe src 携带 pluginId 与 uri 参数。
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

  // 验证切页：点击 Beta 页签触发 onSelectPluginPage（带页面 id）与 onView('plugin')，
  // 且两个窗格仍挂载（不卸载隐藏页）。
  it('selects a page tab and reports the plugin view without unloading the others', () => {
    const onSelectPluginPage = vi.fn()
    const onView = vi.fn()
    const { container } = render(<Inspector {...inspectorProps({ onSelectPluginPage, onView })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Beta Panel' }))
    expect(onSelectPluginPage).toHaveBeenCalledWith(pages[1]!.id)
    expect(onView).toHaveBeenCalledWith('plugin')
    expect(container.querySelectorAll('[data-plugin-ui-page]')).toHaveLength(2)
  })

  // 验证视图切换不卸载：inspector 切到 file 视图时插件容器 hidden 但两个 iframe 仍在文档中。
  it('keeps the panes mounted when another inspector view is active', () => {
    const props = inspectorProps()
    const view = render(<Inspector {...props} />)
    view.rerender(<Inspector {...props} view="file" />)
    const host = view.container.querySelector('[data-plugin-surfaces]')
    expect(host).not.toBeNull()
    expect(host?.hasAttribute('hidden')).toBe(true)
    expect(view.container.querySelectorAll('[data-plugin-ui-page]')).toHaveLength(2)
  })

  // 验证两个关闭入口：页签上的"关闭插件页面 <title>"只关对应页（不触发整体 onClose）；
  // 头部的"关闭插件页面"关闭当前激活页。
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

  // 验证池化宿主接线：有宿主元素（会话内联卡 pool）的页面在 inspector 中渲染槽位并挂载宿主
  // （槽位可见、宿主内容完好），不再长第二个 iframe；无宿主的页面（从 + 打开）保留自己的窗格。
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
    // 池化页面不得在会话自己的 iframe 旁再长出第二个 iframe。
    expect(container.querySelector(`[data-plugin-ui-page="${pages[0]!.id}"]`)).toBeNull()
    // 无宿主的页面（从 + 菜单打开）仍渲染自己的窗格。
    expect(container.querySelector(`[data-plugin-ui-page="${pages[1]!.id}"]`)).not.toBeNull()
  })

  // 验证池化宿主的隐藏语义：宿主对应页签非激活时槽位 hidden，但宿主元素仍挂载在槽位内（不卸载）。
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

  // 验证 "+" 菜单流程：点击"打开插件页面"先刷新 surface 列表（恰好一次），
  // 列表渲染后点击某个 surface 即以完整描述打开。
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

  // 验证空列表兜底：没有任何可用 surface 时菜单显示"去设置里安装插件"。
  it('points at settings when no plugin surface is enabled', async () => {
    render(<Inspector {...inspectorProps({
      pluginSurfaces: [], onRefreshPluginSurfaces: vi.fn(async () => {}), onOpenPluginSurface: vi.fn(),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '打开插件页面' }))
    expect(await screen.findByText('去设置里安装插件')).toBeTruthy()
  })
})

/** Composer 插件上下文 chips 测试。 */
describe('composer plugin context chips', () => {
  /**
   * 构造 Composer 默认 props（空输入、未发送、各回调为 vi.fn）。
   * @param overrides 覆盖个别 props
   * @returns 完整 props 对象
   */
  function composerProps(overrides: Partial<ComponentProps<typeof Composer>> = {}): ComponentProps<typeof Composer> {
    return {
      value: '', images: [], catalog: null, thinkingLevel: 'off', busy: false, queue: [],
      sendMode: 'followUp', sending: false,
      onChange: vi.fn(), onAddImages: vi.fn(), onRemoveImage: vi.fn(), onSend: vi.fn(),
      onStop: vi.fn(), onRemoveQueue: vi.fn(), onSelectModel: vi.fn(), onThinkingLevel: vi.fn(), onSendMode: vi.fn(),
      ...overrides,
    }
  }

  // 验证 chips 渲染与移除：每条上下文一个 chip（"插件上下文"分组）、长文本预览截断加省略号
  // 但 title 保留全文、点击移除按钮以 "pluginId:toolCallId" 形式的 app key 回调。
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

  // 验证空态：无上下文条目时不渲染"插件上下文"分组。
  it('renders nothing above the input without context entries', () => {
    render(<Composer {...composerProps()} />)
    expect(screen.queryByRole('group', { name: '插件上下文' })).toBeNull()
  })
})

/** pluginContextBlock 的 Markdown 序列化测试。 */
describe('plugin context block', () => {
  // 验证序列化格式：头部 "# Plugin context:"、每条目以 "## Plugin <pluginId> (callId)" 分节
  // （无 callId 则省略括号）、结构化内容以 json 代码块附加；与操作者文本用空行连接；
  // 空条目返回空串（不插入任何块）。
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
