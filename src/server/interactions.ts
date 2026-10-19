import type { AskUserQuestionAnswerItem, AskUserQuestionItem, InteractionRequest } from '../shared/types.ts'

/** What the transcript knows about one `ask_user_question` call. */
export type QuestionCall = {
  callId: string
  questions: readonly AskUserQuestionItem[]
  askedAt: number
  /**
   * `pending` = the tool answered with a notice; `cancelled` = the user dismissed the
   * set without answering; `errored` = the call failed before an answer arrived.
   */
  result?: 'pending' | 'answered' | 'cancelled' | 'errored'
}

/** One late answer, delivered as a user message whose entry carries the call id. */
export type QuestionReply = {
  callId: string
  answers: readonly AskUserQuestionAnswerItem[]
  repliedAt: number
}

/**
 * Validate one answer batch against its questions: every question is answered exactly once, selections
 * come from the offered options, and a question without options needs custom text.
 */
export function validateAnswers(questions: readonly AskUserQuestionItem[], answers: readonly AskUserQuestionAnswerItem[]): string | undefined {
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  if (byId.size !== answers.length) return 'Each question can be answered only once'
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (!answer) return `Missing an answer for question "${question.id}"`
    const offered = new Set((question.options ?? []).map(option => option.label))
    for (const selected of answer.selected) {
      if (!offered.has(selected)) return `Selected option "${selected}" was not offered for question "${question.id}"`
    }
    if (selectedCount(answer) === 0 && (answer.custom ?? '').trim() === '') {
      // DSH treats an empty answer as "skipped", which the UI sends deliberately; nothing to reject here.
      continue
    }
    if (!question.multiSelect && answer.selected.length > 1) return `Question "${question.id}" accepts a single choice`
  }
  return undefined
}

function selectedCount(answer: AskUserQuestionAnswerItem): number {
  return answer.selected.length
}

/**
 * Pair question calls with their late answers, newest last. DSH's rule: a call whose tool result already
 * carried the answers is settled, a call still open is answerable, and a call whose tool reported the
 * question as pending stays answerable until a reply arrives.
 */
export function foldInteractions(calls: readonly QuestionCall[], replies: readonly QuestionReply[]): InteractionRequest[] {
  const replyByCall = new Map(replies.map(reply => [reply.callId, reply]))
  return calls
    .map(call => {
      const reply = replyByCall.get(call.callId)
      const base = { id: call.callId, kind: 'question' as const, questions: [...call.questions], createdAt: call.askedAt }
      if (reply) {
        return { ...base, status: 'answered' as const, answer: { answers: [...reply.answers] }, answeredAt: reply.repliedAt }
      }
      if (call.result === 'answered') return { ...base, status: 'answered' as const }
      if (call.result === 'cancelled') return { ...base, status: 'cancelled' as const }
      if (call.result === 'errored') return { ...base, status: 'expired' as const }
      return { ...base, status: 'pending' as const }
    })
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}
