/**
 * Machine payloads the runtime steers as user messages when the user answers or
 * dismisses a question set.
 *
 * They start a run like any other input, but they have no bubble of their own: the
 * content belongs to the `ask_user_question` row. Both the render model (which hides
 * the message) and the tool-row model (which reads the answers out of it) need the
 * same kind strings, so they live here instead of in either module.
 */
export const ANSWER_REPLY_KIND = 'answer_to_pending_question'
export const DISMISSAL_REPLY_KIND = 'dismissed_pending_question'

/**
 * Whether a user message is one of those payloads. The runtime serializes them with
 * `JSON.stringify`, so the kind appears exactly once, unspaced, at the start of an object.
 */
export function isInteractionPayloadText(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{')) return false
  return trimmed.includes(`"kind":"${ANSWER_REPLY_KIND}"`) || trimmed.includes(`"kind":"${DISMISSAL_REPLY_KIND}"`)
}
