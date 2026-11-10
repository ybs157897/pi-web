import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutomations } from '../src/server/runtime/automations.ts'
import { RuntimeError } from '../src/server/runtime-errors.ts'
import { AppStateStore } from '../src/server/state/app-state.ts'
import type { Automation, ConversationDetail, SubmitInput, WorkspaceSummary } from '../src/shared/types.ts'

/** Every time assertion below is relative to this instant; fake timers freeze `Date.now()`. */
const NOW = Date.parse('2026-11-10T12:00:00Z')
const SHANGHAI = 'Asia/Shanghai'
/** Daily at 09:00 Shanghai (01:00Z); the next occurrence after NOW is 2026-11-11T01:00Z. */
const DAILY = 'DTSTART;TZID=Asia/Shanghai:20261101T090000\nRRULE:FREQ=DAILY'
const NEXT_DAILY = Date.parse('2026-11-11T01:00:00Z')
/** Every minute, anchored at NOW; the next occurrence after NOW is 2026-11-10T12:01:00Z. */
const MINUTELY = 'DTSTART:20261110T120000Z\nRRULE:FREQ=MINUTELY'
const NEXT_MINUTELY = Date.parse('2026-11-10T12:01:00Z')
/** One occurrence later today (13:00Z). */
const ONCE_TODAY = 'DTSTART:20261110T130000Z\nRRULE:FREQ=DAILY;COUNT=1'
/** A single occurrence already in the past: the rule has no future trigger. */
const EXHAUSTED = 'DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;COUNT=1'

let root: string
let appState: AppStateStore

const workspace: WorkspaceSummary = { id: 'ws-1', name: 'Code', path: '/code', createdAt: 1, updatedAt: 1 }

const detail = (id: string, error?: string): ConversationDetail => ({
  conversation: {
    id, title: 'Task', createdAt: 1, updatedAt: 1, archived: false, pinned: false, busy: false,
    thinkingLevel: 'medium', cwd: workspace.path,
  },
  messages: [], queue: [],
  ...(error === undefined ? {} : { error }),
} as unknown as ConversationDetail)

interface HarnessOptions {
  /** Conversations that already exist; `requireConversation` rejects anything else. */
  sessions?: string[]
  submit?: (conversationId: string, input: SubmitInput) => Promise<{ submissionId: string }>
  detailError?: (conversationId: string) => string | undefined
}

function service(options: HarnessOptions = {}) {
  const conversations: string[] = []
  const submits: { conversationId: string; input: SubmitInput }[] = []
  const known = new Set(options.sessions ?? [])
  let counter = 0
  const automations = createAutomations({
    appState,
    modelRuntime: { models: { getModel: () => undefined } } as never,
    isClosed: () => false,
    requireConversation: async (id: string) => {
      if (!known.has(id)) throw new RuntimeError('NOT_FOUND', '会话不存在')
      return { id: id as never, waitForIdle: async () => undefined }
    },
    currentDetail: async id => detail(String(id), options.detailError?.(String(id))),
    selectedWorkspace: () => workspace,
    assertModelAllowed: () => undefined,
    create: async () => {
      counter += 1
      const id = `conv-${counter}`
      conversations.push(id)
      known.add(id)
      return detail(id)
    },
    submit: async (conversationId, input) => {
      submits.push({ conversationId, input })
      return options.submit === undefined ? { submissionId: '1' } : await options.submit(conversationId, input)
    },
  })
  return { automations, conversations, submits }
}

