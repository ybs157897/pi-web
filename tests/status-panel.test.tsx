// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import StatusPanel, { todoFocusWindow } from '../src/web/StatusPanel.tsx'
import type { SubagentSummary, TodoItem } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(() => {
  setupRenderingDom()
  // The display mode persists in localStorage; each case starts from the default again.
  window.localStorage.clear()
  // jsdom has no layout: give the panel's parent a wide conversation box.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1440, height: 900, top: 0, left: 0, right: 1440, bottom: 900, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const todos: TodoItem[] = [
  { content: '定位问题', status: 'completed' },
  { content: '读取源码', status: 'completed' },
  { content: '修改实现', status: 'in_progress' },
  { content: '补充测试', status: 'pending' },
  { content: '实机验收', status: 'pending' },
  { content: '整理文档', status: 'pending' },
  { content: '提交', status: 'pending' },
]

const subagent: SubagentSummary = {
  id: 'child-1', label: 'reviewer', title: '检查渲染结果', status: 'running', answer: '',
  durationMs: 12_000, metricsAt: Date.now(), createdAt: 1, updatedAt: 2,
}

function renderPanel(overrides: Partial<Parameters<typeof StatusPanel>[0]> = {}) {
  const onVisibilityChange = vi.fn()
  render(<StatusPanel conversationId="parent-1" todos={todos} subagents={[subagent]}
    onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}}
    onVisibilityChange={onVisibilityChange} {...overrides} />)
  return { onVisibilityChange }
}

describe('todoFocusWindow', () => {
  it('leaves short lists intact', () => {
    expect(todoFocusWindow(todos.slice(0, 6))).toMatchObject({ compact: false, preceding: [], focus: todos.slice(0, 6), following: [] })
  })

  it('keeps three rows around the in-progress item and folds the rest', () => {
    const window = todoFocusWindow(todos)
    expect(window.compact).toBe(true)
    expect(window.preceding.map(item => item.content)).toEqual(['定位问题', '读取源码'])
    expect(window.focus.map(item => item.content)).toEqual(['修改实现', '补充测试', '实机验收'])
    expect(window.following.map(item => item.content)).toEqual(['整理文档', '提交'])
  })

  it('falls back to the last three rows when everything is done', () => {
    const done = todos.map(item => ({ ...item, status: 'completed' as const }))
    const window = todoFocusWindow(done)
    expect(window.focus.map(item => item.content)).toEqual(['实机验收', '整理文档', '提交'])
    expect(window.preceding).toHaveLength(4)
  })
})

