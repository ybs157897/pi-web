import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bot, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, FileDiff, GitCommitHorizontal,
  Loader, Sparkles, Square, Upload,
} from 'lucide-react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitWorktreeFile, GitWorktreeStatus, SubagentSummary, TodoItem } from '../shared/types.ts'
import { api } from './api.ts'
import GitBranchSwitcher from './GitBranchSwitcher.tsx'
import type { InspectorDiff } from './transcript.tsx'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './StatusPanel.module.css'

const GIT_POLL_MS = 5_000
const TODO_FOCUS_WINDOW_SIZE = 3
const COMPACT_TODO_THRESHOLD = 6

export interface StatusPanelProps {
  workspaceId?: string
  conversationId: string
  todos?: readonly TodoItem[] | null
  subagents?: readonly SubagentSummary[]
  /** Changes whenever the conversation snapshot advances; used to re-read Git promptly. */
  refreshToken?: string | number
  onOpenSubagent: (childId: string, title?: string) => void
  onInspectDiff: (diff: InspectorDiff) => void
  onNotice: (message: string, success?: boolean) => void
  /** Lets the chat column reserve room for the expanded card. */
  onVisibilityChange?: (visible: boolean) => void
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

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

function agentMetrics(agent: SubagentSummary, t: (zh: string, en: string) => string): string {
  const parts: string[] = []
  if (agent.tokens !== undefined) parts.push(t(`${formatTokens(agent.tokens)} tok`, `${formatTokens(agent.tokens)} tok`))
  if (agent.durationMs !== undefined) parts.push(formatElapsed(agent.durationMs, t))
  return parts.join(' · ')
}

function todoIcon(status: TodoItem['status']) {
  if (status === 'completed') return <CircleCheck size={15} aria-hidden="true" />
  if (status === 'in_progress') return <CircleDot size={15} aria-hidden="true" />
  return <Circle size={15} aria-hidden="true" />
}

/**
 * ZCode's floating status card: Git worktree, the active Todo snapshot and live subagents.
 * It stays inside the chat pane's right margin and only renders when it has something to say.
 */
export default function StatusPanel({
  workspaceId, conversationId, todos, subagents, refreshToken, onOpenSubagent, onInspectDiff, onNotice, onVisibilityChange,
}: StatusPanelProps) {
  const { t } = useUiPreferences()
  const [git, setGit] = useState<GitWorktreeStatus | null>(null)
  const [gitError, setGitError] = useState('')
  const [open, setOpen] = useState({ git: true, todo: true, agent: false })
  const [showAllTodos, setShowAllTodos] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [busyKey, setBusyKey] = useState<string>()
  const [endedAgentsOpen, setEndedAgentsOpen] = useState(false)
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
    setEndedAgentsOpen(false)
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
  const hasContent = gitChanges || todoItems.length > 0 || runningAgents.length > 0 || endedAgents.length > 0
  const visible = hasContent && wide
  useEffect(() => { onVisibilityChange?.(visible) }, [visible, onVisibilityChange])
  useEffect(() => () => { onVisibilityChange?.(false) }, [onVisibilityChange])

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

  return <aside ref={hostRef} className={css.panel} aria-label={t('状态', 'Status')} data-status-panel
    style={visible ? undefined : { display: 'none' }}>
    {visible && <div className={css.sections}>
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

      {todoItems.length > 0 && <section className={css.section} data-status-section="todo">
        <SectionHeader title={t('进程', 'Process')} open={open.todo} onToggle={() => { toggle('todo') }}
          trailing={<span className={css.trailingCount}>{doneCount}/{todoItems.length}</span>} />
        {open.todo && <div className={`${css.sectionBody} ${css.todoBody}`}>
          {todoWindow.compact && !showAllTodos && todoWindow.preceding.length > 0 && <button type="button" className={css.foldRow}
            onClick={() => { setShowAllTodos(true) }}>
            <ChevronLeft /> {todoWindow.preceding.every(item => item.status === 'completed')
              ? t(`已完成 ${todoWindow.preceding.length} 项`, `${todoWindow.preceding.length} completed`)
              : t(`前面 ${todoWindow.preceding.length} 项`, `${todoWindow.preceding.length} earlier`)}
          </button>}
          {visibleTodos.map((item, index) => <div key={`${item.content}:${index}`} className={css.todoRow} data-status={item.status}>
            <span className={css.todoIcon}>{todoIcon(item.status)}</span>
            <span className={css.todoText}>{item.content}</span>
          </div>)}
          {todoWindow.compact && !showAllTodos && todoWindow.following.length > 0 && <button type="button" className={css.foldRow}
            onClick={() => { setShowAllTodos(true) }}>
            <ChevronRight size={12} aria-hidden="true" /> {todoWindow.following.every(item => item.status === 'pending')
              ? t(`待处理 ${todoWindow.following.length} 项`, `${todoWindow.following.length} pending`)
              : t(`后面 ${todoWindow.following.length} 项`, `${todoWindow.following.length} later`)}
          </button>}
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
          {endedAgents.length > 0 && <button type="button" className={css.endedFold} aria-expanded={endedAgentsOpen}
            onClick={() => { setEndedAgentsOpen(value => !value) }}>
            {endedAgentsOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {t(`已结束的智能体 · ${endedAgents.length}`, `Ended agents · ${endedAgents.length}`)}
          </button>}
          {endedAgentsOpen && endedAgents.map(agent => <button key={agent.id} type="button" className={css.endedRow}
            onClick={() => { onOpenSubagent(agent.id, agent.title || agent.label) }}>
            <CircleCheck size={15} aria-hidden="true" />
            <span className={css.agentOpen}>
              <span className={css.agentTitle}>{agent.title || agent.label}</span>
              <span className={css.agentElapsed}>{agentMetrics(agent, t)}</span>
            </span>
            <ChevronRight size={13} aria-hidden="true" />
          </button>)}
        </div>}
      </section>}
    </div>}

    {visible && <Modal open={commitOpen} onClose={() => { if (commitBusy === undefined) setCommitOpen(false) }}
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
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
    </button>
    {trailing !== undefined && <div className={css.sectionTrailing}>{trailing}</div>}
  </div>
}

/** A small chevron that only labels the folded Todo groups. */
function ChevronLeft() {
  return <span className={css.foldChevron} aria-hidden="true">‹</span>
}
