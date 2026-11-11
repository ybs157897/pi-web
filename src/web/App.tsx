import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, ChevronRight, Loader } from 'lucide-react'
import {
  Button, ConnectionIndicator, IconChecklistOutlineRegular, IconClockOutlineRegular,
  IconDownloadOutlineRegular, IconEllipsisOutlineRegular, IconListPenOutlineRegular,
  IconNewChatOutlineRegular, IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular, IconSettingsOutlineRegular,
  Menu, Modal, ShortcutKeys, Tag, Toast, Tooltip, focusWithoutRing, relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccessMode, AppSettings, ConversationDetail, ConversationSummary, CreateTaskInput, ModelCatalog,
  ModelOption, ProviderInput, SubagentSummary, TaskStatus, TaskSummary, ThinkingLevel, WorkspaceFileEntry, WorkspaceSummary,
  UpdateAppSettingsInput,
} from '../shared/types.ts'
import type { PluginContextEntry, PluginUiPage, PluginUiSurfaceView } from '../shared/plugin-ui.ts'
import { pluginContextBlock } from '../shared/plugin-ui.ts'
import { ApiFailure, api } from './api.ts'
import Composer, { type BusySendMode, type DraftImage } from './Composer.tsx'
import TodoPanel from './TodoPanel.tsx'
import SubagentPanel from './SubagentPanel.tsx'
import TeamPanel from './TeamPanel.tsx'
import GoalBar from './GoalBar.tsx'
import QuestionComposer from './QuestionComposer.tsx'
import SettingsDialog from './SettingsDialog.tsx'
import Transcript, { type PendingMessage } from './transcript.tsx'
import StatusPanel from './StatusPanel.tsx'
import { TaskChangesView, TaskSummaryView, countTaskChanges } from './TaskViews.tsx'
import { conversationStats, visibleTranscriptMessages } from './render-model.ts'
import { latestPlan, sessionPlans, type PlanDocument } from './plan-preview.ts'
import DirectoryBrowser from './DirectoryBrowser.tsx'
import Inspector from './Inspector.tsx'
import { PluginPageHostContext } from './plugin-page-pool.tsx'
import type { InspectorDiff, InspectorFile } from './Inspector.tsx'
import { activateTab, closeAllTabs, closeOtherTabs, closeTabs, nextSelectionChatOrdinal, normalizePaneState,
  openFromLauncher, readPaneMemory, stripConversationScoped, writePaneMemory,
  type InspectorTab, type PaneState } from './inspector-tabs.ts'
import type { GitChangeSourceId, LastTurnChange } from './GitPane.tsx'
import { collectChangeFiles } from './ChangedFiles.tsx'
import SelectionAskPopover from './SelectionAskPopover.tsx'
import { useSideConversation } from './use-side-conversation.ts'
import type { SideChatMessage } from './SelectionChatPane.tsx'
import { buildSideChatPrompt } from './selection-quote.ts'
import AutomationsPage from './AutomationsPage.tsx'
/** antd is only needed by this page, so it loads as its own chunk on first visit. */
const WetrackPage = lazy(() => import('./WetrackPage.tsx'))
import { matchesShortcut, resolveShortcuts, shortcutKeyLabels } from './keyboard.ts'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider, useUiPreferences } from './ui-preferences.tsx'
import css from './App.module.css'

type ConnectionState = 'connecting' | 'disconnected' | 'recovered' | undefined
type MainPage = 'chat' | 'defects' | 'automations'
/** The task workbench's three seats: the live process, the file changes, and the settled summary. */
type TaskView = 'process' | 'changes' | 'summary'
interface ScopedDraft { scope: string; text: string }
/** One attachment as the limits see it: an image flag and its byte size. */
interface AttachmentSize { image: boolean; size: number }
type AttachmentLimit = 'images' | 'files' | 'empty' | 'imageBytes' | 'fileBytes' | 'total'
interface PendingSubmission extends PendingMessage { conversationId: string }
interface ToastMessage { id: number; text: string; success?: boolean }
/** The last failed submission attempt; a retry of the same content reuses its requestId. */
interface FailedSubmission { requestId: string; fingerprint: string }

const DRAFT_PREFIX = 'pi-durable-web:draft:'
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
/** Dropped files can arrive without a MIME type, so the extension stands in for it. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
}
/** Draft scopes without attachments share this, so the composer prop keeps a stable identity. */
const NO_IMAGES: readonly DraftImage[] = []
/** Scopes without plugin context share this, for the same reason. */
const NO_PLUGIN_CONTEXTS: readonly PluginContextEntry[] = []
const MAX_IMAGE_COUNT = 4
const MAX_FILE_COUNT = 8
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

const THINKING_ORDER: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Project the level the runtime will actually store: nearest supported level above, then below. */
export function clampThinkingLevel(level: ThinkingLevel, supported: readonly ThinkingLevel[] | undefined): ThinkingLevel {
  if (supported === undefined || supported.length === 0 || supported.includes(level)) return level
  const requested = THINKING_ORDER.indexOf(level)
  if (requested === -1) return supported[0]!
  for (let index = requested; index < THINKING_ORDER.length; index += 1) {
    if (supported.includes(THINKING_ORDER[index]!)) return THINKING_ORDER[index]!
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    if (supported.includes(THINKING_ORDER[index]!)) return THINKING_ORDER[index]!
  }
  return supported[0]!
}

/**
 * The first attachment limit the batch breaks, or null when every attachment fits.
 * Batches still being read are part of the batch, so two additions queued in one tick
 * cannot pass the same check against the same stale picture.
 * Exported so the limits stay verifiable without a browser.
 */
export function attachmentLimitError(committed: readonly DraftImage[], reading: readonly AttachmentSize[], selected: readonly AttachmentSize[]): AttachmentLimit | null {
  const all: AttachmentSize[] = [
    ...committed.map(image => ({ image: isImageType(image.mimeType), size: image.file.size })),
    ...reading,
    ...selected,
  ]
  const images = all.filter(item => item.image)
  const files = all.filter(item => !item.image)
  if (images.length > MAX_IMAGE_COUNT) return 'images'
  if (files.length > MAX_FILE_COUNT) return 'files'
  if (all.some(item => item.size === 0)) return 'empty'
  if (images.some(item => item.size > MAX_IMAGE_BYTES)) return 'imageBytes'
  if (files.some(item => item.size > MAX_FILE_BYTES)) return 'fileBytes'
  if (all.reduce((sum, item) => sum + item.size, 0) > MAX_ATTACHMENT_BYTES) return 'total'
  return null
}

/** The localized notice for one broken attachment limit. */
function attachmentLimitText(limit: AttachmentLimit, t: (chinese: string, english: string) => string): string {
  switch (limit) {
    case 'images': return t('一条消息最多添加 4 张图片', 'A message can include up to 4 images')
    case 'files': return t('一条消息最多添加 8 个文件', 'A message can include up to 8 files')
    case 'empty': return t('不能添加空文件', 'Empty files cannot be attached')
    case 'imageBytes': return t('每张图片不能超过 4 MiB', 'Each image must be 4 MiB or smaller')
    case 'fileBytes': return t('单个文件不能超过 8 MiB', 'Each file must be 8 MiB or smaller')
    case 'total': return t('一条消息的附件总大小不能超过 8 MiB', 'Attachments in one message cannot exceed 8 MiB total')
  }
}

/** Load shared UI preferences before rendering the complete application shell. */
export default function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_UI_SETTINGS)
  const [settingsError, setSettingsError] = useState('')
  const [settingsReady, setSettingsReady] = useState(false)
  useEffect(() => {
    let active = true
    api.getSettings().then(value => { if (active) { setSettings(value); setSettingsError('') } })
      .catch(cause => { if (active) setSettingsError(errorText(cause, settings.locale === 'zh' ? '无法读取界面设置' : 'Could not load settings')) })
      .finally(() => { if (active) setSettingsReady(true) })
    return () => { active = false }
  }, [])

  const updateSettings = useCallback(async (patch: UpdateAppSettingsInput): Promise<AppSettings> => {
    try {
      const value = await api.updateSettings(patch)
      setSettings(value)
      setSettingsError('')
      return value
    } catch (cause) {
      throw new ApiFailure(errorText(cause, settings.locale === 'zh' ? '无法保存界面设置' : 'Could not save settings'), cause instanceof ApiFailure ? cause.code : undefined)
    }
  }, [settings.locale])

  return <UiPreferencesProvider value={settings}>
    {settingsReady ? <AppShell settings={settings} settingsError={settingsError} onSettingsChange={updateSettings} />
      : <main className={css.appLoading} aria-label="Pi Durable"><span className={css.spinner} /></main>}
  </UiPreferencesProvider>
}

