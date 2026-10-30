import { Buffer } from 'node:buffer'
import type { Context } from '@earendil-works/chord/context'
import {
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
import { inheritPlanConstraint } from '../conversation/execution-policy.ts'

/**
 * Agent Teams, following DSH `packages/experimental/agent-team`.
 *
 * The Lead conversation owns the durable roster and the shared task board (DSH stores both as
 * full snapshots in the Lead session log; here they are two arrays in one conversation document).
 * A teammate is an ordinary task-owned child conversation, the same seam `subagent-tools.ts` uses,
 * so the child inherits the Lead's agent configuration. Every mutation is a compare-and-set on the
 * task revision, exactly like `task-board.ts:105-211`.
 */

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

/** DSH defaults: `agent-team/src/index.ts:42-45`. */
export const MAX_TEAM_MEMBERS = 16
export const MAX_TEAM_TASKS = 256
export const MAX_TEAM_MESSAGE_BYTES = 65_536
export const MAX_TEAM_NAME_LENGTH = 64
export const MAX_TASK_SUBJECT_CHARS = 200
export const MAX_TASK_DESCRIPTION_CHARS = 16_384
export const MIN_WAIT_MS = 10_000
export const MAX_WAIT_MS = 3_600_000
export const DEFAULT_WAIT_MS = 30_000

/** The Lead pseudo-member's model-facing name; reserved and never reusable (DSH `roster.ts:436-444`). */
export const LEAD_NAME = 'lead'
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** One durable roster row, mirroring DSH's `TeamMemberSnapshot` (`types.ts:47-56`). */
export type TeamMemberRecord = {
  name: string
  role: 'lead' | 'teammate'
  conversationId?: string
  phase: TeamMemberPhase
  label?: string
  error?: string
}

/** DSH's `TeamTaskSnapshot` (`types.ts:74-84`) plus the durable timestamps the panel orders by. */
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

export type TeamDocValue = { members: TeamMemberRecord[]; tasks: TeamTaskRecord[] }

/** `pi-web.team` lives on the Lead conversation; `agent-team/src/index.ts:56-109` owns the same state. */
export const Team = defineDoc<TeamDocValue>({
  kind: 'pi-web.team',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ members: [], tasks: [] }),
})

/**
 * Written on a teammate's own conversation so its team tools resolve the Lead's board instead of
 * creating a second, empty team. DSH resolves this through the child's `parentSession` header.
 */
export const TeamLink = defineDoc<{ leadConversationId: string | null; name: string | null }>({
  kind: 'pi-web.team-member',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ leadConversationId: null, name: null }),
})

/**
 * Background anchor task per Lead conversation. DSH's teammates are continuable children that do not
 * keep the Lead busy; Pi's equivalent is documented in the pi-durable README ("A task created with
 * `{ background: true }` is a boundary: work it owns survives the parent's abort and does not keep
 * the parent busy") — member conversations are owned by this parked task, so a running teammate
 * never blocks the Lead's own run, while `interrupt_agent` still aborts the member directly.
 */
export const TeamAnchors = defineDoc<{ taskId: number | null }>({
  kind: 'pi-web.team-anchor',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ taskId: null }),
})

const TeamAnchor = defineTask<{ lead: string }, { phase: 'anchor' }, null, object>({
  name: 'pi-web.team-anchor',
  version: 1,
  initial: () => ({ phase: 'anchor' }),
  phases: {
    // Park for the lifetime of the runtime; the reconciliation edge is the owner link itself.
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
        // The Harness is closing: the parked boundary has nothing left to record.
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

/** Stable rule codes; tool errors surface the message, tests assert the category. */
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

export class TeamRuleError extends Error {
  constructor(message: string, readonly code: TeamRuleCode) {
    super(message)
    this.name = 'TeamRuleError'
  }
}

/** Who mutates one task: the Lead, or a teammate by its durable name. */
export type TeamActor = { lead: boolean; name: string }

/** Trimmed non-empty text, bounded; DSH `validation.ts:12-19`. */
export function requiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text === '') throw new TeamRuleError(`${field} must be non-empty`, 'invalid-argument')
  if (text.length > maxLength) throw new TeamRuleError(`${field} exceeds ${maxLength} characters`, 'invalid-argument')
  return text
}

/**
 * DSH `validation.ts:26-34`: slash-normalize one workspace-relative prefix and reject absolute,
 * drive-letter, empty-segment and parent-traversal values. The scope is advisory, never a lock.
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

/** Normalize and de-duplicate the advisory scopes (`task-board.ts:234-237`). */
export function normalizeWriteScopes(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeWriteScope))]
}

