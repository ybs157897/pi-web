import { useMemo, useState } from 'react'
import {
  CodeBlock, DiffBlock, IconBrowseOutlineRegular, IconCloseOutlineRegular, MarkdownText, ReadBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { diffLabels, markdownLabels, readLabels } from './render-labels.ts'
import { safeWorkspaceAssetUrl, sandboxedHtml } from './inspector-document.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import PlanPreview, { type PlanDocument } from './PlanPreview.tsx'
import WorkspaceBrowserPage from './WorkspaceBrowserPage.tsx'
import type { WorkspaceSummary } from '../shared/types.ts'
import type { InspectorDiff } from './transcript.tsx'
import css from './Inspector.module.css'

export interface InspectorFile {
  path: string
  content?: string
  mimeType?: string
  language?: string
  line?: number
  size?: number
  /** Workspace that owns the path, used to resolve local Markdown images. */
  workspaceId?: string
  /** Same-origin, workspace-scoped asset URL returned by the server. */
  url?: string
}

export type { InspectorDiff } from './transcript.tsx'

/** The inspector's views: a workspace browser beside file, diff and plan documents. */
export type InspectorView = 'file' | 'diff' | 'plan' | 'browse'

export interface InspectorBrowse {
  workspace: WorkspaceSummary
  onOpenFile: (path: string) => void
}

export interface InspectorProps {
  file?: InspectorFile | null
  diff?: InspectorDiff | null
  /** The latest submitted plan, shown in DSH's plan preview (`PlanPreview.tsx:18-40`). */
  plan?: PlanDocument | null
  /** A workspace to browse in this pane; keeping it mounted preserves the open folder. */
  browse?: InspectorBrowse | null
  view?: InspectorView
  onView?: (view: InspectorView) => void
  loading?: boolean
  error?: string | null
  onClose: () => void
}

/** Show a workspace file, recorded artifact, submitted plan, or workspace browser in the right inspector panel. */
export default function Inspector({ file = null, diff = null, plan = null, browse = null, view, onView, loading = false, error = null, onClose }: InspectorProps) {
  const { t } = useUiPreferences()
  const planView = view === 'plan'
  const browseView = browse !== null && view === 'browse'
  const path = browse !== null && view === 'browse'
    ? browse.workspace.name
    : planView ? t('计划', 'Plan') : diff?.path ?? file?.path ?? t('文件检查器', 'File inspector')
  const hasDocument = plan !== null || diff !== null || file !== null
  return (
    <aside className={css.root} aria-label={browseView
      ? t('文件浏览器', 'File browser')
      : planView ? t('计划检查器', 'Plan inspector') : t('文件检查器', 'File inspector')}>
      <header className={css.header}>
        <div className={css.fileIcon} aria-hidden="true"><IconBrowseOutlineRegular size={15} /></div>
        <div className={css.path} title={path}>{path}</div>
        {onView !== undefined && (browse !== null || hasDocument) && <div className={css.viewTabs} role="group" aria-label={t('检查器视图', 'Inspector view')}>
          {browse !== null && <button type="button" data-browse-view aria-pressed={browseView}
            onClick={() => { onView('browse') }}>{t('浏览', 'Browse')}</button>}
          {(diff !== null || file !== null) && <button type="button" aria-pressed={!planView && !browseView}
            onClick={() => { onView(diff !== null ? 'diff' : 'file') }}>{diff !== null ? t('差异', 'Diff') : t('文件', 'File')}</button>}
          {plan !== null && <button type="button" data-plan-view aria-pressed={planView}
            onClick={() => { onView('plan') }}>{t('计划', 'Plan')}</button>}
        </div>}
        <button type="button" className={css.close} onClick={onClose} aria-label={browseView
          ? t('关闭文件浏览器', 'Close file browser')
          : planView ? t('关闭计划检查器', 'Close plan inspector') : t('关闭文件检查器', 'Close file inspector')}>
          <IconCloseOutlineRegular size={15} />
        </button>
      </header>
      {browse !== null && <div className={css.browseSurface} hidden={!browseView}>
        <WorkspaceBrowserPage workspace={browse.workspace} onOpenFile={browse.onOpenFile} compact />
      </div>}
      {!browseView && (planView
        ? <PlanPreview plan={plan} loading={loading} error={error} />
        : <>
          {loading && <div className={css.message} role="status">{t('正在读取文件…', 'Reading file…')}</div>}
          {!loading && error !== null && error !== '' && <div className={css.error} role="alert">{error}</div>}
          {!loading && (error === null || error === '') && diff !== null && <DiffContents diff={diff} />}
          {!loading && (error === null || error === '') && diff === null && file !== null && <FileContents key={file.path} file={file} />}
          {!loading && error === null && diff === null && file === null && !browseView && <div className={css.empty}>{t('选择文件或工具差异查看详情', 'Select a file or tool diff to inspect')}</div>}
        </>)}
    </aside>
  )
}

function DiffContents({ diff }: { diff: InspectorDiff }) {
  const { t } = useUiPreferences()
  if (diff.oldText !== undefined && diff.newText !== undefined) {
    return <div className={css.content}><DiffBlock diffs={[{ path: diff.path, oldText: diff.oldText, newText: diff.newText }]} labels={diffLabels(t)} /></div>
  }
  if (diff.diff !== undefined) {
    return <div className={css.content}><CodeBlock code={diff.diff} lang="diff" copyLabel={t('复制差异', 'Copy diff')} copiedLabel={t('已复制', 'Copied')}
      toolbarLabels={markdownLabels(t).code.toolbarLabels} /></div>
  }
  if (diff.newText !== undefined) {
    return <div className={css.content}><CodeBlock code={diff.newText} lang={languageFromPath(diff.path)}
      copyLabel={t('复制内容', 'Copy content')} copiedLabel={t('已复制', 'Copied')} /></div>
  }
  return <div className={css.empty}>{t('没有可显示的文件差异', 'No file diff was recorded')}</div>
}

function FileContents({ file }: { file: InspectorFile }) {
  const { t } = useUiPreferences()
  const [htmlMode, setHtmlMode] = useState<'preview' | 'source'>('preview')
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>(file.line === undefined ? 'preview' : 'source')
  const mime = file.mimeType?.split(';')[0]?.trim().toLocaleLowerCase() ?? ''
  const assetUrl = safeWorkspaceAssetUrl(file.url, window.location.href)
  const imageUrl = mime.startsWith('image/') ? safeImageUrl(file.url) : undefined
  // Local Markdown images are workspace assets, not page URLs. Resolve them
  // relative to the Markdown file so previews match DSH's document surface.
  const pathImages = useMemo(() => {
    if (file.workspaceId === undefined) return undefined
    const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
    return {
      resolve: (value: string): string | undefined => {
        const target = value.trim()
        if (target === '' || target.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return undefined
        const relative = target.startsWith('/') ? target.slice(1) : `${directory}${target}`
        const parts: string[] = []
        for (const part of relative.replaceAll('\\', '/').split('/')) {
          if (part === '' || part === '.') continue
          if (part === '..') {
            if (parts.length === 0) return undefined
            parts.pop()
            continue
          }
          parts.push(part)
        }
        if (parts.length === 0) return undefined
        return `/api/workspaces/${encodeURIComponent(file.workspaceId!)}/asset?${new URLSearchParams({ path: parts.join('/') }).toString()}`
      },
    }
  }, [file.path, file.workspaceId])
  if (imageUrl !== undefined) return <div className={css.imageSurface}><img src={imageUrl} alt={file.path} /></div>
  if (isHtmlFile(file, mime) && file.content !== undefined) return (
    <div className={css.documentSurface}>
      <div className={css.documentToolbar} role="group" aria-label={t('HTML 查看方式', 'HTML view mode')}>
        <button type="button" aria-pressed={htmlMode === 'preview'} onClick={() => { setHtmlMode('preview') }}>
          {t('预览', 'Preview')}
        </button>
        <button type="button" aria-pressed={htmlMode === 'source'} onClick={() => { setHtmlMode('source') }}>
          {t('源码', 'Source')}
        </button>
      </div>
      {htmlMode === 'source' ? (
        <div className={css.content}><CodeBlock code={file.content} lang="html" lineNumbers
          copyLabel={t('复制源码', 'Copy source')} copiedLabel={t('已复制', 'Copied')} /></div>
      ) : (
        <iframe className={css.htmlPreview} title={file.path} sandbox="allow-scripts"
          referrerPolicy="no-referrer" srcDoc={sandboxedHtml(file.content)} />
      )}
    </div>
  )
  if (isPdfFile(file, mime)) return <div className={css.documentSurface}>
    {assetUrl !== undefined && <iframe className={css.pdfPreview} title={file.path}
      referrerPolicy="no-referrer" src={assetUrl} />}
    <div className={css.documentActions}>
      {assetUrl !== undefined ? <>
        <a href={assetUrl} target="_blank" rel="noopener noreferrer">{t('在新窗口打开 PDF', 'Open PDF in new tab')}</a>
        <a href={assetUrl} download={baseName(file.path)}>{t('下载 PDF', 'Download PDF')}</a>
      </> : <span>{t('没有可用的文件资源地址', 'No file asset URL is available')}</span>}
    </div>
  </div>
  if (isMarkdownFile(file, mime) && file.content !== undefined) return (
    <div className={css.documentSurface}>
      <div className={css.documentToolbar} role="group" aria-label={t('Markdown 查看方式', 'Markdown view mode')}>
        <button type="button" aria-pressed={markdownMode === 'preview'} onClick={() => { setMarkdownMode('preview') }}>
          {t('预览', 'Preview')}
        </button>
        <button type="button" aria-pressed={markdownMode === 'source'} onClick={() => { setMarkdownMode('source') }}>
          {t('源码', 'Source')}
        </button>
      </div>
      {markdownMode === 'source'
        ? <SourceView file={file} t={t} />
        : <div className={`${css.content} ${css.markdownPreview}`}>
          <MarkdownText text={file.content} labels={markdownLabels(t)} pathImages={pathImages} />
        </div>}
    </div>
  )
  if (isTextMime(mime) && file.content !== undefined) return <SourceView file={file} t={t} />
  if (mime.startsWith('image/')) return <div className={css.empty}>
    <strong>{t('图片预览地址不可用', 'Image preview URL is unavailable')}</strong>
    <span>{file.mimeType}</span>
  </div>
  return <div className={css.empty}>
    <strong>{t('无法以内嵌方式预览此文件', 'This file cannot be previewed inline')}</strong>
    <span>{file.mimeType ?? t('未知文件类型', 'Unknown file type')}</span>
    {file.size !== undefined && <span>{formatFileSize(file.size)}</span>}
    {assetUrl !== undefined && <span className={css.documentActions}>
      <a href={assetUrl} target="_blank" rel="noopener noreferrer">{t('打开文件', 'Open file')}</a>
      <a href={assetUrl} download={baseName(file.path)}>{t('下载文件', 'Download file')}</a>
    </span>}
  </div>
}

function SourceView({ file, t }: { file: InspectorFile; t: (chinese: string, english: string) => string }) {
  const content = file.content ?? ''
  const language = file.language ?? languageFromPath(file.path)
  const lines = content.split(/\r?\n/u)
  return <div className={css.content}>
    {file.line !== undefined && <div className={css.lineNote}>{t(`定位到第 ${file.line} 行`, `Requested line ${file.line}`)}</div>}
    <ReadBlock label={file.path} lines={lines.map((text, index) => ({ number: index + 1, text }))}
      totalLines={lines.length} lang={language} labels={readLabels(t)} maxLines={Math.max(lines.length, 1)} />
  </div>
}

function safeImageUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/u.test(value)) return value
  return safeWorkspaceAssetUrl(value, window.location.href)
}

function isHtmlFile(file: InspectorFile, mime: string): boolean {
  return mime === 'text/html' || /\.html?$/iu.test(file.path)
}

function isMarkdownFile(file: InspectorFile, mime: string): boolean {
  return mime === 'text/markdown' || /\.(?:md|markdown|mdx)$/iu.test(file.path)
}

function isPdfFile(file: InspectorFile, mime: string): boolean {
  return mime === 'application/pdf' || /\.pdf$/iu.test(file.path)
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || /(?:json|xml|javascript|typescript|yaml|toml|x-sh|x-python|x-rust|x-c|x-c\+\+)/u.test(mime)
}

function languageFromPath(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase()
  if (extension === undefined || extension === path.toLocaleLowerCase()) return undefined
  const aliases: Record<string, string> = {
    cjs: 'javascript', htm: 'html', md: 'markdown', mjs: 'javascript', py: 'python', rs: 'rust', sh: 'bash', tsx: 'tsx', yml: 'yaml',
  }
  return aliases[extension] ?? extension
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function baseName(path: string): string {
  return path.split(/[\\/]/u).at(-1) || 'download'
}

