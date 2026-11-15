/**
 * 团队花名册与子智能体目录。
 *
 * DSH 把花名册存在 Lead 会话里；pi-durable 没有这种文档，因此相同的问题改由
 * 属主边（owner edge）加每个子会话的实时视图回答。两个投影都要读会话引擎的
 * `detailFromView`，因此使用迟绑定回调。
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

/** 团队 feature 的依赖注入契约：应用状态、harness 迟绑定与核心提供的会话/投影回调。 */
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

/**
 * 功能：创建团队 feature 服务——团队花名册投影、成员状态监视、子会话准备与
 * 子智能体目录、消息与停止等控制面。
 * @param deps 依赖注入契约见 TeamDeps；detailFromView 迟绑定避免构造环
 * 职责边界：负责 Lead/成员关系与子会话目录；委派请求的产生在 subagent/team 工具层。
 */
export function createTeam(deps: TeamDeps) {
  const { appState, harness: harnessOf, requireConversation, currentDetail, detailFromView, defaultWorkspace } = deps

  /**
   * 功能：读取一个会话的实时轮次状态与模型。
   * @param value 会话 ID 字符串
   * @returns running/inactive 状态与模型引用字符串；会话不存在返回 inactive
   * 内部逻辑：`pi.live.run` 与子智能体目录用的 busy 是同一信号，因此这里
   * 的 `inactive` 恰好等于「当前没有轮次在执行」。
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
   * 功能：读取一个已创建成员会话的持久证据，供 spawn 重放路径与创建对账使用。
   * @param value 子会话 ID 字符串
   * @param leadId Lead 会话 ID
   * @param name 成员名
   * @returns 存在性、绑定关系、初始提示是否被拒与运行状态
   * 内部逻辑：DSH 读取持久化的子 Session（roster.ts:385-397）；Pi 的工具 API 没有
   * 会话日志读取器，因此从会话表、子会话的链接文档与初始提交记录回答同样的
   * 问题。收件箱的 `queued` 已可跨崩溃存活且重放复用同一请求 ID，只有显式
   * 拒绝（unanswered）才是终态。
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
      // DSH 要求初始提示被持久接受（roster.ts:389-394）。Pi 的收件箱准入（queued）
      // 本身已可跨崩溃存活，重放复用同一请求 ID 重提，因此只有显式拒绝
      // （unanswered）才是终态。
      promptRejected: submission?.status === 'unanswered',
      running,
    }
  }
  /**
   * 功能：启动时对账各 Lead 的创建中成员。
   * @returns 无返回；单个花名册畸形静默跳过
   * 内部逻辑：DSH 在 Lead 会话启动时对账创建中成员（roster.ts:175-179）；Pi 的
   * 等价时机是运行时创建：这里一次性扫描全部 Lead 文档，对含 provisioning
   * 成员的调用 reconcileProvisioning。
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
        // 一份畸形花名册不得阻止其余团队继续对账。
      }
    }
  }
  /**
   * 功能：为 `wait_agent` 监视各成员的忙碌状态跳变。
   * @param leadValue Lead 会话 ID 字符串
   * @param onChange 任一成员忙碌状态变化时回调
   * @returns 停止监视函数（并行关闭全部 watch，失败吞掉）
   * 内部逻辑：DSH 的 `TeamActivity` 由运行时 `agent/status` 事件通知；Pi 没有这种
   * 订阅，因此从子会话视图读取同一条边（`pi.live.run` 进入或离开）。
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
  // 任务属主的子会话在创建钩子里复制属主的 `pi.agent`，因此这里只需补运行时自己的
  // 元数据：委派标签成为子会话标题，子会话在父会话的工作区里按父会话的访问模式工作。
  // subagent 与 teammate 都以这种方式创建子会话。
  const prepareChildConversation = async (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string): Promise<void> => {
    const metadata = await tx.doc(META, childId)
    const parent = await tx.doc(META, parentId)
    metadata.title = label
    metadata.titleSource = 'user'
    metadata.workspaceId = parent.workspaceId ?? defaultWorkspace()?.id ?? null
    metadata.accessMode = parent.accessMode ?? appState.snapshot().settings.defaultAccessMode
    await inheritPlanConstraint(tx, childId, parentId)
  }
  /** 本会话的团队记录所在的 Lead（成员会话经链接解析到 Lead，Lead 自身返回自身）。 */
  const teamLeadId = async (id: ConversationId): Promise<ConversationId> => {
    const link = await harnessOf().snapshot(TeamLink, id, CTX)
    return link?.leadConversationId ? parseConversationId(link.leadConversationId) : id
  }

  /**
   * 功能：投影出 `ConversationDetail.team` 所需的团队视图。
   * @param id 会话 ID（成员会话自动解析到其 Lead）
   * @returns 团队视图；会话还没有队友或任务时返回 undefined
   * 内部逻辑：普通会话只花两次文档读取，不做成员状态探测，开销有界。
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
   * 功能：完整团队投影（对齐 DSH 的 `agentTeam`）。
   * @param value Lead（或成员）会话 ID 字符串
   * @returns 团队视图，Lead 行在文档尚不存在时也会合成，镜像 roster.ts:126-157
   */
  const team = async (value: string): Promise<TeamView> => {
    const conversation = await requireConversation(value)
    const leadId = await teamLeadId(conversation.id)
    const doc = await harnessOf().snapshot(Team, leadId, CTX)
    return await projectTeam(doc ?? { members: [], tasks: [] }, String(leadId), conversationInfo)
  }

  /**
   * 功能：子智能体目录（对齐 DSH 的 `subagentCatalog`），基于 Pi 的属主边。
   * @param parentId 父会话 ID
   * @returns 该会话创建的子会话摘要，按创建时间与 ID 排序
   * 内部逻辑：DSH 中目录是持久的，因为子会话是同一日志里的 Session；这里存活
   * 的是属主边加子会话自身的记录，因此每行直接读取而非折叠。
   */
  const subagentSummaries = async (parentId: ConversationId): Promise<SubagentSummary[]> => {
    const page = await harnessOf().commit((tx) => tx.scanConversations({ ownerConversationId: parentId }, SUBAGENT_LIMIT), CTX)
    const rows = await Promise.all(page.items.map(childSummary))
    return rows.filter((row): row is SubagentSummary => row !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  /** 组装一个子会话的目录行：标签、状态、最新答案、token 与耗时等指标。 */
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
        // `provider/modelId`——与团队花名册里成员模型相同的字符串。
        ...(detail.conversation.model === undefined ? {} : {
          model: `${detail.conversation.model.provider}/${detail.conversation.model.modelId}`,
        }),
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

  /** 按父会话 ID 列出其子智能体目录。 */
  const children = async (value: string): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    return subagentSummaries(parent.id)
  }

  /**
   * 功能：解析 parentId 的一个直属子会话并校验属主关系。
   * @param parentId 父会话 ID
   * @param childValue 子会话 ID 字符串
   * @returns 子会话句柄
   * 内部逻辑：DSH 的控制工具按实时谱系授权；Pi 没有这种检查，属主关系在这里
   * 强制：父会话没有创建过的会话一律 NOT_FOUND，而不是控制目标
   * （docs/history/families.md A7）。
   */
  const requireChild = async (parentId: ConversationId, childValue: string): Promise<Awaited<ReturnType<typeof requireConversation>>> => {
    const childId = parseConversationId(childValue)
    const record = await harnessOf().commit((tx) => tx.conversation(childId), CTX)
    if (!record || record.owner?.conversationId !== parentId) throw new RuntimeError('NOT_FOUND', '子会话不存在')
    return requireConversation(childValue)
  }

  /** 对一个直属子会话执行 DSH 的 `send_message`：子会话在下一边界放置的 follow-up 消息。 */
  const childMessage = async (value: string, childValue: string, input: ChildMessageInput): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    const child = await requireChild(parent.id, childValue)
    const text = input.text.trim()
    if (text === '' || text.length > SUBAGENT_MESSAGE_CHARS) throw new RuntimeError('INVALID_INPUT', '子智能体消息无效')
    if (!input.requestId.trim() || input.requestId.length > 256) throw new RuntimeError('INVALID_INPUT', 'requestId 无效')
    await child.submit({ type: 'input', content: text, requestId: input.requestId, whenBusy: 'followUp' }, CTX)
    return subagentSummaries(parent.id)
  }

  /** 对一个直属子会话执行 DSH 的 `interrupt_agent`；子会话自己的后代随之停止。 */
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