/** DSH `roster.ts:436-444`: lower-kebab-case, at most 64 characters, never `lead`. */
export function normalizeMemberName(value: string): string {
  if (!MEMBER_NAME.test(value) || value.length > MAX_TEAM_NAME_LENGTH || value === LEAD_NAME) {
    throw new TeamRuleError(
      'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
      'invalid-member-name',
    )
  }
  return value
}

/** Whether every current blocker completed (`task-view.ts:24-26`). */
export function taskReady(tasks: readonly TeamTaskRecord[], task: TeamTaskRecord): boolean {
  return task.blockedBy.every(id => tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** One detached wire view (`task-view.ts:37-62`), with the explicit `blocked` flag the panel uses. */
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
 * Detect a dependency cycle among non-deleted tasks (`task-graph.ts:54-69`); a self edge counts.
 * Returns the id where the cycle closes, or undefined.
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

/** Validate a complete candidate graph (`task-graph.ts:26-69`). */
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

/** Validate and de-duplicate blocker ids against the current board, self included (`task-board.ts:213-232`). */
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

function nextTaskId(tasks: readonly TeamTaskRecord[]): string {
  let max = 0
  for (const task of tasks) {
    const match = /^task-(\d+)$/u.exec(task.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `task-${max + 1}`
}

export type CreateTaskInput = {
  subject: string
  description: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
}

/** Create one unowned pending revision-one task (`task-board.ts:44-69`). */
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

function locateTask(doc: TeamDocValue, taskId: string): TeamTaskRecord {
  const task = doc.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new TeamRuleError(`team task "${taskId}" not found`, 'task-not-found')
  return task
}

/** Compare-and-set one transition (`task-board.ts:105-211`): stale or deleted refuses before the action. */
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

function authorizeOwner(task: TeamTaskRecord, actor: TeamActor): void {
  if (!actor.lead && task.owner !== actor.name) {
    throw new TeamRuleError('task mutation requires its owner or Team Lead', 'unauthorized')
  }
}

function withoutOwner(task: TeamTaskRecord): TeamTaskRecord {
  const { owner: _owner, ...rest } = task
  return rest
}

/** Claim: ready, unowned (or already the caller's), then in progress (`task-board.ts:129-137`). */
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

/** Release an in-progress task back to the unowned pool (`task-board.ts:138-141`). */
export function releaseTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    if (current.status !== 'in_progress') throw new TeamRuleError('only an in-progress task can be released', 'invalid-transition')
    return withoutOwner({ ...current, status: 'pending' })
  }, now)
}

/** Edit the text or advisory scopes (`task-board.ts:143-156`). */
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

/** Replace the complete blocker list, self-reference and cycles rejected (`task-board.ts:157-161`). */
export function setDependencies(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, blockedBy: readonly string[], now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    return { ...current, blockedBy: validateDependencies(doc.tasks, blockedBy, current.id) }
  }, now)
}

/** Complete an in-progress task (`task-board.ts:162-166`). */
export function completeTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    if (current.status !== 'in_progress') throw new TeamRuleError('only an in-progress task can complete', 'invalid-transition')
    return { ...current, status: 'completed' }
  }, now)
}

/** Reopen a completed task as unowned pending (`task-board.ts:167-171`). */
export function reopenTask(doc: TeamDocValue, taskId: string, expectedRevision: number, actor: TeamActor, now: number): { doc: TeamDocValue; task: TeamTaskRecord } {
  return mutateTask(doc, taskId, expectedRevision, current => {
    authorizeOwner(current, actor)
    if (current.status !== 'completed') throw new TeamRuleError('only a completed task can reopen', 'invalid-transition')
    return withoutOwner({ ...current, status: 'pending' })
  }, now)
}

