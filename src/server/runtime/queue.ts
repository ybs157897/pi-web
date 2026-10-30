/**
 * Queue edits and withdrawals.
 *
 * Editing a queued message aborts the original submission and submits a replacement
 * under a derived request id, so a retry after a restart never duplicates it. The
 * per-submission lock keeps concurrent edits of the same row ordered.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import type { Draft } from '@earendil-works/chord'
import type { Conversation, ConversationId, ConversationRecord, Cursor, Harness, SubmissionId } from '@earendil-works/pi-durable'
import type { EditQueueInput, SubmitInput, WorkspaceSummary } from '../../shared/types.ts'
import type { AttachmentReference, WorkspaceFiles } from '../workspace/files.ts'
import { RuntimeError } from '../runtime-errors.ts'
import {
  CTX, type ConversationMetadata, type QueueContent, assertSubmit, canonicalSubmit, objectValue,
  parseSubmissionId, queueContent,
} from './helpers.ts'

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

export function createQueue(deps: QueueDeps) {
  const { requireConversation, ensureMetadata, withMetadata, submitWithReferences, workspaceFiles, defaultWorkspace } = deps
  const harness = (): Harness => deps.harness()

  const queueActionLocks = new Map<string, Promise<void>>()
  const withQueueActionLock = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = queueActionLocks.get(key) ?? Promise.resolve()
    const result = previous.then(action, action)
    const settled = result.then(() => undefined, () => undefined)
    queueActionLocks.set(key, settled)
    try { return await result } finally {
      if (queueActionLocks.get(key) === settled) queueActionLocks.delete(key)
    }
  }
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

  const recoverQueueEdits = async (): Promise<void> => {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness().commit((tx) => tx.scanConversations({ order: 'ascending' }, 250, cursor), CTX)
      records.push(...page.items.filter(record => record.owner === undefined))
      cursor = page.next
    } while (cursor)
    for (const record of records) {
      const metadata = await ensureMetadata(record.id)
      const pending = Object.entries(metadata.queueEdits).filter(([, edit]) => edit.status === 'pending' || edit.status === 'aborting' || edit.status === 'aborted')
      if (!pending.length) continue
      const conversation = await harness().conversation(record.id, CTX)
      if (!conversation) continue
      for (const [requestId] of pending) {
        try { await finishQueueEdit(conversation, requestId) } catch (error) {
          if (error instanceof RuntimeError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) continue
          throw error
        }
      }
    }
  }


  return { editQueued, removeQueued, recover: recoverQueueEdits }
}
