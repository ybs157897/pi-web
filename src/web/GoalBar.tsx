import { useEffect, useRef, useState } from 'react'
import {
  IconEditOutlineRegular,
  IconGoalOutlineRegular,
  IconPauseOutlineRegular,
  IconPlayOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './GoalBar.module.css'

export type GoalBarPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** The goal as `ConversationDetail.goal` carries it; same shape as the server's `pi-web.goal` document. */
export type GoalBarState = {
  id: string
  revision: number
  objective: string
  phase: GoalBarPhase
  maxGoalRounds: number
  roundsStarted: number
  blockedReason?: string
}

/** Requests the bar raises; App maps them onto `POST /api/conversations/:id/goal`. */
export type GoalBarAction = 'pause' | 'resume' | 'edit' | 'clear'

const PHASE_LABEL: Record<Exclude<GoalBarPhase, 'complete'>, [chinese: string, english: string]> = {
  active: ['进行中的目标', 'Active goal'],
  paused: ['已暂停的目标', 'Paused goal'],
  blocked: ['受阻的目标', 'Blocked goal'],
}

/**
 * DSH's goal dock: sits above the composer card like `TodoPanel`, shows the phase, the truncated
 * objective and the round budget, and raises pause/resume/edit/clear for the hosting route. A
 * completed goal hides the bar; editing happens inline and an empty objective cannot be saved.
 */
export default function GoalBar({ goal, onSetState }: {
  goal?: GoalBarState | null
  onSetState: (action: GoalBarAction, payload?: { objective?: string }) => void
}) {
  const { t } = useUiPreferences()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const goalId = goal?.id
  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])
  useEffect(() => { setEditing(false) }, [goalId])
  if (!goal || goal.phase === 'complete') return null
  const label = t(...PHASE_LABEL[goal.phase])
  const rounds = t(`轮次 ${goal.roundsStarted}/${goal.maxGoalRounds}`, `Round ${goal.roundsStarted}/${goal.maxGoalRounds}`)
  const objective = goal.objective
  const submitEdit = () => {
    const next = draft.trim()
    if (next === '') return
    onSetState('edit', { objective: next })
    setEditing(false)
  }
  const title = goal.phase === 'blocked' && goal.blockedReason ? goal.blockedReason : objective
  return <div className={css.bar} data-phase={goal.phase} title={title}>
    {editing
      ? <>
        <IconGoalOutlineRegular size={14} className={css.icon} />
        <span className={css.phase}>{label}</span>
        <input ref={inputRef} className={css.input} value={draft} placeholder={t('目标内容', 'Goal objective')}
          aria-label={t('目标内容', 'Goal objective')}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); submitEdit() }
            else if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
          }} />
        <button type="button" className={`${css.textAction} ${css.save}`} disabled={draft.trim() === ''} onClick={submitEdit}>
          {t('保存', 'Save')}
        </button>
        <button type="button" className={css.textAction} onClick={() => setEditing(false)}>{t('取消', 'Cancel')}</button>
      </>
      : <>
        <IconGoalOutlineRegular size={14} className={css.icon} />
        <span className={css.phase}>{label}</span>
        <span className={css.objective}>{objective}</span>
        <span className={css.rounds}>{rounds}</span>
        <span className={css.actions}>
          {goal.phase === 'active'
            ? <button type="button" className={css.action} title={t('暂停', 'Pause')} aria-label={t('暂停', 'Pause')}
                onClick={() => onSetState('pause')}><IconPauseOutlineRegular size={14} /></button>
            : <button type="button" className={css.action} title={t('恢复', 'Resume')} aria-label={t('恢复', 'Resume')}
                onClick={() => onSetState('resume')}><IconPlayOutlineRegular size={14} /></button>}
          <button type="button" className={css.action} title={t('编辑', 'Edit')} aria-label={t('编辑', 'Edit')}
            onClick={() => { setDraft(objective); setEditing(true) }}><IconEditOutlineRegular size={14} /></button>
          <button type="button" className={css.action} title={t('清除', 'Clear')} aria-label={t('清除', 'Clear')}
            onClick={() => onSetState('clear')}><IconTrashOutlineRegular size={14} /></button>
        </span>
      </>}
  </div>
}
