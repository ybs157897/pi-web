import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { api } from './api.ts'
import { buildCallCards, parseTrajectory, summarizeCalls } from './trajectory-view.ts'
import type { TrajectoryCall, TrajectoryRole } from './trajectory-view.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './TrajectoryPane.module.css'

/** TrajectoryPane 的属性定义：会话 id、标题覆盖与全局提示回调。 */
export interface TrajectoryPaneProps {
  conversationId: string
  /** 头部标题覆盖；缺省用「模型调用轨迹」。 */
  title?: string
  onNotice: (text: string) => void
}

/**
 * 功能：单个会话的模型调用时间线面板——消费轨迹导出 NDJSON（api.trajectory），
 * 每次模型调用渲染为一张可展开卡片，头部含调用次数/token 汇总、子串过滤框
 * 与全部展开/收起、刷新按钮。
 * @param props conversationId 目标会话；title 头部标题覆盖；onNotice 失败时提示。
 * 内部逻辑：load 拉取 NDJSON 文本，失败时写 error 并经 noticeRef 提示（ref 读取
 * 不稳定的 onNotice，让 fetch effect 只依赖会话）；cards 由 parseTrajectory +
 * buildCallCards 派生，expanded 以 Set 记录展开卡片；query 过滤经 matchesCall；
 * allExpanded 判断是否全部展开，toggleAll 在全展开与全收起间切换。
 */
export default function TrajectoryPane({ conversationId, title, onNotice }: TrajectoryPaneProps) {
  const { t } = useUiPreferences()
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // A notice callback may be an unstable inline prop; reading it through a ref
  // keeps the fetch effect tied to the conversation alone.
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const fetched = await api.trajectory(conversationId)
      setText(fetched)
      setExpanded(new Set())
    } catch (cause) {
      const message = cause instanceof Error && cause.message !== '' ? cause.message
        : t('轨迹加载失败', 'Could not load the trajectory')
      setError(message)
      noticeRef.current(message)
    } finally {
      setLoading(false)
    }
  }, [conversationId, t])

  useEffect(() => { void load() }, [load])

  const cards = useMemo(() => buildCallCards(parseTrajectory(text)), [text])
  const summary = useMemo(() => summarizeCalls(cards), [cards])
  const needle = query.trim().toLowerCase()
  const filtered = useMemo(
    () => needle === '' ? cards : cards.filter(card => matchesCall(card, needle)),
    [cards, needle],
  )
  const allExpanded = filtered.length > 0 && filtered.every(card => expanded.has(card.index))

  /** 切换单张卡片的展开态。 */
  const toggle = (index: number) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  /** 全部展开/收起：作用于过滤后的可见卡片集合。 */
  const toggleAll = () => {
    setExpanded(allExpanded ? new Set() : new Set(filtered.map(card => card.index)))
  }

  const heading = title ?? t('模型调用轨迹', 'Model call trajectory')
  return <section className={css.root} data-trajectory-pane={conversationId} aria-label={heading}>
    <header className={css.header}>
      <span className={css.title} title={heading}>{heading}</span>
      <span className={css.summary}>
        {t(`${summary.count} 次调用`, `${summary.count} calls`)}
        {' · '}{t('输入', 'IN')} <span className={css.num}>{formatTokens(summary.inputTokens)}</span>
        {' · '}{t('输出', 'OUT')} <span className={css.num}>{formatTokens(summary.outputTokens)}</span>
      </span>
      <label className={css.search}>
        <Search size={12} aria-hidden />
        <input
          className={css.searchInput}
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('过滤调用…', 'Filter calls…')}
          aria-label={t('过滤调用', 'Filter calls')}
        />
        {needle !== '' && <span className={css.filterCount}>{filtered.length}/{cards.length}</span>}
      </label>
      <button
        type="button"
        className={css.iconButton}
        onClick={toggleAll}
        disabled={filtered.length === 0}
        aria-label={allExpanded ? t('全部收起', 'Collapse all') : t('全部展开', 'Expand all')}
        title={allExpanded ? t('全部收起', 'Collapse all') : t('全部展开', 'Expand all')}
      >
        {allExpanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
      </button>
      <button
        type="button"
        className={css.iconButton}
        onClick={() => { void load() }}
        disabled={loading}
        aria-label={t('刷新', 'Refresh')}
        title={t('刷新', 'Refresh')}
      >
        <RefreshCw size={13} className={loading ? css.spin : undefined} aria-hidden />
      </button>
    </header>
    <div className={css.body}>
      {error !== '' && <div className={css.error} role="alert">{t('轨迹加载失败', 'Could not load the trajectory')}: {error}</div>}
      {loading && text === '' && error === '' && <div className={css.notice} role="status">{t('正在载入轨迹…', 'Loading trajectory…')}</div>}
      {error === '' && filtered.length === 0 && <div className={css.empty}>
        {cards.length === 0 ? t('没有可展示的调用记录', 'No model calls to show') : t('没有匹配的调用', 'No calls match the filter')}
      </div>}
      <ol className={css.timeline}>
        {filtered.map(card => (
          <CallCard key={card.index} card={card} expanded={expanded.has(card.index)} onToggle={() => toggle(card.index)} />
        ))}
      </ol>
    </div>
  </section>
}

