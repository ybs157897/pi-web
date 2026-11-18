import { useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { ArrowLeftFromLine, ArrowRightFromLine, Check, Copy, Download, Maximize2 } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { tableCsv, tableMarkdown } from '../answer-markdown-model.ts'
import { MessageDialog } from './Dialog.tsx'
import { useBrowserLayoutEffect, useCopyFeedback } from './hooks.ts'
import css from './MarkdownTable.module.css'
import './theme.css'

type Geometry = { viewport: number; content: number; left: number; available: number; rightAvailable: number; base: number; offset: number }
const emptyGeometry: Geometry = { viewport: 0, content: 0, left: 0, available: 0, rightAvailable: 0, base: 0, offset: 0 }
/**
 * 功能：从 DOM 表格读出二维文本矩阵（按 innerText 优先，保留单元格内的换行显示）。
 * @param table `<table>` 元素或 null
 * @returns 行 → 单元格文本的二维数组；table 为 null 返回空数组
 */
export function readTableRows(table: HTMLTableElement | null): string[][] {
  return Array.from(table?.rows ?? [], row => Array.from(row.cells, cell => cell.innerText ?? cell.textContent ?? ''))
}
/**
 * 功能：滚动容器上的键盘横向滚动（Home/End 跳到两端，左右方向键步进 80px）。
 * 内部逻辑：仅当事件目标就是容器本身才处理（子元素按键不劫持）；内容未溢出时不响应。
 */
function keyboardScroll(event: KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget) return
  const element = event.currentTarget
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? element.scrollWidth - element.clientWidth
    : event.key === 'ArrowRight' ? element.scrollLeft + 80 : event.key === 'ArrowLeft' ? element.scrollLeft - 80 : undefined
  if (next === undefined || element.scrollWidth <= element.clientWidth) return
  event.preventDefault(); element.scrollLeft = next
}

/**
 * 功能：消息正文中 Markdown 表格的渲染容器（对应 host DTO 的 table 块）：横向滚动、边缘阴影、
 * 自定义滚动条，并提供复制 Markdown、下载 CSV、大图预览、展开全宽四个操作。
 * @param children Streamdown 渲染出的 `<table>` 子元素
 * @param t 双语标签函数
 * 内部逻辑：layout effect 测量「表格自身宽 / 滚动视口宽 / 外层滚动宿主的可用宽」形成 geometry，配合 ResizeObserver 持续校正；overflow 时在边缘渲染阴影、底部渲染 range 滑条映射 scrollLeft；expanded 允许表格临时突破列宽并外扩到滚动宿主边界（offset 为负外边距）；复制/下载分别走 tableMarkdown/tableCsv（readTableRows 从 DOM 取数，保证所见即所得）。
 */
