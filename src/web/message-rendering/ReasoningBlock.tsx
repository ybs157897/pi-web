import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { ProcessRow } from '../ProcessRow.tsx'
import { latestReasoningLine } from '../process-presentation.ts'
import { useProcessExpansion } from './ProcessExpansion.tsx'
import css from './ReasoningBlock.module.css'

const TICK_MS = 1000

/**
 * 功能：模型思考过程的折叠块（对应 host DTO 的 reasoning 块）：标题随状态切换「正在思考/思考」，
 * 收起时显示流式摘要或耗时，展开显示思考全文。
 * @param id 思考块 id（同时是 useProcessExpansion 的记忆键）
 * @param text 思考全文
 * @param streaming 是否仍在流式生成
 * @param redacted 模型隐藏了思考内容（显示占位文案）
 * @param preview 收起态是否显示最新一行摘要
 * @param t 双语标签函数
 * 内部逻辑：耗时计时——流式开始记 startedAt，展开时每秒 tick 更新，结束（streaming 变 false）冻结耗时；历史会话无开始时间，耗时显示「持续了几秒」；收起且流式时不启动定时器，避免隐藏内容每秒重渲染；展开状态经 useProcessExpansion 跨重挂载记忆。
 */
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
/**
 * 功能：取「最后一个非空行」的下标作为摘要内容的 key。
 * @param text 思考全文
 * @returns 非空行下标；新行出现时 key 变化会重挂载摘要文本并重放入场动画
 */
function reasoningLineKey(text: string): number {
  return text.replace(/\r\n?/gu, '\n').split('\n').findLastIndex(line => line.trim() !== '')
}
function DurationSummary({ text }: { text: string }) {
  return <span className={css.summary}>{text}</span>
}
/**
 * 功能：收起流式态的单行摘要：横向滚出最新一行，内容超宽时标记 overflow（渲染渐隐边缘）。
 * @param text 最新非空行文本
 * @param lineKey 行 key，变化时重挂载触发入场动画
 */
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
  return <span ref={viewport} className={css.summary} data-overflow={overflow || undefined}><span key={lineKey} className={css.summaryText}>{text}</span></span>
}
/**
 * 功能：展开态的思考全文滚动区；流式时自动跟随底部（用户上滚即停跟，重新滚到底恢复跟随）。
 * @param text 思考全文
 * @param streaming 是否流式（决定是否自动吸底）
 * @param t 双语标签函数
 * 内部逻辑：following 标记「是否贴底」（距底 ≤ 8px 视为贴底）；ResizeObserver 监听视口与内容尺寸变化，跟随中就滚到底；data-edges 标记上下渐隐边缘（top/bottom/both/none）。
 */
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
