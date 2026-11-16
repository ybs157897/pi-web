// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ConversationDetail } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/**
 * 子智能体面板（SubagentPane）与 Inspector 子会话标签页的渲染契约测试（jsdom 环境）：
 * 实时快照跟随、只读转录（无输入面）、流的生命周期（卸载关闭、隐藏保活）、
 * 加载失败的紧凑报错、多标签挂载与切换。
 */
const apiMock = vi.hoisted(() => ({ getConversation: vi.fn(), watch: vi.fn() }))
vi.mock('../src/web/api.ts', () => ({
  api: apiMock,
  ApiFailure: class ApiFailure extends Error {},
}))

import SubagentPane from '../src/web/SubagentPane.tsx'
import Inspector from '../src/web/Inspector.tsx'

beforeEach(() => {
  setupRenderingDom()
  // 每个用例重置 API mock 并给默认解析值，避免跨用例的调用记录污染。
  apiMock.getConversation.mockReset()
  apiMock.watch.mockReset()
  apiMock.getConversation.mockResolvedValue(conversationDetail())
  apiMock.watch.mockReturnValue({ close: vi.fn() } as unknown as EventSource)
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/**
 * 构造子会话详情 fixture。
 * @param overrides 覆盖默认字段（origin=subagent 的子会话 + 一条用户消息）
 */
function conversationDetail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    conversation: {
      id: 'child-1',
      title: '子会话',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      pinned: false,
      busy: false,
      thinkingLevel: 'off',
      cwd: '/workspace',
      origin: 'subagent',
      parentId: 'parent-1',
      model: { provider: 'test-provider', modelId: 'test-model' },
    },
    messages: [{
      id: 'message-1',
      role: 'user',
      blocks: [{ type: 'text', text: '子任务结果' }],
      timestamp: 1,
    }],
    queue: [],
    ...overrides,
  }
}

/**
 * 构造 Inspector 的 props fixture：两个子会话标签（child-1 激活、child-2 隐藏），
 * 回调全部为 spy。
 * @param overrides 覆盖默认 props
 */
function inspectorProps(overrides: Partial<ComponentProps<typeof Inspector>> = {}): ComponentProps<typeof Inspector> {
  return {
    view: 'subagent',
    onView: vi.fn(),
    onClose: vi.fn(),
    subagentTabs: [
      { id: 'child-1', title: '调研城市' },
      { id: 'child-2', title: '调研区县' },
    ],
    activeSubagentId: 'child-1',
    onSelectSubagentTab: vi.fn(),
    onCloseSubagentTab: vi.fn(),
    ...overrides,
  }
}