export function MarkdownTable({ children, t }: { children?: ReactNode; t: Translate }) {
  const root = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const table = useRef<HTMLTableElement>(null)
  const [geometry, setGeometry] = useState(emptyGeometry)
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState(false)
  const { state, copy } = useCopyFeedback()
  useBrowserLayoutEffect(() => {
    const host = root.current, scroll = viewport.current, content = table.current
    if (!host || !scroll || !content) return
    const column = host.closest<HTMLElement>('[data-message-column]') ?? host.parentElement
    let scrollOwner = host.parentElement
    while (scrollOwner && !['auto', 'scroll'].includes(getComputedStyle(scrollOwner).overflowY)) scrollOwner = scrollOwner.parentElement
    const measure = () => {
      const owner = scrollOwner?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth }
      const rect = host.getBoundingClientRect()
      const available = Math.max(0, owner.right - owner.left - 48)
      const offset = Math.min(0, owner.left + 24 - rect.left)
      const next = { viewport: scroll.clientWidth, content: content.scrollWidth, left: scroll.scrollLeft, available, rightAvailable: Math.max(host.clientWidth, owner.right - rect.left - 24), base: host.clientWidth, offset }
      setGeometry(old => Object.keys(next).every(k => old[k as keyof Geometry] === next[k as keyof Geometry]) ? old : next)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(scroll); observer?.observe(content); if (column) observer?.observe(column)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [children, expanded])
  const overflow = geometry.content > geometry.viewport + 1
  const canExpand = expanded || overflow && geometry.available > geometry.viewport + 32
  const leftEdge = geometry.left > 1
  const rightEdge = geometry.left < geometry.content - geometry.viewport - 1
  const naturalViewportWidth = Math.max(geometry.base, Math.min(geometry.content, geometry.rightAvailable))
  const widthStyle = expanded ? { width: `${Math.min(geometry.content, geometry.available)}px`, maxWidth: 'none', marginLeft: `${geometry.offset}px` }
    : naturalViewportWidth > geometry.base + 1 ? { width: `${naturalViewportWidth}px`, maxWidth: 'none' } : undefined
  function download() {
    const url = URL.createObjectURL(new Blob([tableCsv(readTableRows(table.current))], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'table.csv'
    document.body.append(anchor); anchor.click(); anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className={css.root} ref={root} data-message-table>
    <div className={css.frame} style={widthStyle}>
      <div className={css.actions}>
        <button type="button" aria-label={state === 'copied' ? t('已复制', 'Copied') : t('复制 Markdown', 'Copy Markdown')} title={t('复制 Markdown', 'Copy Markdown')} onClick={() => { void copy(tableMarkdown(readTableRows(table.current))) }}>{state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>
        <button type="button" aria-label={t('下载 CSV', 'Download CSV')} title={t('下载 CSV', 'Download CSV')} onClick={download}><Download size={14} aria-hidden="true" /></button>
        <button type="button" aria-label={t('预览表格', 'Preview table')} title={t('预览表格', 'Preview table')} onClick={() => setPreview(true)}><Maximize2 size={14} aria-hidden="true" /></button>
        {canExpand && <button type="button" aria-label={expanded ? t('收回表格宽度', 'Collapse table width') : t('扩展表格宽度', 'Expand table width')} title={expanded ? t('收回表格宽度', 'Collapse table width') : t('扩展表格宽度', 'Expand table width')} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ArrowRightFromLine size={14} aria-hidden="true" /> : <ArrowLeftFromLine size={14} aria-hidden="true" />}</button>}
      </div>
      {state === 'error' && <span className={css.error} role="status">{t('复制失败', 'Copy failed')}</span>}
      <div className={css.border}>
        <div className={css.scroll} ref={viewport} tabIndex={0} role="region" aria-label={t('表格，可横向滚动', 'Table, horizontally scrollable')} onKeyDown={keyboardScroll}
          onScroll={event => { const left = event.currentTarget.scrollLeft; setGeometry(old => ({ ...old, left })) }}>
          <table ref={table}>{children}</table>
        </div>
        {overflow && leftEdge && <span className={css.leftEdge} aria-hidden="true" />}
        {overflow && rightEdge && <span className={css.rightEdge} aria-hidden="true" />}
      </div>
      {overflow && <div className={css.scrollbar}>
        <input type="range" aria-label={t('横向滚动表格', 'Scroll table horizontally')} min={0} max={Math.max(0, geometry.content - geometry.viewport)} step={1} value={Math.min(geometry.left, Math.max(0, geometry.content - geometry.viewport))}
          style={{ '--table-thumb': `${Math.max(24, geometry.viewport * geometry.viewport / geometry.content)}px` } as CSSProperties}
          onChange={event => { if (viewport.current) viewport.current.scrollLeft = Number(event.currentTarget.value) }} />
      </div>}
    </div>
    <MessageDialog open={preview} onClose={() => setPreview(false)} title={t('表格预览', 'Table preview')} description={t('在更大的可滚动视图中查看表格。', 'View the table in a larger scrollable area.')} t={t}>
      <div className={`${css.scroll} ${css.preview}`} tabIndex={0} onKeyDown={keyboardScroll} role="region" aria-label={t('表格预览内容', 'Table preview content')}><table>{children}</table></div>
    </MessageDialog>
  </div>
}
