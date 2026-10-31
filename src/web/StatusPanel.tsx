import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight, Bot, ChevronDown, ChevronRight, Circle, CircleCheck, FileDiff, GitCommitHorizontal,
  ListChecks, Loader, Minimize2, Sparkles, Square, Upload,
} from 'lucide-react'
import {
  Button, Checkbox, HoverCard, IconCheckOutlineRegular, IconEllipsisOutlineRegular, IconGoalOutlineRegular,
  IconPauseOutlineRegular, IconPlayOutlineRegular, Menu, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitWorktreeFile, GitWorktreeStatus, GoalView, SubagentSummary, TodoItem } from '../shared/types.ts'
import type { PlanDocument } from './plan-preview.ts'
import { api } from './api.ts'
import GitBranchSwitcher from './GitBranchSwitcher.tsx'
import type { InspectorDiff } from './transcript.tsx'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './StatusPanel.module.css'

const GIT_POLL_MS = 5_000
const TODO_FOCUS_WINDOW_SIZE = 3
const COMPACT_TODO_THRESHOLD = 6
/** ZCode's auto/panel/mini override, kept per browser like the app's other view preferences. */
const PANEL_MODE_STORAGE = 'pi-web.status-panel-mode'
type PanelMode = 'auto' | 'panel' | 'mini'

function readPanelMode(): PanelMode {
  try {
    const value = window.localStorage.getItem(PANEL_MODE_STORAGE)
    return value === 'panel' || value === 'mini' ? value : 'auto'
  } catch { return 'auto' }
}

export interface StatusPanelProps {
  workspaceId?: string
  conversationId: string
  todos?: readonly TodoItem[] | null
  subagents?: readonly SubagentSummary[]
  /** The conversation's goal; a completed goal leaves both the section and the capsule. */
  goal?: GoalView | null
  /** Every submitted plan, newest first (`sessionPlans`); a row opens the plan in the inspector. */
  plans?: readonly PlanDocument[]
  /** Changes whenever the conversation snapshot advances; used to re-read Git promptly. */
  refreshToken?: string | number
  onOpenSubagent: (childId: string, title?: string) => void
  /** The status footer's door to the subagent directory page. */
  onOpenSubagentDirectory?: () => void
  onOpenPlan?: (plan: PlanDocument) => void
  onGoalAction?: (action: 'pause' | 'resume') => void
  onInspectDiff: (diff: InspectorDiff) => void
  onNotice: (message: string, success?: boolean) => void
  /** Expanded card only: it reserves room in the conversation column. */
  onVisibilityChange?: (visible: boolean) => void
  /** Any content at all, expanded card or capsule; the bottom Todo dock steps aside for both. */
  onContentChange?: (visible: boolean) => void
}

export interface TodoFocusWindow {
  compact: boolean
  preceding: TodoItem[]
  focus: TodoItem[]
  following: TodoItem[]
}

/** ZCode's compact Todo window: keep three rows around the current item, fold the rest. */
export function todoFocusWindow(items: readonly TodoItem[]): TodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return { compact: false, preceding: [], focus: [...items], following: [] }
  }
  const running = items.findIndex(item => item.status === 'in_progress')
  const firstUnfinished = items.findIndex(item => item.status !== 'completed')
  const focusIndex = running >= 0 ? running : firstUnfinished >= 0 ? firstUnfinished : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE)
  const start = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE))
  const end = Math.min(items.length, start + TODO_FOCUS_WINDOW_SIZE)
  return {
    compact: true,
    preceding: items.slice(0, start),
    focus: items.slice(start, end),
    following: items.slice(end),
  }
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback
}

function formatElapsed(ms: number, t: (zh: string, en: string) => string): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t(`${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`, `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`)
  return t(`${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`, `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`)
}

function subagentElapsed(subagent: SubagentSummary, now: number): number | undefined {
  if (subagent.durationMs === undefined) return undefined
  if (subagent.status !== 'running' || subagent.metricsAt === undefined) return subagent.durationMs
  return subagent.durationMs + Math.max(0, now - subagent.metricsAt)
}

