import type { AskUserQuestionAnswerItem, AskUserQuestionItem, InteractionRequest } from '../../shared/types.ts'

/** 转录中一次 `ask_user_question` 调用的已知信息：问题集、提问时间与（可能迟到的）结果状态。 */
export type QuestionCall = {
  callId: string
  questions: readonly AskUserQuestionItem[]
  askedAt: number
  /**
   * 结果状态：`pending` = 工具以提示（notice）形式等待答复；`cancelled` = 用户未作答直接关闭问题集；
   * `errored` = 收到答复前调用即失败。
   */
  result?: 'pending' | 'answered' | 'cancelled' | 'errored'
}

/** 一条迟到的用户答复：作为用户消息送达，其 entry 携带对应的调用 id。 */
export type QuestionReply = {
  callId: string
  answers: readonly AskUserQuestionAnswerItem[]
  repliedAt: number
}

/**
 * 功能：校验一批答复与其对应的问题集：每个问题恰好回答一次、选项必须来自提供的选项列表、
 * 无选项的问题必须给出自定义文本。
 * @param questions 该调用提出的问题列表。
 * @param answers 用户提交的答复列表。
 * @returns 校验失败时返回英文错误文案（会原样返回给前端）；通过时返回 undefined。
 * 内部逻辑：先查答复按 id 去重（不允许重复回答）；逐题核对存在性、选项合法性；
 * 完全空白的答复视为"跳过"（UI 会刻意发送），不拒绝；单选题选了多项则报错。
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
      // DSH 把空答复视为"跳过"，且 UI 会刻意发送；此处不做拒绝。
      continue
    }
    if (!question.multiSelect && answer.selected.length > 1) return `Question "${question.id}" accepts a single choice`
  }
  return undefined
}

/** 单个答复已勾选的选项数量，用于判断"整批为空即跳过"。 */
function selectedCount(answer: AskUserQuestionAnswerItem): number {
  return answer.selected.length
}

/**
 * 功能：把提问调用与其迟到的答复配对，产出按时间升序（同刻按 id）的交互请求列表。
 * @param calls 转录中已知的全部提问调用。
 * @param replies 迟到的答复列表。
 * @returns 每个调用一个 InteractionRequest；有答复标记 answered，已取消标记 cancelled，
 * 已失败标记 expired，其余标记 pending（仍可回答）。
 * 内部逻辑：DSH 规则——工具结果已带回答复的调用视为已了结；仍开启的调用可回答；
 * 工具把问题报告为 pending 的调用在答复到达前始终可回答。
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
