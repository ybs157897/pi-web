// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import StatusPanel, { todoFocusWindow } from '../src/web/StatusPanel.tsx'
import type { SubagentSummary, TodoItem } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/**
 * 状态面板（StatusPanel）契约测试（jsdom 环境）：待办聚焦窗口（todoFocusWindow）、
 * 进程/智能体/目标/计划四个分区、胶囊（capsule）与完整卡片两种显示模式、
 * Todo 图标语义与计数配色。
 */
beforeEach(() => {
  setupRenderingDom()
  // 显示模式持久化在 localStorage；每个用例都从默认状态重新开始。
  window.localStorage.clear()
  // jsdom 没有布局：给面板父容器一个宽的会话盒子。
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1440, height: 900, top: 0, left: 0, right: 1440, bottom: 900, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 7 条 Todo 样本：2 完成、1 进行中、4 待办，足以触发折叠与聚焦窗口。 */
const todos: TodoItem[] = [
  { content: '定位问题', status: 'completed' },
  { content: '读取源码', status: 'completed' },
  { content: '修改实现', status: 'in_progress' },
  { content: '补充测试', status: 'pending' },
  { content: '实机验收', status: 'pending' },
  { content: '整理文档', status: 'pending' },
  { content: '提交', status: 'pending' },
]

/** 运行中的子智能体样本：带 metricsAt，时长会随时间推进。 */
const subagent: SubagentSummary = {
  id: 'child-1', label: 'reviewer', title: '检查渲染结果', status: 'running', answer: '',
  durationMs: 12_000, metricsAt: Date.now(), createdAt: 1, updatedAt: 2,
}

/**
 * 挂载默认面板。
 * @param overrides 覆盖默认 props（todos/subagents/goal/plans/回调）
 * @returns onVisibilityChange spy，供可见性断言
 */
function renderPanel(overrides: Partial<Parameters<typeof StatusPanel>[0]> = {}) {
  const onVisibilityChange = vi.fn()
  render(<StatusPanel conversationId="parent-1" todos={todos} subagents={[subagent]}
    onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}}
    onVisibilityChange={onVisibilityChange} {...overrides} />)
  return { onVisibilityChange }
}

describe('todoFocusWindow', () => {
  // 短列表（≤6 条）不折叠：无 preceding/following，compact 为 false。
  it('leaves short lists intact', () => {
    expect(todoFocusWindow(todos.slice(0, 6))).toMatchObject({ compact: false, preceding: [], focus: todos.slice(0, 6), following: [] })
  })

  // 长列表聚焦规则：以进行中项为中心保留 3 行焦点，前后行折叠进可展开组。
  it('keeps three rows around the in-progress item and folds the rest', () => {
    const window = todoFocusWindow(todos)
    expect(window.compact).toBe(true)
    expect(window.preceding.map(item => item.content)).toEqual(['定位问题', '读取源码'])
    expect(window.focus.map(item => item.content)).toEqual(['修改实现', '补充测试', '实机验收'])
    expect(window.following.map(item => item.content)).toEqual(['整理文档', '提交'])
  })

  // 边界：全部完成时没有进行中项，焦点窗口回退到列表末尾 3 行。
  it('falls back to the last three rows when everything is done', () => {
    const done = todos.map(item => ({ ...item, status: 'completed' as const }))
    const window = todoFocusWindow(done)
    expect(window.focus.map(item => item.content)).toEqual(['实机验收', '整理文档', '提交'])
    expect(window.preceding).toHaveLength(4)
  })
})

