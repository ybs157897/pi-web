import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileDiff, FileText, Loader, RefreshCw } from 'lucide-react'
import { CodeBlock, DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitChangeSourceId, GitWorktreeFile, GitWorktreeStatus } from '../shared/types.ts'

// Inspector 外壳渲染本面板并以同一组来源 id 标注 props 类型。
export type { GitChangeSourceId }
import { api } from './api.ts'
import { diffLabels, markdownLabels, type Translate } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './GitPane.module.css'

/**
 * 功能：ZCode 风格的 Git 审查面板——顶部为来源下拉（未暂存/已暂存/全部分支更改/上一轮更改），
 * 下方为 32px 高的扁平文件行列表。差异按行懒加载并以 `source:path` 缓存；
 * 同一时间只有一行展开；「上一轮更改」完全由会话自带的 before/after 文本本地渲染。
 * @param props workspaceId 目标工作区；activeSource 当前来源（由外壳持有）；
 *              onSelectSource 切换来源回调；lastTurnChanges 本轮文件变更（应用合成，
 *              undefined 表示无会话上下文）；onNotice 全局提示回调。
 * 内部逻辑：loadStatus 拉取 Git 工作区状态（票据丢弃过期响应）；diff 缓存放在 refs
 * （Map 按 source:path 键控）并配版本号触发重渲染，便于请求去重；来源切换时收起
 * 已展开行、缓存保留；refresh 清缓存重读状态；ensureDiff 懒加载单文件差异并缓存错误；
 * 文件从列表消失时自动收起其差异（与 ZCode 一致）。
 */
export interface LastTurnChange {
  path: string
  added: number
  removed: number
  before?: string
  after?: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed'
}

/** GitPane 的属性定义：工作区、当前来源与切换/提示回调。 */
export interface GitPaneProps {
  workspaceId: string
  activeSource: GitChangeSourceId
  onSelectSource: (source: GitChangeSourceId) => void
  /** 本轮（上一轮）的文件变更，由应用合成；undefined 表示没有会话上下文。 */
  lastTurnChanges?: readonly LastTurnChange[]
  onNotice: (text: string) => void
}

/** 审查来源下拉的选项（保持 ZCode 顺序）；无数据时「上一轮更改」保持禁用。 */
export interface SourceOption { id: GitChangeSourceId; disabled: boolean }

/** 构建来源下拉选项；hasLastTurnData 决定 last-turn 是否可用。 */
export function sourceOptions(hasLastTurnData: boolean): SourceOption[] {
  return [
    { id: 'unstaged', disabled: false },
    { id: 'staged', disabled: false },
    { id: 'branch', disabled: false },
    { id: 'last-turn', disabled: !hasLastTurnData },
  ]
}

/** 来源 id 的展示文案：未暂存/已暂存/全部分支更改/上一轮更改。 */
export function sourceLabel(source: GitChangeSourceId, t: Translate): string {
  switch (source) {
    case 'unstaged': return t('未暂存', 'Unstaged')
    case 'staged': return t('已暂存', 'Staged')
    case 'branch': return t('全部分支更改', 'All branch changes')
    case 'last-turn': return t('上一轮更改', 'Last turn')
  }
}

/** 懒加载差异的缓存键：同一路径在不同来源下差异不同。 */
export function diffCacheKey(source: GitChangeSourceId, path: string): string {
  return `${source}:${path}`
}

/** 不分节头：untracked/conflicted 仅决定行的排序位置（ZCode 顺序）。 */
const STATUS_ORDER: Record<GitWorktreeFile['status'], number> = {
  conflicted: 0, modified: 1, added: 1, deleted: 1, renamed: 1, untracked: 2,
}

/** 某一 Git 来源应显示的行：unstaged/staged 拆分 files，branch 使用上游区间。 */
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

/** 上一轮更改与其余来源一样按路径字母序排列（ZCode 行为）。 */
export function sortLastTurnChanges(changes: readonly LastTurnChange[]): LastTurnChange[] {
  return [...changes].sort((first, second) => first.path.localeCompare(second.path))
}

/** 本地渲染上一轮差异所需的 before/after 文本；两侧都没有文本时返回 null。 */
export function lastTurnDiffTexts(change: LastTurnChange): { oldText: string; newText: string } | null {
  if (change.before === undefined && change.after === undefined) return null
  return { oldText: change.before ?? '', newText: change.after ?? '' }
}

/** 空状态类型：上一轮无更改 / 非 Git 仓库 / 通用空列表。 */
export type PaneEmptyState = 'last-turn-empty' | 'not-repository' | 'generic'

