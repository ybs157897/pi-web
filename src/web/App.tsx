import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, Inbox, Loader } from 'lucide-react'
import {
  Button, ConnectionIndicator, HoverCard, HoverCardGroup, IconArchiveOutlineRegular, IconBranchOutlineRegular,
  IconCheckOutlineRegular, IconChecklistOutlineRegular, IconChevronRightOutlineRegular, IconClockOutlineRegular, IconCopyOutlineRegular,
  IconDownloadOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFlatListOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconListPenOutlineRegular,
  IconNewChatOutlineRegular, IconPanelLeftOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular,
  IconSettingsOutlineRegular, IconSlidersTwoOutlineRegular, IconTrashOutlineRegular, IconUnarchiveOutlineRegular,
  IconWorkspaceTreeOutlineRegular, Input, Menu, Modal, ShortcutKeys, Tag, Toast, Tooltip, focusWithoutRing, relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccessMode, AppSettings, ConversationDetail, ConversationSummary, ModelCatalog,
  ModelOption, ProviderInput, SubagentSummary, ThinkingLevel, WorkspaceFileEntry, WorkspaceSummary,
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
import { conversationStats, visibleTranscriptMessages } from './render-model.ts'
import { latestPlan, sessionPlans, type PlanDocument } from './plan-preview.ts'
import DirectoryBrowser from './DirectoryBrowser.tsx'
import Inspector from './Inspector.tsx'
import { PluginPageHostContext } from './plugin-page-pool.tsx'
import type { InspectorDiff, InspectorFile } from './Inspector.tsx'
import { activateTab, closeAllTabs, closeOtherTabs, closeTabs, nextSelectionChatOrdinal, normalizePaneState,
  openFromLauncher, readPaneMemory, stripConversationScoped, upsertTab, writePaneMemory,
  type InspectorTab, type PaneState } from './inspector-tabs.ts'
import { INSPECTOR_DIVIDER_WIDTH, inspectorLayout } from './inspector-layout.ts'
import type { GitChangeSourceId, LastTurnChange } from './GitPane.tsx'
import { collectChangeFiles } from './ChangedFiles.tsx'
import SelectionAskPopover from './SelectionAskPopover.tsx'
import { useSideConversation } from './use-side-conversation.ts'
import type { SideChatMessage } from './SelectionChatPane.tsx'
import { buildSideChatPrompt } from './selection-quote.ts'
import WorkspaceDialog from './WorkspaceDialog.tsx'
import WorkspaceRenameDialog from './WorkspaceRenameDialog.tsx'
import AutomationsPage from './AutomationsPage.tsx'
/** antd 仅本页面需要，首次访问时按独立 chunk 懒加载。 */
const WetrackPage = lazy(() => import('./WetrackPage.tsx'))
const InboxPage = lazy(() => import('./InboxPage.tsx'))
import { matchesShortcut, resolveShortcuts, shortcutKeyLabels, type ShortcutCommand } from './keyboard.ts'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider, useUiPreferences } from './ui-preferences.tsx'
import css from './App.module.css'

type ConnectionState = 'connecting' | 'disconnected' | 'recovered' | undefined
type MainPage = 'chat' | 'defects' | 'inbox' | 'automations'
type WorkspaceSort = 'recent' | 'name'
interface ScopedDraft { scope: string; text: string }
/** 限额视角下的一个附件：是否图片 + 字节大小。 */
interface AttachmentSize { image: boolean; size: number }
type AttachmentLimit = 'images' | 'files' | 'empty' | 'imageBytes' | 'fileBytes' | 'total'
interface PendingSubmission extends PendingMessage { conversationId: string }
interface ToastMessage { id: number; text: string; success?: boolean }
/** 最近一次失败的提交记录；对相同内容的重试复用其 requestId。 */
interface FailedSubmission { requestId: string; fingerprint: string }

/** localStorage 中记录上次选中会话的键。 */
const SELECTED_KEY = 'pi-durable-web:selected-conversation'
/** 各会话输入草稿在 localStorage 中的键前缀。 */
const DRAFT_PREFIX = 'pi-durable-web:draft:'
/** 受支持的图片附件 MIME 类型集合。 */
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
/** 拖放的文件可能没有 MIME 类型，此时以扩展名代替判断。 */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
}
/** 无附件的草稿作用域共享此空数组，保证 composer prop 身份稳定。 */
const NO_IMAGES: readonly DraftImage[] = []
/** 无插件上下文的作用域共享此空数组，理由同上。 */
const NO_PLUGIN_CONTEXTS: readonly PluginContextEntry[] = []
/** 附件限额：单条消息图片数、文件数、单图/单文件与总大小上限。 */
const MAX_IMAGE_COUNT = 4
const MAX_FILE_COUNT = 8
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** 思考档位的全局递进顺序（clampThinkingLevel 的折算依据）。 */
const THINKING_ORDER: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 折算运行时会真正存储的思考等级：先向上找最近的支持档位，再向下回退。
 * @param level 请求的档位；supported 运行时支持的档位列表。
 * @returns 支持的档位；无列表或请求档位不受支持时按 THINKING_ORDER 就近折算。
 */
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
 * 计算本批附件最先触犯的限额，全部合规时返回 null。
 * 仍在读取中的批次也计入批次，因此同一 tick 内排队的两次添加不会
 * 针对同一份过期快照通过两次检查。
 * 导出以便脱离浏览器验证限额逻辑。
 * @param committed 已入库的附件；reading 读取中的批次；selected 新选中的批次。
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

/** 某一附件限额被触犯时的本地化提示文案。 */
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

/**
 * 功能：应用入口——先加载共享 UI 偏好（主题/语言/字号等），就绪后渲染完整
 * 的应用外壳 AppShell，未就绪时显示加载页。
 * @param props 无 props。
 * 内部逻辑：挂载时经 api.getSettings 拉取设置（active 标记防卸载后 setState）；
 * updateSettings 调 api.updateSettings 保存并以 ApiFailure 抛出失败；
 * 包一层 UiPreferencesProvider 让全局读取偏好。
 */
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

/**
 * 功能：应用外壳——左侧工作区/会话侧栏（搜索、排序、归档、置顶、重命名、分叉、
 * 下载日志），中间会话流 + Composer + Todo/目标/交互卡，右侧 Inspector 面板；
 * 并承载问题清单、收件箱和自动化任务页面、
 * 设置对话框、工作区增删改对话框与全局 Toast/快捷键。
 * @param props settings 已加载的 UI 设置；settingsError 设置读取错误；onSettingsChange 保存补丁回调。
 * 内部逻辑：会话列表/目录/工作区/能力各自独立拉取与轮询（SSE watch 驱动会话详情）；
 * 草稿/附件/插件上下文按会话作用域（scope）隔离存储；Inspector 标签按工作区记忆
 * （pane 桶），插件页宿主由会话流卡片移交；发送流程含乐观条目、附件限额、
 * 失败重试指纹与排队/插入两种繁忙模式；选择引文经 buildSideChatPrompt 走侧聊。
 */