/**
 * Lead-only assignment (`task-board.ts:172-188`). Omitting the owner unassigns and returns the task
 * to pending; assigning requires readiness and an active member (or the Lead itself).
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

/** Delete a task no active task still depends on (`task-board.ts:189-198`). */
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

/** Live turn status plus the child's model, supplied by the runtime. */
export type TeamConversationInfo = { status: 'running' | 'inactive'; model?: string }

/**
 * Durable evidence about one provisioned member session, gathered outside the tool's commit.
 * DSH's reconciliation reads the persisted child Session directly (`roster.ts:385-397`); Pi has
 * no session-log reader in the tool API, so the runtime answers the same questions from the
 * conversation table, the child's `pi-web.team-member` link, and its submission record.
 */
export type MemberSessionState = {
  /** The child conversation record exists. */
  exists: boolean
  /** The child's link document points back at this Lead under this member name. */
  linked: boolean
  /** The initial prompt submission (`team-spawn:<lead>:<name>`) was durably rejected or withdrawn. */
  promptRejected: boolean
  /** The child currently has a live run, so its creator is still completing in this process. */
  running: boolean
}

/** The document access a reconciliation needs; the tool API and the runtime both satisfy it. */
export type TeamDocAccess = {
  read: (leadId: ConversationId, context: Context) => Promise<TeamDocValue | undefined>
  commit: (change: (tx: Tx) => void | Promise<void>, context: Context) => Promise<void>
}

/** What the runtime reports about a member's child conversation. */
export type MemberSessionProbe = (conversationId: string, leadId: ConversationId, name: string) => Promise<MemberSessionState>

/**
 * DSH's provisioning reconciliation (`roster.ts:375-417`): a member left in `provisioning` whose
 * child Session no longer exists — or cannot be resumed as this member's continuation — becomes
 * `failed` with the reason on its row. A live child is skipped: its creator still owns the
 * terminal edge in this process (`roster.ts:379-382`).
 *
 * Pi difference: the child is a durable conversation, so "resumable" means the record exists and
 * its link still names this member; an initial prompt the inbox explicitly rejected is the one
 * terminal failure the reconciliation can see. A prompt never submitted (a crash between child
 * creation and submission) stays `active` because the replay path re-submits it under the same
 * request ID — DSH's continuation is not resumable in that state (`roster.ts:389-394`).
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
    // A live child means creation is still completing here; the creator writes the terminal edge.
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
      // Another writer may have settled it already; the first terminal edge wins.
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

/** Wire rows: the synthetic Lead row first, then durable teammates in creation order. */
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

/** Build the team projection from one Lead document and each member conversation's live status. */
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

/** Options supplied by the runtime: conversation plumbing the tool API does not expose. */
export type TeamToolOptions = {
  /** Stamp the child's title/workspace/access mode inside the creating commit. */
  prepareChild: (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string) => Promise<void>
  /** Live turn status plus the model of one conversation (the member's own agent). */
  conversationInfo: (conversationId: string) => Promise<TeamConversationInfo>
  /** Observe member busy transitions for `wait_agent`; returns a stop function. */
  watchMembers: (leadId: string, onChange: () => void) => Promise<() => Promise<void>>
  /**
   * Durable evidence about one provisioned member session. The spawn replay path and the
   * provisioning reconciliation both need reads the tool API cannot perform inside its own commit
   * (`docs/families.md` A6), so the runtime answers them from the conversation table.
   */
  memberSession: MemberSessionProbe
}

type TeamScope = { leadId: ConversationId; role: 'lead' | 'teammate'; name: string }

function toConversationId(value: string): ConversationId {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new TeamRuleError('invalid conversation id', 'invalid-argument')
  return id as ConversationId
}

const EMPTY_TEAM: TeamDocValue = { members: [], tasks: [] }

/** Resolve the team this conversation belongs to: its own board as Lead, else its Lead's board. */
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

function assertLead(scope: TeamScope): void {
  if (scope.role !== 'lead') throw new TeamRuleError('only the Team Lead can perform this action', 'lead-required')
}

function actorOf(scope: TeamScope): TeamActor {
  return { lead: scope.role === 'lead', name: scope.name }
}

