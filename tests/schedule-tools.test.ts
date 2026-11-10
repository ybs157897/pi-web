import { describe, expect, it } from 'vitest'
import { createScheduleExtension, type ScheduleService } from '../src/server/tools/schedule.ts'
import type { Automation, CreateAutomationInput, UpdateAutomationInput } from '../src/shared/types.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z')
/** A valid rule with an occurrence far in the future, so resumption stays possible. */
const FUTURE = 'DTSTART:29990101T000000Z\nRRULE:FREQ=DAILY'
/** A COUNT=1 rule whose only occurrence is already past. */
const EXHAUSTED = 'DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;COUNT=1'
const DAILY_RULE = 'DTSTART;TZID=UTC:20261101T090000\nRRULE:FREQ=DAILY'

const API = { conversationId: 'conversation-7' }
const CONTEXT = {} as never

type ToolResult = {
  output: { type: string; text: string }[]
  details: unknown
}

type RegisteredTool = {
  name: string
  execute(args: never, api: never, context: never): Promise<ToolResult>
}

function automation(patch: Partial<Automation> & Pick<Automation, 'id' | 'name'>): Automation {
  return {
    prompt: 'go',
    status: 'active',
    target: 'new',
    rrule: FUTURE,
    timeZone: 'UTC',
    nextRunAt: NOW + 60_000,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  }
}

/**
 * In-memory `ScheduleService`. `list` returns clones, as the real service does, so the
 * tools cannot mutate stored records by accident.
 */
function fakeService(items: Automation[] = []) {
  const creates: CreateAutomationInput[] = []
  const updates: { id: string; input: UpdateAutomationInput }[] = []
  const removed: string[] = []
  const runs: string[] = []
  let counter = 0
  const service: ScheduleService = {
    list: () => items.map(item => structuredClone(item)),
    create: async input => {
      creates.push(structuredClone(input))
      counter += 1
      const created: Automation = {
        id: `auto-${counter}`,
        name: input.name,
        prompt: input.prompt,
        status: input.status ?? (input.rrule === undefined ? 'paused' : 'active'),
        target: input.target ?? 'new',
        ...(input.rrule === undefined ? {} : { rrule: input.rrule, timeZone: input.timeZone ?? 'UTC' }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.rrule === undefined ? {} : { nextRunAt: NOW + 60_000 }),
        createdAt: NOW,
        updatedAt: NOW,
      }
      items.push(created)
      return structuredClone(created)
    },
    update: async (id, input) => {
      updates.push({ id, input: structuredClone(input) })
      const current = items.find(item => item.id === id)
      if (current === undefined) throw new Error(`Missing ${id}`)
      if (input.name !== undefined) current.name = input.name
      if (input.prompt !== undefined) current.prompt = input.prompt
      if (input.rrule === null) {
        delete current.rrule
        delete current.timeZone
      } else if (input.rrule !== undefined) {
        current.rrule = input.rrule
        current.timeZone = input.timeZone ?? current.timeZone ?? 'UTC'
      } else if (input.timeZone !== undefined) {
        current.timeZone = input.timeZone
      }
      if (input.target !== undefined) current.target = input.target
      if (input.sessionId === null) delete current.sessionId
      else if (input.sessionId !== undefined) current.sessionId = input.sessionId
      if (input.status !== undefined) current.status = input.status
      current.updatedAt = NOW + 1
      return structuredClone(current)
    },
    remove: async id => {
      removed.push(id)
      const index = items.findIndex(item => item.id === id)
      if (index >= 0) items.splice(index, 1)
    },
    run: async id => {
      runs.push(id)
      const found = items.find(item => item.id === id)
      if (found === undefined) throw new Error(`Missing ${id}`)
      return { automation: structuredClone(found), conversationId: 'conv-1' }
    },
  }
  return { service, creates, updates, removed, runs, items }
}

function tools(service: ScheduleService) {
  const extension = createScheduleExtension({ automations: service })
  const find = (name: string): RegisteredTool => {
    const found = extension.tools?.find(candidate => candidate.name === name)
    if (found === undefined) throw new Error(`Missing ${name} tool`)
    return found as unknown as RegisteredTool
  }
  return { extension, create: find('schedule_create'), edit: find('schedule_edit'), list: find('schedule_list'), view: find('schedule_view') }
}

type ListDetails = { items: { id: string }[]; total: number; nextOffset: number | null }

