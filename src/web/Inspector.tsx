import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CodeBlock, DiffBlock, IconBrowseOutlineRegular, IconCloseOutlineRegular, MarkdownText, ReadBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginContextEntry, PluginUiPage, PluginUiSurfaceView } from '../shared/plugin-ui.ts'
import { diffLabels, markdownLabels, readLabels } from './render-labels.ts'
import { safeWorkspaceAssetUrl, sandboxedHtml } from './inspector-document.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import PlanPreview, { type PlanDocument } from './PlanPreview.tsx'
import WorkspaceBrowserPage from './WorkspaceBrowserPage.tsx'
import { PluginUiPane } from './PluginUiPane.tsx'
import SubagentPane from './SubagentPane.tsx'
import SubagentDirectory from './SubagentDirectory.tsx'
import type { SubagentSummary, WorkspaceSummary } from '../shared/types.ts'
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

/** The inspector's views: a workspace browser beside file, diff, plan, plugin and subagent documents. */
export type InspectorView = 'file' | 'diff' | 'plan' | 'browse' | 'plugin' | 'subagent' | 'subagents'

/** One read-only child conversation the inspector keeps mounted as a tab. */
export interface InspectorSubagentTab {
  id: string
  title: string
}

/** The subagent directory tab: every child of the open parent, live and ended. */
export interface InspectorSubagentDirectory {
  subagents: readonly SubagentSummary[]
  onOpen: (childId: string, title?: string) => void
}

export interface InspectorBrowse {
  workspace: WorkspaceSummary
  /** The directory the browser opens at; empty means the workspace root. */
  path?: string
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
  /** Every plugin page stays mounted while its tab is not active; the page keeps its own state. */
  pluginPages?: readonly PluginUiPage[]
  activePluginPageId?: string
  /**
   * Hosts the transcript's inline cards created, keyed by page id. Appending one here moves the
   * same iframe into the panel instead of mounting a second page.
   */
  pluginPageHosts?: Readonly<Record<string, HTMLElement>>
  /** Page ids whose host the side pane owns; pages outside the set keep their own pane. */
  sidePageIds?: ReadonlySet<string>
  /** Park a host in the app's holding node instead of detaching it when this slot unmounts. */
  onReleasePluginPageHost?: (host: HTMLElement) => void
  onSelectPluginPage?: (id: string) => void
  onClosePluginPage?: (id: string) => void
  onPluginContext?: (entry: PluginContextEntry) => void
  onPluginMessage?: (text: string) => void
  onPluginOpenLink?: (url: string) => void
  /** Surfaces the `+` menu lists for the current workspace and conversation. */
  pluginSurfaces?: readonly PluginUiSurfaceView[]
  onOpenPluginSurface?: (surface: PluginUiSurfaceView) => void
  onRefreshPluginSurfaces?: () => void | Promise<void>
  /** Read-only child conversations, appended after the document and plugin tabs. */
  subagentTabs?: readonly InspectorSubagentTab[]
  activeSubagentId?: string
  onSelectSubagentTab?: (id: string) => void
  onCloseSubagentTab?: (id: string) => void
  /** The subagent directory page, opened from the status card's ended-agents footer. */
  subagentDirectory?: InspectorSubagentDirectory | null
  onCloseSubagentDirectory?: () => void
  onClose: () => void
}

const noop = (): void => {}

const NO_SIDE_PAGES: ReadonlySet<string> = new Set()

/** Append a transcript-owned page host so the inspector shows the same iframe, not a reload. */
function PluginPageHostSlot({ pageId, host, hidden, onRelease }: { pageId: string; host: HTMLElement; hidden: boolean; onRelease?: (host: HTMLElement) => void }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = container.current
    if (element === null) return
    element.appendChild(host)
    return () => {
      if (host.parentElement !== element) return
      // Keep the iframe connected while the tab closes; detaching and reattaching a frame
      // reloads it, which would lose the page's local state.
      if (onRelease !== undefined) onRelease(host)
      else element.removeChild(host)
    }
  }, [host, onRelease])
  return <div ref={container} className={css.pluginPageHost} hidden={hidden} data-plugin-host-slot={pageId} />
}

