/**
 * 排队消息的编辑与撤回。
 *
 * 编辑排队消息会先中止原提交，再以派生的 request id 提交替换消息，因此重启后的
 * 重试不会造成重复。按提交 ID 的行级锁保证对同一行的并发编辑有序执行。
 */
import { createHash } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { Draft } from '@earendil-works/chord'
import type { Conversation, ConversationId, ConversationRecord, Cursor, Harness, SubmissionId } from '@earendil-works/pi-durable'
import type { EditQueueInput, SubmitInput, WorkspaceSummary } from '../../shared/types.ts'
import type { AttachmentReference, WorkspaceFiles } from '../workspace/files.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { isCorruptConversationError } from './corrupt-conversation.ts'
import {
  CTX, type ConversationMetadata, type QueueContent, assertSubmit, canonicalSubmit, objectValue,
  parseSubmissionId, queueContent,
} from './helpers.ts'

/** 队列 feature 的依赖注入契约：harness 惰性获取，提交逻辑复用会话 feature 的入口。 */
export interface QueueDeps {
  harness: () => Harness
  requireConversation(value: string): Promise<Conversation>
  ensureMetadata(id: ConversationId): Promise<Readonly<ConversationMetadata>>
  withMetadata(id: ConversationId, update: (metadata: Draft<ConversationMetadata>) => void): Promise<void>
  submitWithReferences(
    conversation: Conversation,
    input: SubmitInput,
    files: readonly AttachmentReference[],
    requestId?: string,
    fingerprint?: string,
  ): Promise<{ submissionId: string }>
  workspaceFiles: WorkspaceFiles
  defaultWorkspace(): WorkspaceSummary | undefined
}

/**
 * 功能：创建队列 feature 服务，负责排队消息的编辑、撤回与启动时的编辑恢复。
 * @param deps 依赖注入契约见 QueueDeps；换提交复用 submitWithReferences 保证幂等
 * 职责边界：只处理排队的输入提交；已进入运行的消息通过 CONFLICT 拒绝编辑/撤回。
 */
