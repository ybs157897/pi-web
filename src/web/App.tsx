import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Button, ConnectionIndicator, HoverCard, HoverCardGroup, IconArchiveOutlineRegular, IconBranchOutlineRegular,
  IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconClockOutlineRegular, IconCopyOutlineRegular,
  IconDownloadOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFlatListOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconListPenOutlineRegular,
  IconNewChatOutlineRegular, IconPanelLeftOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular,
  IconSettingsOutlineRegular, IconSlidersTwoOutlineRegular, IconTrashOutlineRegular, IconUnarchiveOutlineRegular,
  IconWorkspaceTreeOutlineRegular, Input, Menu, Modal, ShortcutKeys, Tag, Toast, Tooltip, focusWithoutRing, relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccessMode, AgentPreset, AppSettings, ConversationDetail, ConversationSummary, ModelCatalog,
  ModelOption, ProviderInput, SubagentSummary, ThinkingLevel, WorkspaceFileEntry, WorkspaceSummary,
  UpdateAppSettingsInput,
} from '../shared/types.ts'
import { ApiFailure, api } from './api.ts'
import Composer, { type BusySendMode, type DraftImage } from './Composer.tsx'
import TodoPanel from './TodoPanel.tsx'
import SubagentPanel from './SubagentPanel.tsx'
import TeamPanel from './TeamPanel.tsx'
import GoalBar from './GoalBar.tsx'
import QuestionComposer from './QuestionComposer.tsx'
import SettingsDialog from './SettingsDialog.tsx'
import Transcript, { type PendingMessage } from './transcript.tsx'
import { conversationStats } from './render-model.ts'
import { latestPlan, type PlanDocument } from './plan-preview.ts'
import TrajectoryView, { transcriptMessageDomId } from './TrajectoryView.tsx'
import DirectoryBrowser from './DirectoryBrowser.tsx'
import Inspector from './Inspector.tsx'
import type { InspectorDiff, InspectorFile, InspectorView } from './Inspector.tsx'
import WorkspaceBrowserPage from './WorkspaceBrowserPage.tsx'
import WorkspaceDialog from './WorkspaceDialog.tsx'
import WorkspaceRenameDialog from './WorkspaceRenameDialog.tsx'
import AutomationsPage from './AutomationsPage.tsx'
import PresetsPanel from './PresetsPanel.tsx'
import { matchesShortcut, resolveShortcuts, shortcutKeyLabels, type ShortcutCommand } from './keyboard.ts'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider, useUiPreferences } from './ui-preferences.tsx'
import css from './App.module.css'

type ConnectionState = 'connecting' | 'disconnected' | 'recovered' | undefined
type MainPage = 'chat' | 'automations' | 'workspace'
type ChatView = 'chat' | 'trajectory'
type WorkspaceSort = 'recent' | 'name'
interface ScopedDraft { scope: string; text: string }
/** One attachment as the limits see it: an image flag and its byte size. */
interface AttachmentSize { image: boolean; size: number }
type AttachmentLimit = 'images' | 'files' | 'empty' | 'imageBytes' | 'fileBytes' | 'total'
interface PendingSubmission extends PendingMessage { conversationId: string }
interface ToastMessage { id: number; text: string; success?: boolean }
/** The last failed submission attempt; a retry of the same content reuses its requestId. */
interface FailedSubmission { requestId: string; fingerprint: string }

const SELECTED_KEY = 'pi-durable-web:selected-conversation'
const DRAFT_PREFIX = 'pi-durable-web:draft:'
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
/** Dropped files can arrive without a MIME type, so the extension stands in for it. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
}
/** Draft scopes without attachments share this, so the composer prop keeps a stable identity. */
const NO_IMAGES: readonly DraftImage[] = []
const MAX_IMAGE_COUNT = 4
const MAX_FILE_COUNT = 8
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

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

