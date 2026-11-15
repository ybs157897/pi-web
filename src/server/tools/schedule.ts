/**
 * Scheduled tasks as model-facing tools.
 *
 * The task store belongs to the host, not to a conversation: these tools read and
 * write it through the automations service, and a delivery lands in a conversation
 * as a normal user message carrying `[SCHEDULE REMINDER]` framing. Delegated
 * subagents never reach them — `subagentToolAllowed` removes the four tool names
 * from a child's tools, so exposure and execution are both blocked.
 */
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { JsonValue } from '@earendil-works/chord'
import type { Automation, AutomationTarget, CreateAutomationInput, UpdateAutomationInput } from '../../shared/types.ts'
import { describeRule } from '../../shared/automation-timing.ts'
import { nextRunOf, parseRule } from '../automation/recurrence.ts'

const MAX_TITLE_CHARS = 120
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

const TARGET_ITEMS = [Type.Literal('this_session'), Type.Literal('new_once'), Type.Literal('new')] as const

const RRULE_DESCRIPTION = [
  'RFC 5545 子集：一行 DTSTART、一个换行和一行 RRULE。',
  'UTC 的 DTSTART 以 Z 结尾；其他时区用 TZID 携带 IANA 时区。固定偏移如 UTC+5 写作 Etc/GMT-5，符号相反。',
  'TZID 规则在夏令时切换时保持本地钟表时间；生成的不存在的本地时间会被跳过，重复时间仅执行一次，取较早时刻。',
  'DTSTART 可以在过去；从创建后的第一次发生时间开始投递。',
  '一次性投递使用 RRULE:FREQ=DAILY;COUNT=1。',
  '支持 FREQ=MINUTELY、HOURLY、DAILY、WEEKLY、MONTHLY、YEARLY；COUNT 最多 1000；UNTIL 为以 Z 结尾的 UTC 时刻。',
  'MINUTELY 和 HOURLY 不接受任何 BY 部分；请在 DTSTART 中设置钟表时间。',
  'BYMONTHDAY 和带序号的 BYDAY 要求 MONTHLY 或 YEARLY；BYYEARDAY 和 BYWEEKNO 要求 YEARLY；带序号的 BYDAY 不能与 BYWEEKNO 组合。',
  'Example: "DTSTART;TZID=Asia/Shanghai:20260901T080000\\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"',
].join(' ')

const TARGET_DESCRIPTION = [
  'this_session 投递到本会话；new_once 每次投递到同一个新会话，该会话在首次投递时创建；',
  'new 每次投递都创建不同的新会话。新会话使用本会话的工作目录。',
  '提醒或跟进本会话时使用 this_session；',
  '独立工作（如定期报告）或用户明确要求新会话时，使用 new_once 或 new。',
].join(' ')

/** The slice of the automations service these tools need; the runtime passes the real feature. */
export interface ScheduleService {
  list(): Automation[]
  create(input: CreateAutomationInput): Promise<Automation>
  update(id: string, input: UpdateAutomationInput): Promise<Automation>
  remove(id: string): Promise<void>
  run(id: string): Promise<{ automation: Automation; conversationId: string }>
}

function cleanTitle(value: string): string {
  const title = value.trim()
  if (title === '') throw new Error('The schedule title must be non-empty text.')
  if (title.length > MAX_TITLE_CHARS) throw new Error(`The schedule title is limited to ${MAX_TITLE_CHARS} characters.`)
  return title
}

function cleanPrompt(value: string): string {
  const prompt = value.trim()
  if (prompt === '') throw new Error('The schedule prompt must be non-empty text.')
  return prompt
}

function cleanRule(value: string): string {
  parseRule(value)
  return value.trim()
}

function targetOf(value: 'this_session' | 'new_once' | 'new', conversationId: string): { target: AutomationTarget; sessionId?: string } {
  return value === 'this_session'
    ? { target: 'session', sessionId: conversationId }
    : { target: value }
}

/** A compact line per task: id, status, human rule and next run. */
function taskLine(automation: Automation): string {
  const next = automation.status === 'active' && automation.nextRunAt !== undefined
    ? `, next ${new Date(automation.nextRunAt).toISOString()}`
    : ''
  return `${automation.id} [${automation.status}] ${automation.name} — ${describeRule(automation.rrule)} (${automation.target}${next})`
}