function AppShell({ settings, settingsError, onSettingsChange }: {
  settings: AppSettings
  settingsError: string
  onSettingsChange: (patch: UpdateAppSettingsInput) => Promise<AppSettings>
}) {
  const { t } = useUiPreferences()
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
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
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [workspaceSort, setWorkspaceSort] = useState<WorkspaceSort>('recent')
  const [showArchived, setShowArchived] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [rowMenuId, setRowMenuId] = useState<string | null>(null)
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'models'>('general')
  const [savingProvider, setSavingProvider] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [page, setPage] = useState<MainPage>('chat')
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set())
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [deleteWorkspace, setDeleteWorkspace] = useState<WorkspaceSummary | undefined>(undefined)
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false)
  const [renameWorkspace, setRenameWorkspace] = useState<WorkspaceSummary | null>(null)
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
  const [preferredInspectorWidth, setPreferredInspectorWidth] = useState<number>()
  const [mainBodyWidth, setMainBodyWidth] = useState(0)
  const [inspectorDragging, setInspectorDragging] = useState(false)
  const [inspectorLoading, setInspectorLoading] = useState(false)
  const [inspectorError, setInspectorError] = useState('')
  /** Plugin pages the inspector keeps mounted, one per plugin call site. The tab itself lives in `pane`. */
  const [pluginPages, setPluginPages] = useState<PluginUiPage[]>([])
  /** Inline cards hand their page host to the inspector here, so the side pane moves the iframe. */
  const [pluginPageHosts, setPluginPageHosts] = useState<Record<string, HTMLElement>>({})
  /** `ui/update-model-context` chips, scoped like drafts so switching sessions keeps each one. */
  const [pluginContextsByScope, setPluginContextsByScope] = useState<Record<string, PluginContextEntry[]>>({})
  const [pluginSurfaces, setPluginSurfaces] = useState<PluginUiSurfaceView[]>([])
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
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
  // 附件按会话作用域存放，切换会话不会丢掉已添加的附件。
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
  const mainBodyRef = useRef<HTMLDivElement | null>(null)
  const primaryPanelRef = useRef<HTMLDivElement | null>(null)
  const inspectorPanelRef = useRef<HTMLElement | null>(null)
  const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null)
  const workspaceSearchRef = useRef<HTMLInputElement | null>(null)
  /** Real row rects keep a workspace menu anchored when its ellipsis hides on hover-out. */
  const workspaceRowRefs = useRef(new Map<string, HTMLDivElement>())
  const messagesViewport = useRef<HTMLDivElement | null>(null)
  /** Hosts the transcript selection popover's anchor area. */
  const selectionHostRef = useRef<HTMLDivElement | null>(null)
  const inspectorRequestId = useRef(0)
  const inspectorResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  /** DSH's `markOpened` (`PlanCard.tsx:72-80`): the one conversation whose plan already opened by itself. */
  const planAutoOpenedFor = useRef<string | null>(null)
  const wasAtBottom = useRef(true)
  const submitLock = useRef(false)
  const detailRef = useRef<ConversationDetail | null>(null)
  const initialListLoad = useRef(true)
  const blankIntent = useRef(false)
  const pendingWorkspaceId = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  selectedIdRef.current = selectedId
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
  /** 同步会话视口的滚动位置记录（用于判断是否贴底）。 */
  const syncViewportScroll = useCallback((element: HTMLDivElement): void => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    wasAtBottom.current = distance < 88
    setJumpToBottomVisible(distance > 48)
  }, [])
  /** 把会话视口滚动到底部并更新贴底标记。 */
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
  const selectedSummary = conversations.find(item => item.id === selectedId)
  const conversationReady = detail?.conversation.id === selectedId
  const activeConversation = conversationReady ? detail : null
  const requestedModel = activeConversation?.conversation.model ?? newModel ?? settings.defaultModel
  const requestedModelOption = requestedModel === undefined ? undefined
    : catalog?.models.find(model => model.provider === requestedModel.provider && model.modelId === requestedModel.modelId
      && (activeConversation !== null || model.available))
  // 新会话绝不能展示过期的默认模型：服务端目录已对照实时目录解析过，
  // 当存储/默认引用缺失或不可选时以目录结果为准。
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
  /** 提交一次 Inspector 标签状态变更：更新 React 状态并写入工作区记忆桶。 */
  const commitPane = useCallback((next: PaneState): void => {
    paneRef.current = next
    setPaneState(next)
    const workspaceId = currentWorkspaceIdRef.current
    if (workspaceId !== undefined) writePaneMemory(workspaceId, next)
  }, [])
  const cancelInspectorFileRead = useCallback((): void => {
    inspectorRequestId.current += 1
    setInspectorLoading(false)
    setInspectorError('')
  }, [])
  /** Open one tab (ZCode's open semantics: an active launcher tab is consumed in place). */
  /** 在 Inspector 打开一个标签（已存在则激活），并展开面板。 */
  const openPaneTab = useCallback((tab: InspectorTab): void => {
    cancelInspectorFileRead()
    commitPane(openFromLauncher(paneRef.current, tab))
    setInspectorOpen(true)
  }, [cancelInspectorFileRead, commitPane])
  /** Close tabs; an emptied pane collapses, like ZCode's commitSidePaneState. */
  /** 关闭指定标签；关闭当前激活标签时自动落到最后一个剩余标签。 */
  const closePaneTabs = useCallback((ids: readonly string[]): void => {
    cancelInspectorFileRead()
    const { state } = closeTabs(paneRef.current, ids)
    commitPane(state)
    if (state.tabs.length === 0) {
      setInspectorOpen(false)
      setInspectorFullView(false)
    }
  }, [cancelInspectorFileRead, commitPane])
  /** 关闭除指定标签外的全部标签。 */
  const closeOtherPaneTabs = useCallback((id: string): void => {
    cancelInspectorFileRead()
    commitPane(closeOtherTabs(paneRef.current, id))
  }, [cancelInspectorFileRead, commitPane])
  /** 关闭全部标签并收起面板。 */
  const closeAllPaneTabs = useCallback((): void => {
    cancelInspectorFileRead()
    commitPane(closeAllTabs(paneRef.current))
    setInspectorOpen(false)
    setInspectorFullView(false)
  }, [cancelInspectorFileRead, commitPane])
  /** 激活指定标签并展开面板。 */
  const selectPaneTab = useCallback((id: string): void => {
    cancelInspectorFileRead()
    commitPane(activateTab(paneRef.current, id))
  }, [cancelInspectorFileRead, commitPane])
  // 切换到某个工作区时先展开一次；之后其自身的箭头可以收起它，
  // 包括它仍是选中/当前工作区的情况。
  useLayoutEffect(() => {
    if (currentWorkspaceId === undefined) return
    setExpandedWorkspaces(current => {
      if (current.has(currentWorkspaceId)) return current
      const next = new Set(current)
      next.add(currentWorkspaceId)
      return next
    })
  }, [currentWorkspaceId])
  const accessMode = activeConversation?.conversation.accessMode ?? newAccessMode ?? settings.defaultAccessMode
  const selectedPending = pending.filter(item => item.conversationId === selectedId)

  /** 弹出全局 Toast 提示（success 标记成功态）。 */
  const announce = useCallback((text: string, success = false): void => {
    toastSequence.current += 1
    setToast({ id: toastSequence.current, text, success })
  }, [])

  /** 用最新数据更新侧栏会话摘要；子智能体会话不进侧栏，仅更新详情。 */
  const updateConversation = useCallback((value: ConversationDetail | ConversationSummary): void => {
    const summary = 'conversation' in value ? value.conversation : value
    // 子智能体会话经其父会话的目录进入，因此从不进入侧栏列表。
    if (summary.origin !== 'subagent') {
      setConversations(existing => [summary, ...existing.filter(item => item.id !== summary.id)]
        .sort(compareConversations))
    }
    if ('conversation' in value) setDetail(current => current?.conversation.id === summary.id ? value : current)
  }, [])

  /** 拉取会话列表并复位列表错误/加载态。 */
  const refreshList = useCallback(async (): Promise<void> => {
    try {
      const items = await api.listConversations()
      setConversations(items.sort(compareConversations))
      setListError('')
      const firstLoad = initialListLoad.current
      initialListLoad.current = false
      if (firstLoad && selectedIdRef.current === null && !blankIntent.current) {
        const stored = readStorage(SELECTED_KEY)
        const next = items.find(item => item.id === stored && !item.archived)
          ?? items.find(item => !item.archived)
        if (next !== undefined) setSelectedId(next.id)
      }
    } catch (cause) {
      setListError(errorText(cause, t('无法读取会话列表', 'Could not load conversations')))
    } finally {
      setListLoading(false)
    }
  }, [t])

  /** 拉取模型目录并复位目录错误态。 */
  const refreshCatalog = useCallback(async (): Promise<void> => {
    try {
      const value = await api.getModels()
      setCatalog(value)
      setCatalogError('')
    } catch (cause) {
      setCatalogError(errorText(cause, t('无法读取模型列表', 'Could not load models')))
    }
  }, [t])

  /** 拉取工作区列表并复位加载/错误态。 */
  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    setWorkspaceLoading(true)
    try {
      const result = await api.listWorkspaces()
      setWorkspaces(result.workspaces)
      setWorkspaceLoadError('')
    } catch (cause) { setWorkspaceLoadError(errorText(cause, t('无法读取工作区', 'Could not load workspaces'))) }
    finally { setWorkspaceLoading(false) }
  }, [t])

  /** 拉取服务端能力（版本/账号/可选权限模式）。 */
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
    void refreshList()
    void refreshCatalog()
    void refreshWorkspaces()
    void refreshCapabilities()
    api.health().then(value => { setAppVersion(value.version); setAccountName(value.user) }).catch(() => undefined)
  }, [refreshCapabilities, refreshCatalog, refreshList, refreshWorkspaces])

  // 运行可能在不被本标签流式订阅的会话里结束，因此未读圆点只在读者回到窗口时
  // 刷新。每次返回读一次列表，绝不轮询。
  useEffect(() => {
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void refreshList()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    window.addEventListener('focus', refreshWhenVisible)
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.removeEventListener('focus', refreshWhenVisible)
    }
  }, [refreshList])

  // DSH 在宿主上报设置或适配器变化时重读模型目录。服务端对本地保存、
  // 其他实例的写入以及手工编辑的供应商文件推送同一信号。
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
    // 每工作区的「新建会话」动作会带着它的选择跨越这次重置。
    setNewWorkspaceId(pendingWorkspaceId.current ?? preferences.defaultWorkspaceId)
    pendingWorkspaceId.current = null
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
      updateConversation(value)
    }).catch(cause => {
      if (active) setDetailError(errorText(cause, translateRef.current('无法打开此会话', 'Could not open this conversation')))
    }).finally(() => {
      if (active) setDetailLoading(false)
    })
    return () => { active = false }
  }, [selectedId, updateConversation])

  useEffect(() => {
    if (selectedId === null) {
      removeStorage(SELECTED_KEY)
      return
    }
    writeStorage(SELECTED_KEY, selectedId)
  }, [selectedId])

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
      updateConversation(value)
      setPending(existing => existing.filter(item => item.conversationId !== selectedId || !isAcknowledged(value, item)))
      if (follow && viewport !== null) requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight })
    }, state => {
      if (!live) return
      // `open` 也会在普通连接（切换会话、重连令牌更新）时触发，因此只有真正掉线的流
      // 才能上报「已恢复」——否则每次发送都会闪现「连接已恢复」。
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
  }, [conversationReady, reconnectToken, selectedId, updateConversation])

  useEffect(() => {
    if (connection !== 'recovered') return
    const timer = window.setTimeout(() => { setConnection(undefined) }, 2200)
    return () => { window.clearTimeout(timer) }
  }, [connection])

  useEffect(() => {
    const keep = new Set<string>()
    for (const items of Object.values(imageStore)) for (const image of items) keep.add(image.preview)
    for (const item of pending) for (const image of item.images) keep.add(image.preview)
    // 从 composer 移除的草稿预览立即释放——包括仍在读取中的附件（它们和其他条目一样
    // 已入库）——已接受的预览存活到 SSE 回声确认，停在另一个作用域的预览存活到再次打开它。
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

  /** 选中某个会话：清空待发送乐观条目并切换 selectedId。 */
  const selectConversation = useCallback((id: string): void => {
    blankIntent.current = false
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

  /** 创建新会话：写标题，刷新列表并返回会话详情。 */
  const createConversation = useCallback(async (title = t('新对话', 'New conversation')): Promise<ConversationDetail> => {
    blankIntent.current = false
    const model = selectedModel
    const preferences = settingsRef.current
    const workspaceId = newWorkspaceId ?? preferences.defaultWorkspaceId ?? workspaces[0]?.id
    const created = await api.createConversation({
      title,
      ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
      thinkingLevel,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      accessMode: newAccessMode ?? preferences.defaultAccessMode,
    })
    // 计划模式按会话作用域生效，因此 hero 时刻的请求在会话创建后立即应用。
    const detail = newPlan ? await api.setPlan(created.conversation.id, true) : created
    setNewPlan(false)
    setConversations(existing => [detail.conversation, ...existing.filter(item => item.id !== detail.conversation.id)]
      .sort(compareConversations))
    setDetail(detail)
    detailRef.current = detail
    setSelectedId(detail.conversation.id)
    setPage('chat')
    setSidebarOpen(false)
    return detail
  }, [newAccessMode, newPlan, newWorkspaceId, selectedModel, thinkingLevel, t, workspaces])

  /** 写入当前作用域的输入草稿并持久化到 localStorage。 */
  const setDraft = useCallback((value: string): void => {
    setDraftState({ scope: activeScope, text: value })
  }, [activeScope])

  /**
   * `ui/update-model-context` writes one chip for the active scope. The same plugin call
   * overwrites its previous entry, which is the documented "keep the last one" rule.
   */
  /** 追加一条插件上下文芯片（按会话作用域存储）。 */
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

  /** 按 key 移除一条插件上下文芯片。 */
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
  /** 整体写入某作用域的附件列表（含对象 URL 管理）。 */
  const writeImages = useCallback((scope: string, items: DraftImage[]): void => {
    imageStoreRef.current = { ...imageStoreRef.current, [scope]: items }
    setImageStore(imageStoreRef.current)
  }, [])

  /** Patch one attachment in place; a read that finishes after the item was removed is a no-op. */
  /** 按 id 补丁更新某作用域内的单个附件。 */
  const patchImage = useCallback((scope: string, id: string, patch: (image: DraftImage) => DraftImage): void => {
    const current = imageStoreRef.current[scope]
    if (current === undefined || !current.some(image => image.id === id)) return
    writeImages(scope, current.map(image => image.id === id ? patch(image) : image))
  }, [writeImages])

  /** Read one accepted attachment and land the result on the entry that is already in the list. */
  /** 读取一个附件文件：图片走 base64，其他文件仅登记元信息。 */
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

  /** 添加附件批次：先做限额检查，再入列表并行读取。 */
  const addImages = useCallback((files: FileList | File[]): void => {
    const scope = activeScope
    const selected = Array.from(files).map(file => {
      const type = imageFileType(file)
      return { file, image: type !== '', mimeType: type === '' ? file.type || 'application/octet-stream' : type }
    })
    // 限额读取实时库存，其中已包含先前仍在读取中的批次，因此第一批未完成前排队的
    // 第二批不可能对同一份快照重复通过检查。
    const committed = imageStoreRef.current[scope] ?? []
    const limit = attachmentLimitError(committed, [], selected.map(item => ({ image: item.image, size: item.file.size })))
    if (limit !== null) {
      announce(attachmentLimitText(limit, t))
      return
    }
    // 批次在读取前就进入列表：composer 立即展示它，读取失败只标记自己的条目，
    // 不会丢掉整批。
    const batch: DraftImage[] = selected.map(item => ({
      id: crypto.randomUUID(), file: item.file, preview: URL.createObjectURL(item.file),
      mimeType: item.mimeType, data: '', status: 'reading',
    }))
    for (const item of batch) objectUrls.current.add(item.preview)
    writeImages(scope, [...committed, ...batch])
    for (const item of batch) readAttachment(scope, item)
  }, [activeScope, announce, readAttachment, t, writeImages])

  /** Re-read one failed attachment, wherever the scope that owns it has moved on to. */
  /** 重试一个读取失败的附件。 */
  const retryImage = useCallback((id: string): void => {
    for (const [scope, items] of Object.entries(imageStoreRef.current)) {
      const item = items.find(image => image.id === id)
      if (item === undefined) continue
      patchImage(scope, id, image => ({ ...image, status: 'reading', error: undefined }))
      readAttachment(scope, item)
      return
    }
  }, [patchImage, readAttachment])

  /** 移除一个附件（同时释放其对象 URL）。 */
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

  /** 发送消息主流程：附件校验 → 目标会话（按需新建）→ 乐观条目 → api 调用 → 清理草稿与芯片。 */
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
    // `ui/update-model-context` 条目随消息一起发送，但待发送行、标题与重试指纹
    // 都继续读取操作者自己的文本。
    const contextBlock = pluginContextBlock(pluginContextsByScope[activeScope] ?? NO_PLUGIN_CONTEXTS)
    const submittedText = contextBlock === '' ? text : text === '' ? contextBlock : `${text}\n\n${contextBlock}`
    submitLock.current = true
    setSending(true)
    let targetId = selectedId
    let target = detail?.conversation.id === selectedId ? detail : null
    // requestId 只有在目标会话存在后才知道（见下）；此后由乐观条目携带它。
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
    try {
      if (targetId === null) {
        const title = text.trim().split(/\r?\n/u)[0]?.slice(0, 44) || t('文件对话', 'File conversation')
        target = await createConversation(title)
        targetId = target.conversation.id
        setDraftState({ scope: targetId, text: '' })
        writeImages(targetId, [])
        setPending(existing => existing.map(item => item.id === pendingId ? { ...item, conversationId: targetId as string } : item))
      }
      if (targetId === null) throw new Error(t('未能创建会话', 'Could not create conversation'))
      // 重试内容完全相同的失败提交会复用其 requestId：即使只是响应丢失，服务端已接受的
      // 消息也不会被发送两次。内容有任何变化都会获得新 id。
      const fingerprint = submissionFingerprint(targetId, text, ready)
      const remembered = lastFailedSubmit.current
      const requestId = remembered !== null && remembered.fingerprint === fingerprint ? remembered.requestId : crypto.randomUUID()
      lastFailedSubmit.current = { requestId, fingerprint }
      setPending(existing => existing.map(item => item.id === pendingId ? { ...item, requestId } : item))
      const imageAttachments = ready.filter(item => isImageType(item.mimeType))
      const fileAttachments = ready.filter(item => !isImageType(item.mimeType))
      const result = await api.submit(targetId, {
        text: submittedText,
        requestId,
        ...(target?.conversation.busy ? { whenBusy: requestedMode ?? sendMode } : {}),
        ...(imageAttachments.length === 0 ? {} : { images: imageAttachments.map(image => ({ data: image.data, mimeType: image.mimeType })) }),
        ...(fileAttachments.length === 0 ? {} : { files: fileAttachments.map(file => ({ name: file.file.name, mimeType: file.mimeType, data: file.data })) }),
      })
      lastFailedSubmit.current = null
      // 服务端已接受消息，因此该作用域的上下文芯片随之消耗。请求在途期间又新增
      // 条目的作用域同样不会残留过期内容。
      setPluginContextsByScope(current => {
        if (current[activeScope] === undefined) return current
        const next = { ...current }
        delete next[activeScope]
        return next
      })
      const accepted: PendingSubmission = {
        ...firstPending,
        requestId,
        conversationId: targetId,
        submissionId: result.submissionId,
        status: 'accepted',
      }
      const latest = detailRef.current
      const alreadyVisible = latest?.conversation.id === targetId && isAcknowledged(latest, accepted)
      setPending(existing => alreadyVisible
        ? existing.filter(item => item.id !== pendingId)
        : existing.map(item => item.id === pendingId ? accepted : item))
      wasAtBottom.current = true
      setJumpToBottomVisible(false)
      requestAnimationFrame(() => {
        const viewport = messagesViewport.current
        if (viewport !== null) viewport.scrollTop = viewport.scrollHeight
      })
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
  }, [activeScope, announce, createConversation, detail, draftState, pluginContextsByScope, selectedId, sendMode, t, writeImages])

  /** `ui/message` from a plugin page submits straight to the open conversation, leaving the draft alone. */
  /** 把插件页发来的消息作为用户消息发送到当前会话。 */
  const sendPluginMessage = useCallback(async (text: string): Promise<void> => {
    if (selectedId === null) {
      announce(t('请先开始一个会话', 'Start a conversation first'))
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
  /** 打开插件页面请求的外链：http(s) 在浏览器标签中打开。 */
  const openPluginLink = useCallback((url: string): void => {
    try {
      if (new URL(url).protocol !== 'https:') return
    } catch {
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  /** 停止当前会话正在进行的回答；队列非空时进入「队列已暂停」态（可从 composer 恢复）。 */
  const stop = useCallback(async (): Promise<void> => {
    if (selectedId === null) return
    const hasQueue = (detailRef.current?.queue?.length ?? 0) > 0
    try {
      await api.stop(selectedId)
      if (hasQueue) setQueuePausedMap(current => ({ ...current, [selectedId]: true }))
      announce(t('已停止运行', 'Stopped'), true)
    } catch (cause) { announce(errorText(cause, t('停止失败', 'Could not stop'))) }
  }, [announce, selectedId, t])

  /** 目标栏动作：暂停/恢复/编辑/清除，经 api 更新会话目标。 */
  const updateGoal = useCallback(async (action: 'pause' | 'resume' | 'edit' | 'clear', payload?: { objective?: string }): Promise<void> => {
    if (selectedId === null) return
    try {
      const next = await api.updateGoal(selectedId, { action, ...(payload?.objective === undefined ? {} : { objective: payload.objective }) })
      setDetail(next)
      announce(t('目标已更新', 'Goal updated'), true)
    } catch (cause) { announce(errorText(cause, t('无法更新目标', 'Could not update the goal'))) }
  }, [announce, selectedId, t])

  /** 触发当前会话的上下文压缩。 */
  const compact = useCallback(async (): Promise<void> => {
    if (selectedId === null) return
    if (detailRef.current?.compaction?.running === true) return
    try {
      await api.compact(selectedId)
    } catch (cause) { announce(errorText(cause, t('无法压缩上下文', 'Could not compact the context'))) }
  }, [announce, selectedId, t])

  /** 进入或退出计划模式；会话未创建时记住意图，创建后应用。 */
  const setPlan = useCallback(async (active: boolean): Promise<void> => {
    if (selectedId === null || !conversationReady) {
      setNewPlan(active)
      announce(active
        ? t('新会话将以计划模式开始：先出计划，批准后再执行', 'The new conversation will start in plan mode')
        : t('已取消计划模式', 'Plan mode cancelled'), true)
      return
    }
    try {
      const value = await api.setPlan(selectedId, active)
      detailRef.current = value
      setDetail(value)
      updateConversation(value)
      announce(active
        ? t('已进入计划模式：先出计划，批准后再执行', 'Plan mode on: plan first, execute after approval')
        : t('已退出计划模式', 'Plan mode off'), true)
    } catch (cause) { announce(errorText(cause, t('无法切换计划模式', 'Could not switch plan mode'))) }
  }, [announce, conversationReady, selectedId, t, updateConversation])

  /** Hand focus back to the composer, which is what dismissing the plan review does. */
  /** 把输入焦点交回 composer 文本框。 */
  const focusComposer = useCallback((): void => {
    document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()
  }, [])

  /** 移除一条排队中的消息。 */
  const removeQueue = useCallback(async (submissionId: string): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.removeQueued(selectedId, submissionId)
      setPending(existing => existing.filter(item => item.submissionId !== submissionId))
    } catch (cause) { announce(errorText(cause, t('无法撤回这条排队消息', 'Could not withdraw this queued message'))) }
  }, [announce, selectedId, t])

  /** 各会话的「队列已暂停」标记：停止响应时若队列非空则置位，点「继续」或会话恢复运行后清除。 */
  const [queuePausedMap, setQueuePausedMap] = useState<Record<string, boolean>>({})
  /**
   * 恢复被停止暂停的队列。内核 scheduler 在任何提交后都会按 FIFO 落位队列头部，因此
   * 必须替换「最后一条」来激活：撤回它触发的落位是头部第一条（顺序正确），重投的原
   * 最后一条排回队尾，全局顺序不变；替换第一条则会在撤回窗口让第二条抢先落位。
   * 乐观清除暂停标记，失败则回滚并提示。
   */
  const resumeQueue = useCallback(async (): Promise<void> => {
    if (selectedId === null) return
    const queue = detailRef.current?.queue ?? []
    const last = queue[queue.length - 1]
    setQueuePausedMap(current => ({ ...current, [selectedId]: false }))
    if (last === undefined) return
    try {
      await api.updateQueued(selectedId, last.id, { text: last.text, requestId: crypto.randomUUID(), whenBusy: last.mode })
    } catch (cause) {
      setQueuePausedMap(current => ({ ...current, [selectedId]: true }))
      announce(errorText(cause, t('无法恢复队列，请重试', 'Could not resume the queue. Try again.')))
    }
  }, [announce, selectedId, t])

  /**
   * Remember the model/level the operator last chose so the next new
   * conversation (or a newly opened browser window) starts there. The default
   * model is also the settings fallback, so this is the same global value.
   */
  /** 记住最近一次手动选择的模型/思考等级（按会话持久化）。 */
  const rememberModelSelection = useCallback((level: ThinkingLevel, model?: { provider: string; modelId: string }): void => {
    const patch: UpdateAppSettingsInput = {
      defaultThinkingLevel: level,
      ...(model === undefined ? {} : { defaultModel: { ...model } }),
    }
    void onSettingsChange(patch).catch(cause => {
      announce(errorText(cause, t('无法记住模型选择', 'Could not remember the model selection')))
    })
  }, [announce, onSettingsChange, t])

  /** 切换当前会话的模型；不支持的思考等级折算到最近可用档位。 */
  const chooseModel = useCallback(async (model: ModelOption): Promise<void> => {
    const selection = { provider: model.provider, modelId: model.modelId }
    const requested = model.reasoning ? activeConversation?.conversation.thinkingLevel ?? newThinking : 'off'
    // 切换到不提供当前档位的模型时，存储其提供的最近档位——与运行时折算的值一致。
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
      updateConversation(value)
      rememberModelSelection(level, selection)
    } catch (cause) { announce(errorText(cause, t('切换模型失败', 'Could not change model'))) }
  }, [activeConversation, announce, conversationReady, newThinking, rememberModelSelection, selectedId, t, updateConversation])

  /** 切换当前会话的思考等级（按模型支持列表折算）。 */
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
      updateConversation(value)
      rememberModelSelection(level, selectedModel)
    } catch (cause) { announce(errorText(cause, t('更改思考等级失败', 'Could not change reasoning level'))) }
  }, [announce, conversationReady, rememberModelSelection, selectedId, selectedModel, t, updateConversation])

  /** 更新会话属性（重命名/归档/置顶等）并同步侧栏。 */
  const patchConversation = useCallback(async (id: string, patch: {
    title?: string; pinned?: boolean; archived?: boolean;
  }): Promise<void> => {
    try {
      const updated = await api.updateConversation(id, patch)
      updateConversation(updated)
      announce(patch.title === undefined ? t('会话已更新', 'Conversation updated') : t('会话标题已保存', 'Title saved'), true)
      if (patch.archived !== undefined && patch.archived !== showArchived && id === selectedId) {
        blankIntent.current = true
        setSelectedId(null)
        setDetail(null)
        detailRef.current = null
      }
    } catch (cause) { announce(errorText(cause, t('会话更新失败', 'Could not update conversation'))) }
  }, [announce, selectedId, showArchived, t, updateConversation])

  /** 从某条消息分叉出新会话并跳转。 */
  const forkFrom = useCallback(async (entryId: string): Promise<void> => {
    if (selectedId === null) return
    try {
      const forked = await api.fork(selectedId, entryId)
      setConversations(existing => [forked.conversation, ...existing.filter(item => item.id !== forked.conversation.id)]
        .sort(compareConversations))
      setDetail(forked)
      detailRef.current = forked
      setSelectedId(forked.conversation.id)
      announce(t('已从此处创建分支会话', 'Forked from this message'), true)
    } catch (cause) { announce(errorText(cause, t('创建分支失败', 'Could not fork conversation'))) }
  }, [announce, selectedId, t])

  /** 保存模型供应商配置并刷新目录（设置对话框用）。 */
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

  /** 切换当前工作区（经 api 绑定），成功后刷新列表。 */
  const selectWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (conversationReady && selectedId !== null) {
      try {
        const value = await api.updateConversation(selectedId, { workspaceId })
        setDetail(value)
        detailRef.current = value
        updateConversation(value)
        announce(t('会话工作区已更新', 'Conversation workspace updated'), true)
      } catch (cause) { announce(errorText(cause, t('无法切换会话工作区', 'Could not change the conversation workspace'))) }
      return
    }
    setNewWorkspaceId(workspaceId)
    try { await onSettingsChange({ defaultWorkspaceId: workspaceId }) }
    catch (cause) { announce(errorText(cause, t('无法保存默认工作区', 'Could not save the default workspace'))) }
  }, [announce, conversationReady, onSettingsChange, selectedId, t, updateConversation])

  /** 切换当前会话的权限模式。 */
  const selectAccessMode = useCallback(async (mode: AccessMode): Promise<void> => {
    if (conversationReady && selectedId !== null) {
      try {
        const value = await api.updateConversation(selectedId, { accessMode: mode })
        setDetail(value)
        detailRef.current = value
        updateConversation(value)
      } catch (cause) { announce(errorText(cause, t('无法更改访问级别', 'Could not change access mode'))) }
      return
    }
    setNewAccessMode(mode)
    try { await onSettingsChange({ defaultAccessMode: mode }) }
    catch (cause) { announce(errorText(cause, t('无法保存默认访问级别', 'Could not save the default access mode'))) }
  }, [announce, conversationReady, onSettingsChange, selectedId, t, updateConversation])

  /** 注册一个本地目录为新工作区并刷新列表。 */
  const addWorkspace = useCallback(async (input: { path: string; name?: string }): Promise<WorkspaceSummary> => {
    const result = await api.createWorkspace(input)
    setWorkspaces(current => [result.workspace, ...current.filter(workspace => workspace.id !== result.workspace.id)])
    setWorkspaceLoadError('')
    announce(t('工作区已添加', 'Workspace added'), true)
    return result.workspace
  }, [announce, t])

  /** 保存工作区显示名称。 */
  const saveWorkspaceName = useCallback(async (workspace: WorkspaceSummary, name: string): Promise<void> => {
    try {
      const result = await api.renameWorkspace(workspace.id, { name })
      setWorkspaces(current => current.map(item => item.id === workspace.id ? result.workspace : item))
      announce(t('工作区名称已更新', 'Workspace name updated'), true)
    } catch (cause) { announce(errorText(cause, t('无法重命名工作区', 'Could not rename workspace'))) }
  }, [announce, t])

  /** 切换主页面并收起移动端导航。 */
  const navigate = useCallback((next: MainPage): void => {
    setPage(next)
    setSidebarOpen(false)
    if (mobile) requestAnimationFrame(() => { if (mainPanelRef.current !== null) focusWithoutRing(mainPanelRef.current) })
  }, [mobile])

  /** 打开某个会话（供子页面回跳）。 */
  const openConversation = useCallback(async (id: string): Promise<void> => {
    setPage('chat')
    setSidebarOpen(false)
    if (!conversations.some(item => item.id === id)) await refreshList()
    setSelectedId(id)
  }, [conversations, refreshList])

  /** 在 Inspector 打开某工作区的文件浏览器标签。 */
  const openWorkspaceBrowser = useCallback((workspaceId: string, path = ''): void => {
    const workspace = workspaces.find(item => item.id === workspaceId)
    openPaneTab({ id: 'browse', type: 'browse', title: workspace?.name ?? t('文件', 'Files'), openedAt: Date.now(), workspaceId, path })
    setSidebarOpen(false)
  }, [openPaneTab, workspaces, t])

  /** 在 Inspector 打开工作区文件（加载内容与资源地址，支持定位行）。 */
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
      const file = await api.getWorkspaceFile(workspaceId, path, line)
      if (requestId !== inspectorRequestId.current) return
      if (file.kind === 'directory') {
        if (line !== undefined) throw new Error(t('目录没有可定位的行号', 'Directories do not have line numbers'))
        // 回答里的路径有时指向一个目录：直接在文件浏览器里列出它。
        openWorkspaceBrowser(workspaceId, file.path)
        return
      }
      const assetUrl = file.kind !== 'text' || file.textWindow !== undefined
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/asset?${new URLSearchParams({ path: file.path }).toString()}`
        : undefined
      const payload: InspectorFile = {
        path: file.path, content: file.content, textWindow: file.textWindow, mimeType: file.mimeType, size: file.size,
        workspaceId, line, lineRequestId: line === undefined ? undefined : requestId, url: assetUrl,
      }
      openPaneTab({
        id: `doc:file:${workspaceId}:${file.path}`,
        type: 'document',
        title: file.path.split(/[\\/]/u).pop() ?? file.path,
        openedAt: Date.now(),
        doc: { kind: 'file', file: payload },
      })
    } catch (cause) {
      if (requestId === inspectorRequestId.current) setInspectorError(errorText(cause, t('无法打开此文件', 'Could not open this file')))
    } finally { if (requestId === inspectorRequestId.current) setInspectorLoading(false) }
  }, [announce, currentWorkspaceId, openPaneTab, openWorkspaceBrowser, t])

  /** One diff document per workspace+path; repeated opens focus and refresh the same tab. */
  /** 在 Inspector 打开一个差异视图（数据已备好直接入标签）。 */
  const inspectDiff = useCallback((diff: InspectorDiff): void => {
    const workspaceId = currentWorkspaceIdRef.current
    openPaneTab({
      id: `doc:diff:${workspaceId ?? 'new'}:${diff.path}`,
      type: 'document',
      title: diff.path.split(/[\\/]/u).pop() ?? diff.path,
      openedAt: Date.now(),
      doc: { kind: 'diff', diff },
    })
  }, [openPaneTab])

  /** 「@」触发时搜索当前工作区文件，供 composer 建议面板。 */
  const searchWorkspaceFiles = useCallback(async (needle: string): Promise<WorkspaceFileEntry[]> => {    const workspaceId = currentWorkspaceId
    if (workspaceId === undefined) return []
    const result = await api.searchWorkspaceFiles(workspaceId, needle)
    return result.entries
  }, [currentWorkspaceId])

  /** `$` uses the same workspace catalog as Settings → Skills, so plugin skills are included. */
  /** 「$」触发时搜索可用技能（插件技能包含在内）。 */
  const searchSkills = useCallback(async (query: string) => {
    const workspaceId = currentWorkspaceId
    if (workspaceId === undefined) return []
    const catalog = await api.getSkills(workspaceId)
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return catalog.skills
    return catalog.skills.filter(skill =>
      `${skill.name} ${skill.description} ${skill.id}`.toLocaleLowerCase().includes(needle))
  }, [currentWorkspaceId])

  /** 提交某条回答的点赞/点踩反馈。 */
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
  /** 发送用户填写的产品反馈文本。 */
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

  /** 重试某条失败的工具/回答条目。 */
  const retryEntry = useCallback(async (entryId: string): Promise<void> => {
    if (selectedId === null) return
    try {
      const result = await api.retry(selectedId, { entryId, requestId: crypto.randomUUID() })
      await openConversation(result.conversationId)
    } catch (cause) { announce(errorText(cause, t('重新运行失败', 'Could not retry this response'))) }
  }, [announce, openConversation, selectedId, t])

  /** 更新排队消息（文本/模式/图片），供 composer 队列编辑。 */
  const updateQueue = useCallback(async (submissionId: string, input: Parameters<typeof api.updateQueued>[2]): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.updateQueued(selectedId, submissionId, input)
      announce(t('排队消息已更新', 'Queued message updated'), true)
    } catch (cause) { throw new ApiFailure(errorText(cause, t('无法更新排队消息', 'Could not update queued message')), cause instanceof ApiFailure ? cause.code : undefined) }
  }, [announce, selectedId, t])

  /** 复制会话 id 到剪贴板并提示。 */
  const copySessionId = useCallback(async (item: ConversationSummary): Promise<void> => {
    try {
      await navigator.clipboard.writeText(item.id)
      announce(t('Session ID 已复制', 'Session ID copied'), true)
    } catch (cause) { announce(errorText(cause, t('无法复制 Session ID', 'Could not copy the Session ID'))) }
  }, [announce, t])

  /** 从侧栏对会话执行分叉并跳转到新会话。 */
  const forkConversation = useCallback(async (item: ConversationSummary): Promise<void> => {
    try {
      const source = detailRef.current?.conversation.id === item.id ? detailRef.current : await api.getConversation(item.id)
      const entryId = [...source.messages].reverse().find(message => message.role === 'user' && message.entryId !== undefined)?.entryId
      if (entryId === undefined) {
        announce(t('此会话还没有可分叉的用户消息', 'This conversation has no user message to fork from'))
        return
      }
      const forked = await api.fork(item.id, entryId)
      setConversations(current => [forked.conversation, ...current.filter(row => row.id !== forked.conversation.id)].sort(compareConversations))
      detailRef.current = forked
      setDetail(forked)
      setSelectedId(forked.conversation.id)
      setPage('chat')
      setSidebarOpen(false)
      announce(t('已创建分支会话', 'Forked conversation created'), true)
    } catch (cause) { announce(errorText(cause, t('创建分支失败', 'Could not fork this conversation'))) }
  }, [announce, t])

  /** DSH's session-log export: one JSON object per line, taken from the durable conversation. */
  /** 下载会话日志（NDJSON），经临时锚点触发浏览器下载。 */
  const downloadSessionLog = useCallback(async (item?: ConversationSummary): Promise<void> => {
    const id = item?.id ?? selectedId
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
      // 锚点必须已在文档中，浏览器才会开始下载。
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 30_000)
      announce(t('Session 日志已下载', 'Session log downloaded'), true)
    } catch (cause) { announce(errorText(cause, t('无法下载 Session 日志', 'Could not download the session log'))) }
  }, [announce, selectedId, t])

  /** 打开添加工作区流程：有原生面板用路径，否则打开应用内目录浏览器。 */
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
      // 该宿主没有原生目录面板（目前是 Windows）：DSH 为这类宿主提供应用内
      // 浏览器，改为打开它而不是输入路径。
      if (message.includes('原生目录选择器')) { setDirectoryBrowserOpen(true); return }
      announce(errorText(cause, t('无法添加工作区', 'Could not add the workspace')))
    }
  }, [addWorkspace, announce, refreshWorkspaces, t])

  /** 确认删除工作区：服务端重绑其会话后刷新列表与工作区。 */
  const confirmDeleteWorkspace = useCallback(async (workspace: WorkspaceSummary): Promise<void> => {
    setDeleteWorkspace(undefined)
    try {
      await api.deleteWorkspace(workspace.id)
      announce(t(`已删除工作区 ${workspace.name}`, `Deleted workspace ${workspace.name}`), true)
      // 服务端已重新绑定该工作区的会话与默认工作区；两个视图都要重新加载。
      await refreshWorkspaces()
      await refreshList()
      if (browseTab?.workspaceId === workspace.id) {
        closePaneTabs(['browse'])
        setInspectorOpen(false)
      }
    } catch (cause) { announce(errorText(cause, t('无法删除工作区', 'Could not delete the workspace'))) }
  }, [announce, browseTab?.workspaceId, closePaneTabs, refreshList, refreshWorkspaces, t])

  /** 按搜索词过滤会话列表（标题/摘要）。 */
  const filteredConversations = useMemo(() => conversations
    .filter(item => settings.showAnalysisConversations || item.kind !== 'defectAnalysis')
    .filter(item => item.archived === showArchived)
    .filter(item => `${item.title}\n${item.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort(compareConversations), [conversations, query, settings.showAnalysisConversations, showArchived])
  /** 按最近使用或名称排序工作区。 */
  const sortedWorkspaces = useMemo(() => [...workspaces].sort((a, b) => workspaceSort === 'name'
    ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt), [workspaces, workspaceSort])
  const workspaceNeedle = query.trim().toLocaleLowerCase()
  const filteredWorkspaces = sortedWorkspaces.filter(workspace => workspaceNeedle === ''
    || `${workspace.name}\n${workspace.path}`.toLocaleLowerCase().includes(workspaceNeedle)
    || filteredConversations.some(item => item.workspaceId === workspace.id || item.workspaceId === undefined && item.cwd === workspace.path))
  /** 已知工作区 id 集合（判定记忆桶归属）。 */
  const knownWorkspaceIds = useMemo(() => new Set(workspaces.map(workspace => workspace.id)), [workspaces])
  const ungrouped = filteredConversations.filter(item => item.workspaceId === undefined || !knownWorkspaceIds.has(item.workspaceId))
  const busy = activeConversation?.conversation.busy === true
  const activeDetail = activeConversation
  const hasMessages = (activeDetail?.messages.length ?? 0) > 0 || selectedPending.length > 0
  const hero = page === 'chat' && !detailLoading && !detailError && !hasMessages
  const showConversationHeader = page === 'chat' && hasMessages
  // 收件箱占用整个主视图，返回会话时恢复原先的检查器。
  const showInspector = inspectorOpen && page !== 'inbox'
  const inspectorSizes = mobile ? null : inspectorLayout(mainBodyWidth, preferredInspectorWidth)
  const dockedInspector = showInspector && !inspectorFullView ? inspectorSizes : null
  const inspectorOverlay = showInspector && dockedInspector === null
  /** The latest submitted plan of the open conversation, shared by the inspector view and the auto open. */
  /** 当前会话最近一次提交的计划（供 Inspector 缺省展示）。 */
  const conversationPlan = useMemo(() => activeDetail === null
    ? undefined
    : latestPlan(activeDetail.interactions, activeDetail.messages), [activeDetail])
  /** Every plan in the transcript, newest first: the status card's plan directory. */
  /** 当前会话的全部已提交计划（最新在前）。 */
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
  // 会话重新进入运行（用户发消息或点了「继续」）即视为队列恢复流转，清掉暂停标记。
  useEffect(() => {
    if (!busy || selectedId === null) return
    setQueuePausedMap(current => (current[selectedId] === true ? { ...current, [selectedId]: false } : current))
  }, [busy, selectedId])

  const startRename = (item: ConversationSummary): void => {
    setEditingId(item.id)
    setEditTitle(item.title)
    setRowMenuId(null)
  }
  const saveRename = (id: string): void => {
    const title = editTitle.trim()
    if (title !== '') void patchConversation(id, { title })
    setEditingId(null)
  }
  /** 新建会话：保存当前面板草稿、复位作用域并回到聊天页 hero。 */
  const startNewConversation = useCallback((): void => {
    blankIntent.current = true
    setPage('chat')
    setSelectedId(null)
    setDetail(null)
    detailRef.current = null
    setNewModel(undefined)
    setNewThinking(settings.defaultThinkingLevel)
    setNewWorkspaceId(settings.defaultWorkspaceId)
    setNewAccessMode(settings.defaultAccessMode)
    // ZCode 的草稿作用域：会话自有标签页离开，工作区文档留在桶里，空草稿以面板收起起步。
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
    cancelInspectorFileRead()
    setSidebarOpen(false)
    if (mobile) requestAnimationFrame(() => { if (messagesViewport.current !== null) focusWithoutRing(messagesViewport.current) })
  }, [cancelInspectorFileRead, commitPane, mobile, settings.defaultAccessMode, settings.defaultThinkingLevel, settings.defaultWorkspaceId])

  /** The plugin creator is a new task with the bundled Skill already in the draft. */
  /** 以「插件创建技能」预载开启新会话。 */
  const startPluginCreation = useCallback((): void => {
    const text = '$plugin-creator '
    writeStorage(`${DRAFT_PREFIX}__new__`, text)
    startNewConversation()
    setSettingsOpen(false)
    setDraftState({ scope: '__new__', text })
    requestAnimationFrame(() => requestAnimationFrame(focusComposer))
  }, [focusComposer, startNewConversation])

  /** DSH's workspace row action: start a session that already belongs to that workspace. */
  /** 在指定工作区新建会话（侧栏工作区行的入口）。 */
  const startNewConversationIn = useCallback((workspaceId: string): void => {
    if (selectedId === null) { setNewWorkspaceId(workspaceId); return }
    pendingWorkspaceId.current = workspaceId
    startNewConversation()
  }, [selectedId, startNewConversation])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
      if (document.querySelector('[role="menu"], [role="dialog"]') !== null) return
      const shortcuts = resolveShortcuts(settings.shortcuts)
      if (matchesShortcut(event, shortcuts.newConversation)) {
        event.preventDefault()
        startNewConversation()
      } else if (matchesShortcut(event, shortcuts.search)) {
        event.preventDefault()
        setPage('chat')
        setSearchOpen(true)
        requestAnimationFrame(() => { if (workspaceSearchRef.current !== null) focusWithoutRing(workspaceSearchRef.current) })
      } else if (matchesShortcut(event, shortcuts.settings)) {
        event.preventDefault()
        setSettingsInitialTab('general')
        setSettingsOpen(true)
      } else if (matchesShortcut(event, shortcuts.toggleSidebar)) {
        event.preventDefault()
        if (mobile) setSidebarOpen(value => !value)
        else setSidebarCollapsed(value => !value)
      } else if (matchesShortcut(event, shortcuts.rename) || matchesShortcut(event, shortcuts.fork) || matchesShortcut(event, shortcuts.archive)) {
        if (page === 'inbox') return
        // DSH 把这些操作绑定到读者所在的会话行；pi-web 应用到当前打开的会话。
        const current = conversationsRef.current.find(item => item.id === selectedIdRef.current)
        if (current === undefined) return
        event.preventDefault()
        if (matchesShortcut(event, shortcuts.rename)) startRename(current)
        else if (matchesShortcut(event, shortcuts.fork)) void forkConversation(current)
        else void patchConversation(current.id, { archived: !current.archived })
      }
    }
    document.addEventListener('keydown', onShortcut, true)
    return () => { document.removeEventListener('keydown', onShortcut, true) }
  }, [mobile, page, settings.shortcuts, startNewConversation, startRename, forkConversation, patchConversation])

  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations

  const shortcutFor = (source: AppSettings, command: ShortcutCommand): { keys: readonly string[] } => {
    const chord = resolveShortcuts(source.shortcuts)[command]
    return { keys: shortcutKeyLabels(chord) }
  }

  const sessionMenuEntries = (item: ConversationSummary): MenuEntry[] => [
    { id: 'pin', label: item.pinned ? t('取消置顶', 'Unpin session') : t('置顶会话', 'Pin session'), icon: item.pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} /> },
    { id: 'rename', shortcut: shortcutFor(settings, 'rename'), label: t('重命名', 'Rename'), icon: <IconEditOutlineRegular size={14} /> },
    { id: 'fork', shortcut: shortcutFor(settings, 'fork'), label: t('分叉会话', 'Fork conversation'), icon: <IconBranchOutlineRegular size={14} /> },
    { id: 'copyId', label: t('复制 Session ID', 'Copy Session ID'), icon: <IconCopyOutlineRegular size={14} /> },
    { id: 'log', label: t('导出日志', 'Export log'), icon: <IconDownloadOutlineRegular size={14} /> },
    { id: 'archive', shortcut: shortcutFor(settings, 'archive'), label: item.archived ? t('取消归档', 'Unarchive session') : t('归档会话', 'Archive session'), icon: item.archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} /> },
  ]

  const renderSession = (item: ConversationSummary) => <SessionRow key={item.id} item={item} selected={page === 'chat' && item.id === selectedId}
    editing={editingId === item.id} editTitle={editTitle} menuOpen={rowMenuId === item.id}
    onSelect={() => { selectConversation(item.id) }} onEditTitle={setEditTitle}
    onSaveTitle={() => { saveRename(item.id) }} onCancelTitle={() => { setEditingId(null) }}
    onToggleMenu={() => { setRowMenuId(current => current === item.id ? null : item.id) }} onMenuClose={() => { setRowMenuId(null) }}
    actions={sessionMenuEntries(item)} onAction={action => {
      setRowMenuId(null)
      if (action === 'rename') startRename(item)
      else if (action === 'copyId') void copySessionId(item)
      else if (action === 'log') void downloadSessionLog(item)
      else if (action === 'fork') void forkConversation(item)
      else if (action === 'pin') void patchConversation(item.id, { pinned: !item.pinned })
      else if (action === 'archive') void patchConversation(item.id, { archived: !item.archived })
    }} />

  const workspaceActions = (workspace: WorkspaceSummary): MenuEntry[] => {
    const entries: MenuEntry[] = [
      { id: 'select', label: t('设为当前工作区', 'Use this workspace'), icon: <IconCheckOutlineRegular size={14} /> },
      { id: 'browse', label: t('浏览文件', 'Browse files'), icon: <IconFolderOpenOutlineRegular size={14} /> },
      { id: 'rename', label: t('重命名', 'Rename'), icon: <IconEditOutlineRegular size={14} /> },
    ]
    // 仅当还有其他工作区可以接管被重绑的会话时，DSH 才提供移除入口。
    if (workspaces.length > 1) entries.push({ id: 'delete', label: t('删除工作区', 'Delete workspace'), icon: <IconTrashOutlineRegular size={14} /> })
    return entries
  }

  /**
   * ZCode parity: closing the pane only collapses it. The tab bucket keeps its tabs, so reopening
   * lands where the reader left off; conversation-scoped cleanup happens on session switch instead.
   */
  const closeInspector = (): void => {
    cancelInspectorFileRead()
    setInspectorOpen(false)
    setInspectorFullView(false)
  }

  /** Close one plugin tab: drop the page and its inline-card host, then let the model pick the fallback. */
  /** 关闭一个插件页：释放其宿主并从挂载列表移除。 */
  const closePluginPage = useCallback((id: string): void => {
    setPluginPages(current => current.filter(page => page.id !== id))
    // 标签页不再持有宿主；其内联卡会在下一次渲染时把它接回去。
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
  /** 打开插件页：内联卡移交宿主则复用同一 iframe，否则新建页面数据。 */
  const openPluginPage = useCallback((input: PluginUiPage | Omit<PluginUiPage, 'id'>, host?: HTMLElement): void => {
    // 内联卡自带页面 id；「+」菜单还没有页面，因此其 id 取自会话。
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
  /** 打开子智能体只读会话标签（去重激活）。 */
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
  /** 打开子智能体目录标签。 */
  const openSubagentDirectory = useCallback((): void => {
    openPaneTab({ id: 'subagents', type: 'subagents', title: t('子智能体目录', 'Subagents'), openedAt: Date.now() })
    setSidebarOpen(false)
  }, [openPaneTab, t])

  /** Page ids whose host the inspector owns; an inline card shows a placeholder for those. */
  /** 当前由 Inspector 托管的插件页 id 集合（宿主已移交）。 */
  const sidePageIds = useMemo(() => new Set(Object.keys(pluginPageHosts)), [pluginPageHosts])
  const pluginPageHolding = useRef<HTMLDivElement>(null)
  /** 把腾出的插件页宿主存入应用的暂存节点，避免 iframe 脱离文档而重载。 */
  const holdPluginPageHost = useCallback((host: HTMLElement): void => {
    pluginPageHolding.current?.appendChild(host)
  }, [])
  /** 传给插件页池的上下文：托管集合、打开与暂存回调。 */
  const pluginPagePool = useMemo(() => ({ sidePageIds, openSide: openPluginPage, hold: holdPluginPageHost }), [holdPluginPageHost, openPluginPage, sidePageIds])

  /** The `+` menu reads the surfaces the server enables for this workspace and conversation. */
  /** 刷新当前工作区/会话可用的插件 surface 列表。 */
  const refreshPluginSurfaces = useCallback(async (): Promise<void> => {
    try {
      const surfaces = await api.pluginUiSurfaces(currentWorkspaceId, selectedId ?? undefined)
      setPluginSurfaces(surfaces)
    } catch (cause) {
      setPluginSurfaces([])
      announce(errorText(cause, t('无法读取插件页面', 'Could not load plugin pages')))
    }
  }, [announce, currentWorkspaceId, selectedId, t])

  /** 打开一个插件 surface：无页面数据时先向服务端索取。 */
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
    // ZCode 的收起展开：没有标签的面板落在启动页上。
    if (paneRef.current.tabs.length === 0) {
      openPaneTab({ id: 'new-tab', type: 'new-tab', title: t('新标签页', 'New tab'), openedAt: Date.now() })
    }
  }

  // —— ZCode launcher entries: review, browser, trajectory, new-tab, selection side chat. ——
  /** 打开 Git 审查标签（无则新建）。 */
  const openReviewPane = useCallback((): void => {
    openPaneTab({ id: 'git', type: 'git', title: t('审查', 'Review'), openedAt: Date.now() })
  }, [openPaneTab, t])
  /** 打开内置浏览器标签（无则新建）。 */
  const openBrowserPane = useCallback((): void => {
    openPaneTab({ id: `browser:${crypto.randomUUID()}`, type: 'browser', title: t('浏览器', 'Browser'), openedAt: Date.now(), url: '' })
  }, [openPaneTab, t])
  /** 打开模型调用轨迹标签（无则新建）。 */
  const openTrajectoryPane = useCallback((): void => {
    if (selectedId === null) {
      announce(t('先打开一个会话再查看模型轨迹', 'Open a conversation to view its model trajectory'))
      return
    }
    const title = selectedSummary?.title !== undefined && selectedSummary.title !== ''
      ? selectedSummary.title
      : t('模型调用轨迹', 'Model trajectory')
    openPaneTab({ id: `trajectory:${selectedId}`, type: 'trajectory', conversationId: selectedId, title, openedAt: Date.now() })
  }, [announce, openPaneTab, selectedId, selectedSummary, t])
  /** 打开「新标签页」启动页。 */
  const openNewTabPane = useCallback((): void => {
    openPaneTab({ id: 'new-tab', type: 'new-tab', title: t('新标签页', 'New tab'), openedAt: Date.now() })
  }, [openPaneTab, t])
  /** 把浏览器标签的导航补丁（url/地址草稿/标题）回写到标签状态。 */
  const patchBrowserTab = useCallback((tabId: string, patch: { url?: string; addressDraft?: string; title?: string }): void => {
    const current = paneRef.current
    const tabs = current.tabs.map(tab => tab.id === tabId
      ? { ...tab, ...(patch.url === undefined ? {} : { url: patch.url }), ...(patch.addressDraft === undefined ? {} : { addressDraft: patch.addressDraft }), ...(patch.title === undefined ? {} : { title: patch.title }) }
      : tab)
    commitPane(normalizePaneState({ tabs, activeTabId: current.activeTabId }) ?? { tabs, activeTabId: current.activeTabId })
  }, [commitPane])
  /** 切换 Inspector 完整视图（覆盖整个主行）。 */
  const toggleInspectorFullView = useCallback((): void => {
    if (!showInspector) {
      // ZCode 进入完整视图的方式：面板原本收起时先展开它。
      toggleInspector()
      setInspectorFullView(true)
      return
    }
    setInspectorFullView(value => !value)
  }, [showInspector, toggleInspector])

  /** Create (or reuse) a side chat conversation for a transcript selection and open its tab. */
  const sideChatOpening = useRef(false)
  /** 打开（或聚焦）一个侧聊标签；携带引文时存入待发送引用。 */
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
  /** 发送一条侧聊消息：组装含引文的提示词并经 api 旁路请求，流式回填。 */
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

  // ZCode 的侧栏组合键与它们驱动的入口同处声明（入口已在上方定义）。
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

  useLayoutEffect(() => {
    const container = mainBodyRef.current
    if (container === null) return
    const measure = (): void => { setMainBodyWidth(container.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => { window.removeEventListener('resize', measure) }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [sidebarCollapsed])

  useLayoutEffect(() => {
    const primary = primaryPanelRef.current
    const panel = inspectorPanelRef.current
    if (!inspectorOverlay || primary === null || panel === null) return
    const opener = document.activeElement
    const fromPrimary = opener instanceof HTMLElement && primary.contains(opener)
    if (fromPrimary) focusWithoutRing(panel)
    setElementInert(primary, true)
    return () => {
      setElementInert(primary, false)
      if (fromPrimary && opener.isConnected && (document.activeElement === document.body || document.activeElement === panel)) {
        focusWithoutRing(opener)
      }
    }
  }, [inspectorOverlay])

  const inspectorCanResize = dockedInspector !== null
  useLayoutEffect(() => {
    if (inspectorCanResize || inspectorResize.current === null) return
    inspectorResize.current = null
    setInspectorDragging(false)
  }, [inspectorCanResize])

  const resizeInspectorTo = (width: number): void => {
    if (dockedInspector === null) return
    setPreferredInspectorWidth(Math.min(dockedInspector.max, Math.max(dockedInspector.min, width)))
  }
  const beginInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || inspectorResize.current !== null || dockedInspector === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    inspectorResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: dockedInspector.width }
    setInspectorDragging(true)
  }
  const moveInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = inspectorResize.current
    if (start === null || start.pointerId !== event.pointerId) return
    // 分隔条位于 Inspector 左缘，向左拖动即加宽它。
    resizeInspectorTo(Math.round(start.startWidth + start.startX - event.clientX))
  }
  const endInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (inspectorResize.current?.pointerId !== event.pointerId) return
    inspectorResize.current = null
    setInspectorDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  /**
   * DSH's `openPlan` (`ui-plan/src/client/PlanCard.tsx:48-57`): focus the exact submitted plan in
   * the right sidebar. `auto` is the one automatic open per conversation (`PlanCard.tsx:72-80`).
   */
  /** 打开计划：显式打开的计划存入 inspectorPlan，待审计划在会话切换时自动打开一次。 */
  const openPlan = useCallback((plan: PlanDocument, auto = false): void => {
    if (auto) {
      if (selectedId === null || planAutoOpenedFor.current === selectedId) return
      planAutoOpenedFor.current = selectedId
    }
    setInspectorPlan(plan)
    openPaneTab({ id: 'doc:plan', type: 'document', title: t('计划', 'Plan'), openedAt: Date.now(), doc: { kind: 'plan' } })
  }, [openPaneTab, selectedId, t])

  // DSH 对每个待审计划自动打开一次，读者关闭后不再自动打开
  // （`PlanCard.tsx:63-80` + `review-store.ts:12-22`）。Pi 以会话为记忆键，
  // 切换会话即重置；不再处于待审状态的计划绝不自动打开。
  useEffect(() => {
    planAutoOpenedFor.current = null
  }, [selectedId])

  // 插件页面属于打开它们的会话（`plugin-marketplace-design.md` §8.2），因此切换会话
  // 会连同销毁旧会话的已挂载页面与 surface 列表。子会话标签、轨迹与侧聊一并如此：
  // 各自属于其父会话。
  useEffect(() => {
    setPluginPages([])
    setPluginPageHosts({})
    setPluginSurfaces([])
    setSideFeeds({})
    setSideQuotes({})
    commitPane(stripConversationScoped(paneRef.current))
  }, [commitPane, selectedId])

  // 标签按工作区记忆（ZCode 的 taskSidePaneMemory）；在工作区之间移动即切换桶，
  // 未知工作区从空桶开始。空作用域会收起面板
  // (ZCode's resolveSidePaneScopeState), so switching to a fresh workspace never shows a bare shell.
  useLayoutEffect(() => {
    if (currentWorkspaceId === undefined) {
      const emptyPane = { tabs: [], activeTabId: null }
      paneRef.current = emptyPane
      setPaneState(emptyPane)
      setInspectorOpen(false)
      return
    }
    const restored = readPaneMemory(currentWorkspaceId) ?? { tabs: [], activeTabId: null }
    paneRef.current = restored
    setPaneState(restored)
    if (restored.tabs.length === 0) setInspectorOpen(false)
  }, [currentWorkspaceId])
  useLayoutEffect(() => {
    cancelInspectorFileRead()
  }, [cancelInspectorFileRead, currentWorkspaceId, page, selectedId])
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
        aria-label={t('主导航和会话列表', 'Navigation and conversations')} tabIndex={-1}
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
        <Button variant="outline" className={css.newChat} icon={<IconNewChatOutlineRegular size={14} />} onClick={startNewConversation}>
          {t('新会话', 'New conversation')}
        </Button>
        <nav className={css.quickNav} aria-label={t('管理页面', 'Management pages')}>
          <button type="button" className={css.navItem} data-active={page === 'defects' || undefined}
            aria-label={t('问题清单', 'Issues')} aria-current={page === 'defects' ? 'page' : undefined} onClick={() => { navigate('defects') }}>
            <IconChecklistOutlineRegular size={16} /><span>{t('问题清单', 'Issues')}</span>
          </button>
          <button type="button" className={css.navItem} data-active={page === 'inbox' || undefined}
            aria-label={t('收件箱', 'Inbox')} aria-current={page === 'inbox' ? 'page' : undefined} onClick={() => { navigate('inbox') }}>
            <Inbox size={16} aria-hidden="true" /><span>{t('收件箱', 'Inbox')}</span>
          </button>
          <button type="button" className={css.navItem} data-active={page === 'automations' || undefined}
            aria-label={t('自动化任务', 'Automations')} aria-current={page === 'automations' ? 'page' : undefined} onClick={() => { navigate('automations') }}>
            <IconClockOutlineRegular size={16} /><span>{t('自动化任务', 'Automations')}</span>
          </button>
        </nav>
        <div className={css.workspaceHeader}>
          {searchOpen
            ? <Input ref={workspaceSearchRef} className={css.workspaceSearchInput} value={query} onChange={event => { setQuery(event.currentTarget.value) }}
              placeholder={t('搜索工作区和会话', 'Search workspaces and conversations')} aria-label={t('搜索工作区和会话', 'Search workspaces and conversations')} />
            : <span>{t('工作区', 'Workspaces')}</span>}
          <div className={css.workspaceTools}>
            <Tooltip label={searchOpen ? t('关闭搜索', 'Close search') : t('搜索', 'Search')} side="top" portal>
              <Button variant="ghost" size="sm" aria-label={searchOpen ? t('关闭搜索', 'Close search') : t('搜索工作区和会话', 'Search workspaces and conversations')}
                icon={<IconSearchOutlineRegular size={15} />} onClick={() => {
                  setSearchOpen(value => !value)
                  if (searchOpen) setQuery('')
                }} />
            </Tooltip>
            <Menu open={themeMenuOpen} onClose={() => { setThemeMenuOpen(false) }}
              onSelect={id => {
                setThemeMenuOpen(false)
                if (id === 'recent' || id === 'name') setWorkspaceSort(id)
                else if (id === 'archived') setShowArchived(value => !value)
              }}
              selectedId={workspaceSort} items={[
                { id: 'recent', label: t('按最近活动排序', 'Sort by recent activity'), icon: <IconClockOutlineRegular size={14} /> },
                { id: 'name', label: t('按名称排序', 'Sort by name'), icon: <IconFlatListOutlineRegular size={14} /> },
                { id: 'archived', label: showArchived ? t('显示最近会话', 'Show active conversations') : t('显示已归档会话', 'Show archived conversations'), icon: showArchived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} /> },
              ]} portal anchor={<Tooltip label={t('视图选项', 'View options')} side="top" portal>
                <Button variant="ghost" size="sm" aria-label={t('视图选项', 'View options')} icon={<IconSlidersTwoOutlineRegular size={15} />}
                  aria-haspopup="menu" aria-expanded={themeMenuOpen}
                  onClick={() => { setThemeMenuOpen(value => !value) }} />
              </Tooltip>} />
            <Tooltip label={t('添加工作区', 'Add workspace')} side="top" portal>
              <Button variant="ghost" size="sm" aria-label={t('添加工作区', 'Add workspace')} icon={<IconPlusOutlineRegular size={15} />}
                onClick={() => { void addWorkspaceFromPicker() }} />
            </Tooltip>
          </div>
        </div>
        <div className={css.workspaceList}>
          {workspaceLoadError !== '' && <div className={css.listNotice} role="alert"><span>{workspaceLoadError}</span>
            <button type="button" onClick={() => { void refreshWorkspaces() }}>{t('重试', 'Retry')}</button></div>}
          {workspaceLoadError === '' && workspaces.length === 0 && !workspaceLoading && <p className={css.listEmpty}>{t('添加一个文件夹开始工作', 'Add a folder to get started')}</p>}
          {workspaceLoading && <SessionSkeleton />}
          {!workspaceLoading && filteredWorkspaces.map(workspace => {
            const workspaceMatches = workspaceNeedle !== '' && `${workspace.name}\n${workspace.path}`.toLocaleLowerCase().includes(workspaceNeedle)
            const matchesWorkspace = (item: ConversationSummary): boolean => item.workspaceId === workspace.id || item.workspaceId === undefined && item.cwd === workspace.path
            const sessions = (workspaceMatches
              ? conversations.filter(item => (settings.showAnalysisConversations || item.kind !== 'defectAnalysis') && item.archived === showArchived && matchesWorkspace(item))
              : filteredConversations.filter(matchesWorkspace)).sort(compareConversations)
            const isExpanded = expandedWorkspaces.has(workspace.id) || workspaceNeedle !== ''
            const isCurrentWorkspace = workspace.id === currentWorkspaceId
            const workspaceMenuOpen = workspaceMenuId === workspace.id
            const viewEntries = workspaceActions(workspace)
            return <div className={css.workspaceGroup} key={workspace.id}>
              <div className={css.workspaceRow} data-selected={isCurrentWorkspace || undefined} data-menu-open={workspaceMenuOpen || undefined}
                data-workspace-row={workspace.id}
                ref={node => {
                  if (node === null) workspaceRowRefs.current.delete(workspace.id)
                  else workspaceRowRefs.current.set(workspace.id, node)
                }}>
                <button type="button" className={css.workspaceToggle} aria-label={workspace.name}
                  aria-current={isCurrentWorkspace ? 'location' : undefined}
                  aria-expanded={isExpanded && (!sidebarCollapsed || mobile)} title={sidebarCollapsed && !mobile ? workspace.name : undefined}
                  onClick={() => {
                    if (sidebarCollapsed && !mobile) {
                      setSidebarCollapsed(false)
                      setExpandedWorkspaces(current => new Set(current).add(workspace.id))
                      return
                    }
                    setExpandedWorkspaces(current => {
                      const next = new Set(current)
                      if (next.has(workspace.id)) next.delete(workspace.id)
                      else next.add(workspace.id)
                      return next
                    })
                  }}>
                  <IconChevronRightOutlineRegular className={isExpanded ? css.chevronOpen : ''} size={13} />
                  {isExpanded ? <IconFolderOpenOutlineRegular size={16} /> : <IconFolderCloseRegular size={16} />}
                  <span className={css.workspaceName}>{workspace.name}</span>
                </button>
                <span className={css.rowActions} onClick={event => { event.stopPropagation() }}>
                <Menu open={workspaceMenuOpen} onClose={() => { setWorkspaceMenuId(null) }} items={viewEntries} portal align="end"
                  getAnchorRect={() => {
                    const row = workspaceRowRefs.current.get(workspace.id)
                      ?? document.querySelector<HTMLElement>(`[data-workspace-row="${CSS.escape(workspace.id)}"]`)
                    return row?.getBoundingClientRect() ?? null
                  }}
                  onSelect={id => {
                    setWorkspaceMenuId(null)
                    if (id === 'select') void selectWorkspace(workspace.id)
                    else if (id === 'browse') openWorkspaceBrowser(workspace.id)
                    else if (id === 'rename') setRenameWorkspace(workspace)
                    else if (id === 'delete') setDeleteWorkspace(workspace)
                  }} anchor={<button type="button" className={css.rowIconButton}
                    aria-label={t(`工作区“${workspace.name}”的操作`, `Actions for ${workspace.name}`)}
                    aria-haspopup="menu" aria-expanded={workspaceMenuOpen}
                    onClick={() => { setWorkspaceMenuId(value => value === workspace.id ? null : workspace.id) }}><IconEllipsisOutlineRegular size={16} /></button>} />
                <Tooltip label={t('新会话', 'New session')} side="bottom" align="end" delayMs={500} portal>
                  <button type="button" className={css.rowIconButton}
                    aria-label={t(`在“${workspace.name}”中新建会话`, `New session in ${workspace.name}`)}
                    onClick={() => { startNewConversationIn(workspace.id) }}><IconNewChatOutlineRegular size={16} /></button>
                </Tooltip>
                </span>
              </div>
              {isExpanded && <HoverCardGroup className={css.workspaceSessions}>
                {sessions.map(renderSession)}
                {sessions.length === 0 && <span className={css.emptySessions}>{query.trim() !== '' ? t('没有匹配的会话', 'No matching conversations') : t('暂无会话', 'No conversations')}</span>}
              </HoverCardGroup>}
            </div>
          })}
          {ungrouped.length > 0 && <div className={css.workspaceGroup}>
            <div className={css.workspaceLabel}><IconWorkspaceTreeOutlineRegular size={15} /><span>{t('未分组', 'Ungrouped')}</span></div>
            <HoverCardGroup className={css.workspaceSessions}>{ungrouped.map(renderSession)}</HoverCardGroup>
          </div>}
          {!workspaceLoading && filteredConversations.length === 0 && query.trim() !== '' && <p className={css.listEmpty}>{t('没有匹配的会话', 'No matching conversations')}</p>}
          {!listLoading && listError !== '' && <div className={css.listNotice} role="alert"><span>{listError}</span>
            <button type="button" onClick={() => { setListLoading(true); void refreshList() }}>{t('重试', 'Retry')}</button></div>}
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
        {mobile && !showConversationHeader && <button ref={sidebarTriggerRef} type="button" className={css.mobileSidebarButton}
          aria-label={t('打开会话列表', 'Open conversation list')} onClick={() => { setSidebarOpen(true) }}>
          <IconPanelLeftOutlineRegular size={16} />
        </button>}
        <PluginPageHostContext.Provider value={pluginPagePool}>
        <div ref={pluginPageHolding} aria-hidden="true"
          style={{ position: 'fixed', left: '-10000px', top: 0, width: 0, height: 0, overflow: 'hidden' }} />
        <div ref={mainBodyRef} className={`${css.mainBody} ${inspectorOverlay ? css.withInspectorOverlay : dockedInspector !== null ? css.withInspector : ''}`}
          data-inspector-dragging={inspectorDragging || undefined}
          style={dockedInspector === null ? undefined : ({
            '--inspector-width': `${dockedInspector.width}px`,
            '--inspector-divider-width': `${INSPECTOR_DIVIDER_WIDTH}px`,
          } as CSSProperties)}>
          <div ref={primaryPanelRef} className={css.primaryPanel} data-page={page}>
            {page === 'chat' && <>
              {showConversationHeader && <>
                <header className={css.topbar}>
                  <div className={css.topbarStart}>
                    {mobile && <Tooltip label={t('会话列表', 'Conversation list')} side="bottom" portal>
                      <Button ref={sidebarTriggerRef} variant="ghost" size="sm" aria-label={t('打开会话列表', 'Open conversation list')}
                        icon={<IconPanelLeftOutlineRegular size={16} />} onClick={() => { setSidebarOpen(true) }} />
                    </Tooltip>}
                    <div className={css.conversationHeading}>
                      {activeDetail?.conversation.parentId !== undefined
                        ? <SubagentBreadcrumb conversation={activeDetail.conversation}
                          parentTitle={conversations.find(item => item.id === activeDetail.conversation.parentId)?.title}
                          onOpen={id => { selectConversation(id) }} t={t} />
                        : <span className={css.conversationTitle}>{activeDetail?.conversation.title ?? selectedSummary?.title ?? t('新对话', 'New conversation')}</span>}
                      <span className={css.cwd}>{currentWorkspace?.name ?? activeDetail?.conversation.cwd ?? selectedSummary?.cwd ?? ''}
                        {busy && <span className={css.running}>{t('运行中', 'Running')}</span>}</span>
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
                      reconnectActionLabel={t('重新连接会话', 'Reconnect conversation')} restartActionLabel={t('再次尝试连接', 'Try again')}
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
              {hero
                ? <>
                  <div className={css.heroHeader}>
                    <span />
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
                    onOpenSettings={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }} onNewConversation={startNewConversation}
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
                        detailRef.current = value; setDetail(value); setDetailError(''); updateConversation(value)
                      }).catch(cause => { setDetailError(errorText(cause, t('无法打开此会话', 'Could not open this conversation'))) })
                        .finally(() => { setDetailLoading(false) })
                    }}>{t('重试', 'Retry')}</Button>
                  </div>}
                  {activeDetail !== null && <div ref={selectionHostRef} className={`${css.chatLayout} ${statusPanelVisible ? css.withStatusPanel : ''}`}>
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
                        updateConversation(value)
                      }} />
                    {activeDetail.compaction?.running !== true && activeDetail.compaction?.failure !== undefined && <div className={css.compactionNotice} data-state="error" role="alert">
                      <span>{t('上下文压缩失败', 'Context compaction failed')}</span>
                      <span className={css.compactionHint}>{activeDetail.compaction.failure}</span>
                    </div>}
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
                      queuePaused={queuePausedMap[activeDetail.conversation.id] === true} onResumeQueue={() => { void resumeQueue() }}
                      onUpdateQueue={updateQueue} onOpenSettings={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }}
                      onCompact={() => { void compact() }}
                      onNewConversation={startNewConversation} onSearchFiles={searchWorkspaceFiles} onSearchSkills={searchSkills} onPreviewFile={path => { void openWorkspaceFile(path) }}
                      pluginContexts={pluginContexts} onRemovePluginContext={removePluginContext} />
                  </div>}
                </>}
            </>}
            {page === 'defects' && <Suspense fallback={<div className={css.loadingState}><Loader size={16} />{t('正在加载问题清单', 'Loading issues')}</div>}>
              <WetrackPage workspaces={workspaces} onOpenConversation={id => { void openConversation(id) }} />
            </Suspense>}
            {page === 'inbox' && <Suspense fallback={<div className={css.loadingState}><Loader size={16} />{t('正在加载收件箱', 'Loading inbox')}</div>}>
              <InboxPage />
            </Suspense>}
            {page === 'automations' && <AutomationsPage workspaceId={currentWorkspaceId}
              workspaces={workspaces} onNewConversation={startNewConversation}
              onOpenConversation={id => { void openConversation(id) }} />}
          </div>
          {showInspector && <>
            {dockedInspector !== null && <div className={css.inspectorResizer} role="separator" aria-orientation="vertical"
              aria-label={t('调整侧栏宽度', 'Resize inspector')}
              aria-controls="workspace-inspector"
              aria-valuenow={dockedInspector.width} aria-valuemin={dockedInspector.min} aria-valuemax={dockedInspector.max} tabIndex={0}
              aria-valuetext={t(`${dockedInspector.width} 像素`, `${dockedInspector.width} pixels`)}
              onPointerDown={beginInspectorResize} onPointerMove={moveInspectorResize}
              onPointerUp={endInspectorResize} onPointerCancel={endInspectorResize} onLostPointerCapture={endInspectorResize}
              onDoubleClick={() => { setPreferredInspectorWidth(undefined) }}
              onKeyDown={event => {
                switch (event.key) {
                  case 'ArrowLeft': resizeInspectorTo(dockedInspector.width + 16); break
                  case 'ArrowRight': resizeInspectorTo(dockedInspector.width - 16); break
                  case 'Home': resizeInspectorTo(dockedInspector.min); break
                  case 'End': resizeInspectorTo(dockedInspector.max); break
                  default: return
                }
                event.preventDefault()
              }} />}
            <aside ref={inspectorPanelRef} id="workspace-inspector" className={css.inspectorPane}
              aria-label={t('侧边面板', 'Side pane')} tabIndex={-1}>
              <Inspector
                workspaceId={currentWorkspaceId}
                tabs={pane.tabs} activeTabId={pane.activeTabId}
                onSelectTab={selectPaneTab} onCloseTab={id => { closePaneTabs([id]) }}
                onCloseOtherTabs={closeOtherPaneTabs} onCloseAllTabs={closeAllPaneTabs}
                onOpenNewTab={openNewTabPane}
                fullView={inspectorFullView} onToggleFullView={inspectorSizes === null ? undefined : toggleInspectorFullView}
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
      <WorkspaceDialog open={workspaceDialogOpen} workspaces={workspaces} currentWorkspaceId={currentWorkspaceId}
        busy={false} onClose={() => { setWorkspaceDialogOpen(false) }} onSelect={id => {
          void selectWorkspace(id)
          setWorkspaceDialogOpen(false)
        }} onCreate={addWorkspace} />
      <DirectoryBrowser open={directoryBrowserOpen} onClose={() => { setDirectoryBrowserOpen(false) }}
        onPick={path => {
          setDirectoryBrowserOpen(false)
          const name = path.replace(/\/+$/u, '').split('/').pop() ?? path
          void addWorkspace({ path, name }).then(async added => {
            await refreshWorkspaces()
            announce(t(`已添加工作区 ${added.name}`, `Added workspace ${added.name}`), true)
          }).catch(cause => { announce(errorText(cause, t('无法添加工作区', 'Could not add the workspace'))) })
        }} />
      <WorkspaceRenameDialog workspace={renameWorkspace} onClose={() => { setRenameWorkspace(null) }}
        onSave={(workspace, name) => { setRenameWorkspace(null); void saveWorkspaceName(workspace, name) }} />
      <Modal open={deleteWorkspace !== undefined} onClose={() => { setDeleteWorkspace(undefined) }}
        title={t('删除工作区', 'Delete workspace')} closeLabel={t('关闭', 'Close')}
        description={t('只从列表移除；目录与文件保持不变，该工作区的会话会转到其它工作区。', 'Removed from the list only. Files stay on disk and this workspace\'s conversations move to another workspace.')}
        className={css.childModal}
        footer={<><Button variant="ghost" onClick={() => { setDeleteWorkspace(undefined) }}>{t('取消', 'Cancel')}</Button>
          <Button variant="primary" onClick={() => { if (deleteWorkspace !== undefined) void confirmDeleteWorkspace(deleteWorkspace) }}>{t('删除', 'Delete')}</Button></>} />
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
 * 轮询一个侧聊会话并把消息流推送进 Inspector 读取的应用状态。
 * 每个侧聊标签挂载一个实例；不渲染任何 DOM，保持面板结构不受影响。
 * @param props conversationId 侧聊目标会话；active 是否处于激活标签（控制轮询）；onFeed 推送回调。
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
 * 功能：侧栏中的单个会话行——标题、相对时间、置顶标记、行尾操作菜单与悬浮卡
 * （标题/相对时间/运行状态）；编辑态就地重命名（Enter 保存、Escape 取消）。
 * @param props item 会话摘要；selected 是否选中；editing/editTitle 编辑态与草稿；
 *              menuOpen 菜单开合；actions 行尾菜单项；onSelect 选中、onEditTitle/
 *              onSaveTitle/onCancelTitle 重命名流、onToggleMenu/onMenuClose 菜单、
 *              onAction 分发菜单动作。
 * 内部逻辑：前置单元格按状态渲染——运行中转圈、有未读回复亮蓝点、空闲为空；
 * 置顶徽标常驻行内，其余动作收进尾随菜单；悬浮时时间格切换为操作条（DSH 行为）。
 */
function SessionRow({ item, selected, editing, editTitle, menuOpen, actions, onSelect, onEditTitle, onSaveTitle,
  onCancelTitle, onToggleMenu, onMenuClose, onAction }: {
  item: ConversationSummary
  selected: boolean
  editing: boolean
  editTitle: string
  menuOpen: boolean
  actions: MenuEntry[]
  onSelect: () => void
  onEditTitle: (value: string) => void
  onSaveTitle: () => void
  onCancelTitle: () => void
  onToggleMenu: () => void
  onMenuClose: () => void
  onAction: (action: string) => void
}) {
  const { t, settings } = useUiPreferences()
  return (
    // DSH 的悬浮卡：行旁的深色菜单材质，展示标题、相对时间与状态。
    <HoverCard grouped openDelayMs={500} disabled={editing || menuOpen}
      content={<div className={css.sessionHoverCard}>
        <span className={css.sessionHoverTitle}>{item.title || t('新对话', 'New conversation')}</span>
        <span className={css.sessionHoverTime}>{hoverTime(item.updatedAt, settings.locale)}</span>
        <span className={css.sessionHoverState}>
          <span className={css.sessionHoverDot} aria-hidden="true" />
          {item.busy ? t('运行中', 'Running') : t('空闲', 'Idle')}
        </span>
      </div>}
      anchor={
        <div className={css.sessionRow} data-selected={selected || undefined} data-pinned={item.pinned || undefined}
          data-menu-open={menuOpen || undefined}>
          {editing
            ? <div className={css.renameForm}>
              <input aria-label={t('会话标题', 'Conversation title')} value={editTitle} onChange={event => { onEditTitle(event.currentTarget.value) }}
                autoFocus onKeyDown={event => {
                  if (event.key === 'Enter') { event.preventDefault(); onSaveTitle() }
                  if (event.key === 'Escape') onCancelTitle()
                }} />
              <button type="button" aria-label={t('保存标题', 'Save title')} onClick={onSaveTitle}>{t('保存', 'Save')}</button>
            </div>
            : <>
              <button type="button" className={css.sessionSelect} onClick={onSelect} aria-current={selected ? 'page' : undefined}>
                {/* ZCode 的前置单元格：回合运行中转圈，已完成的回复读者未打开时亮蓝点，
                    空闲时不渲染。 */}
                <span className={css.sessionSlot}>{item.busy ? (
                  <span className={css.sessionSpinner} role="img" aria-label={t('正在运行', 'Running')}>
                    <Loader size={16} aria-hidden="true" />
                  </span>
                ) : item.unread ? (
                  <span className={css.sessionUnread} role="img" aria-label={t('有未读回复', 'Unread reply')} />
                ) : null}</span>
                <span className={css.sessionTitle}>{item.title || t('新对话', 'New conversation')}</span>
              </button>
              <time className={css.sessionMeta} dateTime={new Date(item.updatedAt).toISOString()}>{formatUpdated(item.updatedAt, settings.locale)}</time>
              {/* 置顶状态保留在行本身；其余动作都收在尾随菜单里。 */}
              {item.pinned && <span className={css.sessionPin} role="img" aria-label={t('已置顶', 'Pinned')} title={t('已置顶', 'Pinned')}><IconPinFillRegular size={14} /></span>}
              <span className={css.rowActions} onClick={event => { event.stopPropagation() }}>
                <Menu open={menuOpen} onClose={onMenuClose} items={actions} portal
                  onSelect={id => { onAction(id) }}
                  anchor={<button type="button" className={css.rowIconButton} aria-label={t(`会话“${item.title}”的操作`, `Actions for ${item.title}`)}
                    aria-haspopup="menu" aria-expanded={menuOpen}
                    onClick={onToggleMenu}><IconEllipsisOutlineRegular size={16} /></button>} />
              </span>
            </>}
        </div>
      } />
  )
}

/**
 * 功能：DSH 的子智能体会话面包屑层级（对应 `SubagentHeaderLineage.tsx:785-822`）：
 * 父标题可点击返回，当前子标题是兄弟会话切换器——菜单中以 DSH 的「当前会话」
 * 标签（`:238,340`）高亮屏幕上的会话；切换器的无障碍名称沿用 DSH 的 `switcher.aria`
 * （`locales.ts:40`）。
 * @param props conversation 当前子会话摘要；parentTitle 侧栏已知时的父标题；
 *              onOpen 跳转会话回调；t 翻译函数。
 * 内部逻辑：parentId 变化时重置菜单、解析父标题（侧栏未知时经 api.getConversation）
 * 并拉取兄弟会话列表；父标题未解析前回退显示 parentId。
 */
function SubagentBreadcrumb({ conversation, parentTitle, onOpen, t }: {
  conversation: ConversationSummary
  /** 侧栏列表已知时的父标题。 */
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
    // 子智能体的子会话不在侧栏列表中，父标题回退为路由信息。
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

/** 会话列表加载骨架（三条占位条）。 */
function SessionSkeleton() {  const { t } = useUiPreferences()
  return <div className={css.skeleton} aria-label={t('正在加载会话', 'Loading conversations')}>
    <span /><span /><span />
  </div>
}

/** 会话详情加载中的整页占位（转圈 + 文案）。 */
function LoadingConversation() {
  const { t } = useUiPreferences()
  return <div className={css.loadingState} role="status"><span className={css.spinner} />{t('正在载入会话', 'Loading conversation')}</div>
}

/** 会话排序：置顶优先，其余按更新时间倒序。 */
function compareConversations(a: ConversationSummary, b: ConversationSummary): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
}

/** 本地账号行的首字母头像，代替 DSH 的账号图片。 */
function accountInitial(name: string): string {
  const first = [...name.trim()][0]
  return first === undefined ? 'π' : first.toLocaleUpperCase()
}

/** 会话行尾随时间标签，按 DSH 的相对时间分桶，保证两处展示同一行时文案一致。 */
function formatUpdated(value: number, locale: 'zh' | 'en'): string {
  const { unit, n } = relativeTime(value, Date.now())
  switch (unit) {
    case 'now': return locale === 'zh' ? '刚刚' : 'just now'
    case 'minutes': return locale === 'zh' ? `${n} 分钟` : `${n}m`
    case 'hours': return locale === 'zh' ? `${n} 小时` : `${n}h`
    case 'days': return locale === 'zh' ? `${n} 天` : `${n}d`
    case 'months': return locale === 'zh' ? `${n} 个月` : `${n}mo`
    case 'years': return locale === 'zh' ? `${n} 年` : `${n}y`
  }
}

/** DSH 悬浮卡的时间行：与行尾同分桶，但读作「23天前」而非单元格标签。 */
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

/** 判断待发送条目是否已被服务端确认：消息流出现同 requestId，或已进入排队列表。 */
function isAcknowledged(detail: ConversationDetail, pendingItem: PendingSubmission): boolean {
  return detail.messages.some(message => message.requestId === pendingItem.requestId)
    || pendingItem.submissionId !== undefined && detail.queue.some(item => item.id === pendingItem.submissionId)
}

/**
 * 一次提交尝试的身份：目标会话、精确文本与附件 id 组合。
 * 与之匹配的重试属于同一次逻辑提交，保留服务端用于去重的 requestId。
 */
function submissionFingerprint(conversationId: string, text: string, images: readonly DraftImage[]): string {
  return `${conversationId}\u0000${text}\u0000${images.map(image => image.id).join('\u0000')}`
}

/** 提取错误的 message 文本；非 Error 时回退到兜底文案。 */
function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/** 读取某作用域的输入草稿；无存档返回空串。 */
function loadDraft(scope: string): string {
  return readStorage(`${DRAFT_PREFIX}${scope}`) ?? ''
}

/** 安全读取 localStorage；不可用时返回 null。 */
function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key) }
  catch { return null }
}