/** ZCode marks the running step with a static arrow; a dot reads as "unread" in its vocabulary. */
function todoIcon(status: TodoItem['status']) {
  if (status === 'completed') return <CircleCheck size={14} aria-hidden="true" />
  if (status === 'in_progress') return <ArrowRight size={14} aria-hidden="true" />
  return <Circle size={14} aria-hidden="true" />
}

function goalPhaseLabel(phase: GoalView['phase'], t: (zh: string, en: string) => string): string {
  switch (phase) {
    case 'active': return t('进行中', 'Active')
    case 'paused': return t('已暂停', 'Paused')
    case 'blocked': return t('受阻', 'Blocked')
    case 'complete': return t('已完成', 'Complete')
  }
}

/**
 * ZCode's floating status card: Git worktree, the active goal, submitted plans, the active Todo
 * snapshot and live subagents. It stays inside the chat pane's right margin and only renders when
 * it has something to say.
 */
export default function StatusPanel({
  workspaceId, conversationId, todos, subagents, goal, plans, refreshToken,
  onOpenSubagent, onOpenSubagentDirectory, onOpenPlan, onGoalAction, onInspectDiff, onNotice,
  onVisibilityChange, onContentChange,
}: StatusPanelProps) {
  const { t } = useUiPreferences()
  const [git, setGit] = useState<GitWorktreeStatus | null>(null)
  const [gitError, setGitError] = useState('')
  const [open, setOpen] = useState({ git: true, goal: true, plans: true, todo: true, agent: false })
  const [showAllTodos, setShowAllTodos] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [busyKey, setBusyKey] = useState<string>()
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [includeUnstaged, setIncludeUnstaged] = useState(true)
  const [commitBusy, setCommitBusy] = useState<'commit' | 'push' | 'both'>()
  const [commitError, setCommitError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const hostRef = useRef<HTMLElement | null>(null)
  const gitRequest = useRef(0)
  const [wide, setWide] = useState(false)
  const [mode, setModeState] = useState<PanelMode>(readPanelMode)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)

  const setMode = useCallback((next: PanelMode): void => {
    setModeState(next)
    try { window.localStorage.setItem(PANEL_MODE_STORAGE, next) } catch { /* The panel still switches for this visit. */ }
  }, [])

  const loadGit = useCallback(async (): Promise<void> => {
    if (workspaceId === undefined) {
      setGit(null)
      return
    }
    const ticket = ++gitRequest.current
    try {
      const value = await api.gitWorktreeStatus(workspaceId)
      if (ticket !== gitRequest.current) return
      setGit(value)
      setGitError('')
    } catch (cause) {
      if (ticket !== gitRequest.current) return
      setGitError(errorText(cause, t('无法读取 Git 状态', 'Could not read Git status')))
    }
  }, [workspaceId, t])

  useEffect(() => {
    setGit(null)
    setGitError('')
    setChangesOpen(false)
    setCommitOpen(false)
    setCommitMessage('')
    setCommitError('')
    setGenerating(false)
    setShowAllTodos(false)
  }, [workspaceId, conversationId])

  useEffect(() => {
    if (workspaceId !== undefined) void loadGit()
  }, [workspaceId, refreshToken, loadGit])

  useEffect(() => {
    if (workspaceId === undefined || !wide) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadGit()
    }, GIT_POLL_MS)
    return () => window.clearInterval(timer)
  }, [workspaceId, wide, loadGit])

  const todoItems = todos ?? []
  const planRows = plans ?? []
  const activeGoal = goal !== undefined && goal !== null && goal.phase !== 'complete' ? goal : null
  const runningAgents = useMemo(() => (subagents ?? []).filter(item => item.status === 'running'), [subagents])
  const endedAgents = useMemo(() => (subagents ?? []).filter(item => item.status !== 'running'), [subagents])
  const todoWindow = useMemo(() => todoFocusWindow(todoItems), [todoItems])
  useEffect(() => {
    if (!runningAgents.length) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [runningAgents.length])

  useLayoutEffect(() => {
    const host = hostRef.current?.parentElement
    if (!host) return
    const update = (): void => { setWide(host.getBoundingClientRect().width >= 1120) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const gitChanges = git !== null && git.isRepository && (git.dirtyFileCount > 0 || git.ahead > 0)
  const doneCount = todoItems.filter(item => item.status === 'completed').length
  const hasContent = gitChanges || todoItems.length > 0 || planRows.length > 0 || activeGoal !== null
    || runningAgents.length > 0 || endedAgents.length > 0
  // ZCode's display modes: `auto` expands on a wide conversation column and falls back to the
  // capsule; `panel` always expands; `mini` is the capsule until the user expands it again.
  const expanded = hasContent && (mode === 'panel' || (mode === 'auto' && wide))
  const capsule = hasContent && !expanded
  useEffect(() => { onVisibilityChange?.(expanded) }, [expanded, onVisibilityChange])
  useEffect(() => () => { onVisibilityChange?.(false) }, [onVisibilityChange])
  useEffect(() => { onContentChange?.(hasContent) }, [hasContent, onContentChange])
  useEffect(() => () => { onContentChange?.(false) }, [onContentChange])

  const inspectFile = async (file: GitWorktreeFile): Promise<void> => {
    if (workspaceId === undefined || busyKey !== undefined) return
    setBusyKey(file.path)
    try {
      const result = await api.gitWorktreeDiff(workspaceId, file.path)
      onInspectDiff({
        path: result.path,
        ...(result.diff === undefined ? { newText: result.newText ?? '' } : { diff: result.diff }),
      })
    } catch (cause) {
      onNotice(errorText(cause, t('无法读取文件差异', 'Could not read the file diff')))
    } finally {
      setBusyKey(undefined)
    }
  }

  const openCommit = (): void => {
    setCommitError('')
    setCommitMessage('')
    setIncludeUnstaged(true)
    setCommitOpen(true)
  }

  const generateMessage = async (): Promise<void> => {
    if (workspaceId === undefined || generating || commitBusy !== undefined) return
    setGenerating(true)
    setCommitError('')
    try {
      const result = await api.gitCommitMessage(workspaceId, { conversationId, includeUnstaged })
      setCommitMessage(result.message)
    } catch (cause) {
      setCommitError(errorText(cause, t('无法生成提交信息', 'Could not generate a commit message')))
    } finally {
      setGenerating(false)
    }
  }

  const runCommit = async (pushAfter: boolean): Promise<void> => {
    if (workspaceId === undefined || commitBusy !== undefined) return
    if (commitMessage.trim() === '') {
      setCommitError(t('请输入提交信息', 'Enter a commit message'))
      return
    }
    setCommitBusy(pushAfter ? 'both' : 'commit')
    setCommitError('')
    try {
      const result = await api.gitCommit(workspaceId, { message: commitMessage, includeUnstaged })
      if (!result.ok) {
        setCommitError(result.error ?? t('提交失败', 'Commit failed'))
        return
      }
      setGit(result.status)
      setCommitOpen(false)
      if (pushAfter) {
        const pushed = await api.gitPush(workspaceId)
        onNotice(pushed.ok
          ? t('已提交并推送', 'Committed and pushed')
          : t(`已提交，但推送失败：${pushed.error ?? ''}`, `Committed, but the push failed: ${pushed.error ?? ''}`), pushed.ok)
      } else {
        onNotice(result.commitHash === null ? t('已提交', 'Committed') : t(`已提交 ${result.commitHash}`, `Committed ${result.commitHash}`), true)
      }
    } catch (cause) {
      setCommitError(errorText(cause, t('提交失败', 'Commit failed')))
    } finally {
      setCommitBusy(undefined)
    }
  }

  const runPush = async (quiet = false): Promise<void> => {
    if (workspaceId === undefined || commitBusy !== undefined) return
    if (!quiet) {
      setCommitBusy('push')
      setCommitError('')
    }
    try {
      const result = await api.gitPush(workspaceId)
      if (!result.ok) {
        if (quiet) onNotice(result.error ?? t('推送失败', 'Push failed'))
        else setCommitError(result.error ?? t('推送失败', 'Push failed'))
        return
      }
      setCommitOpen(false)
      onNotice(t('已推送', 'Pushed'), true)
      void loadGit()
    } catch (cause) {
      const message = errorText(cause, t('推送失败', 'Push failed'))
      if (quiet) onNotice(message)
      else setCommitError(message)
    } finally {
      setCommitBusy(undefined)
    }
  }

  const stopAgent = async (subagent: SubagentSummary): Promise<void> => {
    setBusyKey(`agent:${subagent.id}`)
    try {
      await api.childStop(conversationId, subagent.id)
      onNotice(t('正在停止子智能体', 'Stopping the subagent'))
    } catch (cause) {
      onNotice(errorText(cause, t('无法停止子智能体', 'Could not stop the subagent')))
    } finally {
      setBusyKey(undefined)
    }
  }

  const toggle = (key: keyof typeof open): void => { setOpen(current => ({ ...current, [key]: !current[key] })) }
  const visibleTodos = todoWindow.compact && !showAllTodos ? todoWindow.focus : todoItems
  const activeTodo = todoItems.find(item => item.status === 'in_progress')
  const firstPendingTodo = todoItems.find(item => item.status === 'pending')
  const lastCompletedTodo = [...todoItems].reverse().find(item => item.status === 'completed')
  const todoProgress = <span className={css.capsuleCount}>{doneCount}/{todoItems.length}</span>
  // ZCode's capsule leans on the most actionable fact first. Todos stay ahead of the goal and the
  // Git summary because the capsule also replaces the bottom Todo dock here: nothing about Todo
  // progress may become invisible just because a goal or a branch has something to say.
  const capsuleSummary = (): ReactNode => {
    if (activeTodo !== undefined) return <>
      <ArrowRight size={14} aria-hidden="true" />
      <span className={css.capsuleText}>{activeTodo.content}</span>
      {todoProgress}
    </>
    if (firstPendingTodo !== undefined) return <>
      <Circle size={14} aria-hidden="true" />
      <span className={css.capsuleText}>{firstPendingTodo.content}</span>
      {todoProgress}
    </>
    if (lastCompletedTodo !== undefined) return <>
      <CircleCheck size={14} aria-hidden="true" />
      <span className={css.capsuleText}>{lastCompletedTodo.content}</span>
      {todoProgress}
    </>
    if (activeGoal !== null) return <>
      <IconGoalOutlineRegular size={14} />
      <span className={css.capsuleText}>{activeGoal.phase === 'blocked' && activeGoal.blockedReason !== undefined
        ? activeGoal.blockedReason
        : activeGoal.objective}</span>
    </>
    if (runningAgents.length > 0) return <>
      <Bot size={14} aria-hidden="true" />
      <span className={css.capsuleText}>{t(`${runningAgents.length} 个智能体运行中`, `${runningAgents.length} agents running`)}</span>
    </>
    if (gitChanges && git !== null) return <>
      <FileDiff size={14} aria-hidden="true" />
      <span className={css.capsuleText}>{t('更改', 'Changes')}</span>
      <span className={css.capsuleAdded}>+{git.added}</span>
      <span className={css.capsuleRemoved}>−{git.removed}</span>
    </>
    if (endedAgents.length > 0) return <>
      <Bot size={14} aria-hidden="true" />
      <span className={css.capsuleText}>{t('已结束的智能体', 'Ended agents')}</span>
      <span className={css.capsuleCount}>{endedAgents.length}</span>
    </>
    // A plan-only conversation must still have something to click: ZCode's last fallback is the
    // latest session plan, and without it the capsule renders as an empty 32px shell.
    if (planRows[0] !== undefined) return <>
      <ListChecks size={14} aria-hidden="true" />
      <span className={css.capsuleText}>{planRows[0].title ?? t('计划', 'Plan')}</span>
    </>
    return null
  }
  const capsuleContent = capsule ? capsuleSummary() : null

  return <aside ref={hostRef} className={expanded ? css.panel : css.capsuleShell} aria-label={t('状态', 'Status')}
    data-status-panel data-display-mode={expanded ? mode : 'mini'} data-capsule={capsule || undefined}
    style={hasContent ? undefined : { display: 'none' }}>
    {expanded && <div className={css.panelControls}>
      <Menu open={modeMenuOpen} onClose={() => { setModeMenuOpen(false) }} portal
        items={[
          { id: 'auto', label: t('自动（宽屏展开）', 'Auto'), icon: mode === 'auto' ? <IconCheckOutlineRegular size={14} /> : undefined },
          { id: 'panel', label: t('常驻展开', 'Always expanded'), icon: mode === 'panel' ? <IconCheckOutlineRegular size={14} /> : undefined },
        ]}
        onSelect={id => {
          setModeMenuOpen(false)
          if (id === 'auto' || id === 'panel') setMode(id)
        }}
        anchor={<button type="button" className={css.panelControl} aria-label={t('显示方式', 'Display mode')}
          aria-haspopup="menu" aria-expanded={modeMenuOpen} onClick={() => { setModeMenuOpen(value => !value) }}>
          <IconEllipsisOutlineRegular size={14} />
        </button>} />
      <button type="button" className={css.panelControl} aria-label={t('收起为胶囊', 'Collapse to capsule')}
        onClick={() => { setMode('mini') }}>
        <Minimize2 size={14} aria-hidden="true" />
      </button>
    </div>}
    {expanded && <div className={css.sections}>
      {gitChanges && <section className={css.section} data-status-section="git">
        <SectionHeader title={t('Git 工具', 'Git tools')} open={open.git} onToggle={() => { toggle('git') }}
          trailing={open.git ? undefined : <span className={css.trailingCounts}>
            <span className={css.added}>+{git.added}</span> <span className={css.removed}>−{git.removed}</span>
          </span>} />
        {open.git && <div className={css.sectionBody}>
          <button type="button" className={css.row} onClick={() => { setChangesOpen(value => !value) }}
            aria-expanded={changesOpen} disabled={git.files.length === 0}>
            <FileDiff size={15} aria-hidden="true" />
            <span className={css.rowLabel}>{t('更改', 'Changes')}</span>
            <span className={css.trailingCounts}>
              <span className={css.added}>+{git.added}</span> <span className={css.removed}>−{git.removed}</span>
            </span>
            {git.files.length > 0 && (changesOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />)}
          </button>
          {changesOpen && <div className={css.changedList}>
            {git.files.map(file => <button key={file.path} type="button" className={css.changedRow} title={file.path}
              disabled={busyKey !== undefined} onClick={() => { void inspectFile(file) }}>
              <span className={css.changedPath}>{file.path}</span>
              <span className={css.trailingCounts}><span className={css.added}>+{file.added}</span> <span className={css.removed}>−{file.removed}</span></span>
              {busyKey === file.path ? <Loader size={12} className={css.spin} aria-hidden="true" /> : <FileDiff size={12} aria-hidden="true" />}
            </button>)}
          </div>}
          <div className={css.branchRow}>
            <GitBranchSwitcher workspaceId={workspaceId} compact side="bottom" />
          </div>
          <button type="button" className={css.row} onClick={openCommit}>
            <Upload size={15} aria-hidden="true" />
            <span className={css.rowLabel}>{t('提交或推送', 'Commit or push')}</span>
          </button>
          {gitError !== '' && <p className={css.error} role="alert">{gitError}</p>}
        </div>}
      </section>}

      {activeGoal !== null && <section className={css.section} data-status-section="goal">
        <SectionHeader title={t('目标', 'Goal')} open={open.goal} onToggle={() => { toggle('goal') }}
          trailing={<span className={css.goalTrailing}>
            <span className={css.trailingCount} data-goal-phase={activeGoal.phase}>{goalPhaseLabel(activeGoal.phase, t)}</span>
            <span className={css.goalSeparator} aria-hidden="true">·</span>
            <span className={css.trailingNumeric}>{t(`${activeGoal.roundsStarted}/${activeGoal.maxGoalRounds} 轮`, `${activeGoal.roundsStarted}/${activeGoal.maxGoalRounds} rounds`)}</span>
            {onGoalAction !== undefined && <button type="button" className={css.goalControl}
              aria-label={activeGoal.phase === 'active' ? t('暂停目标', 'Pause goal') : t('恢复目标', 'Resume goal')}
              title={activeGoal.phase === 'active' ? t('暂停目标', 'Pause goal') : t('恢复目标', 'Resume goal')}
              onClick={() => { onGoalAction(activeGoal.phase === 'active' ? 'pause' : 'resume') }}>
              {activeGoal.phase === 'active'
                ? <IconPauseOutlineRegular size={13} />
                : <IconPlayOutlineRegular size={13} />}
            </button>}
          </span>} />
        {open.goal && <div className={css.sectionBody}>
          <div className={css.goalRow} data-goal-phase={activeGoal.phase}>
            <IconGoalOutlineRegular size={15} className={css.goalIcon} />
            <span className={css.goalObjective}>{activeGoal.objective}</span>
          </div>
          {activeGoal.phase === 'blocked' && activeGoal.blockedReason !== undefined
            && <p className={css.goalReason}>{activeGoal.blockedReason}</p>}
        </div>}
      </section>}

      {planRows.length > 0 && <section className={css.section} data-status-section="plans">
        <SectionHeader title={t('计划', 'Plans')} open={open.plans} onToggle={() => { toggle('plans') }}
          trailing={<span className={`${css.trailingCount} ${css.trailingNumeric}`}>{planRows.length}</span>} />
        {open.plans && <div className={`${css.sectionBody} ${css.planBody}`}>
          {planRows.map((plan, index) => <button key={plan.key ?? `${index}:${plan.markdown.slice(0, 32)}`} type="button"
            className={css.row} title={plan.title ?? t('计划', 'Plan')}
            disabled={onOpenPlan === undefined} onClick={() => { onOpenPlan?.(plan) }}>
            <ListChecks size={15} aria-hidden="true" />
            <span className={css.rowLabel}>{plan.title ?? t('计划', 'Plan')}</span>
            {plan.pending === true && <span className={css.planPending}>{t('待批', 'Pending')}</span>}
          </button>)}
        </div>}
      </section>}

      {todoItems.length > 0 && <section className={css.section} data-status-section="todo">
        <SectionHeader title={t('进程', 'Process')} open={open.todo} onToggle={() => { toggle('todo') }}
          trailing={<span className={`${css.trailingCount} ${css.trailingNumeric}`}
            data-complete={doneCount === todoItems.length || undefined}>{doneCount}/{todoItems.length}</span>} />
        {open.todo && <div className={`${css.sectionBody} ${css.todoBody}`}>
          {todoWindow.compact && !showAllTodos && todoWindow.preceding.length > 0 && <TodoGroupFold
            group="preceding" items={todoWindow.preceding}
            label={todoWindow.preceding.every(item => item.status === 'completed')
              ? t(`已完成 ${todoWindow.preceding.length} 项`, `${todoWindow.preceding.length} completed`)
              : t(`前面 ${todoWindow.preceding.length} 项`, `${todoWindow.preceding.length} earlier`)}
            onExpand={() => { setShowAllTodos(true) }} />}
          {visibleTodos.map((item, index) => <div key={`${item.content}:${index}`} className={css.todoRow} data-status={item.status}>
            <span className={css.todoIcon}>{todoIcon(item.status)}</span>
            <span className={css.todoText}>{item.content}</span>
          </div>)}
          {todoWindow.compact && !showAllTodos && todoWindow.following.length > 0 && <TodoGroupFold
            group="following" items={todoWindow.following}
            label={todoWindow.following.every(item => item.status === 'pending')
              ? t(`待处理 ${todoWindow.following.length} 项`, `${todoWindow.following.length} pending`)
              : t(`后面 ${todoWindow.following.length} 项`, `${todoWindow.following.length} later`)}
            onExpand={() => { setShowAllTodos(true) }} />}
          {todoWindow.compact && showAllTodos && <button type="button" className={css.foldRow} onClick={() => { setShowAllTodos(false) }}>
            <ChevronRight size={12} aria-hidden="true" /> {t('收起', 'Collapse')}
          </button>}
        </div>}
      </section>}

      {(runningAgents.length > 0 || endedAgents.length > 0) && <section className={css.section} data-status-section="agents">
        <SectionHeader title={t('智能体', 'Agents')} open={open.agent} onToggle={() => { toggle('agent') }}
          trailing={<span className={css.trailingCount}>{runningAgents.length > 0
            ? t(`${runningAgents.length} 运行`, `${runningAgents.length} running`)
            : t(`${endedAgents.length} 已结束`, `${endedAgents.length} ended`)}</span>} />
        {open.agent && <div className={css.sectionBody}>
          {runningAgents.map(agent => {
            const elapsed = subagentElapsed(agent, now)
            return <div key={agent.id} className={css.agentRow} data-status="running">
              <Bot size={15} aria-hidden="true" />
              <button type="button" className={css.agentOpen} onClick={() => { onOpenSubagent(agent.id, agent.title || agent.label) }}>
                <span className={css.agentTitle}>{agent.title || agent.label}</span>
                {elapsed !== undefined && <span className={css.agentElapsed}>{formatElapsed(elapsed, t)}</span>}
              </button>
              <button type="button" className={css.stopButton} aria-label={t('停止子智能体', 'Stop subagent')}
                disabled={busyKey === `agent:${agent.id}`} onClick={() => { void stopAgent(agent) }}>
                {busyKey === `agent:${agent.id}` ? <Loader size={12} className={css.spin} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
                {t('停止', 'Stop')}
              </button>
            </div>
          })}
          {endedAgents.length > 0 && <button type="button" className={css.endedDirectory}
            disabled={onOpenSubagentDirectory === undefined}
            onClick={() => { onOpenSubagentDirectory?.() }}>
            <CircleCheck size={15} aria-hidden="true" />
            <span className={css.rowLabel}>{t('已结束的智能体', 'Ended agents')}</span>
            <span className={css.trailingCount}>{endedAgents.length}</span>
            <ChevronRight size={13} aria-hidden="true" />
          </button>}
        </div>}
      </section>}
    </div>}

    {capsuleContent !== null && <button type="button" className={css.capsule} onClick={() => { setMode('panel') }}
      aria-label={t('展开状态面板', 'Expand the status panel')} data-status-capsule>
      {capsuleContent}
    </button>}

    {expanded && <Modal open={commitOpen} onClose={() => { if (commitBusy === undefined) setCommitOpen(false) }}
      title={t('提交或推送', 'Commit or push')}
      className={css.commitModal}
      description={git?.branchName === null || git === null
        ? t('把当前工作区的改动提交到 Git，或推送当前分支。', 'Commit workspace changes to Git, or push the current branch.')
        : t(`分支 ${git.branchName} · ${git.dirtyFileCount} 个文件 · +${git.added} −${git.removed}`, `Branch ${git.branchName} · ${git.dirtyFileCount} files · +${git.added} −${git.removed}`)}
      closeLabel={t('关闭', 'Close')}
      footer={<>
        <Button variant="ghost" disabled={commitBusy !== undefined || generating} onClick={() => { setCommitOpen(false) }}>{t('取消', 'Cancel')}</Button>
        <Button variant="outline" disabled={commitBusy !== undefined || generating || git === null} onClick={() => { void runPush() }}>
          {commitBusy === 'push' ? <Loader size={13} className={css.spin} /> : <Upload size={13} />}{t('推送', 'Push')}
        </Button>
        <Button variant="primary" disabled={commitBusy !== undefined || generating || commitMessage.trim() === ''} onClick={() => { void runCommit(false) }}>
          {commitBusy === 'commit' ? <Loader size={13} className={css.spin} /> : <GitCommitHorizontal size={13} />}{t('提交', 'Commit')}
        </Button>
        <Button variant="primary" disabled={commitBusy !== undefined || generating || commitMessage.trim() === ''} onClick={() => { void runCommit(true) }}>
          {commitBusy === 'both' ? <Loader size={13} className={css.spin} /> : <Upload size={13} />}{t('提交并推送', 'Commit and push')}
        </Button>
      </>}>
      <div className={css.commitHeader}>
        <span>{t('提交信息', 'Commit message')}</span>
        <button type="button" className={css.generateButton} disabled={generating || commitBusy !== undefined}
          onClick={() => { void generateMessage() }}>
          {generating ? <Loader size={12} className={css.spin} aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}
          {generating ? t('生成中…', 'Generating…') : t('AI 生成', 'Generate')}
        </button>
      </div>
      <textarea className={css.commitInput} rows={4} autoFocus value={commitMessage}
        placeholder={t('描述这次改动…', 'Describe this change…')} aria-label={t('提交信息', 'Commit message')}
        onChange={event => { setCommitMessage(event.currentTarget.value); setCommitError('') }} />
      <div className={css.commitOptions}>
        <Checkbox label={t('包含未暂存的改动', 'Include unstaged changes')} checked={includeUnstaged} onChange={setIncludeUnstaged} />
      </div>
      {commitError !== '' && <p className={css.commitError} role="alert">{commitError}</p>}
    </Modal>}
  </aside>
}

function SectionHeader({ title, open, onToggle, trailing }: {
  title: string
  open: boolean
  onToggle: () => void
  trailing?: ReactNode
}) {
  return <div className={css.sectionHeader}>
    <button type="button" className={css.sectionTrigger} aria-expanded={open} onClick={onToggle}>
      <span>{title}</span>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
    </button>
    {trailing !== undefined && <div className={css.sectionTrailing}>{trailing}</div>}
  </div>
}

/** A folded Todo group: the label expands in place, hovering previews the hidden rows (ZCode). */
function TodoGroupFold({ group, items, label, onExpand }: {
  group: 'preceding' | 'following'
  items: readonly TodoItem[]
  label: string
  onExpand: () => void
}) {
  return <HoverCard variant="preview" openDelayMs={140}
    content={<div className={css.foldPreview}>
      <p className={css.foldPreviewTitle}>{label}</p>
      <ul className={css.foldPreviewList}>{items.map((item, index) => <li key={`${item.content}:${index}`}
        className={css.foldPreviewRow} data-status={item.status}>
        <span className={css.todoIcon}>{todoIcon(item.status)}</span>
        <span className={css.foldPreviewText}>{item.content}</span>
      </li>)}</ul>
    </div>}
    anchor={<button type="button" className={css.foldRow} onClick={onExpand} aria-label={label}>
      {group === 'preceding' ? <ChevronLeft /> : <ChevronRight size={12} aria-hidden="true" />}
      <span className={css.foldLabel}>{label}</span>
    </button>} />
}

/** A small chevron that only labels the folded Todo groups. */
function ChevronLeft() {
  return <span className={css.foldChevron} aria-hidden="true">‹</span>
}