function detailsOf(automation: Automation): JsonValue {
  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    target: automation.target,
    rrule: automation.rrule ?? null,
    timeZone: automation.timeZone ?? null,
    nextRunAt: automation.nextRunAt ?? null,
    sessionId: automation.sessionId ?? null,
  } as unknown as JsonValue
}

export function createScheduleExtension(options: { automations: ScheduleService }): Extension {
  const { automations } = options

  const createTool = defineTool({
    name: 'schedule_create',
    description: [
      '创建定时任务。在 rrule 的每次发生时间，将 prompt 作为用户的定时消息投递到目标会话。',
      '结果包含任务 id 和下次发生时间。',
      '停机恢复后，仅补投最近一次错过的发生时间。',
    ].join(' '),
    parameters: Type.Object({
      title: Type.String({ description: `用用户语言填写任务名称，最多 ${MAX_TITLE_CHARS} 字符，采用动作加对象。不含时间、状态、id 或括号后缀。` }),
      prompt: Type.String({ description: '每次发生时投递的指令。' }),
      rrule: Type.String({ description: RRULE_DESCRIPTION }),
      target: Type.Union([...TARGET_ITEMS], { description: TARGET_DESCRIPTION }),
    }),
    execute: async (args, api) => {
      const { target, sessionId } = targetOf(args.target, String(api.conversationId))
      const rrule = cleanRule(args.rrule)
      const automation = await automations.create({
        name: cleanTitle(args.title),
        prompt: cleanPrompt(args.prompt),
        rrule,
        // The rule's own TZID is authoritative; keep the stored metadata in step with it.
        timeZone: parseRule(rrule).timeZone,
        target,
        status: 'active',
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      const next = automation.nextRunAt === undefined ? 'no future occurrence' : new Date(automation.nextRunAt).toISOString()
      return {
        output: [{ type: 'text' as const, text: `Created schedule ${automation.id} (${describeRule(automation.rrule)}), next occurrence ${next}.` }],
        details: detailsOf(automation),
      }
    },
  })

  const editTool = defineTool({
    name: 'schedule_edit',
    description: '按 id 更新、暂停、恢复或删除一个定时任务。删除不会撤回已排队的消息。',
    parameters: Type.Object({
      id: Type.String({ description: '任务 id。' }),
      action: Type.Union([Type.Literal('update'), Type.Literal('delete')], { description: 'update 应用提供的字段，至少需要一个；delete 删除任务。' }),
      title: Type.Optional(Type.String({ description: `新的任务名称，最多 ${MAX_TITLE_CHARS} 字符。` })),
      prompt: Type.Optional(Type.String({ description: '每次发生时投递的新指令。' })),
      rrule: Type.Optional(Type.String({ description: RRULE_DESCRIPTION })),
      target: Type.Optional(Type.Union([...TARGET_ITEMS], { description: TARGET_DESCRIPTION })),
      active: Type.Optional(Type.Boolean({ description: 'false 暂停任务；true 仅在规则仍有未来发生时间时恢复。否则需提供新的 rrule。' })),
      expectedUpdatedAt: Type.Optional(Type.String({ description: '最近一次返回该任务的结果中的 updatedAt；如果此后任务已变化，返回 schedule_conflict，不做任何改动。' })),
    }),
    execute: async (args, api) => {
      if (args.action === 'delete') {
        await automations.remove(args.id)
        return { output: [{ type: 'text' as const, text: `Deleted schedule ${args.id}.` }], details: { id: args.id, deleted: true } as unknown as JsonValue }
      }
      const current = automations.list().find(item => item.id === args.id)
      if (current === undefined) throw new Error(`No scheduled task has id ${args.id}.`)
      if (args.expectedUpdatedAt !== undefined && args.expectedUpdatedAt !== new Date(current.updatedAt).toISOString()) {
        throw new Error('schedule_conflict: the task changed since that result; read it again before editing.')
      }
      const patch: UpdateAutomationInput = {}
      if (args.title !== undefined) patch.name = cleanTitle(args.title)
      if (args.prompt !== undefined) patch.prompt = cleanPrompt(args.prompt)
      if (args.rrule !== undefined) {
        patch.rrule = cleanRule(args.rrule)
        patch.timeZone = parseRule(patch.rrule).timeZone
      }
      if (args.target !== undefined) {
        const { target, sessionId } = targetOf(args.target, String(api.conversationId))
        patch.target = target
        patch.sessionId = sessionId ?? null
      }
      if (args.active !== undefined) {
        if (args.active) {
          const rule = patch.rrule ?? current.rrule
          if (rule === undefined) throw new Error('The task has no recurrence rule; provide a new rrule before resuming it.')
          if (nextRunOf(rule, Date.now()) === undefined) throw new Error('The task has no future occurrence; provide a new rrule before resuming it.')
          patch.status = 'active'
        } else {
          patch.status = 'paused'
        }
      }
      if (Object.keys(patch).length === 0) throw new Error('schedule_edit with action=update needs at least one field.')
      const automation = await automations.update(args.id, patch)
      return {
        output: [{ type: 'text' as const, text: `Updated schedule ${automation.id}: ${describeRule(automation.rrule)}, status ${automation.status}.` }],
        details: detailsOf(automation),
      }
    },
  })

  const listTool = defineTool({
    name: 'schedule_list',
    description: '列出定时任务，包括其他会话创建的任务。活动任务排在前面，按下次发生时间排序。',
    parameters: Type.Object({
      active: Type.Optional(Type.Boolean({ description: 'true 仅返回活动任务；false 仅返回暂停和已结束任务；省略时返回所有任务。' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: `每页数量为 1 到 ${MAX_LIST_LIMIT}，默认 ${DEFAULT_LIST_LIMIT}。` })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: '跳过的任务数量，默认 0。' })),
    }),
    execute: async (args) => {
      const all = automations.list()
      const filtered = args.active === undefined
        ? all
        : all.filter(item => args.active === true ? item.status === 'active' : item.status !== 'active')
      const ordered = [...filtered].sort((left, right) => {
        if (left.status !== right.status) {
          if (left.status === 'active') return -1
          if (right.status === 'active') return 1
        }
        if (left.status === 'active' && right.status === 'active') {
          return (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER)
        }
        return right.updatedAt - left.updatedAt
      })
      const limit = Math.min(MAX_LIST_LIMIT, args.limit ?? DEFAULT_LIST_LIMIT)
      const offset = Math.max(0, args.offset ?? 0)
      const page = ordered.slice(offset, offset + limit)
      const nextOffset = offset + page.length < ordered.length ? offset + page.length : null
      const text = page.length === 0
        ? `No scheduled tasks (total ${ordered.length}).`
        : `${page.map(taskLine).join('\n')}\nTotal ${ordered.length}; ${nextOffset === null ? 'end of list' : `next offset: ${nextOffset}`}`
      return {
        output: [{ type: 'text' as const, text }],
        details: {
          items: page.map(item => detailsOf(item)),
          total: ordered.length,
          nextOffset,
        } as unknown as JsonValue,
      }
    },
  })

  const viewTool = defineTool({
    name: 'schedule_view',
    description: '按 id 查看一个定时任务。',
    parameters: Type.Object({ id: Type.String({ description: '任务 id。' }) }),
    execute: async (args) => {
      const automation = automations.list().find(item => item.id === args.id)
      if (automation === undefined) throw new Error(`No scheduled task has id ${args.id}.`)
      const runs = (automation.runs ?? (automation.lastRun === undefined ? [] : [automation.lastRun])).slice(0, 10)
      const lines = [
        taskLine(automation),
        `prompt: ${JSON.stringify(automation.prompt)}`,
        automation.rrule === undefined ? 'manual: run on demand only' : automation.rrule,
        runs.length === 0 ? 'no runs yet' : `recent runs: ${runs.map(run => `${run.status}@${new Date(run.finishedAt ?? run.startedAt ?? run.plannedAt ?? Date.now()).toISOString()}`).join(', ')}`,
      ]
      return { output: [{ type: 'text' as const, text: lines.join('\n') }], details: detailsOf(automation) }
    },
  })

  // Authorization text only ships where a task can actually be created or changed.
  const authorization = section('schedule-policy', async (input) => {
    const visible = (name: string): boolean =>
      input.agent.tools.some(tool => tool.name === name) || input.agent.callable.some(tool => tool.name === name)
    if (!visible('schedule_create') && !visible('schedule_edit')) return undefined
    return '只有在用户明确要求时才创建或修改定时任务；当前正在执行的定时任务所依据的既有授权继续有效。'
  })

  return defineExtension({ name: 'schedule', tools: [createTool, editTool, listTool, viewTool], sections: [authorization] })
}