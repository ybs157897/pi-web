import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDownOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentSummary } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SubagentPanel.module.css'

/** How often a conversation with a live child re-reads the child rows; DSH pushes catalog frames instead. */
const POLL_MS = 1_500
const MENU_WIDTH = 336
const MENU_MARGIN = 16

/**
 * DSH's compact token count (`SubagentHeaderLineage.tsx:56-64`): plain below 1000, then K/M with
 * one decimal below 100 and none from 100 up.
 */
function formatTokens(value: number): string {
  const scaled = (next: number): string => next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

type DurationParts = { seconds: number; minutes: number; hours: number; days: number; totalMinutes: number; totalHours: number }

function splitDuration(ms: number): DurationParts {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1_000)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const totalHours = Math.floor(totalMinutes / 60)
  return {
    seconds: totalSeconds % 60,
    minutes: totalMinutes % 60,
    hours: totalHours % 24,
    days: Math.floor(totalHours / 24),
    totalMinutes,
    totalHours,
  }
}

/** DSH's compact duration (`SubagentHeaderLineage.tsx:116-153`): decreasing precision at larger scales. */
function formatDuration(ms: number): string {
  const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms)
  if (days >= 365) {
    const years = Math.floor(days / 365)
    const months = Math.floor((days % 365) / 30)
    return months === 0 ? `约${years}年` : `约${years}年${months}个月`
  }
  if (days >= 30) {
    const months = Math.floor(days / 30)
    const remainingDays = days % 30
    return remainingDays === 0 ? `约${months}个月` : `约${months}个月${remainingDays}天`
  }
  if (days > 0) return hours === 0 ? `${days}天` : `${days}天${hours}小时`
  if (totalHours > 0) return `${totalHours}小时${String(minutes).padStart(2, '0')}分${String(seconds).padStart(2, '0')}秒`
  if (totalMinutes > 0) return `${totalMinutes}分${String(seconds).padStart(2, '0')}秒`
  return `${seconds}秒`
}

/** Whole seconds kept for the hover title (`SubagentHeaderLineage.tsx:154-166`). */
function formatExactDuration(ms: number): string {
  const { seconds, minutes, hours, days } = splitDuration(ms)
  return days === 0
    ? formatDuration(ms)
    : `${days}天${String(hours).padStart(2, '0')}小时${String(minutes).padStart(2, '0')}分${String(seconds).padStart(2, '0')}秒`
}

/** The row's active time: the sampled total, advanced by the tick while the child still runs. */
function rowDurationMs(row: SubagentSummary, now: number): number | undefined {
  if (row.durationMs === undefined) return undefined
  if (row.status !== 'running' || row.metricsAt === undefined) return row.durationMs
  return row.durationMs + Math.max(0, now - row.metricsAt)
}

/**
 * DSH's session-header subagent catalog: a count trigger next to the conversation title that opens
 * the direct children with their status and latest answer. DSH folds the catalog from the parent's
 * own session log, so it arrives on the parent's stream; Pi's owner edge is a table row with no
 * subscription, so the rows are re-read while a child is running (and whenever the menu opens).
 */