function requireMember(value: string): string {
  return requiredText(value, 'target', MAX_TEAM_NAME_LENGTH)
}

function memberLabel(value: string | undefined, name: string): string {
  const label = (value ?? '').trim()
  if (label === '') return name
  if (label.length > 200) throw new TeamRuleError('description exceeds 200 characters', 'invalid-argument')
  return label
}

/** What a spawn call should do for one name, given the durable roster (`roster.ts:263-276`). */
export type SpawnReplayPlan =
  | { kind: 'create' }
  | { kind: 'reuse'; conversationId: string }
  | { kind: 'taken' }

/**
 * The spawn idempotency decision. A replay of the same call finds the row its first attempt wrote
 * and reuses that child (`spawn_teammate` is `replay: 'safe'`); any other same-named row means the
 * name was already used, and DSH never reuses a teammate name (`roster.ts:263-276,436-444`).
 */
export function planSpawnReplay(doc: TeamDocValue, name: string): SpawnReplayPlan {
  const existing = doc.members.find(member => member.role === 'teammate' && member.name === name)
  if (existing === undefined) return { kind: 'create' }
  if (existing.conversationId !== undefined && existing.phase !== 'failed') {
    return { kind: 'reuse', conversationId: existing.conversationId }
  }
  return { kind: 'taken' }
}

function spawnLimit(doc: TeamDocValue, name: string): void {
  if (doc.members.some(member => member.name === name)) {
    throw new TeamRuleError(`teammate name "${name}" was already used in this Team`, 'member-name-taken')
  }
  if (doc.members.length >= MAX_TEAM_MEMBERS) {
    throw new TeamRuleError(`Team member limit ${MAX_TEAM_MEMBERS} reached`, 'member-limit')
  }
}

function ensureLeadRow(doc: TeamDocValue, leadId: ConversationId): void {
  if (doc.members.some(member => member.role === 'lead')) return
  doc.members.unshift({ name: LEAD_NAME, role: 'lead', conversationId: String(leadId), phase: 'active', label: 'Lead' })
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
}

