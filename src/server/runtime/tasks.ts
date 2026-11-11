/**
 * 单入口的任务面：一个 `main` 会话加上它派生的 task 会话。
 *
 * task 就是打了 `pi-web.conversation-kind` 标签的 ownerless 会话：创建复用会话引擎
 * （工作区校验、agent 配置、metadata 写入、提交落位与 requestId 幂等），列表复用同一份
 * `ConversationDetail` 投影，状态只是从投影读出的派生值。
 */
import type { ConversationId, ConversationRecord, Cursor, Harness } from '@earendil-works/pi-durable'
import type {
  ChatMessage, ConversationDetail, ConversationSummary, CreateConversationInput, CreateTaskInput, SubmitInput, TaskStatus, TaskSummary,
} from '../../shared/types.ts'
import { CONVERSATION_KIND, CTX, parseConversationId, TASK, TASK_INBOX, type ConversationMetadata } from './helpers.ts'

/** 主会话收件箱保留的结算条数上限，unshift 后截断。 */
const TASK_INBOX_LIMIT = 50

export interface TasksDeps {
  harness: () => Harness
  assertOpen(): void
  ensureMetadata(id: ConversationId): Promise<Readonly<ConversationMetadata>>
  create(input: CreateConversationInput): Promise<ConversationDetail>
  submit(value: string, input: SubmitInput): Promise<{ submissionId: string }>
  currentDetail(id: ConversationId): Promise<ConversationDetail>
}

/**
 * 任务行状态的投影，判定顺序即优先级：待回答的问题 > 运行中 > 有排队输入 > 终态 > 空闲。
 * 纯函数：状态语义可以脱离 runtime 单测。
 */
export function taskStatusOf(detail: ConversationDetail): TaskStatus {
  if (detail.interactions?.some(interaction => interaction.status === 'pending')) return 'waiting'
  const conversation = detail.conversation
  if (conversation.busy) return 'running'
  if (detail.queue.length > 0) return 'queued'
  if (conversation.status === 'error') return 'failed'
  if (conversation.status === 'cancelled') return 'cancelled'
  if (conversation.status === 'completed') return 'completed'
  return 'idle'
}

/** 最后一条 assistant 消息的文本块压成单行，作为列表行的预览。 */
function previewOf(messages: readonly ChatMessage[]): string | undefined {
  const latest = [...messages].reverse().find(message => message.role === 'assistant')
  if (latest === undefined) return undefined
  const text = latest.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed === '' ? undefined : collapsed.slice(0, 120)
}

/** 任务为什么需要人：待答问题、失败原因或停止说明，压成单行供列表副标题。 */
function attentionOf(detail: ConversationDetail): string | undefined {
  const status = taskStatusOf(detail)
  let text: string | undefined
  if (status === 'waiting') {
    const pending = detail.interactions?.find(interaction => interaction.status === 'pending')
    text = pending?.questions?.[0]?.question ?? pending?.detail ?? '等待回答'
  } else if (status === 'failed') {
    text = detail.error ?? '执行失败'
  } else if (status === 'cancelled') {
    text = '已停止'
  }
  if (text === undefined) return undefined
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed === '' ? undefined : collapsed.slice(0, 80)
}

function summaryOf(detail: ConversationDetail): TaskSummary {
  const conversation: ConversationSummary = detail.conversation
  const preview = previewOf(detail.messages)
  const attention = attentionOf(detail)
  return {
    id: conversation.id,
    title: conversation.title,
    status: taskStatusOf(detail),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.model === undefined ? {} : { model: conversation.model }),
    thinkingLevel: conversation.thinkingLevel,
    cwd: conversation.cwd,
    ...(conversation.workspaceId === undefined ? {} : { workspaceId: conversation.workspaceId }),
    busy: conversation.busy,
    ...(conversation.unread === true ? { unread: true } : {}),
    ...(conversation.runStartedAt === undefined ? {} : { runStartedAt: conversation.runStartedAt }),
    ...(conversation.durationMs === undefined ? {} : { durationMs: conversation.durationMs }),
    ...(preview === undefined ? {} : { preview }),
    ...(attention === undefined ? {} : { attention }),
    turns: detail.messages.filter(message => message.role === 'user').length,
  }
}

