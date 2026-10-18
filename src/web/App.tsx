import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Button, ConnectionIndicator, IconArchiveOutlineRegular, IconChevronRightOutlineRegular,
  IconClockOutlineRegular, IconCordisPluginOutlineRegular, IconDarkOutlineRegular,
  IconEllipsisOutlineRegular, IconFollowsystemOutlineRegular, IconFolderCloseRegular,
  IconFolderOpenOutlineRegular, IconLightOutlineRegular, IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular, IconPinFillRegular, IconPinOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular,
  IconSlidersTwoOutlineRegular, IconUnarchiveOutlineRegular, IconWorkspaceTreeOutlineRegular,
  Input, Menu, Toast, Tooltip, focusWithoutRing,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccessMode, AgentPreset, AppSettings, ConversationDetail, ConversationSummary, ModelCatalog,
  ModelOption, PluginSummary, ProviderInput, ThinkingLevel, WorkspaceFileEntry, WorkspaceSummary,
  UpdateAppSettingsInput,
} from '../shared/types.ts'
import { ApiFailure, api } from './api.ts'
import Composer, { type BusySendMode, type DraftImage } from './Composer.tsx'
import SettingsDialog from './SettingsDialog.tsx'
import Transcript, { type PendingMessage } from './transcript.tsx'
import TrajectoryView, { transcriptMessageDomId } from './TrajectoryView.tsx'
import Inspector from './Inspector.tsx'
import type { InspectorDiff, InspectorFile } from './Inspector.tsx'
import WorkspaceBrowserPage from './WorkspaceBrowserPage.tsx'
import WorkspaceDialog from './WorkspaceDialog.tsx'
import WorkspaceRenameDialog from './WorkspaceRenameDialog.tsx'
import PluginsPage, { PluginsPanel } from './PluginsPage.tsx'
import AutomationsPage from './AutomationsPage.tsx'
import PresetsPanel from './PresetsPanel.tsx'
import { matchesShortcut, resolveShortcuts } from './keyboard.ts'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider, useUiPreferences } from './ui-preferences.tsx'
import css from './App.module.css'

type ConnectionState = 'connecting' | 'disconnected' | 'recovered' | undefined
type MainPage = 'chat' | 'plugins' | 'automations' | 'workspace'
type ChatView = 'chat' | 'trajectory'
type WorkspaceSort = 'recent' | 'name'
interface ScopedDraft { scope: string; text: string }
interface ScopedImages { scope: string; items: DraftImage[] }
interface PendingSubmission extends PendingMessage { conversationId: string }
interface ToastMessage { id: number; text: string; success?: boolean }