/** The single entry: task list sidebar, the task conversation surface, and Pi management entry pages. */
function AppShell({ settings, settingsError, onSettingsChange }: {
  settings: AppSettings
  settingsError: string
  onSettingsChange: (patch: UpdateAppSettingsInput) => Promise<AppSettings>
}) {
  const { t } = useUiPreferences()
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [appVersion, setAppVersion] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accessModes, setAccessModes] = useState<AccessMode[]>([])
  const [workspaceLoadError, setWorkspaceLoadError] = useState('')
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [listError, setListError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [listLoading, setListLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'models'>('general')
  const [savingProvider, setSavingProvider] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  /** The 「已完成」 section starts folded; the reader expands it on demand. */
  const [doneCollapsed, setDoneCollapsed] = useState(true)
  /** The open task's workbench seat; follows the run unless the reader picks one. */
  const [taskView, setTaskView] = useState<TaskView>('process')
  const [page, setPage] = useState<MainPage>('chat')
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false)
  /**
   * ZCode's side pane state: one tab array with a single active id, remembered per workspace in a
   * module memory bucket (no localStorage, like ZCode's taskSidePaneMemory). Document payloads ride
   * on the tab itself, so opening a second file no longer evicts the first.
   */
  const [pane, setPaneState] = useState<PaneState>(() => ({ tabs: [], activeTabId: null }))
  /** ZCode's full view: the pane overlays the whole main row until toggled back. */
  const [inspectorFullView, setInspectorFullView] = useState(false)
  /** The review pane's active source, kept across tab switches like ZCode's activeGitSourceId. */
  const [gitSource, setGitSource] = useState<GitChangeSourceId>('unstaged')
  /** Live message feeds for selection side chats, pumped by SideConversationPump mounts. */
  const [sideFeeds, setSideFeeds] = useState<Record<string, { messages: SideChatMessage[]; busy: boolean }>>({})
  /** A selection quote waiting to ride the side chat's first message. */
  const [sideQuotes, setSideQuotes] = useState<Record<string, string>>({})
  const [inspectorOpen, setInspectorOpen] = useState(false)
  /** The plan document the reader explicitly opened; falls back to the conversation's latest. */
  const [inspectorPlan, setInspectorPlan] = useState<PlanDocument | undefined>()
  const [inspectorWidth, setInspectorWidth] = useState(360)
  const [inspectorLoading, setInspectorLoading] = useState(false)
  const [inspectorError, setInspectorError] = useState('')
  /** Plugin pages the inspector keeps mounted, one per plugin call site. The tab itself lives in `pane`. */
  const [pluginPages, setPluginPages] = useState<PluginUiPage[]>([])
  /** Inline cards hand their page host to the inspector here, so the side pane moves the iframe. */
  const [pluginPageHosts, setPluginPageHosts] = useState<Record<string, HTMLElement>>({})
  /** `ui/update-model-context` chips, scoped like drafts so switching sessions keeps each one. */
  const [pluginContextsByScope, setPluginContextsByScope] = useState<Record<string, PluginContextEntry[]>>({})
  const [pluginSurfaces, setPluginSurfaces] = useState<PluginUiSurfaceView[]>([])
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [feedbackError, setFeedbackError] = useState('')
  const [connection, setConnection] = useState<ConnectionState>(undefined)
  const [reconnectToken, setReconnectToken] = useState(0)
  const [pending, setPending] = useState<PendingSubmission[]>([])
  const [draftState, setDraftState] = useState<ScopedDraft>({ scope: '__new__', text: loadDraft('__new__') })
  // Attachments live per scope, so switching tasks keeps what was already added.
  const [imageStore, setImageStore] = useState<Record<string, DraftImage[]>>({})
  const [newModel, setNewModel] = useState<{ provider: string; modelId: string } | undefined>(undefined)
  const [newThinking, setNewThinking] = useState<ThinkingLevel>(settings.defaultThinkingLevel)
  /** Plan mode requested before a conversation exists; applied when the session is created. */
  const [newPlan, setNewPlan] = useState(false)
  const [newWorkspaceId, setNewWorkspaceId] = useState<string | undefined>(settings.defaultWorkspaceId)
  const [newAccessMode, setNewAccessMode] = useState<AccessMode>(settings.defaultAccessMode)
  const [sendMode, setSendMode] = useState<BusySendMode>(settings.busySendMode)
  const [sending, setSending] = useState(false)
  /** ZCode shows the circular jump button as soon as the reader leaves the 48px bottom band. */
  const [jumpToBottomVisible, setJumpToBottomVisible] = useState(false)
  const [statusPanelVisible, setStatusPanelVisible] = useState(false)
  const [statusPanelOccupied, setStatusPanelOccupied] = useState(false)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const mainPanelRef = useRef<HTMLElement | null>(null)
  const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null)
  const messagesViewport = useRef<HTMLDivElement | null>(null)
  /** Hosts the transcript selection popover's anchor area. */
  const selectionHostRef = useRef<HTMLDivElement | null>(null)
  const inspectorRequestId = useRef(0)
  const inspectorResize = useRef<{ startX: number; startWidth: number } | null>(null)
  /** DSH's `markOpened` (`PlanCard.tsx:72-80`): the one conversation whose plan already opened by itself. */
  const planAutoOpenedFor = useRef<string | null>(null)
  const wasAtBottom = useRef(true)
  const submitLock = useRef(false)
  const detailRef = useRef<ConversationDetail | null>(null)
  /** The task the workbench seat belongs to; a different id means the reader switched tasks. */
  const taskViewTaskId = useRef<string | null>(null)
  /** Set once the reader picks a seat by hand, so a later completion does not yank them to the summary. */
  const taskViewManual = useRef(false)
  /** The previous status of the open task, to spot the non-completed → completed transition. */
  const taskViewPrevStatus = useRef<TaskStatus | undefined>(undefined)
  /** Mirrors the attachment store synchronously, so two batches queued in one tick both see the first. */
  const imageStoreRef = useRef<Record<string, DraftImage[]>>({})
  /** Set once the live event stream drops; the recovery hint must not follow an ordinary re-attach. */
  const connectionLost = useRef(false)
  /** The last submission attempt, so retrying identical content reuses the same requestId. */
  const lastFailedSubmit = useRef<FailedSubmission | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const translateRef = useRef(t)
  translateRef.current = t
  const toastSequence = useRef(0)
  /** Keeps the auto-follow ref and the jump-button visibility in one place. */
  const syncViewportScroll = useCallback((element: HTMLDivElement): void => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    wasAtBottom.current = distance < 88
    setJumpToBottomVisible(distance > 48)
  }, [])
  const jumpToBottom = useCallback((): void => {
    const viewport = messagesViewport.current
    if (viewport === null) return
    wasAtBottom.current = true
    setJumpToBottomVisible(false)
    viewport.scrollTop = viewport.scrollHeight
  }, [])
  const activeScope = selectedId === null ? '__new__' : selectedId
  const draft = draftState.scope === activeScope ? draftState.text : ''
  const images = imageStore[activeScope] ?? NO_IMAGES
  const pluginContexts = pluginContextsByScope[activeScope] ?? NO_PLUGIN_CONTEXTS
  /** The selected task row, when the open conversation is a task rather than a subagent or a legacy session. */
  const selectedTask = tasks.find(item => item.id === selectedId)
  const conversationReady = detail?.conversation.id === selectedId
  const activeConversation = conversationReady ? detail : null
  const requestedModel = activeConversation?.conversation.model ?? newModel ?? settings.defaultModel
  const requestedModelOption = requestedModel === undefined ? undefined
    : catalog?.models.find(model => model.provider === requestedModel.provider && model.modelId === requestedModel.modelId
      && (activeConversation !== null || model.available))
  // A new conversation must never display a stale default: the server catalog
  // already resolved it against the live directory, so use that when the
  // stored/default reference is missing or not selectable.
  const defaultModelOption = catalog?.defaultModel === undefined ? undefined
    : catalog.models.find(model => model.provider === catalog.defaultModel!.provider && model.modelId === catalog.defaultModel!.modelId)
  const fallbackModelOption = defaultModelOption?.available === true
    ? defaultModelOption
    : catalog?.models.find(model => model.available) ?? defaultModelOption
  const selectedModelOption = requestedModelOption ?? (activeConversation === null ? fallbackModelOption : undefined)
  const selectedModel = selectedModelOption === undefined
    ? requestedModel
    : { provider: selectedModelOption.provider, modelId: selectedModelOption.modelId }
  const thinkingLevel = clampThinkingLevel(activeConversation?.conversation.thinkingLevel ?? newThinking, selectedModelOption?.thinkingLevels)
  const inferredConversationWorkspace = activeConversation === null ? undefined
    : workspaces.find(workspace => workspace.path === activeConversation.conversation.cwd)?.id
  const currentWorkspaceId = activeConversation !== null
    ? activeConversation.conversation.workspaceId ?? inferredConversationWorkspace ?? settings.defaultWorkspaceId ?? workspaces[0]?.id
    : newWorkspaceId ?? settings.defaultWorkspaceId ?? workspaces[0]?.id
  const currentWorkspace = workspaces.find(workspace => workspace.id === currentWorkspaceId)
  /** The browse tab carries its own workspace and folder, so a restored bucket reopens in place. */
  const browseTab = pane.tabs.find(tab => tab.type === 'browse')
  const browseWorkspace = browseTab?.workspaceId === undefined ? undefined
    : workspaces.find(workspace => workspace.id === browseTab.workspaceId)
  const currentWorkspaceIdRef = useRef(currentWorkspaceId)
  currentWorkspaceIdRef.current = currentWorkspaceId
  const paneRef = useRef(pane)
  paneRef.current = pane
  /** Every pane mutation goes through here so the workspace memory bucket stays in sync. */
  const commitPane = useCallback((next: PaneState): void => {
    setPaneState(next)
    const workspaceId = currentWorkspaceIdRef.current
    if (workspaceId !== undefined) writePaneMemory(workspaceId, next)
  }, [])
  /** Open one tab (ZCode's open semantics: an active launcher tab is consumed in place). */
  const openPaneTab = useCallback((tab: InspectorTab): void => {
    commitPane(openFromLauncher(paneRef.current, tab))
    setInspectorOpen(true)
  }, [commitPane])
  /** Close tabs; an emptied pane collapses, like ZCode's commitSidePaneState. */
  const closePaneTabs = useCallback((ids: readonly string[]): void => {
    const { state } = closeTabs(paneRef.current, ids)
    commitPane(state)
    if (state.tabs.length === 0) {
      setInspectorOpen(false)
      setInspectorFullView(false)
    }
  }, [commitPane])
  const closeOtherPaneTabs = useCallback((id: string): void => {
    commitPane(closeOtherTabs(paneRef.current, id))
  }, [commitPane])
  const closeAllPaneTabs = useCallback((): void => {
    commitPane(closeAllTabs(paneRef.current))
    setInspectorOpen(false)
    setInspectorFullView(false)
  }, [commitPane])
  const selectPaneTab = useCallback((id: string): void => {
    commitPane(activateTab(paneRef.current, id))
  }, [commitPane])
  const accessMode = activeConversation?.conversation.accessMode ?? newAccessMode ?? settings.defaultAccessMode
  const selectedPending = pending.filter(item => item.conversationId === selectedId)

  const announce = useCallback((text: string, success = false): void => {
    toastSequence.current += 1
    setToast({ id: toastSequence.current, text, success })
  }, [])

  /** Insert or replace one task row in place, so a fresh detail never rebuilds the whole list. */
  const upsertTask = useCallback((summary: TaskSummary): void => {
    setTasks(existing => [summary, ...existing.filter(item => item.id !== summary.id)])
  }, [])

  const refreshTasks = useCallback(async (): Promise<void> => {
    try {
      const items = await api.listTasks()
      // An unchanged poll must not re-render the shell (and the transcript) every two seconds.
      setTasks(current => sameTaskRows(current, items) ? current : items)
      setListError('')
    } catch (cause) {
      setListError(errorText(cause, t('无法读取任务列表', 'Could not load tasks')))
    } finally {
      setListLoading(false)
    }
  }, [t])

  const refreshCatalog = useCallback(async (): Promise<void> => {
    try {
      const value = await api.getModels()
      setCatalog(value)
      setCatalogError('')
    } catch (cause) {
      setCatalogError(errorText(cause, t('无法读取模型列表', 'Could not load models')))
    }
  }, [t])

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    setWorkspaceLoading(true)
    try {
      const result = await api.listWorkspaces()
      setWorkspaces(result.workspaces)
      setWorkspaceLoadError('')
    } catch (cause) { setWorkspaceLoadError(errorText(cause, t('无法读取工作区', 'Could not load workspaces'))) }
    finally { setWorkspaceLoading(false) }
  }, [t])

  const refreshCapabilities = useCallback(async (): Promise<void> => {
    try {
      const result = await api.getCapabilities()
      setAccessModes(result.accessModes)
    } catch (cause) {
      setAccessModes([])
      announce(errorText(cause, t('无法读取访问模式', 'Could not load access modes')))
    }
  }, [announce, t])

  useEffect(() => {
    void refreshTasks()
    void refreshCatalog()
    void refreshWorkspaces()
    void refreshCapabilities()
    api.health().then(value => { setAppVersion(value.version); setAccountName(value.user) }).catch(() => undefined)
  }, [refreshCapabilities, refreshCatalog, refreshTasks, refreshWorkspaces])

  // Every task surface reads the same list, and a task's run can settle without this tab streaming
  // it, so the list polls. Rows are replaced by id, which keeps an unchanged row's DOM untouched.
  useEffect(() => {
    const timer = window.setInterval(() => { void refreshTasks() }, 2000)
    return () => { window.clearInterval(timer) }
  }, [refreshTasks])

  // DSH re-reads its model directory when the host reports a settings or
  // adapter change. The server pushes the same signal for saves made here,
  // another instance's writes, and hand-edited provider files.
  useEffect(() => {
    const source = api.watchModels(() => { void refreshCatalog() })
    return () => { source.close() }
  }, [refreshCatalog])

  useEffect(() => {
    const scope = selectedId ?? '__new__'
    wasAtBottom.current = true
    setJumpToBottomVisible(false)
    setStatusPanelVisible(false)
    setStatusPanelOccupied(false)
    detailRef.current = null
    setDraftState({ scope, text: loadDraft(scope) })
    setDetail(null)
    setDetailError('')
    setNewModel(undefined)
    const preferences = settingsRef.current
    setNewThinking(preferences.defaultThinkingLevel)
    setNewWorkspaceId(preferences.defaultWorkspaceId)
    setNewAccessMode(preferences.defaultAccessMode)
    if (selectedId === null) {
      setDetailLoading(false)
      return
    }
    let active = true
    setDetailLoading(true)
    api.getConversation(selectedId).then(value => {
      if (!active) return
      detailRef.current = value
      setDetail(value)
      setDetailError('')
    }).catch(cause => {
      if (active) setDetailError(errorText(cause, translateRef.current('无法打开此任务', 'Could not open this task')))
    }).finally(() => {
      if (active) setDetailLoading(false)
    })
    return () => { active = false }
  }, [selectedId])

  // The open task's stream is fresher than the list poll, so its row is projected in place. A
  // conversation the task list does not own (subagent, side chat) is never inserted here.
  useEffect(() => {
    if (detail === null || detail.conversation.id !== selectedId) return
    const summary = taskFromDetail(detail)
    if (summary === null) return
    setTasks(current => current.some(item => item.id === summary.id)
      ? current.map(item => item.id === summary.id ? summary : item)
      : current)
  }, [detail, selectedId])

  // The workbench seat follows the run: a freshly opened task lands on the seat its status asks for,
  // and a task that completes while the reader has not picked a seat slides to the summary on its own.
  // Switching tasks resets both the manual flag and the remembered status.
  useEffect(() => {
    const status = selectedTask?.status
    if (selectedId === null) {
      taskViewTaskId.current = null
      taskViewManual.current = false
      taskViewPrevStatus.current = undefined
      setTaskView('process')
      return
    }
    if (taskViewTaskId.current !== selectedId) {
      taskViewTaskId.current = selectedId
      taskViewManual.current = false
      taskViewPrevStatus.current = status
      setTaskView(status === 'completed' ? 'summary' : 'process')
      return
    }
    if (taskViewPrevStatus.current !== 'completed' && status === 'completed' && !taskViewManual.current) {
      setTaskView('summary')
    }
    taskViewPrevStatus.current = status
  }, [selectedId, selectedTask?.status])

  /** A seat the reader picks by hand; later completions must not override it. */
  const switchTaskView = useCallback((view: TaskView): void => {
    taskViewManual.current = true
    setTaskView(view)
  }, [])

  useEffect(() => {
    if (draftState.scope !== activeScope) return
    if (draftState.text === '') removeStorage(`${DRAFT_PREFIX}${activeScope}`)
    else writeStorage(`${DRAFT_PREFIX}${activeScope}`, draftState.text)
  }, [activeScope, draftState])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const onChange = (event: MediaQueryListEvent): void => { setMobile(event.matches) }
    setMobile(media.matches)
    media.addEventListener('change', onChange)
    return () => { media.removeEventListener('change', onChange) }
  }, [])

  useEffect(() => {
    if (!conversationReady || selectedId === null) return
    let live = true
    const source = api.watch(selectedId, value => {
      if (!live || value.conversation.id !== selectedId) return
      const viewport = messagesViewport.current
      const follow = wasAtBottom.current
      detailRef.current = value
      setDetail(value)
      setPending(existing => existing.filter(item => item.conversationId !== selectedId || !isAcknowledged(value, item)))
      if (follow && viewport !== null) requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight })
    }, state => {
      if (!live) return
      // `open` also fires on an ordinary attach (conversation switch, reconnect token bump), so only a stream
      // that actually dropped may report itself as recovered — otherwise every send flashes 连接已恢复.
      if (state === 'error') {
        connectionLost.current = true
        setConnection('disconnected')
        return
      }
      if (state === 'open') {
        setConnection(connectionLost.current ? 'recovered' : undefined)
        connectionLost.current = false
        return
      }
      setConnection(connectionLost.current ? 'connecting' : undefined)
    })
    return () => {
      live = false
      source.close()
      setConnection(undefined)
    }
  }, [conversationReady, reconnectToken, selectedId])

  useEffect(() => {
    if (connection !== 'recovered') return
    const timer = window.setTimeout(() => { setConnection(undefined) }, 2200)
    return () => { window.clearTimeout(timer) }
  }, [connection])

  useEffect(() => {
    const keep = new Set<string>()
    for (const items of Object.values(imageStore)) for (const image of items) keep.add(image.preview)
    for (const item of pending) for (const image of item.images) keep.add(image.preview)
    // Draft previews removed from the composer are released immediately — including attachments that were
    // still being read, which now live in the store like every other item — accepted previews stay alive until
    // SSE echoes them, and previews parked on another scope stay alive until it is opened again.
    for (const url of objectUrls.current) {
      if (!keep.has(url)) {
        URL.revokeObjectURL(url)
        objectUrls.current.delete(url)
      }
    }
  }, [imageStore, pending])

  useEffect(() => () => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
    objectUrls.current.clear()
  }, [])

  useEffect(() => {
    if (!mobile) setSidebarOpen(false)
  }, [mobile])

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current
    const main = mainPanelRef.current
    if (sidebar !== null) setElementInert(sidebar, mobile && !sidebarOpen)
    if (main !== null) setElementInert(main, mobile && sidebarOpen)
  }, [mobile, sidebarOpen])

  useEffect(() => {
    if (!mobile || !sidebarOpen) return
    const sidebar = sidebarRef.current
    if (sidebar === null) return
    const focusable = (): HTMLElement[] => Array.from(sidebar.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter(element => element.tabIndex >= 0)
    const firstFrame = requestAnimationFrame(() => {
      const first = focusable()[0]
      if (first !== undefined) focusWithoutRing(first)
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.querySelector('[role="menu"]') !== null) return
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        setSidebarOpen(false)
        requestAnimationFrame(() => {
          const trigger = sidebarTriggerRef.current
          if (trigger !== null) focusWithoutRing(trigger)
        })
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items.at(-1)
      if (first === undefined || last === undefined) {
        event.preventDefault()
        sidebar.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!sidebar.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(firstFrame)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [mobile, sidebarOpen])

  const selectConversation = useCallback((id: string): void => {
    setPage('chat')
    if (id === selectedId) {
      setSidebarOpen(false)
      return
    }
    setSelectedId(id)
    setSidebarOpen(false)
    if (mobile) requestAnimationFrame(() => {
      const viewport = messagesViewport.current
      if (viewport !== null) focusWithoutRing(viewport)
    })
  }, [mobile, selectedId])

  const setDraft = useCallback((value: string): void => {
    setDraftState({ scope: activeScope, text: value })
  }, [activeScope])

  /**
   * `ui/update-model-context` writes one chip for the active scope. The same plugin call
   * overwrites its previous entry, which is the documented "keep the last one" rule.
   */
  const addPluginContext = useCallback((entry: PluginContextEntry): void => {
    const scope = activeScope
    const key = `${entry.pluginId}:${entry.toolCallId ?? ''}`
    setPluginContextsByScope(current => {
      const entries = current[scope] ?? []
      const index = entries.findIndex(item => `${item.pluginId}:${item.toolCallId ?? ''}` === key)
      const next = index === -1
        ? [...entries, entry]
        : entries.map((item, position) => position === index ? entry : item)
      return { ...current, [scope]: next }
    })
  }, [activeScope])

  const removePluginContext = useCallback((key: string): void => {
    setPluginContextsByScope(current => {
      const entries = current[activeScope]
      if (entries === undefined) return current
      const next = entries.filter(entry => `${entry.pluginId}:${entry.toolCallId ?? ''}` !== key)
      if (next.length === entries.length) return current
      return { ...current, [activeScope]: next }
    })
  }, [activeScope])

  /** Write one scope's attachments and mirror them synchronously, so the next batch validates against them. */
  const writeImages = useCallback((scope: string, items: DraftImage[]): void => {
    imageStoreRef.current = { ...imageStoreRef.current, [scope]: items }
    setImageStore(imageStoreRef.current)
  }, [])

  /** Patch one attachment in place; a read that finishes after the item was removed is a no-op. */
  const patchImage = useCallback((scope: string, id: string, patch: (image: DraftImage) => DraftImage): void => {
    const current = imageStoreRef.current[scope]
    if (current === undefined || !current.some(image => image.id === id)) return
    writeImages(scope, current.map(image => image.id === id ? patch(image) : image))
  }, [writeImages])

  /** Read one accepted attachment and land the result on the entry that is already in the list. */
  const readAttachment = useCallback((scope: string, item: { id: string; file: File }): void => {
    void fileData(item.file, t).then(data => {
      patchImage(scope, item.id, image => ({ ...image, data, status: 'ready' }))
    }).catch(cause => {
      patchImage(scope, item.id, image => ({
        ...image, status: 'error',
        error: errorText(cause, t('无法读取附件', 'Could not read attachment')),
      }))
    })
  }, [patchImage, t])

  const addImages = useCallback((files: FileList | File[]): void => {
    const scope = activeScope
    const selected = Array.from(files).map(file => {
      const type = imageFileType(file)
      return { file, image: type !== '', mimeType: type === '' ? file.type || 'application/octet-stream' : type }
    })
    // Limits read the live store, which already holds earlier batches that are still being read, so a second
    // batch queued before the first one finished cannot pass the same check twice.
    const committed = imageStoreRef.current[scope] ?? []
    const limit = attachmentLimitError(committed, [], selected.map(item => ({ image: item.image, size: item.file.size })))
    if (limit !== null) {
      announce(attachmentLimitText(limit, t))
      return
    }
    // The batch joins the list before it is read: the composer shows it immediately, and a read that fails
    // only marks its own entry instead of dropping the whole batch.
    const batch: DraftImage[] = selected.map(item => ({
      id: crypto.randomUUID(), file: item.file, preview: URL.createObjectURL(item.file),
      mimeType: item.mimeType, data: '', status: 'reading',
    }))
    for (const item of batch) objectUrls.current.add(item.preview)
    writeImages(scope, [...committed, ...batch])
    for (const item of batch) readAttachment(scope, item)
  }, [activeScope, announce, readAttachment, t, writeImages])

  /** Re-read one failed attachment, wherever the scope that owns it has moved on to. */
  const retryImage = useCallback((id: string): void => {
    for (const [scope, items] of Object.entries(imageStoreRef.current)) {
      const item = items.find(image => image.id === id)
      if (item === undefined) continue
      patchImage(scope, id, image => ({ ...image, status: 'reading', error: undefined }))
      readAttachment(scope, item)
      return
    }
  }, [patchImage, readAttachment])

  const removeImage = useCallback((id: string): void => {
    const scope = activeScope
    const current = imageStoreRef.current[scope] ?? []
    const removed = current.find(image => image.id === id)
    if (removed !== undefined) {
      URL.revokeObjectURL(removed.preview)
      objectUrls.current.delete(removed.preview)
    }
    writeImages(scope, current.filter(image => image.id !== id))
  }, [activeScope, writeImages])

  const send = useCallback(async (requestedMode?: BusySendMode): Promise<void> => {
    const text = draftState.scope === activeScope ? draftState.text : ''
    const attachments = imageStoreRef.current[activeScope] ?? []
    if ((text.trim() === '' && attachments.length === 0) || submitLock.current) return
    if (attachments.some(image => image.status === 'reading')) {
      announce(t('附件正在读取中，请稍候再发送', 'Attachments are still being read. Try again in a moment'))
      return
    }
    if (attachments.some(image => image.status === 'error')) {
      announce(t('有附件读取失败，请重试或移除后再发送', 'An attachment failed to read. Retry or remove it before sending'))
      return
    }
    const ready = attachments.filter(image => image.status === 'ready')
    // `ui/update-model-context` entries ride along with the message, but the pending row,
    // the title and the retry fingerprint all keep reading the operator's own text.
    const contextBlock = pluginContextBlock(pluginContextsByScope[activeScope] ?? NO_PLUGIN_CONTEXTS)
    const submittedText = contextBlock === '' ? text : text === '' ? contextBlock : `${text}\n\n${contextBlock}`
    submitLock.current = true
    setSending(true)
    const targetId = selectedId
    const pendingId = `pending:${crypto.randomUUID()}`
    const firstPending: PendingSubmission = {
      id: pendingId,
      requestId: '',
      conversationId: targetId ?? '__creating__',
      text,
      images: ready.map(image => ({ name: image.file.name, preview: image.preview, mimeType: image.mimeType })),
      status: 'sending',
    }
    setPending(existing => [...existing, firstPending])
    setDraftState({ scope: activeScope, text: '' })
    writeImages(activeScope, [])
    const imageAttachments = ready.filter(item => isImageType(item.mimeType))
    const fileAttachments = ready.filter(item => !isImageType(item.mimeType))
    const attachmentInput = {
      ...(imageAttachments.length === 0 ? {} : { images: imageAttachments.map(image => ({ data: image.data, mimeType: image.mimeType })) }),
      ...(fileAttachments.length === 0 ? {} : { files: fileAttachments.map(file => ({ name: file.file.name, mimeType: file.mimeType, data: file.data })) }),
    }
    // Retrying the exact same failed submission reuses its requestId, so a message the server already
    // accepted is not sent twice when only the response was lost. Any change in content earns a fresh id.
    const fingerprint = submissionFingerprint(targetId ?? '__new__', text, ready)
    const remembered = lastFailedSubmit.current
    const requestId = remembered !== null && remembered.fingerprint === fingerprint ? remembered.requestId : crypto.randomUUID()
    lastFailedSubmit.current = { requestId, fingerprint }
    setPending(existing => existing.map(item => item.id === pendingId ? { ...item, requestId } : item))
    /** Shared tail: the server accepted the input, so the pending row settles and the scope's chips are consumed. */
    const finish = (conversationId: string, submissionId: string | undefined, created: ConversationDetail | undefined): void => {
      lastFailedSubmit.current = null
      setPluginContextsByScope(current => {
        if (current[activeScope] === undefined) return current
        const next = { ...current }
        delete next[activeScope]
        return next
      })
      const accepted: PendingSubmission = {
        ...firstPending,
        requestId,
        conversationId,
        ...(submissionId === undefined ? {} : { submissionId }),
        status: 'accepted',
      }
      const currentDetail = created ?? detailRef.current
      const alreadyVisible = currentDetail?.conversation.id === conversationId && isAcknowledged(currentDetail, accepted)
      setPending(existing => alreadyVisible
        ? existing.filter(item => item.id !== pendingId)
        : existing.map(item => item.id === pendingId ? accepted : item))
      if (created !== undefined) {
        // A created task starts on its own scope; plan mode is conversation-scoped, so it now applies.
        setNewPlan(false)
        detailRef.current = created
        setDetail(created)
        const summary = taskFromDetail(created)
        if (summary !== null) upsertTask(summary)
        setSelectedId(conversationId)
        setPage('chat')
        setSidebarOpen(false)
        setDraftState({ scope: conversationId, text: '' })
        writeImages(conversationId, [])
      }
      wasAtBottom.current = true
      setJumpToBottomVisible(false)
      requestAnimationFrame(() => {
        const viewport = messagesViewport.current
        if (viewport !== null) viewport.scrollTop = viewport.scrollHeight
      })
    }
    try {
      if (targetId === null) {
        const input: CreateTaskInput = {
          text: submittedText,
          requestId,
          whenBusy: 'reject',
          ...attachmentInput,
          ...(selectedModel === undefined ? {} : { model: selectedModel }),
          thinkingLevel,
          ...(currentWorkspaceId === undefined ? {} : { workspaceId: currentWorkspaceId }),
          accessMode,
        }
        let created = await api.createTask(input)
        if (newPlan) {
          created = await api.setPlan(created.conversation.id, true).catch(cause => {
            announce(errorText(cause, t('无法开启计划模式', 'Could not turn on plan mode')))
            return created
          })
        }
        finish(created.conversation.id, undefined, created)
      } else {
        const target = detailRef.current?.conversation.id === targetId ? detailRef.current : null
        const result = await api.submit(targetId, {
          text: submittedText,
          requestId,
          ...(target?.conversation.busy ? { whenBusy: requestedMode ?? sendMode } : {}),
          ...attachmentInput,
        })
        finish(targetId, result.submissionId, undefined)
      }
    } catch (cause) {
      setPending(existing => existing.filter(item => item.id !== pendingId))
      if (targetId !== null) {
        const scope = targetId
        setDraftState(current => ({ scope, text: current.scope === scope && current.text !== ''
          ? `${text}\n${current.text}` : text }))
        writeImages(scope, [...attachments, ...(imageStoreRef.current[scope] ?? [])])
      } else {
        setDraftState(current => ({ scope: activeScope, text: current.scope === activeScope && current.text !== ''
          ? `${text}\n${current.text}` : text }))
        writeImages(activeScope, [...attachments, ...(imageStoreRef.current[activeScope] ?? [])])
      }
      announce(errorText(cause, t('消息发送失败，输入内容已保留', 'Message failed to send. Your draft has been restored')))
    } finally {
      submitLock.current = false
      setSending(false)
    }
  }, [accessMode, activeScope, announce, currentWorkspaceId, draftState, newPlan, pluginContextsByScope, selectedId, selectedModel, sendMode, t, thinkingLevel, upsertTask, writeImages])

  /** `ui/message` from a plugin page submits straight to the open conversation, leaving the draft alone. */
  const sendPluginMessage = useCallback(async (text: string): Promise<void> => {
    if (selectedId === null) {
      announce(t('请先开始一个任务', 'Start a task first'))
      return
    }
    try {
      await api.submit(selectedId, { text, requestId: crypto.randomUUID() })
      wasAtBottom.current = true
      setJumpToBottomVisible(false)
      requestAnimationFrame(() => {
        const viewport = messagesViewport.current
        if (viewport !== null) viewport.scrollTop = viewport.scrollHeight
      })
    } catch (cause) {
      announce(errorText(cause, t('消息发送失败', 'Message failed to send')))
    }
  }, [announce, selectedId, t])

  /** `ui/open-link` may only reach an https destination, even when a caller skips the bridge check. */
  const openPluginLink = useCallback((url: string): void => {
    try {
      if (new URL(url).protocol !== 'https:') return
    } catch {
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.stop(selectedId)
      announce(t('已停止运行。排队消息已保留，发送下一条消息即可继续处理', 'Stopped. Queued messages are preserved; send another message to continue them'), true)
    } catch (cause) { announce(errorText(cause, t('停止失败', 'Could not stop'))) }
  }, [announce, selectedId, t])

  const updateGoal = useCallback(async (action: 'pause' | 'resume' | 'edit' | 'clear', payload?: { objective?: string }): Promise<void> => {
    if (selectedId === null) return
    try {
      const next = await api.updateGoal(selectedId, { action, ...(payload?.objective === undefined ? {} : { objective: payload.objective }) })
      setDetail(next)
      announce(t('目标已更新', 'Goal updated'), true)
    } catch (cause) { announce(errorText(cause, t('无法更新目标', 'Could not update the goal'))) }
  }, [announce, selectedId, t])

  const compact = useCallback(async (): Promise<void> => {
    if (selectedId === null) return
    if (detailRef.current?.compaction?.running === true) return
    try {
      await api.compact(selectedId)
    } catch (cause) { announce(errorText(cause, t('无法压缩上下文', 'Could not compact the context'))) }
  }, [announce, selectedId, t])

  const setPlan = useCallback(async (active: boolean): Promise<void> => {
    if (selectedId === null || !conversationReady) {
      setNewPlan(active)
      announce(active
        ? t('新任务将以计划模式开始：先出计划，批准后再执行', 'The new task will start in plan mode')
        : t('已取消计划模式', 'Plan mode cancelled'), true)
      return
    }
    try {
      const value = await api.setPlan(selectedId, active)
      detailRef.current = value
      setDetail(value)
      announce(active
        ? t('已进入计划模式：先出计划，批准后再执行', 'Plan mode on: plan first, execute after approval')
        : t('已退出计划模式', 'Plan mode off'), true)
    } catch (cause) { announce(errorText(cause, t('无法切换计划模式', 'Could not switch plan mode'))) }
  }, [announce, conversationReady, selectedId, t])

  /** Hand focus back to the composer, which is what dismissing the plan review does. */
  const focusComposer = useCallback((): void => {
    document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()
  }, [])

  const removeQueue = useCallback(async (submissionId: string): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.removeQueued(selectedId, submissionId)
      setPending(existing => existing.filter(item => item.submissionId !== submissionId))
    } catch (cause) { announce(errorText(cause, t('无法撤回这条排队消息', 'Could not withdraw this queued message'))) }
  }, [announce, selectedId, t])

  /**
   * Remember the model/level the operator last chose so the next new task (or
   * a newly opened browser window) starts there. The default model is also the
   * settings fallback, so this is the same global value.
   */
  const rememberModelSelection = useCallback((level: ThinkingLevel, model?: { provider: string; modelId: string }): void => {
    const patch: UpdateAppSettingsInput = {
      defaultThinkingLevel: level,
      ...(model === undefined ? {} : { defaultModel: { ...model } }),
    }
    void onSettingsChange(patch).catch(cause => {
      announce(errorText(cause, t('无法记住模型选择', 'Could not remember the model selection')))
    })
  }, [announce, onSettingsChange, t])

  const chooseModel = useCallback(async (model: ModelOption): Promise<void> => {
    const selection = { provider: model.provider, modelId: model.modelId }
    const requested = model.reasoning ? activeConversation?.conversation.thinkingLevel ?? newThinking : 'off'
    // Switching to a model that does not offer the current level stores the
    // nearest one it does offer, the same value the runtime would clamp to.
    const level = clampThinkingLevel(requested, model.thinkingLevels)
    if (selectedId === null || !conversationReady) {
      setNewModel(selection)
      setNewThinking(level)
      rememberModelSelection(level, selection)
      return
    }
    try {
      const value = await api.updateConversation(selectedId, { model: selection, thinkingLevel: level })
      setDetail(value)
      detailRef.current = value
      rememberModelSelection(level, selection)
    } catch (cause) { announce(errorText(cause, t('切换模型失败', 'Could not change model'))) }
  }, [activeConversation, announce, conversationReady, newThinking, rememberModelSelection, selectedId, t])

  const chooseThinking = useCallback(async (level: ThinkingLevel): Promise<void> => {
    if (selectedId === null || !conversationReady) {
      setNewThinking(level)
      rememberModelSelection(level, selectedModel)
      return
    }
    try {
      const value = await api.updateConversation(selectedId, { thinkingLevel: level })
      setDetail(value)
      detailRef.current = value
      rememberModelSelection(level, selectedModel)
    } catch (cause) { announce(errorText(cause, t('更改思考等级失败', 'Could not change reasoning level'))) }
  }, [announce, conversationReady, rememberModelSelection, selectedId, selectedModel, t])

  const forkFrom = useCallback(async (entryId: string): Promise<void> => {
    if (selectedId === null) return
    try {
      const forked = await api.fork(selectedId, entryId)
      setDetail(forked)
      detailRef.current = forked
      setSelectedId(forked.conversation.id)
      announce(t('已从这条消息创建分支', 'Forked from this message'), true)
    } catch (cause) { announce(errorText(cause, t('创建分支失败', 'Could not fork the conversation'))) }
  }, [announce, selectedId, t])

  const saveProvider = useCallback(async (input: ProviderInput): Promise<void> => {
    setSavingProvider(true)
    try {
      await api.saveProvider(input)
      await refreshCatalog()
      announce(t('服务商配置已保存', 'Provider saved'), true)
    } catch (cause) {
      throw new ApiFailure(errorText(cause, t('服务商保存失败', 'Could not save provider')), cause instanceof ApiFailure ? cause.code : undefined)
    } finally { setSavingProvider(false) }
  }, [announce, refreshCatalog, t])

  const selectWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (conversationReady && selectedId !== null) {
      try {
        const value = await api.updateConversation(selectedId, { workspaceId })
        setDetail(value)
        detailRef.current = value
        announce(t('工作区已更新', 'Workspace updated'), true)
      } catch (cause) { announce(errorText(cause, t('无法切换工作区', 'Could not change the workspace'))) }
      return
    }
    setNewWorkspaceId(workspaceId)
    try { await onSettingsChange({ defaultWorkspaceId: workspaceId }) }
    catch (cause) { announce(errorText(cause, t('无法保存默认工作区', 'Could not save the default workspace'))) }
  }, [announce, conversationReady, onSettingsChange, selectedId, t])

  const selectAccessMode = useCallback(async (mode: AccessMode): Promise<void> => {
    if (conversationReady && selectedId !== null) {
      try {
        const value = await api.updateConversation(selectedId, { accessMode: mode })
        setDetail(value)
        detailRef.current = value
      } catch (cause) { announce(errorText(cause, t('无法更改访问级别', 'Could not change access mode'))) }
      return
    }
    setNewAccessMode(mode)
    try { await onSettingsChange({ defaultAccessMode: mode }) }
    catch (cause) { announce(errorText(cause, t('无法保存默认访问级别', 'Could not save the default access mode'))) }
  }, [announce, conversationReady, onSettingsChange, selectedId, t])

  const addWorkspace = useCallback(async (input: { path: string; name?: string }): Promise<WorkspaceSummary> => {
    const result = await api.createWorkspace(input)
    setWorkspaces(current => [result.workspace, ...current.filter(workspace => workspace.id !== result.workspace.id)])
    setWorkspaceLoadError('')
    announce(t('工作区已添加', 'Workspace added'), true)
    return result.workspace
  }, [announce, t])

  const navigate = useCallback((next: MainPage): void => {
    setPage(next)
    setSidebarOpen(false)
    if (mobile) requestAnimationFrame(() => { if (mainPanelRef.current !== null) focusWithoutRing(mainPanelRef.current) })
  }, [mobile])

  /** Open a conversation the task list does not own (automation run, defect analysis, subagent). */
  const openConversation = useCallback((id: string): void => {
    setPage('chat')
    setSidebarOpen(false)
    setSelectedId(id)
  }, [])

  const openWorkspaceBrowser = useCallback((workspaceId: string, path = ''): void => {
    inspectorRequestId.current += 1
    const workspace = workspaces.find(item => item.id === workspaceId)
    openPaneTab({ id: 'browse', type: 'browse', title: workspace?.name ?? t('文件', 'Files'), openedAt: Date.now(), workspaceId, path })
    setInspectorError('')
    setInspectorLoading(false)
    setSidebarOpen(false)
  }, [openPaneTab, workspaces, t])

  const openWorkspaceFile = useCallback(async (path: string, workspaceId = currentWorkspaceId, line?: number): Promise<void> => {
    if (workspaceId === undefined) {
      announce(t('请先选择工作区', 'Choose a workspace first'))
      return
    }
    inspectorRequestId.current += 1
    const requestId = inspectorRequestId.current
    setInspectorOpen(true)
    setInspectorError('')
    setInspectorLoading(true)
    try {
      const file = await api.getWorkspaceFile(workspaceId, path)
      if (file.kind === 'directory') {
        // 回答里的路径有时指向一个目录：直接在文件浏览器里列出它。
        if (requestId === inspectorRequestId.current) openWorkspaceBrowser(workspaceId, file.path)
        return
      }
      const assetUrl = file.kind !== 'text'
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/asset?${new URLSearchParams({ path: file.path }).toString()}`
        : undefined
      if (requestId === inspectorRequestId.current) {
        const payload: InspectorFile = { path: file.path, content: file.content ?? '', mimeType: file.mimeType, size: file.size, workspaceId, ...(line === undefined ? {} : { line }), ...(assetUrl === undefined ? {} : { url: assetUrl }) }
        openPaneTab({
          id: `doc:file:${workspaceId}:${file.path}`,
          type: 'document',
          title: file.path.split(/[\\/]/u).pop() ?? file.path,
          openedAt: Date.now(),
          doc: { kind: 'file', file: payload },
        })
      }
    } catch (cause) {
      if (requestId === inspectorRequestId.current) setInspectorError(errorText(cause, t('无法打开此文件', 'Could not open this file')))
    } finally { if (requestId === inspectorRequestId.current) setInspectorLoading(false) }
  }, [announce, currentWorkspaceId, openPaneTab, openWorkspaceBrowser, t])

  /** One diff document per workspace+path; repeated opens focus and refresh the same tab. */
  const inspectDiff = useCallback((diff: InspectorDiff): void => {
    inspectorRequestId.current += 1
    const workspaceId = currentWorkspaceIdRef.current
    openPaneTab({
      id: `doc:diff:${workspaceId ?? 'new'}:${diff.path}`,
      type: 'document',
      title: diff.path.split(/[\\/]/u).pop() ?? diff.path,
      openedAt: Date.now(),
      doc: { kind: 'diff', diff },
    })
    setInspectorError('')
    setInspectorLoading(false)
  }, [openPaneTab])

  const searchWorkspaceFiles = useCallback(async (needle: string): Promise<WorkspaceFileEntry[]> => {    const workspaceId = currentWorkspaceId
    if (workspaceId === undefined) return []
    const result = await api.searchWorkspaceFiles(workspaceId, needle)
    return result.entries
  }, [currentWorkspaceId])

  /** `$` uses the same workspace catalog as Settings → Skills, so plugin skills are included. */
  const searchSkills = useCallback(async (query: string) => {
    const workspaceId = currentWorkspaceId
    if (workspaceId === undefined) return []
    const catalog = await api.getSkills(workspaceId)
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return catalog.skills
    return catalog.skills.filter(skill =>
      `${skill.name} ${skill.description} ${skill.id}`.toLocaleLowerCase().includes(needle))
  }, [currentWorkspaceId])

  const submitFeedback = useCallback(async (entryId: string, rating: 'up' | 'down' | null): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.saveFeedback(selectedId, { entryId, rating })
      const current = detailRef.current
      if (current?.conversation.id === selectedId) {
        const updated = { ...current, messages: current.messages.map(message => message.entryId === entryId ? { ...message, feedback: rating } : message) }
        detailRef.current = updated
        setDetail(updated)
      }
    } catch (cause) { announce(errorText(cause, t('无法保存反馈', 'Could not save feedback'))) }
  }, [announce, selectedId, t])

  /** CP-5: free-form product feedback from the account menu, sent to the standalone feedback endpoint. */
  const sendUserFeedback = useCallback(async (): Promise<void> => {
    const text = feedbackText.trim()
    if (text === '' || text.length > 2000 || feedbackSending) return
    setFeedbackSending(true)
    setFeedbackError('')
    try {
      await api.sendFeedback({ text })
      setFeedbackOpen(false)
      setFeedbackText('')
      announce(t('已收到反馈，谢谢', 'Thanks for your feedback'), true)
    } catch (cause) {
      setFeedbackError(errorText(cause, t('反馈发送失败', 'Could not send feedback')))
    } finally { setFeedbackSending(false) }
  }, [announce, feedbackSending, feedbackText, t])

  const retryEntry = useCallback(async (entryId: string): Promise<void> => {
    if (selectedId === null) return
    try {
      const result = await api.retry(selectedId, { entryId, requestId: crypto.randomUUID() })
      openConversation(result.conversationId)
    } catch (cause) { announce(errorText(cause, t('重新运行失败', 'Could not retry this response'))) }
  }, [announce, openConversation, selectedId, t])

  const updateQueue = useCallback(async (submissionId: string, input: Parameters<typeof api.updateQueued>[2]): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.updateQueued(selectedId, submissionId, input)
      announce(t('排队消息已更新', 'Queued message updated'), true)
    } catch (cause) { throw new ApiFailure(errorText(cause, t('无法更新排队消息', 'Could not update queued message')), cause instanceof ApiFailure ? cause.code : undefined) }
  }, [announce, selectedId, t])

  /** DSH's session-log export: one JSON object per line, taken from the durable conversation. */
  const downloadSessionLog = useCallback(async (): Promise<void> => {
    const id = selectedId
    if (id === null) return
    try {
      const detail = detailRef.current?.conversation.id === id ? detailRef.current : await api.getConversation(id)
      const header = { kind: 'session', ...detail.conversation, exportedAt: new Date().toISOString() }
      const body = [header, ...detail.messages].map(entry => JSON.stringify(entry)).join('\n')
      const blob = new Blob([`${body}\n`], { type: 'application/x-ndjson' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${detail.conversation.title.replace(/[\\/:*?"<>|]+/gu, '-').trim() || 'session'}.jsonl`
      // The anchor has to be in the document for the browser to start the download.
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 30_000)
      announce(t('Session 日志已下载', 'Session log downloaded'), true)
    } catch (cause) { announce(errorText(cause, t('无法下载 Session 日志', 'Could not download the session log'))) }
  }, [announce, selectedId, t])

  const addWorkspaceFromPicker = useCallback(async (): Promise<void> => {
    try {
      const picked = await api.pickWorkspaceDirectory()
      if (picked === null) return
      const name = picked.replace(/\/+$/u, '').split('/').pop() ?? picked
      const added = await addWorkspace({ path: picked, name })
      await refreshWorkspaces()
      announce(t(`已添加工作区 ${added.name}`, `Added workspace ${added.name}`), true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ''
      // No native panel on this host (Windows today): DSH gives such hosts the
      // in-app browser, so open that instead of a typed path.
      if (message.includes('原生目录选择器')) { setDirectoryBrowserOpen(true); return }
      announce(errorText(cause, t('无法添加工作区', 'Could not add the workspace')))
    }
  }, [addWorkspace, announce, refreshWorkspaces, t])

  const busy = activeConversation?.conversation.busy === true
  const activeDetail = activeConversation
  /** The entry page owns the empty selection; a selected task renders its conversation, loading or not. */
  const hero = page === 'chat' && selectedId === null
  const showConversationHeader = page === 'chat' && selectedId !== null
  /** The task list reads newest activity first; stable for equal timestamps. */
  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt), [tasks])
  /** The sidebar's three seats, each still newest-first: what needs the reader, what is live, what settled. */
  const attentionTasks = useMemo(() => sortedTasks.filter(task => task.status === 'waiting' || task.status === 'failed' || task.status === 'cancelled'), [sortedTasks])
  const activeTasks = useMemo(() => sortedTasks.filter(task => task.status === 'running' || task.status === 'queued'), [sortedTasks])
  const doneTasks = useMemo(() => sortedTasks.filter(task => task.status === 'completed' || task.status === 'idle'), [sortedTasks])
  /** The row's state label: running and waiting are the two states that need the reader. */
  const selectedTaskStatus = selectedTask?.status ?? (busy ? 'running' : undefined)
  // Every pane open path ensures a tab exists, so the open flag alone decides visibility.
  const showInspector = inspectorOpen
  /** The latest submitted plan of the open conversation, shared by the inspector view and the auto open. */
  const conversationPlan = useMemo(() => activeDetail === null
    ? undefined
    : latestPlan(activeDetail.interactions, activeDetail.messages), [activeDetail])
  /** Every plan in the transcript, newest first: the status card's plan directory. */
  const conversationPlans = useMemo(() => activeDetail === null
    ? []
    : sessionPlans(activeDetail.interactions, activeDetail.messages), [activeDetail])
  /**
   * The review pane's 上一轮更改 dataset: the last run's file artifacts, merged per path the same
   * way the transcript's changed-files card merges them. ZCode builds this client-side too.
   */
  const lastTurnChanges = useMemo<LastTurnChange[]>(() => {
    const messages = activeDetail?.messages ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const artifacts = messages[index]?.artifacts
      if (artifacts === undefined || artifacts.length === 0) continue
      return collectChangeFiles(artifacts).map(file => ({
        path: file.path,
        added: file.added,
        removed: file.deleted,
        ...(file.before === undefined ? {} : { before: file.before }),
        ...(file.after === undefined ? {} : { after: file.after }),
        kind: file.before === undefined ? 'added' as const : file.after === undefined ? 'deleted' as const : 'modified' as const,
      }))
    }
    return []
  }, [activeDetail])

  /** Distinct changed paths for the 变更 tab badge and the summary stat; cheap, no line diffing. */
  const taskChangeCount = useMemo(() => activeDetail === null ? 0 : countTaskChanges(activeDetail.messages), [activeDetail])
  /** The workbench head and seats belong to tasks; a subagent or legacy session keeps the plain process. */
  const taskHeadVisible = activeDetail !== null && selectedTask !== undefined
  /** The head's current-action line: the live verb, the pending question, the failure, or the state word. */
  const taskHeadAction = ((): string => {
    if (selectedTaskStatus === undefined) return ''
    if (selectedTaskStatus === 'running') return t('执行中', 'Executing')
    if (selectedTaskStatus === 'waiting') return selectedTask?.attention ?? taskStatusLabel(selectedTaskStatus, t)
    if (selectedTaskStatus === 'failed') return activeDetail?.error ?? taskStatusLabel(selectedTaskStatus, t)
    return taskStatusLabel(selectedTaskStatus, t)
  })()
  /** Workspace asset URL for images quoted in the summary answer, same seat the transcript uses. */
  const resolveWorkspaceImage = useCallback((path: string): string | undefined =>
    currentWorkspaceId === undefined ? undefined
      : `/api/workspaces/${encodeURIComponent(currentWorkspaceId)}/asset?${new URLSearchParams({ path }).toString()}`,
  [currentWorkspaceId])

  const startNewTask = useCallback((): void => {
    setPage('chat')
    setSelectedId(null)
    setDetail(null)
    detailRef.current = null
    setNewModel(undefined)
    setNewThinking(settings.defaultThinkingLevel)
    setNewWorkspaceId(settings.defaultWorkspaceId)
    setNewAccessMode(settings.defaultAccessMode)
    // ZCode's draft scope: conversation-owned tabs go, workspace documents stay in the bucket,
    // and the empty draft starts with the pane collapsed.
    const scoped = stripConversationScoped(paneRef.current)
    commitPane(scoped)
    setInspectorPlan(undefined)
    setPluginPages([])
    setPluginPageHosts({})
    setPluginSurfaces([])
    setSideFeeds({})
    setSideQuotes({})
    setInspectorOpen(false)
    setInspectorFullView(false)
    inspectorRequestId.current += 1
    setSidebarOpen(false)
    requestAnimationFrame(() => requestAnimationFrame(focusComposer))
  }, [commitPane, focusComposer, settings.defaultAccessMode, settings.defaultThinkingLevel, settings.defaultWorkspaceId])

  /** The plugin creator is a new task with the bundled Skill already in the draft. */
  const startPluginCreation = useCallback((): void => {
    const text = '$plugin-creator '
    writeStorage(`${DRAFT_PREFIX}__new__`, text)
    startNewTask()
    setSettingsOpen(false)
    setDraftState({ scope: '__new__', text })
    requestAnimationFrame(() => requestAnimationFrame(focusComposer))
  }, [focusComposer, startNewTask])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
      if (document.querySelector('[role="menu"], [role="dialog"]') !== null) return
      const shortcuts = resolveShortcuts(settings.shortcuts)
      if (matchesShortcut(event, shortcuts.newConversation)) {
        event.preventDefault()
        startNewTask()
      } else if (matchesShortcut(event, shortcuts.settings)) {
        event.preventDefault()
        setSettingsInitialTab('general')
        setSettingsOpen(true)
      } else if (matchesShortcut(event, shortcuts.toggleSidebar)) {
        event.preventDefault()
        if (mobile) setSidebarOpen(value => !value)
        else setSidebarCollapsed(value => !value)
      }
    }
    document.addEventListener('keydown', onShortcut, true)
    return () => { document.removeEventListener('keydown', onShortcut, true) }
  }, [mobile, settings.shortcuts, startNewTask])

  /**
   * ZCode parity: closing the pane only collapses it. The tab bucket keeps its tabs, so reopening
   * lands where the reader left off; conversation-scoped cleanup happens on session switch instead.
   */
  const closeInspector = (): void => {
    inspectorRequestId.current += 1
    setInspectorOpen(false)
    setInspectorFullView(false)
    setInspectorError('')
    setInspectorLoading(false)
  }

  /** Close one plugin tab: drop the page and its inline-card host, then let the model pick the fallback. */
  const closePluginPage = useCallback((id: string): void => {
    setPluginPages(current => current.filter(page => page.id !== id))
    // The tab no longer owns the host; its inline card appends it back on the next render.
    setPluginPageHosts(current => {
      if (current[id] === undefined) return current
      const hosts = { ...current }
      delete hosts[id]
      return hosts
    })
    closePaneTabs([id])
  }, [closePaneTabs])
  /**
   * Open or focus one plugin page tab; the id keeps one page per plugin call site. An inline card
   * passes its host, so the inspector moves the mounted page instead of opening a second iframe.
   */
  const openPluginPage = useCallback((input: PluginUiPage | Omit<PluginUiPage, 'id'>, host?: HTMLElement): void => {
    // A card names its own page; the `+` menu has no page yet, so its id comes from the conversation.
    const id = 'id' in input ? input.id : `${selectedId ?? 'new'}:${input.pluginId}:${input.toolCallId ?? input.resourceUri}`
    const stored: PluginUiPage = { ...input, id, ...(selectedId === null ? {} : { conversationId: selectedId }) }
    setPluginPages(current => current.some(item => item.id === id)
      ? current.map(item => item.id === id ? stored : item)
      : [...current, stored])
    if (host !== undefined) {
      setPluginPageHosts(current => current[id] === host ? current : { ...current, [id]: host })
    }
    openPaneTab({ id, type: 'plugin', pageId: id, title: input.title ?? input.pluginId, openedAt: Date.now() })
  }, [openPaneTab, selectedId])

  /**
   * Open or focus one child conversation as a read-only tab in the inspector. The child never
   * replaces the parent in the primary column: its transcript streams beside it, the same way
   * a file or plugin document does. The title comes from the parent's projected child list, so a
   * chip or panel row that only knows the id still lands on the delegation label.
   */
  const openSubagentTab = useCallback((childId: string, title?: string): void => {
    const row = activeDetail?.subagents?.find(item => item.id === childId)
    const label = row?.label !== undefined && row.label !== ''
      ? row.label
      : row?.title !== undefined && row.title !== ''
        ? row.title
        : title !== undefined && title.trim() !== ''
          ? title.trim()
          : t('子智能体', 'Subagent')
    openPaneTab({ id: childId, type: 'subagent', childId, title: label, openedAt: Date.now() })
    setSidebarOpen(false)
  }, [activeDetail, openPaneTab, t])

  /**
   * The status card's 「已结束的智能体」 footer opens ZCode's directory page: every child of the
   * parent in one tab, each row opening the read-only session beside it.
   */
  const openSubagentDirectory = useCallback((): void => {
    openPaneTab({ id: 'subagents', type: 'subagents', title: t('子智能体目录', 'Subagents'), openedAt: Date.now() })
    setSidebarOpen(false)
  }, [openPaneTab, t])

  /** Page ids whose host the inspector owns; an inline card shows a placeholder for those. */
  const sidePageIds = useMemo(() => new Set(Object.keys(pluginPageHosts)), [pluginPageHosts])
  const pluginPageHolding = useRef<HTMLDivElement>(null)
  const holdPluginPageHost = useCallback((host: HTMLElement): void => {
    pluginPageHolding.current?.appendChild(host)
  }, [])
  const pluginPagePool = useMemo(() => ({ sidePageIds, openSide: openPluginPage, hold: holdPluginPageHost }), [holdPluginPageHost, openPluginPage, sidePageIds])

  /** The `+` menu reads the surfaces the server enables for this workspace and conversation. */
  const refreshPluginSurfaces = useCallback(async (): Promise<void> => {
    try {
      const surfaces = await api.pluginUiSurfaces(currentWorkspaceId, selectedId ?? undefined)
      setPluginSurfaces(surfaces)
    } catch (cause) {
      setPluginSurfaces([])
      announce(errorText(cause, t('无法读取插件页面', 'Could not load plugin pages')))
    }
  }, [announce, currentWorkspaceId, selectedId, t])

  const openPluginSurface = useCallback((surface: PluginUiSurfaceView): void => {
    openPluginPage({
      pluginId: surface.pluginId,
      serverName: surface.serverName,
      resourceUri: surface.resourceUri,
      title: surface.title,
    })
  }, [openPluginPage])

  const toggleInspector = (): void => {
    if (showInspector) {
      closeInspector()
      return
    }
    setInspectorOpen(true)
    // ZCode's collapsed expansion: a pane with no tabs lands on the launcher page.
    if (paneRef.current.tabs.length === 0) {
      openPaneTab({ id: 'new-tab', type: 'new-tab', title: t('新标签页', 'New tab'), openedAt: Date.now() })
    }
  }

  // —— ZCode launcher entries: review, browser, trajectory, new-tab, selection side chat. ——
  const openReviewPane = useCallback((): void => {
    openPaneTab({ id: 'git', type: 'git', title: t('审查', 'Review'), openedAt: Date.now() })
  }, [openPaneTab, t])
  const openBrowserPane = useCallback((): void => {
    openPaneTab({ id: `browser:${crypto.randomUUID()}`, type: 'browser', title: t('浏览器', 'Browser'), openedAt: Date.now(), url: '' })
  }, [openPaneTab, t])
  const openTrajectoryPane = useCallback((): void => {
    if (selectedId === null) {
      announce(t('先打开一个任务再查看模型轨迹', 'Open a task to view its model trajectory'))
      return
    }
    const title = selectedTask?.title !== undefined && selectedTask.title !== ''
      ? selectedTask.title
      : t('模型调用轨迹', 'Model trajectory')
    openPaneTab({ id: `trajectory:${selectedId}`, type: 'trajectory', conversationId: selectedId, title, openedAt: Date.now() })
  }, [announce, openPaneTab, selectedId, selectedTask, t])
  const openNewTabPane = useCallback((): void => {
    openPaneTab({ id: 'new-tab', type: 'new-tab', title: t('新标签页', 'New tab'), openedAt: Date.now() })
  }, [openPaneTab, t])
  const patchBrowserTab = useCallback((tabId: string, patch: { url?: string; addressDraft?: string; title?: string }): void => {
    const current = paneRef.current
    const tabs = current.tabs.map(tab => tab.id === tabId
      ? { ...tab, ...(patch.url === undefined ? {} : { url: patch.url }), ...(patch.addressDraft === undefined ? {} : { addressDraft: patch.addressDraft }), ...(patch.title === undefined ? {} : { title: patch.title }) }
      : tab)
    commitPane(normalizePaneState({ tabs, activeTabId: current.activeTabId }) ?? { tabs, activeTabId: current.activeTabId })
  }, [commitPane])
  const toggleInspectorFullView = useCallback((): void => {
    if (!showInspector) {
      // ZCode enters the full view by expanding the pane first when it was closed.
      toggleInspector()
      setInspectorFullView(true)
      return
    }
    setInspectorFullView(value => !value)
  }, [showInspector, toggleInspector])

  /** Create (or reuse) a side chat conversation for a transcript selection and open its tab. */
  const sideChatOpening = useRef(false)
  const openSelectionChat = useCallback(async (quote?: string): Promise<void> => {
    const workspaceId = currentWorkspaceIdRef.current
    if (workspaceId === undefined) {
      announce(t('请先选择工作区', 'Choose a workspace first'))
      return
    }
    if (sideChatOpening.current) return
    sideChatOpening.current = true
    try {
      const ordinal = nextSelectionChatOrdinal(paneRef.current)
      const title = t(`辅助对话 ${ordinal}`, `Side conversation ${ordinal}`)
      const created = await api.createConversation({ workspaceId, title, model: selectedModel, thinkingLevel })
      const childId = created.conversation.id
      if (quote !== undefined && quote.trim() !== '') setSideQuotes(current => ({ ...current, [childId]: quote.trim() }))
      openPaneTab({ id: `selection-chat:${childId}`, type: 'selection-chat', conversationId: childId, ordinal, title, openedAt: Date.now() })
    } catch (cause) {
      announce(errorText(cause, t('无法创建辅助对话', 'Could not create the side conversation')))
    } finally {
      sideChatOpening.current = false
    }
  }, [announce, openPaneTab, selectedModel, thinkingLevel, t])
  /** The side chat's first send folds the pending quote into the prompt, ZCode reference semantics. */
  const sendSideChatMessage = useCallback((conversationId: string, text: string): void => {
    const quote = sideQuotes[conversationId]
    const prompt = quote === undefined || text.trim() === '' ? text : buildSideChatPrompt(quote, text)
    if (quote !== undefined) {
      setSideQuotes(current => {
        if (current[conversationId] === undefined) return current
        const next = { ...current }
        delete next[conversationId]
        return next
      })
    }
    void api.submit(conversationId, { text: prompt, requestId: crypto.randomUUID() })
      .catch(cause => { announce(errorText(cause, t('无法发送消息', 'Could not send the message'))) })
  }, [announce, sideQuotes, t])

  // ZCode's side pane chords live with the entries they drive, which are declared above.
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
      if (document.querySelector('[role="menu"], [role="dialog"]') !== null) return
      const shortcuts = resolveShortcuts(settings.shortcuts)
      if (matchesShortcut(event, shortcuts.toggleInspector)) {
        event.preventDefault()
        toggleInspector()
      } else if (matchesShortcut(event, shortcuts.toggleInspectorFullView)) {
        event.preventDefault()
        toggleInspectorFullView()
      }
    }
    document.addEventListener('keydown', onShortcut, true)
    return () => { document.removeEventListener('keydown', onShortcut, true) }
  }, [settings.shortcuts, toggleInspector, toggleInspectorFullView])

  const clampInspectorWidth = (value: number): number =>
    Math.min(Math.max(value, 280), Math.min(760, window.innerWidth * 0.7))
  const beginInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    inspectorResize.current = { startX: event.clientX, startWidth: inspectorWidth }
  }
  const moveInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = inspectorResize.current
    if (start === null) return
    // The divider sits on the inspector's left edge, so dragging left widens it.
    setInspectorWidth(clampInspectorWidth(start.startWidth + (start.startX - event.clientX)))
  }
  const endInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    inspectorResize.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const nudgeInspector = (delta: number): void => {
    setInspectorWidth(value => clampInspectorWidth(value + delta))
  }
  // A window narrowed after a wide drag must not squeeze the primary column.
  useEffect(() => {
    const onResize = (): void => {
      setInspectorWidth(value => Math.min(Math.max(value, 280), Math.min(760, window.innerWidth * 0.7)))
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])
  /**
   * DSH's `openPlan` (`ui-plan/src/client/PlanCard.tsx:48-57`): focus the exact submitted plan in
   * the right sidebar. `auto` is the one automatic open per conversation (`PlanCard.tsx:72-80`).
   */
  const openPlan = useCallback((plan: PlanDocument, auto = false): void => {
    if (auto) {
      if (selectedId === null || planAutoOpenedFor.current === selectedId) return
      planAutoOpenedFor.current = selectedId
    }
    inspectorRequestId.current += 1
    setInspectorPlan(plan)
    openPaneTab({ id: 'doc:plan', type: 'document', title: t('计划', 'Plan'), openedAt: Date.now(), doc: { kind: 'plan' } })
    setInspectorError('')
    setInspectorLoading(false)
  }, [openPaneTab, selectedId, t])

  // DSH opens each pending review once, automatically, and stops after the reader closes it
  // (`PlanCard.tsx:63-80` + `review-store.ts:12-22`). Pi keys the memory to the conversation,
  // so switching sessions resets it; a plan that is no longer pending never auto-opens.
  useEffect(() => {
    planAutoOpenedFor.current = null
  }, [selectedId])

  // Plugin pages belong to the conversation that opened them (`plugin-marketplace-design.md` §8.2),
  // so a session switch destroys both the mounted pages and the surface list for the old session.
  // Child tabs, trajectory and side chats go with them: each belongs to its parent conversation.
  useEffect(() => {
    setPluginPages([])
    setPluginPageHosts({})
    setPluginSurfaces([])
    setSideFeeds({})
    setSideQuotes({})
    commitPane(stripConversationScoped(paneRef.current))
  }, [commitPane, selectedId])

  // Tabs are remembered per workspace (ZCode's taskSidePaneMemory); moving between workspaces
  // swaps the bucket, and an unknown workspace starts empty. An empty scope collapses the pane
  // (ZCode's resolveSidePaneScopeState), so switching to a fresh workspace never shows a bare shell.
  useEffect(() => {
    if (currentWorkspaceId === undefined) {
      setPaneState({ tabs: [], activeTabId: null })
      setInspectorOpen(false)
      return
    }
    const restored = readPaneMemory(currentWorkspaceId) ?? { tabs: [], activeTabId: null }
    setPaneState(restored)
    if (restored.tabs.length === 0) setInspectorOpen(false)
  }, [currentWorkspaceId])
  useEffect(() => {
    if (selectedId === null || conversationPlan === undefined || conversationPlan.pending !== true) return
    if (planAutoOpenedFor.current === selectedId) return
    openPlan(conversationPlan, true)
  }, [conversationPlan, openPlan, selectedId])

  return (
    <main className={`${css.shell} ${sidebarCollapsed && !mobile ? css.shellCollapsed : ''}`}>
      {mobile && sidebarOpen && <button className={css.backdrop} aria-hidden="true" tabIndex={-1}
        aria-label={t('关闭侧栏', 'Close sidebar')} onClick={() => {
          setSidebarOpen(false)
          requestAnimationFrame(() => { if (sidebarTriggerRef.current !== null) focusWithoutRing(sidebarTriggerRef.current) })
        }} />}
      <aside ref={sidebarRef} className={`${css.sidebar} ${sidebarCollapsed && !mobile ? css.sidebarCollapsed : ''} ${mobile ? sidebarOpen ? css.sidebarMobileOpen : css.sidebarMobileClosed : ''}`}
        aria-label={t('主导航和任务列表', 'Navigation and tasks')} tabIndex={-1}
        role={mobile && sidebarOpen ? 'dialog' : undefined} aria-modal={mobile && sidebarOpen ? true : undefined}
        aria-hidden={mobile && !sidebarOpen ? true : undefined}>
        <div className={css.sidebarHeader}>
          <div className={css.brand}>
            <span className={css.brandMark} aria-hidden>π</span>
            <span className={css.brandName}><strong>Pi Durable</strong><small>{appVersion !== '' ? `v${appVersion}` : t('本机工作区', 'LOCAL WORKSPACE')}</small></span>
          </div>
          {!mobile && <Tooltip label={sidebarCollapsed ? t('展开侧栏', 'Expand sidebar') : t('收起侧栏', 'Collapse sidebar')} side="bottom" portal>
            <Button variant="ghost" size="sm" aria-label={sidebarCollapsed ? t('展开侧栏', 'Expand sidebar') : t('收起侧栏', 'Collapse sidebar')}
              icon={<IconPanelLeftOutlineRegular size={15} />} onClick={() => { setSidebarCollapsed(value => !value) }} />
          </Tooltip>}
        </div>
        <Button variant="outline" className={css.newChat} icon={<IconNewChatOutlineRegular size={14} />} onClick={startNewTask}>
          {t('新任务', 'New task')}
        </Button>
        <nav className={css.quickNav} aria-label={t('管理页面', 'Management pages')}>
          <button type="button" className={css.navItem} data-active={page === 'defects' || undefined}
            aria-label={t('问题清单', 'Issues')} aria-current={page === 'defects' ? 'page' : undefined} onClick={() => { navigate('defects') }}>
            <IconChecklistOutlineRegular size={16} /><span>{t('问题清单', 'Issues')}</span>
          </button>
          <button type="button" className={css.navItem} data-active={page === 'automations' || undefined}
            aria-label={t('自动化任务', 'Automations')} aria-current={page === 'automations' ? 'page' : undefined} onClick={() => { navigate('automations') }}>
            <IconClockOutlineRegular size={16} /><span>{t('自动化任务', 'Automations')}</span>
          </button>
        </nav>
        <div className={css.taskHeader}>
          <span>{t('任务', 'Tasks')}</span>
          <Tooltip label={t('添加工作区', 'Add workspace')} side="top" portal>
            <Button variant="ghost" size="sm" aria-label={t('添加工作区', 'Add workspace')} icon={<IconPlusOutlineRegular size={15} />}
              onClick={() => { void addWorkspaceFromPicker() }} />
          </Tooltip>
        </div>
        <div className={css.taskList}>
          {workspaceLoadError !== '' && <div className={css.listNotice} role="alert"><span>{workspaceLoadError}</span>
            <button type="button" onClick={() => { void refreshWorkspaces() }}>{t('重试', 'Retry')}</button></div>}
          {workspaceLoadError === '' && workspaces.length === 0 && !workspaceLoading && <p className={css.listEmpty}>{t('添加一个文件夹开始工作', 'Add a folder to get started')}</p>}
          {listLoading && <TaskSkeleton />}
          {!listLoading && attentionTasks.length > 0 && <section className={css.taskSection}>
            <div className={css.taskSectionHead}>
              <span className={css.taskSectionLabel}>{t('需要你', 'Needs you')}</span>
              <span className={css.taskSectionBadge}>{attentionTasks.length}</span>
            </div>
            {attentionTasks.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId}
              onSelect={() => { selectConversation(task.id) }} />)}
          </section>}
          {!listLoading && activeTasks.length > 0 && <section className={css.taskSection}>
            <div className={css.taskSectionHead}>
              <span className={css.taskSectionLabel}>{t('进行中', 'In progress')}</span>
            </div>
            {activeTasks.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId}
              onSelect={() => { selectConversation(task.id) }} />)}
          </section>}
          {!listLoading && doneTasks.length > 0 && <section className={css.taskSection}>
            <button type="button" className={css.taskSectionHead} data-toggle aria-expanded={!doneCollapsed}
              onClick={() => { setDoneCollapsed(value => !value) }}>
              <span className={css.taskSectionLabel}>{t('已完成', 'Completed')}</span>
              <span className={css.taskSectionCount}>{doneTasks.length}</span>
              <ChevronRight size={13} className={css.taskSectionChevron} data-open={!doneCollapsed || undefined} aria-hidden="true" />
            </button>
            {!doneCollapsed && doneTasks.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId}
              onSelect={() => { selectConversation(task.id) }} />)}
          </section>}
          {!listLoading && listError === '' && sortedTasks.length === 0 && <p className={css.listEmpty}>{t('还没有任务：在下方输入框描述你要做的事', 'No tasks yet: describe what you need in the composer below')}</p>}
          {!listLoading && listError !== '' && <div className={css.listNotice} role="alert"><span>{listError}</span>
            <button type="button" onClick={() => { setListLoading(true); void refreshTasks() }}>{t('重试', 'Retry')}</button></div>}
        </div>
        <div className={css.sidebarFoot}>
          {/* DSH's footer is the account row; the settings entry lives inside its menu. */}
          <div className={css.accountMenuAnchor}>
          <Menu open={accountMenuOpen} onClose={() => { setAccountMenuOpen(false) }} side="top" portal
            onSelect={id => {
              setAccountMenuOpen(false)
              if (id === 'settings') { setSettingsInitialTab('general'); setSettingsOpen(true) }
              else if (id === 'feedback') { setFeedbackError(''); setFeedbackOpen(true) }
            }}
            items={[
              {
                id: 'settings',
                icon: <IconSettingsOutlineRegular size={15} />,
                label: <span className={css.accountMenuRow}><span>{t('设置', 'Settings')}</span>
                  <ShortcutKeys keys={shortcutKeyLabels(resolveShortcuts(settings.shortcuts).settings)} /></span>,
              },
              {
                id: 'feedback',
                icon: <IconListPenOutlineRegular size={15} />,
                label: t('意见反馈', 'Send feedback'),
              },
            ]}
            anchor={<button type="button" className={css.accountRow} aria-label={t('账号菜单', 'Account menu')}
              aria-haspopup="menu" aria-expanded={accountMenuOpen}
              onClick={() => { setAccountMenuOpen(value => !value) }}>
              <span className={css.accountAvatar} aria-hidden="true">{accountInitial(accountName)}</span>
              <span className={css.accountLabel}>{accountName === '' ? t('本机工作区', 'Local workspace') : accountName}</span>
            </button>} />
          </div>
        </div>
      </aside>

      <section ref={mainPanelRef} className={css.mainPanel} tabIndex={-1} aria-label={t('主内容', 'Main content')}
        aria-hidden={mobile && sidebarOpen ? true : undefined}>
        {mobile && !showConversationHeader && <button type="button" className={css.mobileSidebarButton}
          aria-label={t('打开任务列表', 'Open task list')} onClick={() => { setSidebarOpen(true) }}>
          <IconPanelLeftOutlineRegular size={16} />
        </button>}
        <PluginPageHostContext.Provider value={pluginPagePool}>
        <div ref={pluginPageHolding} aria-hidden="true"
          style={{ position: 'fixed', left: '-10000px', top: 0, width: 0, height: 0, overflow: 'hidden' }} />
        <div className={`${css.mainBody} ${showInspector ? css.withInspector : ''}`}
          style={showInspector ? ({ '--inspector-width': `${inspectorWidth}px` } as CSSProperties) : undefined}>
          <div className={css.primaryPanel}>
            {page === 'chat' && <>
              {showConversationHeader && <>
                <header className={css.topbar}>
                  <div className={css.topbarStart}>
                    {mobile && <Tooltip label={t('任务列表', 'Task list')} side="bottom" portal>
                      <Button ref={sidebarTriggerRef} variant="ghost" size="sm" aria-label={t('打开任务列表', 'Open task list')}
                        icon={<IconPanelLeftOutlineRegular size={16} />} onClick={() => { setSidebarOpen(true) }} />
                    </Tooltip>}
                    <div className={css.conversationHeading}>
                      {activeDetail?.conversation.parentId !== undefined
                        ? <SubagentBreadcrumb conversation={activeDetail.conversation}
                          parentTitle={tasks.find(item => item.id === activeDetail.conversation.parentId)?.title}
                          onOpen={id => { selectConversation(id) }} t={t} />
                        : <span className={css.conversationTitle}>{activeDetail?.conversation.title ?? selectedTask?.title ?? t('任务', 'Task')}</span>}
                      <span className={css.cwd}>{currentWorkspace?.name ?? activeDetail?.conversation.cwd ?? selectedTask?.cwd ?? ''}
                        {selectedTaskStatus !== undefined && <span className={css.taskState} data-status={selectedTaskStatus}>
                          {taskStatusLabel(selectedTaskStatus, t)}
                        </span>}</span>
                    </div>
                    {/* DSH puts the descendant count and the team action between the title and the header actions. */}
                    {activeDetail !== null && <SubagentPanel conversationId={activeDetail.conversation.id}
                      subagents={activeDetail.subagents}
                      onOpen={childId => { openSubagentTab(childId) }}
                      onNotice={message => { announce(message) }} />}
                    {activeDetail !== null && <TeamPanel conversationId={activeDetail.conversation.id}
                      team={activeDetail.team}
                      onOpen={memberId => { selectConversation(memberId) }}
                      onNotice={message => { announce(message) }} />}
                  </div>
                  <div className={css.topbarActions}>
                    <ConnectionIndicator state={connection} disconnectedLabel={t('连接中断 · 重新连接', 'Connection lost · reconnect')}
                      connectingLabel={t('正在连接', 'Connecting')} recoveredLabel={t('连接已恢复', 'Connection restored')}
                      reconnectActionLabel={t('重新连接任务', 'Reconnect task')} restartActionLabel={t('再次尝试连接', 'Try again')}
                      onReconnect={() => { setConnection('connecting'); setReconnectToken(value => value + 1) }} />
                    <Menu open={moreMenuOpen} onClose={() => { setMoreMenuOpen(false) }} onSelect={id => {
                      setMoreMenuOpen(false)
                      if (id === 'download') void downloadSessionLog()
                    }} items={[
                      { id: 'download', label: t('下载 Session 日志', 'Download session log'), icon: <IconDownloadOutlineRegular size={14} /> },
                    ]} portal anchor={<Tooltip label={t('更多操作', 'More actions')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={t('更多操作', 'More actions')}
                        icon={<IconEllipsisOutlineRegular size={16} />} onClick={() => { setMoreMenuOpen(value => !value) }} />
                    </Tooltip>} />
                    <Tooltip label={t('模型设置', 'Model settings')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={t('打开模型设置', 'Open model settings')} icon={<IconSettingsOutlineRegular size={16} />}
                        onClick={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }} />
                    </Tooltip>
                    <Tooltip label={inspectorOpen ? t('关闭侧栏', 'Close inspector') : t('打开侧栏', 'Open inspector')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={inspectorOpen ? t('关闭侧栏', 'Close inspector') : t('打开侧栏', 'Open inspector')}
                        icon={<IconPanelLeftOutlineRegular className={css.panelToggleIcon} size={16} />}
                        onClick={toggleInspector} />
                    </Tooltip>
                  </div>
                </header>
              </>}
              {taskHeadVisible && selectedTaskStatus !== undefined && <div className={css.taskHead}>
                <div className={css.taskHeadInfo}>
                  <span className={css.taskHeadBadge} data-status={selectedTaskStatus}>
                    <span className={css.taskHeadDot} aria-hidden="true" />
                    {taskStatusLabel(selectedTaskStatus, t)}
                  </span>
                  {taskHeadAction !== '' && <span className={css.taskHeadAction} title={taskHeadAction}>{taskHeadAction}</span>}
                </div>
                <div className={css.taskViewTabs} role="tablist" aria-label={t('任务视图', 'Task view')}>
                  <button type="button" role="tab" aria-selected={taskView === 'process'} className={css.taskViewTab}
                    data-active={taskView === 'process' || undefined} onClick={() => { switchTaskView('process') }}>{t('过程', 'Process')}</button>
                  <button type="button" role="tab" aria-selected={taskView === 'changes'} className={css.taskViewTab}
                    data-active={taskView === 'changes' || undefined} onClick={() => { switchTaskView('changes') }}>
                    {t('变更', 'Changes')}{taskChangeCount > 0 && <span className={css.taskViewTabBadge}>{taskChangeCount}</span>}
                  </button>
                  <button type="button" role="tab" aria-selected={taskView === 'summary'} className={css.taskViewTab}
                    data-active={taskView === 'summary' || undefined} onClick={() => { switchTaskView('summary') }}>{t('总结', 'Summary')}</button>
                </div>
              </div>}
              {hero
                ? <>
                  <div className={css.heroHeader}>
                    <span className={css.entryLabel}>{t('任务入口', 'Task entry')}</span>
                    <Tooltip label={inspectorOpen ? t('关闭侧栏', 'Close inspector') : t('打开侧栏', 'Open inspector')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={inspectorOpen ? t('关闭侧栏', 'Close inspector') : t('打开侧栏', 'Open inspector')}
                        icon={<IconPanelLeftOutlineRegular className={css.panelToggleIcon} size={16} />}
                        onClick={toggleInspector} />
                    </Tooltip>
                  </div>
                  {workspaces.length === 0 && !workspaceLoading && <div className={css.emptyWorkspaceNotice} role="status">
                    <span>{t('还没有工作区：添加一个文件夹，AI 才能读写文件和运行命令', 'No workspace yet: add a folder so the AI can read files and run commands')}</span>
                    <Button variant="outline" size="sm" icon={<IconPlusOutlineRegular size={14} />} onClick={() => { void addWorkspaceFromPicker() }}>
                      {t('添加工作区', 'Add workspace')}
                    </Button>
                  </div>}
                  <div className={css.heroArea}>
                  <Composer hero value={draft} images={images} catalog={catalog} model={selectedModel} thinkingLevel={thinkingLevel}
                    busy={false} disabled={detailLoading} queue={[]} sendMode={sendMode} sending={sending}
                    workspace={currentWorkspace} workspaces={workspaces} accessMode={accessMode}
                    accessModes={accessModes} files={[]}
                    plan={newPlan} onPlan={active => { void setPlan(active) }}
                    onChange={setDraft} onAddImages={addImages} onRemoveImage={removeImage} onRetryImage={retryImage} onSend={mode => { void send(mode) }}
                    onStop={() => { void stop() }} onRemoveQueue={id => { void removeQueue(id) }}
                    onSelectModel={model => { void chooseModel(model) }} onThinkingLevel={level => { void chooseThinking(level) }}
                    onSendMode={setSendMode} onSelectWorkspace={id => { void selectWorkspace(id) }} onAddWorkspace={() => { void addWorkspaceFromPicker() }}
                    onAccessMode={mode => { void selectAccessMode(mode) }}
                    onOpenSettings={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }} onNewConversation={startNewTask}
                    onSearchFiles={searchWorkspaceFiles} onSearchSkills={searchSkills} onPreviewFile={path => { void openWorkspaceFile(path) }}
                    pluginContexts={pluginContexts} onRemovePluginContext={removePluginContext} />
                  </div>
                </>
                : <>
                  {detailLoading && !activeDetail && <LoadingConversation />}
                  {!detailLoading && detailError !== '' && !activeDetail && <div className={css.contentState} role="alert">
                    <span>{detailError}</span><Button variant="outline" size="sm" onClick={() => {
                      if (selectedId === null) return
                      setDetailLoading(true)
                      void api.getConversation(selectedId).then(value => {
                        detailRef.current = value; setDetail(value); setDetailError('')
                      }).catch(cause => { setDetailError(errorText(cause, t('无法打开此任务', 'Could not open this task'))) })
                        .finally(() => { setDetailLoading(false) })
                    }}>{t('重试', 'Retry')}</Button>
                  </div>}
                  {activeDetail !== null && <div ref={selectionHostRef} className={`${css.chatLayout} ${taskView === 'process' && statusPanelVisible ? css.withStatusPanel : ''}`}>
                    {taskView === 'process' && <>
                    <SelectionAskPopover containerRef={selectionHostRef} onAsk={quote => { void openSelectionChat(quote) }} />
                    <div className={css.messagesPane}>
                    <div className={css.messagesViewport} ref={messagesViewport} tabIndex={-1} onScroll={event => { syncViewportScroll(event.currentTarget) }}>
                      <Transcript messages={visibleTranscriptMessages(activeDetail.messages, activeDetail.compaction?.running === true)} compactionRunning={activeDetail.compaction?.running === true} conversationId={activeDetail.conversation.id}
                        pending={selectedPending} interactions={activeDetail.interactions}
                        subagents={activeDetail.subagents}
                        running={activeDetail.conversation.busy === true}
                        onFork={entryId => { void forkFrom(entryId) }} onRetry={entryId => { void retryEntry(entryId) }}
                        onFeedback={(entryId, rating) => { void submitFeedback(entryId, rating) }}
                        onOpenFile={(path, line) => { void openWorkspaceFile(path, undefined, line) }}
                        resolveFileImage={path => currentWorkspaceId === undefined ? undefined
                          : `/api/workspaces/${encodeURIComponent(currentWorkspaceId)}/asset?${new URLSearchParams({ path }).toString()}`}
                        onInspectDiff={inspectDiff}
                        onOpenSubagent={(childId, title) => { openSubagentTab(childId, title) }}
                        onOpenPlan={plan => { openPlan(plan) }}
                        onOpenPluginUi={openPluginPage}
                        onPluginContext={addPluginContext}
                        onPluginMessage={text => { void sendPluginMessage(text) }}
                        onPluginOpenLink={openPluginLink} />
                    </div>
                    {jumpToBottomVisible && <button type="button" className={css.jumpToBottom}
                      aria-label={t('滚动到底部', 'Scroll to bottom')} title={t('滚动到底部', 'Scroll to bottom')}
                      onClick={jumpToBottom}><ArrowDown size={16} aria-hidden="true" /></button>}
                    </div>
                    <StatusPanel workspaceId={currentWorkspaceId} conversationId={activeDetail.conversation.id}
                      todos={activeDetail.todos} subagents={activeDetail.subagents}
                      goal={activeDetail.goal} plans={conversationPlans}
                      refreshToken={`${activeDetail.messages.length}:${activeDetail.conversation.busy === true}`}
                      onOpenSubagent={(childId, title) => { openSubagentTab(childId, title) }}
                      onOpenSubagentDirectory={openSubagentDirectory}
                      onOpenPlan={plan => { openPlan(plan) }}
                      onGoalAction={action => { void updateGoal(action) }}
                      onInspectDiff={inspectDiff}
                      onNotice={announce} onVisibilityChange={setStatusPanelVisible}
                      onContentChange={setStatusPanelOccupied} />
                    {catalogError !== '' && <div className={css.catalogNotice} role="status"><span>{catalogError}</span>
                      <button type="button" onClick={() => { void refreshCatalog() }}>{t('重试', 'Retry')}</button></div>}
                    <GoalBar goal={activeDetail.goal} onSetState={(action, payload) => { void updateGoal(action, payload) }} />
                    {!statusPanelOccupied && <TodoPanel todos={activeDetail.todos} />}
                    <QuestionComposer conversationId={activeDetail.conversation.id} interactions={activeDetail.interactions}
                      onDismiss={focusComposer}
                      onOpenPlan={plan => { openPlan(plan) }}
                      onAnswered={value => {
                        detailRef.current = value
                        setDetail(value)
                        setDetailError('')
                      }} />
                    {activeDetail.compaction?.running !== true && activeDetail.compaction?.failure !== undefined && <div className={css.compactionNotice} data-state="error" role="alert">
                      <span>{t('上下文压缩失败', 'Context compaction failed')}</span>
                      <span className={css.compactionHint}>{activeDetail.compaction.failure}</span>
                    </div>}
                    </>}
                    {taskView === 'changes' && <TaskChangesView messages={activeDetail.messages}
                      onInspectDiff={inspectDiff} onOpenFile={path => { void openWorkspaceFile(path) }} t={t} />}
                    {taskView === 'summary' && <TaskSummaryView detail={activeDetail} changeCount={taskChangeCount}
                      onOpenFile={(path, line) => { void openWorkspaceFile(path, undefined, line) }}
                      resolveFileImage={resolveWorkspaceImage} onViewProcess={() => { switchTaskView('process') }} t={t} />}
                    <Composer value={draft} images={images} catalog={catalog} model={selectedModel} thinkingLevel={thinkingLevel}
                      busy={busy} disabled={detailLoading || !conversationReady && detailError === ''} queue={activeDetail.queue}
                      sendMode={sendMode} sending={sending} workspace={currentWorkspace} workspaces={workspaces}
                      accessMode={accessMode} accessModes={accessModes}
                      plan={activeDetail === null ? newPlan : activeDetail.plan?.active === true} onPlan={active => { void setPlan(active) }}
                      files={[]} stats={conversationStats(activeDetail.messages)}
                      onChange={setDraft} onAddImages={addImages} onRemoveImage={removeImage} onRetryImage={retryImage} onSend={mode => { void send(mode) }}
                      onStop={() => { void stop() }} onRemoveQueue={id => { void removeQueue(id) }}
                      onSelectModel={model => { void chooseModel(model) }} onThinkingLevel={level => { void chooseThinking(level) }}
                      onSendMode={setSendMode} onSelectWorkspace={id => { void selectWorkspace(id) }} onAddWorkspace={() => { void addWorkspaceFromPicker() }}
                      onAccessMode={mode => { void selectAccessMode(mode) }}
                      onUpdateQueue={updateQueue} onOpenSettings={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }}
                      onCompact={() => { void compact() }}
                      onNewConversation={startNewTask} onSearchFiles={searchWorkspaceFiles} onSearchSkills={searchSkills} onPreviewFile={path => { void openWorkspaceFile(path) }}
                      pluginContexts={pluginContexts} onRemovePluginContext={removePluginContext} />
                  </div>}
                </>}
            </>}
            {page === 'defects' && <Suspense fallback={<div className={css.loadingState}><Loader size={16} />{t('正在加载问题清单', 'Loading issues')}</div>}>
              <WetrackPage workspaces={workspaces} onOpenConversation={openConversation} />
            </Suspense>}
            {page === 'automations' && <AutomationsPage workspaceId={currentWorkspaceId}
              workspaces={workspaces} onNewConversation={startNewTask}
              onOpenConversation={openConversation} />}
          </div>
          {showInspector && <>
            {!inspectorFullView && <div className={css.inspectorResizer} role="separator" aria-orientation="vertical"
              aria-label={t('调整侧栏宽度', 'Resize inspector')}
              aria-valuenow={inspectorWidth} aria-valuemin={280} aria-valuemax={760} tabIndex={0}
              onPointerDown={beginInspectorResize} onPointerMove={moveInspectorResize}
              onPointerUp={endInspectorResize} onPointerCancel={endInspectorResize}
              onDoubleClick={() => { setInspectorWidth(360) }}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeInspector(16) }
                else if (event.key === 'ArrowRight') { event.preventDefault(); nudgeInspector(-16) }
              }} />}
            <aside className={`${css.inspectorPane} ${inspectorFullView && !mobile ? css.inspectorPaneFullscreen : ''}`}
              aria-label={t('侧边面板', 'Side pane')}>
              <Inspector
                workspaceId={currentWorkspaceId}
                tabs={pane.tabs} activeTabId={pane.activeTabId}
                onSelectTab={selectPaneTab} onCloseTab={id => { closePaneTabs([id]) }}
                onCloseOtherTabs={closeOtherPaneTabs} onCloseAllTabs={closeAllPaneTabs}
                onOpenNewTab={openNewTabPane}
                fullView={inspectorFullView} onToggleFullView={toggleInspectorFullView}
                launcher={{
                  surfaces: pluginSurfaces,
                  surfacesLoading: false,
                  onRefreshSurfaces: () => { void refreshPluginSurfaces() },
                  onOpenSurface: openPluginSurface,
                  onOpenFiles: () => { if (currentWorkspaceId !== undefined) openWorkspaceBrowser(currentWorkspaceId) },
                  onOpenReview: openReviewPane,
                  onOpenBrowser: openBrowserPane,
                  onOpenTrajectory: openTrajectoryPane,
                  onOpenSelectionChat: () => { void openSelectionChat() },
                  canOpenReview: !pane.tabs.some(tab => tab.type === 'git'),
                  canOpenTrajectory: selectedId !== null,
                  canOpenSelectionChat: currentWorkspaceId !== undefined,
                }}
                gitPane={{
                  activeSource: gitSource,
                  onSelectSource: setGitSource,
                  lastTurnChanges,
                  onNotice: announce,
                }}
                browserPane={{ onNavigate: patchBrowserTab }}
                selectionChat={{ for: conversationId => {
                  const feed = sideFeeds[conversationId]
                  const quote = sideQuotes[conversationId]
                  return {
                    messages: feed?.messages ?? [],
                    busy: feed?.busy ?? false,
                    onSend: text => { sendSideChatMessage(conversationId, text) },
                    quotedText: quote,
                    onDismissQuote: quote === undefined ? undefined : () => {
                      setSideQuotes(current => {
                        if (current[conversationId] === undefined) return current
                        const next = { ...current }
                        delete next[conversationId]
                        return next
                      })
                    },
                  }
                } }}
                onNotice={announce}
                plan={inspectorPlan ?? conversationPlan ?? null}
                browse={browseWorkspace === undefined || browseTab === undefined ? null : {
                  workspace: browseWorkspace,
                  path: browseTab.path ?? '',
                  onOpenFile: path => { void openWorkspaceFile(path, browseWorkspace.id) },
                }}
                loading={inspectorLoading} error={inspectorError}
                pluginPages={pluginPages}
                pluginPageHosts={pluginPageHosts} sidePageIds={sidePageIds}
                onReleasePluginPageHost={holdPluginPageHost}
                onClosePluginPage={closePluginPage}
                onPluginContext={addPluginContext} onPluginMessage={text => { void sendPluginMessage(text) }}
                onPluginOpenLink={openPluginLink}
                pluginSurfaces={pluginSurfaces} onOpenPluginSurface={openPluginSurface}
                onRefreshPluginSurfaces={refreshPluginSurfaces}
                subagentDirectory={{ subagents: activeDetail?.subagents ?? [], onOpen: (childId, title) => { openSubagentTab(childId, title) } }}
                onClose={closeInspector} />
            </aside>
          </>}
          {pane.tabs.filter(tab => tab.type === 'selection-chat').map(tab => <SideConversationPump key={tab.id}
            conversationId={tab.conversationId!} active={showInspector && pane.activeTabId === tab.id}
            onFeed={(messages, busyParam) => { setSideFeeds(current => ({ ...current, [tab.conversationId!]: { messages, busy: busyParam } })) }} />)}
        </div>
        </PluginPageHostContext.Provider>
      </section>
      <SettingsDialog open={settingsOpen} catalog={catalog} saving={savingProvider} settings={settings} accessModes={accessModes} workspaceId={currentWorkspaceId}
        initialTab={settingsInitialTab} onSettingsChange={onSettingsChange} onRefreshCatalog={refreshCatalog}
        onClose={() => { setSettingsOpen(false) }} onSave={saveProvider} activeProvider={selectedModel?.provider}
        onCreatePlugin={startPluginCreation} />
      <DirectoryBrowser open={directoryBrowserOpen} onClose={() => { setDirectoryBrowserOpen(false) }}
        onPick={path => {
          setDirectoryBrowserOpen(false)
          const name = path.replace(/\/+$/u, '').split('/').pop() ?? path
          void addWorkspace({ path, name }).then(async added => {
            await refreshWorkspaces()
            announce(t(`已添加工作区 ${added.name}`, `Added workspace ${added.name}`), true)
          }).catch(cause => { announce(errorText(cause, t('无法添加工作区', 'Could not add the workspace'))) })
        }} />
      <Modal open={feedbackOpen} onClose={() => { setFeedbackOpen(false) }} title={t('意见反馈', 'Send feedback')}
        closeLabel={t('关闭', 'Close')} className={css.childModal}
        footer={<><Button variant="ghost" onClick={() => { setFeedbackOpen(false) }}>{t('取消', 'Cancel')}</Button>
          <Button variant="primary" disabled={feedbackText.trim() === '' || feedbackText.trim().length > 2000 || feedbackSending}
            onClick={() => { void sendUserFeedback() }}>{t('提交', 'Submit')}</Button></>}>
        <textarea className={css.feedbackInput} rows={6} value={feedbackText} data-modal-autofocus
          aria-label={t('意见反馈内容', 'Feedback text')} placeholder={t('写下你的建议或遇到的问题', 'Tell us what you think or what went wrong')}
          onChange={event => { setFeedbackText(event.currentTarget.value) }} />
        {feedbackError !== '' && <p className={css.feedbackError} role="alert">{feedbackError}</p>}
      </Modal>
      {settingsError !== '' && <div className={css.settingsNotice} role="status">{settingsError}</div>}
      {toast !== null && <Toast key={toast.id} text={toast.text} tone={toast.success ? 'success' : undefined}
        onDone={() => { setToast(current => current?.id === toast.id ? null : current) }} />}
    </main>
  )
}

