/**
 * Team rosters and the subagent catalog.
 *
 * DSH keeps its roster in the Lead session; pi-durable has no such document, so the same
 * questions are answered from the owner edge plus each child's live view. Both features
 * read `detailFromView` from the conversation engine, hence the late-bound callback.
 */
import type {
  Conversation, ConversationId, ConversationRecord, ConversationView, Cursor, Harness, Tx,
} from '@earendil-works/pi-durable'
import type { ChildMessageInput, ConversationDetail, SubagentSummary, TeamView, WorkspaceSummary } from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import { activeDurationMs, usageTokens } from '../conversation/projection.ts'
import { inheritPlanConstraint } from '../conversation/execution-policy.ts'
import { latestOwnAnswer } from '../conversation/subagent-answer.ts'
import { Subagents } from '../tools/subagent.ts'
import {
  Team, TeamLink, projectTeam, reconcileProvisioning,
  type MemberSessionState, type TeamConversationInfo,
} from '../tools/team.ts'
import { UsageDoc } from '@earendil-works/pi-durable'
import { RuntimeError } from '../runtime-errors.ts'
import type { ConversationMetadata } from './helpers.ts'
import {
  CTX, META, SUBAGENT_ANSWER_CHARS, SUBAGENT_LIMIT, SUBAGENT_MESSAGE_CHARS, liveRunTaskId, parseConversationId,
} from './helpers.ts'

export interface TeamDeps {
  appState: AppStateStore
  harness: () => Harness
  requireConversation(value: string): Promise<Conversation>
  currentDetail(id: ConversationId): Promise<ConversationDetail>
  detailFromView(
    id: ConversationId,
    view: ConversationView,
    metadata?: Readonly<ConversationMetadata>,
    options?: { subagents?: boolean; team?: boolean },
  ): Promise<ConversationDetail>
  defaultWorkspace(): WorkspaceSummary | undefined
}

