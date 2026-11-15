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

/** 目标所处阶段：进行中 / 已暂停 / 受阻 / 已完成。 */
export type GoalBarPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** `ConversationDetail.goal` 携带的目标状态，与服务端 `pi-web.goal` 文档同构。 */
export type GoalBarState = {
  id: string
  revision: number
  objective: string
  phase: GoalBarPhase
  maxGoalRounds: number
  roundsStarted: number
  blockedReason?: string
}

/** 目标栏发起的请求；App 将其映射到 `POST /api/conversations/:id/goal`。 */
export type GoalBarAction = 'pause' | 'resume' | 'edit' | 'clear'

/** 各阶段的展示文案（中/英双语对）。 */
const PHASE_LABEL: Record<Exclude<GoalBarPhase, 'complete'>, [chinese: string, english: string]> = {
  active: ['进行中的目标', 'Active goal'],
  paused: ['已暂停的目标', 'Paused goal'],
  blocked: ['受阻的目标', 'Blocked goal'],
}

/**
 * 功能：DSH 的目标停靠栏（goal dock）——像 `TodoPanel` 一样位于输入卡上方，
 * 展示阶段标签、截断的目标内容与轮次预算，并向宿主路由发起暂停/恢复/编辑/清除。
 * 已完成的目标整体隐藏；编辑为行内输入，空目标不可保存。
 * @param props goal 目标状态（null/undefined 或 phase=complete 时不渲染）；
 *              onSetState 以动作名与可选 payload 回调（edit 附 objective）。
 * 内部逻辑：editing/draft 控制行内编辑；进入编辑时自动聚焦并全选输入框，
 * goalId 变化时退出编辑；blocked 阶段的悬浮提示显示 blockedReason，否则显示目标内容；
 * submitEdit 校验 trim 非空后回调 edit 并退出编辑；暂停/恢复按钮按 phase 二选一渲染。
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
  /** 提交行内编辑：trim 后非空才回调 onSetState('edit')，随后退出编辑态。 */
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
