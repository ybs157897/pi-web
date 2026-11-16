import { describe, expect, it } from 'vitest'
import { createScheduleExtension, type ScheduleService } from '../src/server/tools/schedule.ts'
import type { Automation, CreateAutomationInput, UpdateAutomationInput } from '../src/shared/types.ts'

/**
 * 定时任务工具（schedule_create/edit/list/view）契约测试：
 * this_session 目标映射、输入校验、规则恢复检查、乐观并发（expectedUpdatedAt）、
 * 列表过滤排序分页，以及提示词中的授权策略 section。
 */
const NOW = Date.parse('2026-11-10T12:00:00Z')
/** 合法规则，且下一次发生远在未来，恢复（resume）保持可行。 */
const FUTURE = 'DTSTART:29990101T000000Z\nRRULE:FREQ=DAILY'
/** COUNT=1 的规则，唯一一次发生已过去——无法恢复。 */
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

/**
 * 构造自动化任务 fixture。
 * @param patch 覆盖默认字段（id/name 必填）
 * @returns 活跃、指向新会话、下一次运行在 NOW+60s 的基准任务
 */
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
 * 内存版 `ScheduleService` 桩，记录各方法的调用便于断言。
 * `list` 与真实服务一样返回克隆，工具无法意外改到存储记录。
 * @returns service 及 creates/updates/removed/runs/items 观察口
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

/**
 * 从扩展中取四个定时任务工具。
 * @returns extension 与 create/edit/list/view 工具定义（缺失抛错）
 */
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
  // 目标映射：this_session 解析为调用方会话（target=session + sessionId），
  // 输出文本带创建结果与下一次发生时间。
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

  // 边界：新会话目标（new_once/new）不带 sessionId。
  it('keeps new targets without a session id', async () => {
    const fake = fakeService()
    await tools(fake.service).create.execute({
      title: '报告', prompt: '生成报告', rrule: FUTURE, target: 'new_once',
    } as never, API as never, CONTEXT)
    expect(fake.creates[0]).toMatchObject({ target: 'new_once' })
    expect(fake.creates[0]?.sessionId).toBeUndefined()
  })

  // 输入校验：标题超 120 字符或空白、prompt 空白、规则缺 DTSTART 全部拒绝，
  // 且不得调用服务。
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
  // 删除动作透传服务，输出与 details 都确认删除。
  it('deletes through the service', async () => {
    const fake = fakeService([automation({ id: 'auto-1', name: 'Reminder' })])
    const result = await tools(fake.service).edit.execute({
      id: 'auto-1', action: 'delete',
    } as never, API as never, CONTEXT)
    expect(fake.removed).toEqual(['auto-1'])
    expect(result.output[0]?.text).toBe('Deleted schedule auto-1.')
    expect(result.details).toEqual({ id: 'auto-1', deleted: true })
  })

  // 边界：update 不带任何字段直接拒绝，不触达服务。
  it('rejects an update with no fields', async () => {
    const fake = fakeService([automation({ id: 'auto-1', name: 'Reminder' })])
    await expect(tools(fake.service).edit.execute({
      id: 'auto-1', action: 'update',
    } as never, API as never, CONTEXT)).rejects.toThrow(/at least one field/u)
    expect(fake.updates).toHaveLength(0)
  })

  // 更新映射：字段按提供者应用，this_session 同样解析为调用方会话；
  // active:true 映射为 status active。
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

  // 恢复守门：规则已耗尽（无未来发生）与无规则的手动任务都拒绝恢复，
  // 避免激活一个永远不会跑的任务。
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

  // 乐观并发：陈旧的 expectedUpdatedAt 报 schedule_conflict；携带当前值则放行。
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
  /**
   * 构造 5 条覆盖各状态/时间的任务样本：
   * 3 条活跃（nextRunAt 早晚不一）、1 条暂停、1 条已结束。
   */
  function seeded() {
    return fakeService([
      automation({ id: 'active-late', name: 'Late', nextRunAt: NOW + 300_000 }),
      automation({ id: 'active-soon', name: 'Soon', nextRunAt: NOW + 100_000 }),
      automation({ id: 'active-middle', name: 'Middle', nextRunAt: NOW + 200_000 }),
      automation({ id: 'paused-newer', name: 'Paused newer', status: 'paused', nextRunAt: undefined, updatedAt: NOW - 1_000 }),
      automation({ id: 'ended-older', name: 'Ended older', status: 'ended', nextRunAt: undefined, updatedAt: NOW - 2_000 }),
    ])
  }

  // 列表契约：active=true 只留活跃任务、按下一次发生时间升序、
  // limit/offset 分页（nextOffset 为 null 表示到底）。
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

  // active=false 时暂停与已结束合并列出，按更新时间新→旧。
  it('lists paused and ended tasks together when active=false', async () => {
    const fake = seeded()
    const result = await tools(fake.service).list.execute({ active: false } as never, API as never, CONTEXT)
    const details = result.details as ListDetails
    expect(details.items.map(item => item.id)).toEqual(['paused-newer', 'ended-older'])
    expect(details.total).toBe(2)
  })

  // 省略过滤时全部列出，活跃任务排在前面。
  it('lists everything with active tasks first when the filter is omitted', async () => {
    const fake = seeded()
    const result = await tools(fake.service).list.execute({} as never, API as never, CONTEXT)
    const details = result.details as ListDetails
    expect(details.total).toBe(5)
    expect(details.items.map(item => item.id)).toEqual([
      'active-soon', 'active-middle', 'active-late', 'paused-newer', 'ended-older',
    ])
  })

  // 空列表边界：输出「total 0」而非报错。
  it('reports an empty list', async () => {
    const fake = fakeService()
    const result = await tools(fake.service).list.execute({} as never, API as never, CONTEXT)
    expect(result.output[0]?.text).toBe('No scheduled tasks (total 0).')
    expect(result.details).toMatchObject({ items: [], total: 0, nextOffset: null })
  })
})