/** 空状态优先级（与 ZCode 一致）：上一轮文案优先，其次非仓库提示，最后通用文案。 */
export function paneEmptyState(source: GitChangeSourceId, status: GitWorktreeStatus | null,
  lastTurnChanges: readonly LastTurnChange[] | undefined, rowCount: number): PaneEmptyState | null {
  if (rowCount > 0) return null
  if (source === 'last-turn') return lastTurnChanges !== undefined ? 'last-turn-empty' : 'generic'
  if (status !== null && !status.isRepository) return 'not-repository'
  return 'generic'
}

/** 从扩展名推断语言名（与 Inspector 文件视图同一套词表），供代码块着色。 */
function languageFromPath(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase()
  if (extension === undefined || extension === path.toLocaleLowerCase()) return undefined
  const aliases: Record<string, string> = {
    cjs: 'javascript', htm: 'html', md: 'markdown', mjs: 'javascript', py: 'python', rs: 'rust', sh: 'bash', tsx: 'tsx', yml: 'yaml',
  }
  return aliases[extension] ?? extension
}

/** 提取错误的 message 文本；为空时回退到给定的兜底文案。 */
function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback
}

/** 文件行的展示数据：路径与增删行数。 */
interface PaneRow { path: string; added: number; removed: number }

/** 一个懒加载的 Git 差异条目；错误也会缓存，让失败的行持续展示原因。 */
interface DiffEntry { value?: Awaited<ReturnType<typeof api.gitWorktreeDiff>>; error?: string }

/**
 * 功能：Git 审查面板主体——来源下拉 + 刷新按钮 + 文件行列表；展开行后在其下方
 * 渲染差异内容。位于 Inspector 的「更改」面板中。
 * @param props 见 GitPaneProps。
 * 内部逻辑：status 工作区状态、expandedPath 唯一展开行、diff 缓存 + pending 集合
 * 放在 refs（含 bumpCacheVersion 触发渲染）、statusTicket 丢弃过期状态响应；
 * rows 按 activeSource 派生（last-turn 用排序后的变更，其余按来源过滤排序）；
 * toggleRow 展开时对 Git 来源触发 ensureDiff 懒加载。
 */
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

  /** 拉取 Git 工作区状态；票据保证只应用最新一次请求的结果。 */
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

  /** 刷新：清空差异缓存、收起展开行并重新读取工作区状态。 */
  const refresh = useCallback(async (): Promise<void> => {
    cacheRef.current = new Map()
    setExpandedPath(null)
    await loadStatus()
  }, [loadStatus])

  /** 懒加载单个文件的差异并写入缓存；进行中的请求与已缓存结果直接跳过。 */
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

  /** 当前来源对应的文件行：last-turn 用排序后的会话变更，其余按来源过滤排序工作区文件。 */
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

  /** 展开或收起一行：展开时对 Git 来源懒加载其差异；同一行再次点击即收起。 */
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

/** 单个文件行：目录前缀淡色 + 文件名全色 + 增删计数 + 展开箭头；点击切换展开。 */
function FileRow({ row, expanded, onToggle }: { row: PaneRow; expanded: boolean; onToggle: () => void }) {
  // ZCode 把行拆成淡色的目录前缀与全彩的文件名。
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

/** 展开行下方的差异区：按来源分派到 GitDiff（懒加载）或 LastTurnDiff（本地渲染）。 */
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

/** Git 来源的差异渲染：加载中占位、错误/二进制/截断/不可用提示，其余按 old+new 或 diff 文本渲染。 */
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
    // 未跟踪文件没有 HEAD 基线，以当前全文代替差异展示。
    return <div className={css.diffContent}><CodeBlock code={value.newText} lang={languageFromPath(value.path)}
      copyLabel={t('复制内容', 'Copy content')} copiedLabel={t('已复制', 'Copied')} /></div>
  }
  return <div className={css.noteLine}>{t('无法读取差异', 'Diff unavailable')}</div>
}

/** 上一轮差异：ZCode 用会话自带的 before/after 文本在本地渲染，不走 Git。 */
function LastTurnDiff({ change, t }: { change: LastTurnChange | undefined; t: Translate }) {
  const texts = change === undefined ? null : lastTurnDiffTexts(change)
  if (change === undefined || texts === null) return <div className={css.noteLine}>{t('无法读取差异', 'Diff unavailable')}</div>
  return <div className={css.diffContent}><DiffBlock diffs={[{ path: change.path, oldText: texts.oldText, newText: texts.newText }]} labels={diffLabels(t)} /></div>
}

/** 空状态占位：按 kind 显示图标、标题与说明文案。 */
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
