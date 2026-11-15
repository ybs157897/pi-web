import { Buffer } from 'node:buffer'
import type { Context } from '@earendil-works/chord/context'
import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  section,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Extension,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
} from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { TeamMemberPhase, TeamMemberView, TeamTaskStatus, TeamTaskView, TeamView } from '../../shared/types.ts'
import { resolveToolRoute, toolRouteInstruction, type ToolCatalog, type ToolRoute } from '../conversation/tool-routing.ts'
import { Plans } from './plan.ts'
import { answerText } from './subagent.ts'
import { inheritPlanConstraint } from '../conversation/execution-policy.ts'
import type { AgentChange } from '@earendil-works/pi-durable'
import type { ChildModelRef, ChildModelResolver } from '../agents/builtins.ts'

/**
 * Agent Teams，遵循 DSH `packages/experimental/agent-team`。
 *
 * Lead 会话持有持久的成员名册与共享任务看板（DSH 把两者作为完整快照存在 Lead 会话
 * 日志里；这里是一个会话文档中的两个数组）。teammate 是普通的任务归属子会话，与
 * `subagent-tools.ts` 用同一接缝，因此子会话继承 Lead 的 agent 配置。每次变更都是
 * 对任务 revision 的 compare-and-set，与 `task-board.ts:105-211` 完全一致。
 */

/** team 扩展的九个工具名。 */
export const TEAM_TOOL_NAMES = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const

/** DSH 默认值：`agent-team/src/index.ts:42-45`。以下为团队容量与消息/文本限制。 */
export const MAX_TEAM_MEMBERS = 16
export const MAX_TEAM_TASKS = 256
export const MAX_TEAM_MESSAGE_BYTES = 65_536
export const MAX_TEAM_NAME_LENGTH = 64
export const MAX_TASK_SUBJECT_CHARS = 200
export const MAX_TASK_DESCRIPTION_CHARS = 16_384
export const MIN_WAIT_MS = 10_000
export const MAX_WAIT_MS = 3_600_000
export const DEFAULT_WAIT_MS = 30_000

/** Lead 伪成员面向模型的名称；保留且永不复用（DSH `roster.ts:436-444`）。 */
export const LEAD_NAME = 'lead'
/** 成员名的合法格式：小写 kebab-case。 */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** 一行持久名册记录，对应 DSH 的 `TeamMemberSnapshot`（`types.ts:47-56`）。 */
export type TeamMemberRecord = {
  name: string
  role: 'lead' | 'teammate'
  conversationId?: string
  phase: TeamMemberPhase
  label?: string
  error?: string
}

/** DSH 的 `TeamTaskSnapshot`（`types.ts:74-84`）加上面板排序所需的持久时间戳。 */
export type TeamTaskRecord = {
  id: string
  revision: number
  subject: string
  description: string
  status: TeamTaskStatus
  owner?: string
  blockedBy: string[]
  writeScopes: string[]
  createdAt: number
  updatedAt: number
}

/** Team 文档的值：成员名册与任务列表两个数组。 */
export type TeamDocValue = { members: TeamMemberRecord[]; tasks: TeamTaskRecord[] }

/** `pi-web.team` 文档挂在 Lead 会话上；`agent-team/src/index.ts:56-109` 持有同样的状态。 */
export const Team = defineDoc<TeamDocValue>({
  kind: 'pi-web.team',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ members: [], tasks: [] }),
})

/**
 * 写在 teammate 自己的会话上，让它的 team 工具解析到 Lead 的看板，而不是再建第二个
 * 空团队。DSH 经子会话的 `parentSession` 头解析同一件事。
 */
export const TeamLink = defineDoc<{ leadConversationId: string | null; name: string | null }>({
  kind: 'pi-web.team-member',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ leadConversationId: null, name: null }),
})

/**
 * 每个 Lead 会话一个的后台锚点任务。DSH 的 teammates 是 continuable 子会话，不会让
 * Lead 保持忙碌；Pi 中的等价物在 pi-durable README 有说明（"以 `{ background: true }`
 * 创建的任务是一个边界：它拥有的工作在父任务中止后仍然存活，也不会让父任务忙碌"）——
 * 成员会话归属这个停驻任务，因此运行中的 teammate 永不阻塞 Lead 自己的运行，而
 * `interrupt_agent` 仍可直接中止成员。
 */
export const TeamAnchors = defineDoc<{ taskId: number | null }>({
  kind: 'pi-web.team-anchor',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ taskId: null }),
})

const TeamAnchor = defineTask<{ lead: string }, { phase: 'anchor' }, null, object>({
  name: 'pi-web.team-anchor',
  version: 1,
  initial: () => ({ phase: 'anchor' }),
  phases: {
    // 在 runtime 的整个生命周期内停驻；对账边界就是 owner 链接本身。
    anchor: async (_task, runtime, context) => {
      if (!runtime.signal.aborted) {
        await new Promise<void>((resolve) => {
          runtime.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      try {
        await runtime.commit(() => ({
          status: 'terminal',
          outcome: { status: 'aborted' as const, reason: 'team anchor released' },
        }), context)
      } catch {
        // Harness 正在关闭：停驻的边界已无内容可记录。
      }
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: 'terminal',
      outcome: { status: 'aborted' as const, reason: 'team anchor aborted' },
    }), context)
  },
})

/** 稳定的规则码；工具错误向模型展示 message，测试断言 category。 */
export type TeamRuleCode =
  | 'invalid-argument'
  | 'invalid-member-name'
  | 'member-name-taken'
  | 'member-limit'
  | 'member-not-found'
  | 'lead-required'
  | 'self-message'
  | 'message-too-large'
  | 'task-limit'
  | 'task-not-found'
  | 'task-deleted'
  | 'stale-revision'
  | 'unauthorized'
  | 'already-claimed'
  | 'task-blocked'
  | 'invalid-transition'
  | 'invalid-write-scope'
  | 'dependency-cycle'
  | 'has-dependents'
  | 'invalid-timeout'
  | 'provisioning-conflict'

/** 团队规则错误：携带稳定的 TeamRuleCode，工具错误用它分类。 */
export class TeamRuleError extends Error {
  constructor(message: string, readonly code: TeamRuleCode) {
    super(message)
    this.name = 'TeamRuleError'
  }
}

/** 一次任务变更的发起方：Lead，或按持久名称标识的 teammate。 */
export type TeamActor = { lead: boolean; name: string }

/** 必填文本校验：trim、非空、限长；DSH `validation.ts:12-19`。 */
export function requiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text === '') throw new TeamRuleError(`${field} must be non-empty`, 'invalid-argument')
  if (text.length > maxLength) throw new TeamRuleError(`${field} exceeds ${maxLength} characters`, 'invalid-argument')
  return text
}

/**
 * 功能：规范化一个 workspace 相对前缀（DSH `validation.ts:26-34`）：斜杠统一，拒绝
 * 绝对路径、盘符、空段与父目录穿越值。
 * 边界：写入范围只是建议性标注，永远不是锁。
 * @param value 原始范围字符串。
 * @returns 规范化后的范围。
 */
export function normalizeWriteScope(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  const segments = normalized.split('/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TeamRuleError(`invalid workspace-relative write scope ${JSON.stringify(value)}`, 'invalid-write-scope')
  }
  return normalized
}

/** 规范化并去重建议性写入范围（`task-board.ts:234-237`）。 */
export function normalizeWriteScopes(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeWriteScope))]
}

/** 成员名规则：DSH `roster.ts:436-444`——小写 kebab-case、至多 64 字符、不得为 `lead`。 */
export function normalizeMemberName(value: string): string {
  if (!MEMBER_NAME.test(value) || value.length > MAX_TEAM_NAME_LENGTH || value === LEAD_NAME) {
    throw new TeamRuleError(
      'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
      'invalid-member-name',
    )
  }
  return value
}

