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
  'RFC 5545 subset: one DTSTART line, a newline, and one RRULE line.',
  'DTSTART ends in Z for UTC or carries TZID with an IANA time zone; a fixed offset such as UTC+5 is Etc/GMT-5, with the sign reversed.',
  'A TZID rule keeps local clock time across daylight-saving changes; generated nonexistent local times are skipped, and repeated ones occur once, at the earlier instant.',
  'DTSTART may be in the past; delivery starts with the first occurrence after creation.',
  'A one-time delivery is RRULE:FREQ=DAILY;COUNT=1.',
  'Supported: FREQ=MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY; COUNT at most 1000; UNTIL as a UTC instant ending in Z.',
  'MINUTELY and HOURLY accept no BY parts, so set the clock time in DTSTART.',
  'BYMONTHDAY and ordinal BYDAY require MONTHLY or YEARLY; BYYEARDAY and BYWEEKNO require YEARLY; an ordinal BYDAY cannot combine with BYWEEKNO.',
  'Example: "DTSTART;TZID=Asia/Shanghai:20260901T080000\\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"',
].join(' ')

const TARGET_DESCRIPTION = [
  'this_session delivers to this session; new_once delivers to the same new session every time, opened at the first delivery;',
  'new opens a different new session for every delivery. New sessions use this session\'s working directory.',
  'Use this_session for reminders and for follow-ups to this conversation;',
  'use new_once or new for independent work, such as a recurring report, and whenever the user asks for a new conversation.',
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
      'Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target session as a scheduled message from the user.',
      'The result includes the task id and the next occurrence.',
      'After downtime, only the latest missed occurrence is delivered.',
    ].join(' '),
    parameters: Type.Object({
      title: Type.String({ description: `Task name of at most ${MAX_TITLE_CHARS} characters in the user's language: action plus object. Omit timing, status, ids, and bracketed suffixes.` }),
      prompt: Type.String({ description: 'Instruction delivered at each occurrence.' }),
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
    description: 'Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.',
    parameters: Type.Object({
      id: Type.String({ description: 'Task id.' }),
      action: Type.Union([Type.Literal('update'), Type.Literal('delete')], { description: 'update applies the provided fields, at least one; delete removes the task.' }),
      title: Type.Optional(Type.String({ description: `New task name of at most ${MAX_TITLE_CHARS} characters.` })),
      prompt: Type.Optional(Type.String({ description: 'New instruction delivered at each occurrence.' })),
      rrule: Type.Optional(Type.String({ description: RRULE_DESCRIPTION })),
      target: Type.Optional(Type.Union([...TARGET_ITEMS], { description: TARGET_DESCRIPTION })),
      active: Type.Optional(Type.Boolean({ description: 'false pauses the task; true resumes only if its timing has a future occurrence. Otherwise provide a new rrule.' })),
      expectedUpdatedAt: Type.Optional(Type.String({ description: 'updatedAt from the latest result that returned this task; if the task changed after that result, the result is schedule_conflict and nothing changes.' })),
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
    description: 'List scheduled tasks, including tasks created from other sessions. Active tasks come first, ordered by next occurrence.',
    parameters: Type.Object({
      active: Type.Optional(Type.Boolean({ description: 'true for active tasks only; false for paused and ended tasks only; omitted for all tasks.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT, description: `Page size from 1 to ${MAX_LIST_LIMIT}; defaults to ${DEFAULT_LIST_LIMIT}.` })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Number of tasks to skip; defaults to 0.' })),
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
    description: 'View one scheduled task by id.',
    parameters: Type.Object({ id: Type.String({ description: 'Task id.' }) }),
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