/**
 * Polls one side chat's conversation and pumps its feed into the app state the inspector reads.
 * Mounted per selection-chat tab; rendering nothing keeps the pane's DOM contract untouched.
 */
function SideConversationPump({ conversationId, active, onFeed }: {
  conversationId: string
  active: boolean
  onFeed: (messages: SideChatMessage[], busy: boolean) => void
}) {
  const { messages, busy } = useSideConversation(conversationId, active)
  useEffect(() => { onFeed(messages, busy) }, [busy, messages, onFeed])
  return null
}

/**
 * One row of the single entry's task list. The leading cell is the status: a spinner while the task
 * runs, otherwise a dot coloured by the server's status. The trailing time cell follows DSH's rows.
 */
function TaskRow({ task, selected, onSelect }: {
  task: TaskSummary
  selected: boolean
  onSelect: () => void
}) {
  const { t, settings } = useUiPreferences()
  const unread = task.unread === true && !selected
  const subtitle = taskRowSubtitle(task, t)
  return (
    <div className={css.taskRow} data-selected={selected || undefined} data-status={task.status}>
      <button type="button" className={css.taskSelect} onClick={onSelect} aria-current={selected ? 'page' : undefined}>
        <span className={css.taskSlot}>
          {task.busy ? (
            <span className={css.taskSpinner} role="img" aria-label={t('正在运行', 'Running')}>
              <Loader size={15} aria-hidden="true" />
            </span>
          ) : (
            <span className={css.taskDot} data-status={task.status} role="img" aria-label={taskStatusLabel(task.status, t)} />
          )}
        </span>
        <span className={css.taskBody}>
          <span className={css.taskTitle}>{task.title || t('未命名任务', 'Untitled task')}</span>
          {subtitle !== '' && <span className={css.taskSubtitle} title={subtitle}>{subtitle}</span>}
        </span>
        {unread && <span className={css.taskUnread} role="img" aria-label={t('有未读回复', 'Unread reply')} />}
        {task.status === 'waiting' && <span className={css.taskWaiting}>{t('等待回答', 'Waiting')}</span>}
      </button>
      <time className={css.taskMeta} dateTime={new Date(task.updatedAt).toISOString()}>{hoverTime(task.updatedAt, settings.locale)}</time>
    </div>
  )
}