export default function SubagentPanel({ conversationId, subagents, onOpen, onNotice }: {
  conversationId: string
  /** The projected children of this conversation: the first paint before the route answers. */
  subagents?: readonly SubagentSummary[]
  /** Open a child conversation through the normal conversation selection. */
  onOpen: (childId: string) => void
  /** Report a failed control action; the panel keeps the rows it already had. */
  onNotice: (message: string) => void
}) {
  const { t } = useUiPreferences()
  const [rows, setRows] = useState<SubagentSummary[]>(() => [...subagents ?? []])
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>()
  const [busy, setBusy] = useState(false)
  /** Wall clock for the running rows' duration metrics; DSH re-renders the catalog the same way. */
  const [now, setNow] = useState(() => Date.now())
  /** The one row whose follow-up input is open, plus its draft. */
  const [followUp, setFollowUp] = useState<{ id: string; text: string }>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // DSH's header catalog: hover opens after 150ms, hover-out closes after 120ms, and a
  // click pins the menu so only an explicit dismissal closes it (SubagentHeaderLineage.tsx:536-552).
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRows(await api.listChildren(conversationId))
    } catch {
      // A catalog read that fails leaves the last known rows in place; the next poll retries.
    }
  }, [conversationId])

  useEffect(() => { setRows([...subagents ?? []]) }, [subagents])
  useEffect(() => {
    cancelHover()
    pinnedRef.current = false
    setOpen(false)
    setPosition(undefined)
    void refresh()
  }, [conversationId, refresh])

  const running = rows.some(row => row.status === 'running')
  useEffect(() => {
    if (!running && !open) return
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [open, refresh, running])

  // DSH advances a running row's duration every second (`SubagentHeaderLineage.tsx:205-211`).
  // This is a clock, not an animation: `prefers-reduced-motion` never suppresses it.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [running])

  const place = useCallback((): void => {
    const trigger = triggerRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(MENU_WIDTH, window.innerWidth - MENU_MARGIN * 2)
    setPosition({
      top: rect.bottom + 5,
      left: Math.min(Math.max(MENU_MARGIN, rect.left), Math.max(MENU_MARGIN, window.innerWidth - width - MENU_MARGIN)),
    })
  }, [])

  function cancelHover(): void {
    if (hoverOpenTimer.current !== undefined) {
      clearTimeout(hoverOpenTimer.current)
      hoverOpenTimer.current = undefined
    }
    if (hoverCloseTimer.current !== undefined) {
      clearTimeout(hoverCloseTimer.current)
      hoverCloseTimer.current = undefined
    }
  }

  const changeOpen = (next: boolean, restoreFocus = false): void => {
    cancelHover()
    if (next) {
      if (triggerRef.current === null) return
      setOpen(true)
      place()
      void refresh()
    } else {
      pinnedRef.current = false
      setOpen(false)
      setPosition(undefined)
    }
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  /** `prefers-reduced-motion` skips the delay, so hover opens and closes immediately. */
  const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

  const scheduleHoverOpen = (): void => {
    cancelHover()
    if (open) return
    if (reducedMotion()) { changeOpen(true); return }
    hoverOpenTimer.current = setTimeout(() => {
      hoverOpenTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHover()
    if (pinnedRef.current) return
    if (reducedMotion()) { changeOpen(false); return }
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  useEffect(() => () => { cancelHover() }, [])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (triggerRef.current?.contains(event.target) === true || menuRef.current?.contains(event.target) === true) return
      changeOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  /** Close on Escape, returning focus to the trigger when the panel held it (DSH's `changeOpen(false, true)`). */
  const close = (restoreFocus = false): void => { changeOpen(false, restoreFocus) }

  const control = async (action: () => Promise<SubagentSummary[]>, failure: string): Promise<void> => {
    setBusy(true)
    try {
      setRows(await action())
    } catch (cause) {
      onNotice(cause instanceof Error && cause.message !== '' ? `${failure}：${cause.message}` : failure)
    } finally {
      setBusy(false)
    }
  }

  /** Send the open follow-up draft; the route answers with the refreshed rows. */
  const sendFollowUp = (): void => {
    if (followUp === undefined || busy) return
    const text = followUp.text.trim()
    if (text === '') return
    setFollowUp(undefined)
    void control(
      () => api.childMessage(conversationId, followUp.id, { text, requestId: crypto.randomUUID() }),
      t('无法发送子智能体消息', 'Could not message the subagent'),
    )
  }

  const navigate = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index < 0 ? items.length - 1 : index - 1
    items[(next + items.length) % items.length]?.focus()
  }

  if (rows.length === 0) return null
  const runningCount = rows.filter(row => row.status === 'running').length
  const countText = t(`${rows.length} 个子智能体`, `${rows.length} subagents`)
  const ariaLabel = runningCount > 0 ? t(`${runningCount} 个子智能体，正在运行`, `${runningCount} subagents running`) : countText

  return <div className={css.root} onKeyDown={navigate} onMouseLeave={scheduleHoverClose}>
    <button ref={triggerRef} type="button" className={css.trigger} aria-haspopup="tree" aria-expanded={open} aria-label={ariaLabel}
      onMouseEnter={scheduleHoverOpen}
      onClick={() => {
        cancelHover()
        pinnedRef.current = true
        if (!open) changeOpen(true)
      }}>
      {runningCount > 0 && <StateDot state="ongoing" />}
      <span className={css.count}>{countText}</span>
      <IconChevronDownOutlineRegular size={14} className={open ? css.chevronOpen : undefined} />
    </button>
    {open && position !== undefined && createPortal(
      <div ref={menuRef} className={css.menu} style={position} role="tree" aria-label={t('子智能体会话', 'Subagent sessions')}
        onMouseEnter={cancelHover} onMouseLeave={scheduleHoverClose}>
        {rows.map(row => {
          const durationMs = rowDurationMs(row, now)
          return <div key={row.id} role="treeitem" tabIndex={0} aria-level={1} className={css.row}
          data-follow-up={followUp?.id === row.id || undefined}
          aria-label={`${row.label} ${row.status === 'running' ? t('正在运行', 'running') : t('当前未运行', 'not running')} ${row.answer}`}
          onClick={() => { onOpen(row.id); close() }}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onOpen(row.id)
            close()
          }}>
          <span className={css.activitySlot}><StateDot state={row.status === 'running' ? 'ongoing' : 'idle'} /></span>
          <span className={css.content}>
            <span className={css.label}>{row.label}</span>
            <span className={css.summary}>
              <span className={css.status}>{row.status === 'running' ? t('正在运行', 'running') : t('当前未运行', 'not running')}</span>
              {row.answer !== '' && <span className={css.answer}>{row.answer}</span>}
            </span>
          </span>
          {(row.tokens !== undefined || durationMs !== undefined) && <span className={css.metrics}>
            {row.tokens !== undefined && <span className={css.metricToken}>{t(`${formatTokens(row.tokens)} tok`, `${formatTokens(row.tokens)} tok`)}</span>}
            {durationMs !== undefined && <span className={css.metricDuration} title={t(`总活跃耗时：${formatExactDuration(durationMs)}`, `Total active duration: ${formatExactDuration(durationMs)}`)}>
              {formatDuration(durationMs)}
            </span>}
          </span>}
          <span className={css.actions}>
            <button type="button" className={css.action} disabled={busy || row.status !== 'running'}
              onClick={event => {
                event.stopPropagation()
                void control(() => api.childStop(conversationId, row.id), t('无法停止子智能体', 'Could not stop the subagent'))
              }}>{t('停止', 'Stop')}</button>
            <button type="button" className={css.action} disabled={busy}
              onClick={event => {
                event.stopPropagation()
                setFollowUp(current => current?.id === row.id ? undefined : { id: row.id, text: '' })
              }}>{t('跟进', 'Follow up')}</button>
            <button type="button" className={css.action} disabled={busy}
              onClick={event => {
                event.stopPropagation()
                onOpen(row.id)
                close()
              }}>{t('打开', 'Open')}</button>
          </span>
        </div>
        })}
        {followUp !== undefined && <form key={followUp.id} className={css.followUp} onClick={event => { event.stopPropagation() }}
          onSubmit={event => {
            event.preventDefault()
            event.stopPropagation()
            sendFollowUp()
          }}>
          <input className={css.followUpInput} autoFocus value={followUp.text} aria-label={t('给子智能体发消息', 'Message the subagent')}
            placeholder={t('给这个子智能体发一条消息…', 'Send this subagent a message…')}
            onChange={event => { setFollowUp(current => current === undefined ? current : { ...current, text: event.target.value }) }}
            onKeyDown={event => {
              if (event.key !== 'Enter') return
              // Enter sends here rather than relying on implicit submission, which a synthetic key
              // press does not always reach.
              event.preventDefault()
              event.stopPropagation()
              sendFollowUp()
            }} />
          <button type="submit" className={css.action} disabled={busy || followUp.text.trim() === ''}>{t('发送', 'Send')}</button>
          <button type="button" className={css.action} onClick={() => { setFollowUp(undefined) }}>{t('取消', 'Cancel')}</button>
        </form>}
      </div>,
      document.body,
    )}
  </div>
}
