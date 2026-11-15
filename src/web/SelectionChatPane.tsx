import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, MessageSquareText } from 'lucide-react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SelectionChatPane.module.css'

/** 侧聊中的一条消息：role 区分用户气泡与助手 Markdown 回复。 */
export interface SideChatMessage { role: 'user' | 'assistant'; text: string }

/** SelectionChatPane 的属性定义：会话标识、消息流、发送回调与引用芯片状态。 */
export interface SelectionChatPaneProps {
  /** 本标签页渲染的轻量会话 id；外壳以它作为标签页身份。 */
  conversationId: string
  /** 标签页标题，如「辅助对话 1」。 */
  title: string
  messages: readonly SideChatMessage[]
  /** 侧聊正在回答时为 true：禁止发送并显示忙碌行。 */
  busy: boolean
  onSend: (text: string) => void
  /** 等待随下一条消息一起发送的正文选区，以可移除的引用芯片展示。 */
  quotedText?: string
  /** 清除待发送的引用芯片。 */
  onDismissQuote?: () => void
}

/**
 * 功能：一个轻量的「选中文本问答」侧聊会话，作为 Inspector 标签页渲染：
 * 顶部标题栏、中部消息流（用户气泡 + 助手 Markdown）与底部小型输入区。
 * 消息流数据由 `useSideConversation` 提供，本组件保持纯展示。
 * @param props conversationId/title 会话标识与标签页标题；messages 消息列表；
 *              busy 是否正在回复（禁发 + 忙碌提示行）；onSend 发送文本回调；
 *              quotedText/onDismissQuote 待发送引用芯片及其清除回调。
 * 内部逻辑：draft 驱动输入框，高度随内容自适应（38–100px，约四行）；
 * messages/busy 变化时把消息流滚动到底部保持最新轮次可见；submit 校验非空且非
 * busy 后回调 onSend 并清空草稿；Enter（无 Shift、非输入法组合态）发送。
 */
export default function SelectionChatPane({ conversationId, title, messages, busy, onSend, quotedText, onDismissQuote }: SelectionChatPaneProps) {
  const { t } = useUiPreferences()
  const [draft, setDraft] = useState('')
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const canSend = draft.trim() !== '' && !busy
  // 输入框随草稿内容增高，最多约四行，与主输入框行为一致。
  useEffect(() => {
    const element = input.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 38), 100)}px`
  }, [draft])
  // 回答流式输出期间保持最新一轮在可视范围内。
  useEffect(() => {
    const element = feed.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [messages, busy])
  /** 提交当前草稿：非空且非 busy 时回调 onSend 并清空输入框。 */
  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || busy) return
    onSend(text)
    setDraft('')
  }
  /** 输入框按键：Enter（非 Shift、非输入法组合态）直接发送，其余按键正常输入。 */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }
  return <section className={css.root} data-side-chat={conversationId} aria-label={title}>
    <header className={css.header}>
      <span className={css.titleIcon} aria-hidden="true"><MessageSquareText size={14} /></span>
      <span className={css.title} title={title}>{title}</span>
    </header>
    <div className={css.feed} ref={feed}>
      {messages.length === 0 && <div className={css.empty}>
        {t('选中正文后点「在侧聊中提问」，或在下方直接输入', 'Select text in the transcript and choose "Ask in side chat", or type below')}
      </div>}
      {messages.map((message, index) => message.role === 'user'
        ? <div key={index} className={css.userRow} data-role="user">
          <div className={css.userBubble}>{message.text}</div>
        </div>
        : <div key={index} className={css.assistantRow} data-role="assistant">
          <MarkdownText text={message.text} labels={markdownLabels(t)} />
        </div>)}
      {busy && <div className={css.busyRow} role="status">{t('正在回复…', 'Replying…')}</div>}
    </div>
    <div className={css.composer}>
      {quotedText !== undefined && quotedText !== '' && <div className={css.quoteChip} data-quote-chip>
        <span className={css.quoteText}>{quotedText}</span>
        {onDismissQuote !== undefined && <button type="button" className={css.quoteDismiss}
          aria-label={t('移除引用', 'Remove quote')} onClick={onDismissQuote}>×</button>}
      </div>}
      <textarea ref={input} className={css.input} rows={1}
        aria-label={t('发送侧聊消息', 'Side chat message')}
        placeholder={t('在侧聊中提问…', 'Ask in the side chat…')}
        value={draft} onChange={event => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown} />
      <button type="button" className={css.send} disabled={!canSend}
        aria-label={t('发送', 'Send')} onClick={submit}>
        <ArrowUp size={15} aria-hidden="true" />
      </button>
    </div>
  </section>
}