export function createTasks(deps: TasksDeps) {
  const harness = (): Harness => deps.harness()
  /** 一次 runtime 生命周期内入口会话不变，解析一次后缓存；并发调用共享同一次扫描。 */
  let mainId: string | undefined
  let pendingMain: Promise<string> | undefined

  /** 所有 ownerless 会话，降序分页取全量（与 conversations.list 同一条扫描路径）。 */
  const ownerless = async (): Promise<ConversationRecord[]> => {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness().commit(tx => tx.scanConversations({ order: 'descending' }, 250, cursor), CTX)
      records.push(...page.items.filter(record => record.owner === undefined))
      cursor = page.next
    } while (cursor)
    return records
  }

  /**
   * 单入口的座位：一个打了 `main` 标签的 ownerless 会话，本身不承载工作，task 通过
   * `parentId` 指向它。零工作区也能建，因为它从不跑回合。
   */
  const ensureMain = async (): Promise<string> => {
    if (mainId !== undefined) return mainId
    if (pendingMain !== undefined) return pendingMain
    pendingMain = (async () => {
      for (const record of await ownerless()) {
        const kind = await harness().snapshot(CONVERSATION_KIND, record.id, CTX)
        if (kind?.kind === 'main') return String(record.id)
      }
      const conversation = await harness().createConversation({ ownership: { kind: 'ownerless' } }, CTX)
      await harness().commit(async tx => {
        const kind = await tx.doc(CONVERSATION_KIND, conversation.id)
        kind.kind = 'main'
      }, CTX)
      await deps.ensureMetadata(conversation.id)
      return String(conversation.id)
    })()
    try {
      mainId = await pendingMain
      return mainId
    } finally {
      pendingMain = undefined
    }
  }

  const createTask = async (input: CreateTaskInput): Promise<ConversationDetail> => {
    deps.assertOpen()
    const parentId = await ensureMain()
    const created = await deps.create({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
    })
    const id = parseConversationId(created.conversation.id)
    await harness().commit(async tx => {
      const kind = await tx.doc(CONVERSATION_KIND, id)
      kind.kind = 'task'
      kind.parentId = parentId
      // 独立记录与 kind 标签同 commit 落位：提交失败留下的孤儿也能被 reconcile 认出。
      const task = await tx.doc(TASK, id)
      task.originRequestId = input.requestId
      task.attempt = 1
    }, CTX)
    // 首条消息沿用提交路径：附件保存、requestId 幂等与标题回退都在那里。
    await deps.submit(created.conversation.id, input)
    return deps.currentDetail(id)
  }

  /**
   * 终态任务的一次性结算：写 TASK 的 settledAt/settlement，并向主会话收件箱 unshift 一条。
   * 幂等——已结算（settledAt 已置）直接返回；commit 内再查一次，挡住并发读路径的重复追加。
   * 独立 commit，调用方（list/reconcile）不得把它包进自己的扫描 commit。
   */
  const settle = async (id: ConversationId, detail: ConversationDetail): Promise<void> => {
    const status = taskStatusOf(detail)
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return
    if ((await harness().snapshot(TASK, id, CTX))?.settledAt !== undefined) return
    const now = Date.now()
    const summary = previewOf(detail.messages)
    const main = parseConversationId(await ensureMain())
    await harness().commit(async tx => {
      const task = await tx.doc(TASK, id)
      if (task.settledAt !== undefined) return
      task.settledAt = now
      task.settlement = { status, ...(summary === undefined ? {} : { summary }), at: now }
      const inbox = await tx.doc(TASK_INBOX, main)
      inbox.items.unshift({ taskId: String(id), title: detail.conversation.title, status, ...(summary === undefined ? {} : { summary }), at: now })
      inbox.items = inbox.items.slice(0, TASK_INBOX_LIMIT)
    }, CTX)
  }

  const list = async (): Promise<TaskSummary[]> => {
    deps.assertOpen()
    const records = await ownerless()
    const kinds = await Promise.all(records.map(record => harness().snapshot(CONVERSATION_KIND, record.id, CTX)))
    const tasks = records.filter((record, index) => kinds[index]?.kind === 'task')
    const details = await Promise.all(tasks.map(record => deps.currentDetail(record.id)))
    // 读路径补结算：终态任务在投影后逐个 settle（各自独立 commit），幂等所以重复 list 不追加。
    for (let index = 0; index < tasks.length; index += 1) await settle(tasks[index].id, details[index])
    return details.map(summaryOf)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
  }

  /**
   * 启动扫描：把崩溃/提交失败留下的任务记录补齐。无 user 消息的是 createTask 提交首条消息失败
   * 留下的孤儿，直接标 failed 结算（不删会话）；其余终态走 settle。非终态不动，已结算的跳过。
   */
  const reconcile = async (): Promise<void> => {
    for (const record of await ownerless()) {
      if ((await harness().snapshot(CONVERSATION_KIND, record.id, CTX))?.kind !== 'task') continue
      const detail = await deps.currentDetail(record.id)
      if (!detail.messages.some(message => message.role === 'user')) {
        if ((await harness().snapshot(TASK, record.id, CTX))?.settledAt !== undefined) continue
        const now = Date.now()
        await harness().commit(async tx => {
          const task = await tx.doc(TASK, record.id)
          if (task.settledAt !== undefined) return
          task.settledAt = now
          task.settlement = { status: 'failed', summary: '创建后未提交首条消息', at: now }
        }, CTX)
        continue
      }
      await settle(record.id, detail)
    }
  }

  return { createTask, list, ensureMain, reconcile }
}
