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
  AgentPreset, Automation, ConversationDetail, CreateAutomationInput, CreateConversationInput,
  ModelRef as UiModelRef, SubmitInput, UpdateAutomationInput, WorkspaceSummary,
} from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { AutomationScheduler } from '../automation/scheduler.ts'
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
  const scheduleAutomation = (automation: Automation): void => {
    automationScheduler.cancel(automation.id)
    if (isClosed() || !automation.enabled || automation.intervalMs === undefined) return
    const dueAt = automation.nextRunAt ?? Date.now() + automation.intervalMs
    automationScheduler.schedule(automation.id, dueAt, () => {
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
    const candidate: Automation = {
      id: randomUUID(),
      name: input.name.trim(),
      prompt: input.prompt,
      enabled: input.enabled ?? intervalMs !== undefined,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(input.model ? { model: { ...input.model } } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(input.enabled !== false && intervalMs !== undefined ? { nextRunAt: now + intervalMs } : {}),
      createdAt: now,
      updatedAt: now,
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
      if (input.intervalMs === null) {
        delete current.intervalMs
        delete current.nextRunAt
        if (input.enabled === undefined) current.enabled = false
      } else if (input.intervalMs !== undefined) {
        current.intervalMs = input.intervalMs
        current.nextRunAt = input.enabled === false ? undefined : Date.now() + input.intervalMs
      }
      if (input.enabled !== undefined) current.enabled = input.enabled
      if (!current.enabled || current.intervalMs === undefined) delete current.nextRunAt
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
      automation.lastRun = {
        id: runId,
        status,
        conversationId,
        startedAt: automation.lastRun.startedAt,
        finishedAt,
        ...(errorMessage ? { error: errorMessage } : {}),
      }
      automation.updatedAt = finishedAt
      if (automation.enabled && automation.intervalMs !== undefined) automation.nextRunAt = finishedAt + automation.intervalMs
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
      automation.lastRun = { id: runId, status: 'running', startedAt }
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
      })
      conversationId = detail.conversation.id
      await submit(conversationId, { text: running.prompt, requestId: `automation:${runId}`, whenBusy: 'reject' })
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation?.lastRun?.id === runId) automation.lastRun.conversationId = conversationId
      })
    } catch (error) {
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation?.lastRun?.id === runId) {
          automation.lastRun = {
            id: runId,
            status: 'failed',
            startedAt,
            finishedAt: Date.now(),
            ...(conversationId ? { conversationId } : {}),
            error: safeFailure(error),
          }
          automation.updatedAt = Date.now()
          if (automation.enabled && automation.intervalMs !== undefined) automation.nextRunAt = Date.now() + automation.intervalMs
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
          automation.lastRun = {
            ...automation.lastRun,
            status: 'interrupted',
            finishedAt: now,
            error: 'Pi Durable Web 在运行期间重新启动',
          }
          automation.updatedAt = now
        }
        if (automation.enabled && automation.intervalMs !== undefined && automation.nextRunAt === undefined) {
          automation.nextRunAt = now + automation.intervalMs
        }
      }
      return structuredClone(state.automations)
    })
    for (const automation of recovered) scheduleAutomation(automation)
  }


  return {
    list: automations,
    create: createAutomation,
    update: updateAutomation,
    remove: deleteAutomation,
    run: (id: string) => runAutomation(id),
    recover: recoverAutomations,
    assertNoAutomationReferences,
    close: () => automationScheduler.close(),
    drain: () => Promise.allSettled([...automationTasks]),
  }
}