/** The stored record, which is what later reads and the UI see. */
function stored(automations: ReturnType<typeof service>['automations'], id: string): Automation {
  const found = automations.list().find(item => item.id === id)
  if (found === undefined) throw new Error(`Missing automation ${id}`)
  return found
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  root = await mkdtemp(join(tmpdir(), 'pi-web-automations-'))
  appState = await AppStateStore.open({ dataDir: root, defaultWorkspace: workspace })
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('automation creation', () => {
  it('creates an active task by default when a rule is given', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Nightly', prompt: 'do it', rrule: DAILY, timeZone: SHANGHAI })
    expect(created.status).toBe('active')
    expect(created.target).toBe('new')
    expect(created.rrule).toBe(DAILY)
    expect(created.timeZone).toBe(SHANGHAI)
    expect(created.nextRunAt).toBe(NEXT_DAILY)
  })

  it('creates a paused manual task when no rule is given', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Manual', prompt: 'go' })
    expect(created.status).toBe('paused')
    expect(created.rrule).toBeUndefined()
    expect(created.nextRunAt).toBeUndefined()
  })

  it('rejects an active task without a rule', async () => {
    const { automations } = service()
    await expect(automations.create({ name: 'Bad', prompt: 'go', status: 'active' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects an empty or oversized name', async () => {
    const { automations } = service()
    await expect(automations.create({ name: '   ', prompt: 'go', rrule: DAILY }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(automations.create({ name: 'x'.repeat(121), prompt: 'go', rrule: DAILY }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects a malformed rule', async () => {
    const { automations } = service()
    await expect(automations.create({ name: 'Bad rule', prompt: 'go', rrule: 'FREQ=DAILY' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(automations.list()).toHaveLength(0)
  })

  it('requires a session for a session target and keeps it when given', async () => {
    const { automations } = service({ sessions: ['session-1'] })
    await expect(automations.create({ name: 'Session', prompt: 'go', rrule: DAILY, target: 'session' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const created = await automations.create({
      name: 'Session', prompt: 'go', rrule: DAILY, target: 'session', sessionId: 'session-1',
    })
    expect(created.target).toBe('session')
    expect(created.sessionId).toBe('session-1')
  })
})

describe('automation updates', () => {
  it('clears the next occurrence when paused and recomputes it when resumed', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    const paused = await automations.update(created.id, { status: 'paused' })
    expect(paused.status).toBe('paused')
    expect(paused.nextRunAt).toBeUndefined()

    const resumed = await automations.update(created.id, { status: 'active' })
    expect(resumed.status).toBe('active')
    expect(resumed.nextRunAt).toBe(NEXT_DAILY)
  })

  it('turns a task manual and pauses it when the rule is removed', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    const manual = await automations.update(created.id, { rrule: null })
    expect(manual.rrule).toBeUndefined()
    expect(manual.timeZone).toBeUndefined()
    expect(manual.status).toBe('paused')
    expect(manual.nextRunAt).toBeUndefined()
  })

  it('moves the next occurrence when the rule changes', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: MINUTELY, timeZone: SHANGHAI })
    expect(created.nextRunAt).toBe(NEXT_MINUTELY)

    const changed = await automations.update(created.id, { rrule: DAILY, timeZone: SHANGHAI })
    expect(changed.rrule).toBe(DAILY)
    expect(changed.nextRunAt).toBe(NEXT_DAILY)
  })

  it('rejects a malformed rule on update and leaves the task unchanged', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    await expect(automations.update(created.id, { rrule: 'garbage' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(stored(automations, created.id).nextRunAt).toBe(NEXT_DAILY)
  })
})

describe('automation runs', () => {
  it('opens a conversation for the new target and submits the framed prompt', async () => {
    const { automations, conversations, submits } = service()
    const created = await automations.create({ name: 'Report', prompt: 'deliver the report', rrule: DAILY, timeZone: SHANGHAI })
    const run = await automations.run(created.id)
    expect(run.conversationId).toBe('conv-1')
    expect(conversations).toEqual(['conv-1'])
    expect(submits).toHaveLength(1)
    expect(submits[0]?.conversationId).toBe('conv-1')
    expect(submits[0]?.input.whenBusy).toBe('reject')
    expect(submits[0]?.input.requestId).toMatch(/^automation:/u)

    await automations.drain()
    const record = stored(automations, created.id)
    expect(record.lastRun?.status).toBe('completed')
    expect(record.lastRun?.conversationId).toBe('conv-1')
    expect(record.lastRun?.plannedAt).toBe(NEXT_DAILY)
    expect(record.runs?.[0]?.status).toBe('completed')
  })

  it('reuses the first conversation for new_once', async () => {
    const { automations, conversations, submits } = service()
    const created = await automations.create({
      name: 'Digest', prompt: 'summarise', rrule: DAILY, timeZone: SHANGHAI, target: 'new_once',
    })
    await automations.run(created.id)
    await automations.drain()
    expect(stored(automations, created.id).sessionId).toBe('conv-1')

    await automations.run(created.id)
    await automations.drain()
    const record = stored(automations, created.id)
    expect(conversations).toEqual(['conv-1'])
    expect(submits.map(call => call.conversationId)).toEqual(['conv-1', 'conv-1'])
    expect(record.sessionId).toBe('conv-1')
    expect(record.runs?.map(item => item.conversationId)).toEqual(['conv-1', 'conv-1'])
    expect(record.runs?.every(item => item.status === 'completed')).toBe(true)
  })

  it('delivers into the session target without opening a conversation', async () => {
    const { automations, conversations, submits } = service({ sessions: ['session-1'] })
    const created = await automations.create({
      name: 'Reminder', prompt: 'drink water', rrule: DAILY, timeZone: SHANGHAI,
      target: 'session', sessionId: 'session-1',
    })
    const run = await automations.run(created.id)
    expect(conversations).toEqual([])
    expect(submits).toEqual([{
      conversationId: 'session-1',
      input: expect.objectContaining({ whenBusy: 'followUp', requestId: expect.stringMatching(/^automation:/u) }),
    }])
    expect(run.automation.lastRun?.status).toBe('delivered')
    expect(run.automation.lastRun?.conversationId).toBe('session-1')
    expect(stored(automations, created.id).nextRunAt).toBe(NEXT_DAILY)
  })

  it('frames the delivered prompt with the schedule identity and occurrence', async () => {
    const { automations, submits } = service({ sessions: ['session-1'] })
    const created = await automations.create({
      name: 'Reminder', prompt: 'deliver the report', rrule: DAILY, timeZone: SHANGHAI,
      target: 'session', sessionId: 'session-1',
    })
    await automations.run(created.id)
    expect(submits[0]?.input.text.split('\n')).toEqual([
      '[SCHEDULE REMINDER]',
      'This is a scheduled message from the user',
      `schedule_id_json: ${JSON.stringify(created.id)}`,
      'occurrence_at: 2026-11-11T01:00:00.000Z',
      'reminder_prompt_json: "deliver the report"',
    ])
  })

  it('refuses a second run while the last one is still running', async () => {
    const { automations, conversations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    await appState.update(state => {
      const record = state.automations.find(item => item.id === created.id)
      if (record !== undefined) record.lastRun = { id: 'run-1', status: 'running', startedAt: NOW }
    })
    await expect(automations.run(created.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(conversations).toEqual([])
  })

  it('records a failed run with its reason and advances the rule', async () => {
    const { automations } = service({ submit: async () => { throw new Error('boom') } })
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    await expect(automations.run(created.id)).rejects.toThrow('boom')
    const record = stored(automations, created.id)
    expect(record.lastRun?.status).toBe('failed')
    expect(record.lastRun?.error).toContain('boom')
    expect(record.nextRunAt).toBe(NEXT_DAILY)
  })

  it('ends a task once its COUNT=1 rule has fired', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Once', prompt: 'go', rrule: ONCE_TODAY })
    expect(created.nextRunAt).toBe(Date.parse('2026-11-10T13:00:00Z'))

    // The occurrence has passed by the time the run finishes, so nothing is left to schedule.
    vi.setSystemTime(Date.parse('2026-11-10T13:05:00Z'))
    await automations.run(created.id)
    await automations.drain()

    const record = stored(automations, created.id)
    expect(record.status).toBe('ended')
    expect(record.nextRunAt).toBeUndefined()
    expect(record.lastRun?.status).toBe('completed')
    expect(record.lastRun?.plannedAt).toBe(Date.parse('2026-11-10T13:00:00Z'))
  })
})

describe('automation maintenance', () => {
  it('purges ended tasks and reports how many were removed', async () => {
    const { automations } = service()
    const ended = await automations.create({ name: 'Ended', prompt: 'go', rrule: EXHAUSTED })
    expect(ended.status).toBe('ended')
    const active = await automations.create({ name: 'Active', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })

    expect(await automations.purgeEnded()).toBe(1)
    expect(automations.list().map(item => item.id)).toEqual([active.id])
    expect(await automations.purgeEnded()).toBe(0)
  })

  it('provisions a built-in task once and keeps its prompt in sync', async () => {
    const { automations } = service()
    const provisioned = await automations.ensureBuiltin({
      key: 'wetrack-analysis-daily', name: 'Nightly issues', prompt: 'analyse',
      rrule: DAILY, timeZone: SHANGHAI, workspaceId: workspace.id,
    })
    expect(provisioned.builtin).toBe('wetrack-analysis-daily')
    expect(provisioned.status).toBe('active')
    expect(provisioned.workspaceId).toBe(workspace.id)
    expect(automations.list()).toHaveLength(1)

    // A second call finds the same task instead of creating another one, and refreshes
    // the server-owned prompt.
    const again = await automations.ensureBuiltin({
      key: 'wetrack-analysis-daily', name: 'Nightly issues', prompt: 'analyse v2',
      rrule: DAILY, timeZone: SHANGHAI, workspaceId: workspace.id,
    })
    expect(again.id).toBe(provisioned.id)
    expect(again.prompt).toBe('analyse v2')
    expect(automations.list()).toHaveLength(1)
  })

  it('migrates legacy records, interrupts running runs and pauses unusable rules', async () => {
    const { automations } = service()
    await appState.update(state => {
      state.automations = [
        {
          id: 'legacy-daily', name: 'Legacy daily', prompt: 'go', enabled: true,
          schedule: { unit: 'day', timeOfDay: '09:00' }, timeZone: SHANGHAI,
          createdAt: 1, updatedAt: 1,
          lastRun: { id: 'run-1', status: 'running', startedAt: 2 },
        },
        {
          id: 'broken', name: 'Broken', prompt: 'go', status: 'active', target: 'new',
          rrule: 'not a rule', createdAt: 1, updatedAt: 1,
        },
        {
          id: 'paused', name: 'Paused', prompt: 'go', status: 'paused', target: 'new',
          rrule: DAILY, nextRunAt: 123, createdAt: 1, updatedAt: 1,
        },
      ] as unknown as Automation[]
    })
    await automations.recover()

    const migrated = stored(automations, 'legacy-daily')
    expect(migrated.status).toBe('active')
    expect(migrated.target).toBe('new')
    expect(migrated.rrule).toBe('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY')
    expect(migrated.nextRunAt).toBe(NEXT_DAILY)
    expect(migrated).not.toHaveProperty('enabled')
    expect(migrated).not.toHaveProperty('schedule')
    expect(migrated.lastRun?.status).toBe('interrupted')
    expect(migrated.lastRun?.error).toContain('重新启动')
    expect(migrated.lastRun?.finishedAt).toBe(NOW)

    const broken = stored(automations, 'broken')
    expect(broken.status).toBe('paused')
    expect(broken.nextRunAt).toBeUndefined()

    const paused = stored(automations, 'paused')
    expect(paused.status).toBe('paused')
    expect(paused.nextRunAt).toBeUndefined()
  })
})