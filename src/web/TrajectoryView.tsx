import { useMemo, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconInspectOutlineRegular,
  IconSearchOutlineRegular, JsonBlock, MarkdownText, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatMessage, ContentBlock } from '../shared/types.ts'
import { asRecord, formatUnknownDetails } from './render-model.ts'
import { markdownLabels, type Translate } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './TrajectoryView.module.css'

export { transcriptMessageDomId } from './render-model.ts'

export interface TrajectoryViewProps {
  messages: readonly ChatMessage[]
  onJumpToMessage: (messageId: string) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
}

/** Show recorded messages and tool events in order, with search, details, and chat navigation. */
export default function TrajectoryView({ messages, onJumpToMessage, onOpenTool }: TrajectoryViewProps) {
  const { t } = useUiPreferences()
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const searchIndex = useMemo(() => new Map(messages.map(message => [message.id, searchableMessage(message)])), [messages])
  const filtered = useMemo(() => messages.filter(message => normalized === '' || (searchIndex.get(message.id) ?? '').includes(normalized)),
    [messages, normalized, searchIndex])
  const labels = useMemo(() => markdownLabels(t), [t])
  return (
    <section className={css.root} aria-label={t('会话轨迹', 'Conversation trajectory')}>
      <div className={css.toolbar}>
        <label className={css.search}>
          <IconSearchOutlineRegular size={15} />
          <input value={query} onChange={event => { setQuery(event.currentTarget.value) }}
            placeholder={t('搜索消息和工具', 'Search messages and tools')} aria-label={t('搜索轨迹', 'Search trajectory')} />
        </label>
        <span className={css.count}>{t(`${filtered.length} / ${messages.length} 条记录`, `${filtered.length} of ${messages.length} records`)}</span>
      </div>
      {filtered.length === 0 ? <div className={css.empty}>{normalized === '' ? t('还没有轨迹记录', 'No trajectory records yet') : t('没有匹配记录', 'No matching records')}</div> : (
        <ol className={css.list}>
          {filtered.map(message => <TrajectoryRow key={message.id} message={message} onJump={onJumpToMessage}
            onOpenTool={onOpenTool} labels={labels} t={t} />)}
        </ol>
      )}
    </section>
  )
}

function TrajectoryRow({ message, onJump, onOpenTool, labels, t }: {
  message: ChatMessage
  onJump: (messageId: string) => void
  onOpenTool?: TrajectoryViewProps['onOpenTool']
  labels: ReturnType<typeof markdownLabels>
  t: Translate
}) {
  const [expanded, setExpanded] = useState(false)
  const title = messageTitle(message, t)
  const preview = messagePreview(message, t)
  const state = message.status ?? (message.streaming ? 'running' : message.isError ? 'error' : undefined)
  const calls = message.blocks.flatMap(block => block.type === 'toolCall' ? [block] : [])
  const detailsText = formatUnknownDetails(message.details)
  const hasDetails = detailsText !== '' || calls.length > 0 || message.usage !== undefined || message.artifacts !== undefined
  return (
    <li className={css.item} data-role={message.role} data-status={state}>
      <div className={css.row}>
        <span className={css.stateIcon} aria-hidden="true">
          {state === 'running' ? <StateDot state="ongoing" size={13} />
            : state === 'error' ? <StateDot state="error" size={10} />
              : state === 'cancelled' ? <StateDot state="warning" size={10} />
                : <span className={css.roleDot} />}
        </span>
        <button type="button" className={css.jump} onClick={() => { onJump(message.id) }}>
          <span className={css.title}>{title}</span>
          <span className={css.preview}>{preview}</span>
          <time dateTime={safeIsoTime(message.timestamp)}>{formatClock(message.timestamp)}</time>
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

function messageTitle(message: ChatMessage, t: Translate): string {
  if (message.role === 'user') return t('用户消息', 'User message')
  if (message.role === 'assistant') return t('助手消息', 'Assistant message')
  if (message.role === 'system') return t('系统消息', 'System message')
  return message.toolName ?? t('工具结果', 'Tool result')
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

function safeIsoTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) return undefined
  return new Date(timestamp).toISOString()
}

