/**
 * Automation CRUD, scheduling and run bookkeeping.
 *
 * A task owns a two-line RRULE rule and a delivery target. `new` and `new_once`
 * runs are ordinary conversations plus a prompt, so this module only owns the
 * schedule and the run record; creating and submitting the conversation is
 * delegated to the conversation feature. `session` deliveries message an existing
 * conversation instead, which has no run outcome of its own — arrival is the
 * result, recorded as `delivered`.
 *
 * Legacy records (an `enabled` flag plus `intervalMs` or a four-unit calendar
 * schedule) are migrated in `recover()` before any timer is armed.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import type {
  Automation, AutomationRun, AutomationStatus, AutomationTarget, ConversationDetail,
  CreateAutomationInput, CreateConversationInput, ModelRef as UiModelRef, SubmitInput, UpdateAutomationInput,
  WorkspaceSummary,
} from '../../shared/types.ts'
import { compileRule, systemTimeZone, type AutomationFrequency, type TimingDraft } from '../../shared/automation-timing.ts'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { AutomationScheduler } from '../automation/scheduler.ts'
import { nextRunOf, parseRule } from '../automation/recurrence.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { CTX, safeFailure } from './helpers.ts'

/** The parts of a Pi conversation an automation run touches. */
export interface RuntimeConversation {
  readonly id: ConversationId
  waitForIdle(context: Context): Promise<void>
}

export interface AutomationsDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  /** Reads the composition root's closed flag; scheduling stops once it is set. */
  isClosed: () => boolean
  requireConversation(value: string): Promise<RuntimeConversation>
  currentDetail(id: ConversationId): Promise<ConversationDetail>
  selectedWorkspace(id: string | undefined): WorkspaceSummary
  assertModelAllowed(model: UiModelRef | undefined, label: string): void
  create(input: CreateConversationInput): Promise<ConversationDetail>
  submit(value: string, input: SubmitInput): Promise<{ submissionId: string }>
}

/** How many finished runs the history keeps; the list is a tail, not an archive. */
const MAX_RUN_HISTORY = 50

/** The scheduled-trigger framing a delivered prompt carries, so a model can tell it from a fresh user turn. */
export function framedPrompt(automation: Automation, plannedAt: number): string {
  return [
    '[SCHEDULE REMINDER]',
    'This is a scheduled message from the user',
    `schedule_id_json: ${JSON.stringify(automation.id)}`,
    `occurrence_at: ${new Date(plannedAt).toISOString()}`,
    `reminder_prompt_json: ${JSON.stringify(automation.prompt)}`,
  ].join('\n')
}

/** The legacy shape still present in an app-state written before RRULE support. */
interface LegacyAutomation extends Partial<Automation> {
  enabled?: boolean
  intervalMs?: number
  schedule?: {
    unit: 'hour' | 'day' | 'week' | 'month'
    timeOfDay?: string
    dayOfWeek?: number
    dayOfMonth?: number
  }
}

const LEGACY_UNIT_FREQUENCY: Record<'hour' | 'day' | 'week' | 'month', AutomationFrequency> = {
  hour: 'hourly', day: 'daily', week: 'weekly', month: 'monthly',
}

function legacyDraft(legacy: LegacyAutomation, timeZone: string): TimingDraft | undefined {
  const intervalMs = legacy.intervalMs
  if (typeof intervalMs === 'number' && Number.isFinite(intervalMs)) {
    return {
      frequency: 'minutes', interval: String(Math.max(1, Math.round(intervalMs / 60_000))),
      weekdays: [1], monthDay: 1, date: '', time: '00:00', timeZone,
    }
  }
  const schedule = legacy.schedule
  if (schedule === undefined) return undefined
  return {
    frequency: LEGACY_UNIT_FREQUENCY[schedule.unit] ?? 'daily',
    interval: '1',
    weekdays: [schedule.dayOfWeek ?? 1],
    monthDay: schedule.dayOfMonth ?? 1,
    date: '',
    time: schedule.timeOfDay ?? '00:00',
    timeZone,
  }
}