/** The row's second line: why it needs the reader, what it is doing, or its latest reply. */
function taskRowSubtitle(task: TaskSummary, t: (chinese: string, english: string) => string): string {
  if (task.status === 'waiting' || task.status === 'failed' || task.status === 'cancelled') return task.attention ?? ''
  if (task.status === 'running' || task.status === 'queued') return task.preview ?? t('运行中', 'Running')
  return task.preview ?? ''
}

/**
 * DSH's breadcrumb lineage for a subagent session (`SubagentHeaderLineage.tsx:785-822`):
 * the parent title navigates back, and the current child title is a sibling switcher whose
 * menu highlights the session on screen with DSH's 「当前会话」 tag (`:238,340`). The switcher's
 * accessible name is DSH's `switcher.aria` (`locales.ts:40`).
 */
function SubagentBreadcrumb({ conversation, parentTitle, onOpen, t }: {
  conversation: ConversationSummary
  /** The parent's title when the sidebar list already knows it. */
  parentTitle?: string
  onOpen: (id: string) => void
  t: (chinese: string, english: string) => string
}) {
  const parentId = conversation.parentId
  const [resolvedParent, setResolvedParent] = useState<string | undefined>(parentTitle)
  const [siblings, setSiblings] = useState<SubagentSummary[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (parentId === undefined) return
    let active = true
    setOpen(false)
    // A subagent of a subagent is not in the sidebar list, so the parent title falls back to the route.
    if (parentTitle === undefined) {
      api.getConversation(parentId).then(value => { if (active) setResolvedParent(value.conversation.title) }).catch(() => undefined)
    } else {
      setResolvedParent(parentTitle)
    }
    api.listChildren(parentId).then(value => { if (active) setSiblings(value) }).catch(() => undefined)
    return () => { active = false }
  }, [parentId, parentTitle])
  if (parentId === undefined) return null
  const parentLabel = resolvedParent ?? parentId
  const currentTitle = conversation.title || t('子会话', 'Subagent session')
  const items: MenuEntry[] = siblings.map(sibling => ({
    id: sibling.id,
    label: <span className={css.crumbItem}>
      <span className={css.crumbItemTitle}>{sibling.title || sibling.label}</span>
      {sibling.id === conversation.id && <Tag tone="info" className={css.crumbTag}>{t('当前会话', 'Current chat')}</Tag>}
    </span>,
  }))
  return (
    <nav className={css.crumbs} aria-label={t('会话层级', 'Session hierarchy')}>
      <button type="button" className={css.crumb} title={parentLabel} onClick={() => { onOpen(parentId) }}>{parentLabel}</button>
      <span className={css.crumbSep} aria-hidden="true">/</span>
      <Menu open={open} onClose={() => { setOpen(false) }} items={items} portal
        onSelect={id => { setOpen(false); if (id !== conversation.id) onOpen(id) }}
        anchor={<button type="button" className={`${css.crumb} ${css.crumbCurrent}`} aria-haspopup="menu" aria-expanded={open}
          aria-label={t(`切换子智能体：${currentTitle}`, `Switch subagent: ${currentTitle}`)}
          onClick={() => { setOpen(value => !value) }}>{currentTitle}</button>} />
    </nav>
  )
}

