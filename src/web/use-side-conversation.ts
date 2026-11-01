import { useEffect, useState } from 'react'
import type { ChatMessage } from '../shared/types.ts'
import { api } from './api.ts'
import type { SideChatMessage } from './SelectionChatPane.tsx'

/** How often the hidden feed re-reads the side conversation while its tab is visible. */
const POLL_INTERVAL_MS = 2000

/**
 * Only the plain text survives the projection: tool, image and file blocks are dropped,
 * and messages without any text (a bare tool call) do not become feed rows.
 */
function toSideMessages(messages: readonly ChatMessage[]): SideChatMessage[] {
  const feed: SideChatMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = message.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text.trim() === '') continue
    feed.push({ role: message.role, text })
  }
  return feed
}

/**
 * The side conversation's read model: an immediate detail read plus a two-second poll of
 * `api.getConversation` while the tab is visible. `enabled: false` stops the timer without
 * clearing the last view, so toggling the tab does not blank it. A ticket guards against a
 * slow response landing after a newer poll.
 */
export function useSideConversation(conversationId: string | undefined, enabled: boolean): {
  messages: SideChatMessage[]
  busy: boolean
} {
  const [messages, setMessages] = useState<SideChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!enabled || conversationId === undefined) return
    let ticket = 0
    let timer: number | undefined
    setMessages([])
    setBusy(false)
    const pull = (): void => {
      const mine = ++ticket
      api.getConversation(conversationId).then(detail => {
        if (mine !== ticket) return
        setMessages(toSideMessages(detail.messages))
        setBusy(detail.conversation.busy === true)
      }).catch(() => {
        // A failed poll keeps the previous view; the next tick retries.
      })
    }
    pull()
    timer = window.setInterval(pull, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      ticket += 1
    }
  }, [conversationId, enabled])
  return { messages, busy }
}
