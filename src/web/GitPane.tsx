import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileDiff, FileText, Loader, RefreshCw } from 'lucide-react'
import { CodeBlock, DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitChangeSourceId, GitWorktreeFile, GitWorktreeStatus } from '../shared/types.ts'

// The inspector shell renders this pane and types its props against the same source ids.
export type { GitChangeSourceId }
import { api } from './api.ts'
import { diffLabels, markdownLabels, type Translate } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './GitPane.module.css'

/**
 * ZCode's review pane: one source dropdown (unstaged / staged / branch / last turn) above a flat
 * list of 32px file rows. Diffs load lazily per row and cache under `source:path`; only one row
 * expands at a time, and `last-turn` renders purely from the conversation's own before/after texts.
 */
export interface LastTurnChange {
  path: string
  added: number
  removed: number
  before?: string
  after?: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed'
}

export interface GitPaneProps {
  workspaceId: string
  activeSource: GitChangeSourceId
  onSelectSource: (source: GitChangeSourceId) => void
  /** This turn's file changes, synthesized by the app; undefined = no conversation context. */
  lastTurnChanges?: readonly LastTurnChange[]
  onNotice: (text: string) => void
}

/** ZCode's review sources in dropdown order; the last-turn option stays disabled without data. */
export interface SourceOption { id: GitChangeSourceId; disabled: boolean }

export function sourceOptions(hasLastTurnData: boolean): SourceOption[] {
  return [
    { id: 'unstaged', disabled: false },
    { id: 'staged', disabled: false },
    { id: 'branch', disabled: false },
    { id: 'last-turn', disabled: !hasLastTurnData },
  ]
}

export function sourceLabel(source: GitChangeSourceId, t: Translate): string {
  switch (source) {
    case 'unstaged': return t('未暂存', 'Unstaged')
    case 'staged': return t('已暂存', 'Staged')
    case 'branch': return t('全部分支更改', 'All branch changes')
    case 'last-turn': return t('上一轮更改', 'Last turn')
  }
}

/** Cache identity for a lazily loaded diff: the same path diffs differently per source. */
export function diffCacheKey(source: GitChangeSourceId, path: string): string {
  return `${source}:${path}`
}

/** No section headers: untracked/conflicted only decide where a row sorts (ZCode order). */
const STATUS_ORDER: Record<GitWorktreeFile['status'], number> = {
  conflicted: 0, modified: 1, added: 1, deleted: 1, renamed: 1, untracked: 2,
}

/** The rows one Git source shows: unstaged/staged split `files`, branch uses the upstream range. */
export function sourceFileList(source: Exclude<GitChangeSourceId, 'last-turn'>, status: GitWorktreeStatus | null): GitWorktreeFile[] {
  if (status === null || !status.isRepository) return []
  const files = source === 'unstaged'
    ? status.files.filter(file => !file.staged)
    : source === 'staged'
      ? status.files.filter(file => file.staged)
      : status.branchFiles ?? []
  return [...files].sort((first, second) =>
    (STATUS_ORDER[first.status] - STATUS_ORDER[second.status]) || first.path.localeCompare(second.path))
}

/** ZCode lists last-turn rows alphabetically like every other source. */
export function sortLastTurnChanges(changes: readonly LastTurnChange[]): LastTurnChange[] {
  return [...changes].sort((first, second) => first.path.localeCompare(second.path))
}

/** Before/after texts for a locally rendered last-turn diff; null when neither side carries text. */
export function lastTurnDiffTexts(change: LastTurnChange): { oldText: string; newText: string } | null {
  if (change.before === undefined && change.after === undefined) return null
  return { oldText: change.before ?? '', newText: change.after ?? '' }
}

export type PaneEmptyState = 'last-turn-empty' | 'not-repository' | 'generic'