function TaskSkeleton() {
  const { t } = useUiPreferences()
  return <div className={css.skeleton} aria-label={t('正在加载任务', 'Loading tasks')}>
    <span /><span /><span />
  </div>
}

function LoadingConversation() {
  const { t } = useUiPreferences()
  return <div className={css.loadingState} role="status"><span className={css.spinner} />{t('正在载入任务', 'Loading task')}</div>
}

/** Initial-letter avatar for the local account row, standing in for DSH's account image. */
function accountInitial(name: string): string {
  const first = [...name.trim()][0]
  return first === undefined ? 'π' : first.toLocaleUpperCase()
}

/** The relative time DSH's rows read: "23 分钟前" rather than a bare cell label. */
function hoverTime(value: number, locale: 'zh' | 'en'): string {
  const { unit, n } = relativeTime(value, Date.now())
  switch (unit) {
    case 'now': return locale === 'zh' ? '刚刚' : 'just now'
    case 'minutes': return locale === 'zh' ? `${n} 分钟前` : `${n}m ago`
    case 'hours': return locale === 'zh' ? `${n} 小时前` : `${n}h ago`
    case 'days': return locale === 'zh' ? `${n} 天前` : `${n}d ago`
    case 'months': return locale === 'zh' ? `${n} 个月前` : `${n}mo ago`
    case 'years': return locale === 'zh' ? `${n} 年前` : `${n}y ago`
  }
}

