import type { ChatMessage } from '../../shared/types.ts'

/**
 * The child conversation's own latest answer, as the subagent catalog shows it.
 *
 * Ownership rules: a forked teammate inherits the lead's transcript prefix, so anything
 * before the last `team-spawn:` user input is the lead's voice, not the member's; and an
 * errored assistant turn reports a failure, it does not answer. Both are skipped so a row
 * never attributes foreign or failed text to the child.
 */
export function latestOwnAnswer(messages: readonly ChatMessage[], limit: number): string {
  const spawn = messages.findLastIndex(message => message.role === 'user'
    && typeof message.requestId === 'string' && message.requestId.startsWith('team-spawn:'))
  const own = spawn === -1 ? messages : messages.slice(spawn + 1)
  for (const message of [...own].reverse()) {
    if (message.role !== 'assistant') continue
    if (message.status === 'error' || message.isError === true) continue
    const text = message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').replace(/\s+/g, ' ').trim()
    if (text !== '') return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  }
  return ''
}
