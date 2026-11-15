import { useEffect, useState } from 'react'
import type { ChatMessage } from '../shared/types.ts'
import { api } from './api.ts'
import type { SideChatMessage } from './SelectionChatPane.tsx'

/** 侧聊 tab 可见时，隐藏订阅流重新拉取侧会话的轮询间隔。 */
const POLL_INTERVAL_MS = 2000

/**
 * 功能：把会话消息投影成侧聊 feed 行——只保留纯文本：工具、图片、文件块全部丢弃，
 * 没有任何文本的消息（如纯工具调用）不产生 feed 行。
 * @param messages 会话消息
 * @returns { role, text } 列表
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
 * 功能：侧聊会话的读模型——立读一次 detail，之后 tab 可见期间每 2 秒轮询 `api.getConversation`。
 * @param conversationId 侧聊会话 id；undefined 时不启动轮询
 * @param enabled tab 是否可见；false 停掉定时器但不清空上次视图，切回 tab 不闪白
 * @returns `{ messages, busy }`——投影后的 feed 行与对方是否正在生成
 * 内部逻辑：自增 ticket 守卫「旧响应晚于新轮询落地」的竞态；失败的轮询保留上一视图，下个 tick 重试；conversationId 或 enabled 变化时重置。
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
        // 轮询失败保留上一视图，下个 tick 重试。
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
