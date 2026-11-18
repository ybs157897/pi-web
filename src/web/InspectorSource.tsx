import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, IconCheckOutlineRegular, IconCopyOutlineRegular, IconWrapLinesOutlineRegular, languageForPath, useCodeHighlighter, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabFile } from './inspector-tabs.ts'
import { useCopyFeedback } from './message-rendering/hooks.ts'
import { readLabels } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './InspectorSource.module.css'

const PAGE_LINES = 800
const MAX_HIGHLIGHT_CHARS = 120_000

/** Read-only source with stable line elements before and after the grammar loads. */
export default function InspectorSource({ file, active, assetUrl }: { file: TabFile; active: boolean; assetUrl?: string }) {
  const { t } = useUiPreferences()
  const labels = readLabels(t)
  const { copy, state: copyState } = useCopyFeedback(writeClipboard)
  const [wrap, setWrap] = useState(false)
  const [page, setPage] = useState<{ start: number; line?: number; request?: number }>()
  const scrollport = useRef<HTMLDivElement>(null)
  const targetRow = useRef<HTMLDivElement>(null)
  const previousJump = useRef<{ line: number; request?: number }>()
  const content = file.content ?? ''
  const lines = useMemo(() => content.split(/\r\n|[\r\n]/u), [content])
  const excerpt = file.textWindow
  const firstLine = excerpt?.startLine ?? 1
  const totalLines = excerpt?.totalLines ?? lines.length
  const requestedLine = file.line
  const request = file.lineRequestId
  const target = requestedLine === undefined ? -1 : requestedLine - firstLine
  const targetAvailable = Number.isInteger(target) && target >= 0 && target < lines.length
  const start = page !== undefined && page.request === request && page.line === requestedLine && page.start < lines.length
    ? page.start
    : targetAvailable ? Math.max(0, Math.min(target - Math.floor(PAGE_LINES / 2), lines.length - PAGE_LINES)) : 0
  const visible = useMemo(() => lines.slice(start, start + PAGE_LINES), [lines, start])
  const end = start + visible.length
  const highlight = useCodeHighlighter(file.language ?? languageForPath(file.path))
  const tokens = useMemo(() => {
    if (!active) return undefined
    const fragment = visible.join('\n')
    return fragment.length <= MAX_HIGHLIGHT_CHARS ? highlight(fragment) : undefined
  }, [active, highlight, visible])

  useLayoutEffect(() => {
    const viewport = scrollport.current
    const row = targetRow.current
    if (!active || requestedLine === undefined || viewport === null || row === null) return
    if (previousJump.current?.line === requestedLine && previousJump.current.request === request) return
    previousJump.current = { line: requestedLine, request }
    viewport.scrollTop = Math.max(0, row.offsetTop + (row.offsetHeight - viewport.clientHeight) / 2)
  }, [active, requestedLine, request])

  const showPage = (next: number): void => {
    setPage({ start: next, line: requestedLine, request })
    if (scrollport.current !== null) scrollport.current.scrollTop = 0
  }
  const copyLabel = copyState === 'copied' ? labels.copied : copyState === 'error' ? t('复制失败', 'Copy failed')
    : excerpt === undefined ? labels.copy : t('复制片段', 'Copy excerpt')
  const wrapLabel = wrap ? labels.unwrapLabel : labels.wrapLabel
  const showRange = excerpt !== undefined || lines.length > PAGE_LINES
  return <div className={css.root}>
    <div className={css.toolbar}>
      <span className={css.path} title={file.path}>{file.path}</span>
      <Button variant="ghost" size="sm" icon={<IconWrapLinesOutlineRegular size={14} />}
        aria-label={wrapLabel} title={wrapLabel} aria-pressed={wrap} onClick={() => setWrap(value => !value)} />
      <Button variant="ghost" size="sm" icon={copyState === 'copied' ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
        aria-label={copyLabel} title={copyLabel} onClick={() => { void copy(content) }} />
    </div>
    {copyState === 'error' && <div className={css.notice} role="status">{copyLabel}</div>}
    {requestedLine !== undefined && <div role="status" className={targetAvailable ? css.srOnly : css.notice}>
      {targetAvailable ? t(`第 ${requestedLine} 行`, `Line ${requestedLine}`)
        : t(`文件中没有第 ${requestedLine} 行（共 ${totalLines} 行）`, `Line ${requestedLine} does not exist (${totalLines} lines total)`)}
    </div>}
    {showRange && <div className={css.range}>
      <span>{t(`第 ${firstLine + start}–${firstLine + end - 1} 行，共 ${totalLines} 行`,
        `Lines ${firstLine + start}–${firstLine + end - 1} of ${totalLines}`)}</span>
      {excerpt?.clippedLines && <span>{t('部分长行已截断', 'Long lines shortened')}</span>}
      {excerpt !== undefined && assetUrl !== undefined && <a href={assetUrl} download={file.path.split('/').at(-1)}>{t('下载完整文件', 'Download full file')}</a>}
      {lines.length > PAGE_LINES && <div className={css.paging}>
        <Button variant="ghost" size="sm" disabled={start === 0} onClick={() => showPage(Math.max(0, start - PAGE_LINES))}>
          {t('上一段', 'Previous lines')}
        </Button>
        <Button variant="ghost" size="sm" disabled={end === lines.length} onClick={() => showPage(end)}>
          {t('下一段', 'Next lines')}
        </Button>
      </div>}
    </div>}
    <div className={css.scrollport} ref={scrollport} tabIndex={0} role="region"
      aria-label={t(`${file.path} 的源码`, `Source for ${file.path}`)} data-source-wrap={wrap}
      style={{ '--source-gutter': `${Math.max(3, String(totalLines).length)}ch` } as CSSProperties}>
      <div className={css.lines}>
        {visible.map((text, index) => {
          const number = firstLine + start + index
          const selected = number === requestedLine
          const spans = tokens?.[index]
          return <div key={number} ref={selected ? targetRow : undefined} className={css.line} data-source-line={number}
            aria-current={selected ? 'location' : undefined}>
            <span className={css.gutter}>{number}</span>
            <code>{spans === undefined ? text : spans.map((span, key) => <span key={key} style={span.style}>{span.text}</span>)}</code>
          </div>
        })}
      </div>
    </div>
  </div>
}
