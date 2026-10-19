import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronDownOutlineRegular, IconUserOutlineRegular, IconUsersOutlineRegular, StateDot, Tag,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamMemberView, TeamTaskView, TeamView } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './TeamPanel.module.css'

/** How often an open panel or a live team re-reads the projection; DSH pushes frames instead. */
const POLL_MS = 1_500
const MENU_WIDTH = 336
const MENU_MARGIN = 16

/** DSH `TeamAction.tsx:52-58`: running/provisioning are ongoing, failed is an error, inactive is a person. */
function memberDotState(status: Exclude<TeamMemberView['status'], 'inactive'>): StateDotState {
  return status === 'failed' ? 'error' : 'ongoing'
}

/** DSH `TeamAction.tsx:60-68`: ready pending is idle, a blocked pending is a warning. */
function taskDotState(task: TeamTaskView): StateDotState {
  if (task.status === 'pending') return task.ready ? 'idle' : 'warning'
  if (task.status === 'in_progress') return 'ongoing'
  return 'done'
}

/**
 * DSH's session-header Agent Team catalog: a read-only trigger that opens the durable roster and
 * the shared task board. The panel never writes; every mutation goes through the conversation.
 */
export default function TeamPanel({ conversationId, team, onOpen, onNotice }: {
  conversationId: string
  /** The projected team of this conversation: the first paint before the route answers. */
  team?: TeamView
  /** Open a member's conversation through the normal conversation selection. */
  onOpen: (conversationId: string) => void
  /** Report a failed refresh; the panel keeps the rows it already had. */
  onNotice: (message: string) => void
}) {
  const { t } = useUiPreferences()
  const [view, setView] = useState<TeamView | undefined>(() => team === undefined ? undefined : structuredClone(team))
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>()
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerLabelRef = useRef<HTMLSpanElement>(null)
  // DSH's Team action: hover opens after 150ms, hover-out closes after 120ms, a click
  // pins the panel, and only outside click or Escape closes a pinned one
  // (TeamAction.tsx:217-251).
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setView(await api.getTeam(conversationId))
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== '' ? cause.message : t('无法读取智能体团队', 'Could not read the agent team'))
    }
  }, [conversationId, t])

  useEffect(() => { setView(team === undefined ? undefined : structuredClone(team)) }, [team])
  useEffect(() => {
    cancelHover()
    pinnedRef.current = false
    setOpen(false)
    setPosition(undefined)
    setError(null)
    void refresh()
  }, [conversationId, refresh])

  const running = (view?.members ?? []).some(member => member.status === 'running' || member.status === 'provisioning')
  useEffect(() => {
    if (!running && !open) return
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [open, refresh, running])

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
    }
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  /** `prefers-reduced-motion` skips the delay, so hover opens and closes immediately. */
  const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

  const scheduleHoverOpen = (): void => {
    cancelHover()
    if (open) return
    // Icon-only trigger (the header container query collapsed the label): hover-open would
    // surprise on such a small target, so only click opens it (DSH TeamAction.tsx:221-224).
    if (triggerLabelRef.current !== null && getComputedStyle(triggerLabelRef.current).display === 'none') return
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
      if (triggerRef.current?.contains(event.target) === true || panelRef.current?.contains(event.target) === true) return
      changeOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      changeOpen(false, panelRef.current?.contains(document.activeElement) === true)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  const members = view?.members ?? []
  const teammates = members.filter(member => member.role === 'teammate')
  // DSH shows the action even for a lone Lead, but pi-web's trigger only earns its place once a
  // teammate or a task exists; both arrive through this panel.
  if (teammates.length === 0 && (view?.tasks.length ?? 0) === 0) return null
  const runningCount = members.filter(member => member.status === 'running').length
  const countText = t(`${teammates.length} 名成员`, `${teammates.length} members`)
  const ariaLabel = runningCount > 0 ? t(`${runningCount} 名成员正在运行`, `${runningCount} members running`) : countText
  const tasks = view?.tasks ?? []

  return <div className={css.root} onMouseLeave={scheduleHoverClose}>
    <button ref={triggerRef} type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel}
      onMouseEnter={scheduleHoverOpen}
      onClick={() => {
        cancelHover()
        pinnedRef.current = true
        if (!open) changeOpen(true)
        else panelRef.current?.focus()
      }}>
      {runningCount > 0 && <StateDot state="ongoing" />}
      <IconUsersOutlineRegular size={14} />
      <span ref={triggerLabelRef} className={css.triggerLabel}>{t('智能体团队', 'Agent Team')}</span>
      <span className={css.count}>{countText}</span>
      <IconChevronDownOutlineRegular size={14} className={open ? css.chevronOpen : undefined} />
    </button>
    {open && position !== undefined && createPortal(
      <div ref={panelRef} className={css.panel} style={position} role="dialog" tabIndex={-1}
        aria-label={t('智能体团队', 'Agent Team')} data-team-panel
        onMouseEnter={cancelHover} onMouseLeave={scheduleHoverClose}>
        <div className={css.body}>
          {error !== null && <div className={css.error} role="alert"><StateDot state="error" />{error}</div>}
          <section>
            <h3>{t('成员', 'Members')}<span className={css.sectionCount}>{members.length}</span></h3>
            <div className={css.roster}>
              {members.map(member => {
                const current = member.conversationId === conversationId
                const inert = member.status === 'failed' || member.status === 'provisioning' || member.conversationId === undefined || current
                return <button key={member.name} type="button"
                  className={current && members.length > 1 ? `${css.member} ${css.memberCurrent}` : css.member}
                  disabled={inert}
                  onClick={() => {
                    if (member.conversationId === undefined) return
                    onOpen(member.conversationId)
                    changeOpen(false)
                  }}>
                  <span className={css.memberDot}>
                    {member.status === 'inactive'
                      ? <IconUserOutlineRegular size={14} className={css.inactiveIcon} />
                      : <StateDot state={memberDotState(member.status)} />}
                  </span>
                  <span className={css.memberText}>
                    <span className={css.memberName}>
                      <span className={css.memberNameText}>{member.name}</span>
                      {current && <Tag tone="info" className={css.currentTag}>{t('当前会话', 'Current chat')}</Tag>}
                    </span>
                    <small className={css.memberStatus}>
                      {member.status === 'running' ? t('运行中', 'Running')
                        : member.status === 'provisioning' ? t('准备中', 'Provisioning')
                          : member.status === 'failed' ? t('失败', 'Failed')
                            : t('未运行', 'Inactive')}
                      {member.model !== undefined && <span className={css.memberModel}>{` · ${t('模型', 'Model')}: ${member.model}`}</span>}
                    </small>
                    {member.error !== undefined && <small className={css.diagnostic}>{member.error}</small>}
                  </span>
                </button>
              })}
            </div>
          </section>
          <section>
            {tasks.length === 0
              ? <p className={css.empty}>{t('暂无共享任务，可以通过对话创建', 'No shared tasks yet. Create them through the conversation.')}</p>
              : <>
                <h3>{t('共享任务', 'Shared tasks')}<span className={css.sectionCount}>{tasks.length}</span></h3>
                <div className={css.tasks}>
                  {tasks.map(task => <TaskCard key={task.id} task={task} />)}
                </div>
              </>}
          </section>
        </div>
      </div>,
      document.body,
    )}
  </div>
}

