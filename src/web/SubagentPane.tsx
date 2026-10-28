import { useEffect, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationDetail } from '../shared/types.ts'
import { api } from './api.ts'
import { visibleTranscriptMessages } from './render-model.ts'
import Transcript from './transcript.tsx'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SubagentPane.module.css'

/**
 * One child conversation shown read-only in the inspector's side panel. The pane loads the
 * durable detail first and then follows the same live snapshot stream as the main transcript,
 * so a running child keeps streaming while its parent stays in the primary column. Every pane
 * stays mounted (hidden while another tab is active) to keep its EventSource and scroll state.
 */
export default function SubagentPane({ childId, title, hidden = false }: {
  childId: string
  /** The tab's label: the child's delegation label, falling back to its title. */
  title: string
  /** Kept mounted but not displayed while another inspector tab is active. */
  hidden?: boolean
}) {
  const { t } = useUiPreferences()
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    // The initial read may land after the stream's first frame; a snapshot is authoritative then.
    let snapshotSeen = false
    setDetail(null)
    setError('')
    setLoading(true)
    api.getConversation(childId).then(value => {
      if (!active || snapshotSeen) return
      setDetail(value)
      setError('')
      setLoading(false)
    }).catch(cause => {
      if (!active) return
      setError(cause instanceof Error && cause.message !== '' ? cause.message
        : t('无法打开子会话', 'Could not open the subagent session'))
      setLoading(false)
    })
    const source = api.watch(childId, value => {
      if (!active) return
      snapshotSeen = true
      setDetail(value)
      setError('')
      setLoading(false)
    }, state => {
      if (!active || state !== 'error') return
      setError(current => current === '' ? t('子会话连接已中断', 'Subagent session disconnected') : current)
    })
    return () => {
      active = false
      source.close()
    }
  }, [childId, t])

  const running = detail?.conversation.busy === true
  const model = detail?.conversation.model
  return <section className={css.root} data-subagent-pane={childId} hidden={hidden} aria-label={title}>
    <header className={css.header}>
      <StateDot state={running ? 'ongoing' : 'idle'} />
      <span className={css.title} title={title}>{title}</span>
      <span className={css.meta}>
        {running ? t('运行中', 'Running') : t('空闲', 'Idle')}
        {model !== undefined && ` · ${model.modelId}`}
      </span>
    </header>
    {error !== '' && <div className={css.error} role="alert">{error}</div>}
    {loading && detail === null && error === '' && <div className={css.notice} role="status">{t('正在载入子会话…', 'Loading subagent session…')}</div>}
    {detail !== null && <div className={css.body}>
      <Transcript messages={visibleTranscriptMessages(detail.messages, detail.compaction?.running === true)}
        conversationId={childId} running={running} />
    </div>}
  </section>
}