export function createTeam(deps: TeamDeps) {
  const { appState, harness: harnessOf, requireConversation, currentDetail, detailFromView, defaultWorkspace } = deps

  /**
   * One conversation's live turn status plus its model. `pi.live.run` is the same signal the child
   * catalog uses (`busy`), so `inactive` here means exactly "no turn is executing".
   */
  const conversationInfo = async (value: string): Promise<TeamConversationInfo> => {
    const id = parseConversationId(value)
    const conversation = await harnessOf().conversation(id, CTX)
    if (conversation === undefined) return { status: 'inactive' }
    const viewWatch = await conversation.watch(CTX)
    try {
      const running = liveRunTaskId(viewWatch.value) !== undefined
      const agent = await conversation.agent(CTX)
      return {
        status: running ? 'running' : 'inactive',
        ...(agent.model === undefined ? {} : { model: `${agent.model.provider}/${agent.model.modelId}` }),
      }
    } finally {
      await viewWatch.stop()
    }
  }
  /**
   * Durable evidence about one provisioned member session, for the spawn replay path and the
   * provisioning reconciliation. DSH reads the persisted child Session (`roster.ts:385-397`);
   * Pi's tool API has no session-log reader, so the same questions are answered from the
   * conversation table, the child's link document, and its initial submission record.
   */
  const memberSession = async (value: string, leadId: ConversationId, name: string): Promise<MemberSessionState> => {
    const childId = parseConversationId(value)
    const record = await harnessOf().commit((tx) => tx.conversation(childId), CTX)
    if (record === undefined) return { exists: false, linked: false, promptRejected: false, running: false }
    const link = await harnessOf().snapshot(TeamLink, childId, CTX)
    const submission = await harnessOf().commit(
      (tx) => tx.submissionByRequest(childId, `team-spawn:${String(leadId)}:${name}`), CTX)
    const conversation = await harnessOf().conversation(childId, CTX)
    let running = false
    if (conversation !== undefined) {
      const viewWatch = await conversation.watch(CTX)
      try {
        running = liveRunTaskId(viewWatch.value) !== undefined
      } finally {
        await viewWatch.stop()
      }
    }
    return {
      exists: true,
      linked: link?.leadConversationId === String(leadId) && link.name === name,
      // DSH needs the initial prompt durably accepted (`roster.ts:389-394`). Pi's inbox admission
      // (`queued`) already survives a crash and the replay resubmits under the same request ID, so
      // only an explicit rejection (`unanswered`) is terminal.
      promptRejected: submission?.status === 'unanswered',
      running,
    }
  }
  /**
   * DSH reconciles provisioning-only members when the Lead session starts (`roster.ts:175-179`).
   * Pi's equivalent start point is runtime creation: every Lead document is scanned once here.
   */
  const reconcileTeamRosters = async (): Promise<void> => {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harnessOf().commit((tx) => tx.scanConversations({ order: 'ascending' }, 250, cursor), CTX)
      records.push(...page.items)
      cursor = page.next
    } while (cursor)
    for (const record of records) {
      const doc = await harnessOf().snapshot(Team, record.id, CTX)
      if (doc === undefined || !doc.members.some(member => member.role === 'teammate' && member.phase === 'provisioning')) continue
      try {
        await reconcileProvisioning(
          { read: (id, ctx) => harnessOf().snapshot(Team, id, ctx), commit: (change, ctx) => harnessOf().commit(change, ctx) },
          { memberSession },
          record.id,
          CTX,
        )
      } catch {
        // One malformed roster must not stop the remaining teams from being reconciled.
      }
    }
  }
  /**
   * Observe each teammate's busy transitions for `wait_agent`. DSH's `TeamActivity` is notified by
   * the runtime's `agent/status` event; Pi exposes no such subscription, so the same edge is read
   * off the child conversation view (`pi.live.run` entering or leaving).
   */
  const watchTeamMembers = async (leadValue: string, onChange: () => void): Promise<() => Promise<void>> => {
    const leadId = parseConversationId(leadValue)
    const doc = await harnessOf().snapshot(Team, leadId, CTX)
    const ids = (doc?.members ?? []).flatMap(member =>
      member.role === 'teammate' && typeof member.conversationId === 'string' ? [member.conversationId] : [])
    const stops: Array<() => Promise<unknown>> = []
    for (const value of ids) {
      const conversation = await harnessOf().conversation(parseConversationId(value), CTX)
      if (conversation === undefined) continue
      const viewWatch = await conversation.watch(CTX)
      let running = liveRunTaskId(viewWatch.value) !== undefined
      viewWatch.start(async (view) => {
        const next = liveRunTaskId(view) !== undefined
        if (next === running) return
        running = next
        onChange()
      })
      stops.push(() => viewWatch.stop())
    }
    return async () => { await Promise.allSettled(stops.map(stop => stop())) }
  }
  // A task-owned child copies the owner's `pi.agent` in the creation hook, so only the runtime's
  // own metadata needs stamping: the delegation label becomes the child's title, and the child
  // works in the parent's workspace under the parent's access mode. Both subagents and teammates
  // create their child this way.
  const prepareChildConversation = async (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string): Promise<void> => {
    const metadata = await tx.doc(META, childId)
    const parent = await tx.doc(META, parentId)
    metadata.title = label
    metadata.titleSource = 'user'
    metadata.workspaceId = parent.workspaceId ?? defaultWorkspace()?.id ?? null
    metadata.presetId = parent.presetId ?? null
    metadata.accessMode = parent.accessMode ?? appState.snapshot().settings.defaultAccessMode
    await inheritPlanConstraint(tx, childId, parentId)
  }
  /** The Lead (or the Lead of a member conversation) this conversation's team record lives on. */
  const teamLeadId = async (id: ConversationId): Promise<ConversationId> => {
    const link = await harnessOf().snapshot(TeamLink, id, CTX)
    return link?.leadConversationId ? parseConversationId(link.leadConversationId) : id
  }

  /**
   * The team as `ConversationDetail.team`. Undefined until the conversation has a teammate or a
   * task, so a plain conversation pays two document reads and no member-status probe.
   */
  const teamProjection = async (id: ConversationId): Promise<TeamView | undefined> => {
    const leadId = await teamLeadId(id)
    const doc = await harnessOf().snapshot(Team, leadId, CTX)
    if (!doc) return undefined
    const hasTeammate = doc.members.some(member => member.role === 'teammate')
    const hasTask = doc.tasks.some(task => task.status !== 'deleted')
    if (!hasTeammate && !hasTask) return undefined
    return await projectTeam(doc, String(leadId), conversationInfo)
  }

  /**
   * DSH's `agentTeam` projection over the Lead document. The Lead row is synthesized even before the
   * document exists, mirroring `roster.ts:126-157`; teammates carry their child's live turn status.
   */
  const team = async (value: string): Promise<TeamView> => {
    const conversation = await requireConversation(value)
    const leadId = await teamLeadId(conversation.id)
    const doc = await harnessOf().snapshot(Team, leadId, CTX)
    return await projectTeam(doc ?? { members: [], tasks: [] }, String(leadId), conversationInfo)
  }

  /**
   * DSH's `subagentCatalog` over Pi's owner edge: the conversations this one created, each with the
   * label its delegation recorded and the child's latest answer. The catalog is durable in DSH
   * because children are sessions in the same log; here the owner edge plus the child's own
   * transcript is what survives, so the row is read instead of folded.
   */
  const subagentSummaries = async (parentId: ConversationId): Promise<SubagentSummary[]> => {
    const page = await harnessOf().commit((tx) => tx.scanConversations({ ownerConversationId: parentId }, SUBAGENT_LIMIT), CTX)
    const rows = await Promise.all(page.items.map(childSummary))
    return rows.filter((row): row is SubagentSummary => row !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  const childSummary = async (record: ConversationRecord): Promise<SubagentSummary | undefined> => {
    const conversation = await harnessOf().conversation(record.id, CTX)
    if (!conversation) return undefined
    const identity = await harnessOf().snapshot(Subagents, record.id, CTX)
    const usage = await harnessOf().snapshot(UsageDoc, record.id, CTX)
    const viewWatch = await conversation.watch(CTX)
    try {
      const detail = await detailFromView(record.id, viewWatch.value)
      const tokens = usageTokens(usage)
      const durationMs = activeDurationMs(detail.messages)
      const metricsAt = Date.now()
      return {
        id: String(record.id),
        label: identity?.record?.label ?? detail.conversation.title,
        title: detail.conversation.title,
        status: detail.conversation.busy ? 'running' : 'inactive',
        answer: latestOwnAnswer(detail.messages, SUBAGENT_ANSWER_CHARS),
        ...(tokens === undefined ? {} : { tokens }),
        ...(durationMs === undefined ? {} : { durationMs }),
        metricsAt,
        createdAt: detail.conversation.createdAt,
        updatedAt: detail.conversation.updatedAt,
      }
    } finally {
      await viewWatch.stop()
    }
  }

  const children = async (value: string): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    return subagentSummaries(parent.id)
  }

  /**
   * Resolve one direct child of `parentId`. DSH's control tools authorize by live lineage; Pi exposes
   * no such check, so ownership is enforced here: any conversation this parent did not create is a
   * NOT_FOUND rather than a control target (`docs/families.md` A7).
   */
  const requireChild = async (parentId: ConversationId, childValue: string): Promise<Awaited<ReturnType<typeof requireConversation>>> => {
    const childId = parseConversationId(childValue)
    const record = await harnessOf().commit((tx) => tx.conversation(childId), CTX)
    if (!record || record.owner?.conversationId !== parentId) throw new RuntimeError('NOT_FOUND', '子会话不存在')
    return requireConversation(childValue)
  }

  /** DSH's `send_message` for one direct child: a follow-up the child's next boundary places. */
  const childMessage = async (value: string, childValue: string, input: ChildMessageInput): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    const child = await requireChild(parent.id, childValue)
    const text = input.text.trim()
    if (text === '' || text.length > SUBAGENT_MESSAGE_CHARS) throw new RuntimeError('INVALID_INPUT', '子智能体消息无效')
    if (!input.requestId.trim() || input.requestId.length > 256) throw new RuntimeError('INVALID_INPUT', 'requestId 无效')
    await child.submit({ type: 'input', content: text, requestId: input.requestId, whenBusy: 'followUp' }, CTX)
    return subagentSummaries(parent.id)
  }

  /** DSH's `interrupt_agent` for one direct child; the child's own descendants stop with it. */
  const childStop = async (value: string, childValue: string): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    const child = await requireChild(parent.id, childValue)
    await child.abort(CTX)
    return subagentSummaries(parent.id)
  }


  return {
    conversationInfo,
    memberSession,
    watchMembers: watchTeamMembers,
    prepareChild: prepareChildConversation,
    projection: teamProjection,
    team,
    summaries: subagentSummaries,
    children,
    childMessage,
    childStop,
    reconcileRosters: reconcileTeamRosters,
  }
}