const SELECTED_KEY = 'pi-durable-web:selected-conversation'
const DRAFT_PREFIX = 'pi-durable-web:draft:'
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_IMAGE_COUNT = 4
const MAX_FILE_COUNT = 8
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

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
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [accessModes, setAccessModes] = useState<AccessMode[]>([])
  const [workspaceLoadError, setWorkspaceLoadError] = useState('')
  const [pluginLoadError, setPluginLoadError] = useState('')
  const [presetLoadError, setPresetLoadError] = useState('')
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [pluginsLoading, setPluginsLoading] = useState(true)
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
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'models' | 'plugins' | 'presets'>('general')
  const [savingProvider, setSavingProvider] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [page, setPage] = useState<MainPage>('chat')
  const [workspacePageId, setWorkspacePageId] = useState<string | null>(null)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set())
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [renameWorkspace, setRenameWorkspace] = useState<WorkspaceSummary | null>(null)
  const [chatView, setChatView] = useState<ChatView>('chat')
  const [inspectorFile, setInspectorFile] = useState<InspectorFile | undefined>()
  const [inspectorDiff, setInspectorDiff] = useState<InspectorDiff | undefined>()
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorLoading, setInspectorLoading] = useState(false)
  const [inspectorError, setInspectorError] = useState('')
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>(undefined)
  const [reconnectToken, setReconnectToken] = useState(0)
  const [pending, setPending] = useState<PendingSubmission[]>([])
  const [draftState, setDraftState] = useState<ScopedDraft>({ scope: '__new__', text: loadDraft('__new__') })
  const [imageState, setImageState] = useState<ScopedImages>({ scope: '__new__', items: [] })
  const [newModel, setNewModel] = useState<{ provider: string; modelId: string } | undefined>(undefined)
  const [newThinking, setNewThinking] = useState<ThinkingLevel>(settings.defaultThinkingLevel)
  const [newWorkspaceId, setNewWorkspaceId] = useState<string | undefined>(settings.defaultWorkspaceId)
  const [newPresetId, setNewPresetId] = useState<string | null | undefined>(settings.defaultPresetId)
  const [newAccessMode, setNewAccessMode] = useState<AccessMode>(settings.defaultAccessMode)
  const [sendMode, setSendMode] = useState<BusySendMode>('followUp')
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const mainPanelRef = useRef<HTMLElement | null>(null)
  const sidebarTriggerRef = useRef<HTMLButtonElement | null>(null)
  const workspaceSearchRef = useRef<HTMLInputElement | null>(null)
  const messagesViewport = useRef<HTMLDivElement | null>(null)
  const inspectorRequestId = useRef(0)
  const wasAtBottom = useRef(true)
  const submitLock = useRef(false)
  const detailRef = useRef<ConversationDetail | null>(null)
  const initialListLoad = useRef(true)
  const blankIntent = useRef(false)
  const selectedIdRef = useRef<string | null>(selectedId)
  selectedIdRef.current = selectedId
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const translateRef = useRef(t)
  translateRef.current = t
  const toastSequence = useRef(0)
  const activeScope = selectedId === null ? '__new__' : selectedId
  const draft = draftState.scope === activeScope ? draftState.text : ''
  const images = imageState.scope === activeScope ? imageState.items : []
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
    setConversations(existing => [summary, ...existing.filter(item => item.id !== summary.id)]
      .sort(compareConversations))
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

  const refreshPlugins = useCallback(async (): Promise<void> => {
    setPluginsLoading(true)
    try {
      const result = await api.listPlugins()
      setPlugins(result.plugins)
      setPluginLoadError('')
    } catch (cause) { setPluginLoadError(errorText(cause, t('无法读取插件', 'Could not load plugins'))) }
    finally { setPluginsLoading(false) }
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
    void refreshPlugins()
    void refreshCapabilities()
  }, [refreshCapabilities, refreshCatalog, refreshList, refreshPlugins, refreshPresets, refreshWorkspaces])

  useEffect(() => {
    const scope = selectedId ?? '__new__'
    wasAtBottom.current = true
    detailRef.current = null
    setDraftState({ scope, text: loadDraft(scope) })
    setImageState({ scope, items: [] })
    setDetail(null)
    setDetailError('')
    setNewModel(undefined)
    const preferences = settingsRef.current
    setNewThinking(preferences.defaultThinkingLevel)
    setNewWorkspaceId(preferences.defaultWorkspaceId)
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
    setConnection('connecting')
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
      setConnection(state === 'error' ? 'disconnected' : state === 'open' ? 'recovered' : 'connecting')
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
    const activeUrls = new Set(images.map(image => image.preview))
    for (const item of pending) for (const image of item.images) activeUrls.add(image.preview)
    // Draft previews removed from the composer are released immediately; accepted previews stay alive until SSE echoes them.
    const keep = activeUrls
    for (const url of objectUrls.current) {
      if (!keep.has(url)) {
        URL.revokeObjectURL(url)
        objectUrls.current.delete(url)
      }
    }
  }, [images, pending])

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
    setConversations(existing => [created.conversation, ...existing.filter(item => item.id !== created.conversation.id)]
      .sort(compareConversations))
    setDetail(created)
    detailRef.current = created
    setSelectedId(created.conversation.id)
    setPage('chat')
    setChatView('chat')
    setSidebarOpen(false)
    return created
  }, [newAccessMode, newPresetId, newWorkspaceId, selectedModel, thinkingLevel, t, workspaces])

  const setDraft = useCallback((value: string): void => {
    setDraftState({ scope: activeScope, text: value })
  }, [activeScope])

  const addImages = useCallback((files: FileList | File[]): void => {
    const selected = Array.from(files)
    const existing = imageState.scope === activeScope ? imageState.items : []
    const existingImages = existing.filter(image => IMAGE_MIME_TYPES.has(image.mimeType.toLocaleLowerCase())).length
    const existingFiles = existing.length - existingImages
    const selectedImages = selected.filter(file => IMAGE_MIME_TYPES.has(file.type.toLocaleLowerCase()))
    const selectedFiles = selected.length - selectedImages.length
    if (existingImages + selectedImages.length > MAX_IMAGE_COUNT) {
      announce(t('一条消息最多添加 4 张图片', 'A message can include up to 4 images'))
      return
    }
    if (existingFiles + selectedFiles > MAX_FILE_COUNT) {
      announce(t('一条消息最多添加 8 个文件', 'A message can include up to 8 files'))
      return
    }
    if (selected.some(file => file.size === 0)) {
      announce(t('不能添加空文件', 'Empty files cannot be attached'))
      return
    }
    if (selectedImages.some(file => file.size > MAX_IMAGE_BYTES)) {
      announce(t('每张图片不能超过 4 MiB', 'Each image must be 4 MiB or smaller'))
      return
    }
    if (selectedFiles > 0 && selected.some(file => !IMAGE_MIME_TYPES.has(file.type.toLocaleLowerCase()) && file.size > MAX_FILE_BYTES)) {
      announce(t('单个文件不能超过 8 MiB', 'Each file must be 8 MiB or smaller'))
      return
    }
    const currentBytes = existing.reduce((sum, image) => sum + image.file.size, 0)
    const selectedBytes = selected.reduce((sum, file) => sum + file.size, 0)
    if (currentBytes + selectedBytes > MAX_ATTACHMENT_BYTES) {
      announce(t('一条消息的附件总大小不能超过 8 MiB', 'Attachments in one message cannot exceed 8 MiB total'))
      return
    }
    const pendingImages = selected.map(file => {
      const preview = URL.createObjectURL(file)
      objectUrls.current.add(preview)
      return { id: crypto.randomUUID(), file, preview, mimeType: file.type || 'application/octet-stream' }
    })
    void Promise.all(pendingImages.map(async image => ({ ...image, data: await fileData(image.file, t) }))).then(newImages => {
      setImageState(current => ({
        scope: activeScope,
        items: [...(current.scope === activeScope ? current.items : []), ...newImages],
      }))
    }).catch(cause => {
      for (const image of pendingImages) {
        URL.revokeObjectURL(image.preview)
        objectUrls.current.delete(image.preview)
      }
      announce(errorText(cause, t('无法读取附件', 'Could not read attachment')))
    })
  }, [activeScope, announce, imageState, t])

  const removeImage = useCallback((id: string): void => {
    setImageState(current => {
      const item = current.items.find(image => image.id === id)
      if (item !== undefined) {
        URL.revokeObjectURL(item.preview)
        objectUrls.current.delete(item.preview)
      }
      return { scope: activeScope, items: current.items.filter(image => image.id !== id) }
    })
  }, [activeScope])

  const send = useCallback(async (requestedMode?: BusySendMode): Promise<void> => {
    const text = draftState.scope === activeScope ? draftState.text : ''
    const attachments = imageState.scope === activeScope ? imageState.items : []
    if ((text.trim() === '' && attachments.length === 0) || submitLock.current) return
    submitLock.current = true
    setSending(true)
    let targetId = selectedId
    let target = detail?.conversation.id === selectedId ? detail : null
    const requestId = crypto.randomUUID()
    let pendingId = `pending:${requestId}`
    const firstPending: PendingSubmission = {
      id: pendingId,
      requestId,
      conversationId: targetId ?? '__creating__',
      text,
      images: attachments.map(image => ({ name: image.file.name, preview: image.preview, mimeType: image.mimeType })),
      status: 'sending',
    }
    setPending(existing => [...existing, firstPending])
    setDraftState({ scope: activeScope, text: '' })
    setImageState({ scope: activeScope, items: [] })
    try {
      if (targetId === null) {
        const title = text.trim().split(/\r?\n/u)[0]?.slice(0, 44) || t('文件对话', 'File conversation')
        target = await createConversation(title)
        targetId = target.conversation.id
        setDraftState({ scope: targetId, text: '' })
        setImageState({ scope: targetId, items: [] })
        setPending(existing => existing.map(item => item.id === pendingId ? { ...item, conversationId: targetId as string } : item))
      }
      if (targetId === null) throw new Error(t('未能创建会话', 'Could not create conversation'))
      const imageAttachments = attachments.filter(item => IMAGE_MIME_TYPES.has(item.mimeType.toLocaleLowerCase()))
      const fileAttachments = attachments.filter(item => !IMAGE_MIME_TYPES.has(item.mimeType.toLocaleLowerCase()))
      const result = await api.submit(targetId, {
        text,
        requestId,
        ...(target?.conversation.busy ? { whenBusy: requestedMode ?? sendMode } : {}),
        ...(imageAttachments.length === 0 ? {} : { images: imageAttachments.map(image => ({ data: image.data, mimeType: image.mimeType })) }),
        ...(fileAttachments.length === 0 ? {} : { files: fileAttachments.map(file => ({ name: file.file.name, mimeType: file.mimeType, data: file.data })) }),
      })
      pendingId = `pending:${requestId}`
      const accepted: PendingSubmission = {
        ...firstPending,
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
        setDraftState(current => ({ scope: targetId as string, text: current.scope === targetId && current.text !== ''
          ? `${text}\n${current.text}` : text }))
        setImageState(current => ({ scope: targetId as string, items: [
          ...attachments,
          ...(current.scope === targetId ? current.items : []),
        ] }))
      } else {
        setDraftState(current => ({ scope: activeScope, text: current.scope === activeScope && current.text !== ''
          ? `${text}\n${current.text}` : text }))
        setImageState(current => ({ scope: activeScope, items: [...attachments, ...(current.scope === activeScope ? current.items : [])] }))
      }
      announce(errorText(cause, t('消息发送失败，输入内容已保留', 'Message failed to send. Your draft has been restored')))
    } finally {
      submitLock.current = false
      setSending(false)
    }
  }, [activeScope, announce, createConversation, detail, draftState, imageState, selectedId, sendMode, t])

  const stop = useCallback(async (): Promise<void> => {
    if (selectedId === null) return
    try {
      await api.stop(selectedId)
      announce(t('已停止运行。排队消息已保留，发送下一条消息即可继续处理', 'Stopped. Queued messages are preserved; send another message to continue them'), true)
    } catch (cause) { announce(errorText(cause, t('停止失败', 'Could not stop'))) }
  }, [announce, selectedId, t])

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

  const setPlugin = useCallback(async (pluginId: string, patch: { enabled?: boolean; tools?: Record<string, boolean> }): Promise<void> => {
    try {
      const result = await api.updatePlugin(pluginId, patch)
      setPlugins(current => current.map(item => item.id === pluginId ? result.plugin : item))
      setPluginLoadError('')
    } catch (cause) {
      const message = errorText(cause, t('插件设置失败', 'Plugin update failed'))
      setPluginLoadError(message)
      announce(message)
    }
  }, [announce, t])

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
    setInspectorFile(undefined)
    setInspectorDiff(undefined)
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

  const searchWorkspaceFiles = useCallback(async (needle: string): Promise<WorkspaceFileEntry[]> => {
    const workspaceId = currentWorkspaceId
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

  const copyConversation = useCallback(async (item: ConversationSummary): Promise<void> => {
    try {
      const conversation = detailRef.current?.conversation.id === item.id ? detailRef.current : await api.getConversation(item.id)
      const content = conversation.messages.map(message => {
        const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role === 'tool' ? `Tool: ${message.toolName ?? ''}` : 'System'
        const body = message.blocks.map(block => block.type === 'text' || block.type === 'thinking' ? block.text
          : block.type === 'toolCall' ? `\n\`\`\`json\n${JSON.stringify(block.arguments, null, 2)}\n\`\`\``
            : block.type === 'file' ? `[${block.name}](${block.path})` : `[${t('图片', 'Image')}]`).join('')
        return `## ${label}\n\n${body}`
      }).join('\n\n')
      await navigator.clipboard.writeText(`# ${item.title}\n\n${content}`)
      announce(t('对话内容已复制', 'Conversation copied'), true)
    } catch (cause) { announce(errorText(cause, t('无法复制对话内容', 'Could not copy the conversation'))) }
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
  const showInspector = inspectorOpen || inspectorFile !== undefined || inspectorDiff !== undefined || inspectorLoading || inspectorError !== ''

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
    setInspectorOpen(false)
    inspectorRequestId.current += 1
    setSidebarOpen(false)
    if (mobile) requestAnimationFrame(() => { if (messagesViewport.current !== null) focusWithoutRing(messagesViewport.current) })
  }, [mobile, settings.defaultAccessMode, settings.defaultPresetId, settings.defaultThinkingLevel, settings.defaultWorkspaceId])

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
      }
    }
    document.addEventListener('keydown', onShortcut, true)
    return () => { document.removeEventListener('keydown', onShortcut, true) }
  }, [mobile, settings.shortcuts, startNewConversation])

  const sessionMenuEntries = (item: ConversationSummary): MenuEntry[] => [
    { id: 'rename', label: t('重命名', 'Rename') },
    { id: 'copy', label: t('复制对话内容', 'Copy conversation') },
    { id: 'fork', label: t('从最后一条消息分叉', 'Fork from latest message') },
    { id: 'pin', label: item.pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin'), icon: item.pinned ? <IconPinOutlineRegular size={14} /> : <IconPinFillRegular size={14} /> },
    { id: 'archive', label: item.archived ? t('移出归档', 'Unarchive') : t('归档', 'Archive'), icon: item.archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} /> },
  ]

  const renderSession = (item: ConversationSummary) => <SessionRow key={item.id} item={item} selected={item.id === selectedId}
    editing={editingId === item.id} editTitle={editTitle} menuOpen={rowMenuId === item.id}
    onSelect={() => { selectConversation(item.id) }} onEditTitle={setEditTitle}
    onSaveTitle={() => { saveRename(item.id) }} onCancelTitle={() => { setEditingId(null) }}
    onToggleMenu={() => { setRowMenuId(current => current === item.id ? null : item.id) }} onMenuClose={() => { setRowMenuId(null) }}
    actions={sessionMenuEntries(item)} onAction={action => {
      setRowMenuId(null)
      if (action === 'rename') startRename(item)
      else if (action === 'copy') void copyConversation(item)
      else if (action === 'fork') void forkConversation(item)
      else if (action === 'pin') void patchConversation(item.id, { pinned: !item.pinned })
      else if (action === 'archive') void patchConversation(item.id, { archived: !item.archived })
    }} />

  const workspaceActions = (workspace: WorkspaceSummary): MenuEntry[] => [
    { id: 'select', label: t('设为当前工作区', 'Use this workspace') },
    { id: 'browse', label: t('浏览文件', 'Browse files') },
    { id: 'rename', label: t('重命名', 'Rename') },
  ]

  const closeInspector = (): void => {
    inspectorRequestId.current += 1
    setInspectorOpen(false)
    setInspectorFile(undefined)
    setInspectorDiff(undefined)
    setInspectorError('')
    setInspectorLoading(false)
  }
  const toggleInspector = (): void => {
    if (showInspector) closeInspector()
    else setInspectorOpen(true)
  }

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
            <span className={css.brandName}><strong>Pi Durable</strong><small>{t('本机工作区', 'LOCAL WORKSPACE')}</small></span>
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
        <Button variant="outline" className={css.newChat} icon={<IconNewChatOutlineRegular size={15} />} onClick={startNewConversation}>
          {t('新会话', 'New conversation')}
        </Button>
        <nav className={css.quickNav} aria-label={t('管理页面', 'Management pages')}>
          <button type="button" className={css.navItem} data-active={page === 'plugins' || undefined}
            aria-label={t('插件', 'Plugins')} aria-current={page === 'plugins' ? 'page' : undefined} onClick={() => { navigate('plugins') }}>
            <IconCordisPluginOutlineRegular size={16} /><span>{t('插件', 'Plugins')}</span>
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
                { id: 'recent', label: t('按最近活动排序', 'Sort by recent activity') },
                { id: 'name', label: t('按名称排序', 'Sort by name') },
                { id: 'archived', label: showArchived ? t('显示最近会话', 'Show active conversations') : t('显示已归档会话', 'Show archived conversations'), icon: showArchived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} /> },
              ]} portal compact anchor={<Tooltip label={t('视图选项', 'View options')} side="top" portal>
                <Button variant="ghost" size="sm" aria-label={t('视图选项', 'View options')} icon={<IconSlidersTwoOutlineRegular size={15} />}
                  onClick={() => { setThemeMenuOpen(value => !value) }} />
              </Tooltip>} />
            <Tooltip label={t('添加工作区', 'Add workspace')} side="top" portal>
              <Button variant="ghost" size="sm" aria-label={t('添加工作区', 'Add workspace')} icon={<IconPlusOutlineRegular size={15} />}
                onClick={() => { setWorkspaceDialogOpen(true) }} />
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
                <Menu open={workspaceMenuId === workspace.id} onClose={() => { setWorkspaceMenuId(null) }} items={viewEntries} portal compact
                  onSelect={id => {
                    setWorkspaceMenuId(null)
                    if (id === 'select') void selectWorkspace(workspace.id)
                    else if (id === 'browse') navigate('workspace', workspace.id)
                    else if (id === 'rename') setRenameWorkspace(workspace)
                  }} anchor={<Tooltip label={t('工作区操作', 'Workspace actions')} side="top" portal>
                    <button type="button" className={css.rowMenuButton} aria-label={t(`工作区操作：${workspace.name}`, `Workspace actions: ${workspace.name}`)}
                      onClick={() => { setWorkspaceMenuId(value => value === workspace.id ? null : workspace.id) }}><IconEllipsisOutlineRegular size={15} /></button>
                  </Tooltip>} />
              </div>
              {isExpanded && <div className={css.workspaceSessions}>
                {sessions.map(renderSession)}
                {sessions.length === 0 && <span className={css.emptySessions}>{query.trim() !== '' ? t('没有匹配的会话', 'No matching conversations') : t('暂无会话', 'No conversations')}</span>}
              </div>}
            </div>
          })}
          {ungrouped.length > 0 && <div className={css.workspaceGroup}>
            <div className={css.workspaceLabel}><IconWorkspaceTreeOutlineRegular size={15} /><span>{t('未分组', 'Ungrouped')}</span></div>
            <div className={css.workspaceSessions}>{ungrouped.map(renderSession)}</div>
          </div>}
          {!workspaceLoading && filteredConversations.length === 0 && query.trim() !== '' && <p className={css.listEmpty}>{t('没有匹配的会话', 'No matching conversations')}</p>}
          {!listLoading && listError !== '' && <div className={css.listNotice} role="alert"><span>{listError}</span>
            <button type="button" onClick={() => { setListLoading(true); void refreshList() }}>{t('重试', 'Retry')}</button></div>}
        </div>
        <div className={css.sidebarFoot}>
          <Menu open={moreMenuOpen} onClose={() => { setMoreMenuOpen(false) }} onSelect={id => {
            setMoreMenuOpen(false)
            if (id === 'settings') { setSettingsInitialTab('general'); setSettingsOpen(true) }
            else if (id === 'models') { setSettingsInitialTab('models'); setSettingsOpen(true) }
            else if (id === 'theme-system' || id === 'theme-light' || id === 'theme-dark') {
              const theme = id.slice('theme-'.length) as AppSettings['theme']
              void onSettingsChange({ theme }).catch(cause => { announce(errorText(cause, t('无法更改外观', 'Could not change appearance'))) })
            } else if (id === 'plugins') navigate('plugins')
            else if (id === 'automations') navigate('automations')
          }} items={[
            { id: 'settings', label: t('设置', 'Settings'), icon: <IconSettingsOutlineRegular size={15} /> },
            { id: 'models', label: t('模型配置', 'Model settings') },
            { id: 'plugins', label: t('插件', 'Plugins'), icon: <IconCordisPluginOutlineRegular size={15} /> },
            { id: 'automations', label: t('自动化任务', 'Automations'), icon: <IconClockOutlineRegular size={15} /> },
            { id: 'theme-system', label: t('跟随系统外观', 'Follow system appearance'), icon: <IconFollowsystemOutlineRegular size={15} /> },
            { id: 'theme-light', label: t('浅色外观', 'Light appearance'), icon: <IconLightOutlineRegular size={15} /> },
            { id: 'theme-dark', label: t('深色外观', 'Dark appearance'), icon: <IconDarkOutlineRegular size={15} /> },
          ]} portal compact anchor={<Tooltip label={t('更多', 'More')} side="top" portal>
            <button type="button" className={css.moreButton} aria-label={t('更多', 'More')} aria-expanded={moreMenuOpen} onClick={() => { setMoreMenuOpen(value => !value) }}>
              <IconEllipsisOutlineRegular size={16} /><span>{t('更多', 'More')}</span>
            </button>
          </Tooltip>} />
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
                      <span className={css.conversationTitle}>{activeDetail?.conversation.title ?? selectedSummary?.title ?? t('新对话', 'New conversation')}</span>
                      <span className={css.cwd}>{currentWorkspace?.name ?? activeDetail?.conversation.cwd ?? selectedSummary?.cwd ?? ''}
                        {busy && <span className={css.running}>{t('运行中', 'Running')}</span>}</span>
                    </div>
                  </div>
                  <div className={css.topbarActions}>
                    <ConnectionIndicator state={connection} disconnectedLabel={t('连接中断 · 重新连接', 'Connection lost · reconnect')}
                      connectingLabel={t('正在连接', 'Connecting')} recoveredLabel={t('连接已恢复', 'Connection restored')}
                      reconnectActionLabel={t('重新连接会话', 'Reconnect conversation')} restartActionLabel={t('再次尝试连接', 'Try again')}
                      onReconnect={() => { setConnection('connecting'); setReconnectToken(value => value + 1) }} />
                    <Menu open={moreMenuOpen} onClose={() => { setMoreMenuOpen(false) }} onSelect={id => {
                      setMoreMenuOpen(false)
                      if (id === 'settings') { setSettingsInitialTab('general'); setSettingsOpen(true) }
                      if (id === 'models') { setSettingsInitialTab('models'); setSettingsOpen(true) }
                      if (id === 'theme-system' || id === 'theme-light' || id === 'theme-dark') {
                        void onSettingsChange({ theme: id.slice('theme-'.length) as AppSettings['theme'] }).catch(cause => { announce(errorText(cause, t('无法更改外观', 'Could not change appearance'))) })
                      }
                    }} items={[
                      { id: 'settings', label: t('设置', 'Settings'), icon: <IconSettingsOutlineRegular size={15} /> },
                      { id: 'models', label: t('模型配置', 'Model settings') },
                      { id: 'theme-system', label: t('跟随系统外观', 'Follow system appearance'), icon: <IconFollowsystemOutlineRegular size={15} /> },
                      { id: 'theme-light', label: t('浅色外观', 'Light appearance'), icon: <IconLightOutlineRegular size={15} /> },
                      { id: 'theme-dark', label: t('深色外观', 'Dark appearance'), icon: <IconDarkOutlineRegular size={15} /> },
                    ]} portal compact anchor={<Tooltip label={t('更多对话操作', 'More conversation options')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={t('更多对话操作', 'More conversation options')}
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
                    onChange={setDraft} onAddImages={addImages} onRemoveImage={removeImage} onSend={mode => { void send(mode) }}
                    onStop={() => { void stop() }} onRemoveQueue={id => { void removeQueue(id) }}
                    onSelectModel={model => { void chooseModel(model) }} onThinkingLevel={level => { void chooseThinking(level) }}
                    onSendMode={setSendMode} onSelectWorkspace={id => { void selectWorkspace(id) }} onAddWorkspace={() => { setWorkspaceDialogOpen(true) }}
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
                        ? <Transcript messages={activeDetail.messages} pending={selectedPending}
                          onFork={entryId => { void forkFrom(entryId) }} onRetry={entryId => { void retryEntry(entryId) }}
                          onFeedback={(entryId, rating) => { void submitFeedback(entryId, rating) }}
                          onOpenFile={(path, line) => { void openWorkspaceFile(path).then(() => {
                            if (line !== undefined) setInspectorFile(current => current === undefined ? undefined : { ...current, line })
                          }) }}
                          resolveFileImage={path => currentWorkspaceId === undefined ? undefined
                            : `/api/workspaces/${encodeURIComponent(currentWorkspaceId)}/asset?${new URLSearchParams({ path }).toString()}`}
                          onInspectDiff={diff => { inspectorRequestId.current += 1; setInspectorOpen(true); setInspectorFile(undefined); setInspectorDiff(diff); setInspectorError(''); setInspectorLoading(false) }}
                          onOpenTool={() => { setChatView('trajectory') }}
                          displayMode={settings.processDisplay} autoCollapseCompleted={settings.collapseProcess === 'afterResponse'} />
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
                    <Composer value={draft} images={images} catalog={catalog} model={selectedModel} thinkingLevel={thinkingLevel}
                      busy={busy} disabled={detailLoading || !conversationReady && detailError === ''} queue={activeDetail.queue}
                      sendMode={sendMode} sending={sending} workspace={currentWorkspace} workspaces={workspaces} presets={presets}
                      presetId={selectedPresetId} accessMode={accessMode} accessModes={accessModes}
                      files={[]} usage={activeDetail.usage}
                      runCount={new Set(activeDetail.messages.map(message => message.runId).filter((runId): runId is string => runId !== undefined)).size}
                      stepCount={activeDetail.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length}
                      onChange={setDraft} onAddImages={addImages} onRemoveImage={removeImage} onSend={mode => { void send(mode) }}
                      onStop={() => { void stop() }} onRemoveQueue={id => { void removeQueue(id) }}
                      onSelectModel={model => { void chooseModel(model) }} onThinkingLevel={level => { void chooseThinking(level) }}
                      onSendMode={setSendMode} onSelectWorkspace={id => { void selectWorkspace(id) }} onAddWorkspace={() => { setWorkspaceDialogOpen(true) }}
                      onSelectPreset={id => { void selectPreset(id) }} onAccessMode={mode => { void selectAccessMode(mode) }}
                      onUpdateQueue={updateQueue} onOpenSettings={() => { setSettingsInitialTab('models'); setSettingsOpen(true) }}
                      onNewConversation={startNewConversation} onSearchFiles={searchWorkspaceFiles} onPreviewFile={path => { void openWorkspaceFile(path) }} />
                  </div>}
                </>}
            </>}
            {page === 'plugins' && <PluginsPage plugins={plugins} error={pluginLoadError} loading={pluginsLoading}
              onRefresh={() => { void refreshPlugins() }} onTogglePlugin={(pluginId, enabled) => { void setPlugin(pluginId, { enabled }) }}
              onToggleTool={(pluginId, toolName, enabled) => { void setPlugin(pluginId, { tools: { [toolName]: enabled } }) }} />}
            {page === 'automations' && <AutomationsPage workspaceId={currentWorkspaceId} presetId={selectedPresetId}
              onOpenConversation={id => { void openConversation(id) }} />}
            {page === 'workspace' && (workspaces.find(item => item.id === workspacePageId) === undefined
              ? <div className={css.contentState}>{t('请选择一个工作区', 'Choose a workspace')}</div>
              : <WorkspaceBrowserPage workspace={workspaces.find(item => item.id === workspacePageId)!}
                onOpenFile={path => { void openWorkspaceFile(path, workspacePageId ?? undefined) }} />)}
          </div>
          {showInspector && <aside className={css.inspectorPane} aria-label={t('文件检查器', 'File inspector')}>
            <Inspector file={inspectorFile} diff={inspectorDiff} loading={inspectorLoading} error={inspectorError}
              onClose={closeInspector} />
          </aside>}
        </div>
      </section>
      <SettingsDialog open={settingsOpen} catalog={catalog} saving={savingProvider} settings={settings} accessModes={accessModes}
        initialTab={settingsInitialTab} onSettingsChange={onSettingsChange} onRefreshCatalog={refreshCatalog}
        pluginsPanel={<PluginsPanel embedded plugins={plugins} error={pluginLoadError} loading={pluginsLoading}
          onRefresh={() => { void refreshPlugins() }} onTogglePlugin={(pluginId, enabled) => { void setPlugin(pluginId, { enabled }) }}
          onToggleTool={(pluginId, toolName, enabled) => { void setPlugin(pluginId, { tools: { [toolName]: enabled } }) }} />}
        presetsPanel={<PresetsPanel presets={presets} models={catalog?.models ?? []} defaultPresetId={settings.defaultPresetId}
          loading={presetsLoading} error={presetLoadError} onRefresh={() => { void refreshPresets() }}
          onChange={setPresets} onSetDefault={id => { void onSettingsChange({ defaultPresetId: id ?? null }).catch(cause => { announce(errorText(cause, t('无法保存默认预设', 'Could not save the default preset'))) }) }} />}
        onClose={() => { setSettingsOpen(false) }} onSave={saveProvider} />
      <WorkspaceDialog open={workspaceDialogOpen} workspaces={workspaces} currentWorkspaceId={currentWorkspaceId}
        busy={false} onClose={() => { setWorkspaceDialogOpen(false) }} onSelect={id => {
          void selectWorkspace(id)
          setWorkspaceDialogOpen(false)
        }} onCreate={addWorkspace} />
      <WorkspaceRenameDialog workspace={renameWorkspace} onClose={() => { setRenameWorkspace(null) }}
        onSave={(workspace, name) => { setRenameWorkspace(null); void saveWorkspaceName(workspace, name) }} />
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
    <div className={css.sessionRow} data-selected={selected || undefined} data-pinned={item.pinned || undefined}>
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
            {item.pinned && <IconPinFillRegular className={css.sessionPin} size={11} />}
            <span className={css.sessionTitle}>{item.title || t('新对话', 'New conversation')}</span>
            {item.busy && <span className={css.sessionBusy} aria-label={t('正在运行', 'Running')} />}
          </button>
          <Menu open={menuOpen} onClose={onMenuClose} items={actions} portal compact
            onSelect={id => { onAction(id) }}
            anchor={<Tooltip label={t('更多会话操作', 'Conversation actions')} side="top" portal>
              <button type="button" className={css.rowMenuButton} aria-label={t(`会话操作：${item.title}`, `Conversation actions: ${item.title}`)}
                onClick={onToggleMenu}><IconEllipsisOutlineRegular size={16} /></button>
            </Tooltip>} />
          <time className={css.sessionMeta} dateTime={new Date(item.updatedAt).toISOString()}>{formatUpdated(item.updatedAt, settings.locale)}</time>
        </>}
    </div>
  )
}

function SessionSkeleton() {
  const { t } = useUiPreferences()
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

function formatUpdated(value: number, locale: 'zh' | 'en'): string {
  const date = new Date(value)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay ? new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric' }).format(date)
}

function isAcknowledged(detail: ConversationDetail, pendingItem: PendingSubmission): boolean {
  return detail.messages.some(message => message.requestId === pendingItem.requestId)
    || pendingItem.submissionId !== undefined && detail.queue.some(item => item.id === pendingItem.submissionId)
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
