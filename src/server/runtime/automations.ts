/**
 * Automation CRUD, scheduling and run bookkeeping.
 *
 * A run is an ordinary conversation plus its prompt, so this module only owns the
 * schedule, the `lastRun` record and the guard rails around deletion; creating and
 * submitting the conversation is delegated to the conversation feature.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import type {
  AgentPreset, Automation, AutomationRun, AutomationSchedule, ConversationDetail, CreateAutomationInput, CreateConversationInput,
  ModelRef as UiModelRef, SubmitInput, UpdateAutomationInput, WorkspaceSummary,
} from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { AutomationScheduler } from '../automation/scheduler.ts'
import { nextRunAt } from '../automation/recurrence.ts'
import { parseTimeOfDay } from '../../shared/automation-schedule.ts'
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
  selectedPreset(id: string | null | undefined): AgentPreset | undefined
  assertModelAllowed(model: UiModelRef | undefined, label: string): void
  create(input: CreateConversationInput): Promise<ConversationDetail>
  submit(value: string, input: SubmitInput): Promise<{ submissionId: string }>
}

export function createAutomations(deps: AutomationsDeps) {
  const {
    appState, modelRuntime, isClosed, requireConversation, currentDetail,
    selectedWorkspace, selectedPreset, assertModelAllowed, create, submit,
  } = deps

  const automationTasks = new Set<Promise<void>>()
  let runAutomation: (id: string) => Promise<{ automation: Automation; conversationId: string }>
  const automationScheduler = new AutomationScheduler()
  /** How many finished runs the history keeps; the list is a tail, not an archive. */
  const MAX_RUN_HISTORY = 50
  /**
   * When the task fires next. A calendar schedule wins over the plain interval, and
   * a stored `nextRunAt` keeps the due time stable across restarts.
   */
  const dueAt = (automation: Automation, from: number): number | undefined => {
    if (automation.schedule !== undefined) return nextRunAt(automation.schedule, from)
    if (automation.intervalMs !== undefined) return from + automation.intervalMs
    return undefined
  }
  const scheduleAutomation = (automation: Automation): void => {
    automationScheduler.cancel(automation.id)
    if (isClosed() || !automation.enabled) return
    const at = automation.nextRunAt ?? dueAt(automation, Date.now())
    if (at === undefined) return
    automationScheduler.schedule(automation.id, at, () => {
      void runAutomation(automation.id).catch(() => undefined)
    })
  }
  const automations = (): Automation[] => appState.snapshot().automations

  const validateAutomation = (input: CreateAutomationInput | UpdateAutomationInput): void => {
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 120)) throw new RuntimeError('INVALID_INPUT', 'Automation 名称无效')
    if (input.prompt !== undefined && (!input.prompt.trim() || input.prompt.length > 100_000)) throw new RuntimeError('INVALID_INPUT', 'Automation 提示词无效')
    if (input.intervalMs !== undefined && input.intervalMs !== null && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 60_000 || input.intervalMs > 365 * 24 * 60 * 60 * 1000)) {
      throw new RuntimeError('INVALID_INPUT', 'Automation interval 必须在 1 分钟到 1 年之间')
    }
    if (input.schedule !== undefined && input.schedule !== null) {
      const schedule = input.schedule
      if (!['hour', 'day', 'week', 'month'].includes(schedule.unit)) throw new RuntimeError('INVALID_INPUT', 'Automation 重复单位无效')
      if (schedule.timeOfDay !== undefined) {
        const time = parseTimeOfDay(schedule.timeOfDay)
        const raw = /^(\d{1,2}):(\d{2})$/u.exec(schedule.timeOfDay.trim())
        if (raw === null || time.hour !== Number(raw[1]) || time.minute !== Number(raw[2])) {
          throw new RuntimeError('INVALID_INPUT', 'Automation 时间格式应为 HH:MM')
        }
      }
      if (schedule.unit === 'week' && schedule.dayOfWeek !== undefined && (schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)) {
        throw new RuntimeError('INVALID_INPUT', 'Automation 星期应在 0-6 之间')
      }
      if (schedule.unit === 'month' && schedule.dayOfMonth !== undefined && (schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) {
        throw new RuntimeError('INVALID_INPUT', 'Automation 月份日期应在 1-31 之间')
      }
    }
    if (input.model && !modelRuntime.models.getModel(input.model.provider, input.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', 'Automation 模型不在 Pi 模型目录中')
    assertModelAllowed(input.model, 'Automation 模型')
    if (input.workspaceId) selectedWorkspace(input.workspaceId)
    if (input.presetId) selectedPreset(input.presetId)
  }

  const assertAutomationResourcesExist = (
    workspaceId: string | undefined,
    presetId: string | undefined,
    workspaces: readonly WorkspaceSummary[],
    presets: readonly AgentPreset[],
  ): void => {
    if (workspaceId && !workspaces.some(workspace => workspace.id === workspaceId)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    if (presetId && !presets.some(preset => preset.id === presetId)) throw new RuntimeError('NOT_FOUND', 'Agent preset 不存在')
  }

  const assertNoAutomationReferences = (items: readonly Automation[], resource: 'workspace' | 'preset', id: string): void => {
    const references = items.filter(item => (resource === 'workspace' ? item.workspaceId : item.presetId) === id)
    if (references.length === 0) return
    const resourceName = resource === 'workspace' ? '工作区' : 'Agent preset'
    const automationList = references.map(item => `${item.name}（${item.id}）`).join('、')
    throw new RuntimeError('CONFLICT', `${resourceName}仍被以下 Automation 引用：${automationList}。请先修改或删除这些 Automation`)
  }

  const createAutomation = async (input: CreateAutomationInput): Promise<Automation> => {
    validateAutomation(input)
    const now = Date.now()
    const intervalMs = input.intervalMs
    const schedule = input.schedule
    const enabled = input.enabled ?? (intervalMs !== undefined || schedule !== undefined)
    const candidate: Automation = {
      id: randomUUID(),
      name: input.name.trim(),
      prompt: input.prompt,
      enabled,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(input.model ? { model: { ...input.model } } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(input.accessMode ? { accessMode: input.accessMode } : {}),
      ...(input.builtin ? { builtin: input.builtin } : {}),
      createdAt: now,
      updatedAt: now,
    }
    if (enabled) {
      const at = dueAt(candidate, now)
      if (at !== undefined) candidate.nextRunAt = at
    }
    const stored = await appState.update(state => {
      assertAutomationResourcesExist(candidate.workspaceId, candidate.presetId, state.workspaces, state.presets)
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
      if (input.presetId !== undefined) current.presetId = input.presetId
      if (input.accessMode !== undefined) current.accessMode = input.accessMode
      let scheduleChanged = false
      if (input.schedule === null) {
        if (current.schedule !== undefined) scheduleChanged = true
        delete current.schedule
      } else if (input.schedule !== undefined) {
        current.schedule = input.schedule
        scheduleChanged = true
      }
      if (input.intervalMs === null) {
        if (current.intervalMs !== undefined) scheduleChanged = true
        delete current.intervalMs
      } else if (input.intervalMs !== undefined) {
        current.intervalMs = input.intervalMs
        scheduleChanged = true
      }
      if (input.enabled !== undefined) current.enabled = input.enabled
      if (scheduleChanged) {
        const at = current.enabled ? dueAt(current, Date.now()) : undefined
        if (at === undefined) delete current.nextRunAt
        else current.nextRunAt = at
      }
      if (!current.enabled || (current.intervalMs === undefined && current.schedule === undefined)) delete current.nextRunAt
      assertAutomationResourcesExist(current.workspaceId, current.presetId, state.workspaces, state.presets)
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

  /** The run history is a tail: newest first, capped, and always including `lastRun`. */
  const recordRun = (automation: Automation, run: AutomationRun): void => {
    automation.lastRun = run
    const runs = (automation.runs ?? []).filter(item => item.id !== run.id)
    runs.unshift(run)
    automation.runs = runs.slice(0, MAX_RUN_HISTORY)
  }

  const finishAutomation = async (automationId: string, runId: string, conversationId: string): Promise<void> => {
    let status: NonNullable<Automation['lastRun']>['status'] = 'completed'
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
        conversationId,
        startedAt: automation.lastRun.startedAt,
        finishedAt,
        ...(errorMessage ? { error: errorMessage } : {}),
      })
      automation.updatedAt = finishedAt
      const at = automation.enabled ? dueAt(automation, finishedAt) : undefined
      if (at === undefined) delete automation.nextRunAt
      else automation.nextRunAt = at
      return structuredClone(automation)
    })
    if (updated) scheduleAutomation(updated)
  }

  runAutomation = async (id: string): Promise<{ automation: Automation; conversationId: string }> => {
    const current = appState.snapshot().automations.find(item => item.id === id)
    if (!current) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
    if (current.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 已在运行')
    const runId = randomUUID()
    const startedAt = Date.now()
    const running = await appState.update(state => {
      const automation = state.automations.find(item => item.id === id)
      if (!automation) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
      if (automation.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 已在运行')
      recordRun(automation, { id: runId, status: 'running', startedAt })
      delete automation.nextRunAt
      automation.updatedAt = startedAt
      return structuredClone(automation)
    })
    let conversationId: string | undefined
    try {
      const detail = await create({
        title: running.name,
        ...(running.model ? { model: running.model } : {}),
        ...(running.workspaceId ? { workspaceId: running.workspaceId } : {}),
        ...(running.presetId ? { presetId: running.presetId } : {}),
        ...(running.accessMode ? { accessMode: running.accessMode } : {}),
      })
      conversationId = detail.conversation.id
      await submit(conversationId, { text: running.prompt, requestId: `automation:${runId}`, whenBusy: 'reject' })
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation === undefined || automation.lastRun?.id !== runId) return
        const runs = automation.runs ?? []
        const index = runs.findIndex(item => item.id === runId)
        if (index >= 0) runs[index] = { ...runs[index]!, conversationId }
        automation.runs = runs
        automation.lastRun = { ...automation.lastRun!, conversationId }
      })
    } catch (error) {
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation?.lastRun?.id === runId) {
          recordRun(automation, {
            id: runId,
            status: 'failed',
            startedAt,
            finishedAt: Date.now(),
            ...(conversationId ? { conversationId } : {}),
            error: safeFailure(error),
          })
          automation.updatedAt = Date.now()
          const at = automation.enabled ? dueAt(automation, Date.now()) : undefined
          if (at === undefined) delete automation.nextRunAt
          else automation.nextRunAt = at
        }
      })
      const updated = appState.snapshot().automations.find(item => item.id === id)
      if (updated) scheduleAutomation(updated)
      throw error
    }
    const task = finishAutomation(id, runId, conversationId)
    automationTasks.add(task)
    void task.finally(() => automationTasks.delete(task)).catch(() => undefined)
    const latest = appState.snapshot().automations.find(item => item.id === id)
    if (!latest || !conversationId) throw new RuntimeError('CONFLICT', 'Automation 运行状态无法读取')
    return { automation: latest, conversationId }
  }

  const recoverAutomations = async (): Promise<void> => {
    const recovered = await appState.update(state => {
      const now = Date.now()
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
        const at = automation.enabled ? dueAt(automation, now) : undefined
        if (at === undefined) delete automation.nextRunAt
        else if (automation.nextRunAt === undefined) automation.nextRunAt = at
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
    schedule?: AutomationSchedule
    workspaceId?: string
    model?: UiModelRef
    accessMode?: Automation['accessMode']
  }): Promise<Automation> => {
    const existing = appState.snapshot().automations.find(item => item.builtin === spec.key)
    if (existing !== undefined) {
      // A rebinding of the shared workspace must not leave the task pointing at the old one.
      if (spec.workspaceId !== undefined && existing.workspaceId !== spec.workspaceId) {
        return await updateAutomation(existing.id, { workspaceId: spec.workspaceId })
      }
      return existing
    }
    return await createAutomation({
      name: spec.name,
      prompt: spec.prompt,
      enabled: true,
      ...(spec.schedule ? { schedule: spec.schedule } : {}),
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
    ensureBuiltin,
    recover: recoverAutomations,
    assertNoAutomationReferences,
    close: () => automationScheduler.close(),
    drain: () => Promise.allSettled([...automationTasks]),
  }
}