/** 写入 localStorage；存储满或被禁用时静默失败（内存中的草稿仍然可用）。 */
function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) }
  catch { /* 浏览器存储满或被禁用时，内存中的草稿仍然可用。 */ }
}

/** 移除 localStorage 条目；不可用时静默失败（页面可继续运行）。 */
function removeStorage(key: string): void {
  try { window.localStorage.removeItem(key) }
  catch { /* 没有浏览器存储页面也能继续。 */ }
}

/** 设置或移除元素的 inert 属性（禁用交互与无障碍树）。 */
function setElementInert(element: HTMLElement, inert: boolean): void {
  if (inert) element.setAttribute('inert', '')
  else element.removeAttribute('inert')
}

/** 判断 MIME 类型是否为受支持的图片类型。 */
function isImageType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLocaleLowerCase())
}

/** 附件的图片 MIME 类型：浏览器未报告时从文件名扩展名推断。 */
function imageFileType(file: File): string {
  const declared = file.type.toLocaleLowerCase()
  if (declared !== '') return isImageType(declared) ? declared : ''
  const extension = file.name.toLocaleLowerCase().split('.').pop() ?? ''
  return IMAGE_EXTENSIONS[extension] ?? ''
}

/** 把附件文件读取为 base64 数据（data URL 去掉前缀）；失败以本地化错误拒绝。 */
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

/** 已创建的附件预览对象 URL 登记（卸载/移除时统一 revoke）。 */
const objectUrls = { current: new Set<string>() }