/** ZCode's empty-state priority: last-turn copy, then the not-a-repository note, then generic. */
export function paneEmptyState(source: GitChangeSourceId, status: GitWorktreeStatus | null,
  lastTurnChanges: readonly LastTurnChange[] | undefined, rowCount: number): PaneEmptyState | null {
  if (rowCount > 0) return null
  if (source === 'last-turn') return lastTurnChanges !== undefined ? 'last-turn-empty' : 'generic'
  if (status !== null && !status.isRepository) return 'not-repository'
  return 'generic'
}

/** Same vocabulary as the inspector's file view, so both surfaces render one file the same way. */
function languageFromPath(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase()
  if (extension === undefined || extension === path.toLocaleLowerCase()) return undefined
  const aliases: Record<string, string> = {
    cjs: 'javascript', htm: 'html', md: 'markdown', mjs: 'javascript', py: 'python', rs: 'rust', sh: 'bash', tsx: 'tsx', yml: 'yaml',
  }
  return aliases[extension] ?? extension
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback
}

interface PaneRow { path: string; added: number; removed: number }

/** A lazily loaded Git diff; errors stay cached so a failed row keeps explaining itself. */
interface DiffEntry { value?: Awaited<ReturnType<typeof api.gitWorktreeDiff>>; error?: string }

