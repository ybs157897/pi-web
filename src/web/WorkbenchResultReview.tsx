import { useRef, useState, type FormEvent } from 'react'
import { Check, Undo2 } from 'lucide-react'
import type { WorkItem } from '../shared/workbench.ts'
import { DECISION_INBOX_CHANGED } from './decision-inbox-api.ts'
import { workbenchApi } from './workbench-api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './AgentWorkbenchConversation.module.css'

/** Each review acts on the specific delivery attempt visible in this conversation. */
export function WorkbenchResultReview({ item, onChange }: { item: WorkItem; onChange: () => void }) {
  const { t } = useUiPreferences()
  const [editing, setEditing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState<'accept' | 'revise'>()
  const [error, setError] = useState('')
  const sending = useRef(false)
  const reviseButton = useRef<HTMLButtonElement>(null)
  async function decide(action: 'accept' | 'revise') {
    if (sending.current || done) return
    sending.current = true
    setPending(true)
    setError('')
    try {
      await workbenchApi.verdict(item.workspaceId, item.id, {
        action, attempt: item.attempt, ...(action === 'revise' && feedback.trim() ? { feedback: feedback.trim() } : {}),
      })
      setDone(action)
      window.dispatchEvent(new CustomEvent(DECISION_INBOX_CHANGED, { detail: { workspaceId: item.workspaceId } }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('验收未能提交，请重试。', 'The decision could not be submitted. Try again.'))
    } finally {
      sending.current = false
      setPending(false)
      onChange()
    }
  }
  function submitRevision(event: FormEvent) { event.preventDefault(); void decide('revise') }
  if (done) return <p className={css.reviewNote} role="status">{done === 'accept' ? t('验收通过', 'Accepted') : t('已退回修改', 'Sent back for revision')}</p>
  return <div className={css.review} aria-label={t('处理本次交付', 'Review this delivery')}>
    {item.acceptance.length > 0 && <details className={css.reviewCriteria}><summary>{t('验收条件', 'Acceptance criteria')}</summary>
      <ul>{item.acceptance.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></details>}
    {editing ? <form onSubmit={submitRevision} className={css.revision}>
      <label>{t('修改意见（选填）', 'Revision feedback (optional)')}
        <textarea autoFocus rows={2} maxLength={2000} value={feedback} disabled={pending} onChange={event => setFeedback(event.currentTarget.value)} /></label>
      <div className={css.reviewButtons}><button type="submit" disabled={pending}>{t('提交返修', 'Send for revision')}</button>
        <button type="button" disabled={pending} onClick={() => { setEditing(false); requestAnimationFrame(() => reviseButton.current?.focus()) }}>{t('取消', 'Cancel')}</button></div>
    </form> : <div className={css.reviewButtons}>
      <button type="button" disabled={pending} onClick={() => void decide('accept')}><Check size={14} />{t('验收通过', 'Accept result')}</button>
      <button type="button" ref={reviseButton} disabled={pending} onClick={() => setEditing(true)}><Undo2 size={14} />{t('退回修改', 'Request changes')}</button>
    </div>}
    {error && <p role="alert" className={css.error}>{error}</p>}
  </div>
}
