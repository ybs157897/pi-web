import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { configure, defineDoc, defineExtension, defineTask, defineTool, InboxDoc, LiveDoc, type AgentChange, type ConversationId, type Harness, type TaskId, type Tx } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { copyJson, type Draft } from '@earendil-works/chord'
import type { AccessMode, ConversationDetail, ModelRef, SubmitInput, ThinkingLevel, WorkspaceSummary } from '../../shared/types.ts'
import type { ConversationFailure } from '../../shared/conversation-failure.ts'
import type { SkillSummary } from '../../shared/skills.ts'
import type { CreateWorkbenchBotInput, UpdateWorkbenchBotInput, WorkbenchAgent, WorkbenchMessage, WorkbenchReplyInput, WorkbenchRetryInput, WorkbenchSubmitInput, WorkbenchView, WorkItem, WorkItemStatus, WorkItemWaitingOn } from '../../shared/workbench.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { Subagents } from '../conversation/subagent-policy.ts'
import { workspaceWriteSupported } from '../conversation/execution-env.ts'
import { Interactions } from '../tools/interaction.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { ConversationFailureError, conversationFailure, runFailure, submissionFailure } from '../conversation/failure.ts'
import { CTX, META, assertSubmit, fingerprintSubmit, parseConversationId } from './helpers.ts'
import { planWork, workerInstructions, type PlannedTask } from './workbench-plan.ts'
import { WORKBENCH_CREATE_BOT_TOOL, WorkbenchBotRoster, botRoster, boundedBotAccess, createUserBot, findBot, incubateBot, updateBotProfile, createWorkbenchBotSchema, updateWorkbenchBotSchema, type ProposedWorkbenchBot, type WorkbenchBotProfile } from './workbench-bots.ts'
import { workbenchEvidence, workbenchEvidenceHook } from './workbench-evidence.ts'

type WorkbenchSeat = { workspaceId: string; itemId?: string; skillIds?: string[] | null }
type StoredModel = { provider: string; modelId: string }
type StoredSubmit = Pick<SubmitInput, keyof SubmitInput>
type WorkspaceAccess = 'workspaceWrite' | 'readOnly'
export const WorkbenchSeats = defineDoc<{ seat: WorkbenchSeat | null }>({
  kind: 'pi-web.workbench-seat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ seat: null }), checkpointWhen: () => false,
})

const WorkbenchIndex = defineDoc<{ workspaces: Record<string, number> }>({
  kind: 'pi-web.workbench-index', version: 1, scope: 'session',
  initial: () => ({ workspaces: {} }), checkpointWhen: () => true,
})

type Dispatch = WorkbenchMessage & {
  phase: 'queued' | 'planning' | 'planned' | 'failed'
  fingerprint: string
  input?: StoredSubmit & { mention?: string; accessMode?: AccessMode }
  model: StoredModel
  thinkingLevel?: ThinkingLevel
  accessMode: AccessMode
  lease?: { owner: string; expiresAt: number }
}
type WorkItemRun = {
  requestId: string
  input?: StoredSubmit
  inputQueued?: true
  accessMode: AccessMode
  model: StoredModel
  thinkingLevel?: ThinkingLevel
  modelOverride?: StoredModel
  thinkingOverride?: ThinkingLevel
  /** null uses current Bot permissions; older records use their saved access mode. */
  accessCeiling?: AccessMode | null
  startedAt?: number
  elapsedMs?: number
  timingOut?: true
  lease?: { owner: string; expiresAt: number }
  failures: number
  retryAt?: number
}
type BotCreation = { draft: ProposedWorkbenchBot; receipt?: { id: string; name: string; created: boolean } }
type StoredWorkItem = { view: WorkItem; run: WorkItemRun; replies?: Record<string, string>; botCreation?: BotCreation }
const Workbench = defineDoc<{ anchor: number | null; messages: Dispatch[]; items: StoredWorkItem[] }>({
  kind: 'pi-web.workbench', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ anchor: null, messages: [], items: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
})

// The owned conversation remains continuable across separate worker runs and server restarts.
const WorkbenchAnchor = defineTask<null, { phase: 'park' }, null, object>({
  name: 'pi-web.workbench-anchor', version: 1, initial: () => ({ phase: 'park' }),
  phases: {
    park: async (_task, runtime, context) => {
      if (!runtime.signal.aborted) {
        await new Promise<void>(resolve => runtime.signal.addEventListener('abort', () => resolve(), { once: true }))
      }
      await runtime.commit(() => ({
        status: 'terminal', outcome: { status: 'aborted', reason: 'workbench anchor released' },
      }), context).catch(() => undefined)
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: 'terminal', outcome: { status: 'aborted', reason: 'workbench anchor aborted' },
    }), context)
  },
})
export function createWorkbenchRuntimeExtension(harness: () => Harness) {
  return defineExtension({
    name: 'pi-web-workbench', tasks: [WorkbenchAnchor],
    tools: [defineTool({
      name: WORKBENCH_CREATE_BOT_TOOL,
      description: '提交本次用户明确要求创建的 Bot 配置。草案由主 Agent 准备，仅在通用智能体的建档工作项可用。重复调用返回同一个建档回执。调用后根据回执告诉用户 Bot 名称与创建结果。',
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: 'safe',
      execute: async (_args, api, context) => {
        const receipt = await api.commit(async tx => {
          const { seat } = await tx.doc(WorkbenchSeats, api.conversationId)
          if (!seat?.itemId) throw new RuntimeError('FORBIDDEN', '当前会话没有获准的 Bot 建档工作项')
          const index = await tx.doc(WorkbenchIndex)
          const mainId = index.workspaces[seat.workspaceId] as ConversationId | undefined
          if (mainId === undefined) throw new RuntimeError('NOT_FOUND', '没有找到 Bot 所属的工作空间')
          const workbench = await tx.doc(Workbench, mainId)
          const item = workbench.items.find(candidate => candidate.view.id === seat.itemId)
          if (!item?.botCreation || item.view.assignee !== 'general' || item.view.childId !== String(api.conversationId)) {
            throw new RuntimeError('FORBIDDEN', '当前会话没有获准的 Bot 建档工作项')
          }
          if (item.botCreation.receipt) return { ...item.botCreation.receipt }
          const roster = await tx.doc(WorkbenchBotRoster, mainId)
          const { bot, created } = incubateBot(botRoster(roster.bots), item.botCreation.draft)
          if (created) {
            roster.bots.push(bot)
            const message = workbench.messages.find(message => message.requestId === item.view.requestId)
            if (message) message.createdBotId = bot.id
          }
          const result = { id: bot.id, name: bot.name, created }
          item.botCreation.receipt = result
          return result
        }, context)
        return {
          output: [{ type: 'text', text: receipt.created ? `已创建 Bot「${receipt.name}」` : `已复用名册里的 Bot「${receipt.name}」` }],
          details: receipt,
        }
      },
    })],
    hooks: [workbenchEvidenceHook(harness, async (id, context) => {
      const seat = (await harness().snapshot(WorkbenchSeats, id, context))?.seat
      if (!seat?.itemId) return undefined
      const parent = (await harness().snapshot(WorkbenchIndex, context))?.workspaces[seat.workspaceId]
      if (parent === undefined) return undefined
      const doc = await harness().snapshot(Workbench, parent as ConversationId, context)
      return doc?.items.find(item => item.view.id === seat.itemId)?.view.attempt
    })],
  })
}

