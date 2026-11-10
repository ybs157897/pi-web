// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Automation } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

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

const { default: AutomationsPage } = await import('../src/web/AutomationsPage.tsx')

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0)
const WEEKLY = 'DTSTART;TZID=Asia/Shanghai:20261102T170000\nRRULE:FREQ=DAILY'

function task(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1', name: 'Nightly issues', prompt: 'analyse the list',
    status: 'active', target: 'new', rrule: WEEKLY, timeZone: 'Asia/Shanghai',
    nextRunAt: NOW + 3_600_000, createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

function renderPage(overrides: { onOpenConversation?: (id: string) => void; onNewConversation?: () => void } = {}) {
  return render(<AutomationsPage workspaces={[]} onOpenConversation={overrides.onOpenConversation ?? (() => {})}
    onNewConversation={overrides.onNewConversation ?? (() => {})} />)
}

beforeEach(() => {
  setupRenderingDom()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.automationRuns.mockResolvedValue({ runs: [], total: 0 })
  mocks.purgeEndedAutomations.mockResolvedValue({ removed: 0 })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('automations page', () => {
  it('describes a rule and its next scheduled time', async () => {
    mocks.listAutomations.mockResolvedValue({ automations: [task()] })
    renderPage()
    await waitFor(() => { expect(screen.getByText(/每天 17:00/)).toBeTruthy() })
    expect(screen.getByText(/下次计划时间/)).toBeTruthy()
  })

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
    // A task with no rule reads as manual.
    expect(screen.getAllByText('手动').length).toBeGreaterThan(0)
  })

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

  it('opens a new conversation from the primary create button', async () => {
    const created: string[] = []
    mocks.listAutomations.mockResolvedValue({ automations: [] })
    renderPage({ onNewConversation: () => { created.push('new') } })
    await waitFor(() => { expect(screen.getByRole('button', { name: '新建' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(created).toEqual(['new'])
  })

  it('pauses an active task from the detail pane', async () => {
    mocks.listAutomations.mockResolvedValue({ automations: [task()] })
    mocks.updateAutomation.mockResolvedValue({ automation: task({ status: 'paused', nextRunAt: undefined }) })
    renderPage()
    await waitFor(() => { expect(screen.getAllByText('Nightly issues').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('button', { name: '暂停任务' }))
    await waitFor(() => { expect(mocks.updateAutomation).toHaveBeenCalledWith('auto-1', { status: 'paused' }) })
  })
})