describe('StatusPanel', () => {
  // Todo 分区主链路：进程计数 2/7、折叠组默认收起、点击「待处理 2 项」展开
  // 并触发 onVisibilityChange(true)。
  it('renders the process count, folds hidden Todo rows and reveals them on demand', () => {
    const { onVisibilityChange } = renderPanel()
    expect(screen.getByText('进程')).toBeTruthy()
    expect(screen.getByText('2/7')).toBeTruthy()
    expect(screen.queryByText('整理文档')).toBeNull()
    fireEvent.click(screen.getByText('待处理 2 项'))
    expect(screen.getByText('整理文档')).toBeTruthy()
    expect(onVisibilityChange).toHaveBeenCalledWith(true)
  })

  // 智能体分区：默认收起，点开后显示标题、运行时长与停止按钮。
  it('keeps agents collapsed until opened and shows their elapsed time and stop action', () => {
    renderPanel()
    expect(screen.getByText('智能体')).toBeTruthy()
    expect(screen.getByText('1 运行')).toBeTruthy()
    expect(screen.queryByText('检查渲染结果')).toBeNull()
    fireEvent.click(screen.getByText('智能体'))
    expect(screen.getByText('检查渲染结果')).toBeTruthy()
    expect(screen.getByText('停止')).toBeTruthy()
  })

  // 已结束智能体不进卡片列表：只显示计数，点击「已结束的智能体」跳转目录页。
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

  // 目标分区：目标文本、进行中阶段、轮次预算（2/10）与暂停按钮各就各位。
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

  // 受阻目标：显示受阻原因，控制按钮从「暂停」切换为「恢复」（resume 回调）。
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

  // 完成的目标从分区与胶囊双双消失——不留已完成目标的入口。
  it('hides a completed goal from both the section and the capsule', () => {
    renderPanel({
      todos: [],
      subagents: [],
      goal: { id: 'goal-1', revision: 4, objective: '已经完成', phase: 'complete', maxGoalRounds: 5, roundsStarted: 5, createdAt: 1, updatedAt: 2 },
    })
    expect(document.querySelector('[data-status-section="goal"]')).toBeNull()
    expect(document.querySelector('[data-status-capsule]')).toBeNull()
  })

  // 计划分区：新计划在前、待批计划带「待批」后缀、点击行回调 onOpenPlan。
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

  // 胶囊回退链之一：只有计划时胶囊展示最新计划，纯计划会话仍有入口。
  it('capsules the latest plan so a plan-only conversation keeps its entry point', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    render(<StatusPanel conversationId="parent-1" todos={[]} subagents={[]}
      plans={[{ markdown: '# 演示计划', title: '演示计划', key: 'call-a', pending: true }]}
      onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('演示计划')
  })

  // 胶囊回退链之二：有 Todo 时胶囊展示首个待办项与进度计数；
  // 全部完成后展示最后一项与 2/2。
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

  // 胶囊回退链之三：Todo 分支不命中时落到目标；胶囊不出现 Git/智能体计数。
  it('falls back to the goal after the Todo branches and keeps the Git summary below agents', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    render(<StatusPanel conversationId="parent-1" todos={[]} subagents={[subagent]}
      goal={{ id: 'goal-1', revision: 1, objective: '补齐右侧状态卡', phase: 'active', maxGoalRounds: 10, roundsStarted: 0, createdAt: 1, updatedAt: 2 }}
      onOpenSubagent={() => {}} onInspectDiff={() => {}} onNotice={() => {}} />)
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('补齐右侧状态卡')
    expect(document.querySelector('[data-status-capsule]')?.textContent).not.toContain('个智能体运行中')
  })

  // 空态：没有任何可显示内容时面板整体隐藏（display: none），不占布局。
  it('renders nothing while there is no Git, Todo or agent content', () => {
    renderPanel({ todos: [], subagents: [] })
    expect(document.querySelector('[data-status-panel]')).toBeTruthy()
    expect(document.querySelector('[data-status-panel]')?.getAttribute('style')).toContain('display: none')
  })

  // 窄列自适应：宽度不足时自动切 mini 模式（胶囊 + 释放布局空间，
  // onVisibilityChange(false)），分区不渲染。
  it('falls back to the capsule and releases layout room when the conversation column is narrow', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    const { onVisibilityChange } = renderPanel()
    expect(document.querySelector('[data-status-panel]')?.getAttribute('data-display-mode')).toBe('mini')
    expect(document.querySelector('[data-status-capsule]')?.textContent).toContain('修改实现')
    expect(document.querySelector('[data-status-section="todo"]')).toBeNull()
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false)
  })

  // 交互：点击胶囊展开为完整卡片（分区出现、胶囊消失）。
  it('expands the capsule into the full card when clicked', () => {
    const rect = (width: number) => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(HTMLElement.prototype.getBoundingClientRect as unknown as { mockReturnValue: (value: DOMRect) => void }).mockReturnValue(rect(900))
    renderPanel()
    fireEvent.click(document.querySelector('[data-status-capsule]') as HTMLElement)
    expect(screen.getByText('进程')).toBeTruthy()
    expect(document.querySelector('[data-status-capsule]')).toBeNull()
  })

  // 展开态控件：提供「显示方式」菜单与「收起为胶囊」按钮，点击后回到胶囊态。
  it('offers the display-mode menu and the collapse control on the expanded card', () => {
    renderPanel()
    expect(screen.getByLabelText('显示方式')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('收起为胶囊'))
    expect(document.querySelector('[data-status-capsule]')).toBeTruthy()
    expect(document.querySelector('[data-status-section="todo"]')).toBeNull()
  })

  // 悬停预览：折叠组（「已完成 2 项」）悬停约 300ms 后浮出已完成项预览。
  it('previews a folded Todo group on hover', async () => {
    vi.useFakeTimers()
    renderPanel()
    const fold = screen.getByText('已完成 2 项')
    fireEvent.pointerEnter(fold.closest('span') as HTMLElement)
    await vi.advanceTimersByTimeAsync(300)
    expect(screen.getAllByText('定位问题').length).toBeGreaterThan(0)
    vi.useRealTimers()
  })

  // ZCode 的图标词汇：进行中步骤用箭头、未开始用空心圆、实心点会被读成「未读」
  // 因此禁用；计数只有全部完成才变绿（data-complete）。
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

  // 完成态：所有 Todo 完成后行图标换成实心对勾圆，计数标记 data-complete=true。
  it('colors the count once every Todo is completed', () => {
    renderPanel({ todos: [{ content: '定位问题', status: 'completed' }, { content: '读取源码', status: 'completed' }] })
    const row = screen.getByText('读取源码').closest('[data-status]')
    expect(row?.querySelector('svg')?.getAttribute('class')?.split(' ')).toContain('lucide-circle-check')
    expect(screen.getByText('2/2').getAttribute('data-complete')).toBe('true')
  })
})