type WorkbenchDeps = {
  dataDir: string
  harness(): Harness
  assertOpen(): void
  modelRuntime: RuntimeModels
  selectedWorkspace(id: string): WorkspaceSummary
  defaultAccessMode(): AccessMode
  workspaceWriteAvailable: boolean
  buildAgentChange(workspaceId: string, accessMode: AccessMode, overrides?: { model?: ModelRef; thinkingLevel?: ThinkingLevel; workbenchBotCreation?: boolean }): Promise<AgentChange>
  currentDetail(id: ConversationId, options?: { subagents: boolean; team: boolean }): Promise<ConversationDetail>
  submit(id: string, input: SubmitInput): Promise<{ submissionId: string }>
  serializeInteractionSettlement<T>(id: ConversationId, action: () => Promise<T>): Promise<T>
  listSkills(workspaceId: string): Promise<SkillSummary[]>
  defaultModel(): ModelRef | undefined
}

const TICK_MS = 1_000
const LEASE_MS = 15_000
const RUN_LIMIT_MS = 15 * 60_000
const PLANNER_LEASE_MS = 120_000
const MAX_ACTIVE_WORKERS = 3
const SEAT_DETAIL = { subagents: false, team: false }

export async function workbenchDirectory(dataDir: string, workspaceId: string, itemId: string): Promise<string> {
  if (![workspaceId, itemId].every(id => /^[a-z0-9_-]+$/iu.test(id))) throw new RuntimeError('INVALID_INPUT', '工作项目录标识无效')
  const path = join(await realpath(dataDir), 'workbench-runs', workspaceId, itemId)
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (await realpath(path) !== path) throw new RuntimeError('FORBIDDEN', '工作项目录不能经过符号链接')
  return path
}

function transition(item: Draft<WorkItem>, status: WorkItemStatus, waitingOn: WorkItemWaitingOn): void {
  item.status = status
  item.waitingOn = waitingOn
  item.updatedAt = Date.now()
}

function submissionReceipt(items: readonly StoredWorkItem[], id: string): string | undefined {
  return items.find(item => item.view.id === id)?.view.childId
}

