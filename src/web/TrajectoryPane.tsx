import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import { api } from './api.ts'
import { buildCallCards, parseTrajectory, summarizeCalls } from './trajectory-view.ts'
import type { TrajectoryCall, TrajectoryRole } from './trajectory-view.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './TrajectoryPane.module.css'

export interface TrajectoryPaneProps {
  conversationId: string
  /** Header title override; defaults to the model-call trajectory label. */
  title?: string
  onNotice: (text: string) => void
}

/**
 * The model-call timeline for one conversation: consumes the trajectory export
 * NDJSON (`api.trajectory`) and renders one expandable card per model call,
 * with a header summary, substring filter and expand-all toggle.
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

  const toggle = (index: number) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
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

/** Substring filter across model id, purpose, roles text, tool names and output. */
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

function roleClass(role: TrajectoryRole): string {
  switch (role) {
    case 'system': return css.roleSystem
    case 'user': return css.roleUser
    case 'assistant': return css.roleAssistant
    case 'tool': return css.roleTool
  }
}

function formatTokens(value: number): string {
  return value.toLocaleString()
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—'
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

function formatClock(timestamp: number | null): string {
  if (timestamp === null) return '—'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
