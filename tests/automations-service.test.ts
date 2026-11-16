import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutomations } from '../src/server/runtime/automations.ts'
import { RuntimeError } from '../src/server/runtime-errors.ts'
import { AppStateStore } from '../src/server/state/app-state.ts'
import type { Automation, ConversationDetail, SubmitInput, WorkspaceSummary } from '../src/shared/types.ts'

/** 下面所有时间断言都相对这一瞬间；fake timers 冻结 Date.now()。 */
const NOW = Date.parse('2026-11-10T12:00:00Z')
const SHANGHAI = 'Asia/Shanghai'
/** 上海每天 09:00（即 01:00Z）；NOW 之后的下一次触发是 2026-11-11T01:00Z。 */
const DAILY = 'DTSTART;TZID=Asia/Shanghai:20261101T090000\nRRULE:FREQ=DAILY'
const NEXT_DAILY = Date.parse('2026-11-11T01:00:00Z')
/** 每分钟一次，锚定在 NOW；NOW 之后下一次触发是 2026-11-10T12:01:00Z。 */
const MINUTELY = 'DTSTART:20261110T120000Z\nRRULE:FREQ=MINUTELY'
const NEXT_MINUTELY = Date.parse('2026-11-10T12:01:00Z')
/** 今天稍后（13:00Z）的一次触发。 */
const ONCE_TODAY = 'DTSTART:20261110T130000Z\nRRULE:FREQ=DAILY;COUNT=1'
/** 唯一一次触发已在过去：规则没有未来触发点。 */
const EXHAUSTED = 'DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;COUNT=1'

let root: string
let appState: AppStateStore

/** 夹具 workspace 摘要（id=ws-1，路径 /code）。 */
const workspace: WorkspaceSummary = { id: 'ws-1', name: 'Code', path: '/code', createdAt: 1, updatedAt: 1 }

/**
 * 构造一份会话详情（空消息/队列，可选 error）。
 * @param id 会话 id
 * @param error 可选错误文本
 * @returns ConversationDetail
 */
const detail = (id: string, error?: string): ConversationDetail => ({
  conversation: {
    id, title: 'Task', createdAt: 1, updatedAt: 1, archived: false, pinned: false, busy: false,
    thinkingLevel: 'medium', cwd: workspace.path,
  },
  messages: [], queue: [],
  ...(error === undefined ? {} : { error }),
} as unknown as ConversationDetail)

/** 服务夹具的选项：已存在的会话集合、submit 行为、detail 错误注入。 */
interface HarnessOptions {
  /** 已存在的会话；`requireConversation` 对其他 id 抛 NOT_FOUND。 */
  sessions?: string[]
  submit?: (conversationId: string, input: SubmitInput) => Promise<{ submissionId: string }>
  detailError?: (conversationId: string) => string | undefined
}

/**
 * 构造自动化服务夹具：真实 AppStateStore + stub 的会话依赖（创建/提交/查询），
 * 并记录创建的会话与提交调用。
 * @param options 夹具选项
 * @returns automations 服务、创建的会话 id 列表、提交调用记录
 */
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

/**
 * 读取存储中的任务记录（后续读取与 UI 看到的数据源）。
 * @param automations 自动化服务
 * @param id 任务 id
 * @returns 存储中的 Automation 记录；找不到时抛错
 */
function stored(automations: ReturnType<typeof service>['automations'], id: string): Automation {
  const found = automations.list().find(item => item.id === id)
  if (found === undefined) throw new Error(`Missing automation ${id}`)
  return found
}

/** 每个用例前：启用 fake timers 冻结在 NOW，并打开临时目录下的 AppStateStore。 */
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  root = await mkdtemp(join(tmpdir(), 'pi-web-automations-'))
  appState = await AppStateStore.open({ dataDir: root, defaultWorkspace: workspace })
})

/** 每个用例后：恢复真实 timers 并删除临时目录。 */
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

/**
 * 自动化任务创建测试。
 *
 * 关键契约：
 * - 给了规则即默认创建 active 任务（target=new），nextRunAt 按 RRULE 计算；
 * - 无规则创建 paused 的手动任务（无 rrule/nextRunAt）；
 * - active 无规则、空名/超长名（>120）、非法规则都拒绝并抛 INVALID_INPUT；
 * - target=session 必须携带已存在的 sessionId，给了则保留。
 */