describe('StatusPanel', () => {
  it('renders the process count, folds hidden Todo rows and reveals them on demand', () => {
    const { onVisibilityChange } = renderPanel()
    expect(screen.getByText('进程')).toBeTruthy()
    expect(screen.getByText('2/7')).toBeTruthy()
    expect(screen.queryByText('整理文档')).toBeNull()
    fireEvent.click(screen.getByText('待处理 2 项'))
    expect(screen.getByText('整理文档')).toBeTruthy()
    expect(onVisibilityChange).toHaveBeenCalledWith(true)
  })

  it('keeps agents collapsed until opened and shows their elapsed time and stop action', () => {
    renderPanel()
    expect(screen.getByText('智能体')).toBeTruthy()
    expect(screen.getByText('1 运行')).toBeTruthy()
    expect(screen.queryByText('检查渲染结果')).toBeNull()
    fireEvent.click(screen.getByText('智能体'))
    expect(screen.getByText('检查渲染结果')).toBeTruthy()
    expect(screen.getByText('停止')).toBeTruthy()
  })

  it('sends ended agents to the directory page instead of listing them in the card', () => {
    const ended: SubagentSummary = {
      id: 'child-2', label: 'writer', title: '整理验收记录', status: 'inactive', answer: 'done',
      durationMs: 65_000, tokens: 12_345, createdAt: 1, updatedAt: 2,
    }
    const onOpenSubagentDirectory = vi.fn()
    renderPanel({ subagents: [ended], onOpenSubagentDirectory })
    expect(screen.getByText('1 已结束')).toBeTruthy()
    fireEvent.click(screen.getByText('智能体'))
    expect(screen.queryByText('整理验收记录')).toBeNull()
    fireEvent.click(screen.getByText('已结束的智能体'))
    expect(onOpenSubagentDirectory).toHaveBeenCalledTimes(1)
  })

  it('renders the goal section with its phase, round budget and pause control', () => {
    const onGoalAction = vi.fn()
    renderPanel({
      goal: { id: 'goal-1', revision: 3, objective: '把右侧状态卡补齐', phase: 'active', maxGoalRounds: 10, roundsStarted: 2, createdAt: 1, updatedAt: 2 },
      onGoalAction,
    })
    expect(screen.getByText('目标')).toBeTruthy()
    expect(screen.getByText('把右侧状态卡补齐')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('2/10 轮')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('暂停目标'))
    expect(onGoalAction).toHaveBeenCalledWith('pause')
  })

  it('switches the goal control to resume once the goal is paused or blocked', () => {
    const onGoalAction = vi.fn()
    renderPanel({
      goal: {
        id: 'goal-1', revision: 3, objective: '补齐胶囊', phase: 'blocked', maxGoalRounds: 8, roundsStarted: 1,
        blockedReason: '缺少验收环境', createdAt: 1, updatedAt: 2,
      },
      onGoalAction,
    })
    expect(screen.getByText('受阻')).toBeTruthy()
    expect(screen.getByText('缺少验收环境')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('恢复目标'))
    expect(onGoalAction).toHaveBeenCalledWith('resume')
  })

  it('hides a completed goal from both the section and the capsule', () => {
    renderPanel({
      todos: [],
      subagents: [],
      goal: { id: 'goal-1', revision: 4, objective: '已经完成', phase: 'complete', maxGoalRounds: 5, roundsStarted: 5, createdAt: 1, updatedAt: 2 },
    })
    expect(document.querySelector('[data-status-section="goal"]')).toBeNull()
    expect(document.querySelector('[data-status-capsule]')).toBeNull()
  })

  it('lists submitted plans newest first and opens one on click', () => {
    const onOpenPlan = vi.fn()
    renderPanel({
      plans: [
        { markdown: '# 第二版计划', title: '第二版计划', key: 'call-b', pending: true },
        { markdown: '# 第一版计划', title: '第一版计划', key: 'call-a' },
      ],
      onOpenPlan,
    })
    expect(screen.getByText('计划')).toBeTruthy()
    const rows = screen.getAllByRole('button').filter(button => button.textContent?.includes('版计划'))
    expect(rows.map(row => row.textContent)).toEqual(['第二版计划待批', '第一版计划'])
    fireEvent.click(rows[0]!)
    expect(onOpenPlan).toHaveBeenCalledWith(expect.objectContaining({ key: 'call-b', pending: true }))
  })

  it('capsules the latest plan so a plan-only conversation keeps its entry point', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    render(<StatusPanel conversationId="parent-1" todos={[]} subagents={[]}
      plans={[{ markdown: '# 演示计划', title: '演示计划', key: 'call-a', pending: true }]}
      onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('演示计划')
  })

  it('capsules the first pending Todo item and the last completed one', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    const pendingPanel = render(<StatusPanel conversationId="parent-1"
      todos={[{ content: '定位问题', status: 'completed' }, { content: '补充测试', status: 'pending' }]}
      subagents={[]} onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('补充测试')
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('1/2')
    pendingPanel.unmount()
    render(<StatusPanel conversationId="parent-1"
      todos={[{ content: '定位问题', status: 'completed' }, { content: '补充测试', status: 'completed' }]}
      subagents={[]} onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('补充测试')
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('2/2')
  })

  it('falls back to the goal after the Todo branches and keeps the Git summary below agents', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    render(<StatusPanel conversationId="parent-1" todos={[]} subagents={[subagent]}
      goal={{ id: 'goal-1', revision: 1, objective: '补齐右侧状态卡', phase: 'active', maxGoalRounds: 10, roundsStarted: 0, createdAt: 1, updatedAt: 2 }}
      onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('补齐右侧状态卡')
    expect(document.querySelector('[data-status-capsule]')?.textContent).not.toContain('个智能体运行中')
  })

  it('renders nothing while there is no Git, Todo or agent content', () => {
    renderPanel({ todos: [], subagents: [] })
    expect(document.querySelector('[data-status-panel]')).toBeTruthy()
    expect(document.querySelector('[data-status-panel]')?.getAttribute('style')).toContain('display: none')
  })

  it('falls back to the capsule and releases layout room when the conversation column is narrow', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    const { onVisibilityChange } = renderPanel()
    expect(document.querySelector('[data-status-panel]')?.getAttribute('data-display-mode')).toBe('mini')
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('修改实现')
    expect(document.querySelector('[data-status-section="todo"]')).toBeNull()
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false)
  })

  it('expands the capsule into the full card when clicked', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    renderPanel()
    fireEvent.click(document.querySelector('[data-status-capsule]') as HTMLElement)
    expect(screen.getByText('进程')).toBeTruthy()
    expect(document.querySelector('[data-status-capsule]')).toBeNull()
  })

  it('offers the display-mode menu and the collapse control on the expanded card', () => {
    renderPanel()
    expect(screen.getByLabelText('显示方式')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('收起为胶囊'))
    expect(document.querySelector('[data-status-capsule]')).toBeTruthy()
    expect(document.querySelector('[data-status-section="todo"]')).toBeNull()
  })

  it('previews a folded Todo group on hover', async () => {
    vi.useFakeTimers()
    renderPanel()
    const fold = screen.getByText('已完成 2 项')
    fireEvent.pointerEnter(fold.closest('span') as HTMLElement)
    await vi.advanceTimersByTimeAsync(300)
    expect(screen.getAllByText('定位问题').length).toBeGreaterThan(0)
    vi.useRealTimers()
  })

  // ZCode's vocabulary: an arrow marks the running step, a bare circle the untouched ones,
  // and a filled dot would read as "unread". The count turns green only when nothing is left.
  it('draws the running step as an arrow and keeps the count neutral until everything is done', () => {
    renderPanel()
    const iconOf = (content: string) => screen.getByText(content).closest('[data-status]')!
      .querySelector('svg')?.getAttribute('class')?.split(' ') ?? []
    expect(screen.getByText('修改实现').closest('[data-status]')?.getAttribute('data-status')).toBe('in_progress')
    expect(iconOf('修改实现')).toContain('lucide-arrow-right')
    expect(iconOf('补充测试')).toContain('lucide-circle')
    expect(iconOf('补充测试')).not.toContain('lucide-circle-check')
    expect(screen.getByText('2/7').getAttribute('data-complete')).toBeNull()
  })

  it('colors the count once every Todo is completed', () => {
    renderPanel({ todos: [{ content: '定位问题', status: 'completed' }, { content: '读取源码', status: 'completed' }] })
    const row = screen.getByText('读取源码').closest('[data-status]')
    expect(row?.querySelector('svg')?.getAttribute('class')?.split(' ')).toContain('lucide-circle-check')
    expect(screen.getByText('2/2').getAttribute('data-complete')).toBe('true')
  })
})