/** 判断任务的全部当前阻塞项是否都已完成（`task-view.ts:24-26`）。 */
export function taskReady(tasks: readonly TeamTaskRecord[], task: TeamTaskRecord): boolean {
  return task.blockedBy.every(id => tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

/** 两个写入范围是否重叠（相等或互为路径前缀）。 */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** 一个独立的线上视图（`task-view.ts:37-62`），带面板使用的显式 `blocked` 标记。 */
export function taskView(tasks: readonly TeamTaskRecord[], task: TeamTaskRecord): TeamTaskView {
  const warnings = new Set<string>()
  for (const other of tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`)
    }
  }
  const ready = task.status === 'pending' && taskReady(tasks, task)
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.owner === undefined ? {} : { ownerName: task.owner }),
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ready,
    blocked: task.status === 'pending' && !ready,
    writeScopeWarnings: [...warnings],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * 功能：在非删除任务间检测依赖环（`task-graph.ts:54-69`）；自环也算环。
 * 内部逻辑：DFS 三色标记（visiting/visited），发现回边即返回成环处 id。
 * @param tasks 全部任务记录。
 * @returns 环闭合处的任务 id；无环时 undefined。
 */
export function detectCycle(tasks: readonly TeamTaskRecord[]): string | undefined {
  const active = new Map(tasks.filter(task => task.status !== 'deleted').map(task => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): string | undefined => {
    if (visiting.has(id)) return id
    if (visited.has(id)) return undefined
    const task = active.get(id)
    if (task === undefined) return undefined
    visiting.add(id)
    for (const blocker of task.blockedBy) {
      const cycle = visit(blocker)
      if (cycle !== undefined) return cycle
    }
    visiting.delete(id)
    visited.add(id)
    return undefined
  }
  for (const id of active.keys()) {
    const cycle = visit(id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/** 校验一份完整的候选任务图（`task-graph.ts:26-69`）：自环、重复阻塞项、缺失阻塞项与依赖环。 */
function assertTaskGraph(tasks: readonly TeamTaskRecord[]): void {
  const active = new Map(tasks.filter(task => task.status !== 'deleted').map(task => [task.id, task]))
  for (const task of active.values()) {
    const seen = new Set<string>()
    for (const blockerId of task.blockedBy) {
      if (blockerId === task.id) {
        throw new TeamRuleError(`team task "${task.id}" cannot block itself`, 'dependency-cycle')
      }
      if (seen.has(blockerId)) {
        throw new TeamRuleError(`team task "${task.id}" repeats blocker "${blockerId}"`, 'invalid-argument')
      }
      seen.add(blockerId)
      if (!active.has(blockerId)) {
        throw new TeamRuleError(`blocker task "${blockerId}" for "${task.id}" is missing or deleted`, 'task-not-found')
      }
    }
  }
  const cycle = detectCycle(tasks)
  if (cycle !== undefined) throw new TeamRuleError(`task dependency cycle includes "${cycle}"`, 'dependency-cycle')
}

/** 对照当前看板校验并去重阻塞项 id（含自引用检查）（`task-board.ts:213-232`）。 */
function validateDependencies(tasks: readonly TeamTaskRecord[], values: readonly string[], selfId?: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const id = requiredText(raw, 'blocked_by entry', 64)
    if (id === selfId) throw new TeamRuleError('a team task cannot block itself', 'dependency-cycle')
    if (seen.has(id)) throw new TeamRuleError(`duplicate blocker "${id}"`, 'invalid-argument')
    const blocker = tasks.find(candidate => candidate.id === id)
    if (blocker === undefined || blocker.status === 'deleted') {
      throw new TeamRuleError(`blocker task "${id}" not found`, 'task-not-found')
    }
    seen.add(id)
    result.push(id)
  }
  return result
}

/** 生成本看板的下一个任务 id：取现有 `task-N` 的最大 N 加一。 */
function nextTaskId(tasks: readonly TeamTaskRecord[]): string {
  let max = 0
  for (const task of tasks) {
    const match = /^task-(\d+)$/u.exec(task.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `task-${max + 1}`
}

/** 创建任务的输入：主题、描述、可选阻塞项与建议写入范围。 */
export type CreateTaskInput = {
  subject: string
  description: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
}

/** 创建一个无负责人、pending、revision 1 的任务（`task-board.ts:44-69`）。 */
export function createTask(doc: TeamDocValue, input: CreateTaskInput, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  const active = doc.tasks.filter(task => task.status !== 'deleted').length
  if (active >= MAX_TEAM_TASKS) throw new TeamRuleError(`Team task limit ${MAX_TEAM_TASKS} reached`, 'task-limit')
  const subject = requiredText(input.subject, 'subject', MAX_TASK_SUBJECT_CHARS)
  const description = requiredText(input.description, 'description', MAX_TASK_DESCRIPTION_CHARS)
  const blockedBy = validateDependencies(doc.tasks, input.blockedBy ?? [])
  const writeScopes = normalizeWriteScopes(input.writeScopes ?? [])
  const task: TeamTaskRecord = {
    id: nextTaskId(doc.tasks),
    revision: 1,
    subject,
    description,
    status: 'pending',
    blockedBy,
    writeScopes,
    createdAt: now,
    updatedAt: now,
  }
  const tasks = [...doc.tasks, task]
  assertTaskGraph(tasks)
  return { doc: { members: doc.members, tasks }, task }
}

/** 按任务 id 定位任务；不存在抛 task-not-found。 */
function locateTask(doc: TeamDocValue, taskId: string): TeamTaskRecord {
  const task = doc.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new TeamRuleError(`team task "${taskId}" not found`, 'task-not-found')
  return task
}

/** 以 compare-and-set 执行一次状态迁移（`task-board.ts:105-211`）：revision 过期或已删除在动作前拒绝。 */
function mutateTask(
  doc: TeamDocValue,
  taskId: string,
  expectedRevision: number,
  update: (current: TeamTaskRecord) => TeamTaskRecord,
  now: number,
): { doc: TeamDocValue; task: TeamTaskRecord } {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new TeamRuleError('expected_revision must be a positive safe integer', 'invalid-argument')
  }
  const current = locateTask(doc, taskId)
  if (current.revision !== expectedRevision) {
    throw new TeamRuleError(
      `stale team task "${current.id}" revision ${expectedRevision}; current revision is ${current.revision}`,
      'stale-revision',
    )
  }
  if (current.status === 'deleted') throw new TeamRuleError(`team task "${current.id}" is deleted`, 'task-deleted')
  const next: TeamTaskRecord = { ...update(current), revision: current.revision + 1, updatedAt: now }
  const tasks = doc.tasks.map(task => task.id === taskId ? next : task)
  assertTaskGraph(tasks)
  return { doc: { members: doc.members, tasks }, task: next }
}

/** 权限检查：非 Lead 只能变更自己拥有的任务。 */
function authorizeOwner(task: TeamTaskRecord, actor: TeamActor): void {
  if (!actor.lead && task.owner !== actor.name) {
    throw new TeamRuleError('task mutation requires its owner or Team Lead', 'unauthorized')
  }
}

/** 返回去掉 owner 字段的任务记录（回到无负责人状态）。 */
function withoutOwner(task: TeamTaskRecord): TeamTaskRecord {
  const { owner: _owner, ...rest } = task
  return rest
}

/** 认领任务：须就绪、无主（或已是调用方的），然后转 in_progress（`task-board.ts:129-137`）。 */
export function claimTask(doc: TeamDocValue, taskId: string, expectedRevision: number, owner: string, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    if (current.owner !== undefined && current.owner !== owner) {
      throw new TeamRuleError(`team task "${current.id}" is owned by another member`, 'already-claimed')
    }
    if (current.status !== 'pending' || !taskReady(doc.tasks, current)) {
      throw new TeamRuleError(`team task "${current.id}" is not ready to claim`, 'task-blocked')
    }
    return { ...current, status: 'in_progress', owner }
  }, now)
}

/** 把进行中的任务释放回无主池（`task-board.ts:138-141`）。 */
export function releaseTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    if (current.status !== 'in_progress') throw new TeamRuleError('only an in-progress task can be released', 'invalid-transition')
    return withoutOwner({ ...current, status: 'pending' })
  }, now)
}

/** 编辑任务文本或建议性写入范围（`task-board.ts:143-156`）。 */
export function editTask(
  doc: TeamDocValue,
  taskId: string,
  expectedRevision: number,
  actor: TeamActor,
  patch: { subject?: string; description?: string; writeScopes?: readonly string[] },
  now: number,
): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    if (patch.subject === undefined && patch.description === undefined && patch.writeScopes === undefined) {
      throw new TeamRuleError('task edit requires subject, description, or write_scopes', 'invalid-argument')
    }
    return {
      ...current,
      ...(patch.subject === undefined ? {} : { subject: requiredText(patch.subject, 'subject', MAX_TASK_SUBJECT_CHARS) }),
      ...(patch.description === undefined ? {} : { description: requiredText(patch.description, 'description', MAX_TASK_DESCRIPTION_CHARS) }),
      ...(patch.writeScopes === undefined ? {} : { writeScopes: normalizeWriteScopes(patch.writeScopes) }),
    }
  }, now)
}

/** 整体替换阻塞项列表，拒绝自引用与依赖环（`task-board.ts:157-161`）。 */
export function setDependencies(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, blockedBy: readonly string[], now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    return { ...current, blockedBy: validateDependencies(doc.tasks, blockedBy, current.id) }
  }, now)
}

/** 完成一个进行中的任务（`task-board.ts:162-166`）。 */
export function completeTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    if (current.status !== 'in_progress') throw new TeamRuleError('only an in-progress task can complete', 'invalid-transition')
    return { ...current, status: 'completed' }
  }, now)
}

/** 把已完成任务重新打开为无主的 pending（`task-board.ts:167-171`）。 */
export function reopenTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    if (current.status !== 'completed') throw new TeamRuleError('only a completed task can reopen', 'invalid-transition')
    return withoutOwner({ ...current, status: 'pending' })
  }, now)
}

/**
 * 仅限 Lead 的指派（`task-board.ts:172-188`）。省略 owner 即取消指派并回到 pending；
 * 指派要求任务就绪且成员处于 active（或指给 Lead 本身）。
 */
export function reassignTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, owner: string | undefined, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    if (!actor.lead) throw new TeamRuleError('only the Team Lead can reassign tasks', 'lead-required')
    if (current.status !== 'pending' && current.status !== 'in_progress') {
      throw new TeamRuleError('only a pending or in-progress task can be reassigned', 'invalid-transition')
    }
    const name = owner?.trim() ?? ''
    if (name === '') return withoutOwner({ ...current, status: 'pending' })
    if (name !== LEAD_NAME && !doc.members.some(member => member.role === 'teammate' && member.name === name && member.phase === 'active')) {
      throw new TeamRuleError(`active teammate "${name}" not found`, 'member-not-found')
    }
    if (!taskReady(doc.tasks, current)) throw new TeamRuleError(`team task "${current.id}" is blocked`, 'task-blocked')
    return { ...current, status: 'in_progress', owner: name }
  }, now)
}

/** 删除一个没有其他活动任务依赖它的任务（`task-board.ts:189-198`）。 */
export function deleteTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    const dependent = doc.tasks.find(task =>
      task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
    if (dependent !== undefined) {
      throw new TeamRuleError(`team task "${current.id}" still blocks "${dependent.id}"`, 'has-dependents')
    }
    return { ...current, status: 'deleted' }
  }, now)
}

/** 会话的实时回合状态与子会话模型，由 runtime 提供。 */
export type TeamConversationInfo = { status: 'running' | 'inactive'; model?: string }

/**
 * 关于一个已供应成员会话的持久证据，在工具 commit 之外收集。DSH 的对账直接读取持久化
 * 的子 Session（`roster.ts:385-397`）；Pi 的工具 API 没有会话日志读取器，runtime 从
 * 会话表、子会话的 `pi-web.team-member` 链接与其提交记录回答同样的问题。
 */
export type MemberSessionState = {
  /** 子会话记录存在。 */
  exists: boolean
  /** 子会话的链接文档以该成员名指回此 Lead。 */
  linked: boolean
  /** 初始 prompt 提交（`team-spawn:<lead>:<name>`）被持久拒绝或撤回。 */
  promptRejected: boolean
  /** 子会话当前有存活运行，其创建者仍在本进程内完成收尾。 */
  running: boolean
}

/** 对账所需的文档访问；工具 API 与 runtime 双方都能满足。 */
export type TeamDocAccess = {
  read: (leadId: ConversationId, context: Context) => Promise<TeamDocValue | undefined>
  commit: (change: (tx: Tx) => void | Promise<void>, context: Context) => Promise<void>
}

/** runtime 对一个成员子会话的探针函数。 */
export type MemberSessionProbe = (conversationId: string, leadId: ConversationId, name: string) => Promise<MemberSessionState>

/**
 * 功能：DSH 的 provisioning 对账（`roster.ts:375-417`）：停留在 `provisioning` 的成员，
 * 其子会话已不存在——或不能作为该成员的续篇恢复——则变为 `failed` 并在行上写原因。
 * 存活的子会话跳过：其创建者在本进程内仍持有终态边（`roster.ts:379-382`）。
 *
 * Pi 差异：子会话是持久会话，"可恢复"意味着记录存在且链接仍指向该成员；收件箱显式
 * 拒绝的初始 prompt 是对账可见的唯一终态失败。从未提交的 prompt（子会话创建与提交
 * 之间崩溃）保持 `active`，因为重放路径会以同一请求 ID 重新提交——DSH 的 continuation
 * 在该状态下不可恢复（`roster.ts:389-394`）。
 * @param access 文档读/写通道。
 * @param options 含 memberSession 探针。
 * @param leadId Lead 会话 id。
 * @param context 执行上下文。
 */
export async function reconcileProvisioning(
  access: TeamDocAccess,
  options: { memberSession: MemberSessionProbe },
  leadId: ConversationId,
  context: Context,
): Promise<void> {
  const doc = await access.read(leadId, context)
  const pending = (doc?.members ?? []).filter(member => member.role === 'teammate' && member.phase === 'provisioning')
  if (pending.length === 0) return
  const settled: Array<{ name: string; phase: 'active' | 'failed'; error?: string }> = []
  for (const member of pending) {
    if (member.conversationId === undefined) {
      settled.push({ name: member.name, phase: 'failed', error: 'provisioning did not leave a resumable child conversation' })
      continue
    }
    let state: MemberSessionState
    try {
      state = await options.memberSession(member.conversationId, leadId, member.name)
    } catch (error) {
      settled.push({ name: member.name, phase: 'failed', error: `child conversation recovery failed: ${describe(error)}` })
      continue
    }
    // 存活的子会话意味着创建仍在本进程收尾；终态边由创建者写入。
    if (state.running) continue
    if (!state.exists) {
      settled.push({ name: member.name, phase: 'failed', error: 'provisioning did not leave a resumable child conversation' })
    } else if (!state.linked) {
      settled.push({ name: member.name, phase: 'failed', error: 'the child conversation is no longer this member\'s continuation' })
    } else if (state.promptRejected) {
      settled.push({ name: member.name, phase: 'failed', error: 'the initial prompt was not accepted' })
    } else {
      settled.push({ name: member.name, phase: 'active' })
    }
  }
  if (settled.length === 0) return
  await access.commit(async (tx) => {
    const stored = await tx.doc(Team, leadId)
    for (const row of settled) {
      const member = stored.members.find(candidate => candidate.name === row.name)
      // 另一个写入者可能已结算；第一个终态边胜出。
      if (member?.phase !== 'provisioning') continue
      member.phase = row.phase
      if (row.error === undefined) delete member.error
      else member.error = row.error
    }
  }, context)
}

function memberView(member: TeamMemberRecord, status: TeamMemberView['status'], model?: string): TeamMemberView {
  return {
    name: member.name,
    role: member.role,
    phase: member.phase,
    status,
    ...(member.conversationId === undefined ? {} : { conversationId: member.conversationId }),
    ...(member.label === undefined ? {} : { label: member.label }),
    ...(model === undefined ? {} : { model }),
    ...(member.error === undefined ? {} : { error: member.error }),
  }
}

/** 线上成员行：合成 Lead 行在前，持久 teammates 按创建顺序排列。 */
export async function memberViews(
  doc: TeamDocValue,
  leadId: string,
  info: (conversationId: string) => Promise<TeamConversationInfo>,
  leadLabel = 'Lead',
): Promise<TeamMemberView[]> {
  const lead = doc.members.find(member => member.role === 'lead')
  const leadInfo = await info(leadId)
  const rows: TeamMemberView[] = [{
    name: LEAD_NAME,
    role: 'lead',
    phase: 'active',
    status: leadInfo.status,
    conversationId: leadId,
    label: lead?.label ?? leadLabel,
    ...(leadInfo.model === undefined ? {} : { model: leadInfo.model }),
  }]
  for (const member of doc.members) {
    if (member.role === 'lead') continue
    const live = member.phase === 'active' && member.conversationId !== undefined
      ? await info(member.conversationId)
      : undefined
    const status = member.phase === 'failed'
      ? 'failed'
      : member.phase === 'provisioning'
        ? 'provisioning'
        : live?.status ?? 'inactive'
    rows.push(memberView(member, status, live?.model))
  }
  return rows
}

/** 从一份 Lead 文档与各成员会话的实时状态构建团队投影。 */
export async function projectTeam(
  doc: TeamDocValue,
  leadId: string,
  info: (conversationId: string) => Promise<TeamConversationInfo>,
): Promise<TeamView> {
  return {
    members: await memberViews(doc, leadId, info),
    tasks: doc.tasks.filter(task => task.status !== 'deleted').map(task => taskView(doc.tasks, task)),
  }
}

/** runtime 提供的配置：工具 API 不暴露的会话管道。 */
export type TeamToolOptions = {
  /** 在创建事务内写入子会话的标题/工作区/访问模式。 */
  prepareChild: (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string) => Promise<void>
  /** 一个会话的实时回合状态与模型（成员自己的 agent）。 */
  conversationInfo: (conversationId: string) => Promise<TeamConversationInfo>
  /** 为 `wait_agent` 观察成员忙碌状态变化；返回停止函数。 */
  watchMembers: (leadId: string, onChange: () => void) => Promise<() => Promise<void>>
  /**
   * 关于一个已供应成员会话的持久证据。spawn 重放路径与 provisioning 对账都需要工具
   * API 无法在自己 commit 内完成的读取（`docs/history/families.md` A6），runtime 从
   * 会话表回答。
   */
  memberSession: MemberSessionProbe
  /** 对显式选取的成员模型（仅 fresh 上下文）按目录校验并夹取。 */
  resolveChildModel?: ChildModelResolver
}

/** 当前调用方在团队中的位置：Lead 会话 id、角色与名称。 */
type TeamScope = { leadId: ConversationId; role: 'lead' | 'teammate'; name: string }

/** 把字符串会话 id 转为 ConversationId；非法值抛 invalid-argument。 */
function toConversationId(value: string): ConversationId {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new TeamRuleError('invalid conversation id', 'invalid-argument')
  return id as ConversationId
}

/** 无团队时的空文档。 */
const EMPTY_TEAM: TeamDocValue = { members: [], tasks: [] }

/** 解析本会话所属的团队：Lead 读自己的看板，teammate 读其 Lead 的看板。 */
export async function resolveTeamScope(api: ToolExecutionApi, context: Context): Promise<TeamScope> {
  const link = await api.snapshot(TeamLink, api.conversationId, context)
  if (link?.leadConversationId) {
    return {
      leadId: toConversationId(link.leadConversationId),
      role: 'teammate',
      name: link.name ?? 'teammate',
    }
  }
  return { leadId: api.conversationId, role: 'lead', name: LEAD_NAME }
}

async function readDoc(api: ToolExecutionApi, leadId: ConversationId, context: Context): Promise<TeamDocValue> {
  return await api.snapshot(Team, leadId, context) ?? EMPTY_TEAM
}

/** 断言调用方是 Lead；否则抛 lead-required。 */
function assertLead(scope: TeamScope): void {
  if (scope.role !== 'lead') throw new TeamRuleError('only the Team Lead can perform this action', 'lead-required')
}

/** 从 TeamScope 构造任务变更发起方。 */
function actorOf(scope: TeamScope): TeamActor {
  return { lead: scope.role === 'lead', name: scope.name }
}

/** 校验成员目标名：必填文本，限长 MAX_TEAM_NAME_LENGTH。 */
function requireMember(value: string): string {
  return requiredText(value, 'target', MAX_TEAM_NAME_LENGTH)
}

/** 清洗成员展示 label：缺省回落为名称；超过 200 字符抛错。 */
function memberLabel(value: string | undefined, name: string): string {
  const label = (value ?? '').trim()
  if (label === '') return name
  if (label.length > 200) throw new TeamRuleError('description exceeds 200 characters', 'invalid-argument')
  return label
}

/** 给定持久名册，一次 spawn 调用对某个名字应做的事（`roster.ts:263-276`）。 */
export type SpawnReplayPlan =
  | { kind: 'create' }
  | { kind: 'reuse'; conversationId: string }
  | { kind: 'taken' }

/**
 * 功能：spawn 的幂等决策。同一调用的重放会找到首次写入的行并复用该子会话
 * （`spawn_teammate` 是 `replay: 'safe'`）；其他同名行意味着名字已被占用，而 DSH 从不
 * 复用 teammate 名称（`roster.ts:263-276,436-444`）。
 * @param doc 当前团队文档。
 * @param name 目标成员名。
 * @returns create / reuse / taken 三种计划。
 */
export function planSpawnReplay(doc: TeamDocValue, name: string): SpawnReplayPlan {
  const existing = doc.members.find(member => member.role === 'teammate' && member.name === name)
  if (existing === undefined) return { kind: 'create' }
  if (existing.conversationId !== undefined && existing.phase !== 'failed') {
    return { kind: 'reuse', conversationId: existing.conversationId }
  }
  return { kind: 'taken' }
}

/** spawn 前置检查：名字不得已被使用过；成员数不得超过 MAX_TEAM_MEMBERS。 */
function spawnLimit(doc: TeamDocValue, name: string): void {
  if (doc.members.some(member => member.name === name)) {
    throw new TeamRuleError(`teammate name "${name}" was already used in this Team`, 'member-name-taken')
  }
  if (doc.members.length >= MAX_TEAM_MEMBERS) {
    throw new TeamRuleError(`Team member limit ${MAX_TEAM_MEMBERS} reached`, 'member-limit')
  }
}

/** 确保名册中存在 Lead 行；没有则在头部补一行合成 Lead 记录。 */
function ensureLeadRow(doc: TeamDocValue, leadId: ConversationId): void {
  if (doc.members.some(member => member.role === 'lead')) return
  doc.members.unshift({ name: LEAD_NAME, role: 'lead', conversationId: String(leadId), phase: 'active', label: 'Lead' })
}

/** 把任意错误压成一行描述：取 message、折叠空白、截断 300 字符；空则报 unknown error。 */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
}

/** 把值序列化为缩进 JSON 的文本输出块。 */
function jsonText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 不要从 inactivity 推断任务完成，也不要唤醒已完成工作的成员。 */
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. Read the returned results and shared tasks first; use send_message only if a required inactive member still has work to do.'

/** 成员是否处于忙碌状态：running 或 provisioning。 */
function isActiveStatus(status: TeamMemberView['status']): boolean {
  return status === 'running' || status === 'provisioning'
}

/** `wait_agent` 结果中一个成员的汇总状态：状态加上最近一次答复文本。 */
type WaitAgentMember = {
  name: string
  status: string
  conversationId?: string
  answer?: string
  answerStatus?: 'available' | 'truncated' | 'not_found_in_recent_entries' | 'read_failed'
  answerEntryId?: string
  conversationPath?: string
}
/** `wait_agent` 的完整结果：是否超时、无进展原因或成员名册。 */
type WaitAgentResult = { timedOut: boolean; noProgress?: { reason: 'no-active-peer'; message: string }; members?: WaitAgentMember[] }

/** 成员答复预览的最大字符数。 */
const MAX_MEMBER_ANSWER_CHARS = 2_000

/**
 * 功能：收集等待结束后 Lead 所见的名册：每个 teammate 的实时状态；非 running 时附带
 * 有界的最近 assistant 文本预览及其来源（answerStatus 与条目 id），供后续追查。
 * @param api 工具执行 API。
 * @param doc 团队文档。
 * @param info 会话实时信息回调。
 * @param context 执行上下文。
 * @returns 成员状态列表。
 */
async function teamRosterWithAnswers(
  api: ToolExecutionApi,
  doc: TeamDocValue,
  info: (conversationId: string) => Promise<TeamConversationInfo>,
  context: Context,
): Promise<{ members: WaitAgentMember[] }> {
  const members: WaitAgentMember[] = []
  for (const member of doc.members) {
    if (member.role !== 'teammate') continue
    const status = member.phase === 'failed'
      ? 'failed'
      : member.phase === 'provisioning'
        ? 'provisioning'
        : member.conversationId === undefined ? 'inactive' : (await info(member.conversationId)).status
    let answer: string | undefined
    let answerStatus: WaitAgentMember['answerStatus']
    let answerEntryId: string | undefined
    if (status !== 'running' && member.conversationId !== undefined) {
      try {
        const result = await api.commit(async (tx) => {
          const page = await tx.scanEntries({ conversationId: toConversationId(member.conversationId!), order: 'descending' }, 8)
          for (const entry of page.items) {
            const text = answerText(entry.model)
            if (text !== '') return { text, entryId: String(entry.id) }
          }
          return undefined
        }, context)
        if (result === undefined) answerStatus = 'not_found_in_recent_entries'
        else {
          answer = result.text.slice(0, MAX_MEMBER_ANSWER_CHARS)
          answerEntryId = result.entryId
          answerStatus = result.text.length > MAX_MEMBER_ANSWER_CHARS ? 'truncated' : 'available'
        }
      } catch {
        context.abortSignal?.throwIfAborted()
        answerStatus = 'read_failed'
      }
    }
    members.push({
      name: member.name,
      status,
      ...(member.conversationId === undefined ? {} : {
        conversationId: member.conversationId,
        conversationPath: `/api/conversations/${encodeURIComponent(member.conversationId)}`,
      }),
      ...(answer === undefined ? {} : { answer }),
      ...(answerStatus === undefined ? {} : { answerStatus }),
      ...(answerEntryId === undefined ? {} : { answerEntryId }),
    })
  }
  return { members }
}

/**
 * 功能：有界的 `wait_agent` 等待：观察文档变化与成员忙碌状态变化，直到变化发生或
 * 超时；abort 随调用一起终止。
 * 内部逻辑：挂接 doc watcher 与成员观察器；用快照对比补偿获取观察器期间落下的变化；
 * 超时 resolve(false)，变化 resolve(true)，abort reject。
 * @param observed 等待前观察到的文档与成员视图（用于竞态补偿）。
 * @returns 是否因变化而唤醒（false 为超时自然返回）。
 */
export async function waitForTeamChange(
  api: ToolExecutionApi,
  options: TeamToolOptions,
  leadId: ConversationId,
  timeoutMs: number,
  context: Context,
  observed: { doc: TeamDocValue; members: TeamMemberView[] },
): Promise<boolean> {
  const signal = context.abortSignal
  signal?.throwIfAborted()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let resolveChange!: (value: boolean) => void
  let rejectChange!: (error: unknown) => void
  const changed = new Promise<boolean>((resolve, reject) => {
    resolveChange = resolve
    rejectChange = reject
  })
  const finish = (action: () => void): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    action()
  }
  const notify = (): void => { finish(() => resolveChange(true)) }
  onAbort = (): void => {
    const reason: unknown = signal?.reason
    finish(() => rejectChange(reason instanceof Error ? reason : new Error('wait_agent aborted')))
  }
  let stopDoc: (() => Promise<unknown>) | undefined
  let stopMembers: (() => Promise<void>) | undefined
  try {
    const docWatch = await api.watchDoc(Team, leadId, context)
    if (docWatch !== undefined) {
      docWatch.start(async () => { notify() })
      stopDoc = () => docWatch.stop()
    }
    stopMembers = await options.watchMembers(String(leadId), notify)
    // 补偿异步观察器获取期间落下的状态变化。
    if (!settled) {
      const afterDoc = await readDoc(api, leadId, context)
      const afterMembers = await memberViews(afterDoc, String(leadId), options.conversationInfo)
      const states = (members: TeamMemberView[]) => members.filter(member => member.role === 'teammate')
        .map(({ name, phase, status, conversationId }) => ({ name, phase, status, conversationId }))
      if (JSON.stringify(afterDoc) !== JSON.stringify(observed.doc)
        || JSON.stringify(states(afterMembers)) !== JSON.stringify(states(observed.members))) notify()
    }
    if (!settled) {
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
      if (!settled) timer = setTimeout(() => { finish(() => resolveChange(false)) }, timeoutMs)
    }
    return !(await changed)
  } finally {
    await stopDoc?.()
    await stopMembers?.()
  }
}

/** 团队工具名的类型别名。 */
type TeamToolName = (typeof TEAM_TOOL_NAMES)[number]

/** 每个工具的调用示例参数文本（section 生成用）。 */
const TEAM_TOOL_EXAMPLES: Record<TeamToolName, string> = {
  spawn_teammate: '{ name: "worker", prompt: "..." }',
  send_message: '{ target: "worker", message: "..." }',
  list_agents: '{}',
  wait_agent: '{ timeout_ms: 30000 }',
  interrupt_agent: '{ target: "worker" }',
  team_task_create: '{ subject: "...", description: "...", write_scopes: ["..."] }',
  team_task_list: '{}',
  team_task_get: '{ task_id: "task-1" }',
  team_task_update: '{ task_id: "task-1", expected_revision: 1, action: "claim" }',
}

/** 解析全部团队工具在当前 agent 下的路由。 */
function teamRoutes(agent: ToolCatalog): Record<TeamToolName, ToolRoute> {
  return Object.fromEntries(TEAM_TOOL_NAMES.map(name => [name, resolveToolRoute(agent, name)])) as Record<TeamToolName, ToolRoute>
}

/** 生成单个工具的路由调用说明；不可调用时 undefined。 */
function teamCall(name: TeamToolName, routes: Record<TeamToolName, ToolRoute>, args = TEAM_TOOL_EXAMPLES[name]): string | undefined {
  return toolRouteInstruction(name, routes[name], args)
}

/** 团队共享工作目录的公共策略文本；按计划模式是否开启给出只读/协作两个版本。 */
function sharedTeamPolicy(planActive: boolean): string {
  return planActive
    ? '团队共享同一工作目录。计划模式对所有成员均为只读：检查并报告证据，保留所有文件，不修改工作区。'
    : '团队共享同一工作目录；文件改动对所有成员立即可见。保留其他成员的改动，遵守分配的写入范围，修改共享文件前先协调重叠工作。'
}

/** team-policy section：成员视角给执行/汇报/任务规则，Lead 视角给委派/观察/看板规则。 */
const teamSection = section('team-policy', async (input, context) => {
  const [link, plan] = await Promise.all([
    input.read.snapshot(TeamLink, input.conversationId, context),
    input.read.snapshot(Plans, input.conversationId, context),
  ])
  const planActive = plan?.active === true
  const routes = teamRoutes(input.agent)
  if (link?.leadConversationId) {
    const lines = [
      `你是 Agent 团队的成员“${link.name ?? 'teammate'}”。团队负责人的名称为“lead”。`,
      sharedTeamPolicy(planActive),
      planActive
        ? '只执行分配的调研任务，向团队负责人报告发现和具体证据。'
        : '只执行分配的任务，向团队负责人报告结果和具体的验证证据。负责人负责团队协调和任务分配。',
    ]
    const message = teamCall('send_message', routes, '{ target: "lead", message: "..." }')
    if (message) {
      lines.push(`联系负责人时，${message}。发送成功只表示收件箱已接纳，不代表接收方已经处理。其他成员的消息以发送者名称开头。`)
    }
    const list = teamCall('list_agents', routes)
    if (list) lines.push(`查看成员名称和当前可用状态时，${list}。`)
    if (planActive && routes.team_task_list !== 'unavailable' && routes.team_task_get !== 'unavailable') {
      lines.push('仅通过读取任务看板了解分配的调研范围；计划模式下不要尝试更新任务。')
    } else if (!planActive && routes.team_task_list !== 'unavailable' && routes.team_task_get !== 'unavailable' && routes.team_task_update !== 'unavailable') {
      lines.push('对于分配给你的共享任务，先读取最新 revision；若为 pending 且没有负责人，先认领；只有工作及所要求的验证都完成后，才标记完成。')
    } else if (routes.team_task_update !== 'unavailable') {
      lines.push('只使用派工内容中提供的任务标识和 revision，不要猜测。')
    }
    if (routes.team_task_list !== 'unavailable' && routes.team_task_update !== 'unavailable') {
      lines.push('在共享任务中，用工作区相对路径前缀记录预期写入范围，用任务依赖 blocked_by 表达必要顺序。写入范围重叠只会产生警告，不是锁。')
    }
    const taskCalls = (['team_task_list', 'team_task_get', 'team_task_update'] as const)
      .map(name => teamCall(name, routes)).filter((line): line is string => line !== undefined)
    if (taskCalls.length) lines.push(...taskCalls)
    return lines.join('\n')
  }
  const doc = await input.read.snapshot(Team, input.conversationId, context)
  const teammates = (doc?.members ?? []).filter(member => member.role === 'teammate')
  if (teammates.length === 0) return undefined
  const lines = [
    `你是名为“lead”的团队负责人。团队有 ${teammates.length} 名成员：${teammates.map(member => member.name).join(', ')}。`,
    sharedTeamPolicy(planActive),
  ]

  const spawn = teamCall('spawn_teammate', routes)
  if (spawn) {
    lines.push(planActive
      ? `只委派彼此独立、调研范围分开的只读研究。每条任务说明都必须自包含，写明任务、范围、约束与授权、验收标准和所需证据；子会话继承计划模式。${spawn}。`
      : `只委派职责明确且写入范围互不重叠的工作。成员任务说明必须自包含，写明任务、范围、约束与授权、验收标准和所需结果证据，并要求保留分配范围外的改动。创建的成员在后台运行。${spawn}。`)
  }
  const list = teamCall('list_agents', routes)
  if (list) lines.push(`通过成员列表检查各成员的可用状态；inactive 表示没有回合正在运行，不代表任务完成。${list}。`)
  const message = teamCall('send_message', routes)
  if (message) {
    lines.push(`用消息指导正在运行的成员，或启动、恢复 inactive 成员。发送成功只表示收件箱已接纳，不代表成员已经处理；其他成员的消息以发送者名称开头。${message}。`)
  }
  const interrupt = teamCall('interrupt_agent', routes)
  if (interrupt) lines.push(`只中断确实应停止当前回合的成员。${interrupt}。`)

  const createTask = teamCall('team_task_create', routes)
  if (createTask) {
    lines.push(`需要记录负责人或依赖关系的工作使用共享任务。用工作区相对路径前缀记录预期写入范围，用任务依赖 blocked_by 表达必要顺序；写入范围重叠只会产生警告，不是锁。${createTask}。`)
  }
  const taskList = teamCall('team_task_list', routes)
  const taskGet = teamCall('team_task_get', routes)
  const taskUpdate = teamCall('team_task_update', routes)
  if (taskList) lines.push(planActive
    ? `仅检查当前任务范围和状态，用于调研规划。${taskList}。`
    : `分配工作前，检查任务是否就绪及其负责人。${taskList}。`)
  if (taskGet) lines.push(planActive
    ? `仅通过读取任务详情了解当前调研范围。${taskGet}。`
    : `修改或执行任务前，读取其最新 revision。${taskGet}。`)
  if (taskUpdate) {
    lines.push(`每次更新使用最新 revision；工作前先认领，验证通过后才标记完成。任务就绪不会自动启动负责人。${taskUpdate}。`)
  }
  const wait = teamCall('wait_agent', routes)
  if (wait && list) {
    lines.push(`成员列表反映可用状态，不代表任务完成。wait_agent 观察后续变化，不会唤醒成员；等待返回或超时后，重新读取成员列表。若无人运行，调用一次即可收集已有答复，无须等待。检查 answerStatus；会话路径供宿主或用户定位来源，不是可调用工具。${message ? ' 必要时向成员索取缺失的详情；不要唤醒已完成工作的 inactive 成员。' : ' 没有可用的获取方式时，说明缺少哪些证据。'} 最终答复前，收齐必要成员的结果。${wait}。`)
  }
  return lines.join('\n')
})

/**
 * 功能：装配 team 扩展，贡献 9 个工具（spawn_teammate / send_message / list_agents /
 * wait_agent / interrupt_agent / team_task_create / team_task_list / team_task_get /
 * team_task_update）、1 个 section（team-policy：成员与 Lead 两套协作规则）和 1 个
 * 后台锚点任务（TeamAnchor）。`options` 被本调用内的所有工具定义闭包引用。
 * @param options runtime 注入的会话管道与授权依赖。
 * @returns 名为 `team` 的扩展。
 */
export function createTeamTools(options: TeamToolOptions): Extension {
  /** 把一次成员失败记入名册（phase=failed + 错误描述）；记录失败本身仅诊断告警。 */
  async function markMemberFailed(api: ToolExecutionApi, leadId: ConversationId, name: string, error: unknown, context: Context): Promise<void> {
    try {
      await api.commit(async (tx) => {
        const doc = await tx.doc(Team, leadId)
        const stored = doc.members.find(member => member.name === name)
        if (stored === undefined) return
        stored.phase = 'failed'
        stored.error = describe(error)
      }, context)
    } catch (recordingError) {
      if (context.abortSignal?.aborted === true) throw recordingError
      api.diagnostic({ severity: 'warn', message: `could not record the failed teammate: ${describe(recordingError)}` })
    }
  }

  /** 构造 spawn 失败的工具结果：error 级诊断 + isError 输出 + failed 视图。 */
  function spawnFailure(api: ToolExecutionApi, reason: string): ToolExecutionResult<TeamMemberView> {
    api.diagnostic({ severity: 'error', message: `Teammate creation failed: ${reason}` })
    return {
      output: [{ type: 'text' as const, text: `Teammate creation failed: ${reason}` }],
      isError: true,
      details: { name: '', role: 'teammate', phase: 'failed', status: 'failed', error: reason },
    }
  }

  const spawnTool = defineTool({
    name: 'spawn_teammate',
    description: [
      '在独立子会话中创建一个具名、持久的团队成员；它在后台运行，本调用立即返回，不等待答复。',
      '仅团队负责人可调用。名称必须唯一，使用小写短横线格式，最多 64 字符，且不能为 "lead"；即使创建失败，该名称也不能复用。',
      'prompt 是成员完整、自包含的初始任务。成员继承你的 Agent 配置、工具、模型和工作目录，但不继承消息。必须写明任务、分配范围、适用的约束与授权、验收标准和所需结果证据。',
      'context 选择初始上下文：fresh 创建空子会话，fork 从你上一个已完成回合继续。model 可按 {provider, modelId} 为 fresh 成员指定模型，并接受目录和允许列表校验；fork 保留你的模型以复用前缀，因此 context: "fork" 不接受 model。',
      '成员共享工作目录。分配互不重叠的写入范围，并要求成员保留其分配范围外的改动。',
      '团队成员用于持续需要共享任务看板或成员间消息的协作。独立的一次性子任务，即使有很多项并行或相互交叉核验，也应使用 subagent：其工具结果直接返回子智能体答复；团队成员的最终文本不会自行返回负责人，须通过任务、消息或文件收集。',
    ].join(' '),
    parameters: Type.Object({
      name: Type.String(),
      description: Type.Optional(Type.String()),
      prompt: Type.String(),
      context: Type.Optional(Type.Union([Type.Literal('fresh'), Type.Literal('fork')])),
      model: Type.Optional(Type.Object({
        provider: Type.String(),
        modelId: Type.String(),
      })),
    }),
    // 崩溃后的重跑必须复用已创建的子会话，而不是再 spawn 一次。
    replay: 'safe',
    /**
     * 功能：创建团队成员（四步装配流程）。
     * 输入校验/权限：仅 Lead；名称经 normalizeMemberName；prompt 必填限长；fork 模式
     * 拒绝指定 model；先对账 provisioning 成员；名字是幂等键（重放复用已建子会话）。
     * 内部逻辑：1) 先写 provisioning 边（创建失败也留行）；2) 一个 commit 内创建任务
     * 归属子会话与身份链接（fork 走 forkLeadConversation，fresh 建新会话；可选仅覆盖
     * 模型）；3) 提交初始 prompt（不等待运行）；4) 结算 active 边。
     */
    execute: async (args, api, context): Promise<ToolExecutionResult<TeamMemberView>> => {
      const scope = await resolveTeamScope(api, context)
      assertLead(scope)
      const name = normalizeMemberName(args.name)
      const prompt = requiredText(args.prompt, 'prompt', 20_000)
      const label = memberLabel(args.description, name)
      const mode = args.context ?? 'fresh'
      if (mode === 'fork' && args.model !== undefined) {
        throw new TeamRuleError(
          'fork 上下文继承 Lead 的对话与模型，不支持另行指定模型（保持前缀缓存复用）；需要另选模型请用 fresh。',
          'invalid-argument',
        )
      }
      const leadId = scope.leadId
      // 在本次调用添加新成员之前，先结算此前崩溃留下的 `provisioning` 成员
      // （DSH 在 Lead 启动时对账，`roster.ts:175-179,375-417`）。
      await reconcileProvisioning(
        { read: (id, ctx) => api.snapshot(Team, id, ctx), commit: (change, ctx) => api.commit(change, ctx) },
        { memberSession: options.memberSession },
        leadId,
        context,
      )
      const before = await readDoc(api, leadId, context)
      // 名字即幂等键：重放的 spawn 会找到自己已写的行与子会话。
      const plan = planSpawnReplay(before, name)
      if (plan.kind === 'reuse') {
        // 仅凭行还不够：子会话必须仍存在且链接指向本成员——正是 provisioning 对账检查
        // 的那对条件（`roster.ts:385-397`）。
        const state = await options.memberSession(plan.conversationId, leadId, name)
        if (!state.exists || !state.linked) {
          const reason = state.exists
            ? 'the child conversation is no longer this member\'s continuation'
            : 'provisioning did not leave a resumable child conversation'
          await markMemberFailed(api, leadId, name, new Error(reason), context)
          return spawnFailure(api, reason)
        }
      }
      if (plan.kind === 'taken') {
        throw new TeamRuleError(`teammate name "${name}" was already used in this Team`, 'member-name-taken')
      }
      if (plan.kind === 'create') spawnLimit(before, name)

      // 1. 在子会话存在之前记录 provisioning 边，创建失败也会留下一行。
      if (plan.kind === 'create') {
        await api.commit(async (tx) => {
          const doc = await tx.doc(Team, leadId)
          ensureLeadRow(doc, leadId)
          spawnLimit(doc, name)
          doc.members.push({ name, role: 'teammate', phase: 'provisioning', label })
        }, context)
      }

      // 2. 在同一个 commit 内创建任务归属子会话与身份链接（docs/history/families.md A6）。
      //    重放的调用复用为该名字记录的子会话。
      // fresh spawn 显式指定模型时只覆盖 model/thinkingLevel——绝不覆盖工具或指令，
      // 它们继续克隆 Lead 的组合（DSH 的 teammates 是 Lead 的副本）。
      let agent: AgentChange | undefined
      if (plan.kind === 'create' && mode === 'fresh' && args.model !== undefined && options.resolveChildModel !== undefined) {
        const lead = await api.agent(context)
        const resolved = options.resolveChildModel(args.model, { thinkingLevel: lead.thinkingLevel })
        agent = {
          model: resolved.model,
          ...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
        }
      }
      let childId: ConversationId
      try {
        childId = plan.kind === 'reuse'
          ? toConversationId(plan.conversationId)
          : await api.commit(async (tx) => {
            // 在会话写入之前读看板与 fork 边界：写后再读表/文档可能排队（docs/history/families.md A6）。
            const doc = await tx.doc(Team, leadId)
            const stored = doc.members.find(member => member.name === name)
            const ref = await tx.doc(TeamAnchors, leadId)
            // fork 的种子止于 Lead 最后一个已完成回合，绝不含进行中的回合
            // （DSH `subagent-fork-in-process/src/index.ts:44-56`）。
            const cutoff = mode === 'fork' ? await lastCompletedTurnEntry(tx, leadId) : undefined
            const anchorId = await reusableAnchor(tx, ref.taskId, leadId, (created) => { ref.taskId = Number(created) })
            const record = mode === 'fork'
              ? await forkLeadConversation(tx, leadId, cutoff, anchorId)
              : await tx.createConversation({ ownership: { kind: 'task', taskId: anchorId } })
            // Tx 创建调用不接受 agent 选项；`configure` 在同一 commit 内把模型选取写入
            // 克隆的 `pi.agent` 文档。
            if (agent !== undefined) await configure(tx, record.id, agent)
            await options.prepareChild(tx, record.id, leadId, label)
            const link = await tx.doc(TeamLink, record.id)
            link.leadConversationId = String(leadId)
            link.name = name
            if (stored !== undefined) stored.conversationId = String(record.id)
            return record.id
          }, context)
      } catch (error) {
        await markMemberFailed(api, leadId, name, error, context)
        return spawnFailure(api, describe(error))
      }

      await api.details({
        name, role: 'teammate', phase: 'provisioning', status: 'running', conversationId: String(childId), label,
      } satisfies TeamMemberView, context)

      // 3. 把初始 prompt 作为子会话的第一条消息送达，不等待运行。
      const child = await api.conversation(childId, context)
      if (child === undefined) {
        const reason = `child conversation ${String(childId)} is no longer available`
        await markMemberFailed(api, leadId, name, new Error(reason), context)
        return spawnFailure(api, reason)
      }
      try {
        await api.commit(tx => inheritPlanConstraint(tx, childId, leadId), context)
        await child.submit({
          type: 'input',
          content: prompt,
          requestId: `team-spawn:${String(leadId)}:${name}`,
          whenBusy: 'followUp',
        }, context)
      } catch (error) {
        if (context.abortSignal?.aborted === true) throw error
        await markMemberFailed(api, leadId, name, error, context)
        return spawnFailure(api, `the initial prompt was not accepted: ${describe(error)}`)
      }

      // 4. 结算持久的 active 边；即使运行已经结束，创建也算成功。
      const settled = await api.commit(async (tx) => {
        const doc = await tx.doc(Team, leadId)
        const stored = doc.members.find(member => member.name === name)
        if (stored === undefined) throw new TeamRuleError(`provisioned teammate "${name}" disappeared`, 'member-not-found')
        stored.phase = 'active'
        delete stored.error
        return { ...stored }
      }, context)
      const info = await options.conversationInfo(String(childId))
      const view = memberView(settled, info.status, info.model)
      return { output: jsonText({ member: view }), details: view }
    },
  })

  const sendMessageTool = defineTool({
    name: 'send_message',
    description: [
      '向另一名团队成员发送一条消息。正在运行的目标会在最近的步骤边界收到消息；inactive 目标会启动或恢复一个回合。',
      'target 来自 spawn_teammate 或 list_agents，也可为 "lead"。发送成功仅表示收件箱已接纳，不代表收到接收方的答复。',
    ].join(' '),
    parameters: Type.Object({ target: Type.String(), message: Type.String() }),
    /**
     * 功能：向团队成员或 lead 发送一条消息。
     * 输入校验：target 必须是活动成员或 lead；不能给自己发；带框架的消息不超过
     * MAX_TEAM_MESSAGE_BYTES。
     * 内部逻辑：先继承计划模式约束，再以 steer 模式提交到目标会话（running 的目标在
     * 最近步骤边界收到，inactive 的启动新回合）；投递失败写 error 诊断后抛出。
     */
    execute: async (args, api, context): Promise<ToolExecutionResult<{ sent: boolean; target: string; conversationId: string }>> => {
      const scope = await resolveTeamScope(api, context)
      const targetName = requireMember(args.target)
      const message = requiredText(args.message, 'message', 200_000)
      const doc = await readDoc(api, scope.leadId, context)
      let targetId: ConversationId
      if (targetName === LEAD_NAME) {
        targetId = scope.leadId
      } else {
        const member = doc.members.find(candidate => candidate.role === 'teammate' && candidate.name === targetName)
        if (member === undefined || member.phase !== 'active' || member.conversationId === undefined) {
          throw new TeamRuleError(`active teammate "${targetName}" not found`, 'member-not-found')
        }
        targetId = toConversationId(member.conversationId)
      }
      if (targetId === api.conversationId) {
        throw new TeamRuleError('a Team member cannot message itself', 'self-message')
      }
      const framed = `来自 ${scope.name} 的团队消息：\n${message}`
      if (Buffer.byteLength(framed, 'utf8') > MAX_TEAM_MESSAGE_BYTES) {
        throw new TeamRuleError(`team message exceeds ${MAX_TEAM_MESSAGE_BYTES} bytes`, 'message-too-large')
      }
      const target = await api.conversation(targetId, context)
      if (target === undefined) throw new TeamRuleError(`conversation ${String(targetId)} is no longer available`, 'member-not-found')
      try {
        await api.commit(tx => inheritPlanConstraint(tx, targetId, api.conversationId), context)
        await target.submit({
          type: 'input',
          content: framed,
          requestId: `team-message:${api.callId}:${targetName}`,
          whenBusy: 'steer',
        }, context)
      } catch (error) {
        api.diagnostic({ severity: 'error', message: `Team message delivery failed: ${describe(error)}` })
        throw error
      }
      const details = { sent: true, target: targetName, conversationId: String(targetId) }
      return { output: jsonText({ sent: true }), details }
    },
  })

  const listAgentsTool = defineTool({
    name: 'list_agents',
    description: [
      '列出负责人和所有持久团队成员，包含可寻址的 target 及当前可用状态。',
      'inactive 表示没有回合正在执行，不代表任务结果。provisioning 和 failed 描述成员创建状态。',
    ].join(' '),
    parameters: Type.Object({}),
    /** 功能：列出 Lead 合成行与全部成员的线上视图（含实时状态与模型）。 */
    execute: async (_args, api, context): Promise<ToolExecutionResult<{ members: TeamMemberView[] }>> => {
      const scope = await resolveTeamScope(api, context)
      const doc = await readDoc(api, scope.leadId, context)
      const members = await memberViews(doc, String(scope.leadId), options.conversationInfo)
      return { output: jsonText(members), details: { members } }
    },
  })

  const waitAgentTool = defineTool({
    name: 'wait_agent',
    description: [
      '等待本调用开始后的下一次成员状态、消息或共享任务变化。',
      '结果包含成员状态，以及可用时最近的助手文本预览、answerStatus、来源会话和条目。预览可能被截断或属于之前的回合。会话路径供宿主或用户定位来源，本身不是可调用工具。',
      '不会唤醒 inactive 成员；其他成员均未运行且未处于 provisioning 时，立即返回 noProgress。等待返回或超时后重新读取成员列表，不要循环轮询。',
      `timeout_ms 为 ${MIN_WAIT_MS} 到 ${MAX_WAIT_MS} 之间的整数，默认 ${DEFAULT_WAIT_MS}。`,
    ].join(' '),
    parameters: Type.Object({ timeout_ms: Type.Optional(Type.Number()) }),
    /**
     * 功能：等待成员状态/消息/共享任务的下一步变化。
     * 输入校验：timeout_ms 为 MIN_WAIT_MS–MAX_WAIT_MS 的安全整数。
     * 边界：没有其他活动成员时立即返回 noProgress（不唤醒 inactive 成员）并附带答复
     * 名册；等待经 waitForTeamChange 有界观察；返回后重新读取文档收集各成员答复预览。
     */
    execute: async (args, api, context): Promise<ToolExecutionResult<WaitAgentResult>> => {
      const timeoutMs = args.timeout_ms ?? DEFAULT_WAIT_MS
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_WAIT_MS || timeoutMs > MAX_WAIT_MS) {
        throw new TeamRuleError(`timeout_ms must be an integer from ${MIN_WAIT_MS} through ${MAX_WAIT_MS}`, 'invalid-timeout')
      }
      const scope = await resolveTeamScope(api, context)
      const doc = await readDoc(api, scope.leadId, context)
      const members = await memberViews(doc, String(scope.leadId), options.conversationInfo)
      const hasActivePeer = members.some(member =>
        member.conversationId !== String(api.conversationId) && isActiveStatus(member.status))
      if (!hasActivePeer) {
        const noProgress = { reason: 'no-active-peer' as const, message: NO_ACTIVE_PEER_MESSAGE }
        const roster = await teamRosterWithAnswers(api, doc, options.conversationInfo, context)
        return { output: jsonText({ timedOut: false, noProgress, ...roster }), details: { timedOut: false, noProgress, ...roster } }
      }
      const timedOut = await waitForTeamChange(api, options, scope.leadId, timeoutMs, context, { doc, members })
      const roster = await teamRosterWithAnswers(api, await readDoc(api, scope.leadId, context), options.conversationInfo, context)
      return { output: jsonText({ timedOut, ...roster }), details: { timedOut, ...roster } }
    },
  })

  const interruptAgentTool = defineTool({
    name: 'interrupt_agent',
    description: '中断一名成员的当前回合，并保留其待处理收件箱。仅团队负责人可调用。',
    parameters: Type.Object({ target: Type.String() }),
    /**
     * 功能：中断一名成员的当前回合（保留其待处理收件箱）。
     * 输入校验/权限：仅 Lead；目标必须是活动成员且不能是 Lead 自己。
     * 内部逻辑：先取实时状态作为 previousStatus，再对目标会话 abort。
     */
    execute: async (args, api, context): Promise<ToolExecutionResult<{ previousStatus: 'running' | 'inactive' }>> => {
      const scope = await resolveTeamScope(api, context)
      assertLead(scope)
      const targetName = requireMember(args.target)
      if (targetName === LEAD_NAME) throw new TeamRuleError('the Team Lead cannot interrupt itself', 'invalid-argument')
      const doc = await readDoc(api, scope.leadId, context)
      const member = doc.members.find(candidate => candidate.role === 'teammate' && candidate.name === targetName)
      if (member === undefined || member.phase !== 'active' || member.conversationId === undefined) {
        throw new TeamRuleError(`active teammate "${targetName}" not found`, 'member-not-found')
      }
      const info = await options.conversationInfo(member.conversationId)
      const target = await api.conversation(toConversationId(member.conversationId), context)
      if (target !== undefined) await target.abort(context)
      const details = { previousStatus: info.status }
      return { output: jsonText(details), details }
    },
  })

  const teamTaskCreateTool = defineTool({
    name: 'team_task_create',
    description: '在团队共享任务看板上创建一个无负责人、状态为 pending 的任务。',
    parameters: Type.Object({
      subject: Type.String(),
      description: Type.String(),
      blocked_by: Type.Optional(Type.Array(Type.String())),
      write_scopes: Type.Optional(Type.Array(Type.String())),
    }),
    /**
     * 功能：在共享看板上创建任务。
     * 输入校验：subject/description 必填限长；blocked_by 与 write_scopes 经纯函数校验
     * （存在性、自环、依赖环、范围规范化）。
     * 内部逻辑：ensureLeadRow 保证 Lead 行存在；createTask 产出新任务后写回文档并返回
     * 线上视图。
     */
    execute: async (args, api, context): Promise<ToolExecutionResult<TeamTaskView>> => {
      const scope = await resolveTeamScope(api, context)
      const view = await api.commit(async (tx) => {
        const doc = await tx.doc(Team, scope.leadId)
        ensureLeadRow(doc, scope.leadId)
        const { doc: next, task } = createTask(doc, {
          subject: args.subject,
          description: args.description,
          ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by }),
          ...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
        }, Date.now())
        doc.members = next.members
        doc.tasks = next.tasks
        return taskView(next.tasks, task)
      }, context)
      return { output: jsonText(view), details: view }
    },
  })

  const teamTaskListTool = defineTool({
    name: 'team_task_list',
    description: '列出共享任务，包括就绪状态、负责人、revision、阻塞项及写入范围警告。',
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])),
      owner: Type.Optional(Type.String()),
      ready: Type.Optional(Type.Boolean()),
      cursor: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    /**
     * 功能：分页列出共享任务（过滤 status/owner/ready）。
     * 输入校验：cursor 为非负安全整数；limit 为 1–100 的安全整数。
     * 边界：删除状态的任务不返回；还有剩余时附 nextCursor。
     */
    execute: async (args, api, context): Promise<ToolExecutionResult<{ tasks: TeamTaskView[]; nextCursor?: number }>> => {
      const scope = await resolveTeamScope(api, context)
      const doc = await readDoc(api, scope.leadId, context)
      const views = doc.tasks
        .filter(task => task.status !== 'deleted')
        .map(task => taskView(doc.tasks, task))
        .filter(task =>
          (args.status === undefined || task.status === args.status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
      const cursor = args.cursor ?? 0
      const limit = args.limit ?? 50
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TeamRuleError('cursor must be a non-negative safe integer', 'invalid-argument')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TeamRuleError('limit must be an integer from 1 through 100', 'invalid-argument')
      const tasks = views.slice(cursor, cursor + limit)
      const details = { tasks, ...(cursor + limit < views.length ? { nextCursor: cursor + limit } : {}) }
      return { output: jsonText(details), details }
    },
  })

  const teamTaskGetTool = defineTool({
    name: 'team_task_get',
    description: '修改或执行共享任务前，读取该任务完整的最新内容。',
    parameters: Type.Object({ task_id: Type.String() }),
    /** 功能：读取单个任务的完整线上视图（含最新 revision，修改前必读）。 */
    execute: async (args, api, context): Promise<ToolExecutionResult<TeamTaskView>> => {
      const scope = await resolveTeamScope(api, context)
      const doc = await readDoc(api, scope.leadId, context)
      const task = locateTask(doc, requiredText(args.task_id, 'task_id', 64))
      const view = taskView(doc.tasks, task)
      return { output: jsonText(view), details: view }
    },
  })

  const teamTaskUpdateTool = defineTool({
    name: 'team_task_update',
    description: [
      '使用 team_task_get 或 team_task_list 返回的最新 revision，对共享任务执行比较后更新操作。',
      '操作包括 claim、release、edit、set_dependencies、complete、reopen、reassign、delete。已有负责人的任务仅可由该负责人或团队负责人修改；reassign 仅限团队负责人。',
      '过期的 expected_revision 会被拒绝；重新读取任务，并使用当前 revision 重试。',
    ].join(' '),
    parameters: Type.Object({
      task_id: Type.String(),
      expected_revision: Type.Number(),
      action: Type.Union([
        Type.Literal('claim'), Type.Literal('release'), Type.Literal('edit'),
        Type.Literal('set_dependencies'), Type.Literal('complete'), Type.Literal('reopen'),
        Type.Literal('reassign'), Type.Literal('delete'),
      ]),
      subject: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      blocked_by: Type.Optional(Type.Array(Type.String())),
      write_scopes: Type.Optional(Type.Array(Type.String())),
      owner: Type.Optional(Type.String()),
    }),
    /**
     * 功能：以 expected_revision 做 CAS 的任务更新，按 action 分派到对应纯函数
     * （claim/release/edit/set_dependencies/complete/reopen/reassign/delete）。
     * 输入校验/权限：revision 过期或已删除在纯函数内拒绝；set_dependencies 必须带
     * blocked_by；各动作的归属权限（owner 或 Lead）与 Lead 专属的 reassign 也在其中
     * 裁决；变更后的任务图整体校验。
     */
    execute: async (args, api, context): Promise<ToolExecutionResult<TeamTaskView>> => {
      const scope = await resolveTeamScope(api, context)
      const actor = actorOf(scope)
      const taskId = requiredText(args.task_id, 'task_id', 64)
      const patch = {
        ...(args.subject === undefined ? {} : { subject: args.subject }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
      }
      const view = await api.commit(async (tx) => {
        const doc = await tx.doc(Team, scope.leadId)
        const revision = args.expected_revision
        const result = (() => {
          switch (args.action) {
            case 'claim':
              return claimTask(doc, taskId, revision, scope.name, Date.now())
            case 'release':
              return releaseTask(doc, taskId, revision, actor, Date.now())
            case 'edit':
              return editTask(doc, taskId, revision, actor, patch, Date.now())
            case 'set_dependencies':
              if (args.blocked_by === undefined) throw new TeamRuleError('set_dependencies requires blocked_by', 'invalid-argument')
              return setDependencies(doc, taskId, revision, actor, args.blocked_by, Date.now())
            case 'complete':
              return completeTask(doc, taskId, revision, actor, Date.now())
            case 'reopen':
              return reopenTask(doc, taskId, revision, actor, Date.now())
            case 'reassign':
              return reassignTask(doc, taskId, revision, actor, args.owner, Date.now())
            case 'delete':
              return deleteTask(doc, taskId, revision, actor, Date.now())
          }
        })()
        doc.members = result.doc.members
        doc.tasks = result.doc.tasks
        return taskView(result.doc.tasks, result.task)
      }, context)
      return { output: jsonText(view), details: view }
    },
  })

  return defineExtension({
    name: 'team',
    tools: [
      spawnTool,
      sendMessageTool,
      listAgentsTool,
      waitAgentTool,
      interruptAgentTool,
      teamTaskCreateTool,
      teamTaskListTool,
      teamTaskGetTool,
      teamTaskUpdateTool,
    ],
    sections: [teamSection],
    tasks: [TeamAnchor],
  })
}

/**
 * 功能：复用 Lead 停驻的后台锚点，或新建一个。锚点是所有权边界，把成员的运行挡在
 * Lead 的空闲范围之外（pi-durable README：后台任务不参与普通空闲等待、会话中止与
 * 级联中止）。
 * 内部逻辑：已有记录且任务仍在 pending/running/waiting 时直接复用；否则创建新锚点
 * 任务（background: true，归属当前会话）并经 remember 回写文档。
 */
async function reusableAnchor(
  tx: Tx,
  taskId: number | null,
  leadId: ConversationId,
  remember: (created: TaskId) => void,
): Promise<TaskId> {
  if (typeof taskId === 'number' && Number.isSafeInteger(taskId) && taskId > 0) {
    const record = await tx.task(taskId as TaskId)
    if (record !== undefined
      && (record.state.status === 'running' || record.state.status === 'waiting' || record.state.status === 'pending')) {
      return record.id as TaskId
    }
  }
  const created = await tx.createTask(TeamAnchor, { lead: String(leadId) }, {
    ownership: { kind: 'conversation' },
    background: true,
  })
  remember(created)
  return created
}

/**
 * 功能：找到父会话关闭其最后一个已完成回合的条目；首个回合完成前返回 undefined。
 *
 * DSH 给 fork 子会话播种平衡的已完成回合前缀，绝不包含进行中的回合
 * （`subagent-fork-in-process/src/index.ts:44-56`，README "Seed boundary"）。Pi 的条目
 * 日志没有 `turn/end` 标记，因此同一边界从模型消息推导：一个回合以 stopReason 为
 * `stop` 或 `length` 的 assistant 答复结束；`toolUse` 还有未完成的工作，
 * `pending`/`error`/`aborted` 未完成。未完成回合期间插入的 steer 输入位于该条目之后，
 * 因此随之一并排除。
 * @param tx 事务句柄。
 * @param conversationId 父（Lead）会话 id。
 * @returns 截断条目 id，或 undefined。
 */
export async function lastCompletedTurnEntry(tx: Tx, conversationId: ConversationId): Promise<EntryId | undefined> {
  let cutoff: EntryId | undefined
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId, order: 'ascending' }, 256, cursor)
    for (const entry of page.items) {
      if ((entry.model ?? []).some(message =>
        message.role === 'assistant' && (message.stopReason === 'stop' || message.stopReason === 'length'))) {
        cutoff = entry.id
      }
    }
    cursor = page.next
  } while (cursor)
  return cutoff
}

/**
 * 功能：把 Lead 的已完成回合前缀 fork 成任务归属的子会话。
 * 内部逻辑：首个已完成回合之前前缀为空，子会话全新开始——DSH 的 `prepareContinuable`
 * 在该情况下返回 `{}`，子会话表现得像 spawn（`index.ts:72-77`）。`cutoff` 必须在
 * commit 的首次表写入之前读取（docs/history/families.md A6）。
 */
async function forkLeadConversation(tx: Tx, leadId: ConversationId, cutoff: EntryId | undefined, taskId: TaskId): Promise<{ id: ConversationId }> {
  const ownership = { kind: 'task' as const, taskId }
  if (cutoff === undefined) return await tx.createConversation({ ownership })
  return await tx.forkConversation(leadId, cutoff, { ownership })
}