/** Task card with the two-line description clamp and the meta row (`TeamAction.tsx:129-176`). */
function TaskCard({ task }: { task: TeamTaskView }) {
  const { t } = useUiPreferences()
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = textRef.current
    if (paragraph === null) return
    const measure = (): void => { setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [task.description, expanded])
  return <article className={css.task}>
    <div className={css.taskTitle}>
      <strong>{task.subject}</strong>
      <span className={css.taskState}>
        <StateDot state={taskDotState(task)} />
        <span>{task.status === 'pending' ? t('待处理', 'Pending') : task.status === 'in_progress' ? t('进行中', 'In progress') : t('已完成', 'Completed')}</span>
      </span>
    </div>
    <p ref={textRef} className={expanded ? undefined : css.clamped}>{task.description}</p>
    <div className={css.meta}>
      {(clamped || expanded) && <button type="button" className={css.expand} aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}>
        {expanded ? t('收起', 'Show less') : t('展开', 'Show more')}
        <IconChevronDownOutlineRegular size={12} className={expanded ? css.expandOpen : undefined} />
      </button>}
      <span>{task.id}</span>
      <span>{t('Owner', 'Owner')}: {task.ownerName ?? t('未分配', 'Unowned')}</span>
      {task.status === 'pending' && <span>{task.ready ? t('可开始', 'Ready') : t('被依赖阻塞', 'Blocked by dependencies')}</span>}
      {task.blockedBy.length > 0 && <span>{t('依赖', 'Blocked by')}: {task.blockedBy.join(', ')}</span>}
      {task.writeScopes.length > 0 && <span>{t('写入范围', 'Write scopes')}: {task.writeScopes.join(', ')}</span>}
      {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
    </div>
  </article>
}