/**
 * Bring one stored record onto the current shape. Idempotent: a record that
 * already carries `status`, `target` and an RRULE (or none) is returned as-is.
 */
export function migrateAutomation(raw: LegacyAutomation, now: number): Automation {
  const timeZone = raw.timeZone ?? systemTimeZone()
  if (raw.status !== undefined && raw.target !== undefined && (raw.rrule !== undefined || legacyDraft(raw, timeZone) === undefined)) {
    return raw as Automation
  }
  const status: AutomationStatus = raw.status ?? (raw.enabled === false ? 'paused' : 'active')
  const target: AutomationTarget = raw.target ?? 'new'
  let rrule = raw.rrule
  if (rrule === undefined) {
    const draft = legacyDraft(raw, timeZone)
    rrule = draft === undefined ? undefined : compileRule(draft, now)
  }
  const migrated: Automation = {
    ...(raw as Automation),
    status: rrule === undefined && status === 'active' ? 'paused' : status,
    target,
    ...(rrule === undefined ? {} : { rrule, timeZone }),
  }
  delete (migrated as LegacyAutomation).enabled
  delete (migrated as LegacyAutomation).intervalMs
  delete (migrated as LegacyAutomation).schedule
  return migrated
}

export function createAutomations(deps: AutomationsDeps) {
  const {
    appState, modelRuntime, isClosed, requireConversation, currentDetail,
    selectedWorkspace, assertModelAllowed, create, submit,
  } = deps

  const automationTasks = new Set<Promise<void>>()
  let runAutomation: (id: string) => Promise<{ automation: Automation; conversationId: string }>
  const automationScheduler = new AutomationScheduler()
  /**
   * When the task fires next. A stored `nextRunAt` keeps the due time stable
   * across restarts; otherwise the rule is asked for its next occurrence.
   */
  const dueAt = (automation: Automation, from: number): number | undefined => {
    if (automation.rrule === undefined) return undefined
    try {
      return nextRunOf(automation.rrule, from)
    } catch {
      // A stored rule that no longer parses cannot fire; `recover` pauses it.
      return undefined
    }
  }
  const scheduleAutomation = (automation: Automation): void => {
    automationScheduler.cancel(automation.id)
    if (isClosed() || automation.status !== 'active') return
    const at = automation.nextRunAt ?? dueAt(automation, Date.now())
    if (at === undefined) return
    automationScheduler.schedule(automation.id, at, () => {
      void runAutomation(automation.id).catch(() => undefined)
    })
  }
  const automations = (): Automation[] => appState.snapshot().automations

  const validateAutomation = (input: CreateAutomationInput | UpdateAutomationInput): void => {
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 120)) throw new RuntimeError('INVALID_INPUT', 'Automation 名称必须是 1 到 120 个字符')
    if (input.prompt !== undefined && (!input.prompt.trim() || input.prompt.length > 100_000)) throw new RuntimeError('INVALID_INPUT', 'Automation 提示词无效')
    if (input.rrule !== undefined && input.rrule !== null) {
      if (typeof input.rrule !== 'string' || input.rrule.trim() === '') throw new RuntimeError('INVALID_INPUT', 'Automation 重复规则不能为空')
      try {
        parseRule(input.rrule)
      } catch (error) {
        throw new RuntimeError('INVALID_INPUT', `Automation 重复规则无效：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (input.target !== undefined && !['session', 'new_once', 'new'].includes(input.target)) {
      throw new RuntimeError('INVALID_INPUT', 'Automation 执行位置无效')
    }
    if (input.status !== undefined && !['active', 'paused', 'ended'].includes(input.status)) {
      throw new RuntimeError('INVALID_INPUT', 'Automation 状态无效')
    }
    if (input.model && !modelRuntime.models.getModel(input.model.provider, input.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', 'Automation 模型不在 Pi 模型目录中')
    assertModelAllowed(input.model, 'Automation 模型')
    if (input.workspaceId) selectedWorkspace(input.workspaceId)
  }

  const assertAutomationResourcesExist = (
    workspaceId: string | undefined,
    workspaces: readonly WorkspaceSummary[],
  ): void => {
    if (workspaceId && !workspaces.some(workspace => workspace.id === workspaceId)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
  }

  const assertNoAutomationReferences = (items: readonly Automation[], id: string): void => {
    const references = items.filter(item => item.workspaceId === id)
    if (references.length === 0) return
    const automationList = references.map(item => `${item.name}（${item.id}）`).join('、')
    throw new RuntimeError('CONFLICT', `工作区仍被以下 Automation 引用：${automationList}。请先修改或删除这些 Automation`)
  }

  const createAutomation = async (input: CreateAutomationInput): Promise<Automation> => {
    validateAutomation(input)
    const target: AutomationTarget = input.target ?? 'new'
    if (target === 'session') {
      if (input.sessionId === undefined || input.sessionId.trim() === '') throw new RuntimeError('INVALID_INPUT', '执行位置为「当前会话」时必须指定会话')
      await requireConversation(input.sessionId)
    }
    const now = Date.now()
    const rrule = input.rrule
    const status: AutomationStatus = input.status ?? (rrule === undefined ? 'paused' : 'active')
    if (status === 'active' && rrule === undefined) throw new RuntimeError('INVALID_INPUT', '没有重复规则的任务只能手动运行')
    const candidate: Automation = {
      id: randomUUID(),
      name: input.name.trim(),
      prompt: input.prompt,
      status,
      target,
      ...(rrule === undefined ? {} : { rrule, timeZone: input.timeZone ?? systemTimeZone() }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.model ? { model: { ...input.model } } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.accessMode ? { accessMode: input.accessMode } : {}),
      ...(input.builtin ? { builtin: input.builtin } : {}),
      createdAt: now,
      updatedAt: now,
    }
    if (status === 'active') {
      const at = dueAt(candidate, now)
      if (at === undefined) candidate.status = 'ended'
      else candidate.nextRunAt = at
    }
    const stored = await appState.update(state => {
      assertAutomationResourcesExist(candidate.workspaceId, state.workspaces)
      state.automations.push(candidate)
      return structuredClone(candidate)
    })
    scheduleAutomation(stored)
    return stored
  }

  const updateAutomation = async (id: string, input: UpdateAutomationInput): Promise<Automation> => {
    validateAutomation(input)
    const updated = await appState.update(state => {
      const current = state.automations.find(item => item.id === id)
      if (!current) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
      if (input.name !== undefined) current.name = input.name.trim()
      if (input.prompt !== undefined) current.prompt = input.prompt
      if (input.model !== undefined) current.model = input.model ? { ...input.model } : undefined
      if (input.workspaceId !== undefined) current.workspaceId = input.workspaceId
      if (input.accessMode !== undefined) current.accessMode = input.accessMode
      if (input.target !== undefined) current.target = input.target
      let timingChanged = false
      if (input.rrule === null) {
        if (current.rrule !== undefined) timingChanged = true
        delete current.rrule
        delete current.timeZone
      } else if (input.rrule !== undefined) {
        current.rrule = input.rrule
        current.timeZone = input.timeZone ?? current.timeZone ?? systemTimeZone()
        timingChanged = true
      } else if (input.timeZone !== undefined) {
        current.timeZone = input.timeZone
        timingChanged = true
      }
      if (input.sessionId === null) delete current.sessionId
      else if (input.sessionId !== undefined) current.sessionId = input.sessionId
      if (input.status !== undefined) current.status = input.status
      // A task without a rule never fires, so it cannot claim to be active.
      if (current.rrule === undefined && current.status === 'active') current.status = 'paused'
      if (current.status === 'active' && (timingChanged || current.nextRunAt === undefined)) {
        const at = dueAt(current, Date.now())
        if (at === undefined) current.status = 'ended'
        else current.nextRunAt = at
      }
      if (current.status !== 'active') delete current.nextRunAt
      assertAutomationResourcesExist(current.workspaceId, state.workspaces)
      if (current.target === 'session' && (current.sessionId ?? '') === '') {
        throw new RuntimeError('INVALID_INPUT', '执行位置为「当前会话」时必须指定会话')
      }
      current.updatedAt = Date.now()
      return structuredClone(current)
    })
    scheduleAutomation(updated)
    return updated
  }

  const deleteAutomation = async (id: string): Promise<void> => {
    const current = appState.snapshot().automations.find(item => item.id === id)
    if (!current) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
    if (current.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 仍在运行')
    automationScheduler.cancel(id)
    await appState.update(state => {
      const index = state.automations.findIndex(item => item.id === id)
      if (index < 0) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
      state.automations.splice(index, 1)
    })
  }

  /** Remove every task whose rule is exhausted. */
  const purgeEnded = async (): Promise<number> => {
    const ended = appState.snapshot().automations.filter(item => item.status === 'ended')
    for (const automation of ended) automationScheduler.cancel(automation.id)
    await appState.update(state => {
      state.automations = state.automations.filter(item => item.status !== 'ended')
      return structuredClone(state.automations)
    })
    return ended.length
  }

  /** The run history is a tail: newest first, capped, and always including `lastRun`. */
  const recordRun = (automation: Automation, run: AutomationRun): void => {
    automation.lastRun = run
    const runs = (automation.runs ?? []).filter(item => item.id !== run.id)
    runs.unshift(run)
    automation.runs = runs.slice(0, MAX_RUN_HISTORY)
  }

  /** Advance the rule after a run and end the task once nothing is left. */
  const advance = (automation: Automation, now: number): void => {
    if (automation.status !== 'active') {
      delete automation.nextRunAt
      return
    }
    const at = dueAt(automation, now)
    if (at === undefined) {
      automation.status = 'ended'
      delete automation.nextRunAt
    } else {
      automation.nextRunAt = at
    }
  }

  const finishAutomation = async (automationId: string, runId: string, conversationId: string, plannedAt: number): Promise<void> => {
    let status: AutomationRun['status'] = 'completed'
    let errorMessage: string | undefined
    try {
      const conversation = await requireConversation(conversationId)
      await conversation.waitForIdle(CTX)
      const detail = await currentDetail(conversation.id)
      if (detail.error) {
        status = 'failed'
        errorMessage = safeFailure(detail.error)
      }
    } catch (error) {
      status = 'failed'
      errorMessage = safeFailure(error)
    }
    const updated = await appState.update(state => {
      const automation = state.automations.find(item => item.id === automationId)
      if (!automation || automation.lastRun?.id !== runId) return undefined
      const finishedAt = Date.now()
      recordRun(automation, {
        id: runId,
        status,
        plannedAt,
        startedAt: automation.lastRun.startedAt,
        finishedAt,
        conversationId,
        ...(errorMessage ? { error: errorMessage } : {}),
      })
      automation.updatedAt = finishedAt
      advance(automation, finishedAt)
      return structuredClone(automation)
    })
    if (updated) scheduleAutomation(updated)
  }

  /** Deliver one occurrence into an existing conversation: arrival is the outcome. */
  const deliverToSession = async (
    automation: Automation, runId: string, plannedAt: number,
  ): Promise<{ automation: Automation; conversationId: string }> => {
    const sessionId = automation.sessionId
    if (sessionId === undefined) throw new RuntimeError('CONFLICT', 'Automation 没有关联会话')
    await requireConversation(sessionId)
    const text = framedPrompt(automation, plannedAt)
    await submit(sessionId, { text, requestId: `automation:${runId}`, whenBusy: 'followUp' })
    const updated = await appState.update(state => {
      const current = state.automations.find(item => item.id === automation.id)
      if (current === undefined || current.lastRun?.id !== runId) return undefined
      const deliveredAt = Date.now()
      recordRun(current, {
        id: runId, status: 'delivered', plannedAt, startedAt: deliveredAt,
        finishedAt: deliveredAt, conversationId: sessionId,
      })
      current.updatedAt = deliveredAt
      advance(current, deliveredAt)
      return structuredClone(current)
    })
    if (updated === undefined) throw new RuntimeError('CONFLICT', 'Automation 运行状态无法读取')
    scheduleAutomation(updated)
    return { automation: updated, conversationId: sessionId }
  }

  runAutomation = async (id: string): Promise<{ automation: Automation; conversationId: string }> => {
    const current = appState.snapshot().automations.find(item => item.id === id)
    if (!current) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
    if (current.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 已在运行')
    const plannedAt = current.nextRunAt ?? Date.now()
    const runId = randomUUID()
    const startedAt = Date.now()
    const running = await appState.update(state => {
      const automation = state.automations.find(item => item.id === id)
      if (!automation) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
      if (automation.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 已在运行')
      recordRun(automation, { id: runId, status: 'running', plannedAt, startedAt })
      delete automation.nextRunAt
      automation.updatedAt = startedAt
      return structuredClone(automation)
    })
    if (running.target === 'session') {
      try {
        return await deliverToSession(running, runId, plannedAt)
      } catch (error) {
        await appState.update(state => {
          const automation = state.automations.find(item => item.id === id)
          if (automation?.lastRun?.id === runId) {
            recordRun(automation, {
              id: runId, status: 'failed', plannedAt, startedAt, finishedAt: Date.now(), error: safeFailure(error),
            })
            automation.updatedAt = Date.now()
            advance(automation, Date.now())
          }
        })
        const updated = appState.snapshot().automations.find(item => item.id === id)
        if (updated) scheduleAutomation(updated)
        throw error
      }
    }
    let conversationId: string | undefined
    try {
      if (running.target === 'new_once' && running.sessionId !== undefined) {
        // Reuse the conversation reserved by the first delivery, unless it was deleted.
        try {
          const existing = await requireConversation(running.sessionId)
          conversationId = String(existing.id)
        } catch {
          conversationId = undefined
        }
      }
      if (conversationId === undefined) {
        const detail = await create({
          title: running.name,
          ...(running.model ? { model: running.model } : {}),
          ...(running.workspaceId ? { workspaceId: running.workspaceId } : {}),
          ...(running.accessMode ? { accessMode: running.accessMode } : {}),
        })
        conversationId = detail.conversation.id
      }
      await submit(conversationId, {
        text: framedPrompt(running, plannedAt),
        requestId: `automation:${runId}`,
        whenBusy: 'reject',
      })
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation === undefined || automation.lastRun?.id !== runId) return
        const runs = automation.runs ?? []
        const index = runs.findIndex(item => item.id === runId)
        if (index >= 0) runs[index] = { ...runs[index]!, conversationId }
        automation.runs = runs
        automation.lastRun = { ...automation.lastRun!, conversationId }
        // A new_once task adopts its first conversation and reuses it afterwards.
        if (automation.target === 'new_once' && automation.sessionId === undefined) automation.sessionId = conversationId
      })
    } catch (error) {
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation?.lastRun?.id === runId) {
          recordRun(automation, {
            id: runId, status: 'failed', plannedAt, startedAt, finishedAt: Date.now(),
            ...(conversationId ? { conversationId } : {}), error: safeFailure(error),
          })
          automation.updatedAt = Date.now()
          advance(automation, Date.now())
        }
      })
      const updated = appState.snapshot().automations.find(item => item.id === id)
      if (updated) scheduleAutomation(updated)
      throw error
    }
    const task = finishAutomation(id, runId, conversationId as string, plannedAt)
    automationTasks.add(task)
    void task.finally(() => automationTasks.delete(task)).catch(() => undefined)
    const latest = appState.snapshot().automations.find(item => item.id === id)
    if (!latest || !conversationId) throw new RuntimeError('CONFLICT', 'Automation 运行状态无法读取')
    return { automation: latest, conversationId }
  }

  const recoverAutomations = async (): Promise<void> => {
    const now = Date.now()
    const recovered = await appState.update(state => {
      const migrated: Automation[] = []
      for (const raw of state.automations as LegacyAutomation[]) {
        const automation = migrateAutomation(raw, now)
        if (automation.rrule !== undefined) {
          try {
            parseRule(automation.rrule)
          } catch {
            // A rule the engine rejects cannot fire; keep the task visible but paused.
            automation.status = 'paused'
            delete automation.nextRunAt
          }
        }
        if (automation.status === 'active' && automation.rrule === undefined) automation.status = 'paused'
        migrated.push(automation)
      }
      state.automations = migrated
      for (const automation of state.automations) {
        if (automation.lastRun?.status === 'running') {
          const interrupted: AutomationRun = {
            ...automation.lastRun,
            status: 'interrupted',
            finishedAt: now,
            error: 'Pi Durable Web 在运行期间重新启动',
          }
          recordRun(automation, interrupted)
          automation.updatedAt = now
        }
        if (automation.status !== 'active') {
          delete automation.nextRunAt
          continue
        }
        const at = automation.nextRunAt === undefined ? dueAt(automation, now) : automation.nextRunAt
        if (at === undefined) {
          automation.status = 'ended'
          delete automation.nextRunAt
        } else {
          automation.nextRunAt = at
        }
      }
      return structuredClone(state.automations)
    })
    for (const automation of recovered) scheduleAutomation(automation)
  }

  /**
   * Provision a task the server owns, without ever resurrecting one the operator
   * deleted: the caller decides whether the built-in should exist.
   */
  const ensureBuiltin = async (spec: {
    key: string
    name: string
    prompt: string
    rrule?: string
    timeZone?: string
    target?: AutomationTarget
    workspaceId?: string
    model?: UiModelRef
    accessMode?: Automation['accessMode']
  }): Promise<Automation> => {
    const existing = appState.snapshot().automations.find(item => item.builtin === spec.key)
    if (existing !== undefined) {
      // The built-in task's prompt is server-owned: a coordinator that predates the
      // current analysis procedure would hand its workers the old rules.
      const patch: UpdateAutomationInput = {}
      if (existing.prompt !== spec.prompt) patch.prompt = spec.prompt
      // A rebinding of the shared workspace must not leave the task pointing at the old one.
      if (spec.workspaceId !== undefined && existing.workspaceId !== spec.workspaceId) patch.workspaceId = spec.workspaceId
      if (spec.rrule !== undefined && existing.rrule !== spec.rrule) patch.rrule = spec.rrule
      if (spec.timeZone !== undefined && existing.timeZone !== spec.timeZone) patch.timeZone = spec.timeZone
      return Object.keys(patch).length === 0 ? existing : await updateAutomation(existing.id, patch)
    }
    return await createAutomation({
      name: spec.name,
      prompt: spec.prompt,
      status: 'active',
      target: spec.target ?? 'new',
      ...(spec.rrule === undefined ? {} : { rrule: spec.rrule }),
      ...(spec.timeZone === undefined ? {} : { timeZone: spec.timeZone }),
      ...(spec.workspaceId ? { workspaceId: spec.workspaceId } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.accessMode ? { accessMode: spec.accessMode } : {}),
      builtin: spec.key,
    })
  }

  const runsOf = (id: string): AutomationRun[] => {
    const automation = appState.snapshot().automations.find(item => item.id === id)
    if (automation === undefined) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
    return automation.runs ?? (automation.lastRun === undefined ? [] : [automation.lastRun])
  }

  return {
    list: automations,
    create: createAutomation,
    update: updateAutomation,
    remove: deleteAutomation,
    run: (id: string) => runAutomation(id),
    runs: runsOf,
    purgeEnded,
    ensureBuiltin,
    recover: recoverAutomations,
    assertNoAutomationReferences,
    close: () => automationScheduler.close(),
    drain: () => Promise.allSettled([...automationTasks]),
  }
}