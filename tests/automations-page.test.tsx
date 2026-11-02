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
}))

vi.mock('../src/web/api.ts', () => ({ api: mocks }))

const { default: AutomationsPage } = await import('../src/web/AutomationsPage.tsx')

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0)

function task(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1', name: 'Nightly issues', prompt: 'analyse the list', enabled: true,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

beforeEach(() => {
  setupRenderingDom()
  mocks.listAutomations.mockReset()
  mocks.createAutomation.mockReset()
  mocks.updateAutomation.mockReset()
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('automations page', () => {
  it('describes a calendar schedule and its next due time', async () => {
    mocks.listAutomations.mockResolvedValue({
      automations: [task({ schedule: { unit: 'day', timeOfDay: '17:00' }, nextRunAt: NOW + 3600_000 })],
    })
    render(<AutomationsPage onOpenConversation={() => {}} />)
    await waitFor(() => { expect(screen.getByText(/每天 17:00/)).toBeTruthy() })
    expect(screen.getByText(/下次/)).toBeTruthy()
  })

  it('keeps the fixed-interval tasks readable', async () => {
    mocks.listAutomations.mockResolvedValue({ automations: [task({ intervalMs: 30 * 60_000 })] })
    render(<AutomationsPage onOpenConversation={() => {}} />)
    await waitFor(() => { expect(screen.getByText(/每 30 分钟/)).toBeTruthy() })
  })

  it('lists the run history and opens a run in its conversation', async () => {
    const opened: string[] = []
    mocks.listAutomations.mockResolvedValue({
      automations: [task({
        runs: [
          { id: 'run-2', status: 'failed', conversationId: 'conv-2', startedAt: NOW, finishedAt: NOW + 60_000, error: 'boom' },
          { id: 'run-1', status: 'completed', conversationId: 'conv-1', startedAt: NOW - 60_000, finishedAt: NOW },
        ],
      })],
    })
    render(<AutomationsPage onOpenConversation={id => { opened.push(id) }} />)
    await waitFor(() => { expect(screen.getByText('执行记录')).toBeTruthy() })
    expect(screen.getByText('2 次')).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: '打开会话' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    expect(opened).toEqual(['conv-2'])
  })

  it('marks a built-in task and saves a weekly schedule with a time and a weekday', async () => {
    mocks.listAutomations.mockResolvedValue({ automations: [task({ builtin: 'wetrack-analysis-daily' })] })
    mocks.createAutomation.mockResolvedValue({ automation: task({ id: 'auto-new', schedule: { unit: 'week', timeOfDay: '09:00', dayOfWeek: 3 } }) })
    render(<AutomationsPage onOpenConversation={() => {}} />)
    await waitFor(() => { expect(screen.getByText('内置')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: /新建任务/ }))
    await waitFor(() => { expect(screen.getByText('重复方式')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '每周' }))
    const time = screen.getByLabelText('执行时间') as HTMLInputElement
    fireEvent.change(time, { target: { value: '09:30' } })
    fireEvent.click(screen.getByRole('button', { name: '三' }))
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: 'Weekly issues' } })
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'do the work' } })
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }))

    await waitFor(() => { expect(mocks.createAutomation).toHaveBeenCalled() })
    expect(mocks.createAutomation.mock.calls[0]![0]).toMatchObject({
      name: 'Weekly issues',
      schedule: { unit: 'week', timeOfDay: '09:30', dayOfWeek: 3 },
    })
  })
})