/** Row equality that ignores array identity, so an unchanged poll keeps the previous state. */
function sameTaskRows(a: readonly TaskSummary[], b: readonly TaskSummary[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index]
    return other !== undefined && item.id === other.id && item.title === other.title && item.status === other.status
      && item.updatedAt === other.updatedAt && item.busy === other.busy && item.unread === other.unread
      && item.thinkingLevel === other.thinkingLevel && item.cwd === other.cwd && item.workspaceId === other.workspaceId
      && item.model?.provider === other.model?.provider && item.model?.modelId === other.model?.modelId
      && item.runStartedAt === other.runStartedAt && item.durationMs === other.durationMs
      && item.preview === other.preview && item.attention === other.attention && item.turns === other.turns
  })
}

/** The topbar and row wording for one task state. */
function taskStatusLabel(status: TaskStatus, t: (chinese: string, english: string) => string): string {
  switch (status) {
    case 'running': return t('运行中', 'Running')
    case 'waiting': return t('等待回答', 'Waiting for answer')
    case 'queued': return t('排队中', 'Queued')
    case 'completed': return t('已完成', 'Completed')
    case 'failed': return t('失败', 'Failed')
    case 'cancelled': return t('已停止', 'Stopped')
    case 'idle': return t('空闲', 'Idle')
  }
}

