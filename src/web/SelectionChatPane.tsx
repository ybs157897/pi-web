import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, MessageSquareText } from 'lucide-react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SelectionChatPane.module.css'

export interface SideChatMessage { role: 'user' | 'assistant'; text: string }

export interface SelectionChatPaneProps {
  /** The lightweight conversation this tab renders; read by the shell's tab identity. */
  conversationId: string
  /** The tab's label, e.g. 「辅助对话 1」. */
  title: string
  messages: readonly SideChatMessage[]
  /** True while the side conversation is answering; sending is blocked and a busy row shows. */
  busy: boolean
  onSend: (text: string) => void
  /** A transcript selection waiting to ride the next send; shown as a removable reference chip. */
  quotedText?: string
  /** Clears the pending quote chip. */
  onDismissQuote?: () => void
}

/**
 * One lightweight quoted-selection conversation, rendered as an inspector tab: a title bar,
 * a chat feed (user bubbles, assistant markdown) and a small composer below. The feed itself
 * is supplied by `useSideConversation`; this component stays a pure presenter.
 */
export default function SelectionChatPane({ conversationId, title, messages, busy, onSend, quotedText, onDismissQuote }: SelectionChatPaneProps) {
  const { t } = useUiPreferences()
  const [draft, setDraft] = useState('')
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const canSend = draft.trim() !== '' && !busy
  // The composer grows with its draft up to four lines, like the main composer.
  useEffect(() => {
    const element = input.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 38), 100)}px`
  }, [draft])
  // Keep the newest turn in view while answers stream in.
  useEffect(() => {
    const element = feed.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [messages, busy])
  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || busy) return
    onSend(text)
    setDraft('')
  }
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
