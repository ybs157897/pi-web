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
export function readTableRows(table: HTMLTableElement | null): string[][] {
  return Array.from(table?.rows ?? [], row => Array.from(row.cells, cell => cell.innerText ?? cell.textContent ?? ''))
}
function keyboardScroll(event: KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget) return
  const element = event.currentTarget
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? element.scrollWidth - element.clientWidth
    : event.key === 'ArrowRight' ? element.scrollLeft + 80 : event.key === 'ArrowLeft' ? element.scrollLeft - 80 : undefined
  if (next === undefined || element.scrollWidth <= element.clientWidth) return
  event.preventDefault(); element.scrollLeft = next
}

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
        <button type="button" aria-label={state === 'copied' ? t('已复制', 'Copied') : t('复制 Markdown', 'Copy Markdown')} title={t('复制 Markdown', 'Copy Markdown')} onClick={() => { void copy(tableMarkdown(readTableRows(table.current))) }}>{state === 'copied' ? <Check size={14} /> : <Copy size={14} />}</button>
        <button type="button" aria-label={t('下载 CSV', 'Download CSV')} title={t('下载 CSV', 'Download CSV')} onClick={download}><Download size={14} /></button>
        <button type="button" aria-label={t('预览表格', 'Preview table')} title={t('预览表格', 'Preview table')} onClick={() => setPreview(true)}><Maximize2 size={14} /></button>
        {canExpand && <button type="button" aria-label={expanded ? t('收回表格宽度', 'Collapse table width') : t('扩展表格宽度', 'Expand table width')} title={expanded ? t('收回表格宽度', 'Collapse table width') : t('扩展表格宽度', 'Expand table width')} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ArrowRightFromLine size={14} /> : <ArrowLeftFromLine size={14} />}</button>}
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
