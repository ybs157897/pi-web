/**
 * Automation（定时任务）的增删改查、排程与运行记录。
 *
 * 任务持有一条两段式 RRULE 规则与一个投递目标。`new` 与 `new_once` 运行是
 * 「普通会话 + 一条提示」，因此本模块只拥有排程与运行记录；会话的创建与提交
 * 委托给会话 feature。`session` 投递改为向既有会话发消息，没有独立的运行结果
 * ——送达即结果，记录为 `delivered`。
 *
 * 旧格式记录（`enabled` 标志加 `intervalMs` 或四单位日历排程）在任何定时器
 * 布防前于 `recover()` 中迁移。
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

/** 自动化运行会触碰的 Pi 会话能力子集（等待空闲）。 */
export interface RuntimeConversation {
  readonly id: ConversationId
  waitForIdle(context: Context): Promise<void>
}

/** 自动化 feature 的依赖注入契约：排程决策与实际运行都通过组合根回调完成。 */
export interface AutomationsDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  /** 读取组合根的关闭标志；置位后停止排程。 */
  isClosed: () => boolean
  requireConversation(value: string): Promise<RuntimeConversation>
  currentDetail(id: ConversationId): Promise<ConversationDetail>
  selectedWorkspace(id: string | undefined): WorkspaceSummary
  assertModelAllowed(model: UiModelRef | undefined, label: string): void
  create(input: CreateConversationInput): Promise<ConversationDetail>
  submit(value: string, input: SubmitInput): Promise<{ submissionId: string }>
}

/** 运行历史保留的已完成条数上限；列表是尾部而非归档。 */
const MAX_RUN_HISTORY = 50

/**
 * 功能：把一条定时触发的提示包装成带调度的框架文本。
 * @param automation 任务记录
 * @param plannedAt 计划触发时间戳
 * @returns 以 `[SCHEDULE REMINDER]` 开头的多行文本，模型据此与新鲜用户轮次区分
 */
export function framedPrompt(automation: Automation, plannedAt: number): string {
  return [
    '[SCHEDULE REMINDER]',
    '这是一条来自用户的定时消息',
    `schedule_id_json: ${JSON.stringify(automation.id)}`,
    `occurrence_at: ${new Date(plannedAt).toISOString()}`,
    `reminder_prompt_json: ${JSON.stringify(automation.prompt)}`,
  ].join('\n')
}

/** 支持 RRULE 之前写入的应用状态里仍存在的旧记录形状。 */
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

/** 把旧格式的间隔/日历字段转换为新 TimingDraft；两种旧字段都没有时返回 undefined。 */
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
 * 功能：把一条存储记录迁移到当前形状。
 * @param raw 旧（或已迁移）记录
 * @param now 当前时间戳，用于把旧排程编译成 RRULE
 * @returns 迁移后的记录；幂等——已带 `status`、`target` 与 RRULE（或两者皆无）
 * 的记录原样返回
 * 内部逻辑：enabled=false 映射为 paused；旧 intervalMs 映射为分钟级频率、旧
 * 四单位日历映射为对应频率；无规则的 active 任务降级为 paused，旧字段被删除。
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

/**
 * 功能：创建自动化 feature 服务——任务 CRUD、排程布防、运行执行与记录、启动恢复
 * 与内置任务保障。
 * @param deps 依赖注入契约见 AutomationsDeps；会话创建/提交复用会话 feature
 * 职责边界：拥有排程与运行记录；运行本身的模型调用经 submit 进入会话引擎。
 */
