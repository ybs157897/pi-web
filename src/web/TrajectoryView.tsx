import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  IconClockOutlineRegular, IconInspectOutlineRegular, IconSearchOutlineRegular,
  JsonBlock, MarkdownText, StateDot, Tag, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatMessage, ContentBlock } from '../shared/types.ts'
import { asRecord, buildRenderModel, formatUnknownDetails } from './render-model.ts'
import { markdownLabels, type Translate } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './TrajectoryView.module.css'

export { transcriptMessageDomId } from './render-model.ts'

export interface TrajectoryViewProps {
  messages: readonly ChatMessage[]
  onJumpToMessage: (messageId: string) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
}

/** How long a clicked timeline segment keeps its target row highlighted. */
const FOCUS_FLASH_MS = 1600

/** Show recorded messages and tool events in order, with search, details, and chat navigation. */
export default function TrajectoryView({ messages, onJumpToMessage, onOpenTool }: TrajectoryViewProps) {
  const { t } = useUiPreferences()
  const [query, setQuery] = useState('')
  const [showDuration, setShowDuration] = useState(true)
  const [showRuns, setShowRuns] = useState(true)
  const [showCalls, setShowCalls] = useState(true)
  const [focusedId, setFocusedId] = useState<string>()
  const rowElements = useRef(new Map<string, HTMLLIElement>())
  const flashTimer = useRef<number>()
  useEffect(() => () => { if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current) }, [])

  const normalized = query.trim().toLocaleLowerCase()
  const searchIndex = useMemo(() => new Map(messages.map(message => [message.id, searchableMessage(message)])), [messages])
  // The call toggle decides which records the panel owns; the counter and the timeline both scope to it,
  // so a hidden row can never be counted as a visible record.
  const scoped = useMemo(() => showCalls ? messages : messages.filter(message => message.role !== 'tool'), [messages, showCalls])
  const filtered = useMemo(() => scoped.filter(message => normalized === '' || (searchIndex.get(message.id) ?? '').includes(normalized)),
    [scoped, normalized, searchIndex])
  const runIndex = useMemo(() => messageRunIndex(messages), [messages])
  const groups = useMemo(() => timelineGroups(filtered, runIndex), [filtered, runIndex])
  // Label the first visible record of each turn, so a turn marker survives search filtering.
  const rows = useMemo(() => {
    let previousRun: number | undefined
    return filtered.map(message => {
      const run = runIndex.get(message.id) ?? previousRun
      const startsRun = showRuns && run !== undefined && run !== previousRun
      previousRun = run
      return { message, run: startsRun ? run : undefined }
    })
  }, [filtered, runIndex, showRuns])
  const labels = useMemo(() => markdownLabels(t), [t])

  /** Reveal a row the timeline points at, and flash it so the eye can land on it. */
  const revealMessage = (messageId: string) => {
    rowElements.current.get(messageId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setFocusedId(messageId)
    if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => { setFocusedId(undefined) }, FOCUS_FLASH_MS)
  }
  return (
    <section className={css.root} aria-label={t('会话轨迹', 'Conversation trajectory')}>
      <div className={css.toolbar}>
        <div className={css.switches} role="group" aria-label={t('轨迹显示选项', 'Trajectory display options')}>
          <DisplayToggle label={t('时长', 'Duration')} hint={t('在行尾显示每条记录的耗时', 'Show each record’s clock time')}
            icon={<IconClockOutlineRegular size={13} />} pressed={showDuration} onToggle={setShowDuration} />
          <DisplayToggle label={t('轮次', 'Turns')} hint={t('按对话轮次分组显示记录', 'Group records by conversation turn')}
            icon={<IconBranchOutlineRegular size={13} />} pressed={showRuns} onToggle={setShowRuns} />
          <DisplayToggle label={t('调用', 'Calls')} hint={t('显示工具调用记录', 'Show tool call records')}
            icon={<IconInspectOutlineRegular size={13} />} pressed={showCalls} onToggle={setShowCalls} />
        </div>
        <label className={css.search}>
          <IconSearchOutlineRegular size={15} />
          <input value={query} onChange={event => { setQuery(event.currentTarget.value) }}
            placeholder={t('搜索消息和工具', 'Search messages and tools')} aria-label={t('搜索轨迹', 'Search trajectory')} />
        </label>
        <span className={css.count}>{t(`${filtered.length} / ${scoped.length} 条记录`, `${filtered.length} of ${scoped.length} records`)}</span>
      </div>
      {groups.length > 0 && <div className={css.timeline} role="group" aria-label={t('会话时间分布', 'Session timeline')}>
        {groups.map(group => <div key={group.key} className={css.timelineRun} style={{ flexGrow: group.weight }}>
          {group.segments.map(segment => {
            const label = segmentLabel(segment, t)
            return <button key={segment.message.id} type="button" className={css.segment}
              data-kind={segment.message.role} style={{ flexGrow: segment.weight }}
              title={label} aria-label={label} onClick={() => { revealMessage(segment.message.id) }} />
          })}
        </div>)}
      </div>}
      {filtered.length === 0 ? <div className={css.empty}>{messages.length === 0 ? t('还没有轨迹记录', 'No trajectory records yet') : t('没有匹配记录', 'No matching records')}</div> : (
        <ol className={css.list}>
          {rows.map(row => <TrajectoryRow key={row.message.id} message={row.message} onJump={onJumpToMessage} onOpenTool={onOpenTool}
            labels={labels} t={t} showDuration={showDuration} focused={focusedId === row.message.id}
            runLabel={row.run === undefined ? undefined : t(`第 ${row.run} 轮`, `Turn ${row.run}`)}
            rowRef={element => {
              if (element === null) rowElements.current.delete(row.message.id)
              else rowElements.current.set(row.message.id, element)
            }} />)}
        </ol>
      )}
    </section>
  )
}