describe('schedule_create', () => {
  it('maps this_session to a session target on the calling conversation', async () => {
    const fake = fakeService()
    const result = await tools(fake.service).create.execute({
      title: '喝水提醒', prompt: '该喝水了', rrule: FUTURE, target: 'this_session',
    } as never, API as never, CONTEXT)

    expect(fake.creates).toHaveLength(1)
    expect(fake.creates[0]).toMatchObject({
      name: '喝水提醒', prompt: '该喝水了', rrule: FUTURE, target: 'session',
      sessionId: 'conversation-7', status: 'active',
    })
    expect(result.output[0]?.text).toContain('Created schedule auto-1')
    expect(result.output[0]?.text).toContain('next occurrence 2026-11-10T12:01:00.000Z')
    expect(result.details).toMatchObject({ id: 'auto-1', target: 'session', sessionId: 'conversation-7', status: 'active' })
  })

  it('keeps new targets without a session id', async () => {
    const fake = fakeService()
    await tools(fake.service).create.execute({
      title: '报告', prompt: '生成报告', rrule: FUTURE, target: 'new_once',
    } as never, API as never, CONTEXT)
    expect(fake.creates[0]).toMatchObject({ target: 'new_once' })
    expect(fake.creates[0]?.sessionId).toBeUndefined()
  })

  it('rejects an oversized or empty title, an empty prompt and a malformed rule', async () => {
    const fake = fakeService()
    const create = tools(fake.service).create
    await expect(create.execute({
      title: 'x'.repeat(121), prompt: 'go', rrule: FUTURE, target: 'new',
    } as never, API as never, CONTEXT)).rejects.toThrow(/limited to 120/u)
    await expect(create.execute({
      title: '   ', prompt: 'go', rrule: FUTURE, target: 'new',
    } as never, API as never, CONTEXT)).rejects.toThrow(/non-empty/u)
    await expect(create.execute({
      title: 'Task', prompt: '   ', rrule: FUTURE, target: 'new',
    } as never, API as never, CONTEXT)).rejects.toThrow(/non-empty/u)
    await expect(create.execute({
      title: 'Task', prompt: 'go', rrule: 'FREQ=DAILY', target: 'new',
    } as never, API as never, CONTEXT)).rejects.toThrow(/DTSTART/u)
    expect(fake.creates).toHaveLength(0)
  })
})

describe('schedule_edit', () => {
  it('deletes through the service', async () => {
    const fake = fakeService([automation({ id: 'auto-1', name: 'Reminder' })])
    const result = await tools(fake.service).edit.execute({
      id: 'auto-1', action: 'delete',
    } as never, API as never, CONTEXT)
    expect(fake.removed).toEqual(['auto-1'])
    expect(result.output[0]?.text).toBe('Deleted schedule auto-1.')
    expect(result.details).toEqual({ id: 'auto-1', deleted: true })
  })

  it('rejects an update with no fields', async () => {
    const fake = fakeService([automation({ id: 'auto-1', name: 'Reminder' })])
    await expect(tools(fake.service).edit.execute({
      id: 'auto-1', action: 'update',
    } as never, API as never, CONTEXT)).rejects.toThrow(/at least one field/u)
    expect(fake.updates).toHaveLength(0)
  })

  it('applies the provided fields and maps this_session on update', async () => {
    const fake = fakeService([automation({ id: 'auto-1', name: 'Reminder', status: 'paused' })])
    const result = await tools(fake.service).edit.execute({
      id: 'auto-1', action: 'update', title: '新提醒', target: 'this_session', active: true,
    } as never, API as never, CONTEXT)
    expect(fake.updates[0]?.input).toMatchObject({
      name: '新提醒', target: 'session', sessionId: 'conversation-7', status: 'active',
    })
    expect(result.output[0]?.text).toContain('Updated schedule auto-1')
    expect(result.output[0]?.text).toContain('status active')
  })

  it('refuses to resume a task whose rule has no future occurrence', async () => {
    const fake = fakeService([
      automation({ id: 'exhausted', name: 'Old', status: 'paused', rrule: EXHAUSTED }),
      automation({ id: 'manual', name: 'Manual', status: 'paused', rrule: undefined, nextRunAt: undefined }),
    ])
    const edit = tools(fake.service).edit
    await expect(edit.execute({ id: 'exhausted', action: 'update', active: true } as never, API as never, CONTEXT))
      .rejects.toThrow(/no future occurrence/u)
    await expect(edit.execute({ id: 'manual', action: 'update', active: true } as never, API as never, CONTEXT))
      .rejects.toThrow(/no recurrence rule/u)
    expect(fake.updates).toHaveLength(0)
  })

  it('rejects a stale expectedUpdatedAt and accepts the current one', async () => {
    const fake = fakeService([automation({ id: 'auto-1', name: 'Reminder' })])
    const edit = tools(fake.service).edit
    await expect(edit.execute({
      id: 'auto-1', action: 'update', title: 'stale',
      expectedUpdatedAt: new Date(NOW + 1_000).toISOString(),
    } as never, API as never, CONTEXT)).rejects.toThrow(/schedule_conflict/u)
    expect(fake.updates).toHaveLength(0)

    await edit.execute({
      id: 'auto-1', action: 'update', title: 'fresh',
      expectedUpdatedAt: new Date(NOW).toISOString(),
    } as never, API as never, CONTEXT)
    expect(fake.updates[0]?.input).toMatchObject({ name: 'fresh' })
  })
})

