import type { ChatMessage } from '../../shared/types.ts'

/**
 * 功能：取子会话自己发出的最新一条回答文本，供子智能体目录展示。
 * @param messages 子会话的完整消息序列。
 * @param limit 返回文本的最大字符数；超出时截断并追加省略号。
 * @returns 最新一条非错误助手消息的纯文本（空白压缩为单空格）；没有可用回答时返回空串。
 * 内部逻辑：以最后一条 `team-spawn:` 用户输入为归属分界——fork 的队友继承主会话的转录前缀，
 * 分界之前是主会话的声音而非成员自己的；出错的助手轮次报告失败、不算回答，同样跳过。
 * 两类都跳过，避免目录把外来或失败的文本归到子会话名下。
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