/** 单次模型调用卡片：头部为序号/主对话或旁路标记/模型 id/token/时长/时间，展开后显示输入输出明细。 */
function CallCard({ card, expanded, onToggle }: {
  card: TrajectoryCall
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useUiPreferences()
  const preview = card.input[0]
  return <li className={css.call} data-error={card.error !== null || undefined}>
    <button type="button" className={css.callHead} onClick={onToggle} aria-expanded={expanded}>
      <span className={css.index}>{String(card.index).padStart(2, '0')}</span>
      <span className={card.side ? css.sideChip : css.mainChip}>
        {card.side ? t('旁路调用', 'Side call') : t('主对话', 'Main')}
      </span>
      <span className={css.model}>{card.modelId !== '' ? card.modelId : '—'}</span>
      <span className={css.tokens}>
        <span>IN <span className={css.num}>{formatTokens(card.inputTokens)}</span></span>
        <span>OUT <span className={css.num}>{formatTokens(card.outputTokens)}</span></span>
      </span>
      <span className={css.meta}>{formatDuration(card.durationMs)}</span>
      <span className={css.meta}>{formatClock(card.timestamp)}</span>
      {expanded
        ? <ChevronDown size={13} className={css.chevron} aria-hidden />
        : <ChevronRight size={13} className={css.chevron} aria-hidden />}
    </button>
    {!expanded && preview !== undefined && <div className={css.preview}>
      <span className={`${css.roleTag} ${roleClass(preview.role)}`}>{preview.role}</span>
      {preview.toolName !== undefined && <span className={css.toolName}>{preview.toolName}</span>}
      <span className={css.previewText}>{preview.text}</span>
    </div>}
    {expanded && <div className={css.callBody}>
      <div className={css.section}>
        <div className={css.sectionTitle}>{t('输入', 'Input')}</div>
        {card.input.map((line, position) => <div key={position} className={css.line}>
          <span className={`${css.roleTag} ${roleClass(line.role)}`}>{line.role}</span>
          {line.toolName !== undefined && <span className={css.toolName}>{line.toolName}</span>}
          <pre className={css.lineText}>{line.text}</pre>
        </div>)}
        {card.input.length === 0 && <div className={css.sectionEmpty}>{t('无输入记录', 'No input recorded')}</div>}
      </div>
      <div className={css.section}>
        <div className={css.sectionTitle}>{t('输出', 'Output')}</div>
        {card.outputText !== '' && <pre className={css.lineText}>{card.outputText}</pre>}
        {card.toolCalls.map((call, position) => <div key={position} className={css.line}>
          <span className={`${css.roleTag} ${css.roleTool}`}>tool</span>
          <span className={css.toolName}>{call.name}</span>
          <pre className={css.lineText}>{call.arguments}</pre>
        </div>)}
        {card.outputText === '' && card.toolCalls.length === 0
          && <div className={css.sectionEmpty}>{t('无输出内容', 'No output content')}</div>}
        {card.error !== null && <div className={css.callError} role="alert">{card.error}</div>}
      </div>
    </div>}
  </li>
}

/** 子串过滤：匹配模型 id、用途、输入消息文本/工具名、输出文本、错误与工具调用参数。 */
function matchesCall(card: TrajectoryCall, needle: string): boolean {
  if (card.modelId.toLowerCase().includes(needle)) return true
  if (card.purpose?.toLowerCase().includes(needle) === true) return true
  if (card.outputText.toLowerCase().includes(needle)) return true
  if (card.error?.toLowerCase().includes(needle) === true) return true
  for (const line of card.input) {
    if (line.text.toLowerCase().includes(needle)) return true
    if (line.toolName?.toLowerCase().includes(needle) === true) return true
  }
  for (const call of card.toolCalls) {
    if (call.name.toLowerCase().includes(needle)) return true
    if (call.arguments.toLowerCase().includes(needle)) return true
  }
  return false
}

/** 按消息角色返回对应的角色标签样式类。 */
function roleClass(role: TrajectoryRole): string {
  switch (role) {
    case 'system': return css.roleSystem
    case 'user': return css.roleUser
    case 'assistant': return css.roleAssistant
    case 'tool': return css.roleTool
  }
}

/** token 数按当前 locale 千分位格式化。 */
function formatTokens(value: number): string {
  return value.toLocaleString()
}

/** 时长格式化：1 秒内显示 ms，否则显示一位小数的秒；未知显示 —。 */
function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—'
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

/** 时间戳格式化为本地时分的 HH:mm:ss；未知显示 —。 */
function formatClock(timestamp: number | null): string {
  if (timestamp === null) return '—'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