export function createQueue(deps: QueueDeps) {
  const { requireConversation, ensureMetadata, withMetadata, submitWithReferences, workspaceFiles, defaultWorkspace } = deps
  const harness = (): Harness => deps.harness()

  /** 按 key 串行的行级锁集合；key 为 `会话ID:提交ID`，锁在无等待者时自清理。 */
  const queueActionLocks = new Map<string, Promise<void>>()
  /**
   * 功能：把 action 串行挂到同一 key 的已有 promise 链上。
   * @param key 锁标识（会话+提交）
   * @param action 要串行执行的异步操作
   * @returns action 的结果；失败不破坏链条
   * 内部逻辑：新请求排在前一个完成后执行（无论成败），队列存的是吞掉结果的
   * settled promise；若当前 key 已无后继等待则删除条目，避免 Map 无限增长。
   */
  const withQueueActionLock = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = queueActionLocks.get(key) ?? Promise.resolve()
    const result = previous.then(action, action)
    const settled = result.then(() => undefined, () => undefined)
    queueActionLocks.set(key, settled)
    try { return await result } finally {
      if (queueActionLocks.get(key) === settled) queueActionLocks.delete(key)
    }
  }
  /** 从会话收件箱读取一条排队消息的文本/图片/附件内容；非排队输入返回 undefined。 */
  const queuedContentFor = async (conversation: Awaited<ReturnType<typeof requireConversation>>, submissionId: SubmissionId): Promise<QueueContent | undefined> => {
    const view = await conversation.watch(CTX)
    try {
      const inbox = objectValue(view.value.docs['pi.inbox'])
      const items = Array.isArray(inbox?.items) ? inbox.items : []
      const item = items.map(objectValue).find(candidate => candidate?.id === Number(submissionId))
      if (!item || (item.mode !== 'steer' && item.mode !== 'followUp')) return undefined
      return queueContent(item.content, item.entry)
    } finally {
      await view.stop()
    }
  }

  /**
   * 功能：推进一条排队编辑的状态机直至提交替换消息。
   * @param conversation 目标会话
   * @param requestId 编辑请求 ID（queueEdits 文档的键）
   * @returns 替换提交的 ID
   * 内部逻辑：complete 状态幂等返回；conflict 拒绝。pending/aborting 时先中止
   * 原排队提交——已进入运行（already_placed）或状态漂移都标记 conflict；成功
   * 中止后以 `queue-edit:<requestId>` 提交替换消息并写入 complete 与替换提交 ID，
   * 同时清掉原提交的排队时间戳。该方法由 editQueued 与重启恢复共用。
   */
  const finishQueueEdit = async (conversation: Awaited<ReturnType<typeof requireConversation>>, requestId: string): Promise<{ submissionId: string }> => {
    const id = conversation.id
    const metadata = await ensureMetadata(id)
    const edit = metadata.queueEdits[requestId]
    if (!edit) throw new RuntimeError('NOT_FOUND', '排队编辑记录不存在')
    if (edit.status === 'complete' && edit.submissionId !== null) return { submissionId: String(edit.submissionId) }
    if (edit.status === 'conflict') throw new RuntimeError('CONFLICT', '排队消息已进入当前运行，编辑未提交')

    const sourceId = edit.sourceSubmissionId as SubmissionId
    const source = await harness().submission(sourceId, CTX)
    if (!source) {
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
      throw new RuntimeError('NOT_FOUND', '排队消息不存在')
    }
    const sourceRecord = await source.status(CTX)
    if (sourceRecord.conversationId !== id || sourceRecord.type !== 'input') throw new RuntimeError('NOT_FOUND', '排队消息不存在')
    if (sourceRecord.status === 'queued') {
      await withMetadata(id, (draft) => {
        const current = draft.queueEdits[requestId]
        if (current && current.status !== 'complete' && current.status !== 'conflict') current.status = 'aborting'
      })
      const result = await harness().abortSubmission(sourceId, CTX, id)
      if (result === 'already_placed') {
        await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
        throw new RuntimeError('CONFLICT', '消息已进入当前运行，无法编辑')
      }
      if (result === 'not_found' || result === 'settled') {
        const settled = await source.status(CTX)
        if (settled.status !== 'unanswered' || settled.reason !== 'aborted') {
          await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
          throw new RuntimeError('CONFLICT', '排队消息状态已改变，编辑未提交')
        }
      }
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'aborted' })
    } else if (sourceRecord.status === 'unanswered' && sourceRecord.reason === 'aborted' && edit.status === 'aborting') {
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'aborted' })
    } else if (edit.status !== 'aborted' || sourceRecord.status !== 'unanswered' || sourceRecord.reason !== 'aborted') {
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
      throw new RuntimeError('CONFLICT', '排队消息状态已改变，编辑未提交')
    }

    const currentMetadata = await ensureMetadata(id)
    const stored = currentMetadata.queueEdits[requestId]
    if (!stored) throw new RuntimeError('CONFLICT', '排队编辑状态丢失')
    const input: SubmitInput = {
      requestId,
      text: stored.input.text,
      whenBusy: stored.input.whenBusy,
      images: stored.input.images,
    }
    const replacement = await submitWithReferences(conversation, input, stored.input.files, `queue-edit:${requestId}`, stored.fingerprint)
    await withMetadata(id, (draft) => {
      const current = draft.queueEdits[requestId]
      current.status = 'complete'
      current.submissionId = Number(replacement.submissionId)
      delete draft.queueCreatedAt[String(sourceId)]
    })
    return replacement
  }

  /**
   * 功能：编辑一条排队消息，必要时保存新附件，然后推进状态机提交替换消息。
   * @param value 会话 ID 字符串
   * @param submissionValue 原排队提交 ID 字符串
   * @param input 新文本、忙碌策略、图片与可选附件
   * @returns 替换提交的 ID
   * 内部逻辑：整个流程在 `会话:提交` 行级锁内执行。同一 requestId 的重试要求
   * 来源提交与内容指纹一致（否则 CONFLICT）；首次编辑校验原消息仍在排队、
   * 保存附件、写 pending 记录后进入 finishQueueEdit。
   */
  const editQueued = async (value: string, submissionValue: string, input: EditQueueInput): Promise<{ submissionId: string }> => {
    assertSubmit(input)
    const conversation = await requireConversation(value)
    const sourceId = parseSubmissionId(submissionValue)
    const lockKey = `${conversation.id}:${sourceId}`
    return withQueueActionLock(lockKey, async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify({ sourceId, payload: canonicalSubmit(input) })).digest('hex')
      const currentMetadata = await ensureMetadata(conversation.id)
      const existing = currentMetadata.queueEdits[input.requestId]
      if (existing) {
        if (existing.sourceSubmissionId !== Number(sourceId) || existing.fingerprint !== fingerprint) {
          throw new RuntimeError('CONFLICT', '同一个 requestId 不能用于不同的排队编辑')
        }
        return finishQueueEdit(conversation, input.requestId)
      }
      const source = await harness().submission(sourceId, CTX)
      if (!source) throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      const sourceRecord = await source.status(CTX)
      if (sourceRecord.conversationId !== conversation.id || sourceRecord.type !== 'input' || sourceRecord.status !== 'queued') {
        throw new RuntimeError('CONFLICT', '消息已不在排队中，编辑未提交')
      }
      const current = await queuedContentFor(conversation, sourceId)
      if (!current) throw new RuntimeError('CONFLICT', '无法读取排队消息内容')
      let files = current.files
      if (input.files !== undefined) {
        if (input.files.length > 0) {
          const attachmentWorkspaceId = currentMetadata.workspaceId ?? defaultWorkspace()?.id
          if (attachmentWorkspaceId === undefined) throw new RuntimeError('INVALID_INPUT', '此会话没有可用的工作区，无法保存附件')
          files = await workspaceFiles.saveAttachments(attachmentWorkspaceId, String(conversation.id), `queue-edit-${input.requestId}`, input.files)
        } else {
          files = []
        }
      }
      const effective = {
        text: input.text,
        whenBusy: input.whenBusy,
        images: input.images ?? current.images,
        files,
      }
      await withMetadata(conversation.id, (draft) => {
        draft.queueEdits[input.requestId] = {
          fingerprint,
          sourceSubmissionId: Number(sourceId),
          input: effective,
          status: 'pending',
          submissionId: null,
        }
      })
      return finishQueueEdit(conversation, input.requestId)
    })
  }

  /**
   * 功能：撤回一条排队消息（中止原提交并清理其排队时间戳）。
   * @param value 会话 ID 字符串
   * @param submissionValue 排队提交 ID 字符串
   * @returns 无返回；已进入运行或状态漂移时抛 CONFLICT/NOT_FOUND
   * 内部逻辑：在行级锁内校验提交归属与排队状态后调用 abortSubmission；
   * already_placed 视为冲突，not_found/settled 视为不存在。
   */
  const removeQueued = async (value: string, submissionValue: string): Promise<void> => {
    const conversation = await requireConversation(value)
    const submissionId = parseSubmissionId(submissionValue)
    return withQueueActionLock(`${conversation.id}:${submissionId}`, async () => {
      const submission = await harness().submission(submissionId, CTX)
      if (!submission) throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      const record = await submission.status(CTX)
      if (record.conversationId !== conversation.id || record.type !== 'input' || record.status !== 'queued') {
        throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      }
      const result = await harness().abortSubmission(submissionId, CTX, conversation.id)
      if (result === 'already_placed') throw new RuntimeError('CONFLICT', '消息已进入当前运行，无法撤回')
      if (result === 'not_found' || result === 'settled') throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      await withMetadata(conversation.id, (metadata) => { delete metadata.queueCreatedAt[String(submissionId)] })
    })
  }

  /**
   * 功能：启动恢复——扫描全部无主会话，续推未完成的排队编辑状态机。
   * @returns 无返回；单条编辑的 CONFLICT/NOT_FOUND 视为该行已终态，跳过继续
   * 内部逻辑：分页扫描会话记录，对 queueEdits 里 pending/aborting/aborted 状态
   * 的条目逐条调用 finishQueueEdit；崩溃前已提交替换或已漂移的编辑由此收敛。
   */
  const recoverQueueEdits = async (): Promise<void> => {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness().commit((tx) => tx.scanConversations({ order: 'ascending' }, 250, cursor), CTX)
      records.push(...page.items.filter(record => record.owner === undefined))
      cursor = page.next
    } while (cursor)
    for (const record of records) {
      try {
        const metadata = await ensureMetadata(record.id)
        const pending = Object.entries(metadata.queueEdits).filter(([, edit]) => edit.status === 'pending' || edit.status === 'aborting' || edit.status === 'aborted')
        if (!pending.length) continue
        const conversation = await harness().conversation(record.id, CTX)
        if (!conversation) continue
        for (const [requestId] of pending) {
          try { await finishQueueEdit(conversation, requestId) } catch (error) {
            if (error instanceof RuntimeError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) continue
            if (isCorruptConversationError(error)) break
            throw error
          }
        }
      } catch (error) {
        // 一条无法重放的会话不得阻止其余会话的排队编辑恢复。
        if (!isCorruptConversationError(error)) throw error
      }
    }
  }


  return { editQueued, removeQueued, recover: recoverQueueEdits }
}