/** Workspace sidebar, conversation surface, and Pi management entry pages. */
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
  const [presets, setPresets] = useState<AgentPreset[]>([])
  const [appVersion, setAppVersion] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accessModes, setAccessModes] = useState<AccessMode[]>([])
  const [workspaceLoadError, setWorkspaceLoadError] = useState('')
  const [presetLoadError, setPresetLoadError] = useState('')
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [presetsLoading, setPresetsLoading] = useState(true)
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
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'models' | 'presets'>('general')
  const [savingProvider, setSavingProvider] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [page, setPage] = useState<MainPage>('chat')
  const [workspacePageId, setWorkspacePageId] = useState<string | null>(null)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set())
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [deleteWorkspace, setDeleteWorkspace] = useState<WorkspaceSummary | undefined>(undefined)
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false)
  const [renameWorkspace, setRenameWorkspace] = useState<WorkspaceSummary | null>(null)
  const [chatView, setChatView] = useState<ChatView>('chat')
  const [inspectorFile, setInspectorFile] = useState<InspectorFile | undefined>()
  const [inspectorDiff, setInspectorDiff] = useState<InspectorDiff | undefined>()
  const [inspectorPlan, setInspectorPlan] = useState<PlanDocument | undefined>()
  const [inspectorView, setInspectorView] = useState<InspectorView>('file')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorLoading, setInspectorLoading] = useState(false)
  const [inspectorError, setInspectorError] = useState('')
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
  // Attachments live per scope, so switching conversations keeps what was already added.
  const [imageStore, setImageStore] = useState<Record<string, DraftImage[]>>({})
  const [newModel, setNewModel] = useState<{ provider: string; modelId: string } | undefined>(undefined)
  const [newThinking, setNewThinking] = useState<ThinkingLevel>(settings.defaultThinkingLevel)
  /** Plan mode requested before a conversation exists; applied when the session is created. */
  const [newPlan, setNewPlan] = useState(false)
  const [newWorkspaceId, setNewWorkspaceId] = useState<string | undefined>(settings.defaultWorkspaceId)
  const [newPresetId, setNewPresetId] = useState<string | null | undefined>(settings.defaultPresetId)
  const [newAccessMode, setNewAccessMode] = useState<AccessMode>(settings.defaultAccessMode)
  const [sendMode, setSendMode] = useState<BusySendMode>(settings.busySendMode)
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const mainPanelRef = useRef<HTMLElement | null>(null)
  const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null)
  const workspaceSearchRef = useRef<HTMLInputElement | null>(null)
  const messagesViewport = useRef<HTMLDivElement | null>(null)
  const inspectorRequestId = useRef(0)
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
  const activeScope = selectedId === null ? '__new__' : selectedId
  const draft = draftState.scope === activeScope ? draftState.text : ''
  const images = imageStore[activeScope] ?? NO_IMAGES
  const selectedSummary = conversations.find(item => item.id === selectedId)
  const conversationReady = detail?.conversation.id === selectedId
  const activeConversation = conversationReady ? detail : null
  const selectedModel = activeConversation?.conversation.model ?? newModel ?? settings.defaultModel ?? catalog?.defaultModel
  const thinkingLevel = activeConversation?.conversation.thinkingLevel ?? newThinking
  const inferredConversationWorkspace = activeConversation === null ? undefined
    : workspaces.find(workspace => workspace.path === activeConversation.conversation.cwd)?.id
  const currentWorkspaceId = activeConversation !== null
    ? activeConversation.conversation.workspaceId ?? inferredConversationWorkspace ?? settings.defaultWorkspaceId ?? workspaces[0]?.id
    : newWorkspaceId ?? settings.defaultWorkspaceId ?? workspaces[0]?.id
  const currentWorkspace = workspaces.find(workspace => workspace.id === currentWorkspaceId)
  const selectedPresetId = activeConversation !== null
    ? activeConversation.conversation.presetId
    : newPresetId === null ? undefined : newPresetId ?? settings.defaultPresetId
  const accessMode = activeConversation?.conversation.accessMode ?? newAccessMode ?? settings.defaultAccessMode
  const selectedPending = pending.filter(item => item.conversationId === selectedId)

  const announce = useCallback((text: string, success = false): void => {
    toastSequence.current += 1
    setToast({ id: toastSequence.current, text, success })
  }, [])

  const updateConversation = useCallback((value: ConversationDetail | ConversationSummary): void => {
    const summary = 'conversation' in value ? value.conversation : value
    // A subagent session is reached through its parent's catalog, so it never enters the sidebar list.
    if (summary.origin !== 'subagent') {
      setConversations(existing => [summary, ...existing.filter(item => item.id !== summary.id)]
        .sort(compareConversations))
    }
    if ('conversation' in value) setDetail(current => current?.conversation.id === summary.id ? value : current)
  }, [])

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

  const refreshPresets = useCallback(async (): Promise<void> => {
    setPresetsLoading(true)
    try {
      const result = await api.listPresets()
      setPresets(result.presets)
      setPresetLoadError('')
    } catch (cause) { setPresetLoadError(errorText(cause, t('无法读取 Agent 预设', 'Could not load agent presets'))) }
    finally { setPresetsLoading(false) }
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
    void refreshList()
    void refreshCatalog()
    void refreshWorkspaces()
    void refreshPresets()
    void refreshCapabilities()
    api.health().then(value => { setAppVersion(value.version); setAccountName(value.user) }).catch(() => undefined)
  }, [refreshCapabilities, refreshCatalog, refreshList, refreshPresets, refreshWorkspaces])

  useEffect(() => {
    const scope = selectedId ?? '__new__'
    wasAtBottom.current = true
    detailRef.current = null
    setDraftState({ scope, text: loadDraft(scope) })
    setDetail(null)
    setDetailError('')
    setNewModel(undefined)
    const preferences = settingsRef.current
    setNewThinking(preferences.defaultThinkingLevel)
    // A per-workspace "new session" action carries its choice across this reset.
    setNewWorkspaceId(pendingWorkspaceId.current ?? preferences.defaultWorkspaceId)
    pendingWorkspaceId.current = null
    setNewPresetId(preferences.defaultPresetId)
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
    blankIntent.current = false
    setPage('chat')
    setChatView('chat')
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

  const createConversation = useCallback(async (title = t('新对话', 'New conversation')): Promise<ConversationDetail> => {
    blankIntent.current = false
    const model = selectedModel
    const preferences = settingsRef.current
    const workspaceId = newWorkspaceId ?? preferences.defaultWorkspaceId ?? workspaces[0]?.id
    const presetId = newPresetId === null ? undefined : newPresetId ?? preferences.defaultPresetId
    const created = await api.createConversation({
      title,
      ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
      thinkingLevel,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(presetId === undefined ? {} : { presetId }),
      accessMode: newAccessMode ?? preferences.defaultAccessMode,
    })
    // Plan mode is conversation-scoped, so the hero-time request is applied once the session exists.
    const detail = newPlan ? await api.setPlan(created.conversation.id, true) : created
    setNewPlan(false)
    setConversations(existing => [detail.conversation, ...existing.filter(item => item.id !== detail.conversation.id)]
      .sort(compareConversations))
    setDetail(detail)
    detailRef.current = detail
    setSelectedId(detail.conversation.id)
    setPage('chat')
    setChatView('chat')
    setSidebarOpen(false)
    return detail
  }, [newAccessMode, newPlan, newPresetId, newWorkspaceId, selectedModel, thinkingLevel, t, workspaces])

  const setDraft = useCallback((value: string): void => {
    setDraftState({ scope: activeScope, text: value })
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
    submitLock.current = true
    setSending(true)
    let targetId = selectedId
    let target = detail?.conversation.id === selectedId ? detail : null
    // The requestId is only known once the target exists (see below); the optimistic entry carries it from then on.
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
      // Retrying the exact same failed submission reuses its requestId, so a message the server already
      // accepted is not sent twice when only the response was lost. Any change in content earns a fresh id.
      const fingerprint = submissionFingerprint(targetId, text, ready)
      const remembered = lastFailedSubmit.current
      const requestId = remembered !== null && remembered.fingerprint === fingerprint ? remembered.requestId : crypto.randomUUID()
      lastFailedSubmit.current = { requestId, fingerprint }
      setPending(existing => existing.map(item => item.id === pendingId ? { ...item, requestId } : item))
      const imageAttachments = ready.filter(item => isImageType(item.mimeType))
      const fileAttachments = ready.filter(item => !isImageType(item.mimeType))
      const result = await api.submit(targetId, {
        text,
        requestId,
        ...(target?.conversation.busy ? { whenBusy: requestedMode ?? sendMode } : {}),
        ...(imageAttachments.length === 0 ? {} : { images: imageAttachments.map(image => ({ data: image.data, mimeType: image.mimeType })) }),
        ...(fileAttachments.length === 0 ? {} : { files: fileAttachments.map(file => ({ name: file.file.name, mimeType: file.mimeType, data: file.data })) }),
      })
      lastFailedSubmit.current = null
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
  }, [activeScope, announce, createConversation, detail, draftState, selectedId, sendMode, t, writeImages])

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
    try {
      await api.compact(selectedId)
      announce(t('已开始压缩上下文', 'Compaction started'), true)
    } catch (cause) { announce(errorText(cause, t('无法压缩上下文', 'Could not compact the context'))) }
  }, [announce, selectedId, t])

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

  const chooseModel = useCallback(async (model: ModelOption): Promise<void> => {
    const selection = { provider: model.provider, modelId: model.modelId }
    const level = model.reasoning ? activeConversation?.conversation.thinkingLevel ?? newThinking : 'off'
    if (selectedId === null || !conversationReady) {
      setNewModel(selection)
      setNewThinking(level)
      return
    }
    try {
      const value = await api.updateConversation(selectedId, { model: selection, thinkingLevel: level })
      setDetail(value)
      detailRef.current = value
      updateConversation(value)
    } catch (cause) { announce(errorText(cause, t('切换模型失败', 'Could not change model'))) }
  }, [activeConversation, announce, conversationReady, newThinking, selectedId, t, updateConversation])

  const chooseThinking = useCallback(async (level: ThinkingLevel): Promise<void> => {
    if (selectedId === null || !conversationReady) {
      setNewThinking(level)
      return
    }
    try {
      const value = await api.updateConversation(selectedId, { thinkingLevel: level })
      setDetail(value)
      detailRef.current = value
      updateConversation(value)
    } catch (cause) { announce(errorText(cause, t('更改思考等级失败', 'Could not change reasoning level'))) }
  }, [announce, conversationReady, selectedId, t, updateConversation])

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
        updateConversation(value)
        announce(t('会话工作区已更新', 'Conversation workspace updated'), true)
      } catch (cause) { announce(errorText(cause, t('无法切换会话工作区', 'Could not change the conversation workspace'))) }
      return
    }
    setNewWorkspaceId(workspaceId)
    try { await onSettingsChange({ defaultWorkspaceId: workspaceId }) }
    catch (cause) { announce(errorText(cause, t('无法保存默认工作区', 'Could not save the default workspace'))) }
  }, [announce, conversationReady, onSettingsChange, selectedId, t, updateConversation])

  const selectPreset = useCallback(async (selection: string): Promise<void> => {
    const presetId = selection === '__none' ? undefined : selection
    if (conversationReady && selectedId !== null) {
      try {
        const value = await api.updateConversation(selectedId, { presetId: presetId ?? null })
        setDetail(value)
        detailRef.current = value
        updateConversation(value)
        announce(t('会话预设已更新', 'Conversation preset updated'), true)
      } catch (cause) { announce(errorText(cause, t('无法切换 Agent 预设', 'Could not change agent preset'))) }
      return
    }
    setNewPresetId(presetId ?? null)
    try { await onSettingsChange({ defaultPresetId: presetId ?? null }) }
    catch (cause) { announce(errorText(cause, t('无法保存默认预设', 'Could not save the default preset'))) }
  }, [announce, conversationReady, onSettingsChange, selectedId, t, updateConversation])

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

  const addWorkspace = useCallback(async (input: { path: string; name?: string }): Promise<WorkspaceSummary> => {
    const result = await api.createWorkspace(input)
    setWorkspaces(current => [result.workspace, ...current.filter(workspace => workspace.id !== result.workspace.id)])
    setWorkspaceLoadError('')
    announce(t('工作区已添加', 'Workspace added'), true)
    return result.workspace
  }, [announce, t])

  const saveWorkspaceName = useCallback(async (workspace: WorkspaceSummary, name: string): Promise<void> => {
    try {
      const result = await api.renameWorkspace(workspace.id, { name })
      setWorkspaces(current => current.map(item => item.id === workspace.id ? result.workspace : item))
      announce(t('工作区名称已更新', 'Workspace name updated'), true)
    } catch (cause) { announce(errorText(cause, t('无法重命名工作区', 'Could not rename workspace'))) }
  }, [announce, t])

  const navigate = useCallback((next: MainPage, workspaceId?: string): void => {
    setPage(next)
    setChatView('chat')
    if (next === 'workspace' && workspaceId !== undefined) setWorkspacePageId(workspaceId)
    setSidebarOpen(false)
    if (mobile) requestAnimationFrame(() => { if (mainPanelRef.current !== null) focusWithoutRing(mainPanelRef.current) })
  }, [mobile])

  const openConversation = useCallback(async (id: string): Promise<void> => {
    setPage('chat')
    setChatView('chat')
    setSidebarOpen(false)
    if (!conversations.some(item => item.id === id)) await refreshList()
    setSelectedId(id)
  }, [conversations, refreshList])

  const openWorkspaceFile = useCallback(async (path: string, workspaceId = currentWorkspaceId): Promise<void> => {
    if (workspaceId === undefined) {
      announce(t('请先选择工作区', 'Choose a workspace first'))
      return
    }
    inspectorRequestId.current += 1
    const requestId = inspectorRequestId.current
    setInspectorOpen(true)
    setInspectorView('file')
    setInspectorFile(undefined)
    setInspectorDiff(undefined)
    setInspectorPlan(undefined)
    setInspectorError('')
    setInspectorLoading(true)
    try {
      const file = await api.getWorkspaceFile(workspaceId, path)
      const assetUrl = file.kind !== 'text'
        ? `/api/workspaces/${encodeURIComponent(workspaceId)}/asset?${new URLSearchParams({ path: file.path }).toString()}`
        : undefined
      if (requestId === inspectorRequestId.current) {
        setInspectorFile({ path: file.path, content: file.content ?? '', mimeType: file.mimeType, size: file.size, ...(assetUrl === undefined ? {} : { url: assetUrl }) })
      }
    } catch (cause) {
      if (requestId === inspectorRequestId.current) setInspectorError(errorText(cause, t('无法打开此文件', 'Could not open this file')))
    } finally { if (requestId === inspectorRequestId.current) setInspectorLoading(false) }
  }, [announce, currentWorkspaceId, t])

  const searchWorkspaceFiles = useCallback(async (needle: string): Promise<WorkspaceFileEntry[]> => {    const workspaceId = currentWorkspaceId
    if (workspaceId === undefined) return []
    const result = await api.searchWorkspaceFiles(workspaceId, needle)
    return result.entries
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
      await openConversation(result.conversationId)
    } catch (cause) { announce(errorText(cause, t('重新运行失败', 'Could not retry this response'))) }
  }, [announce, openConversation, selectedId, t])

  const updateQueue = useCallback(async (submissionId: string, input: Parameters<typeof api.updateQueued>[2]): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.updateQueued(selectedId, submissionId, input)
      announce(t('排队消息已更新', 'Queued message updated'), true)
    } catch (cause) { throw new ApiFailure(errorText(cause, t('无法更新排队消息', 'Could not update queued message')), cause instanceof ApiFailure ? cause.code : undefined) }
  }, [announce, selectedId, t])

  const copySessionId = useCallback(async (item: ConversationSummary): Promise<void> => {
    try {
      await navigator.clipboard.writeText(item.id)
      announce(t('Session ID 已复制', 'Session ID copied'), true)
    } catch (cause) { announce(errorText(cause, t('无法复制 Session ID', 'Could not copy the Session ID'))) }
  }, [announce, t])

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
      setChatView('chat')
      setSidebarOpen(false)
      announce(t('已创建分支会话', 'Forked conversation created'), true)
    } catch (cause) { announce(errorText(cause, t('创建分支失败', 'Could not fork this conversation'))) }
  }, [announce, t])

  /** DSH's session-log export: one JSON object per line, taken from the durable conversation. */
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

  const confirmDeleteWorkspace = useCallback(async (workspace: WorkspaceSummary): Promise<void> => {
    setDeleteWorkspace(undefined)
    try {
      await api.deleteWorkspace(workspace.id)
      announce(t(`已删除工作区 ${workspace.name}`, `Deleted workspace ${workspace.name}`), true)
      // The server rebound this workspace's sessions and its default; reload both views.
      await refreshWorkspaces()
      await refreshList()
    } catch (cause) { announce(errorText(cause, t('无法删除工作区', 'Could not delete the workspace'))) }
  }, [announce, refreshList, refreshWorkspaces, t])

  const filteredConversations = useMemo(() => conversations
    .filter(item => item.archived === showArchived)
    .filter(item => `${item.title}\n${item.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort(compareConversations), [conversations, query, showArchived])
  const sortedWorkspaces = useMemo(() => [...workspaces].sort((a, b) => workspaceSort === 'name'
    ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt), [workspaces, workspaceSort])
  const workspaceNeedle = query.trim().toLocaleLowerCase()
  const filteredWorkspaces = sortedWorkspaces.filter(workspace => workspaceNeedle === ''
    || `${workspace.name}\n${workspace.path}`.toLocaleLowerCase().includes(workspaceNeedle)
    || filteredConversations.some(item => item.workspaceId === workspace.id || item.workspaceId === undefined && item.cwd === workspace.path))
  const knownWorkspaceIds = useMemo(() => new Set(workspaces.map(workspace => workspace.id)), [workspaces])
  const ungrouped = filteredConversations.filter(item => item.workspaceId === undefined || !knownWorkspaceIds.has(item.workspaceId))
  const busy = activeConversation?.conversation.busy === true
  const activeDetail = activeConversation
  const hasMessages = (activeDetail?.messages.length ?? 0) > 0 || selectedPending.length > 0
  const hero = page === 'chat' && !detailLoading && !detailError && !hasMessages
  const showConversationHeader = page === 'chat' && hasMessages
  const showInspector = inspectorOpen || inspectorFile !== undefined || inspectorDiff !== undefined || inspectorPlan !== undefined || inspectorLoading || inspectorError !== ''
  /** The latest submitted plan of the open conversation, shared by the inspector view and the auto open. */
  const conversationPlan = useMemo(() => activeDetail === null
    ? undefined
    : latestPlan(activeDetail.interactions, activeDetail.messages), [activeDetail])

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
  const startNewConversation = useCallback((): void => {
    blankIntent.current = true
    setPage('chat')
    setChatView('chat')
    setSelectedId(null)
    setDetail(null)
    detailRef.current = null
    setNewModel(undefined)
    setNewThinking(settings.defaultThinkingLevel)
    setNewWorkspaceId(settings.defaultWorkspaceId)
    setNewPresetId(settings.defaultPresetId)
    setNewAccessMode(settings.defaultAccessMode)
    setInspectorFile(undefined)
    setInspectorDiff(undefined)
    setInspectorPlan(undefined)
    setInspectorOpen(false)
    inspectorRequestId.current += 1
    setSidebarOpen(false)
    if (mobile) requestAnimationFrame(() => { if (messagesViewport.current !== null) focusWithoutRing(messagesViewport.current) })
  }, [mobile, settings.defaultAccessMode, settings.defaultPresetId, settings.defaultThinkingLevel, settings.defaultWorkspaceId])

  /** DSH's workspace row action: start a session that already belongs to that workspace. */
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
        // DSH binds these to the session row the reader is on; pi-web applies them to the open one.
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
  }, [mobile, settings.shortcuts, startNewConversation, startRename, forkConversation, patchConversation])

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

  const renderSession = (item: ConversationSummary) => <SessionRow key={item.id} item={item} selected={item.id === selectedId}
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
    // DSH only offers removal while another workspace can take the rebound sessions.
    if (workspaces.length > 1) entries.push({ id: 'delete', label: t('删除工作区', 'Delete workspace'), icon: <IconTrashOutlineRegular size={14} /> })
    return entries
  }

  const closeInspector = (): void => {
    inspectorRequestId.current += 1
    setInspectorOpen(false)
    setInspectorFile(undefined)
    setInspectorDiff(undefined)
    setInspectorPlan(undefined)
    setInspectorError('')
    setInspectorLoading(false)
  }
  const toggleInspector = (): void => {
    if (showInspector) closeInspector()
    else setInspectorOpen(true)
  }
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
    setInspectorView('plan')
    setInspectorOpen(true)
    setInspectorError('')
    setInspectorLoading(false)
  }, [selectedId])

  // DSH opens each pending review once, automatically, and stops after the reader closes it
  // (`PlanCard.tsx:63-80` + `review-store.ts:12-22`). Pi keys the memory to the conversation,
  // so switching sessions resets it; a plan that is no longer pending never auto-opens.
  useEffect(() => {
    planAutoOpenedFor.current = null
  }, [selectedId])
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
          <Tooltip label={t('新建会话', 'New conversation')} side="bottom" portal>
            <Button variant="ghost" size="sm" aria-label={t('新建会话', 'New conversation')}
              icon={<IconNewChatOutlineRegular size={16} />} onClick={startNewConversation} />
          </Tooltip>
          {!mobile && <Tooltip label={sidebarCollapsed ? t('展开侧栏', 'Expand sidebar') : t('收起侧栏', 'Collapse sidebar')} side="bottom" portal>
            <Button variant="ghost" size="sm" aria-label={sidebarCollapsed ? t('展开侧栏', 'Expand sidebar') : t('收起侧栏', 'Collapse sidebar')}
              icon={<IconPanelLeftOutlineRegular size={15} />} onClick={() => { setSidebarCollapsed(value => !value) }} />
          </Tooltip>}
        </div>
        <Button variant="outline" className={css.newChat} icon={<IconNewChatOutlineRegular size={14} />} onClick={startNewConversation}>
          {t('新会话', 'New conversation')}
          <ShortcutKeys keys={shortcutKeyLabels(resolveShortcuts(settings.shortcuts).newConversation)} className={css.newChatKeys} />
        </Button>
        <nav className={css.quickNav} aria-label={t('管理页面', 'Management pages')}>
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
              ? conversations.filter(item => item.archived === showArchived && matchesWorkspace(item))
              : filteredConversations.filter(matchesWorkspace)).sort(compareConversations)
            const isExpanded = expandedWorkspaces.has(workspace.id) || currentWorkspaceId === workspace.id || workspaceNeedle !== ''
            const viewEntries = workspaceActions(workspace)
            return <div className={css.workspaceGroup} key={workspace.id}>
              <div className={css.workspaceRow} data-selected={workspace.id === currentWorkspaceId || undefined}>
                <button type="button" className={css.workspaceToggle} aria-label={workspace.name} aria-expanded={isExpanded} onClick={() => {
                  setExpandedWorkspaces(current => { const next = new Set(current); if (next.has(workspace.id)) next.delete(workspace.id); else next.add(workspace.id); return next })
                }}>
                  <IconChevronRightOutlineRegular className={isExpanded ? css.chevronOpen : ''} size={13} />
                  {isExpanded ? <IconFolderOpenOutlineRegular size={16} /> : <IconFolderCloseRegular size={16} />}
                  <span className={css.workspaceName}>{workspace.name}</span>
                </button>
                <span className={css.rowActions} onClick={event => { event.stopPropagation() }}>
                <Menu open={workspaceMenuId === workspace.id} onClose={() => { setWorkspaceMenuId(null) }} items={viewEntries} portal
                  onSelect={id => {
                    setWorkspaceMenuId(null)
                    if (id === 'select') void selectWorkspace(workspace.id)
                    else if (id === 'browse') navigate('workspace', workspace.id)
                    else if (id === 'rename') setRenameWorkspace(workspace)
                    else if (id === 'delete') setDeleteWorkspace(workspace)
                  }} anchor={<button type="button" className={css.rowIconButton}
                    aria-label={t(`工作区“${workspace.name}”的操作`, `Actions for ${workspace.name}`)}
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
        {mobile && !showConversationHeader && <button type="button" className={css.mobileSidebarButton}
          aria-label={t('打开会话列表', 'Open conversation list')} onClick={() => { setSidebarOpen(true) }}>
          <IconPanelLeftOutlineRegular size={16} />
        </button>}
        <div className={`${css.mainBody} ${showInspector ? css.withInspector : ''}`}>
          <div className={css.primaryPanel}>
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
                      onOpen={childId => { selectConversation(childId) }}
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
                <nav className={css.chatTabs} aria-label={t('会话视图', 'Conversation views')}>
                  <button type="button" aria-current={chatView === 'chat' ? 'page' : undefined} data-selected={chatView === 'chat' || undefined}
                    onClick={() => { setChatView('chat') }}>{t('对话', 'Chat')}</button>
                  <button type="button" aria-current={chatView === 'trajectory' ? 'page' : undefined} data-selected={chatView === 'trajectory' || undefined}
                    onClick={() => { setChatView('trajectory') }}>{t('轨迹', 'Trajectory')}</button>
                </nav>
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
                  <div className={css.heroArea}>
                  <Composer hero value={draft} images={images} catalog={catalog} model={selectedModel} thinkingLevel={thinkingLevel}
                    busy={false} disabled={detailLoading} queue={[]} sendMode={sendMode} sending={sending}
                    workspace={currentWorkspace} workspaces={workspaces} presets={presets} presetId={selectedPresetId} accessMode={accessMode}
                    accessModes={accessModes} files={[]}
                    plan={newPlan} onPlan={active => { void setPlan(active) }}
                    onChange={setDraft} onAddImages={addImages} onRemoveImage={removeImage} onRetryImage={retryImage} onSend={mode => { void send(mode) }}
                    onStop={() => { void stop() }} onRemoveQueue={id => { void removeQueue(id) }}
                    onSelectModel={model => { void chooseModel(model) }} onThinkingLevel={level => { void chooseThinking(level) }}
                    onSendMode={setSendMode} onSelectWorkspace={id => { void selectWorkspace(id) }} onAddWorkspace={() => { void addWorkspaceFromPicker() }}
                    onSelectPreset={id => { void selectPreset(id) }} onAccessMode={mode => { void selectAccessMode(mode) }}
                    onOpenSettings={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }} onNewConversation={startNewConversation}
                    onSearchFiles={searchWorkspaceFiles} onPreviewFile={path => { void openWorkspaceFile(path) }} />
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
                  {activeDetail !== null && <div className={css.chatLayout}>
                    <div className={css.messagesViewport} ref={messagesViewport} tabIndex={-1} onScroll={event => {
                      const element = event.currentTarget
                      wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 88
                    }}>
                      {chatView === 'chat'
                        ? <Transcript messages={activeDetail.messages} pending={selectedPending} interactions={activeDetail.interactions}
                          onFork={entryId => { void forkFrom(entryId) }} onRetry={entryId => { void retryEntry(entryId) }}
                          onFeedback={(entryId, rating) => { void submitFeedback(entryId, rating) }}
                          onOpenFile={(path, line) => { void openWorkspaceFile(path).then(() => {
                            if (line !== undefined) setInspectorFile(current => current === undefined ? undefined : { ...current, line })
                          }) }}
                          resolveFileImage={path => currentWorkspaceId === undefined ? undefined
                            : `/api/workspaces/${encodeURIComponent(currentWorkspaceId)}/asset?${new URLSearchParams({ path }).toString()}`}
                          onInspectDiff={diff => { inspectorRequestId.current += 1; setInspectorOpen(true); setInspectorView('diff'); setInspectorFile(undefined); setInspectorDiff(diff); setInspectorPlan(undefined); setInspectorError(''); setInspectorLoading(false) }}
                          onOpenSubagent={childId => { selectConversation(childId) }}
                          onOpenPlan={plan => { openPlan(plan) }}
                          onOpenTool={() => { setChatView('trajectory') }} />
                        : <TrajectoryView messages={activeDetail.messages}
                          onJumpToMessage={messageId => {
                            setChatView('chat')
                            requestAnimationFrame(() => document.getElementById(transcriptMessageDomId(messageId))?.scrollIntoView({ block: 'center' }))
                          }} onOpenTool={messageId => {
                            setChatView('chat')
                            requestAnimationFrame(() => document.getElementById(transcriptMessageDomId(messageId))?.scrollIntoView({ block: 'center' }))
                          }} />}
                    </div>
                    {catalogError !== '' && <div className={css.catalogNotice} role="status"><span>{catalogError}</span>
                      <button type="button" onClick={() => { void refreshCatalog() }}>{t('重试', 'Retry')}</button></div>}
                    <GoalBar goal={activeDetail.goal} onSetState={(action, payload) => { void updateGoal(action, payload) }} />
                    <TodoPanel todos={activeDetail.todos} />
                    <QuestionComposer conversationId={activeDetail.conversation.id} interactions={activeDetail.interactions}
                      onDismiss={focusComposer}
                      onOpenPlan={plan => { openPlan(plan) }}
                      onAnswered={value => {
                        detailRef.current = value
                        setDetail(value)
                        setDetailError('')
                        updateConversation(value)
                      }} />
                    <Composer value={draft} images={images} catalog={catalog} model={selectedModel} thinkingLevel={thinkingLevel}
                      busy={busy} disabled={detailLoading || !conversationReady && detailError === ''} queue={activeDetail.queue}
                      sendMode={sendMode} sending={sending} workspace={currentWorkspace} workspaces={workspaces} presets={presets}
                      presetId={selectedPresetId} accessMode={accessMode} accessModes={accessModes}
                      plan={activeDetail === null ? newPlan : activeDetail.plan?.active === true} onPlan={active => { void setPlan(active) }}
                      files={[]} stats={conversationStats(activeDetail.messages)}
                      onChange={setDraft} onAddImages={addImages} onRemoveImage={removeImage} onRetryImage={retryImage} onSend={mode => { void send(mode) }}
                      onStop={() => { void stop() }} onRemoveQueue={id => { void removeQueue(id) }}
                      onSelectModel={model => { void chooseModel(model) }} onThinkingLevel={level => { void chooseThinking(level) }}
                      onSendMode={setSendMode} onSelectWorkspace={id => { void selectWorkspace(id) }} onAddWorkspace={() => { void addWorkspaceFromPicker() }}
                      onSelectPreset={id => { void selectPreset(id) }} onAccessMode={mode => { void selectAccessMode(mode) }}
                      onUpdateQueue={updateQueue} onOpenSettings={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }}
                      onCompact={() => { void compact() }}
                      onNewConversation={startNewConversation} onSearchFiles={searchWorkspaceFiles} onPreviewFile={path => { void openWorkspaceFile(path) }} />
                  </div>}
                </>}
            </>}
            {page === 'automations' && <AutomationsPage workspaceId={currentWorkspaceId} presetId={selectedPresetId}
              onOpenConversation={id => { void openConversation(id) }} />}
            {page === 'workspace' && (workspaces.find(item => item.id === workspacePageId) === undefined
              ? <div className={css.contentState}>{t('请选择一个工作区', 'Choose a workspace')}</div>
              : <WorkspaceBrowserPage workspace={workspaces.find(item => item.id === workspacePageId)!}
                onOpenFile={path => { void openWorkspaceFile(path, workspacePageId ?? undefined) }} />)}
          </div>
          {showInspector && <aside className={css.inspectorPane} aria-label={t('文件检查器', 'File inspector')}>
            <Inspector file={inspectorFile} diff={inspectorDiff} plan={inspectorPlan ?? conversationPlan ?? null}
              view={inspectorView} onView={setInspectorView}
              loading={inspectorLoading} error={inspectorError}
              onClose={closeInspector} />
          </aside>}
        </div>
      </section>
      <SettingsDialog open={settingsOpen} catalog={catalog} saving={savingProvider} settings={settings} accessModes={accessModes}
        initialTab={settingsInitialTab} onSettingsChange={onSettingsChange} onRefreshCatalog={refreshCatalog}
        presetsPanel={<PresetsPanel presets={presets} models={catalog?.models ?? []} defaultPresetId={settings.defaultPresetId}
          loading={presetsLoading} error={presetLoadError} onRefresh={() => { void refreshPresets() }}
          onChange={setPresets} onSetDefault={id => { void onSettingsChange({ defaultPresetId: id ?? null }).catch(cause => { announce(errorText(cause, t('无法保存默认预设', 'Could not save the default preset'))) }) }} />}
        onClose={() => { setSettingsOpen(false) }} onSave={saveProvider} activeProvider={selectedModel?.provider} />
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
    // DSH's hover card: the dark menu material beside the row with its title, relative time and state.
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
                <span className={css.sessionSlot}>{item.busy && <span className={css.sessionBusy} aria-label={t('正在运行', 'Running')} />}</span>
                <span className={css.sessionTitle}>{item.title || t('新对话', 'New conversation')}</span>
              </button>
              <time className={css.sessionMeta} dateTime={new Date(item.updatedAt).toISOString()}>{formatUpdated(item.updatedAt, settings.locale)}</time>
              {/* The pin state stays on the row itself; every other action lives in the trailing menu. */}
              {item.pinned && <span className={css.sessionPin} role="img" aria-label={t('已置顶', 'Pinned')} title={t('已置顶', 'Pinned')}><IconPinFillRegular size={14} /></span>}
              {/* DSH swaps the trailing time cell for the row's action strip while the row is hovered. */}
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

function SessionSkeleton() {  const { t } = useUiPreferences()
  return <div className={css.skeleton} aria-label={t('正在加载会话', 'Loading conversations')}>
    <span /><span /><span />
  </div>
}

function LoadingConversation() {
  const { t } = useUiPreferences()
  return <div className={css.loadingState} role="status"><span className={css.spinner} />{t('正在载入会话', 'Loading conversation')}</div>
}

function compareConversations(a: ConversationSummary, b: ConversationSummary): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt
}

/** Initial-letter avatar for the local account row, standing in for DSH's account image. */
function accountInitial(name: string): string {
  const first = [...name.trim()][0]
  return first === undefined ? 'π' : first.toLocaleUpperCase()
}

/** Session row trailing label in DSH's relative buckets, so two surfaces naming the same row agree. */
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

/** DSH's hover-card time line: the same buckets as the row, read as "23天前" instead of a cell label. */
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