function DisplayToggle({ label, hint, icon, pressed, onToggle }: {
  label: string
  hint: string
  icon: ReactNode
  pressed: boolean
  onToggle: (next: boolean) => void
}) {
  return <button type="button" className={css.toggle} aria-pressed={pressed} title={hint}
    onClick={() => { onToggle(!pressed) }}>
    {icon}<span>{label}</span>
  </button>
}

function TrajectoryRow({ message, onJump, onOpenTool, labels, t, showDuration, runLabel, focused, rowRef }: {
  message: ChatMessage
  onJump: (messageId: string) => void
  onOpenTool?: TrajectoryViewProps['onOpenTool']
  labels: ReturnType<typeof markdownLabels>
  t: Translate
  showDuration: boolean
  runLabel?: string
  focused: boolean
  rowRef: (element: HTMLLIElement | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const preview = messagePreview(message, t)
  const toolName = message.role === 'tool' ? message.toolName ?? t('工具结果', 'Tool result') : undefined
  const state = message.status ?? (message.streaming ? 'running' : message.isError ? 'error' : undefined)
  const calls = message.blocks.flatMap(block => block.type === 'toolCall' ? [block] : [])
  const detailsText = formatUnknownDetails(message.details)
  const hasDetails = detailsText !== '' || calls.length > 0 || message.usage !== undefined || message.artifacts !== undefined
  return (
    <li ref={rowRef} className={css.item} data-role={message.role} data-status={state}
      data-run-start={runLabel === undefined ? undefined : ''} data-focused={focused ? '' : undefined}>
      <div className={css.row}>
        <span className={css.stateIcon} aria-hidden="true">
          {state === 'running' ? <StateDot state="ongoing" size={13} />
            : state === 'error' ? <StateDot state="error" size={10} />
              : state === 'cancelled' ? <StateDot state="warning" size={10} />
                : <span className={css.roleDot} />}
        </span>
        {/* The turn marker owns a fixed gutter column, so every row keeps its kind chip aligned. */}
        <span className={css.runGutter}>{runLabel !== undefined && <span className={css.runLabel}>{runLabel}</span>}</span>
        <Tag tone={roleTone(message.role)} className={css.chip}>{roleLabel(message.role, t)}</Tag>
        <button type="button" className={css.jump} onClick={() => { onJump(message.id) }}>
          {toolName !== undefined && <span className={css.tool}>{toolName}</span>}
          <span className={css.preview}>{preview}</span>
          {showDuration && <time dateTime={safeIsoTime(message.timestamp)}>{formatClock(message.timestamp)}</time>}
        </button>
        {hasDetails && <button type="button" className={css.disclosure} aria-expanded={expanded}
          onClick={() => { setExpanded(value => !value) }} aria-label={expanded ? t('收起详情', 'Collapse details') : t('展开详情', 'Expand details')}>
          {expanded ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />}
        </button>}
      </div>
      {expanded && <div className={css.details}>
        {message.blocks.map((block, index) => <TrajectoryBlock key={`${message.id}:${index}`} block={block} streaming={message.streaming === true} labels={labels} t={t} />)}
        {calls.map(call => <button key={`open:${call.id}`} type="button" className={css.inspectButton}
          onClick={() => { onOpenTool?.(message.id, call.id) }} disabled={onOpenTool === undefined}>
          <IconInspectOutlineRegular size={13} />{t('检查工具调用', 'Inspect tool call')}: {call.name}
        </button>)}
        {message.details !== undefined && message.details !== null && <JsonBlock label={t('工具详情', 'Tool details')} payload={message.details}
          truncatedLabel={count => t(`内容过长（${count} 字符）`, `Content too long (${count} characters)`)} />}
        {message.usage !== undefined && <UsageSummary usage={message.usage} t={t} />}
        {message.artifacts?.map((artifact, index) => <div className={css.artifact} key={`${artifact.kind}:${artifact.path}:${index}`}>
          <span>{artifact.kind}</span><code>{artifact.path}</code>
          {artifact.diff !== undefined && <pre>{artifact.diff}</pre>}
          {artifact.before !== undefined && artifact.after !== undefined && <pre>{artifact.after}</pre>}
        </div>)}
        {message.role === 'tool' && message.toolCallId !== undefined && <button type="button" className={css.inspectButton}
          onClick={() => { onOpenTool?.(message.id, message.toolCallId) }} disabled={onOpenTool === undefined}>
          <IconInspectOutlineRegular size={13} />{t('检查工具结果', 'Inspect tool result')}
        </button>}
      </div>}
    </li>
  )
}

function TrajectoryBlock({ block, streaming, labels, t }: {
  block: ContentBlock
  streaming: boolean
  labels: ReturnType<typeof markdownLabels>
  t: Translate
}) {
  switch (block.type) {
    case 'text':
      return <div className={css.block}><MarkdownText text={block.text} streaming={streaming} labels={labels} /></div>
    case 'thinking':
      return <div className={css.block} data-thinking="">
        {block.redacted === true ? <span className={css.redacted}>{t('思考内容已隐藏', 'Reasoning is hidden')}</span>
          : <MarkdownText text={block.text} labels={labels} variant="compact" />}
      </div>
    case 'toolCall':
      return <div className={css.call}>
        <span>{block.name}</span>
        <JsonBlock label={t('参数', 'Arguments')} payload={block.arguments}
          truncatedLabel={count => t(`内容过长（${count} 字符）`, `Content too long (${count} characters)`)} />
      </div>
    case 'image':
      return <div className={css.block}><img className={css.image} src={block.url} alt={t('对话图片', 'Conversation image')} loading="lazy" /></div>
    case 'file':
      return <div className={css.block}><span className={css.file}>{block.name}</span><code>{block.path}</code></div>
    default:
      return <div className={css.block}>{t('无法显示的消息内容', 'Unsupported message content')}</div>
  }
}

function UsageSummary({ usage, t }: { usage: NonNullable<ChatMessage['usage']>; t: Translate }) {
  return <div className={css.usage}>
    <span>{t('输入', 'Input')} {usage.input}</span>
    <span>{t('输出', 'Output')} {usage.output}</span>
    <span>{t('缓存读取', 'Cache read')} {usage.cacheRead}</span>
    <span>{t('总计', 'Total')} {usage.totalTokens}</span>
    <span>{t('费用', 'Cost')} {usage.cost.total}</span>
  </div>
}

/** One run of the session timeline: the records recorded between two conversation turns. */
interface TimelineGroup {
  readonly key: string
  readonly run: number
  readonly weight: number
  readonly segments: readonly TimelineSegment[]
}

interface TimelineSegment {
  readonly message: ChatMessage
  readonly weight: number
}

/** Map every recorded message to its 1-based conversation turn, reusing the chat view's own run grouping. */
function messageRunIndex(messages: readonly ChatMessage[]): Map<string, number> {
  const index = new Map<string, number>()
  buildRenderModel(messages).runs.forEach((run, position) => {
    for (const message of run.messages) if (!index.has(message.id)) index.set(message.id, position + 1)
  })
  return index
}

/** Lay the visible records out as run groups, sized by how much time each record waited for. */
function timelineGroups(visible: readonly ChatMessage[], runIndex: ReadonlyMap<string, number>): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let current: { key: string; run: number; weight: number; segments: TimelineSegment[] } | undefined
  let previousRun: number | undefined
  visible.forEach((message, position) => {
    // System records carry no run of their own; they stay with the turn recorded around them.
    const run = runIndex.get(message.id) ?? previousRun ?? 1
    if (current === undefined || run !== current.run) {
      current = { key: `run:${run}:${position}`, run, weight: 0, segments: [] }
      groups.push(current)
    }
    previousRun = run
    const weight = segmentWeight(message.timestamp - (visible[position - 1]?.timestamp ?? message.timestamp))
    current.weight += weight
    current.segments.push({ message, weight })
  })
  return groups
}

/** Bucket the wait before a record to whole seconds and cap it, so one long pause never owns the whole bar. */
function segmentWeight(gapMs: number): number {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return 1
  return 1 + Math.min(Math.round(gapMs / 1000), 4)
}

/** The hover text of one timeline segment: what kind of record it is, when it happened, and where it sits. */
function segmentLabel(segment: TimelineSegment, t: Translate): string {
  const { message } = segment
  const parts = [roleLabel(message.role, t), formatClockSeconds(message.timestamp)]
  if (message.role === 'tool' && message.toolName !== undefined) parts.push(message.toolName)
  return parts.join(' · ')
}

function roleLabel(role: ChatMessage['role'], t: Translate): string {
  if (role === 'user') return t('用户', 'User')
  if (role === 'assistant') return t('助手', 'Assistant')
  if (role === 'system') return t('系统', 'System')
  return t('工具', 'Tool')
}

/** Tint each record kind with the same semantic color the timeline bar uses for it. */
function roleTone(role: ChatMessage['role']): TagTone {
  if (role === 'assistant') return 'info'
  if (role === 'tool') return 'warning'
  if (role === 'system') return 'quiet'
  return 'neutral'
}

function messagePreview(message: ChatMessage, t: Translate): string {
  const parts = message.blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'thinking') return block.redacted === true ? [t('思考内容已隐藏', 'Reasoning is hidden')] : [block.text]
    if (block.type === 'toolCall') return [block.name]
    if (block.type === 'image') return [t('图片', 'Image')]
    return [block.name]
  })
  if (parts.length > 0) return firstLine(parts.join(' · '))
  const details = formatUnknownDetails(message.details)
  if (details !== '') return firstLine(details)
  if (message.status === 'error' || message.isError) return t('执行失败', 'Failed')
  if (message.status === 'cancelled') return t('已停止', 'Stopped')
  return t('无文本内容', 'No text content')
}

function searchableMessage(message: ChatMessage): string {
  const content = message.blocks.flatMap(block => {
    if (block.type === 'thinking' && block.redacted === true) return []
    if (block.type === 'text' || block.type === 'thinking') return [block.text]
    if (block.type === 'toolCall') return [block.name, safeJson(block.arguments)]
    if (block.type === 'file') return [block.name, block.path]
    return []
  }).join('\n')
  return `${content}\n${message.toolName ?? ''}\n${message.status ?? ''}\n${formatUnknownDetails(message.details)}`.toLocaleLowerCase()
}

function safeJson(value: unknown): string {
  const record = asRecord(value)
  if (record === undefined) return ''
  return formatUnknownDetails(record)
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u).find(line => line.trim() !== '')?.trim() ?? ''
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

function formatClockSeconds(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp)
}

function safeIsoTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) return undefined
  return new Date(timestamp).toISOString()
}
