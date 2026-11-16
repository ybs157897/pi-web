// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Automation } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/**
 * vi.hoisted 收集的 API 层 mock：自动化 CRUD 与运行记录查询全部替换为 vi.fn，
 * 页面组件不触达真实后端。
 */
const mocks = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  runAutomation: vi.fn(),
  automationRuns: vi.fn(),
  purgeEndedAutomations: vi.fn(),
}))

vi.mock('../src/web/api.ts', () => ({ api: mocks }))

// 在 mock 生效后再动态导入被测页面组件。
const { default: AutomationsPage } = await import('../src/web/AutomationsPage.tsx')

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0)
const WEEKLY = 'DTSTART;TZID=Asia/Shanghai:20261102T170000\nRRULE:FREQ=DAILY'

/**
 * 构造一条自动化任务记录，默认为带每日规则的活动任务。
 * @param overrides 需要覆盖的字段（status/rrule/nextRunAt 等）
 * @returns 完整的 Automation 对象
 */
function task(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1', name: 'Nightly issues', prompt: 'analyse the list',
    status: 'active', target: 'new', rrule: WEEKLY, timeZone: 'Asia/Shanghai',
    nextRunAt: NOW + 3_600_000, createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

/**
 * 渲染自动化页面（空工作区列表 + 可选回调覆盖）。
 * @param overrides onOpenConversation / onNewConversation 回调覆盖项
 * @returns testing-library 的 render 结果
 */
function renderPage(overrides: { onOpenConversation?: (id: string) => void; onNewConversation?: () => void } = {}) {
  return render(<AutomationsPage workspaces={[]} onOpenConversation={overrides.onOpenConversation ?? (() => {})}
    onNewConversation={overrides.onNewConversation ?? (() => {})} />)
}

/** 每个用例前：搭建渲染 DOM 环境、重置全部 mock，并给运行记录/清理接口默认空响应。 */
beforeEach(() => {
  setupRenderingDom()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.automationRuns.mockResolvedValue({ runs: [], total: 0 })
  mocks.purgeEndedAutomations.mockResolvedValue({ removed: 0 })
})

/** 每个用例后：卸载组件、恢复被 spy 的实现，避免用例间污染。 */
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/**
 * 自动化页面（AutomationsPage）集成测试。
 *
 * 关键契约：
 * - 规则摘要（如「每天 17:00」）与「下次计划时间」正确展示；
 * - 状态筛选默认选中「已开启」，无规则的暂停任务读作「手动」；
 * - 运行记录列表展示状态与错误，按「查看会话」打开对应会话（倒序第一行）；
 * - 手动创建面板把表单编译成 RRULE 并以 target=new_once 提交；
 * - 主「新建」按钮进入新会话；详情面板可暂停活动任务。
 */
describe('automations page', () => {
  // 任务规则必须以中文摘要展示（含时刻），并给出下次计划时间的文案。
  it('describes a rule and its next scheduled time', async () => {
    mocks.listAutomations.mockResolvedValue({ automations: [task()] })
    renderPage()
    await waitFor(() => { expect(screen.getByText(/每天 17:00/)).toBeTruthy() })
    expect(screen.getByText(/下次计划时间/)).toBeTruthy()
  })

  // 状态筛选互斥：默认「已开启」只显示活动任务，切到「已暂停」只显示暂停任务；无规则的任务读作「手动」。
  it('filters by status, with 已开启 selected first', async () => {
    mocks.listAutomations.mockResolvedValue({
      automations: [
        task({ id: 'auto-1', name: 'Active task' }),
        task({ id: 'auto-2', name: 'Paused task', status: 'paused', rrule: undefined, nextRunAt: undefined }),
      ],
    })
    renderPage()
    await waitFor(() => { expect(screen.getAllByText('Active task').length).toBeGreaterThan(0) })
    expect(screen.queryAllByText('Paused task')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '已暂停' }))
    await waitFor(() => { expect(screen.getAllByText('Paused task').length).toBeGreaterThan(0) })
    expect(screen.queryAllByText('Active task')).toHaveLength(0)
    // 没有规则的任务读作手动。
    expect(screen.getAllByText('手动').length).toBeGreaterThan(0)
  })

  // 运行记录按倒序展示（failed 在前），状态标签与错误文案可见；第一个「查看会话」按钮打开倒序第一行的会话 conv-2。
  it('lists a task run history and opens a run in its conversation', async () => {
    const opened: string[] = []
    mocks.listAutomations.mockResolvedValue({ automations: [task()] })
    mocks.automationRuns.mockResolvedValue({
      total: 2,
      runs: [
        { id: 'run-2', status: 'failed', plannedAt: NOW, startedAt: NOW, finishedAt: NOW + 60_000, conversationId: 'conv-2', error: 'boom' },
        { id: 'run-1', status: 'completed', plannedAt: NOW - 60_000, startedAt: NOW - 60_000, finishedAt: NOW, conversationId: 'conv-1' },
      ],
    })
    renderPage({ onOpenConversation: id => { opened.push(id) } })
    await waitFor(() => { expect(screen.getAllByText('Nightly issues').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('tab', { name: '任务运行记录' }))
    await waitFor(() => { expect(screen.getByText(/boom/)).toBeTruthy() })
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: '查看会话' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    expect(opened).toEqual(['conv-2'])
  })

  // 手动创建面板填写名称/内容/重复/时间后提交，createAutomation 收到 target=new_once 的 active 任务且 rrule 含 FREQ=DAILY。
  it('creates a task from the manual panel with a compiled rule', async () => {
    mocks.listAutomations.mockResolvedValue({ automations: [task()] })
    mocks.createAutomation.mockResolvedValue({ automation: task({ id: 'auto-new' }) })
    renderPage()
    await waitFor(() => { expect(screen.getAllByText('Nightly issues').length).toBeGreaterThan(0) })

    fireEvent.click(screen.getByRole('button', { name: '选择创建方式' }))
    await waitFor(() => { expect(screen.getByText('手动创建')).toBeTruthy() })
    fireEvent.click(screen.getByText('手动创建'))
    await waitFor(() => { expect(screen.getByLabelText('自动化任务名称')).toBeTruthy() })

    fireEvent.change(screen.getByLabelText('自动化任务名称'), { target: { value: 'Weekly issues' } })
    fireEvent.change(screen.getByLabelText('自动化任务内容'), { target: { value: 'do the work' } })
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: 'daily' } })
    fireEvent.change(screen.getByLabelText('时间'), { target: { value: '09:30' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => { expect(mocks.createAutomation).toHaveBeenCalled() })
    expect(mocks.createAutomation.mock.calls[0]![0]).toMatchObject({
      name: 'Weekly issues', prompt: 'do the work', target: 'new_once', status: 'active',
    })
    expect(String(mocks.createAutomation.mock.calls[0]![0].rrule)).toContain('RRULE:FREQ=DAILY')
  })

  // 列表为空时主「新建」按钮直接进入新会话，不经过创建面板。
  it('opens a new conversation from the primary create button', async () => {
    const created: string[] = []
    mocks.listAutomations.mockResolvedValue({ automations: [] })
    renderPage({ onNewConversation: () => { created.push('new') } })
    await waitFor(() => { expect(screen.getByRole('button', { name: '新建' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(created).toEqual(['new'])
  })

  // 详情面板的「暂停任务」把 status 更新为 paused 并发送到 updateAutomation('auto-1', { status: 'paused' })。
  it('pauses an active task from the detail pane', async () => {
    mocks.listAutomations.mockResolvedValue({ automations: [task()] })
    mocks.updateAutomation.mockResolvedValue({ automation: task({ status: 'paused', nextRunAt: undefined }) })
    renderPage()
    await waitFor(() => { expect(screen.getAllByText('Nightly issues').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('button', { name: '暂停任务' }))
    await waitFor(() => { expect(mocks.updateAutomation).toHaveBeenCalledWith('auto-1', { status: 'paused' }) })
  })
})