/**
 * The task row a live conversation projects, mirroring the server's `TaskSummary` projection field
 * for field. The list stays server-authored: this only refreshes a row that already exists.
 */
function taskFromDetail(detail: ConversationDetail): TaskSummary | null {
  const conversation = detail.conversation
  // A subagent is reached through its parent's catalog; it is never a task row.
  if (conversation.origin === 'subagent') return null
  const preview = latestAssistantPreview(detail)
  const attention = attentionOfDetail(detail)
  return {
    id: conversation.id,
    title: conversation.title,
    status: taskStatusOfDetail(detail),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.model === undefined ? {} : { model: conversation.model }),
    thinkingLevel: conversation.thinkingLevel,
    cwd: conversation.cwd,
    ...(conversation.workspaceId === undefined ? {} : { workspaceId: conversation.workspaceId }),
    busy: conversation.busy,
    ...(conversation.unread === true ? { unread: true } : {}),
    ...(conversation.runStartedAt === undefined ? {} : { runStartedAt: conversation.runStartedAt }),
    ...(conversation.durationMs === undefined ? {} : { durationMs: conversation.durationMs }),
    ...(preview === undefined ? {} : { preview }),
    ...(attention === undefined ? {} : { attention }),
    turns: detail.messages.filter(message => message.role === 'user').length,
  }
}