function jsonText(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** `wait_agent` without an active peer says exactly what DSH says (`tool-agent-team/src/index.ts:45`). */
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

function isActiveStatus(status: TeamMemberView['status']): boolean {
  return status === 'running' || status === 'provisioning'
}

/**
 * Member-status digest for the post-registration recheck. Pi's reads are asynchronous where DSH
 * registers its waiter in one synchronous span, so a transition that lands while the watchers are
 * acquired is recovered here instead of being lost.
 */
async function statusDigest(info: TeamToolOptions['conversationInfo'], ids: readonly string[]): Promise<string> {
  const rows = await Promise.all(ids.map(async id => {
    try {
      return `${id}:${(await info(id)).status}`
    } catch {
      return `${id}:unknown`
    }
  }))
  return rows.join('|')
}

/** Bounded `wait_agent`: doc changes plus member busy transitions, aborted with the call. */
export async function waitForTeamChange(
  api: ToolExecutionApi,
  options: TeamToolOptions,
  leadId: ConversationId,
  timeoutMs: number,
  context: Context,
): Promise<boolean> {
  const signal = context.abortSignal
  signal?.throwIfAborted()
  const baselineDoc = await readDoc(api, leadId, context)
  const ids = baselineDoc.members
    .flatMap(member => member.role === 'teammate' && member.conversationId !== undefined ? [member.conversationId] : [])
  const baseline = await statusDigest(options.conversationInfo, ids)
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
    // Recover a transition that landed while the asynchronous watchers were being acquired.
    if (!settled) {
      const after = await statusDigest(options.conversationInfo, ids)
      if (after !== baseline) notify()
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

type TeamToolName = (typeof TEAM_TOOL_NAMES)[number]

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

function teamRoutes(agent: ToolCatalog): Record<TeamToolName, ToolRoute> {
  return Object.fromEntries(TEAM_TOOL_NAMES.map(name => [name, resolveToolRoute(agent, name)])) as Record<TeamToolName, ToolRoute>
}

function teamCall(name: TeamToolName, routes: Record<TeamToolName, ToolRoute>, args = TEAM_TOOL_EXAMPLES[name]): string | undefined {
  return toolRouteInstruction(name, routes[name], args)
}

function sharedTeamPolicy(planActive: boolean): string {
  return planActive
    ? 'The Team shares one working directory. Plan mode is read-only for every member: inspect and report evidence, preserve all files, and do not make workspace changes.'
    : 'The Team shares one working directory; file changes are immediately visible to every member. Preserve other members’ edits, stay within your assigned write scope, and coordinate overlapping work before changing shared files.'
}

const teamSection = section('team-policy', async (input, context) => {
  const [link, plan] = await Promise.all([
    input.read.snapshot(TeamLink, input.conversationId, context),
    input.read.snapshot(Plans, input.conversationId, context),
  ])
  const planActive = plan?.active === true
  const routes = teamRoutes(input.agent)
  if (link?.leadConversationId) {
    const lines = [
      `You are teammate "${link.name ?? 'teammate'}" of an Agent Team. Your Team Lead is named "lead".`,
      sharedTeamPolicy(planActive),
      planActive
        ? 'Follow only the assigned research task; report findings and concrete evidence to the Team Lead.'
        : 'Follow only the assigned task; report the outcome and concrete verification evidence to the Team Lead. The Lead coordinates the team and owns task assignment.',
    ]
    const message = teamCall('send_message', routes, '{ target: "lead", message: "..." }')
    if (message) lines.push(`To contact the Lead, ${message}`)
    const list = teamCall('list_agents', routes)
    if (list) lines.push(`To inspect teammate names and availability, ${list}`)
    if (planActive && routes.team_task_list !== 'unavailable' && routes.team_task_get !== 'unavailable') {
      lines.push('Use task board reads only to understand the assigned research scope; do not attempt task updates during Plan mode.')
    } else if (!planActive && routes.team_task_list !== 'unavailable' && routes.team_task_get !== 'unavailable' && routes.team_task_update !== 'unavailable') {
      lines.push('For your assigned shared task, inspect its latest revision, claim it if it is pending and unowned, then mark it complete only after its work and requested verification are done.')
    } else if (routes.team_task_update !== 'unavailable') {
      lines.push('Use only task identifiers and revisions supplied in the assignment; do not guess either value.')
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
    `You are the Team Lead named "lead". Your Team has ${teammates.length} teammate${teammates.length === 1 ? '' : 's'}: ${teammates.map(member => member.name).join(', ')}.`,
    sharedTeamPolicy(planActive),
  ]

  const spawn = teamCall('spawn_teammate', routes)
  if (spawn) {
    lines.push(planActive
      ? `Delegate only independent read-only research with separate research scopes. Make each prompt self-contained with the task, scope, constraints and authorization, acceptance criteria, and required evidence; the child inherits Plan mode. ${spawn}`
      : `Delegate only focused work with disjoint write scopes. A teammate prompt must be self-contained and include the task, scope, constraints and authorization, acceptance criteria, and required result evidence; preserve changes outside its assigned scope. A spawned teammate runs in the background. ${spawn}`)
  }
  const list = teamCall('list_agents', routes)
  if (list) lines.push(`Use the roster to check each member’s availability; inactive means no turn is running, not task completion. ${list}`)
  const message = teamCall('send_message', routes)
  if (message) lines.push(`Use a message to steer a running member or start/resume an inactive one; a successful send does not mean it was processed. ${message}`)
  const interrupt = teamCall('interrupt_agent', routes)
  if (interrupt) lines.push(`Interrupt only a member whose current turn should stop. ${interrupt}`)

  const createTask = teamCall('team_task_create', routes)
  if (createTask) lines.push(`Use shared tasks for work that needs ownership or dependencies; record write scopes and blockers when relevant. ${createTask}`)
  const taskList = teamCall('team_task_list', routes)
  const taskGet = teamCall('team_task_get', routes)
  const taskUpdate = teamCall('team_task_update', routes)
  if (taskList) lines.push(planActive
    ? `Inspect only current task scope and status for research planning. ${taskList}`
    : `Inspect readiness and ownership before assigning work. ${taskList}`)
  if (taskGet) lines.push(planActive
    ? `Read task details only to understand the current research scope. ${taskGet}`
    : `Read a task’s latest revision before changing or executing it. ${taskGet}`)
  if (taskUpdate) {
    lines.push(`Use the latest revision for each update; claim before work and complete only after verification passes. Task readiness does not start an owner. ${taskUpdate}`)
  }
  const wait = teamCall('wait_agent', routes)
  if (wait && list) {
    lines.push(`Wait only after the roster shows another required member running or provisioning; this observes later changes and never wakes a member. Re-list after wakeup or timeout. Wait for required teammates before the final answer. ${wait}`)
  }
  return lines.join('\n')
})

/** Build the Team extension; `options` is closed over by every tool definition in this call. */
export function createTeamTools(options: TeamToolOptions): Extension {
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
      'Create one named, durable teammate in a separate child conversation; it runs in the background and this call returns without waiting for its answer.',
      'Only the Team Lead may call this tool. The name must be unique lower-kebab-case, at most 64 characters, and never "lead"; a name is never reused, even after a failed creation.',
      'The prompt is the teammate\'s complete, self-contained initial task: it inherits your agent configuration, tools, model and working directory, but not your messages. Include the task, assigned scope, applicable constraints and authorization, acceptance criteria, and required result evidence.',
      'Members share the working directory. Assign disjoint write scopes and require the teammate to preserve edits outside its assigned scope.',
    ].join(' '),
    parameters: Type.Object({
      name: Type.String(),
      description: Type.Optional(Type.String()),
      prompt: Type.String(),
      context: Type.Optional(Type.Union([Type.Literal('fresh'), Type.Literal('fork')])),
    }),
    // A rerun after a crash must reuse the child it already created instead of spawning twice.
    replay: 'safe',
    execute: async (args, api, context): Promise<ToolExecutionResult<TeamMemberView>> => {
      const scope = await resolveTeamScope(api, context)
      assertLead(scope)
      const name = normalizeMemberName(args.name)
      const prompt = requiredText(args.prompt, 'prompt', 20_000)
      const label = memberLabel(args.description, name)
      const mode = args.context ?? 'fresh'
      const leadId = scope.leadId
      // Settle members an earlier crash left in `provisioning` before this call adds another
      // (DSH reconciles at Lead start, `roster.ts:175-179,375-417`).
      await reconcileProvisioning(
        { read: (id, ctx) => api.snapshot(Team, id, ctx), commit: (change, ctx) => api.commit(change, ctx) },
        { memberSession: options.memberSession },
        leadId,
        context,
      )
      const before = await readDoc(api, leadId, context)
      // The name is the idempotency key: a replayed spawn finds the row and child it already made.
      const plan = planSpawnReplay(before, name)
      if (plan.kind === 'reuse') {
        // The row alone is not enough: the child must still exist and its link must name this
        // member, exactly the pair the provisioning reconciliation checks (`roster.ts:385-397`).
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

      // 1. Record the provisioning edge before any child exists, so a failed creation leaves a row.
      if (plan.kind === 'create') {
        await api.commit(async (tx) => {
          const doc = await tx.doc(Team, leadId)
          ensureLeadRow(doc, leadId)
          spawnLimit(doc, name)
          doc.members.push({ name, role: 'teammate', phase: 'provisioning', label })
        }, context)
      }

      // 2. Create the task-owned child and its identity link in one commit (docs/families.md A6).
      //    A replayed call reuses the child already recorded for this name.
      let childId: ConversationId
      try {
        childId = plan.kind === 'reuse'
          ? toConversationId(plan.conversationId)
          : await api.commit(async (tx) => {
            // Read the board and the fork boundary before the conversation write: a table/doc read
            // after a write can queue (docs/families.md A6).
            const doc = await tx.doc(Team, leadId)
            const stored = doc.members.find(member => member.name === name)
            const ref = await tx.doc(TeamAnchors, leadId)
            // The fork seed ends at the Lead's last completed turn, never at its in-flight one
            // (DSH `subagent-fork-in-process/src/index.ts:44-56`).
            const cutoff = mode === 'fork' ? await lastCompletedTurnEntry(tx, leadId) : undefined
            const anchorId = await reusableAnchor(tx, ref.taskId, leadId, (created) => { ref.taskId = Number(created) })
            const record = mode === 'fork'
              ? await forkLeadConversation(tx, leadId, cutoff, anchorId)
              : await tx.createConversation({ ownership: { kind: 'task', taskId: anchorId } })
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

      // 3. Deliver the initial prompt as the child's first message, without waiting for the run.
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

      // 4. Settle the durable active edge; creation succeeded even if the run already finished.
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
      'Send one message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      'The target comes from spawn_teammate or list_agents, including "lead". A successful send only means the inbox accepted it; it is not the recipient\'s answer.',
    ].join(' '),
    parameters: Type.Object({ target: Type.String(), message: Type.String() }),
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
      const framed = `Team message from ${scope.name}:\n${message}`
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
      'List the Lead and every durable teammate with an addressable target and current availability.',
      'inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
    ].join(' '),
    parameters: Type.Object({}),
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
      'Wait for the next teammate status, message, or shared-task change after this call starts.',
      'This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      `timeout_ms is an integer from ${MIN_WAIT_MS} through ${MAX_WAIT_MS}; it defaults to ${DEFAULT_WAIT_MS}.`,
    ].join(' '),
    parameters: Type.Object({ timeout_ms: Type.Optional(Type.Number()) }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ timedOut: boolean; noProgress?: { reason: 'no-active-peer'; message: string } }>> => {
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
        return { output: jsonText({ timedOut: false, noProgress }), details: { timedOut: false, noProgress } }
      }
      const timedOut = await waitForTeamChange(api, options, scope.leadId, timeoutMs, context)
      return { output: jsonText({ timedOut }), details: { timedOut } }
    },
  })

  const interruptAgentTool = defineTool({
    name: 'interrupt_agent',
    description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
    parameters: Type.Object({ target: Type.String() }),
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
    description: 'Create one unowned pending task on the shared Team task board.',
    parameters: Type.Object({
      subject: Type.String(),
      description: Type.String(),
      blocked_by: Type.Optional(Type.Array(Type.String())),
      write_scopes: Type.Optional(Type.Array(Type.String())),
    }),
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
    description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])),
      owner: Type.Optional(Type.String()),
      ready: Type.Optional(Type.Boolean()),
      cursor: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
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
    description: 'Read the complete latest value of one shared task before changing or executing it.',
    parameters: Type.Object({ task_id: Type.String() }),
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
      'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      'Actions: claim, release, edit, set_dependencies, complete, reopen, reassign, delete. Only the owner or the Team Lead may mutate an owned task; reassign is Lead-only.',
      'A stale expected_revision is rejected; re-read the task and retry with the current revision.',
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
 * Reuse the Lead's parked background anchor, or create one. The anchor is the ownership boundary
 * that keeps a member's run out of the Lead's idle scope (pi-durable README: background tasks are
 * excluded from ordinary idle waits, conversation aborts, and cascades).
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
 * The parent entry that closes its last completed turn, or undefined before the first one.
 *
 * DSH seeds a fork child with the balanced completed-turn prefix and never the in-flight turn
 * (`subagent-fork-in-process/src/index.ts:44-56`, README "Seed boundary"). Pi's entry log has no
 * `turn/end` marker, so the same boundary is derived from the model messages: a turn ends with an
 * assistant answer whose `stopReason` is `stop` or `length`; `toolUse` still has work outstanding,
 * and `pending`/`error`/`aborted` did not complete. Steering inputs placed during an unfinished
 * turn sit after this entry, so they are excluded with it.
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
 * Fork the Lead's completed-turn prefix into a task-owned child. Before the first completed turn
 * the prefix is empty, so the child starts fresh — DSH's `prepareContinuable` returns `{}` in that
 * case and the child behaves like a spawn (`index.ts:72-77`). `cutoff` must be read before the
 * commit's first table write (docs/families.md A6).
 */
async function forkLeadConversation(tx: Tx, leadId: ConversationId, cutoff: EntryId | undefined, taskId: TaskId): Promise<{ id: ConversationId }> {
  const ownership = { kind: 'task' as const, taskId }
  if (cutoff === undefined) return await tx.createConversation({ ownership })
  return await tx.forkConversation(leadId, cutoff, { ownership })
}