/** Durable messages and work items are scoped to the workspace seat rather than the worker transcript. */
export function createWorkbench(deps: WorkbenchDeps) {
  const { harness: harnessOf } = deps
  const schedulerId = randomUUID()
  let closed = false
  let sweepInFlight: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const planning = new Map<string, AbortController>()
  const planningRuns = new Set<Promise<void>>()
  const workspacePermissions = new Map<string, Promise<WorkspaceAccess>>()

  async function ensureMain(workspaceId: string): Promise<ConversationId> {
    deps.assertOpen()
    const workspace = deps.selectedWorkspace(workspaceId)
    const previous = (await harnessOf().snapshot(WorkbenchIndex, CTX))?.workspaces[workspace.id]
    if (previous !== undefined) return previous as ConversationId
    // Resolve the displayed model before the commit, without exposing any tools to the lead seat.
    const leadAgent = await deps.buildAgentChange(workspace.id, 'readOnly').catch(() => ({}))
    return harnessOf().commit(async tx => {
      const index = await tx.doc(WorkbenchIndex)
      if (index.workspaces[workspace.id] !== undefined) return index.workspaces[workspace.id] as ConversationId
      const main = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      await configure(tx, main.id, { ...leadAgent, tools: [], modelTools: null })
      const metadata = await tx.doc(META, main.id)
      metadata.title = 'Agent 对话'
      metadata.titleSource = 'user'
      metadata.workspaceId = workspace.id
      metadata.accessMode = 'readOnly'
      const link = await tx.doc(WorkbenchSeats, main.id)
      link.seat = { workspaceId: workspace.id }
      index.workspaces[workspace.id] = Number(main.id)
      return main.id
    }, CTX)
  }

  async function listWorkItems(workspaceId: string): Promise<WorkItem[]> {
    deps.assertOpen()
    const workspace = deps.selectedWorkspace(workspaceId)
    const main = (await harnessOf().snapshot(WorkbenchIndex, CTX))?.workspaces[workspace.id]
    if (main === undefined) return []
    const state = await harnessOf().snapshot(Workbench, main as ConversationId, CTX)
    return state?.items.map(item => item.view) ?? []
  }

  async function readBots(mainId: ConversationId): Promise<WorkbenchBotProfile[]> {
    const stored = await harnessOf().snapshot(WorkbenchBotRoster, mainId, CTX)
    return botRoster(stored?.bots ?? [])
  }

  async function workspacePermission(workspaceId: string): Promise<WorkspaceAccess> {
    if (!deps.workspaceWriteAvailable) return 'readOnly'
    const { path } = deps.selectedWorkspace(workspaceId)
    const cached = workspacePermissions.get(path)
    if (cached) return cached
    // The tool environment checks the actual sandbox again when it is created.
    const probed = workspaceWriteSupported(path).then((supported): WorkspaceAccess => supported ? 'workspaceWrite' : 'readOnly')
    workspacePermissions.set(path, probed)
    return probed
  }

  function botAccess(profile: WorkbenchBotProfile, workspaceAccess: WorkspaceAccess, ceiling: AccessMode | null = null): AccessMode {
    const configured = profile.accessMode ?? workspaceAccess
    const granted = ceiling === null ? configured : boundedBotAccess(ceiling, configured)
    return granted === 'workspaceWrite' ? workspaceAccess : granted
  }

  function agentView(profile: WorkbenchBotProfile, items: readonly WorkItem[], skills: readonly SkillSummary[], defaultAccess: WorkspaceAccess): WorkbenchAgent {
    const assigned = items.filter(item => item.assignee === profile.id)
    const latest = assigned.findLast(item => item.childId !== undefined)
    const { skillIds } = profile
    const model = profile.model ?? deps.defaultModel()
    return {
      id: profile.id, name: profile.name, role: profile.role, description: profile.description,
      status: assigned.some(item => item.status === 'running') ? 'running' : 'idle',
      skills: skills.filter(skill => skillIds === null || skillIds.includes(skill.id)).map(skill => skill.name),
      ...(latest?.childId ? { conversationId: latest.childId } : {}),
      ...(model === undefined ? {} : { model }),
      accessMode: botAccess(profile, defaultAccess),
      config: {
        instructions: profile.instructions, accessMode: profile.accessMode ?? defaultAccess, skillIds,
        icon: profile.icon, origin: profile.origin,
        ...(profile.model === undefined ? {} : { model: profile.model }),
      },
    }
  }

  async function changeBot(workspaceId: string, input: CreateWorkbenchBotInput | UpdateWorkbenchBotInput, botId?: string): Promise<WorkbenchAgent> {
    const parsed = botId === undefined ? createWorkbenchBotSchema.safeParse(input) : updateWorkbenchBotSchema.safeParse(input)
    if (!parsed.success) throw new RuntimeError('INVALID_INPUT', 'Bot 配置格式不正确')
    const changes = parsed.data
    const mainId = await ensureMain(workspaceId)
    const [skills, state, defaultAccess] = await Promise.all([
      deps.listSkills(workspaceId), harnessOf().snapshot(Workbench, mainId, CTX), workspacePermission(workspaceId),
    ])
    if (changes.accessMode === 'workspaceWrite' && defaultAccess === 'readOnly') {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    if (changes.model) await deps.buildAgentChange(workspaceId, 'readOnly', { model: changes.model })
    if (changes.skillIds && changes.skillIds.some(id => !skills.some(skill => skill.id === id))) {
      throw new RuntimeError('INVALID_INPUT', '所选技能不在当前工作区技能目录中')
    }
    const profile = await harnessOf().commit(async tx => {
      const stored = await tx.doc(WorkbenchBotRoster, mainId)
      const roster = botRoster(stored.bots)
      const next = botId === undefined
        ? createUserBot(roster, changes as CreateWorkbenchBotInput)
        : updateBotProfile(roster, botId, changes)
      const index = stored.bots.findIndex(bot => bot.id === next.id)
      if (index < 0) stored.bots.push(next)
      else stored.bots[index] = next
      return copyJson(next) as WorkbenchBotProfile
    }, CTX)
    return agentView(profile, state?.items.map(item => item.view) ?? [], skills, defaultAccess)
  }

  async function view(workspaceId: string): Promise<WorkbenchView> {
    const mainId = await ensureMain(workspaceId)
    const defaultAccess = await workspacePermission(workspaceId)
    const [main, assignments, skills] = await Promise.all([
      deps.currentDetail(mainId, SEAT_DETAIL),
      // Creating a specialist and assigning its work is one transaction. Read both
      // documents together to keep the same guarantee in frontend snapshots.
      harnessOf().commit(async tx => {
        const state = await tx.doc(Workbench, mainId)
        const roster = await tx.doc(WorkbenchBotRoster, mainId)
        const latestModel = state.messages.at(-1)?.model
        const profiles = botRoster(copyJson(roster.bots) as WorkbenchBotProfile[])
        const byId = new Map(profiles.map(profile => [profile.id, profile]))
        return {
          items: state.items.map(item => {
            const view = copyJson(item.view) as WorkItem
            const profile = byId.get(view.assignee)
            if (view.status === 'ready' && profile) view.accessMode = workerAccess(item.run, profile, defaultAccess)
            else if (view.childId !== undefined) view.accessMode = item.run.accessMode
            if (item.botCreation !== undefined) view.replyAccessMode = 'readOnly'
            return view
          }),
          roster: profiles,
          running: state.messages.some(message => message.phase === 'queued' || message.phase === 'planning'),
          latestModel: latestModel === undefined ? undefined : { ...latestModel },
          messages: state.messages.map(({ requestId, text, at, mention, error, failure, failureAttempt, createdBotId }) => ({
            requestId, text, at,
            ...(mention === undefined ? {} : { mention }),
            ...(error === undefined ? {} : { error }),
            ...(failure ? { failure: { ...failure }, failureAttempt: failureAttempt ?? 1 } : {}),
            ...(createdBotId === undefined ? {} : { createdBotId }),
          })),
        }
      }, CTX),
      deps.listSkills(workspaceId).catch(() => []),
    ])
    const { items, roster, messages } = assignments
    const latestModel = assignments.latestModel ?? main.conversation.model
    const lead: WorkbenchAgent = {
      id: 'lead', name: '主 Agent', role: '分配 · 协调', description: '理解请求，安排工作项并将任务交给对应智能体。',
      status: assignments.running ? 'running' : 'idle',
      conversationId: String(mainId),
      ...(latestModel ? { model: latestModel } : {}),
      accessMode: 'readOnly', skills: [],
    }
    const workers = roster.map(profile => agentView(profile, items, skills, defaultAccess))
    return { main, items, agents: [lead, ...workers], messages }
  }

  async function submit(workspaceId: string, input: WorkbenchSubmitInput): Promise<{ requestId: string }> {
    assertSubmit(input)
    const workspace = deps.selectedWorkspace(workspaceId)
    const workspaceAccess = await workspacePermission(workspace.id)
    if (input.accessMode === 'workspaceWrite' && workspaceAccess === 'readOnly') {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([
      fingerprintSubmit(input), input.mention, input.model?.provider, input.model?.modelId, input.thinkingLevel, input.accessMode,
    ])).digest('hex')
    const mainId = await ensureMain(workspace.id)
    const requested = input.accessMode ?? deps.defaultAccessMode()
    const accessMode = input.mention === undefined
      ? requested === 'workspaceWrite' ? workspaceAccess : requested
      : botAccess(findBot(await readBots(mainId), input.mention), workspaceAccess, input.accessMode)
    const change = await deps.buildAgentChange(workspace.id, accessMode, input).catch(error => {
      if (error instanceof RuntimeError && error.code === 'MODEL_UNAVAILABLE') throw new ConversationFailureError(runFailure(error))
      throw error
    })
    if (!change.model) throw new ConversationFailureError(conversationFailure('MODEL_UNAVAILABLE'))
    const model = change.model
    const entry: Dispatch = {
      requestId: input.requestId, text: input.text, ...(input.mention ? { mention: input.mention } : {}),
      at: Date.now(), phase: 'queued', fingerprint, input,
      model, accessMode, ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
    }
    await harnessOf().commit(async tx => {
      const state = await tx.doc(Workbench, mainId)
      const previous = state.messages.find(message => message.requestId === input.requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new RuntimeError('CONFLICT', '发送标识已用于不同内容')
        return
      }
      state.messages.push(entry)
    }, CTX)
    wake()
    return { requestId: input.requestId }
  }

  function materialize(mainId: ConversationId, workspaceId: string, dispatch: Dispatch, tasks: PlannedTask[], botCreation: boolean): StoredWorkItem[] {
    const source = dispatch.input!
    const ids = tasks.map(() => randomUUID())
    return tasks.map((task, index) => {
      const id = ids[index]!
      const requestId = `workbench-start:${id}`
      const dependencies = [...new Set([...task.dependsOn.map(dependency => ids[dependency]!), ...task.previous])]
      const accessCeiling = botCreation ? 'readOnly'
        : source.mention !== undefined ? source.accessMode ?? null
          : task.type === 'build' ? dispatch.accessMode : 'readOnly'
      const body = [
        `工作项：${task.title}`,
        `目标：${task.objective}`,
        ...task.constraints.map(c => `约束：${c}`),
        ...task.acceptance.map(a => `验收：${a}`),
        '以下为用户原始请求。只执行此工作项被分配的范围，其他任务的工作由对应智能体承担。',
        source.text,
      ].join('\n')
      return {
        view: {
          id, requestId: dispatch.requestId, parentId: String(mainId), workspaceId,
          title: task.title, objective: task.objective, constraints: task.constraints, acceptance: task.acceptance,
          type: task.type, assignee: task.assignee, dependencies, status: 'ready',
          waitingOn: { kind: dependencies.length ? 'dependencies' : 'scheduler' },
          evidence: [], verification: 'pending', attempt: 1, createdAt: Date.now(), updatedAt: Date.now(),
        },
        run: {
          requestId, accessMode: accessCeiling ?? dispatch.accessMode, accessCeiling, model: dispatch.model, failures: 0,
          ...(dispatch.thinkingLevel ? { thinkingLevel: dispatch.thinkingLevel } : {}),
          input: {
            requestId, text: body,
            ...(source.images ? { images: source.images } : {}), ...(source.files ? { files: source.files } : {}),
          },
        },
      }
    })
  }

  function startPlanning(mainId: ConversationId, workspaceId: string, dispatch: Dispatch): void {
    const key = `${mainId}:${dispatch.requestId}`
    if (planning.has(key)) return
    const controller = new AbortController()
    planning.set(key, controller)
    const run = (async () => {
      const claimed = await harnessOf().commit(async tx => {
        const state = await tx.doc(Workbench, mainId)
        const current = state.messages.find(message => message.requestId === dispatch.requestId)
        if (!current || current.phase === 'planned' || current.phase === 'failed') return false
        if (current.lease && current.lease.expiresAt > Date.now()) return false
        current.phase = 'planning'
        current.lease = { owner: schedulerId, expiresAt: Date.now() + PLANNER_LEASE_MS }
        return true
      }, CTX)
      if (!claimed) return
      try {
        const [state, bots] = await Promise.all([harnessOf().snapshot(Workbench, mainId, CTX), readBots(mainId)])
        const context = {
          messages: state?.messages.filter(message => message.at <= dispatch.at && message.requestId !== dispatch.requestId).slice(-8) ?? [],
          items: state?.items.slice(-28).map(item => item.view) ?? [],
          bots,
        }
        const input = dispatch.input!
        const accessMode = input.mention === undefined ? dispatch.accessMode
          : botAccess(findBot(bots, input.mention), await workspacePermission(workspaceId), input.accessMode)
        const plan = await planWork(deps.modelRuntime, mainId, dispatch.model, input, accessMode, context, controller.signal)
        await harnessOf().commit(async tx => {
          const state = await tx.doc(Workbench, mainId)
          const current = state.messages.find(message => message.requestId === dispatch.requestId)
          if (!current || current.phase !== 'planning' || current.lease?.owner !== schedulerId) return
          const proposal = plan.newBot
          let tasks = plan.tasks
          if (proposal) {
            const roster = await tx.doc(WorkbenchBotRoster, mainId)
            const { bot, created } = incubateBot(botRoster(roster.bots), proposal)
            if (created) {
              roster.bots.push(bot)
              current.createdBotId = bot.id
            }
            tasks = tasks.map(task => task.assignee === proposal.id ? { ...task, assignee: bot.id } : task)
          }
          const records = materialize(mainId, workspaceId, dispatch, tasks, plan.createBot !== undefined)
          if (plan.createBot && records[0]) records[0].botCreation = { draft: plan.createBot }
          state.items.push(...records)
          current.phase = 'planned'
          delete current.input
          delete current.lease
        }, CTX)
      } catch (error) {
        await harnessOf().commit(async tx => {
          const state = await tx.doc(Workbench, mainId)
          const current = state.messages.find(message => message.requestId === dispatch.requestId)
          if (!current || current.lease?.owner !== schedulerId) return
          delete current.lease
          if (closed) {
            current.phase = 'queued'
            return
          }
          current.phase = 'failed'
          const failure = runFailure(error)
          current.failure = failure
          current.error = failure.message
        }, CTX)
      }
    })().catch(() => undefined).finally(() => {
      planning.delete(key)
      planningRuns.delete(run)
      wake()
    })
    planningRuns.add(run)
  }

  function workerAccess(run: Pick<WorkItemRun, 'accessCeiling' | 'accessMode'>, profile: WorkbenchBotProfile, workspaceAccess: WorkspaceAccess): AccessMode {
    return botAccess(profile, workspaceAccess, run.accessCeiling === undefined ? run.accessMode : run.accessCeiling)
  }

  async function workerAgent(item: StoredWorkItem, profile: WorkbenchBotProfile, accessMode: AccessMode): Promise<AgentChange> {
    const cwd = await workbenchDirectory(deps.dataDir, item.view.workspaceId, item.view.id)
    const plan = await deps.buildAgentChange(item.view.workspaceId, accessMode, {
      model: item.run.modelOverride ?? profile.model ?? item.run.model,
      thinkingLevel: item.run.thinkingOverride ?? item.run.thinkingLevel,
      workbenchBotCreation: item.botCreation !== undefined,
    })
    const instructions = workerInstructions(profile, accessMode)
    const creation = item.botCreation
    return {
      ...plan, cwd, instructions: creation === undefined ? instructions : [
        instructions,
        '当前工作项的授权范围仅为建档。核对用户明确请求创建 Bot 后，使用 create_workbench_bot 提交已准备的草案。如果只能调用 codemode，调用 tools.create_workbench_bot({})。实际结果以建档工具回执为准。仅汇报建档结果。',
        JSON.stringify(creation.draft),
      ].join('\n'),
    }
  }

  async function runChild(mainId: ConversationId, item: StoredWorkItem, profile: WorkbenchBotProfile, accessMode: AccessMode): Promise<boolean> {
    const agent = await workerAgent(item, profile, accessMode)
    return harnessOf().commit(async tx => {
      const state = await tx.doc(Workbench, mainId)
      const stored = state.items.find(row => row.view.id === item.view.id)
      if (!stored || stored.run.requestId !== item.run.requestId || stored.view.status !== 'ready') return false
      const roster = await tx.doc(WorkbenchBotRoster, mainId)
      if (findBot(botRoster(roster.bots), profile.id).accessMode !== profile.accessMode) return false
      const prerequisites = stored.view.dependencies.map(dependency => state.items.find(row => row.view.id === dependency))
      if (prerequisites.some(dependency => dependency?.view.outcome?.decision !== 'accepted')) return false
      const newChild = stored.view.childId === undefined
      let childId: ConversationId
      if (stored.view.childId === undefined) {
        const anchor = state.anchor === null ? undefined : await tx.task(state.anchor as TaskId)
        const anchorId = anchor && anchor.state.outcome === undefined ? anchor.id : await tx.createTask(WorkbenchAnchor, null, {
          ownership: { kind: 'conversation' }, conversationId: mainId, background: true,
        })
        state.anchor = Number(anchorId)
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchorId } })
        childId = child.id
        stored.view.childId = String(childId)
        const identity = await tx.doc(Subagents, childId)
        identity.record = {
          label: profile.name, createdAt: Date.now(), profile: 'general-purpose', workbench: true,
        }
      } else childId = parseConversationId(stored.view.childId)
      await configure(tx, childId, agent)
      const childSeat = await tx.doc(WorkbenchSeats, childId)
      childSeat.seat = { workspaceId: item.view.workspaceId, itemId: item.view.id, skillIds: profile.skillIds }
      const meta = await tx.doc(META, childId)
      meta.workspaceId = item.view.workspaceId
      meta.accessMode = accessMode
      meta.title = item.view.title
      meta.titleSource = 'user'
      if (newChild && stored.run.input && prerequisites.length) {
        const delivered = prerequisites.map(dependency => {
          const view = dependency!.view
          const artifacts = view.evidence.flatMap(pointer => pointer.path === undefined ? [] : [pointer.path]).slice(0, 8)
          const pointers = artifacts.length ? `\n  交付文件路径：${artifacts.join('、')}` : ''
          return `- ${view.title}：${view.outcome!.summary.slice(0, 900)}${pointers}`
        }).join('\n')
        stored.run.input.text = `已验收的上游交付是参考背景，只沿用当前请求授权：\n${delivered}\n\n${stored.run.input.text}`
      }
      if (stored.run.accessCeiling === undefined) stored.run.accessCeiling = item.run.accessMode
      stored.run.accessMode = accessMode
      stored.run.startedAt = Date.now()
      stored.run.elapsedMs = 0
      stored.run.lease = { owner: schedulerId, expiresAt: Date.now() + LEASE_MS }
      transition(stored.view, 'running', { kind: 'agent', detail: stored.view.assignee })
      return true
    }, CTX)
  }

  async function mutateItem(mainId: ConversationId, id: string, update: (item: Draft<StoredWorkItem>) => void) {
    await harnessOf().commit(async tx => {
      const state = await tx.doc(Workbench, mainId)
      const selected = state.items.find(item => item.view.id === id)
      if (selected) update(selected)
    }, CTX)
  }

  async function launchChild(mainId: ConversationId, item: StoredWorkItem): Promise<void> {
    if (item.view.childId === undefined || item.run.input === undefined) return
    if (item.run.retryAt !== undefined && item.run.retryAt > Date.now()) return
    try {
      await deps.submit(item.view.childId, item.run.input)
      const child = parseConversationId(item.view.childId)
      const receipt = await harnessOf().commit(tx => tx.submissionByRequest(child, item.run.requestId), CTX)
      await mutateItem(mainId, item.view.id, stored => {
        if (stored.run.requestId !== item.run.requestId) return
        // Keep an unplaced input available for retry if the timeout withdraws it.
        if (receipt?.status === 'queued' || receipt?.status === 'unanswered' && receipt.entry === undefined) {
          stored.run.inputQueued = true
        } else delete stored.run.input
        delete stored.run.retryAt
        delete stored.view.error
        delete stored.view.failure
      })
    } catch (error) {
      await mutateItem(mainId, item.view.id, stored => {
        if (stored.run.requestId !== item.run.requestId) return
        stored.run.failures += 1
        const failure = runFailure(error)
        if (failure.code === 'CONVERSATION_FAILED' && stored.run.failures <= 2) {
          stored.run.retryAt = Date.now() + 1_000 * (stored.run.failures + 1)
        } else {
          transition(stored.view, 'needs_human', { kind: 'human', detail: '执行未能启动' })
          stored.view.verification = 'failed'
          stored.view.failure = failure
          stored.view.error = failure.message
          delete stored.run.lease
        }
      })
    }
  }

  async function reconcileExecution(mainId: ConversationId, item: StoredWorkItem, child: ConversationId) {
    return deps.serializeInteractionSettlement(child, async () => {
      const observed = await harnessOf().commit(async tx => {
        const state = await tx.doc(Workbench, mainId)
        const stored = state.items.find(row => row.view.id === item.view.id)
        if (!stored || stored.run.requestId !== item.run.requestId) return
        if (stored.run.timingOut) return { kind: 'timeout' as const }
        const interaction = Object.entries(await tx.doc(Interactions, child)).find(([, request]) => request.status === 'pending')
        const submission = await tx.submissionByRequest(child, item.run.requestId)
        if (stored.run.inputQueued && submission?.entry !== undefined) {
          delete stored.run.input
          delete stored.run.inputQueued
        }
        const live = await tx.doc(LiveDoc, child)
        const inbox = await tx.doc(InboxDoc, child)
        const busy = live.run !== undefined || submission?.status === 'placed' || inbox.items.some(input => input.mode !== 'write')
        if (!busy && !interaction) return { kind: 'settled' as const, submission }

        const now = Date.now()
        const run = stored.run
        if (busy) {
          run.startedAt ??= now
          run.elapsedMs ??= 0
          if (run.elapsedMs + Math.max(0, now - run.startedAt) >= RUN_LIMIT_MS) {
            run.timingOut = true
            return { kind: 'timeout' as const }
          }
        } else if (interaction && run.startedAt !== undefined) {
          // Older waiting records did not store the start of the pause.
          const pausedAt = run.elapsedMs === undefined && stored.view.status === 'needs_human' ? interaction[1].askedAt : now
          run.elapsedMs = (run.elapsedMs ?? 0) + Math.max(0, pausedAt - run.startedAt)
          delete run.startedAt
        }
        if (interaction) {
          if (stored.view.status !== 'needs_human' || stored.view.waitingOn.detail !== interaction[0]) {
            transition(stored.view, 'needs_human', { kind: 'human', detail: interaction[0] })
          }
        } else if (stored.view.status !== 'running') {
          transition(stored.view, 'running', { kind: 'agent', detail: stored.view.assignee })
        }
        if (!run.lease || run.lease.expiresAt - now < LEASE_MS / 2) {
          run.lease = { owner: schedulerId, expiresAt: now + LEASE_MS }
        }
      }, CTX)
      if (observed?.kind !== 'timeout') return observed

      const conversation = await harnessOf().conversation(child, CTX)
      // Keep the durable deadline marker until the child and its queued inputs
      // have settled, so a server restart still completes the timeout.
      try { await conversation?.abort(CTX, { background: true }) } catch { return }
      await harnessOf().commit(async tx => {
        const state = await tx.doc(Workbench, mainId)
        const stored = state.items.find(row => row.view.id === item.view.id)
        if (!stored || stored.run.requestId !== item.run.requestId) return
        const interactions = await tx.doc(Interactions, child)
        const now = Date.now()
        for (const interaction of Object.values(interactions)) {
          if (interaction.status !== 'pending') continue
          interaction.status = 'cancelled'
          interaction.cancelledAt = now
        }
        delete stored.run.timingOut
        applyWorkItemFailure(stored, conversationFailure('WORKBENCH_TIMEOUT'))
      }, CTX)
    })
  }

  async function reconcileChild(mainId: ConversationId, item: StoredWorkItem): Promise<void> {
    if (item.view.childId === undefined) return
    if (item.run.lease?.owner !== schedulerId) {
      const claimed = await harnessOf().commit(async tx => {
        const state = await tx.doc(Workbench, mainId)
        const stored = state.items.find(row => row.view.id === item.view.id)
        if (!stored || stored.run.requestId !== item.run.requestId) return false
        const lease = stored.run.lease
        if (lease !== undefined && lease.owner !== schedulerId && lease.expiresAt > Date.now()) return false
        stored.run.lease = { owner: schedulerId, expiresAt: Date.now() + LEASE_MS }
        return true
      }, CTX)
      if (!claimed) return
    }
    if (item.run.input !== undefined && !item.run.inputQueued) {
      await launchChild(mainId, item)
      return
    }
    const child = parseConversationId(item.view.childId)
    const execution = await reconcileExecution(mainId, item, child)
    if (!execution) return
    const { submission } = execution
    if (submission?.status === 'unanswered') {
      const detail = await deps.currentDetail(child, SEAT_DETAIL)
      await markWorkerError(mainId, item, detail.failure ?? submissionFailure(submission.reason, submission.detail))
      return
    }
    if (submission?.status !== 'done') {
      await markWorkerError(mainId, item, conversationFailure('CONVERSATION_FAILED'))
      return
    }
    const detail = await deps.currentDetail(child, SEAT_DETAIL)
    if (detail.conversation.busy || detail.queue.length) return
    const start = detail.messages.findIndex(message => message.entryId === String(submission.entry))
    const messages = detail.messages.slice(Math.max(start, 0))
    const lastAnswer = [...messages].reverse().find(message =>
      message.role === 'assistant' && !message.streaming && message.status !== 'error' && message.status !== 'cancelled'
      && message.blocks.some(block => block.type === 'text' && block.text.trim() !== ''))
    if (detail.failure || detail.conversation.status === 'cancelled' || !lastAnswer) {
      await markWorkerError(mainId, item, detail.failure ?? conversationFailure(
        detail.conversation.status === 'cancelled' ? 'CONVERSATION_INTERRUPTED' : 'CONVERSATION_FAILED',
      ))
      return
    }
    const summary = lastAnswer.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 50_000)
    const evidence = await workbenchEvidence(harnessOf(), child, item.view.attempt, messages)
    evidence.push({
      kind: 'response', label: '查看智能体完整结果', status: 'recorded',
      ...(lastAnswer.entryId === undefined ? {} : { entryId: lastAnswer.entryId }),
    })
    const validation = evidence.filter(pointer => pointer.kind === 'validation')
    const verification = validation.some(pointer => pointer.status === 'failed') ? 'failed'
      : validation.some(pointer => pointer.status === 'passed') ? 'recorded' : 'insufficient'
    await mutateItem(mainId, item.view.id, stored => {
      if (stored.run.requestId !== item.run.requestId || stored.view.outcome?.decision === 'accepted') return
      if (stored.botCreation && !stored.botCreation.receipt) {
        applyWorkItemFailure(stored, { ...conversationFailure('CONVERSATION_FAILED'), message: 'Bot 建档没有提交，请重试此工作项。' })
        return
      }
      stored.view.outcome = { summary, at: Date.now() }
      stored.view.evidence = evidence
      stored.view.verification = verification
      delete stored.view.error
      delete stored.view.failure
      delete stored.run.lease
      transition(stored.view, 'pending_review', { kind: 'human', detail: '结果待验收' })
    })
  }

  async function markWorkerError(mainId: ConversationId, item: StoredWorkItem, failure: ConversationFailure): Promise<void> {
    await mutateItem(mainId, item.view.id, stored => {
      if (stored.run.requestId !== item.run.requestId) return
      applyWorkItemFailure(stored, failure)
    })
  }

  function applyWorkItemFailure(stored: Draft<StoredWorkItem>, failure: ConversationFailure): void {
    stored.view.failure = failure
    stored.view.error = failure.message
    stored.view.verification = 'failed'
    delete stored.run.lease
    transition(stored.view, 'needs_human', { kind: 'human', detail: '执行异常' })
  }

  async function sweep(): Promise<void> {
    const index = await harnessOf().snapshot(WorkbenchIndex, CTX)
    for (const [workspaceId, value] of Object.entries(index?.workspaces ?? {})) {
      if (closed) return
      try { deps.selectedWorkspace(workspaceId) } catch { continue }
      const mainId = value as ConversationId
      const state = await harnessOf().snapshot(Workbench, mainId, CTX)
      if (!state) continue
      const dispatch = state.messages.find(message => message.phase === 'queued' || message.phase === 'planning')
      if (dispatch?.input && (!dispatch.lease || dispatch.lease.expiresAt <= Date.now())) startPlanning(mainId, workspaceId, dispatch)
      const active = state.items.filter(item => item.view.status === 'running'
        || (item.view.status === 'needs_human' && !item.view.error))
      for (const item of active) {
        try { await reconcileChild(mainId, item) } catch (error) { await markWorkerError(mainId, item, runFailure(error)) }
      }
      const latest = await harnessOf().snapshot(Workbench, mainId, CTX)
      if (!latest || !latest.items.some(item => item.view.status === 'ready')) continue
      const running = latest.items.filter(item => item.view.status === 'running'
        || (item.view.status === 'needs_human' && !item.view.error && item.run.startedAt !== undefined))
      const accepted = new Set(latest.items.filter(item => item.view.outcome?.decision === 'accepted').map(item => item.view.id))
      let capacity = MAX_ACTIVE_WORKERS - running.length
      // A worker waiting on a real decision can resume directly from either surface.
      let writing = latest.items.some(item => item.run.accessMode !== 'readOnly'
        && (item.view.status === 'running' || (item.view.status === 'needs_human' && !item.view.error)))
      const profiles = new Map((await readBots(mainId)).map(profile => [profile.id, profile]))
      const workspaceAccess = await workspacePermission(workspaceId)
      for (const item of latest.items) {
        if (capacity <= 0) break
        if (item.view.status !== 'ready' || !item.view.dependencies.every(id => accepted.has(id))) continue
        try {
          const profile = profiles.get(item.view.assignee)
          if (!profile) throw new RuntimeError('NOT_FOUND', '未找到任务分配的 Bot')
          const accessMode = workerAccess(item.run, profile, workspaceAccess)
          if (accessMode !== 'readOnly' && writing) continue
          if (!await runChild(mainId, item, profile, accessMode)) continue
          capacity -= 1
          writing ||= accessMode !== 'readOnly'
        } catch (error) {
          await markWorkerError(mainId, item, runFailure(error))
        }
      }
    }
  }

  async function reply(workspaceId: string, itemId: string, input: WorkbenchReplyInput): Promise<{ submissionId: string }> {
    assertSubmit(input)
    const mainId = await ensureMain(workspaceId)
    const key = createHash('sha256').update(input.requestId).digest('hex')
    const basicFingerprint = fingerprintSubmit(input)
    const fingerprint = input.model === undefined && input.thinkingLevel === undefined
      ? basicFingerprint
      : createHash('sha256').update(JSON.stringify([basicFingerprint, input.model?.provider, input.model?.modelId, input.thinkingLevel])).digest('hex')
    await harnessOf().commit(async tx => {
      const state = await tx.doc(Workbench, mainId)
      const stored = state.items.find(item => item.view.id === itemId)
      if (!stored?.view.childId) throw new RuntimeError('NOT_FOUND', '工作项尚无可回复的子会话')
      const previous = stored.replies?.[key]
      if (previous !== undefined) {
        if (previous !== fingerprint) throw new RuntimeError('CONFLICT', '发送标识已用于不同内容')
        return
      }
      if (/^workbench-(?:start|revise|retry):/u.test(input.requestId)) throw new RuntimeError('INVALID_INPUT', '该发送标识由工作台保留')
      if (stored.view.status === 'running' || stored.view.status === 'ready') throw new RuntimeError('CONFLICT', '智能体正在等待或执行，请在本轮结束后继续')
      if (stored.view.status === 'needs_human' && !stored.view.error) throw new RuntimeError('CONFLICT', '请先答复当前待裁决事项')
      if (input.model !== undefined || input.thinkingLevel !== undefined) {
        await deps.buildAgentChange(workspaceId, 'readOnly', { model: input.model, thinkingLevel: input.thinkingLevel })
      }
      stored.replies ??= {}
      stored.replies[key] = fingerprint
      queueReply(stored, input)
      stored.run.accessCeiling = stored.botCreation === undefined ? null : 'readOnly'
    }, CTX)
    wake()
    const state = await harnessOf().snapshot(Workbench, mainId, CTX)
    const childId = submissionReceipt(state?.items ?? [], itemId)
    if (childId === undefined) throw new RuntimeError('NOT_FOUND', '工作项子会话不存在')
    const child = parseConversationId(childId)
    const receipt = await harnessOf().commit(tx => tx.submissionByRequest(child, input.requestId), CTX)
    return { submissionId: receipt ? String(receipt.id) : input.requestId }
  }

  function queueReply(stored: Draft<StoredWorkItem>, input: WorkbenchReplyInput): void {
    stored.view.attempt += 1
    delete stored.view.outcome
    delete stored.view.error
    delete stored.view.failure
    stored.view.evidence = []
    stored.view.verification = 'pending'
    const { model, thinkingLevel, ...turn } = input
    stored.run = {
      ...stored.run, requestId: turn.requestId, input: turn,
      failures: 0,
    }
    if (model === undefined) delete stored.run.modelOverride
    else stored.run.modelOverride = model
    if (thinkingLevel === undefined) delete stored.run.thinkingOverride
    else stored.run.thinkingOverride = thinkingLevel
    delete stored.run.retryAt
    delete stored.run.inputQueued
    delete stored.run.startedAt
    delete stored.run.elapsedMs
    delete stored.run.timingOut
    delete stored.run.lease
    transition(stored.view, 'ready', { kind: 'scheduler' })
  }

  /** The attempt guards duplicate recovery and replay after refresh. */
  async function retry(workspaceId: string, input: WorkbenchRetryInput): Promise<{ ok: true }> {
    const mainId = await ensureMain(workspaceId)
    if (input.model !== undefined) {
      await deps.buildAgentChange(workspaceId, 'readOnly', input).catch(error => {
        if (error instanceof RuntimeError && error.code === 'MODEL_UNAVAILABLE') throw new ConversationFailureError(runFailure(error))
        throw error
      })
    }
    await harnessOf().commit(async tx => {
      const state = await tx.doc(Workbench, mainId)
      if ('requestId' in input) {
        const dispatch = state.messages.find(message => message.requestId === input.requestId)
        if (!dispatch) throw new RuntimeError('NOT_FOUND', '未找到原始派发请求')
        if (dispatch.phase !== 'failed' || dispatch.input === undefined || dispatch.failure === undefined
          || (dispatch.failureAttempt ?? 1) !== input.attempt) {
          throw new RuntimeError('CONFLICT', '该派发状态已更新，请刷新后再试')
        }
        dispatch.phase = 'queued'
        dispatch.failureAttempt = input.attempt + 1
        if (input.model) dispatch.model = input.model
        if (input.thinkingLevel !== undefined) dispatch.thinkingLevel = input.thinkingLevel
        delete dispatch.lease
        delete dispatch.error
        delete dispatch.failure
        return
      }
      const stored = state.items.find(item => item.view.id === input.itemId)
      if (!stored) throw new RuntimeError('NOT_FOUND', '工作项不存在')
      if (stored.view.status !== 'needs_human' || stored.view.failure === undefined || stored.view.attempt !== input.attempt) {
        throw new RuntimeError('CONFLICT', '该工作项状态已更新，请刷新后再试')
      }
      const previous = stored.view.childId === undefined ? undefined
        : await tx.submissionByRequest(parseConversationId(stored.view.childId), stored.run.requestId)
      if (previous?.status === 'placed' || previous?.status === 'queued') throw new RuntimeError('CONFLICT', '智能体仍在执行本轮')
      const requestId = `workbench-retry:${input.itemId}:${input.attempt + 1}`
      let next: SubmitInput
      if (previous?.entry !== undefined) {
        // A placed turn's original messages and attachments already belong to this conversation.
        next = {
          text: '继续上一轮没有完成的请求。检查会话和工作区已完成的步骤，再从断点继续。',
          requestId, whenBusy: 'reject',
        }
      } else if (stored.run.input) {
        next = { ...stored.run.input, requestId, whenBusy: 'reject' }
      } else {
        throw new RuntimeError('CONFLICT', '无法恢复原始工作项，请在会话中继续')
      }
      queueReply(stored, {
        ...next, model: input.model ?? stored.run.modelOverride, thinkingLevel: input.thinkingLevel ?? stored.run.thinkingOverride,
      })
    }, CTX)
    wake()
    return { ok: true }
  }

  async function decideWorkItem(
    workspaceId: string, itemId: string, action: 'accept' | 'revise', attempt: number, feedback?: string,
    recordVerdict?: (tx: Tx, item: Readonly<WorkItem>) => Promise<boolean>,
  ): Promise<void> {
    const mainId = await ensureMain(workspaceId)
    await harnessOf().commit(async tx => {
      const state = await tx.doc(Workbench, mainId)
      const stored = state.items.find(item => item.view.id === itemId)
      if (!stored) throw new RuntimeError('NOT_FOUND', '工作项不存在')
      if (await recordVerdict?.(tx, stored.view)) return
      if (stored.view.attempt === attempt && stored.view.outcome?.decision === 'accepted' && action === 'accept') return
      if (stored.view.status !== 'pending_review' || stored.view.attempt !== attempt || !stored.view.outcome) {
        throw new RuntimeError('CONFLICT', '该轮结果已处理，请刷新后查看')
      }
      if (action === 'accept') {
        stored.view.outcome.decision = 'accepted'
        transition(stored.view, 'ended', { kind: 'none' })
        return
      }
      const requestId = `workbench-revise:${itemId}:${attempt + 1}`
      const text = feedback?.trim()
        ? `用户退回该工作项。请按意见返修并重新提交证据：\n${feedback.trim()}`
        : '用户退回该工作项。重新核对目标、验收条件与当前证据，补足缺口后重新提交。'
      queueReply(stored, { text, requestId })
    }, CTX)
    wake()
  }

  function wake(): void {
    if (closed || sweepInFlight) return
    sweepInFlight = sweep().catch(() => undefined).finally(() => { sweepInFlight = undefined })
  }

  function start(): void {
    timer = setInterval(wake, TICK_MS)
    timer.unref()
    wake()
  }

  async function close(): Promise<void> {
    closed = true
    if (timer !== undefined) clearInterval(timer)
    for (const controller of planning.values()) controller.abort()
    await Promise.allSettled([...planningRuns, ...(sweepInFlight ? [sweepInFlight] : [])])
  }

  async function seat(id: string): Promise<Readonly<WorkbenchSeat> | null> {
    return (await harnessOf().snapshot(WorkbenchSeats, parseConversationId(id), CTX))?.seat ?? null
  }

  return {
    view, submit, reply, retry, listWorkItems, decideWorkItem, seat, start, close,
    createBot: (workspaceId: string, input: CreateWorkbenchBotInput) => changeBot(workspaceId, input),
    updateBot: (workspaceId: string, botId: string, input: UpdateWorkbenchBotInput) => changeBot(workspaceId, input, botId),
  }
}