describe('schedule_view', () => {
  // 详情视图：任务行（id + 状态 + 名称）、prompt、RRULE 原文与最近运行记录。
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

  // 边界：无运行记录时明说「no runs yet」；未知 id 报带 id 的错误。
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
  // 授权策略文案（pin）：创建/修改定时任务需用户明确要求，既有授权继续有效。
  const POLICY = '只有在用户明确要求时才创建或修改定时任务；当前正在执行的定时任务所依据的既有授权继续有效。'

  /**
   * 渲染 schedule-policy section。
   * @param offered 本请求可见的工具名
   * @param callable 可调用集合（codemode 场景）
   */
  function render(offered: string[], callable: string[] = []): Promise<string | undefined> {
    const section = tools(fakeService().service).extension.sections?.find(candidate => candidate.key === 'schedule-policy')
    if (section === undefined) throw new Error('Missing schedule section')
    const run = section.render as unknown as (input: unknown, context: unknown) => string | undefined | Promise<string | undefined>
    return Promise.resolve(run({
      agent: { tools: offered.map(name => ({ name })), callable: callable.map(name => ({ name })) },
    }, CONTEXT))
  }

  // 只读工具（list/view）不触发授权文案，section 保持沉默。
  it('stays silent where no schedule tool is visible', async () => {
    expect(await render([])).toBeUndefined()
    expect(await render(['read', 'schedule_list', 'schedule_view'])).toBeUndefined()
  })

  // create/edit 可见（含经 codemode 可调用）时渲染完整授权文案，逐字一致。
  it('renders the authorization text when create or edit is visible', async () => {
    expect(await render(['schedule_create'])).toBe(POLICY)
    expect(await render(['read', 'schedule_edit'])).toBe(POLICY)
    expect(await render(['codemode'], ['schedule_edit'])).toBe(POLICY)
  })
})