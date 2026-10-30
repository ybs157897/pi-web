/**
 * Answering or dismissing the human-in-the-loop calls a run is waiting on.
 *
 * The reply is submitted before the stored call is settled, so a rejected submission
 * leaves the call answerable; a retry after a restart reuses the call-derived request id.
 */
import type { Conversation, ConversationId, Harness } from '@earendil-works/pi-durable'
import type { AskUserQuestionAnswerItem, ConversationDetail } from '../../shared/types.ts'
import { validateAnswers } from '../conversation/interactions.ts'
import { Plans, decidePlanReview, interactionTable, planReviewOf, type StoredPlanReview } from '../tools/plan.ts'
import { Interactions } from '../tools/interaction.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { CTX } from './helpers.ts'

export interface InteractionsDeps {
  harness: () => Harness
  requireConversation(value: string): Promise<Conversation>
  currentDetail(id: ConversationId): Promise<ConversationDetail>
  assertConversationModelAllowed(conversation: Conversation): Promise<void>
}

export function createInteractionReplies(deps: InteractionsDeps) {
  const { requireConversation, currentDetail, assertConversationModelAllowed } = deps
  const harness = (): Harness => deps.harness()

  const answerPlanReview = async (
    conversation: Awaited<ReturnType<typeof requireConversation>>,
    callId: string,
    review: StoredPlanReview,
    answers: AskUserQuestionAnswerItem[],
  ): Promise<ConversationDetail> => {
    const id = conversation.id
    // A superseded or already answered review is settled: nothing is waiting and plan mode stays as it is.
    if (review.status !== 'pending') return currentDetail(id)
    await assertConversationModelAllowed(conversation)
    const decision = decidePlanReview(review, answers)
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
        ? 'The user approved the plan and plan mode is now off: execute the approved plan in this turn.'
        : 'The user asked for changes and plan mode is still on: revise the plan and submit it again with exit_plan_mode.',
    }
    await conversation.submit({
      type: 'input',
      content: JSON.stringify(reply),
      requestId: `plan-review-reply:${callId}`,
      entry: {
        kind: 'pi-web.plan-review-reply',
        data: {
          callId,
          approved: decision.approved,
          answers: settledAnswers,
          ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
        },
      },
      whenBusy: 'steer',
    }, CTX)
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
   * Settle one pending interaction. The reply is submitted first, so a rejected submission leaves the
   * call answerable; the document is marked answered afterwards. The reply entry carries the call id
   * and `requestId` is derived from it, so a retry after a restart never injects the message twice.
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
    await conversation.submit({
      type: 'input',
      content: JSON.stringify(reply),
      requestId: `question-reply:${callId}`,
      entry: { kind: 'pi-web.user-question-reply', data: { callId, answers: settledAnswers } },
      whenBusy: 'steer',
    }, CTX)
    await harness().commit(async (tx) => {
      const doc = await tx.doc(Interactions, id)
      const stored = doc[callId]
      // Only a pending call settles here: an answer that lost the race against a
      // dismissal must not resurrect the question.
      if (!stored || stored.status !== 'pending') return
      stored.status = 'answered'
      stored.answers = settledAnswers
      stored.answeredAt = Date.now()
    }, CTX)
    return currentDetail(id)
  }

  /**
   * Dismiss one pending question set the way DSH's `ASK_CANCELLED` does: nobody answers,
   * the model is told, and the row can no longer take an answer. The dismissal reply is
   * steered first with a call-derived `requestId`, so a retry after a restart never tells
   * the model twice; already-cancelled calls are idempotent, and an answered call is a
   * conflict because its answers are already on their way.
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
    if (planReviewOf(request)) throw new RuntimeError('UNSUPPORTED', '计划待审请在卡片上批准或要求修改')
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
      instruction: 'The user dismissed these questions without answering. Do not ask them again; continue with work that does not depend on the answers, or wrap up.',
    }
    await conversation.submit({
      type: 'input',
      content: JSON.stringify(dismissal),
      requestId: `question-dismiss:${callId}`,
      entry: { kind: 'pi-web.user-question-dismissed', data: { callId } },
      whenBusy: 'steer',
    }, CTX)
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