export function createAutomations(deps: AutomationsDeps) {
  const {
    appState, modelRuntime, isClosed, requireConversation, currentDetail,
    selectedWorkspace, assertModelAllowed, create, submit,
  } = deps

  /** 在途运行 promise 集合，供关闭时 drain 等待。 */
  const automationTasks = new Set<Promise<void>>()
  let runAutomation: (id: string) => Promise<{ automation: Automation; conversationId: string }>
  const automationScheduler = new AutomationScheduler()
  /**
   * 功能：计算任务下次触发时间。
   * @param automation 任务记录
   * @param from 计算起点时间戳
   * @returns 下次触发时间；无规则或规则解析失败返回 undefined
   * 内部逻辑：优先使用存档的 `nextRunAt`（跨重启保持到期时间稳定），否则向
   * 规则询问下一次出现；解析失败的任务由 recover 暂停。
   */
  const dueAt = (automation: Automation, from: number): number | undefined => {
    if (automation.rrule === undefined) return undefined
    try {
      return nextRunOf(automation.rrule, from)
    } catch {
      // 解析失败的存档规则无法触发；recover 会把它暂停。
      return undefined
    }
  }
  /** 先取消既有定时器再按需布防：运行时关闭或任务非 active 时不排。 */
  const scheduleAutomation = (automation: Automation): void => {
    automationScheduler.cancel(automation.id)
    if (isClosed() || automation.status !== 'active') return
    const at = automation.nextRunAt ?? dueAt(automation, Date.now())
    if (at === undefined) return
    automationScheduler.schedule(automation.id, at, () => {
      void runAutomation(automation.id).catch(() => undefined)
    })
  }
  /** 读取当前任务列表快照。 */
  const automations = (): Automation[] => appState.snapshot().automations

  /**
   * 功能：校验任务的创建/更新输入。
   * @param input 待校验的字段
   * @returns 通过即无返回，否则抛 INVALID_INPUT / MODEL_UNAVAILABLE
   * 内部逻辑：名称 1-120 字符、提示词 ≤100k、RRULE 必须能被 parseRule 解析、
   * target/status 限枚举、模型须在目录与白名单内、工作区须存在。
   */
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

  /** 校验任务引用的工作区仍然存在（事务内使用）。 */
  const assertAutomationResourcesExist = (
    workspaceId: string | undefined,
    workspaces: readonly WorkspaceSummary[],
  ): void => {
    if (workspaceId && !workspaces.some(workspace => workspace.id === workspaceId)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
  }

  /** 工作区仍被任务引用时抛 CONFLICT，列出引用者；供工作区删除前调用。 */
  const assertNoAutomationReferences = (items: readonly Automation[], id: string): void => {
    const references = items.filter(item => item.workspaceId === id)
    if (references.length === 0) return
    const automationList = references.map(item => `${item.name}（${item.id}）`).join('、')
    throw new RuntimeError('CONFLICT', `工作区仍被以下 Automation 引用：${automationList}。请先修改或删除这些 Automation`)
  }

  /**
   * 功能：创建一个定时任务。
   * @param input 任务字段（名称、提示词、RRULE、目标、模型、工作区等）
   * @returns 创建后的任务
   * 内部逻辑：session 目标要求会话存在；无规则的 active 任务只能手动运行（拒绝）
   * 或降级 paused。active 且规则可解析时立即计算 nextRunAt，规则已耗尽（无下次
   * 出现）则标记 ended。事务内校验工作区存在后布防排程。
   */
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

  /**
   * 功能：更新一个定时任务。
   * @param id 任务 ID
   * @param input 部分更新的字段
   * @returns 更新后的任务
   * 内部逻辑：RRULE 显式置 null 表示移除规则；无规则的 active 任务降级 paused。
   * 计时变化或 nextRunAt 缺失时重算到期时间，规则耗尽标记 ended；非 active 删除
   * nextRunAt。session 目标必须有会话。保存后重新布防。
   */
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
      // 没有规则的任务永远不会触发，因此不能自称 active。
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

  /**
   * 功能：删除一个定时任务。
   * @param id 任务 ID
   * @returns 无返回；正在运行的任务抛 CONFLICT
   * 内部逻辑：先取消排程定时器，再从事务中移除记录。
   */
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

  /** 功能：清除所有规则已耗尽（ended）的任务；返回清除数量。 */
  const purgeEnded = async (): Promise<number> => {
    const ended = appState.snapshot().automations.filter(item => item.status === 'ended')
    for (const automation of ended) automationScheduler.cancel(automation.id)
    await appState.update(state => {
      state.automations = state.automations.filter(item => item.status !== 'ended')
      return structuredClone(state.automations)
    })
    return ended.length
  }

  /** 运行历史是尾部：最新在前、封顶 MAX_RUN_HISTORY，且始终与 lastRun 一致。 */
  const recordRun = (automation: Automation, run: AutomationRun): void => {
    automation.lastRun = run
    const runs = (automation.runs ?? []).filter(item => item.id !== run.id)
    runs.unshift(run)
    automation.runs = runs.slice(0, MAX_RUN_HISTORY)
  }

  /** 运行后推进规则，规则不再有下一次出现时结束任务。 */
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

  /**
   * 功能：等待一次运行的目标会话空闲，并据其错误状态落定运行记录、推进规则与重新排程。
   * @param automationId 任务 ID
   * @param runId 本次运行 ID
   * @param conversationId 运行目标会话 ID
   * @param plannedAt 计划触发时间
   * @returns 无返回；会话详情带错误或等待失败记为 failed
   * 内部逻辑：记录写入要求 lastRun 仍是本次 runId（防并发覆盖）；写完后用最新
   * 记录重新布防排程。
   */
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

  /** 功能：把一次触发投递进既有会话——送达即结果，记录为 delivered。 */
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

  /**
   * 功能：执行一次任务触发。
   * @param id 任务 ID
   * @returns 任务记录与目标会话 ID
   * 内部逻辑：已在运行的任务拒绝。先在事务里写 running 记录并清 nextRunAt，
   * 再按 target 分流：session 走 deliverToSession；new/new_once 创建（或复用
   * new_once 已保留的）会话并以 `automation:<runId>` 提交提示。失败写 failed
   * 记录、推进规则并重新排程后抛出；成功路径把等待空闲落定记录的 promise 挂入
   * automationTasks，立即返回。
   */
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
        // 复用首次投递保留的会话，除非它已被删除。
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
        // new_once 任务收养它的第一个会话，之后一直复用。
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

  /**
   * 功能：启动恢复——迁移旧记录、暂停无法解析的规则、标记崩溃中断的运行并重新布防。
   * @returns 无返回；恢复完成后按最新记录逐一排程
   * 内部逻辑：任何定时器布防前调用。上次运行停留在 running 的记录改记为
   * interrupted（附重启原因）；active 任务重算或沿用 nextRunAt，规则耗尽标记 ended。
   */
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
            // 引擎拒绝的规则无法触发；任务保持可见但暂停。
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
   * 功能：保障服务端拥有的内置任务存在且与最新规范同步。
   * @param spec 内置任务的键、名称、提示词与可选配置
   * @returns 现有（已按需 patch）或新建的任务
   * 内部逻辑：从不复活操作者已删除的任务——是否应存在由调用方（标记文件）决定。
   * 已存在时只 patch 漂移的字段：提示词为服务端所有，必须随分析规程更新；
   * 共享工作区改绑后不得指向旧工作区。
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
      // 内置任务的提示词归服务端所有：早于当前分析规程创建的协调者
      // 会把旧规则交给它的 worker。
      const patch: UpdateAutomationInput = {}
      if (existing.prompt !== spec.prompt) patch.prompt = spec.prompt
      // 共享工作区重新绑定后，任务不得继续指向旧工作区。
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

  /** 读取一个任务的运行历史；无 runs 数组时退回仅含 lastRun 的列表。 */
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