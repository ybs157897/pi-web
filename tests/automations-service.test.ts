import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAutomations } from '../src/server/runtime/automations.ts'
import { AppStateStore } from '../src/server/state/app-state.ts'
import type { ConversationDetail, WorkspaceSummary } from '../src/shared/types.ts'

let root: string
let appState: AppStateStore

const workspace: WorkspaceSummary = { id: 'ws-1', name: 'Code', path: 'D:/code', createdAt: 1, updatedAt: 1 }

const detail = (id: string, error?: string): ConversationDetail => ({
  conversation: {
    id, title: 'Task', createdAt: 1, updatedAt: 1, archived: false, pinned: false, busy: false,
    thinkingLevel: 'medium', cwd: workspace.path,
  },
  messages: [], queue: [],
  ...(error === undefined ? {} : { error }),
} as unknown as ConversationDetail)

function service(overrides: { submit?: () => Promise<unknown>; create?: () => Promise<ConversationDetail> } = {}) {
  const created: string[] = []
  let counter = 0
  const automations = createAutomations({
    appState,
    modelRuntime: { models: { getModel: () => undefined } } as never,
    isClosed: () => false,
    requireConversation: async (id: string) => ({ id: id as never, waitForIdle: async () => undefined }),
    currentDetail: async (id: string) => detail(String(id)),
    selectedWorkspace: () => workspace,
    selectedPreset: () => undefined,
    assertModelAllowed: () => undefined,
    create: async () => {
      counter += 1
      const id = `conv-${counter}`
      created.push(id)
      return overrides.create === undefined ? detail(id) : await overrides.create()
    },
    submit: async () => (overrides.submit === undefined ? { submissionId: '1' } : await overrides.submit() as never),
  })
  return { automations, created }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-web-automations-'))
  appState = await AppStateStore.open({ dataDir: root, defaultWorkspace: workspace })
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('automation schedules', () => {
  it('schedules a daily task at the chosen wall-clock time', async () => {
    const { automations } = service()
    const created = await automations.create({
      name: 'Nightly', prompt: 'do it', schedule: { unit: 'day', timeOfDay: '17:00' },
    })
    expect(created.enabled).toBe(true)
    expect(created.schedule).toEqual({ unit: 'day', timeOfDay: '17:00' })
    expect(created.nextRunAt).toBeGreaterThan(Date.now())
    const due = new Date(created.nextRunAt!)
    expect(due.getHours()).toBe(17)
    expect(due.getMinutes()).toBe(0)
  })

  it('keeps the minute interval and the calendar schedule exclusive', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', intervalMs: 30 * 60_000 })
    expect(created.schedule).toBeUndefined()
    expect(created.intervalMs).toBe(30 * 60_000)

    const withSchedule = await automations.update(created.id, {
      schedule: { unit: 'week', timeOfDay: '09:00', dayOfWeek: 1 }, intervalMs: null,
    })
    expect(withSchedule.schedule).toEqual({ unit: 'week', timeOfDay: '09:00', dayOfWeek: 1 })
    expect(withSchedule.intervalMs).toBeUndefined()

    const backToMinutes = await automations.update(created.id, {
      schedule: null, intervalMs: 15 * 60_000,
    })
    expect(backToMinutes.schedule).toBeUndefined()
    expect(backToMinutes.intervalMs).toBe(15 * 60_000)
  })

  it('rejects a malformed schedule', async () => {
    const { automations } = service()
    await expect(automations.create({
      name: 'Task', prompt: 'go', schedule: { unit: 'day', timeOfDay: '25:00' },
    })).rejects.toThrow(/HH:MM/)
    await expect(automations.create({
      name: 'Task', prompt: 'go', schedule: { unit: 'week', timeOfDay: '09:00', dayOfWeek: 9 },
    })).rejects.toThrow(/0-6/)
  })
})

describe('automation run history', () => {
  it('keeps every run, newest first, and links it to its conversation', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', schedule: { unit: 'day', timeOfDay: '00:00' } })
    const first = await automations.run(created.id)
    await automations.drain()
    const second = await automations.run(created.id)
    await automations.drain()

    const stored = automations.list().find(item => item.id === created.id)!
    expect(stored.runs).toHaveLength(2)
    expect(stored.runs?.[0]?.id).toBe(second.automation.lastRun?.id)
    expect(stored.runs?.[1]?.id).toBe(first.automation.lastRun?.id)
    expect(stored.runs?.every(run => run.status === 'completed')).toBe(true)
    expect(stored.runs?.every(run => run.conversationId !== undefined)).toBe(true)
    expect(stored.runs?.[0]?.conversationId).not.toBe(stored.runs?.[1]?.conversationId)
    expect(automations.runs(created.id)).toHaveLength(2)
  })

  it('records a failed run with its reason', async () => {
    const { automations } = service({ submit: async () => { throw new Error('boom') } })
    const created = await automations.create({ name: 'Task', prompt: 'go', schedule: { unit: 'day', timeOfDay: '00:00' } })
    await expect(automations.run(created.id)).rejects.toThrow('boom')
    const stored = automations.list().find(item => item.id === created.id)!
    expect(stored.runs?.[0]?.status).toBe('failed')
    expect(stored.runs?.[0]?.error).toContain('boom')
  })
})

describe('built-in automations', () => {
  it('provisions a built-in task once and keeps its workspace in sync', async () => {
    const { automations } = service()
    const provisioned = await automations.ensureBuiltin({
      key: 'wetrack-analysis-daily', name: 'Nightly issues', prompt: 'analyse',
      schedule: { unit: 'day', timeOfDay: '00:00' }, workspaceId: workspace.id,
    })
    expect(provisioned.builtin).toBe('wetrack-analysis-daily')
    expect(provisioned.enabled).toBe(true)
    expect(automations.list()).toHaveLength(1)

    // A second call finds the same task instead of creating another one.
    const again = await automations.ensureBuiltin({
      key: 'wetrack-analysis-daily', name: 'Nightly issues', prompt: 'analyse',
      schedule: { unit: 'day', timeOfDay: '00:00' }, workspaceId: workspace.id,
    })
    expect(again.id).toBe(provisioned.id)
    expect(automations.list()).toHaveLength(1)
  })
})
