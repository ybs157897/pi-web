/**
 * Machine payloads the runtime steers as user messages when the user answers or
 * dismisses a question set.
 *
 * They start a run like any other input, but they have no bubble of their own: the
 * content belongs to the `ask_user_question` row. Both the render model (which hides
 * the message) and the tool-row model (which reads the answers out of it) need the
 * same kind strings, so they live here instead of in either module.
 */
/**
 * 运行时以「用户消息」形态注入的机器载荷 kind 常量：用户应答或关掉一组提问 / 计划评审时产生。
 *
 * 它们和普通输入一样会触发一轮 run，但不生成自己的消息气泡——内容归属对应的
 * `ask_user_question` 行。渲染模型（隐藏该消息）与工具行模型（从中读出答案）都要用
 * 同一组 kind 字符串，因此单独放在这里避免两处各自维护。
 */
export const ANSWER_REPLY_KIND = 'answer_to_pending_question'
export const DISMISSAL_REPLY_KIND = 'dismissed_pending_question'
export const DISMISS_PLAN_REPLY_KIND = 'dismissed_plan_review'

/**
 * 功能：判断一段用户消息文本是否是上面三种机器载荷之一（隐藏气泡、交给工具行模型的依据）。
 * @param text 消息全文
 * @returns 是机器载荷返回 true
 * 内部逻辑：运行时用 `JSON.stringify` 序列化，`"kind":"..."` 必然以无空格形式出现在对象开头，所以子串匹配即可，不必完整解析 JSON。
 */
export function isInteractionPayloadText(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{')) return false
  return trimmed.includes(`"kind":"${ANSWER_REPLY_KIND}"`) || trimmed.includes(`"kind":"${DISMISSAL_REPLY_KIND}"`)
    || trimmed.includes(`"kind":"${DISMISS_PLAN_REPLY_KIND}"`)
}
