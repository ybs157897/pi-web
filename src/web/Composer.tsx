import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  Button, Checkbox, FileTypeIcon, IconAgentPresetOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconDatabaseOutlineRegular, IconEditOutlineRegular,
  IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconGaugeOutlineRegular, IconPlanOutlineRegular, IconPlusOutlineRegular,
  IconSendOutlineRegular, IconStopFillRegular, IconWarningOutlineRegular, Input, Menu, MenuItemButton,
  Modal, PermissionIconFullAccessRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular,
  Tooltip, observeComposition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccessMode, AgentPreset, ModelCatalog, ModelOption, QueueActionInput, QueueItem, ThinkingLevel, WorkspaceFileEntry, WorkspaceSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { cacheHitPercent, formatTokens } from './render-labels.ts'
import ModelSelect from './ModelSelect.tsx'
import type { ConversationStats } from './render-model.ts'
import { matchesShortcut, resolveShortcuts } from './keyboard.ts'
import css from './Composer.module.css'

export interface DraftImage { id: string; file: File; preview: string; data: string; mimeType: string; status: 'reading' | 'ready' | 'error'; error?: string }
export type BusySendMode = 'followUp' | 'steer'
export interface ComposerProps {
  value: string; images: readonly DraftImage[]; catalog: ModelCatalog | null
  model?: { provider: string; modelId: string }; thinkingLevel: ThinkingLevel; busy: boolean; disabled?: boolean
  queue: readonly QueueItem[]; sendMode: BusySendMode; sending: boolean
  onChange: (value: string) => void; onAddImages: (files: FileList | File[]) => void; onRemoveImage: (id: string) => void
  onRetryImage?: (id: string) => void
  onSend: (mode?: BusySendMode) => void; onStop: () => void; onRemoveQueue: (id: string) => void
  onSelectModel: (model: ModelOption) => void; onThinkingLevel: (level: ThinkingLevel) => void; onSendMode: (mode: BusySendMode) => void
  hero?: boolean; workspace?: WorkspaceSummary; workspaces?: WorkspaceSummary[]; onSelectWorkspace?: (id: string) => void; onAddWorkspace?: () => void
  presetId?: string; presets?: AgentPreset[]; onSelectPreset?: (id: string) => void
  accessMode?: AccessMode; accessModes?: AccessMode[]; onAccessMode?: (mode: AccessMode) => void
  onUpdateQueue?: (id: string, action: QueueActionInput) => Promise<void>
  onOpenSettings?: () => void; onNewConversation?: () => void; onCompact?: () => void
  /** Plan mode as the server projects it; the chip closes it through `onPlan`. */
  plan?: boolean; onPlan?: (active: boolean) => void
  files?: WorkspaceFileEntry[]; onSearchFiles?: (query: string) => Promise<WorkspaceFileEntry[]>; onPreviewFile?: (path: string) => void
  stats?: ConversationStats
}
const LEVEL_NAMES: Record<ThinkingLevel, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