/** Same precedence as the server's `attentionOf`: the pending question, the failure reason, or the stop note. */
function attentionOfDetail(detail: ConversationDetail): string | undefined {
  const status = taskStatusOfDetail(detail)
  let text: string | undefined
  if (status === 'waiting') {
    const pending = detail.interactions?.find(item => item.status === 'pending')
    text = pending?.questions?.[0]?.question ?? pending?.detail ?? '等待回答'
  } else if (status === 'failed') {
    text = detail.error ?? '执行失败'
  } else if (status === 'cancelled') {
    text = '已停止'
  }
  if (text === undefined) return undefined
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed === '' ? undefined : collapsed.slice(0, 80)
}

/** Same precedence as the server's `taskStatusOf`: a pending question, then the live run, then the queue. */
function taskStatusOfDetail(detail: ConversationDetail): TaskStatus {
  if (detail.interactions?.some(item => item.status === 'pending') === true) return 'waiting'
  const conversation = detail.conversation
  if (conversation.busy) return 'running'
  if (detail.queue.length > 0) return 'queued'
  if (conversation.status === 'error') return 'failed'
  if (conversation.status === 'cancelled') return 'cancelled'
  if (conversation.status === 'completed') return 'completed'
  return 'idle'
}

/** The latest assistant text collapsed to one line, for the row's preview. */
function latestAssistantPreview(detail: ConversationDetail): string | undefined {
  for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
    const message = detail.messages[index]
    if (message?.role !== 'assistant') continue
    const text = message.blocks.filter(block => block.type === 'text').map(block => block.text).join(' ')
      .replace(/\s+/gu, ' ').trim()
    if (text !== '') return text.slice(0, 120)
  }
  return undefined
}

function isAcknowledged(detail: ConversationDetail, pendingItem: PendingSubmission): boolean {
  return detail.messages.some(message => message.requestId === pendingItem.requestId)
    || pendingItem.submissionId !== undefined && detail.queue.some(item => item.id === pendingItem.submissionId)
}

/**
 * Identity of one submission attempt: the target conversation, the exact text, and the attachment ids.
 * A retry that matches it is the same logical submission and keeps the requestId the server deduplicates on.
 */
function submissionFingerprint(conversationId: string, text: string, images: readonly DraftImage[]): string {
  return `${conversationId}\u0000${text}\u0000${images.map(image => image.id).join('\u0000')}`
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function loadDraft(scope: string): string {
  return readStorage(`${DRAFT_PREFIX}${scope}`) ?? ''
}

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key) }
  catch { return null }
}

function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) }
  catch { /* The in-memory draft remains available when browser storage is full or disabled. */ }
}

function removeStorage(key: string): void {
  try { window.localStorage.removeItem(key) }
  catch { /* The page can continue without browser storage. */ }
}

function setElementInert(element: HTMLElement, inert: boolean): void {
  if (inert) element.setAttribute('inert', '')
  else element.removeAttribute('inert')
}

function isImageType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLocaleLowerCase())
}

/** The attachment's image MIME type, read from the file name when the browser reports none. */
function imageFileType(file: File): string {
  const declared = file.type.toLocaleLowerCase()
  if (declared !== '') return isImageType(declared) ? declared : ''
  const extension = file.name.toLocaleLowerCase().split('.').pop() ?? ''
  return IMAGE_EXTENSIONS[extension] ?? ''
}

function fileData(file: File, t: (chinese: string, english: string) => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error(t('附件读取失败', 'Could not read attachment'))) }
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(t('附件数据不可读取', 'Attachment data is unavailable')))
        return
      }
      const comma = reader.result.indexOf(',')
      resolve(comma < 0 ? reader.result : reader.result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

const objectUrls = { current: new Set<string>() }