describe('subagent pane', () => {
  // 渲染契约：标题可见、getConversation 拉初始数据、watch 挂实时流并响应推送；
  // 子会话转录是只读的——无输入框、无重试/分叉/停止控件。
  it('renders the child title, follows the live snapshot, and has no composer', async () => {
    let listener: ((detail: ConversationDetail) => void) | undefined
    apiMock.watch.mockImplementation((_id: string, next: (detail: ConversationDetail) => void) => {
      listener = next
      return { close: vi.fn() } as unknown as EventSource
    })
    const { container } = render(<SubagentPane childId="child-1" title="调研城市" />)

    expect(screen.getByText('调研城市')).toBeTruthy()
    await screen.findByText('子任务结果')
    expect(apiMock.getConversation).toHaveBeenCalledWith('child-1')
    expect(apiMock.watch).toHaveBeenCalledWith('child-1', expect.any(Function), expect.any(Function))
    // 子会话转录是只读的：没有输入面，也没有重试、分叉或停止控件。
    expect(container.querySelector('[data-composer-input]')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试此回答' })).toBeNull()

    act(() => {
      listener?.(conversationDetail({
        messages: [{
          id: 'message-2',
          role: 'user',
          blocks: [{ type: 'text', text: '更新后的快照' }],
          timestamp: 2,
        }],
      }))
    })
    await screen.findByText('更新后的快照')
  })

  // 生命周期：卸载面板必须关闭 EventSource 流，防止泄漏。
  it('closes the live stream when the pane unmounts', async () => {
    const close = vi.fn()
    apiMock.watch.mockReturnValue({ close } as unknown as EventSource)
    const view = render(<SubagentPane childId="child-1" title="调研城市" />)
    await screen.findByText('子任务结果')

    view.unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })

  // 保活策略：hidden 只是视觉隐藏（保持挂载），转录与实时流都存活、不关闭。
  it('keeps a hidden pane mounted so its transcript and stream survive', async () => {
    const close = vi.fn()
    apiMock.watch.mockReturnValue({ close } as unknown as EventSource)
    const { container, rerender } = render(<SubagentPane childId="child-1" title="调研城市" />)
    await screen.findByText('子任务结果')

    rerender(<SubagentPane childId="child-1" title="调研城市" hidden />)
    const pane = container.querySelector('[data-subagent-pane="child-1"]')
    expect(pane?.hasAttribute('hidden')).toBe(true)
    expect(screen.getByText('子任务结果')).toBeTruthy()
    expect(close).not.toHaveBeenCalled()
  })

  // 容错：加载失败展示带错误信息的紧凑 alert，而不是空白或崩溃。
  it('shows a compact error when the child cannot be loaded', async () => {
    apiMock.getConversation.mockRejectedValue(new Error('子会话不存在'))
    render(<SubagentPane childId="ghost" title="缺失的会话" />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('子会话不存在')
  })
})

describe('inspector subagent tabs', () => {
  // 标签页契约：每个子会话一个 tab（aria-pressed 标激活）、所有 pane 常驻挂载、
  // 非激活 pane 隐藏、容器本身可见。
  it('renders one tab per child, keeps every pane mounted and hides inactive ones', () => {
    const { container } = render(<Inspector {...inspectorProps()} />)

    expect(screen.getByRole('button', { name: '调研城市' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '调研区县' }).getAttribute('aria-pressed')).toBe('false')
    const panes = container.querySelectorAll('[data-subagent-pane]')
    expect(panes).toHaveLength(2)
    expect(panes[0]?.getAttribute('data-subagent-pane')).toBe('child-1')
    expect(panes[0]?.hasAttribute('hidden')).toBe(false)
    expect(panes[1]?.getAttribute('data-subagent-pane')).toBe('child-2')
    expect(panes[1]?.hasAttribute('hidden')).toBe(true)
    expect(container.querySelector('[data-subagent-surfaces]')?.hasAttribute('hidden')).toBe(false)
  })

  // 交互：点击 tab 回调 onSelectSubagentTab 并保持 subagent 视图。
  it('selects a child tab and reports the subagent view', () => {
    const onSelectSubagentTab = vi.fn()
    const onView = vi.fn()
    render(<Inspector {...inspectorProps({ onSelectSubagentTab, onView })} />)

    fireEvent.click(screen.getByRole('button', { name: '调研区县' }))
    expect(onSelectSubagentTab).toHaveBeenCalledWith('child-2')
    expect(onView).toHaveBeenCalledWith('subagent')
  })

  // 关闭路径分流：每个 tab 自己的关闭按钮只关该子会话；
  // 头部的总关闭按钮关闭当前激活 tab、不触发整体 onClose。
  it('closes one child tab from its own button and the active one from the header', () => {
    const onCloseSubagentTab = vi.fn()
    const onClose = vi.fn()
    render(<Inspector {...inspectorProps({ onCloseSubagentTab, onClose })} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭子智能体会话 调研区县' }))
    expect(onCloseSubagentTab).toHaveBeenCalledWith('child-2')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '关闭子智能体会话' }))
    expect(onCloseSubagentTab).toHaveBeenLastCalledWith('child-1')
  })

  // 切走视图时 pane 全部隐藏但保持挂载，切回时转录与流无需重建。
  it('keeps the child panes mounted and hidden while another view is active', () => {
    const props = inspectorProps()
    const view = render(<Inspector {...props} />)
    view.rerender(<Inspector {...props} view="file" file={{ path: '/workspace/notes.md', content: '# Notes' }} />)

    const panes = view.container.querySelectorAll('[data-subagent-pane]')
    expect(panes).toHaveLength(2)
    expect(panes[0]?.hasAttribute('hidden')).toBe(true)
    expect(panes[1]?.hasAttribute('hidden')).toBe(true)
    expect(view.container.querySelector('[data-subagent-surfaces]')?.hasAttribute('hidden')).toBe(true)
  })
})