/** Human-readable attachment size; DSH shows the extension plus this value. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.slice(index + 1).toUpperCase().slice(0, 8) : 'FILE'
}

/** DSH's shared hero/docked composer, connected to Pi conversation operations. */
export default function Composer(props: ComposerProps) {
  const { value, images, catalog, model, thinkingLevel, busy, disabled = false, queue, sendMode, sending,
    onChange, onAddImages, onRemoveImage, onSend, onStop, onRemoveQueue, onSelectModel, onThinkingLevel,
    hero = false, workspace, workspaces = [], presets = [], presetId, accessMode = 'fullAccess',
    accessModes = ['readOnly', 'fullAccess'], onUpdateQueue, onSearchFiles, plan = false, onPlan } = props
  const { t, settings } = useUiPreferences()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const queueAttempt = useRef<{ key: string; requestId: string } | null>(null)
  const guard = useRef<ReturnType<typeof observeComposition> | null>(null)
  const modelSearch = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<'model' | 'search' | 'access' | 'add' | 'workspace' | 'preset' | 'mode' | 'usage' | 'context' | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [editingQueue, setEditingQueue] = useState<string | null>(null)
  const [queueText, setQueueText] = useState('')
  const [queueSaving, setQueueSaving] = useState<string | null>(null)
  const [queueError, setQueueError] = useState('')
  const [trigger, setTrigger] = useState<{ type: 'command' | 'file'; query: string; from: number; to: number } | null>(null)
  const [matches, setMatches] = useState<WorkspaceFileEntry[]>([])
  const [fileError, setFileError] = useState('')
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const [accessConfirm, setAccessConfirm] = useState(false)
  const [accessAck, setAccessAck] = useState(false)
  const modelChoices = catalog?.models ?? []
  const selectedModel = modelChoices.find(item => item.provider === model?.provider && item.modelId === model.modelId)
  const thinkingChoices = selectedModel?.thinkingLevels?.length ? selectedModel.thinkingLevels : selectedModel?.reasoning ? catalog?.thinkingLevels ?? [] : ['off'] as ThinkingLevel[]
  const availableModels = useMemo(() => modelChoices.filter(item => item.available), [modelChoices])
  const matchingModels = useMemo(() => availableModels.filter(item => `${item.name} ${item.modelId} ${item.provider}`.toLowerCase().includes(modelQuery.toLowerCase())).slice(0, 60), [availableModels, modelQuery])
  const providerName = (id: string): string => catalog?.providers.find(item => item.id === id)?.name ?? id
  const selectedPreset = presets.find(item => item.id === presetId)
  const attachmentsPending = images.some(image => image.status !== 'ready')
  const canSend = (value.trim() !== '' || images.length > 0) && !disabled && !sending && !attachmentsPending
  const stats = props.stats
  const contextWindow = selectedModel?.contextWindow
  const cacheHit = stats === undefined ? undefined : cacheHitPercent(stats.cacheRead, stats.input + stats.cacheRead + stats.cacheWrite)
  const contextPercent = stats !== undefined && contextWindow !== undefined && contextWindow > 0 && stats.contextTokens > 0
    ? Math.min(100, Math.round(stats.contextTokens / contextWindow * 100))
    : undefined
  const accessLabel = (mode: AccessMode) => mode === 'readOnly' ? t('仅可查看', 'Read only') : mode === 'workspaceWrite' ? t('工作区内修改', 'Workspace write') : t('完全权限', 'Full access')
  const accessIcon = (mode: AccessMode): ReactNode => mode === 'readOnly' ? <PermissionIconReadOnlyRegular size={14} /> : mode === 'workspaceWrite' ? <PermissionIconWorkspaceWriteRegular size={14} /> : <PermissionIconFullAccessRegular size={14} />

  useEffect(() => { guard.current = observeComposition(document); return () => { guard.current?.dispose(); guard.current = null } }, [])
  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragActive(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragActive(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragActive(false)
      if (!disabled && event.dataTransfer && event.dataTransfer.files.length > 0) onAddImages(event.dataTransfer.files)
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragover', over)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragover', over)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', drop)
    }
  }, [disabled, onAddImages])
  useEffect(() => {
    if (trigger === null) return
    const close = (event: MouseEvent) => {
      if (card.current && event.target instanceof Node && card.current.contains(event.target)) return
      setTrigger(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [trigger])
  useEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(Math.max(element.scrollHeight, hero ? 52 : 36), 340)}px`
  }, [value, hero])
  useEffect(() => {
    if (menu !== 'search') { setModelQuery(''); return }
    const frame = requestAnimationFrame(() => { modelSearch.current?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [menu])
  useEffect(() => {
    if (trigger?.type !== 'file' || !onSearchFiles) return
    let active = true
    setFileError('')
    const timer = window.setTimeout(() => {
      void onSearchFiles(trigger.query).then(items => { if (active) setMatches([...items].sort((left, right) => left.type === right.type ? left.path.localeCompare(right.path) : left.type === 'directory' ? -1 : 1).slice(0, 12)) })
        .catch(() => { if (active) { setMatches([]); setFileError(t('无法读取文件列表', 'Could not list files')) } })
    }, 100)
    return () => { active = false; clearTimeout(timer) }
  }, [trigger, onSearchFiles, t])

  const commands: Array<{ id: string; group: 'add' | 'command'; label: string; description: string; icon: ReactNode; run: () => void }> = [
    { id: 'file', group: 'add', label: t('文件', 'File'), description: t('选择图片或文件作为附件', 'Attach images or files'), icon: <IconPlusOutlineRegular size={16} />, run: () => fileInput.current?.click() },
    ...(props.onCompact ? [{ id: 'compact', group: 'command' as const, label: t('压缩', 'Compact'), description: t('压缩以上对话内容', 'Compact the conversation above'), icon: <IconDatabaseOutlineRegular size={16} />, run: props.onCompact }] : []),
    ...(onPlan ? [{ id: 'plan', group: 'command' as const, label: t('计划', 'Plan'), description: plan ? t('退出计划模式，直接执行', 'Leave plan mode and work directly') : t('进入计划模式：先出计划，批准后再执行', 'Enter plan mode: plan first, execute after approval'), icon: <IconPlanOutlineRegular size={16} />, run: () => onPlan(!plan) }] : []),
    { id: 'permission', group: 'command', label: t('权限', 'Permission'), description: t('切换权限预设（沙箱模式与审批策略）', 'Switch the permission preset (sandbox and approvals)'), icon: accessIcon(accessMode), run: () => setMenu('access') },
    { id: 'model', group: 'command', label: t('模型', 'Model'), description: t('选择本会话使用的模型', 'Choose the model for this conversation'), icon: <IconDatabaseOutlineRegular size={16} />, run: () => setMenu('search') },
    { id: 'settings', group: 'command', label: t('设置', 'Settings'), description: t('打开设置对话框', 'Open settings'), icon: <IconGaugeOutlineRegular size={16} />, run: () => props.onOpenSettings?.() },
    { id: 'new', group: 'command', label: t('新建会话', 'New conversation'), description: t('开始一个新会话', 'Start a new conversation'), icon: <IconPlusOutlineRegular size={16} />, run: () => props.onNewConversation?.() },
    ...(busy ? [{ id: 'stop', group: 'command' as const, label: t('停止', 'Stop'), description: t('停止当前回答', 'Stop the current response'), icon: <IconStopFillRegular size={16} />, run: onStop }] : []),
  ]
  const commandMatches = trigger?.type === 'command' ? commands.filter(item => item.id.startsWith(trigger.query.toLowerCase())) : []
  const suggestionCount = trigger?.type === 'command' ? commandMatches.length : matches.length
  const chooseSuggestion = (index: number) => {
    if (!trigger) return
    if (trigger.type === 'command') {
      const command = commandMatches[index]
      if (!command) return
      onChange(value.slice(0, trigger.from) + value.slice(trigger.to))
      setTrigger(null)
      command.run()
      return
    }
    const entry = matches[index]
    if (!entry) return
    if (entry.type === 'directory') {
      const directory = entry.path.endsWith('/') ? entry.path : `${entry.path}/`
      if (directory.includes(' ')) {
        const insertion = `@"${directory}" `
        onChange(value.slice(0, trigger.from) + insertion + value.slice(trigger.to))
        setTrigger(null)
        requestAnimationFrame(() => {
          textarea.current?.focus()
          const caret = trigger.from + insertion.length
          textarea.current?.setSelectionRange(caret, caret)
        })
        return
      }
      const insertion = `@${directory}`
      const next = value.slice(0, trigger.from) + insertion + value.slice(trigger.to)
      updateValue(next, trigger.from + insertion.length)
      requestAnimationFrame(() => {
        textarea.current?.focus()
        const caret = trigger.from + insertion.length
        textarea.current?.setSelectionRange(caret, caret)
      })
      return
    }
    const insertion = entry.path.includes(' ') ? `@"${entry.path}" ` : `@${entry.path} `
    onChange(value.slice(0, trigger.from) + insertion + value.slice(trigger.to))
    setTrigger(null)
    requestAnimationFrame(() => {
      textarea.current?.focus()
      const caret = trigger.from + insertion.length
      textarea.current?.setSelectionRange(caret, caret)
    })
  }
  const updateValue = (next: string, caret: number) => {
    onChange(next)
    const match = /(?:^|\s)([@/])([^\s]*)$/.exec(next.slice(0, caret))
    setTrigger(match ? { type: match[1] === '@' ? 'file' : 'command', query: match[2] ?? '', from: caret - (match[2]?.length ?? 0) - 1, to: caret } : null)
    setSelectedSuggestion(0)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (guard.current?.guards(event.nativeEvent) || event.nativeEvent.isComposing) return
    if (trigger && ['ArrowDown', 'ArrowUp', 'Escape', 'Enter', 'Tab'].includes(event.key)) {
      if (event.key === 'Escape') { event.preventDefault(); setTrigger(null); return }
      if (suggestionCount > 0) {
        event.preventDefault()
        if (event.key === 'ArrowDown') setSelectedSuggestion(index => (index + 1) % suggestionCount)
        else if (event.key === 'ArrowUp') setSelectedSuggestion(index => (index + suggestionCount - 1) % suggestionCount)
        else chooseSuggestion(selectedSuggestion)
        return
      }
    }
    const shortcuts = resolveShortcuts(settings.shortcuts)
    if (matchesShortcut(event.nativeEvent, shortcuts.newline)) {
      event.preventDefault()
      const start = event.currentTarget.selectionStart
      const end = event.currentTarget.selectionEnd
      onChange(value.slice(0, start) + '\n' + value.slice(end))
      requestAnimationFrame(() => textarea.current?.setSelectionRange(start + 1, start + 1))
      return
    }
    const alternate = matchesShortcut(event.nativeEvent, shortcuts.alternateSend)
    if (!alternate && !matchesShortcut(event.nativeEvent, shortcuts.send)) return
    event.preventDefault()
    if (canSend) onSend(busy && alternate ? sendMode === 'followUp' ? 'steer' : 'followUp' : sendMode)
  }
  const submitQueueEdit = async (item: QueueItem, text: string, mode = item.mode) => {
    if (!onUpdateQueue || queueSaving) return
    setQueueSaving(item.id); setQueueError('')
    const key = JSON.stringify([item.id, text, mode, item.images])
    if (queueAttempt.current?.key !== key) queueAttempt.current = { key, requestId: crypto.randomUUID() }
    try {
      await onUpdateQueue(item.id, { text, requestId: queueAttempt.current.requestId, whenBusy: mode, images: item.images })
      queueAttempt.current = null
      setEditingQueue(null)
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : t('无法更新排队消息，请重试', 'Could not update queued message. Try again.'))
    } finally { setQueueSaving(null) }
  }

  return <div className={`${css.composerArea} ${hero ? css.hero : ''}`} data-composer-mode={hero ? 'hero' : 'docked'}>
    {hero && <>
      <div className={css.heroTitle}><span className={css.heroMark} aria-hidden>π</span><h1>{t('探索未至之境', 'Explore beyond')}</h1><span className={css.preview}>{t('预览版', 'Preview')}</span></div>
      <div className={css.heroContext}>
        <Menu open={menu === 'workspace'} onClose={() => setMenu(null)} portal items={[
          ...workspaces.map(item => ({ id: item.id, label: item.name, icon: <IconFolderOpenOutlineRegular size={14} /> })),
          { type: 'separator', id: 'workspace-divider' }, { id: '__add', label: t('添加工作区…', 'Add workspace…'), icon: <IconPlusOutlineRegular size={14} /> },
        ]} selectedId={workspace?.id} onSelect={id => { setMenu(null); if (id === '__add') props.onAddWorkspace?.(); else props.onSelectWorkspace?.(id) }}
          anchor={<button className={css.contextButton} type="button" aria-label={t('选择工作区', 'Choose workspace')} onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')}><IconFolderOpenOutlineRegular size={15} /><span>{workspace?.name ?? t('选择工作区', 'Choose workspace')}</span><IconChevronDownOutlineRegular size={11} /></button>} />
        <Menu open={menu === 'preset'} onClose={() => setMenu(null)} portal items={[{ id: '__none', label: t('标准模式（无预设）', 'Standard mode (no preset)') }, ...presets.map(item => ({ id: item.id, label: item.name }))]} selectedId={presetId ?? '__none'}
          onSelect={id => { props.onSelectPreset?.(id); setMenu(null) }} anchor={<button className={css.contextButton} type="button" onClick={() => setMenu(menu === 'preset' ? null : 'preset')}><IconAgentPresetOutlineRegular size={14} /><span>{selectedPreset?.name ?? t('标准模式', 'Standard mode')}</span><IconChevronDownOutlineRegular size={11} /></button>} />
      </div>
    </>}
    {queue.length > 0 && <div className={css.queue} aria-label={t('待处理消息', 'Queued messages')}>
      <div className={css.queueHeading}>{t('接下来', 'Up next')} <span>{queue.length}</span></div>
      {!busy && <p className={css.queueNotice}>{t('队列已保留，发送下一条消息后继续处理。', 'Queue preserved. Send your next message to continue.')}</p>}
      {queueError && <p className={css.queueError} role="alert">{queueError}</p>}
      {queue.map(item => <div className={css.queueItem} key={item.id}>
        {editingQueue === item.id ? <form className={css.queueEdit} onSubmit={event => { event.preventDefault(); if (queueText.trim() || item.images?.length || item.files?.length) void submitQueueEdit(item, queueText) }}>
          <textarea value={queueText} disabled={queueSaving === item.id} onChange={event => setQueueText(event.currentTarget.value)} aria-label={t('编辑排队消息', 'Edit queued message')} rows={2} />
          <Button size="sm" variant="ghost" type="button" disabled={queueSaving === item.id} onClick={() => { setEditingQueue(null); setQueueError('') }}>{t('取消', 'Cancel')}</Button><Button size="sm" variant="primary" type="submit" disabled={queueSaving === item.id}>{queueSaving === item.id ? t('保存中…', 'Saving…') : t('保存', 'Save')}</Button>
        </form> : <>{item.images?.length ? <span className={css.queueMedia}>{item.images.map((image, index) => <img key={index} className={css.queueThumb} src={`data:${image.mimeType};base64,${image.data}`} alt={t('附件图片', 'Attached image')} />)}</span> : null}
          {item.files?.length ? <span className={css.queueFiles}>{item.files.map((file, index) => <span key={index} className={css.queueFile}><FileTypeIcon path={file.name} size={12} /><span className={css.queueFileName}>{file.name}</span><span className={css.queueFileSize}>{formatBytes(file.size)}</span></span>)}</span> : null}
          <span className={css.queueText}>{item.text || (item.images?.length || item.files?.length ? '' : t('附件消息', 'Attachments'))}</span><span className={css.queueMode}>{item.mode === 'steer' ? t('插入', 'Steer') : t('排队', 'Queued')}</span>
          {onUpdateQueue && <><button className={css.queueAction} type="button" disabled={queueSaving !== null} aria-label={t('编辑排队消息', 'Edit queued message')} onClick={() => { setEditingQueue(item.id); setQueueText(item.text); setQueueError('') }}><IconEditOutlineRegular size={14} /></button>
          {item.mode !== 'steer' && <button className={css.queueAction} type="button" disabled={queueSaving !== null} onClick={() => { void submitQueueEdit(item, item.text, 'steer') }}>{t('立即插入', 'Steer now')}</button>}</>}
          <button className={css.queueAction} type="button" aria-label={t('移除排队消息', 'Remove queued message')} onClick={() => onRemoveQueue(item.id)}><IconCloseOutlineRegular size={14} /></button></>}
      </div>)}
    </div>}
    {dragActive && <div className={`${css.dropOverlay} ${disabled ? css.dropReject : ''}`} role="status" aria-live="polite">
      <div className={css.dropPanel}>
        <svg className={css.dropArt} viewBox="0 0 120 84" aria-hidden="true">
          <rect x="14" y="22" width="44" height="44" rx="12" fill="#bff0ee" transform="rotate(-14 36 44)" />
          <rect x="62" y="22" width="44" height="44" rx="12" fill="#cfe0ff" transform="rotate(12 84 44)" />
          <rect x="38" y="30" width="44" height="44" rx="12" fill="#3f6cf6" />
          <circle cx="55" cy="45" r="4.5" fill="#fff" />
          <path d="M50 63l10-12 8 9 7-7 5 10" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className={css.dropTitle}>{disabled ? t('当前无法添加文件或图片', 'Files and images cannot be added right now') : t('文件或图片拖动到此处即可添加', 'Drag files or images here to add them')}</p>
        {!disabled && <p className={css.dropHint}>{t('图片限制：最多 4 张，每张 4 MiB', 'Image limit: up to 4 images, 4 MiB each')}</p>}
      </div>
    </div>}
    <div className={css.card} ref={card} onDragOver={event => { event.preventDefault() }} onDrop={event => { event.preventDefault(); if (!disabled) onAddImages(event.dataTransfer.files) }}>
      {images.length > 0 && <div className={css.attachments}>{images.map(image => {
        const imageAttachment = image.mimeType.startsWith('image/')
        const reading = image.status === 'reading'
        const failed = image.status === 'error'
        const meta = reading ? t('读取中…', 'Reading…') : failed ? t('读取失败，点击重试', 'Upload failed; click to retry') : `${fileExtension(image.file.name)} ${formatBytes(image.file.size)}`
        return <div key={image.id} className={`${css.attachment} ${imageAttachment ? css.attachmentImage : css.attachmentFile} ${reading ? css.attachmentReading : failed ? css.attachmentFailed : ''}`} role="group" aria-label={imageAttachment ? t('待发送图片', 'Pending image') : t('待发送文件', 'Pending file')}>
          {imageAttachment
            ? reading ? <span className={css.attachmentThumbPlaceholder} aria-hidden="true"><span className={css.spinner} /></span>
              : failed ? <span className={css.attachmentThumbPlaceholder} aria-hidden="true"><IconWarningOutlineRegular size={20} /></span>
                : <img className={css.attachmentThumb} src={image.preview} alt={image.file.name} />
            : <>
              <span className={css.fileIcon}>{reading ? <span className={css.spinner} /> : <FileTypeIcon path={image.file.name} />}</span>
              <span className={css.fileBody}><span className={css.fileName}>{image.file.name}</span>{reading || failed ? <span className={css.fileMeta} role="status">{meta}</span> : <span className={css.fileMeta}>{meta}</span>}</span>
            </>}
          {imageAttachment && (reading || failed) && <span className={css.srOnly} role="status">{t(`${image.file.name}：${meta}`, `${image.file.name}: ${meta}`)}</span>}
          {failed && <button className={css.attachmentRetry} type="button" title={meta} aria-label={t(`重试读取 ${image.file.name}`, `Retry reading ${image.file.name}`)} onClick={() => props.onRetryImage?.(image.id)} />}
          <button className={css.attachmentRemove} type="button" aria-label={imageAttachment ? t(`移除图片 ${image.file.name}`, `Remove image ${image.file.name}`) : t(`移除文件 ${image.file.name}`, `Remove file ${image.file.name}`)} onClick={() => onRemoveImage(image.id)}><IconCloseOutlineRegular size={12} /></button>
        </div>
      })}</div>}
      <textarea ref={textarea} className={css.textarea} data-composer-input aria-label={t('发送消息', 'Message')} placeholder={hero ? t('描述你想要构建的内容, / 调用指令, @ 文件或对话', 'Describe what you want to build, / for commands, @ for files') : t('发消息或创建任务, / 调用指令, @ 文件或对话', 'Send a message or create a task, / commands, @ files')}
        value={value} disabled={disabled || sending} rows={hero ? 2 : 1} onChange={event => updateValue(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={onKeyDown}
        onPaste={event => { const files = event.clipboardData.files; if (files.length) { event.preventDefault(); onAddImages(files) } }} />
      {trigger !== null && <div className={css.suggestionPanel} role="listbox" aria-label={trigger.type === 'command' ? t('指令', 'Commands') : t('文件与文件夹', 'Files and folders')}>
        {trigger.type === 'command' ? (['add', 'command'] as const).map(group => {
          const rows = commandMatches.map((item, index) => ({ item, index })).filter(row => row.item.group === group)
          if (rows.length === 0) return null
          return <div key={group} className={css.suggestionGroup}>
            <div className={css.suggestionGroupTitle}>{group === 'add' ? t('添加', 'Add') : t('指令', 'Commands')}</div>
            {rows.map(({ item, index }) => <button key={item.id} type="button" role="option" aria-selected={index === selectedSuggestion}
              className={`${css.suggestionItem} ${index === selectedSuggestion ? css.suggestionItemSelected : ''}`}
              onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelectedSuggestion(index)} onClick={() => chooseSuggestion(index)}>
              <span className={css.suggestionIcon}>{item.icon}</span>
              <span className={css.suggestionName}>{item.label}<small>/{item.id}</small></span>
              <span className={css.suggestionDesc}>{item.description}</span>
            </button>)}
          </div>
        }) : <>
          <div className={css.suggestionGroupTitle}>{matches.some(item => item.type === 'directory') ? t('文件与文件夹', 'Files and folders') : t('文件', 'Files')}</div>
          {matches.map((item, index) => <button key={`${item.type}:${item.path}`} type="button" role="option" aria-selected={index === selectedSuggestion}
            className={`${css.suggestionItem} ${index === selectedSuggestion ? css.suggestionItemSelected : ''}`}
            onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelectedSuggestion(index)} onClick={() => chooseSuggestion(index)}>
            <span className={css.suggestionIcon}>{item.type === 'directory' ? <IconFolderCloseRegular size={18} /> : <FileTypeIcon path={item.path} />}</span>
            <span className={css.suggestionName}>{item.type === 'directory' ? `${item.path}/` : item.path}</span>
            {item.type === 'directory' && <IconChevronRightOutlineRegular size={14} className={css.suggestionChevron} />}
          </button>)}
        </>}
        {suggestionCount === 0 && <div className={css.suggestionEmpty}>{fileError || t('没有匹配项', 'No matches')}</div>}
      </div>}
      <div className={css.toolbar}>
        <div className={css.tools}>
          <input ref={fileInput} type="file" multiple className={css.fileInput} onChange={event => { if (event.currentTarget.files) onAddImages(event.currentTarget.files); event.currentTarget.value = '' }} />
          <Menu open={menu === 'add'} onClose={() => setMenu(null)} side="top" portal items={[
            { id: 'upload', label: t('添加文件', 'Add files'), icon: <IconPlusOutlineRegular size={14} /> },
            { id: 'reference', label: t('引用工作区文件', 'Reference workspace file'), disabled: !workspace },
            { id: 'commands', label: t('调用指令', 'Commands') },
          ]} onSelect={id => { setMenu(null); if (id === 'upload') fileInput.current?.click(); else { const symbol = id === 'reference' ? '@' : '/'; const next = `${value}${value ? ' ' : ''}${symbol}`; updateValue(next, next.length); requestAnimationFrame(() => textarea.current?.focus()) } }}
            anchor={<button type="button" className={css.add} aria-label={t('添加文件或调用指令', 'Add files or commands')} disabled={disabled} onClick={() => setMenu(menu === 'add' ? null : 'add')}><IconPlusOutlineRegular size={16} /></button>} />
          {plan && <Tooltip label={t('计划模式已开启，点击退出', 'Plan mode is on; click to leave')} portal>
            <button type="button" className={css.planChip} data-plan-chip aria-pressed={true}
              aria-label={t('退出计划模式', 'Leave plan mode')} onClick={() => onPlan?.(false)}>
              <IconPlanOutlineRegular size={14} /><span>{t('计划', 'Plan')}</span>
            </button>
          </Tooltip>}
          <Menu open={menu === 'access'} onClose={() => setMenu(null)} side="top" portal items={accessModes.map(mode => ({ id: mode, label: accessLabel(mode), icon: accessIcon(mode) }))} selectedId={accessMode}
            onSelect={id => {
              setMenu(null)
              const mode = id as AccessMode
              if (mode === accessMode) return
              if (mode === 'fullAccess') { setAccessAck(false); setAccessConfirm(true); return }
              props.onAccessMode?.(mode)
            }} anchor={<button type="button" className={css.select} aria-label={`${t('访问模式，当前：', 'Access mode: ')}${accessLabel(accessMode)}`} onClick={() => setMenu(menu === 'access' ? null : 'access')} disabled={disabled}>{accessIcon(accessMode)}<span className={css.accessText}>{accessLabel(accessMode)}</span><IconChevronDownOutlineRegular size={11} /></button>} />
        </div>
        <div className={css.trailing}>
          <ModelSelect models={availableModels} providerName={providerName} current={model} level={thinkingLevel} levels={thinkingChoices}
            levelName={value => LEVEL_NAMES[value]} disabled={disabled} busy={busy} t={t}
            onSelectModel={value => { onSelectModel(value) }} onSelectLevel={value => { onThinkingLevel(value) }}
            onSearch={() => setMenu('search')} onManageProviders={() => { props.onOpenSettings?.() }} />
          <Menu open={menu === 'search'} onClose={() => setMenu(null)} side="top" align="end" portal anchor={<span className={css.menuAnchor} aria-hidden />} getAnchorRect={() => card.current?.getBoundingClientRect() ?? null} listClassName={css.modelSearchMenu}>
            <div className={css.modelSearch}><Input ref={modelSearch} value={modelQuery} placeholder={t('搜索模型', 'Search models')} onChange={event => setModelQuery(event.currentTarget.value)} /></div>
            {matchingModels.map(item => <MenuItemButton key={`${item.provider}/${item.modelId}`} onSelect={() => { onSelectModel(item); setMenu(null) }}><span className={css.modelMenuRow}><span>{item.name}<small>{item.provider}</small></span>{item.provider === model?.provider && item.modelId === model.modelId && <IconCheckOutlineRegular size={14} />}</span></MenuItemButton>)}
            {matchingModels.length === 0 && <div className={css.emptyMenu}>{t('没有可用模型', 'No available models')}</div>}
            <MenuItemButton separatorBefore onSelect={() => { setMenu(null); props.onOpenSettings?.() }}>{t('管理模型提供商', 'Manage model providers')}</MenuItemButton>
          </Menu>
          {busy && canSend && <Tooltip label={t('停止当前回答', 'Stop current response')} portal><button className={css.stopSecondary} type="button" aria-label={t('停止当前回答', 'Stop current response')} onClick={onStop}><IconStopFillRegular size={14} /></button></Tooltip>}
          <Tooltip label={busy && !canSend ? t('停止当前回答', 'Stop current response') : busy ? sendMode === 'steer' ? t('立即插入', 'Steer now') : t('排队发送', 'Queue message') : !disabled && !sending && attachmentsPending ? t('附件读取中，暂不可发送', 'Attachments are still loading') : t('发送消息', 'Send message')} portal>
            <button type="button" className={css.send} disabled={disabled || sending || !busy && !canSend} aria-label={busy && !canSend ? t('停止当前回答', 'Stop current response') : !disabled && !sending && attachmentsPending ? t('附件读取中，暂不可发送', 'Attachments are still loading') : t('发送消息', 'Send message')}
              onClick={() => { setTrigger(null); if (busy && !canSend) onStop(); else onSend(sendMode) }}>{busy && !canSend ? <IconStopFillRegular size={16} /> : <IconSendOutlineRegular size={20} />}</button>
          </Tooltip>
        </div>
      </div>
    </div>
    {!hero && <div className={css.statusStrip}>
      {stats !== undefined && (stats.runCount > 0 || stats.stepCount > 0) && <span className={css.stat}>
        <IconGaugeOutlineRegular size={12} />
        <span>{stats.runCount} {t('轮', 'runs')} {stats.stepCount} {t('步', 'steps')}</span>
      </span>}
      {stats !== undefined && stats.totalTokens > 0 && <Menu open={menu === 'usage'} onClose={() => setMenu(null)} side="top" portal
        anchor={<button type="button" aria-label={t('Token 用量', 'Token usage')} onClick={() => setMenu(menu === 'usage' ? null : 'usage')}>
          <IconDatabaseOutlineRegular size={12} />
          <span>{formatTokens(stats.totalTokens)} tok</span>
          {cacheHit !== undefined && <span>· {t(`缓存命中 ${cacheHit}%`, `cache hit ${cacheHit}%`)}</span>}
        </button>}>
        {cacheHit !== undefined && <StatRow label={t('缓存命中', 'Cache hit')} value={`${cacheHit}%`} onClose={() => setMenu(null)} />}
        <StatRow label={t('未缓存输入', 'Uncached input')} value={stats.input.toLocaleString()} onClose={() => setMenu(null)} />
        <StatRow label={t('缓存读取', 'Cache read')} value={stats.cacheRead.toLocaleString()} onClose={() => setMenu(null)} />
        {stats.cacheWrite > 0 && <StatRow label={t('缓存写入', 'Cache write')} value={stats.cacheWrite.toLocaleString()} onClose={() => setMenu(null)} />}
        <StatRow label={t('输出', 'Output')} value={stats.output.toLocaleString()} onClose={() => setMenu(null)} />
      </Menu>}
      {contextPercent !== undefined && stats !== undefined && contextWindow !== undefined && <Menu open={menu === 'context'} onClose={() => setMenu(null)} side="top" portal
        anchor={<button type="button" aria-label={t(`上下文已用 ${contextPercent}%`, `Context used ${contextPercent}%`)} onClick={() => setMenu(menu === 'context' ? null : 'context')}>
          <ContextRing percent={contextPercent} /><span>{contextPercent}%</span>
        </button>}>
        <StatRow label={t('上下文已用', 'Context used')} value={`~${formatTokens(stats.contextTokens)} / ${formatTokens(contextWindow)}`} onClose={() => setMenu(null)} />
      </Menu>}
      {busy && <Menu open={menu === 'mode'} onClose={() => setMenu(null)} side="top" portal selectedId={sendMode} items={[{ id: 'followUp', label: t('排队发送', 'Queue message') }, { id: 'steer', label: t('立即插入', 'Steer now') }]}
        onSelect={id => { props.onSendMode(id as BusySendMode); setMenu(null) }} anchor={<button type="button" onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>{sendMode === 'steer' ? t('插入', 'Steer') : t('排队', 'Queue')}<IconChevronDownOutlineRegular size={10} /></button>} />}
    </div>}
    <Modal open={accessConfirm} onClose={() => { setAccessConfirm(false); setAccessAck(false) }} title={t('确认启用完全权限?', 'Enable full access?')} closeLabel={t('关闭', 'Close')}
      footer={<div className={css.riskActions}>
        <Button variant="ghost" onClick={() => { setAccessConfirm(false); setAccessAck(false) }}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" disabled={!accessAck} onClick={() => {
          if (!accessAck) return
          setAccessConfirm(false)
          setAccessAck(false)
          props.onAccessMode?.('fullAccess')
        }}>{t('启用完全权限', 'Enable full access')}</Button>
      </div>}>
      <div className={css.riskBody}>
        <IconWarningOutlineRegular size={20} className={css.riskIcon} />
        <p>{t('启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。', 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.')}</p>
      </div>
      <Checkbox label={t('我已了解风险，并愿意继续', 'I understand the risk and want to continue')} checked={accessAck} onChange={setAccessAck} />
    </Modal>
  </div>
}

/** One read-only row of a composer statistics panel. */
function StatRow({ label, value, onClose }: { label: string; value: string; onClose: () => void }) {
  return <MenuItemButton onSelect={onClose}>
    <span className={css.statRow}><span>{label}</span><span>{value}</span></span>
  </MenuItemButton>
}

/** DSH's context occupancy ring: a 14px dial whose arc is the used share. */
function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  const used = Math.min(1, Math.max(0, percent / 100))
  return <svg className={css.contextRing} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
    <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeDasharray={`${circumference * used} ${circumference}`} transform="rotate(-90 7 7)" />
  </svg>
}