export default function GitPane({ workspaceId, activeSource, onSelectSource, lastTurnChanges, onNotice }: GitPaneProps) {
  const { t } = useUiPreferences()
  const [status, setStatus] = useState<GitWorktreeStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [loading, setLoading] = useState(false)
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  // The diff cache lives in refs (Map keyed by `source:path`) with a version tick for re-renders,
  // so in-flight requests can dedupe against the authoritative set instead of stale state.
  const cacheRef = useRef(new Map<string, DiffEntry>())
  const pendingRef = useRef(new Set<string>())
  const [, bumpCacheVersion] = useState(0)
  const statusTicket = useRef(0)

  const loadStatus = useCallback(async (): Promise<void> => {
    const ticket = ++statusTicket.current
    setLoading(true)
    try {
      const value = await api.gitWorktreeStatus(workspaceId)
      if (ticket !== statusTicket.current) return
      setStatus(value)
      setStatusError('')
    } catch (cause) {
      if (ticket !== statusTicket.current) return
      setStatusError(errorText(cause, t('无法读取 Git 状态', 'Could not read Git status')))
    } finally {
      if (ticket === statusTicket.current) setLoading(false)
    }
  }, [workspaceId, t])

  useEffect(() => { void loadStatus() }, [loadStatus])

  // ZCode collapses the open row when the source changes; the diff cache survives, keyed per source.
  useEffect(() => { setExpandedPath(null) }, [activeSource])

  const refresh = useCallback(async (): Promise<void> => {
    cacheRef.current = new Map()
    setExpandedPath(null)
    await loadStatus()
  }, [loadStatus])

  const ensureDiff = useCallback(async (source: Exclude<GitChangeSourceId, 'last-turn'>, path: string): Promise<void> => {
    const key = diffCacheKey(source, path)
    if (cacheRef.current.has(key) || pendingRef.current.has(key)) return
    pendingRef.current.add(key)
    bumpCacheVersion(version => version + 1)
    try {
      const value = await api.gitWorktreeDiff(workspaceId, path, source)
      cacheRef.current.set(key, { value })
    } catch (cause) {
      const message = errorText(cause, t('无法读取文件差异', 'Could not read the file diff'))
      cacheRef.current.set(key, { error: message })
      onNotice(message)
    } finally {
      pendingRef.current.delete(key)
      bumpCacheVersion(version => version + 1)
    }
  }, [workspaceId, t, onNotice])

  const rows = useMemo<PaneRow[]>(() => {
    if (activeSource === 'last-turn') {
      return sortLastTurnChanges(lastTurnChanges ?? []).map(change =>
        ({ path: change.path, added: change.added, removed: change.removed }))
    }
    return sourceFileList(activeSource, status)
  }, [activeSource, status, lastTurnChanges])

  // A file that vanishes from the list must not keep its diff open (ZCode auto-collapse).
  useEffect(() => {
    if (expandedPath !== null && !rows.some(row => row.path === expandedPath)) setExpandedPath(null)
  }, [rows, expandedPath])

  const toggleRow = (path: string): void => {
    if (expandedPath === path) {
      setExpandedPath(null)
      return
    }
    setExpandedPath(path)
    if (activeSource !== 'last-turn') void ensureDiff(activeSource, path)
  }

  const emptyState = paneEmptyState(activeSource, status, lastTurnChanges, rows.length)
  const lastTurnByPath = useMemo(() => new Map((lastTurnChanges ?? []).map(change => [change.path, change])), [lastTurnChanges])
  const loadingStatus = activeSource !== 'last-turn' && statusError === '' && status === null

  return <div className={css.pane} data-git-pane>
    <header className={css.header}>
      <span className={css.sourceWrap}>
        <select className={css.sourceSelect} value={activeSource} aria-label={t('更改来源', 'Change source')}
          onChange={event => { onSelectSource(event.currentTarget.value as GitChangeSourceId) }}>
          {sourceOptions(lastTurnChanges !== undefined).map(option =>
            <option key={option.id} value={option.id} disabled={option.disabled}>{sourceLabel(option.id, t)}</option>)}
        </select>
        <ChevronDown size={13} className={css.selectChevron} aria-hidden="true" />
      </span>
      <button type="button" className={css.refresh} aria-label={t('刷新', 'Refresh')} onClick={() => { void refresh() }}>
        <RefreshCw size={14} className={loading ? css.spin : undefined} aria-hidden="true" />
      </button>
    </header>
    <div className={css.list}>
      {activeSource !== 'last-turn' && statusError !== '' && <div className={css.noteLine} role="alert">{statusError}</div>}
      {loadingStatus && <div className={css.emptyState} role="status"><Loader size={16} className={css.spin} aria-hidden="true" /></div>}
      {rows.map(row => <Fragment key={row.path}>
        <FileRow row={row} expanded={expandedPath === row.path} onToggle={() => { toggleRow(row.path) }} />
        {expandedPath === row.path && <DiffBody activeSource={activeSource} path={row.path}
          entry={activeSource === 'last-turn' ? undefined : cacheRef.current.get(diffCacheKey(activeSource, row.path))}
          pending={activeSource !== 'last-turn' && pendingRef.current.has(diffCacheKey(activeSource, row.path))}
          change={activeSource === 'last-turn' ? lastTurnByPath.get(row.path) : undefined}
          t={t} />}
      </Fragment>)}
      {!loadingStatus && emptyState !== null && <EmptyState kind={emptyState} t={t} />}
    </div>
  </div>
}

function FileRow({ row, expanded, onToggle }: { row: PaneRow; expanded: boolean; onToggle: () => void }) {
  // ZCode splits the row into a muted directory prefix and a full-color file name.
  const directory = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/') + 1) : ''
  const fileName = row.path.slice(directory.length)
  return <button type="button" className={css.row} data-expanded={expanded || undefined} title={row.path}
    aria-expanded={expanded} onClick={onToggle}>
    <FileText size={14} className={css.fileIcon} aria-hidden="true" />
    {directory !== '' && <span className={css.directory}>{directory}</span>}
    <span className={css.fileName}>{fileName}</span>
    <span className={css.counts}>
      <span className={css.added}>+{row.added}</span>
      <span className={css.removed}>−{row.removed}</span>
    </span>
    <ChevronDown size={13} className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} aria-hidden="true" />
  </button>
}