describe('schedule_list', () => {
  function seeded() {
    return fakeService([
      automation({ id: 'active-late', name: 'Late', nextRunAt: NOW + 300_000 }),
      automation({ id: 'active-soon', name: 'Soon', nextRunAt: NOW + 100_000 }),
      automation({ id: 'active-middle', name: 'Middle', nextRunAt: NOW + 200_000 }),
      automation({ id: 'paused-newer', name: 'Paused newer', status: 'paused', nextRunAt: undefined, updatedAt: NOW - 1_000 }),
      automation({ id: 'ended-older', name: 'Ended older', status: 'ended', nextRunAt: undefined, updatedAt: NOW - 2_000 }),
    ])
  }

  it('filters active tasks, orders by next occurrence and pages with nextOffset', async () => {
    const fake = seeded()
    const list = tools(fake.service).list

    const first = await list.execute({ active: true, limit: 2 } as never, API as never, CONTEXT)
    const firstDetails = first.details as ListDetails
    expect(firstDetails.items.map(item => item.id)).toEqual(['active-soon', 'active-middle'])
    expect(firstDetails.total).toBe(3)
    expect(firstDetails.nextOffset).toBe(2)
    expect(first.output[0]?.text).toContain('next offset: 2')

    const second = await list.execute({ active: true, limit: 2, offset: 2 } as never, API as never, CONTEXT)
    const secondDetails = second.details as ListDetails
    expect(secondDetails.items.map(item => item.id)).toEqual(['active-late'])
    expect(secondDetails.nextOffset).toBeNull()
    expect(second.output[0]?.text).toContain('end of list')
  })

  it('lists paused and ended tasks together when active=false', async () => {
    const fake = seeded()
    const result = await tools(fake.service).list.execute({ active: false } as never, API as never, CONTEXT)
    const details = result.details as ListDetails
    expect(details.items.map(item => item.id)).toEqual(['paused-newer', 'ended-older'])
    expect(details.total).toBe(2)
  })

  it('lists everything with active tasks first when the filter is omitted', async () => {
    const fake = seeded()
    const result = await tools(fake.service).list.execute({} as never, API as never, CONTEXT)
    const details = result.details as ListDetails
    expect(details.total).toBe(5)
    expect(details.items.map(item => item.id)).toEqual([
      'active-soon', 'active-middle', 'active-late', 'paused-newer', 'ended-older',
    ])
  })

  it('reports an empty list', async () => {
    const fake = fakeService()
    const result = await tools(fake.service).list.execute({} as never, API as never, CONTEXT)
    expect(result.output[0]?.text).toBe('No scheduled tasks (total 0).')
    expect(result.details).toMatchObject({ items: [], total: 0, nextOffset: null })
  })
})

describe('schedule_view', () => {
  it('prints the task, its rule and its recent runs', async () => {
    const fake = fakeService([
      automation({
        id: 'auto-1', name: 'Reminder', prompt: 'drink water', rrule: DAILY_RULE,
        runs: [{ id: 'run-1', status: 'delivered', finishedAt: NOW }],
      }),
    ])
    const result = await tools(fake.service).view.execute({ id: 'auto-1' } as never, API as never, CONTEXT)
    const text = result.output[0]?.text ?? ''
    expect(text).toContain('auto-1 [active] Reminder')
    expect(text).toContain('prompt: "drink water"')
    expect(text).toContain(DAILY_RULE)
    expect(text).toContain('recent runs: delivered@2026-11-10T12:00:00.000Z')
    expect(result.details).toMatchObject({ id: 'auto-1', rrule: DAILY_RULE })
  })

  it('says a task has no runs yet and refuses an unknown id', async () => {
    const fake = fakeService([automation({ id: 'auto-1', name: 'Reminder' })])
    const view = tools(fake.service).view
    const result = await view.execute({ id: 'auto-1' } as never, API as never, CONTEXT)
    expect(result.output[0]?.text).toContain('no runs yet')
    await expect(view.execute({ id: 'missing' } as never, API as never, CONTEXT))
      .rejects.toThrow(/No scheduled task has id missing/u)
  })
})

describe('schedule authorization section', () => {
  const POLICY = '只有在用户明确要求时才创建或修改定时任务；当前正在执行的定时任务所依据的既有授权继续有效。'

  function render(offered: string[], callable: string[] = []): Promise<string | undefined> {
    const section = tools(fakeService().service).extension.sections?.find(candidate => candidate.key === 'schedule-policy')
    if (section === undefined) throw new Error('Missing schedule section')
    const run = section.render as unknown as (input: unknown, context: unknown) => string | undefined | Promise<string | undefined>
    return Promise.resolve(run({
      agent: { tools: offered.map(name => ({ name })), callable: callable.map(name => ({ name })) },
    }, CONTEXT))
  }

  it('stays silent where no schedule tool is visible', async () => {
    expect(await render([])).toBeUndefined()
    expect(await render(['read', 'schedule_list', 'schedule_view'])).toBeUndefined()
  })

  it('renders the authorization text when create or edit is visible', async () => {
    expect(await render(['schedule_create'])).toBe(POLICY)
    expect(await render(['read', 'schedule_edit'])).toBe(POLICY)
    expect(await render(['codemode'], ['schedule_edit'])).toBe(POLICY)
  })
})