describe('automation creation', () => {
  // 带 DAILY 规则创建：status=active、target=new、rrule/timeZone 原样、nextRunAt=次日 01:00Z。
  it('creates an active task by default when a rule is given', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Nightly', prompt: 'do it', rrule: DAILY, timeZone: SHANGHAI })
    expect(created.status).toBe('active')
    expect(created.target).toBe('new')
    expect(created.rrule).toBe(DAILY)
    expect(created.timeZone).toBe(SHANGHAI)
    expect(created.nextRunAt).toBe(NEXT_DAILY)
  })

  // 不带规则创建：status=paused 的手动任务，rrule 与 nextRunAt 均为空。
  it('creates a paused manual task when no rule is given', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Manual', prompt: 'go' })
    expect(created.status).toBe('paused')
    expect(created.rrule).toBeUndefined()
    expect(created.nextRunAt).toBeUndefined()
  })

  // 显式 status=active 却没有规则：拒绝（INVALID_INPUT）。
  it('rejects an active task without a rule', async () => {
    const { automations } = service()
    await expect(automations.create({ name: 'Bad', prompt: 'go', status: 'active' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  // 名字纯空白或超过 120 字符都拒绝（INVALID_INPUT）。
  it('rejects an empty or oversized name', async () => {
    const { automations } = service()
    await expect(automations.create({ name: '   ', prompt: 'go', rrule: DAILY }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(automations.create({ name: 'x'.repeat(121), prompt: 'go', rrule: DAILY }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  // 非法规则（缺 DTSTART 的 FREQ=DAILY）拒绝且列表保持为空（不落库）。
  it('rejects a malformed rule', async () => {
    const { automations } = service()
    await expect(automations.create({ name: 'Bad rule', prompt: 'go', rrule: 'FREQ=DAILY' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(automations.list()).toHaveLength(0)
  })

  // target=session 缺 sessionId 时拒绝；带已存在的 session-1 时创建成功并保留 target/sessionId。
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

/**
 * 自动化任务更新测试。
 *
 * 关键契约：
 * - 暂停清掉 nextRunAt，恢复时重新计算；
 * - 删除规则（rrule=null）把任务转手动并暂停；
 * - 换规则重算 nextRunAt；
 * - 更新时非法规则被拒且任务原样不动。
 */
describe('automation updates', () => {
  // 暂停后 nextRunAt 清空；恢复 active 后重算为 NEXT_DAILY。
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

  // rrule=null：任务变手动（rrule/timeZone 清空）、状态转 paused、无下次触发。
  it('turns a task manual and pauses it when the rule is removed', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    const manual = await automations.update(created.id, { rrule: null })
    expect(manual.rrule).toBeUndefined()
    expect(manual.timeZone).toBeUndefined()
    expect(manual.status).toBe('paused')
    expect(manual.nextRunAt).toBeUndefined()
  })

  // 从 MINUTELY（NEXT_MINUTELY）换成 DAILY：rrule 更新且 nextRunAt 重算为 NEXT_DAILY。
  it('moves the next occurrence when the rule changes', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: MINUTELY, timeZone: SHANGHAI })
    expect(created.nextRunAt).toBe(NEXT_MINUTELY)

    const changed = await automations.update(created.id, { rrule: DAILY, timeZone: SHANGHAI })
    expect(changed.rrule).toBe(DAILY)
    expect(changed.nextRunAt).toBe(NEXT_DAILY)
  })

  // 更新为非法规则（garbage）被拒，存储中的 nextRunAt 保持 NEXT_DAILY 不动。
  it('rejects a malformed rule on update and leaves the task unchanged', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    await expect(automations.update(created.id, { rrule: 'garbage' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(stored(automations, created.id).nextRunAt).toBe(NEXT_DAILY)
  })
})

/**
 * 自动化运行测试。
 *
 * 关键契约：
 * - target=new 每次开新会话并提交（whenBusy=reject，requestId 以 automation: 开头），
 *   drain 后记录 completed 运行（含 plannedAt）；
 * - target=new_once 复用首个会话（sessionId 固化）；
 * - target=session 直投既有会话（whenBusy=followUp），不开新会话、状态 delivered、nextRunAt 照常推进；
 * - 投递提示词带 [SCHEDULE REMINDER] 框架（schedule_id/occurrence_at/reminder_prompt）；
 * - 上一次运行未结束时拒绝再次运行（CONFLICT）；
 * - 提交失败记录 failed 运行（含原因）且规则照常推进；
 * - COUNT=1 规则触发后任务转为 ended。
 */
describe('automation runs', () => {
  // target=new：run 开会话 conv-1 并提交一次（whenBusy=reject、automation: 前缀 requestId）；
  // drain 后 lastRun/runs 记 completed，plannedAt 为规则计算出的 NEXT_DAILY。
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

  // target=new_once：两次运行都投进 conv-1，sessionId 固化为 conv-1，两条运行记录都 completed。
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

  // target=session：不创建会话、直投 session-1（whenBusy=followUp）、lastRun=delivered、nextRunAt 照常推进。
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

  // 投递文本逐行核对：[SCHEDULE REMINDER] 头、中文说明、schedule_id_json、occurrence_at、reminder_prompt_json 五行框架。
  it('frames the delivered prompt with the schedule identity and occurrence', async () => {
    const { automations, submits } = service({ sessions: ['session-1'] })
    const created = await automations.create({
      name: 'Reminder', prompt: 'deliver the report', rrule: DAILY, timeZone: SHANGHAI,
      target: 'session', sessionId: 'session-1',
    })
    await automations.run(created.id)
    expect(submits[0]?.input.text.split('\n')).toEqual([
      '[SCHEDULE REMINDER]',
      '这是一条来自用户的定时消息',
      `schedule_id_json: ${JSON.stringify(created.id)}`,
      'occurrence_at: 2026-11-11T01:00:00.000Z',
      'reminder_prompt_json: "deliver the report"',
    ])
  })

  // 上一次运行还是 running 时再次 run 抛 CONFLICT，且不开任何会话。
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

  // submit 抛 boom：run 向上传播错误、lastRun 记 failed（error 含 boom）、规则仍推进到 NEXT_DAILY。
  it('records a failed run with its reason and advances the rule', async () => {
    const { automations } = service({ submit: async () => { throw new Error('boom') } })
    const created = await automations.create({ name: 'Task', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })
    await expect(automations.run(created.id)).rejects.toThrow('boom')
    const record = stored(automations, created.id)
    expect(record.lastRun?.status).toBe('failed')
    expect(record.lastRun?.error).toContain('boom')
    expect(record.nextRunAt).toBe(NEXT_DAILY)
  })

  // COUNT=1 规则触发后（运行完成时该次触发已过）任务转为 ended、不再排下一次，lastRun 记 completed 与当时的 plannedAt。
  it('ends a task once its COUNT=1 rule has fired', async () => {
    const { automations } = service()
    const created = await automations.create({ name: 'Once', prompt: 'go', rrule: ONCE_TODAY })
    expect(created.nextRunAt).toBe(Date.parse('2026-11-10T13:00:00Z'))

    // 运行结束时该次触发已经过去，所以没有下一次可排。
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

/**
 * 自动化维护测试（清理/内置任务/恢复）。
 *
 * 关键契约：
 * - purgeEnded 只清 ended 任务并报告删除数，二次清理为 0；
 * - ensureBuiltin 按 key 幂等供给内置任务，重复调用复用同一任务并刷新服务端持有的提示词；
 * - recover 迁移 legacy 记录（编译规则、清 legacy 字段）、把 running 的运行标 interrupted
 *   （错误含「重新启动」、finishedAt=NOW），并暂停无法使用的规则（非法规则）与 paused 记录（清掉过期的 nextRunAt）。
 */
describe('automation maintenance', () => {
  // EXHAUSTED 规则的任务创建即 ended；purgeEnded 删掉 1 个、只剩 active；再次清理返回 0。
  it('purges ended tasks and reports how many were removed', async () => {
    const { automations } = service()
    const ended = await automations.create({ name: 'Ended', prompt: 'go', rrule: EXHAUSTED })
    expect(ended.status).toBe('ended')
    const active = await automations.create({ name: 'Active', prompt: 'go', rrule: DAILY, timeZone: SHANGHAI })

    expect(await automations.purgeEnded()).toBe(1)
    expect(automations.list().map(item => item.id)).toEqual([active.id])
    expect(await automations.purgeEnded()).toBe(0)
  })

  // 首次 ensureBuiltin 创建 active 的内置任务（绑 workspace）；第二次同 key 复用同一 id 并把 prompt 刷新为 analyse v2，总数仍为 1。
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

    // 第二次调用找到同一任务而不是再建一个，并刷新服务端持有的提示词。
    const again = await automations.ensureBuiltin({
      key: 'wetrack-analysis-daily', name: 'Nightly issues', prompt: 'analyse v2',
      rrule: DAILY, timeZone: SHANGHAI, workspaceId: workspace.id,
    })
    expect(again.id).toBe(provisioned.id)
    expect(again.prompt).toBe('analyse v2')
    expect(automations.list()).toHaveLength(1)
  })

  // 三类恢复：legacy-daily 迁移成 active/new 的 RRULE 任务（legacy 字段删除、running 运行标 interrupted、finishedAt=NOW）；
  // broken（非法规则）转 paused；paused 记录的过期 nextRunAt 清掉。
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