function DiffBody({ activeSource, path, entry, pending, change, t }: {
  activeSource: GitChangeSourceId
  path: string
  entry: DiffEntry | undefined
  pending: boolean
  change: LastTurnChange | undefined
  t: Translate
}) {
  return <div className={css.diffBody} data-diff-body={path}>
    {activeSource === 'last-turn'
      ? <LastTurnDiff change={change} t={t} />
      : <GitDiff entry={entry} pending={pending} t={t} />}
  </div>
}

function GitDiff({ entry, pending, t }: { entry: DiffEntry | undefined; pending: boolean; t: Translate }) {
  if (pending && entry === undefined) {
    return <div className={css.diffPlaceholder} role="status"><Loader size={14} className={css.spin} aria-hidden="true" />{t('正在读取差异…', 'Reading diff…')}</div>
  }
  if (entry === undefined) return null
  if (entry.error !== undefined) return <div className={css.noteLine} role="alert">{entry.error}</div>
  const value = entry.value
  if (value === undefined) return <div className={css.noteLine}>{t('无法读取差异', 'Diff unavailable')}</div>
  if (value.availability === 'binary') return <div className={css.noteLine}>{t('二进制文件', 'Binary file')}</div>
  if (value.availability === 'truncated') return <div className={css.noteLine}>{t('内容过大已截断', 'Content too large, truncated')}</div>
  if (value.availability === 'unavailable') return <div className={css.noteLine}>{t('无法读取差异', 'Diff unavailable')}</div>
  if (value.oldText !== undefined && value.newText !== undefined) {
    return <div className={css.diffContent}><DiffBlock diffs={[{ path: value.path, oldText: value.oldText, newText: value.newText }]} labels={diffLabels(t)} /></div>
  }
  if (value.diff !== undefined) {
    return <div className={css.diffContent}><CodeBlock code={value.diff} lang="diff" copyLabel={t('复制差异', 'Copy diff')}
      copiedLabel={t('已复制', 'Copied')} toolbarLabels={markdownLabels(t).code.toolbarLabels} /></div>
  }
  if (value.newText !== undefined) {
    // Untracked: no HEAD baseline exists, so the full current text stands in for a diff.
    return <div className={css.diffContent}><CodeBlock code={value.newText} lang={languageFromPath(value.path)}
      copyLabel={t('复制内容', 'Copy content')} copiedLabel={t('已复制', 'Copied')} /></div>
  }
  return <div className={css.noteLine}>{t('无法读取差异', 'Diff unavailable')}</div>
}

/** ZCode renders the last turn locally from the conversation's own before/after texts. */
function LastTurnDiff({ change, t }: { change: LastTurnChange | undefined; t: Translate }) {
  const texts = change === undefined ? null : lastTurnDiffTexts(change)
  if (change === undefined || texts === null) return <div className={css.noteLine}>{t('无法读取差异', 'Diff unavailable')}</div>
  return <div className={css.diffContent}><DiffBlock diffs={[{ path: change.path, oldText: texts.oldText, newText: texts.newText }]} labels={diffLabels(t)} /></div>
}

function EmptyState({ kind, t }: { kind: PaneEmptyState; t: Translate }) {
  const copy = kind === 'last-turn-empty'
    ? { title: t('上一轮没有文件更改', 'No file changes in the last turn'), description: t('切换其他来源查看工作区的改动', 'Switch sources to see worktree changes') }
    : kind === 'not-repository'
      ? { title: t('当前目录不是 Git 仓库', 'The current directory is not a Git repository'), description: t('把工作区指向 Git 仓库后再查看更改', 'Point the workspace at a Git repository to review changes') }
      : { title: t('当前来源下没有可展示的改动', 'No changes to show in this source'), description: t('点右上角刷新可重新读取', 'Use refresh to read the changes again') }
  return <div className={css.emptyState} data-empty-state={kind}>
    <FileDiff size={20} className={css.emptyIcon} aria-hidden="true" />
    <p className={css.emptyTitle}>{copy.title}</p>
    <p className={css.emptyDescription}>{copy.description}</p>
  </div>
}
