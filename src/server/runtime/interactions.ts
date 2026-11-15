/**
 * 回答或放弃一次运行正在等待的人机交互请求。
 *
 * 回复消息先于存储的交互请求落定而提交，因此提交被拒时该请求仍可回答；
 * 重启后的重试复用由 call 派生的 request id。
 */
import { createHash } from 'node:crypto'
import type { Conversation, ConversationId, Harness, InputSubmissionDraft } from '@earendil-works/pi-durable'
import type { AskUserQuestionAnswerItem, ConversationDetail } from '../../shared/types.ts'
import { validateAnswers } from '../conversation/interactions.ts'
import { Plans, decidePlanReview, interactionTable, planReviewOf, type StoredPlanReview } from '../tools/plan.ts'
import { Interactions } from '../tools/interaction.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { CTX, META } from './helpers.ts'

/** 交互回复 feature 的依赖注入契约：会话句柄获取、会话校验、详情读取与模型策略。 */
export interface InteractionsDeps {
  harness: () => Harness
  requireConversation(value: string): Promise<Conversation>
  currentDetail(id: ConversationId): Promise<ConversationDetail>
  assertConversationModelAllowed(conversation: Conversation): Promise<void>
}

/**
 * 功能：创建交互回复 feature 服务——回答/放弃 ask_user_question 与计划审阅。
 * @param deps 依赖注入契约见 InteractionsDeps
 * 职责边界：只负责交互的答复侧；交互请求的产生在工具层。回复先提交再落定存储，
 * 保证提交被拒时请求仍可重试回答。
 */
