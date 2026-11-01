import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  CodeBlock, DiffBlock, IconBrowseOutlineRegular, IconCloseOutlineRegular, MarkdownText, ReadBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { FileDiff, FolderOpen, Globe, Maximize2, MessageSquareText, Minimize2, Plus, Puzzle, Waypoints } from 'lucide-react'
import type { PluginContextEntry, PluginUiPage, PluginUiSurfaceView } from '../shared/plugin-ui.ts'
import type { InspectorTab } from './inspector-tabs.ts'
import type { GitChangeSourceId, LastTurnChange } from './GitPane.tsx'
import type { SideChatMessage } from './SelectionChatPane.tsx'
import GitPane from './GitPane.tsx'
import BrowserPane from './BrowserPane.tsx'
import TrajectoryPane from './TrajectoryPane.tsx'
import SelectionChatPane from './SelectionChatPane.tsx'
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

/** Toast sink shared by the git review pane and its sources. */
export interface InspectorGitPane {
  activeSource: GitChangeSourceId
  onSelectSource: (source: GitChangeSourceId) => void
  /** Last-turn changes synthesized from the conversation's artifacts; undefined means no session context. */
  lastTurnChanges?: readonly LastTurnChange[]
  onNotice: (text: string) => void
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
  /** Workspace owning the git review tab; git tabs render an empty state without it. */
  workspaceId?: string
  /** The multi-tab shell's tabs; without them (and without a launcher) the pane keeps the single-slot views. */
  tabs?: readonly InspectorTab[]
  activeTabId?: string | null
  onSelectTab?: (id: string) => void
  onCloseTab?: (id: string) => void
  onCloseOtherTabs?: (id: string) => void
  onCloseAllTabs?: () => void
  onOpenNewTab?: () => void
  /** Full-view overlay state; the pane only paints the toggle, the app owns the layout. */
  fullView?: boolean
  onToggleFullView?: () => void
  /** The new-tab launcher's entries and recommended plugin surfaces. */
  launcher?: {
    surfaces: readonly PluginUiSurfaceView[]
    surfacesLoading: boolean
    onRefreshSurfaces: () => void | Promise<void>
    onOpenSurface: (surface: PluginUiSurfaceView) => void
    onOpenFiles: () => void
    onOpenReview: () => void
    onOpenBrowser: () => void
    onOpenTrajectory: () => void
    onOpenSelectionChat: () => void
    /** An already-open review tab hides the launcher's review entry, like ZCode's launcher dedupe. */
    canOpenReview: boolean
    canOpenTrajectory: boolean
    canOpenSelectionChat: boolean
  }
  /** Git review state for the `git` tab; without it the tab shows an empty state. */
  gitPane?: InspectorGitPane
  /** Browser tab navigation; the pane binds the tab id, the app owns the tab's mutable fields. */
  browserPane?: { onNavigate: (tabId: string, patch: { url?: string; addressDraft?: string; title?: string }) => void }
  /** Per-conversation side chat state; returning undefined falls back to an empty state. */
  selectionChat?: {
    for: (conversationId: string) => {
      messages: readonly SideChatMessage[]
      busy: boolean
      onSend: (text: string) => void
      /** A selection quote waiting to ride the next send, shown as a removable chip. */
      quotedText?: string
      onDismissQuote?: () => void
    } | undefined
  }
  /** Toast sink for the browser and trajectory panes, whose feedback escapes their own surface. */
  onNotice?: (text: string) => void
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
  workspaceId, tabs = [], activeTabId = null,
  onSelectTab, onCloseTab, onCloseOtherTabs, onCloseAllTabs, onOpenNewTab,
  fullView = false, onToggleFullView, launcher, gitPane, browserPane, selectionChat, onNotice,
}: InspectorProps) {
  const { t } = useUiPreferences()
  const [surfacesOpen, setSurfacesOpen] = useState(false)
  const [surfacesLoading, setSurfacesLoading] = useState(false)
  const surfacesAnchor = useRef<HTMLSpanElement>(null)
  // The tab context menu is app-level state here because it portals out of the pane.
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  // ZCode's shell: any tab, or a reachable launcher, switches the header into a tab strip.
  const shellMode = tabs.length > 0 || onOpenNewTab !== undefined
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
  useEffect(() => {
    if (tabMenu === null) return
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && tabMenuRef.current?.contains(event.target) === true) return
      setTabMenu(null)
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setTabMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [tabMenu])
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
  if (shellMode) {
    // In the shell the header close means "close the active tab"; with no tab left it collapses the pane.
    const activeTab = tabs.find(tab => tab.id === activeTabId)
    const closeShellActive = (): void => {
      if (activeTab !== undefined && onCloseTab !== undefined) onCloseTab(activeTab.id)
      else onClose()
    }
    const openTabMenu = (id: string, event: { clientX: number; clientY: number }): void => {
      if (onCloseTab === undefined) return
      setTabMenu({
        id,
        x: Math.max(0, Math.min(event.clientX, window.innerWidth - 176)),
        y: Math.max(0, Math.min(event.clientY, window.innerHeight - 116)),
      })
    }
    return (
      <aside className={`${css.root}${fullView ? ` ${css.fullscreen}` : ''}`} aria-label={t('检查器', 'Inspector')} data-inspector-shell>
        <header className={css.tabBar}>
          <div className={css.tabStrip} role="group" aria-label={t('检查器标签', 'Inspector tabs')}>
            {tabs.map(tab => {
              const active = tab.id === activeTabId
              return (
                <span key={tab.id} className={css.tab} data-inspector-tab-trigger={tab.id} data-active={active}
                  onAuxClick={event => { if (event.button === 1) onCloseTab?.(tab.id) }}
                  onContextMenu={event => { event.preventDefault(); openTabMenu(tab.id, event) }}>
                  <button type="button" className={css.tabButton} aria-pressed={active} title={tab.title}
                    onClick={() => onSelectTab?.(tab.id)}>{tab.title}</button>
                  {onCloseTab !== undefined && <button type="button" className={css.tabClose}
                    aria-label={t(`关闭标签 ${tab.title}`, `Close tab ${tab.title}`)}
                    onClick={() => onCloseTab(tab.id)}><IconCloseOutlineRegular size={11} /></button>}
                </span>
              )
            })}
          </div>
          {onOpenNewTab !== undefined && <button type="button" className={css.tabBarAction}
            aria-label={t('新增标签', 'New tab')} onClick={onOpenNewTab}><Plus size={15} /></button>}
          {onToggleFullView !== undefined && <button type="button" className={css.tabBarAction}
            aria-label={fullView ? t('退出完整视图', 'Exit full view') : t('进入完整视图', 'Enter full view')}
            title={fullView ? t('退出完整视图', 'Exit full view') : t('进入完整视图', 'Enter full view')}
            aria-pressed={fullView} onClick={onToggleFullView}>
            {fullView ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>}
          <button type="button" className={css.close} onClick={closeShellActive} aria-label={t('关闭标签', 'Close tab')}>
            <IconCloseOutlineRegular size={15} />
          </button>
        </header>
        <div className={css.tabSurfaces}>
          {tabs.map(tab => {
            const active = tab.id === activeTabId
            return <div key={tab.id} className={css.tabSurface} data-inspector-tab={tab.id} hidden={!active}>
              {tabContent(tab, {
                active, t, plan, loading, error, browse, pluginPages, pluginPageHosts, sidePageIds, onReleasePluginPageHost,
                onPluginContext, onPluginMessage, onPluginOpenLink, subagentDirectory,
                workspaceId, gitPane, browserPane, selectionChat, onNotice, launcher,
              })}
            </div>
          })}
        </div>
        {tabMenu !== null && createPortal(
          <div ref={tabMenuRef} className={css.tabMenu} role="menu" style={{ left: tabMenu.x, top: tabMenu.y }}>
            <button type="button" role="menuitem" className={css.tabMenuItem}
              onClick={() => { onCloseTab?.(tabMenu.id); setTabMenu(null) }}>{t('关闭标签', 'Close tab')}</button>
            <button type="button" role="menuitem" className={css.tabMenuItem} disabled={tabs.length <= 1}
              onClick={() => { onCloseOtherTabs?.(tabMenu.id); setTabMenu(null) }}>{t('关闭其他标签', 'Close other tabs')}</button>
            <button type="button" role="menuitem" className={css.tabMenuItem}
              onClick={() => { onCloseAllTabs?.(); setTabMenu(null) }}>{t('关闭所有标签', 'Close all tabs')}</button>
          </div>, document.body)}
      </aside>
    )
  }
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

/** Everything a tab's content renderer needs; gathered once so the dispatch stays a pure switch. */
interface TabContentDeps {
  active: boolean
  t: (chinese: string, english: string) => string
  plan: PlanDocument | null
  loading: boolean
  error: string | null
  browse: InspectorBrowse | null
  pluginPages: readonly PluginUiPage[]
  pluginPageHosts: Readonly<Record<string, HTMLElement>>
  sidePageIds: ReadonlySet<string>
  onReleasePluginPageHost?: (host: HTMLElement) => void
  onPluginContext?: (entry: PluginContextEntry) => void
  onPluginMessage?: (text: string) => void
  onPluginOpenLink?: (url: string) => void
  subagentDirectory: InspectorSubagentDirectory | null
  workspaceId?: string
  gitPane?: InspectorGitPane
  browserPane?: { onNavigate: (tabId: string, patch: { url?: string; addressDraft?: string; title?: string }) => void }
  selectionChat?: NonNullable<InspectorProps['selectionChat']>
  onNotice?: (text: string) => void
  launcher?: NonNullable<InspectorProps['launcher']>
}

/** Route one shell tab to its renderer; every surface keeps its own pane mounted while hidden. */
function tabContent(tab: InspectorTab, deps: TabContentDeps): ReactNode {
  const { t, active } = deps
  switch (tab.type) {
    case 'document': {
      const doc = tab.doc
      if (doc === undefined) return <div className={css.empty}>{t('没有可显示的内容', 'Nothing to show')}</div>
      if (doc.kind === 'file') return <FileContents key={doc.file.path} file={doc.file} />
      if (doc.kind === 'diff') return <DiffContents diff={doc.diff} />
      return <PlanPreview plan={deps.plan} loading={deps.loading} error={deps.error} />
    }
    case 'browse':
      return deps.browse !== null
        ? <WorkspaceBrowserPage workspace={deps.browse.workspace} path={deps.browse.path ?? ''} onOpenFile={deps.browse.onOpenFile} compact />
        : <div className={css.empty}>{t('没有可浏览的工作区', 'No workspace to browse')}</div>
    case 'git':
      return deps.workspaceId !== undefined && deps.gitPane !== undefined
        ? <GitPane workspaceId={deps.workspaceId} activeSource={deps.gitPane.activeSource}
          onSelectSource={deps.gitPane.onSelectSource} lastTurnChanges={deps.gitPane.lastTurnChanges}
          onNotice={deps.gitPane.onNotice} />
        : <div className={css.empty}>{t('没有可审查的代码变更', 'No code changes to review')}</div>
    case 'browser':
      return <BrowserPane tab={tab} onNotice={deps.onNotice ?? noop}
        onNavigate={patch => { deps.browserPane?.onNavigate(tab.id, patch) }} />
    case 'trajectory':
      return <TrajectoryPane conversationId={tab.conversationId!} title={tab.title} onNotice={deps.onNotice ?? noop} />
    case 'selection-chat': {
      const chat = deps.selectionChat?.for(tab.conversationId ?? '')
      return chat === undefined
        ? <div className={css.empty}>{t('没有可显示的对话', 'No conversation to show')}</div>
        : <SelectionChatPane conversationId={tab.conversationId!} title={tab.title}
          messages={chat.messages} busy={chat.busy} onSend={chat.onSend}
          quotedText={chat.quotedText} onDismissQuote={chat.onDismissQuote} />
    }
    case 'plugin': {
      const page = deps.pluginPages.find(candidate => candidate.id === tab.pageId)
      if (page === undefined) return <div className={css.empty}>{t('插件页面已关闭', 'This plugin page is closed')}</div>
      const host = deps.pluginPageHosts[page.id]
      // An inline card already mounted this page; move its host instead of opening a second iframe.
      return host !== undefined && deps.sidePageIds.has(page.id)
        ? <PluginPageHostSlot pageId={page.id} host={host} hidden={!active} onRelease={deps.onReleasePluginPageHost} />
        : <PluginUiPane page={page} hidden={!active}
          onContext={deps.onPluginContext ?? noop} onMessage={deps.onPluginMessage ?? noop} onOpenLink={deps.onPluginOpenLink ?? noop} />
    }
    case 'subagent':
      return <SubagentPane childId={tab.childId!} title={tab.title} hidden={!active} />
    case 'subagents':
      return deps.subagentDirectory !== null
        ? <SubagentDirectory subagents={deps.subagentDirectory.subagents} onOpen={deps.subagentDirectory.onOpen} />
        : <div className={css.empty}>{t('没有子智能体记录', 'No subagent records')}</div>
    case 'new-tab':
      return deps.launcher === undefined
        ? <div className={css.empty}>{t('没有可打开的内容', 'Nothing to open')}</div>
        : <NewTabLauncher launcher={deps.launcher} />
  }
}

/** The `new-tab` page: built-in entries up top, recommended plugin apps below a short rule. */
function NewTabLauncher({ launcher }: { launcher: NonNullable<InspectorProps['launcher']> }) {
  const { t } = useUiPreferences()
  const entries = [
    { id: 'files', icon: FolderOpen, label: t('文件', 'Files'), description: t('从目录中选择一个文件', 'Choose a file from the workspace'), available: true, open: launcher.onOpenFiles },
    { id: 'browser', icon: Globe, label: t('浏览器', 'Browser'), description: t('浏览网页和预览应用', 'Browse the web and preview apps'), available: true, open: launcher.onOpenBrowser },
    { id: 'review', icon: FileDiff, label: t('审查', 'Review'), description: t('查看代码变更与差异', 'Review code changes and diffs'), available: launcher.canOpenReview, open: launcher.onOpenReview },
    { id: 'trajectory', icon: Waypoints, label: t('模型调用轨迹', 'Model trajectory'), description: t('查看本次会话的模型调用记录', 'View this conversation\'s model calls'), available: launcher.canOpenTrajectory, open: launcher.onOpenTrajectory },
    { id: 'selection-chat', icon: MessageSquareText, label: t('辅助对话', 'Side chat'), description: t('在侧边面板中继续对话', 'Continue the conversation in the side panel'), available: launcher.canOpenSelectionChat, open: launcher.onOpenSelectionChat },
  ].filter(entry => entry.available)
  return <div className={css.launcher}>
    <h2 className={css.launcherTitle}>{t('新标签页', 'New tab')}</h2>
    <div className={css.launcherGrid}>
      {entries.map(entry => {
        const Icon = entry.icon
        return <button key={entry.id} type="button" className={css.launcherItem} data-launcher-entry={entry.id} onClick={entry.open}>
          <span className={css.launcherIcon} aria-hidden="true"><Icon size={20} /></span>
          <span className={css.launcherText}>
            <span className={css.launcherLabel}>{entry.label}</span>
            <span className={css.launcherDescription}>{entry.description}</span>
          </span>
          <span className={css.launcherPill}>{t('打开', 'Open')}</span>
        </button>
      })}
    </div>
    <div className={css.launcherDivider} aria-hidden="true" />
    <section className={css.launcherApps}>
      <h3 className={css.launcherSectionTitle}>{t('应用插件', 'Apps')}</h3>
      {launcher.surfaces.length === 0
        ? <div className={css.launcherEmpty}>{t('暂无推荐的应用插件', 'No recommended apps yet')}</div>
        : <div className={css.launcherGrid}>
          {launcher.surfaces.map(surface => <button key={surface.id} type="button" className={css.launcherItem}
            data-launcher-surface={surface.id} onClick={() => launcher.onOpenSurface(surface)}>
            <span className={css.launcherIcon} aria-hidden="true"><Puzzle size={20} /></span>
            <span className={css.launcherText}>
              <span className={css.launcherLabel}>{surface.title}</span>
              <span className={css.launcherDescription}>{surface.pluginName}</span>
            </span>
            <span className={css.launcherPill}>{t('打开', 'Open')}</span>
          </button>)}
        </div>}
    </section>
  </div>
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
