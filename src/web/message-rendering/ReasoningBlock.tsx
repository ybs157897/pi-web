import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { ProcessRow } from '../ProcessRow.tsx'
import { latestReasoningLine } from '../process-presentation.ts'
import { useProcessExpansion } from './ProcessExpansion.tsx'
import css from './ReasoningBlock.module.css'

const TICK_MS = 1000

export function ReasoningBlock({ id, text, streaming, redacted, preview, t }: {
  id: string; text: string; streaming: boolean; redacted: boolean; preview: boolean; t: Translate
}) {
  const [open, setOpen] = useProcessExpansion(id)
  const [duration, setDuration] = useState<number>()
  const startedAt = useRef<number | null>(null)
  useEffect(() => {
    if (!streaming) {
      // 结束态只冻结已有开始时间；历史会话没有开始时间，耗时保持未知。
      if (startedAt.current === null) return
      setDuration(Math.ceil((Date.now() - startedAt.current) / TICK_MS))
      startedAt.current = null
      return
    }
    if (startedAt.current === null) startedAt.current = Date.now()
    // 收起态只展示流式摘要，不为隐藏的耗时每秒重渲染整块思考内容。
    if (!open) return
    const update = () => {
      if (startedAt.current === null) return
      setDuration(Math.max(1, Math.ceil((Date.now() - startedAt.current) / TICK_MS)))
    }
    update()
    const timer = window.setInterval(update, TICK_MS)
    return () => window.clearInterval(timer)
  }, [open, streaming])
  const collapsedStreaming = streaming && !open
  const title = collapsedStreaming ? t('正在思考', 'Thinking') : t('思考', 'Thought')
  const summaryLine = collapsedStreaming && preview ? latestReasoningLine(text) : ''
  const durationText = duration === undefined
    ? t('持续了几秒', 'a few seconds')
    : t(`持续了 ${duration} 秒`, `${duration} seconds`)
  return <div className={css.root} data-reasoning-block data-running={streaming || undefined} data-expanded={open || undefined}>
    <ProcessRow icon={<Brain size={16} />} title={title}
      open={open} expandable keepSummaryWhenOpen toggleLabel={title} onToggle={() => setOpen(value => !value)} running={collapsedStreaming}
      summary={collapsedStreaming
        ? summaryLine && <ThoughtSummary text={summaryLine} lineKey={reasoningLineKey(text)} />
        : <DurationSummary text={durationText} />}>
      {redacted ? <div className={css.redacted}>{t('此模型隐藏了思考内容', 'This model hides its reasoning content')}</div>
        : <ThoughtContent text={text} streaming={streaming} t={t} />}
    </ProcessRow>
  </div>
}
/** Latest nonempty line index; a new line remounts the summary text and replays its entrance animation. */
function reasoningLineKey(text: string): number {
  return text.replace(/\r\n?/gu, '\n').split('\n').findLastIndex(line => line.trim() !== '')
}
function DurationSummary({ text }: { text: string }) {
  return <><span className={css.separator} aria-hidden="true">·</span><span className={css.summary}>{text}</span></>
}
function ThoughtSummary({ text, lineKey }: { text: string; lineKey: number }) {
  const viewport = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const update = () => { setOverflow(element.scrollWidth > element.clientWidth + 1); element.scrollLeft = element.scrollWidth }
    update(); const observer = new ResizeObserver(update); observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return <><span className={css.separator} aria-hidden="true">·</span><span ref={viewport} className={css.summary} data-overflow={overflow || undefined}><span key={lineKey} className={css.summaryText}>{text}</span></span></>
}
function ThoughtContent({ text, streaming, t }: { text: string; streaming: boolean; t: Translate }) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [edges, setEdges] = useState('none')
  const sync = () => {
    const el = viewport.current
    if (!el) return
    const top = el.scrollTop > 1, bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 8
    setEdges(top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : 'none')
  }
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    if (following.current && streaming) el.scrollTop = el.scrollHeight
    sync()
    const observer = new ResizeObserver(() => { if (following.current && streaming) el.scrollTop = el.scrollHeight; sync() })
    observer.observe(el); if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [text, streaming])
  return <div className={css.contentPadding}><div ref={viewport} className={css.scroll} tabIndex={0} role="region" aria-label={t('思考内容', 'Thinking content')} data-edges={edges}
    onScroll={() => { const el = viewport.current; if (el) following.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 8; sync() }}>
    <div ref={content}>{text}</div>
  </div></div>
}