export function createInteractionReplies(deps: InteractionsDeps) {
  const { requireConversation, currentDetail, assertConversationModelAllowed } = deps
  const harness = (): Harness => deps.harness()

  /**
   * 功能：提交一条回复消息，并记下与手打消息相同的请求回执。
   * @param conversation 目标会话
   * @param requestId 幂等请求 ID（由 call 派生）
   * @param content 回复 JSON 文本
   * @param entry 随消息附带的 entry 数据
   * @returns 无返回；已有已接受回执时幂等返回
   * 内部逻辑：回执是实时投影把流式消息归到与落定条目相同 run id（runIdForLive）
   * 的依据，没有它回答会被当成第二条运行；entry 同时携带 requestId，让持久层
   * 按请求而不是按行号计算 id。
   */
  const submitReply = async (
    conversation: Conversation,
    requestId: string,
    content: string,
    entry: InputSubmissionDraft['entry'],
  ): Promise<void> => {
    const existing = await harness().snapshot(META, conversation.id, CTX)
    const receipt = existing?.requestReceipts[requestId]
    if (receipt?.submissionId !== null && receipt?.submissionId !== undefined) return
    const request = await conversation.submit({
      type: 'input',
      content,
      requestId,
      ...(entry === undefined ? {} : { entry }),
      whenBusy: 'steer',
    }, CTX)
    const status = await request.status(CTX)
    await harness().commit(async (tx) => {
      const metadata = await tx.doc(META, conversation.id)
      metadata.requestReceipts[requestId] = {
        fingerprint: createHash('sha256').update(content).digest('hex'),
        status: 'accepted',
        submissionId: Number(request.id),
      }
      if (status.status === 'queued') metadata.queueCreatedAt[String(request.id)] = Date.now()
      metadata.updatedAt = Date.now()
    }, CTX)
  }


  /**
   * 功能：回答一次计划审阅（批准或要求修改）。
   * @param conversation 目标会话
   * @param callId 交互请求 ID
   * @param review 存储的计划审阅
   * @param answers 用户的选择（含自定义补充）
   * @returns 回答后的会话详情
   * 内部逻辑：非 pending 的审阅已落定，幂等返回；先校验会话模型可用，再由
   * decidePlanReview 计算决定。批准且会话为只读时按只读措辞收尾。回复以
   * `plan-review-reply:<callId>` 提交（重启重试幂等），随后把审阅标为 answered，
   * 批准时一并关闭计划模式。
   */
  const answerPlanReview = async (
    conversation: Awaited<ReturnType<typeof requireConversation>>,
    callId: string,
    review: StoredPlanReview,
    answers: AskUserQuestionAnswerItem[],
  ): Promise<ConversationDetail> => {
    const id = conversation.id
    // 被替换或已回答的审阅已经落定：没有东西在等待，计划模式保持原状。
    if (review.status !== 'pending') return currentDetail(id)
    await assertConversationModelAllowed(conversation)
    const decision = decidePlanReview(review, answers)
    const metadata = await harness().snapshot(META, id, CTX)
    const settledAnswers = answers.map(answer => ({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    }))
    const reply = {
      kind: 'answer_to_pending_question',
      callId,
      interactionKind: 'plan-review',
      approveLabel: review.approveLabel,
      approved: decision.approved,
      ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
      answers: settledAnswers,
      instruction: decision.approved
        ? metadata?.accessMode === 'readOnly'
          ? '用户已批准计划，计划模式已关闭。当前会话仍为只读：不要实施改动；请说明执行需要写入权限。'
          : '用户已批准计划，计划模式已关闭：在本轮按当前访问权限执行获批计划；多步工作先调用 todo_write。'
        : '用户要求修改，计划模式仍开启：修订计划，再用 exit_plan_mode 提交。',
    }
    const requestId = `plan-review-reply:${callId}`
    await submitReply(conversation, requestId, JSON.stringify(reply), {
      kind: 'pi-web.plan-review-reply',
      data: {
        requestId,
        callId,
        approved: decision.approved,
        answers: settledAnswers,
        ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
      },
    })
    await harness().commit(async (tx) => {
      const table = interactionTable(await tx.doc(Interactions, id))
      const stored = planReviewOf(table[callId])
      if (!stored || stored.status !== 'pending') return
      stored.status = 'answered'
      stored.approved = decision.approved
      stored.answers = settledAnswers
      stored.answeredAt = Date.now()
      if (decision.feedback !== undefined) stored.feedback = decision.feedback
      if (!decision.approved) return
      const plan = await tx.doc(Plans, id)
      plan.active = false
      plan.updatedAt = Date.now()
    }, CTX)
    return currentDetail(id)
  }

  /**
   * 功能：关闭一次计划审阅，行为对齐 ZCode 的 elicitation decline：不作决定、
   * 计划未获批、计划模式保持开启。
   * @param conversation 目标会话
   * @param callId 交互请求 ID
   * @param review 存储的计划审阅
   * @returns 关闭后的会话详情
   * 内部逻辑：关闭回复先以 call 派生的 request id 投递（跨重启幂等），随后存储的
   * 审阅落定为 cancelled；已落定的审阅幂等返回。
   */
  const dismissPlanReview = async (
    conversation: Awaited<ReturnType<typeof requireConversation>>,
    callId: string,
    review: StoredPlanReview,
  ): Promise<ConversationDetail> => {
    if (review.status !== 'pending') return currentDetail(conversation.id)
    await assertConversationModelAllowed(conversation)
    const requestId = `plan-review-dismiss:${callId}`
    await submitReply(conversation, requestId, JSON.stringify({
      kind: 'dismissed_plan_review',
      callId,
      approveLabel: review.approveLabel,
      instruction: '用户关闭了计划审阅，未作决定。计划模式仍开启，计划未获批准，不得实施。请询问用户如何继续（修订计划，或不使用计划开展工作）。',
    }), {
      kind: 'pi-web.plan-review-dismissed',
      data: { requestId, callId },
    })
    await harness().commit(async (tx) => {
      const table = interactionTable(await tx.doc(Interactions, conversation.id))
      const stored = planReviewOf(table[callId])
      if (!stored || stored.status !== 'pending') return
      stored.status = 'cancelled'
      stored.cancelledAt = Date.now()
    }, CTX)
    return currentDetail(conversation.id)
  }

  /**
   * 功能：回答一条 pending 的交互请求（计划审阅之外的问答）。
   * @param value 会话 ID 字符串
   * @param callId 交互请求 ID
   * @param answers 各问题的选择与自定义补充
   * @returns 回答后的会话详情
   * 内部逻辑：先校验 callId 与请求存在；计划审阅转 answerPlanReview，已回答幂等
   * 返回、已取消报 CONFLICT；validateAnswers 校验选项合法。回复先以
   * `question-reply:<callId>` 提交再落定文档——提交被拒时请求仍可回答，重试
   * 也不会重复注入消息。
   */
  const answerInteraction = async (value: string, callId: string, answers: AskUserQuestionAnswerItem[]): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    if (typeof callId !== 'string' || callId.trim() === '' || callId.length > 160) {
      throw new RuntimeError('INVALID_INPUT', '交互请求 ID 无效')
    }
    const state = await harness().snapshot(Interactions, id, CTX)
    const request = state?.[callId]
    if (!request) throw new RuntimeError('NOT_FOUND', '交互请求不存在')
    const review = planReviewOf(request)
    if (review) return answerPlanReview(conversation, callId, review, answers)
    if (request.status === 'answered') return currentDetail(id)
    if (request.status === 'cancelled') throw new RuntimeError('CONFLICT', '该问题已放弃整组，无法再回答')
    const invalid = validateAnswers(request.questions, answers)
    if (invalid) throw new RuntimeError('INVALID_INPUT', invalid)
    await assertConversationModelAllowed(conversation)
    const settledAnswers = answers.map(answer => ({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    }))
    const reply = {
      kind: 'answer_to_pending_question',
      callId,
      questions: request.questions.map(question => ({
        ...question,
        ...(question.options ? { options: question.options.map(option => ({ ...option })) } : {}),
      })),
      answers: settledAnswers,
    }
    const requestId = `question-reply:${callId}`
    await submitReply(conversation, requestId, JSON.stringify(reply), {
      kind: 'pi-web.user-question-reply',
      data: { requestId, callId, answers: settledAnswers },
    })
    await harness().commit(async (tx) => {
      const doc = await tx.doc(Interactions, id)
      const stored = doc[callId]
      // 只有 pending 的请求在这里落定：输给放弃操作的回答不得复活该问题。
      if (!stored || stored.status !== 'pending') return
      stored.status = 'answered'
      stored.answers = settledAnswers
      stored.answeredAt = Date.now()
    }, CTX)
    return currentDetail(id)
  }

  /**
   * 功能：放弃一条 pending 的问答组，行为对齐 DSH 的 `ASK_CANCELLED`：无人回答、
   * 告知模型、该行不再接受回答。
   * @param value 会话 ID 字符串
   * @param callId 交互请求 ID
   * @returns 放弃后的会话详情
   * 内部逻辑：计划审阅转 dismissPlanReview；已回答报 CONFLICT（答案已在路上），
   * 已取消幂等返回。放弃回复先以 call 派生的 requestId 投递，重启重试不会重复
   * 告知模型。
   */
  const cancelInteraction = async (value: string, callId: string): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    if (typeof callId !== 'string' || callId.trim() === '' || callId.length > 160) {
      throw new RuntimeError('INVALID_INPUT', '交互请求 ID 无效')
    }
    const state = await harness().snapshot(Interactions, id, CTX)
    const request = state?.[callId]
    if (!request) throw new RuntimeError('NOT_FOUND', '交互请求不存在')
    const review = planReviewOf(request)
    if (review) return dismissPlanReview(conversation, callId, review)
    if (request.status === 'answered') throw new RuntimeError('CONFLICT', '该问题已回答，无法放弃整组问题')
    if (request.status === 'cancelled') return currentDetail(id)
    await assertConversationModelAllowed(conversation)
    const dismissal = {
      kind: 'dismissed_pending_question',
      callId,
      questions: request.questions.map(question => ({
        ...question,
        ...(question.options ? { options: question.options.map(option => ({ ...option })) } : {}),
      })),
      instruction: '用户关闭了这些问题，未作答复。不要重复提问；继续不依赖答复的工作，或结束本轮。',
    }
    const requestId = `question-dismiss:${callId}`
    await submitReply(conversation, requestId, JSON.stringify(dismissal), {
      kind: 'pi-web.user-question-dismissed',
      data: { requestId, callId },
    })
    await harness().commit(async (tx) => {
      const doc = await tx.doc(Interactions, id)
      const stored = doc[callId]
      if (!stored || stored.status !== 'pending') return
      stored.status = 'cancelled'
      stored.cancelledAt = Date.now()
    }, CTX)
    return currentDetail(id)
  }


  return { answerInteraction, cancelInteraction }
}