/** Show a workspace file, recorded artifact, submitted plan, workspace browser or plugin page. */
export default function Inspector({
  file = null, diff = null, plan = null, browse = null, view, onView, loading = false, error = null,
  pluginPages = [], activePluginPageId, pluginPageHosts = {}, sidePageIds = NO_SIDE_PAGES,
  onReleasePluginPageHost,
  onSelectPluginPage, onClosePluginPage,
  onPluginContext, onPluginMessage, onPluginOpenLink,
  pluginSurfaces = [], onOpenPluginSurface, onRefreshPluginSurfaces, onClose,
  subagentTabs = [], activeSubagentId, onSelectSubagentTab, onCloseSubagentTab,
  subagentDirectory = null, onCloseSubagentDirectory,
}: InspectorProps) {
  const { t } = useUiPreferences()
  const [surfacesOpen, setSurfacesOpen] = useState(false)
  const [surfacesLoading, setSurfacesLoading] = useState(false)
  const surfacesAnchor = useRef<HTMLSpanElement>(null)
  const planView = view === 'plan'
  const pluginView = view === 'plugin' && pluginPages.length > 0
  const subagentView = view === 'subagent' && subagentTabs.length > 0
  const directoryView = view === 'subagents' && subagentDirectory !== null
  const browseView = browse !== null && view === 'browse'
  const activePluginPage = pluginPages.find(page => page.id === activePluginPageId)
  const activeSubagentTab = subagentTabs.find(tab => tab.id === activeSubagentId)
  const path = directoryView
    ? t('子智能体目录', 'Subagent directory')
    : subagentView
      ? activeSubagentTab?.title ?? t('子智能体', 'Subagent')
      : pluginView
        ? activePluginPage?.title ?? activePluginPage?.pluginId ?? t('插件', 'Plugin')
        : browse !== null && view === 'browse'
          ? browse.workspace.name
          : planView ? t('计划', 'Plan') : diff?.path ?? file?.path ?? t('文件检查器', 'File inspector')
  const hasDocument = plan !== null || diff !== null || file !== null
  const showTabs = onView !== undefined
    && (browse !== null || hasDocument || pluginPages.length > 0 || subagentTabs.length > 0
      || subagentDirectory !== null || onRefreshPluginSurfaces !== undefined)
  useEffect(() => {
    if (!surfacesOpen) return
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && surfacesAnchor.current?.contains(event.target) === true) return
      setSurfacesOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [surfacesOpen])
  // A view switch dismisses the surface menu; it belongs to the tab it was opened from.
  useEffect(() => { setSurfacesOpen(false) }, [view])
  const toggleSurfaces = (): void => {
    const next = !surfacesOpen
    setSurfacesOpen(next)
    if (!next || onRefreshPluginSurfaces === undefined) return
    setSurfacesLoading(true)
    const pending = onRefreshPluginSurfaces()
    if (pending instanceof Promise) void pending.finally(() => { setSurfacesLoading(false) })
    else setSurfacesLoading(false)
  }
  const closeActive = (): void => {
    if (directoryView && onCloseSubagentDirectory !== undefined) {
      onCloseSubagentDirectory()
      return
    }
    if (subagentView && onCloseSubagentTab !== undefined) {
      const target = activeSubagentId ?? subagentTabs[0]?.id
      if (target !== undefined) {
        onCloseSubagentTab(target)
        return
      }
    }
    if (pluginView && onClosePluginPage !== undefined) {
      const target = activePluginPageId ?? pluginPages[0]?.id
      if (target !== undefined) {
        onClosePluginPage(target)
        return
      }
    }
    onClose()
  }
  const closeLabel = directoryView
    ? t('关闭子智能体目录', 'Close subagent directory')
    : subagentView
      ? t('关闭子智能体会话', 'Close subagent session')
      : pluginView
        ? t('关闭插件页面', 'Close plugin page')
        : browseView
          ? t('关闭文件浏览器', 'Close file browser')
          : planView ? t('关闭计划检查器', 'Close plan inspector') : t('关闭文件检查器', 'Close file inspector')
  return (
    <aside className={css.root} aria-label={directoryView
      ? t('子智能体目录', 'Subagent directory')
      : subagentView
        ? t('子智能体会话', 'Subagent session')
        : pluginView
          ? t('插件面板', 'Plugin panel')
          : browseView
            ? t('文件浏览器', 'File browser')
            : planView ? t('计划检查器', 'Plan inspector') : t('文件检查器', 'File inspector')}>
      <header className={css.header}>
        <div className={css.fileIcon} aria-hidden="true"><IconBrowseOutlineRegular size={15} /></div>
        <div className={css.path} title={path}>{path}</div>
        {showTabs && <div className={css.viewTabs} role="group" aria-label={t('检查器视图', 'Inspector view')}>
          {browse !== null && <button type="button" data-browse-view aria-pressed={browseView}
            onClick={() => { setSurfacesOpen(false); onView('browse') }}>{t('浏览', 'Browse')}</button>}
          {(diff !== null || file !== null) && <button type="button" aria-pressed={!planView && !browseView && !pluginView && !subagentView && !directoryView}
            onClick={() => { setSurfacesOpen(false); onView(diff !== null ? 'diff' : 'file') }}>{diff !== null ? t('差异', 'Diff') : t('文件', 'File')}</button>}
          {plan !== null && <button type="button" data-plan-view aria-pressed={planView}
            onClick={() => { setSurfacesOpen(false); onView('plan') }}>{t('计划', 'Plan')}</button>}
          {pluginPages.map(page => {
            const title = page.title ?? page.pluginId
            return <span key={page.id} className={css.pluginTab} data-plugin-tab={page.id}>
              <button type="button" className={css.pluginTabButton}
                aria-pressed={pluginView && page.id === activePluginPageId} title={title}
                onClick={() => { setSurfacesOpen(false); onSelectPluginPage?.(page.id); onView('plugin') }}>{title}</button>
              {onClosePluginPage !== undefined && <button type="button" className={css.pluginTabClose}
                aria-label={t(`关闭插件页面 ${title}`, `Close plugin page ${title}`)}
                onClick={() => { onClosePluginPage(page.id) }}><IconCloseOutlineRegular size={11} /></button>}
            </span>
          })}
          {onRefreshPluginSurfaces !== undefined && <span className={css.surfacesAnchor} ref={surfacesAnchor}>
            <button type="button" className={css.addPage} aria-label={t('打开插件页面', 'Open plugin page')}
              aria-expanded={surfacesOpen} onClick={toggleSurfaces}>+</button>
            {surfacesOpen && <div className={css.surfacesMenu} role="group" aria-label={t('可用插件页面', 'Available plugin pages')}>
              {surfacesLoading
                ? <span className={css.surfacesEmpty}>{t('正在读取插件…', 'Loading plugins…')}</span>
                : pluginSurfaces.length === 0
                  ? <span className={css.surfacesEmpty}>{t('去设置里安装插件', 'Install plugins in Settings')}</span>
                  : pluginSurfaces.map(surface => <button key={surface.id} type="button" className={css.surfaceItem}
                    data-plugin-surface={surface.id}
                    onClick={() => { setSurfacesOpen(false); onOpenPluginSurface?.(surface) }}>
                    <span className={css.surfaceTitle}>{surface.title}</span>
                    <span className={css.surfaceMeta}>{surface.pluginName}</span>
                  </button>)}
            </div>}
          </span>}
          {subagentDirectory !== null && <span className={css.pluginTab} data-subagent-directory-tab>
            <button type="button" className={css.pluginTabButton} aria-pressed={directoryView}
              onClick={() => { setSurfacesOpen(false); onView?.('subagents') }}>{t('子智能体目录', 'Subagents')}</button>
            {onCloseSubagentDirectory !== undefined && <button type="button" className={css.pluginTabClose}
              aria-label={t('关闭子智能体目录', 'Close subagent directory')}
              onClick={() => { onCloseSubagentDirectory() }}><IconCloseOutlineRegular size={11} /></button>}
          </span>}
          {subagentTabs.map(tab => {
            const title = tab.title
            return <span key={tab.id} className={css.pluginTab} data-subagent-tab={tab.id}>
              <button type="button" className={css.pluginTabButton}
                aria-pressed={subagentView && tab.id === activeSubagentId} title={title}
                onClick={() => { setSurfacesOpen(false); onSelectSubagentTab?.(tab.id); onView('subagent') }}>{title}</button>
              {onCloseSubagentTab !== undefined && <button type="button" className={css.pluginTabClose}
                aria-label={t(`关闭子智能体会话 ${title}`, `Close subagent session ${title}`)}
                onClick={() => { onCloseSubagentTab(tab.id) }}><IconCloseOutlineRegular size={11} /></button>}
            </span>
          })}
        </div>}
        <button type="button" className={css.close} onClick={closeActive} aria-label={closeLabel}>
          <IconCloseOutlineRegular size={15} />
        </button>
      </header>
      {pluginPages.length > 0 && <div className={css.pluginSurfaces} data-plugin-surfaces hidden={!pluginView}>
        {pluginPages.map(page => {
          const host = pluginPageHosts[page.id]
          const hidden = page.id !== activePluginPageId
          // An inline card already mounted this page; move its host instead of opening a second iframe.
          return host !== undefined && sidePageIds.has(page.id)
            ? <PluginPageHostSlot key={page.id} pageId={page.id} host={host} hidden={hidden} onRelease={onReleasePluginPageHost} />
            : <PluginUiPane key={page.id} page={page} hidden={hidden}
              onContext={onPluginContext ?? noop} onMessage={onPluginMessage ?? noop} onOpenLink={onPluginOpenLink ?? noop} />
        })}
      </div>}
      {subagentDirectory !== null && <div className={css.subagentSurfaces} data-subagent-directory-surface hidden={!directoryView}>
        <SubagentDirectory subagents={subagentDirectory.subagents} onOpen={subagentDirectory.onOpen} />
      </div>}
      {subagentTabs.length > 0 && <div className={css.subagentSurfaces} data-subagent-surfaces hidden={!subagentView}>
        {subagentTabs.map(tab => <SubagentPane key={tab.id} childId={tab.id} title={tab.title}
          hidden={!subagentView || tab.id !== activeSubagentId} />)}
      </div>}
      {browse !== null && <div className={css.browseSurface} hidden={!browseView}>
        <WorkspaceBrowserPage workspace={browse.workspace} path={browse.path ?? ''} onOpenFile={browse.onOpenFile} compact />
      </div>}
      {!pluginView && !browseView && !subagentView && !directoryView && (planView
        ? <PlanPreview plan={plan} loading={loading} error={error} />
        : <>
          {loading && <div className={css.message} role="status">{t('正在读取文件…', 'Reading file…')}</div>}
          {!loading && error !== null && error !== '' && <div className={css.error} role="alert">{error}</div>}
          {!loading && (error === null || error === '') && diff !== null && <DiffContents diff={diff} />}
          {!loading && (error === null || error === '') && diff === null && file !== null && <FileContents key={file.path} file={file} />}
          {!loading && error === null && diff === null && file === null && <div className={css.empty}>{t('选择文件或工具差异查看详情', 'Select a file or tool diff to inspect')}</div>}
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

