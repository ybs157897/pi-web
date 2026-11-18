import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import {
  Button, Checkbox, FileTypeIcon, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  IconSkillOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconDatabaseOutlineRegular,
  IconEditOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconGaugeOutlineRegular,
  IconPlanOutlineRegular, IconPlusOutlineRegular, IconSendOutlineRegular, IconStopFillRegular, IconTrashOutlineRegular,
  IconWarningOutlineRegular, Input, Menu, MenuItemButton, Modal, PermissionIconFullAccessRegular,
  PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, Tooltip, observeComposition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccessMode, ModelCatalog, ModelOption, QueueActionInput, QueueItem, ThinkingLevel, WorkspaceFileEntry, WorkspaceSummary } from '../shared/types.ts'
import type { PluginContextEntry } from '../shared/plugin-ui.ts'
import type { SkillSummary } from '../shared/skills.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import ModelSelect from './ModelSelect.tsx'
import GitBranchSwitcher from './GitBranchSwitcher.tsx'
import ComposerUsage from './ComposerUsage.tsx'
import type { ConversationStats } from './render-model.ts'
import { matchesShortcut, resolveShortcuts } from './keyboard.ts'
import { CHAT_EMPTY_GREETINGS, chatEmptyGreeting, greetingFontSizePx, nextGreetingDelayMs } from './greeting.ts'
import css from './Composer.module.css'

export interface DraftImage { id: string; file: File; preview: string; data: string; mimeType: string; status: 'reading' | 'ready' | 'error'; error?: string }
/** 繁忙时的发送模式：排队发送或立即插入（steer）。 */
export type BusySendMode = 'followUp' | 'steer'
/**
 * Composer 的属性定义：输入值与附件、模型目录与当前模型、队列、权限与计划模式，
 * 以及发送/停止/队列编辑/模型选择等回调。
 */
export interface ComposerProps {
  value: string; images: readonly DraftImage[]; catalog: ModelCatalog | null
  model?: { provider: string; modelId: string }; thinkingLevel: ThinkingLevel; busy: boolean; disabled?: boolean
  queue: readonly QueueItem[]; sendMode: BusySendMode; sending: boolean
  onChange: (value: string) => void; onAddImages: (files: FileList | File[]) => void; onRemoveImage: (id: string) => void
  onRetryImage?: (id: string) => void
  onSend: (mode?: BusySendMode) => void; onStop: () => void; onRemoveQueue: (id: string) => void
  onSelectModel: (model: ModelOption) => void; onThinkingLevel: (level: ThinkingLevel) => void; onSendMode: (mode: BusySendMode) => void
  hero?: boolean; workspace?: WorkspaceSummary; workspaces?: WorkspaceSummary[]; onSelectWorkspace?: (id: string) => void; onAddWorkspace?: () => void
  accessMode?: AccessMode; accessModes?: AccessMode[]; onAccessMode?: (mode: AccessMode) => void
  onUpdateQueue?: (id: string, action: QueueActionInput) => Promise<void>
  /** 停止响应后的队列暂停态：为 true 且空闲时在队列上方显示「队列已暂停」条。 */
  queuePaused?: boolean
  /** 恢复被暂停的队列（以原内容重投最后一条激活队列处理）。 */
  onResumeQueue?: () => void
  onOpenSettings?: () => void; onNewConversation?: () => void; onCompact?: () => void
  /** Plan mode as the server projects it; the chip closes it through `onPlan`. */
  plan?: boolean; onPlan?: (active: boolean) => void
  files?: WorkspaceFileEntry[]; onSearchFiles?: (query: string) => Promise<WorkspaceFileEntry[]>; onPreviewFile?: (path: string) => void
  /** `$` skill picker; returns the workspace catalog (plugin skills included). */
  onSearchSkills?: (query: string) => Promise<readonly SkillSummary[]>
  stats?: ConversationStats
  /** `ui/update-model-context` chips; App appends them to the submitted message. */
  pluginContexts?: readonly PluginContextEntry[]
  onRemovePluginContext?: (key: string) => void
}
const LEVEL_NAMES: Record<ThinkingLevel, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

/** 附件大小的可读文案；DSH 展示扩展名加上这个值。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 取文件扩展名（大写，最长 8 字符）；无扩展名时返回 FILE。 */
function fileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.slice(index + 1).toUpperCase().slice(0, 8) : 'FILE'
}

/** One-line chip preview; the whole text stays in the title attribute and the submission. */
function pluginContextPreview(text: string, max = 80): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * 功能：DSH 的共享 hero/停靠双形态输入卡，对接 Pi 会话操作——hero 形态是空会话
 * 首屏（问候语 + 工作区/分支选择），docked 形态是会话底部工具栏：附件、插件上下文
 * 芯片、输入框、/@/$ 触发的建议面板、模型/权限/计划等工具与用量状态条。
 * @param props 见 ComposerProps。
 * 内部逻辑：updateValue 在光标前检测 @/$// 触发符维护 trigger 建议（文件/技能/指令），
 * 方向键/Enter/Tab 在面板内导航与确认；onKeyDown 遵守输入法守卫（observeComposition）、
 * 自定义换行快捷键与繁忙时的发送/插入语义；hero 问候语按固定小时滚动，字号随容器
 * 宽度自适应（ResizeObserver）；document 级拖放计数管理 drop 遮罩；切换到完全权限
 * 需经风险确认弹窗勾选确认；队列条为 ZCode 风格单行（拖拽点 + 文本 + 「立即」/编辑/删除），
 * 停止响应后显示「队列已暂停」条并可一键恢复。
 */
export default function Composer(props: ComposerProps) {
  const { value, images, catalog, model, thinkingLevel, busy, disabled = false, queue, sendMode, sending,
    onChange, onAddImages, onRemoveImage, onSend, onStop, onRemoveQueue, onSelectModel, onThinkingLevel,
    hero = false, workspace, workspaces = [], accessMode = 'fullAccess',
    accessModes = ['readOnly', 'fullAccess'], onUpdateQueue, onSearchFiles, onSearchSkills, plan = false, onPlan,
    pluginContexts = [], onRemovePluginContext, queuePaused = false, onResumeQueue } = props
  const { t, settings } = useUiPreferences()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const queueAttempt = useRef<{ key: string; requestId: string } | null>(null)
  const guard = useRef<ReturnType<typeof observeComposition> | null>(null)
  const modelSearch = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<'model' | 'search' | 'access' | 'add' | 'workspace' | 'mode' | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [editingQueue, setEditingQueue] = useState<string | null>(null)
  const [queueText, setQueueText] = useState('')
  const [queueSaving, setQueueSaving] = useState<string | null>(null)
  const [queueError, setQueueError] = useState('')
  const [trigger, setTrigger] = useState<{ type: 'command' | 'file' | 'skill'; query: string; from: number; to: number } | null>(null)
  const [matches, setMatches] = useState<WorkspaceFileEntry[]>([])
  const [skillMatches, setSkillMatches] = useState<SkillSummary[]>([])
  const [fileError, setFileError] = useState('')
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const [accessConfirm, setAccessConfirm] = useState(false)
  const [accessAck, setAccessAck] = useState(false)
  const [greetingDate, setGreetingDate] = useState(() => new Date())
  const [greetingSize, setGreetingSize] = useState(30)
  const greetingRef = useRef<HTMLParagraphElement>(null)
  const greetingMeasure = useRef<HTMLSpanElement>(null)
  const greeting = chatEmptyGreeting(greetingDate)
  const greetingText = t(CHAT_EMPTY_GREETINGS[greeting].zh, CHAT_EMPTY_GREETINGS[greeting].en)
  const modelChoices = catalog?.models ?? []
  const selectedModel = modelChoices.find(item => item.provider === model?.provider && item.modelId === model.modelId)
  const thinkingChoices = selectedModel?.thinkingLevels?.length ? selectedModel.thinkingLevels : selectedModel?.reasoning ? catalog?.thinkingLevels ?? [] : ['off'] as ThinkingLevel[]
  const availableModels = useMemo(() => modelChoices.filter(item => item.available), [modelChoices])
  const matchingModels = useMemo(() => availableModels.filter(item => `${item.name} ${item.modelId} ${item.provider}`.toLowerCase().includes(modelQuery.toLowerCase())).slice(0, 60), [availableModels, modelQuery])
  const providerName = (id: string): string => catalog?.providers.find(item => item.id === id)?.name ?? id
  const attachmentsPending = images.some(image => image.status !== 'ready')
  const canSend = (value.trim() !== '' || images.length > 0) && !disabled && !sending && !attachmentsPending
  const accessLabel = (mode: AccessMode) => mode === 'readOnly' ? t('仅可查看', 'Read only') : mode === 'workspaceWrite' ? t('工作区内修改', 'Workspace write') : t('完全权限', 'Full access')
  const accessIcon = (mode: AccessMode): ReactNode => mode === 'readOnly' ? <PermissionIconReadOnlyRegular size={14} /> : mode === 'workspaceWrite' ? <PermissionIconWorkspaceWriteRegular size={14} /> : <PermissionIconFullAccessRegular size={14} />

  useEffect(() => { guard.current = observeComposition(document); return () => { guard.current?.dispose(); guard.current = null } }, [])
  // ZCode 的空会话问候语按固定小时切换（ConversationDraftEmptyState.tsx:20-60）。
  useEffect(() => {
    if (!hero) return
    const timer = window.setTimeout(() => setGreetingDate(new Date()), nextGreetingDelayMs(greetingDate))
    return () => window.clearTimeout(timer)
  }, [greetingDate, hero])
  // 仅当 30px 自然字号与 composer 宽度冲突时才缩小（:98-137）。
  useLayoutEffect(() => {
    if (!hero) return
    const container = greetingRef.current
    const measure = greetingMeasure.current
    if (!container || !measure) return
    const update = () => {
      const style = window.getComputedStyle(container)
      const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      setGreetingSize(greetingFontSizePx(container.getBoundingClientRect().width - padding, measure.getBoundingClientRect().width))
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(container)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [greeting, hero])
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

  useEffect(() => {
    if (trigger?.type !== 'skill' || onSearchSkills === undefined) return
    let active = true
    setFileError('')
    const timer = window.setTimeout(() => {
      void onSearchSkills(trigger.query).then(items => { if (active) setSkillMatches([...items].slice(0, 12)) })
        .catch(() => { if (active) { setSkillMatches([]); setFileError(t('无法读取技能列表', 'Could not list skills')) } })
    }, 100)
    return () => { active = false; clearTimeout(timer) }
  }, [trigger, onSearchSkills, t])

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
  const suggestionCount = trigger?.type === 'command' ? commandMatches.length : trigger?.type === 'skill' ? skillMatches.length : matches.length
  /** 确认当前高亮的建议项：指令执行后清除触发文本；技能/文件把插入文本写回输入框并还原光标。 */
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
    if (trigger.type === 'skill') {
      const skill = skillMatches[index]
      if (!skill) return
      const insertion = `$${skill.name} `
      onChange(value.slice(0, trigger.from) + insertion + value.slice(trigger.to))
      setTrigger(null)
      requestAnimationFrame(() => {
        textarea.current?.focus()
        const caret = trigger.from + insertion.length
        textarea.current?.setSelectionRange(caret, caret)
      })
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
  /** 更新输入值并在新光标处重新检测 @/$// 触发符，维护建议面板状态。 */
  const updateValue = (next: string, caret: number) => {
    onChange(next)
    const match = /(?:^|\s)([@/$])([^\s]*)$/.exec(next.slice(0, caret))
    setTrigger(match ? { type: match[1] === '@' ? 'file' : match[1] === '$' ? 'skill' : 'command', query: match[2] ?? '', from: caret - (match[2]?.length ?? 0) - 1, to: caret } : null)
    setSelectedSuggestion(0)
  }
  /** 输入框按键处理：输入法期间不拦截；建议面板键导航；自定义换行/发送/插入快捷键。 */
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
  /** 保存排队消息的编辑：同一内容（key 相同）复用同一 requestId 实现幂等重试。 */
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
      <div className={css.heroGreeting}>
        <svg className={css.heroLogo} viewBox="0 0 400 320" width="400" height="320" fill="none" aria-hidden="true" focusable="false">
          <text x="200" y="330" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="680" fontWeight="400" fill="none" stroke="currentColor" strokeWidth="1">π</text>
        </svg>
        <p ref={greetingRef} data-draft-greeting="true" className={css.greeting} style={{ '--greeting-font-size': `${greetingSize}px` } as CSSProperties}>
          <span ref={greetingMeasure} className={css.greetingMeasure} aria-hidden="true">{greetingText}</span>
          <span>{greetingText}</span>
        </p>
      </div>
      <div className={css.heroContext}>
        <Menu open={menu === 'workspace'} onClose={() => setMenu(null)} portal items={[
          ...workspaces.map(item => ({ id: item.id, label: item.name, icon: <IconFolderOpenOutlineRegular size={14} /> })),
          { type: 'separator', id: 'workspace-divider' }, { id: '__add', label: t('添加工作区…', 'Add workspace…'), icon: <IconPlusOutlineRegular size={14} /> },
        ]} selectedId={workspace?.id} onSelect={id => { setMenu(null); if (id === '__add') props.onAddWorkspace?.(); else props.onSelectWorkspace?.(id) }}
          anchor={<button className={css.contextButton} type="button" aria-label={t('选择工作区', 'Choose workspace')} onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')}><IconFolderOpenOutlineRegular size={15} /><span>{workspace?.name ?? t('选择工作区', 'Choose workspace')}</span><IconChevronDownOutlineRegular size={11} /></button>} />
        <GitBranchSwitcher workspaceId={workspace?.id} />
      </div>
    </>}
    {queue.length > 0 && <div className={css.queue} aria-label={t('待处理消息', 'Queued messages')}>
      {queueError && <p className={css.queueError} role="alert">{queueError}</p>}
      {queuePaused && !busy && onResumeQueue && <div className={css.queuePausedRow}>
        <span className={css.queuePausedText}>{t('由于你中断了当前响应，队列已暂停', 'You interrupted the response; the queue is paused')}</span>
        <button className={css.queueResume} type="button" onClick={onResumeQueue}>{t('继续', 'Resume')}</button>
      </div>}
      {queue.map(item => <div className={css.queueItem} key={item.id}>
        {editingQueue === item.id ? <form className={css.queueEdit} onSubmit={event => { event.preventDefault(); if (queueText.trim() || item.images?.length || item.files?.length) void submitQueueEdit(item, queueText) }}>
          <textarea value={queueText} disabled={queueSaving === item.id} onChange={event => setQueueText(event.currentTarget.value)} aria-label={t('编辑排队消息', 'Edit queued message')} rows={2} />
          <Button size="sm" variant="ghost" type="button" disabled={queueSaving === item.id} onClick={() => { setEditingQueue(null); setQueueError('') }}>{t('取消', 'Cancel')}</Button><Button size="sm" variant="primary" type="submit" disabled={queueSaving === item.id}>{queueSaving === item.id ? t('保存中…', 'Saving…') : t('保存', 'Save')}</Button>
        </form> : <>{onUpdateQueue && <svg className={css.queueGrip} viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
          {[2, 7, 12].map(y => [2, 6].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill="currentColor" />))}
        </svg>}
          {item.images?.length ? <span className={css.queueMedia}>{item.images.map((image, index) => <img key={index} className={css.queueThumb} src={`data:${image.mimeType};base64,${image.data}`} alt={t('附件图片', 'Attached image')} />)}</span> : null}
          {item.files?.length ? <span className={css.queueFiles}>{item.files.map((file, index) => <span key={index} className={css.queueFile}><FileTypeIcon path={file.name} size={12} /><span className={css.queueFileName}>{file.name}</span><span className={css.queueFileSize}>{formatBytes(file.size)}</span></span>)}</span> : null}
          <span className={css.queueText}>{item.text || (item.images?.length || item.files?.length ? '' : t('附件消息', 'Attachments'))}</span>
          {onUpdateQueue && <><button className={css.queueSteer} type="button" disabled={queueSaving !== null} aria-label={t('立即插入这条消息', 'Steer this message in now')} onClick={() => { void submitQueueEdit(item, item.text, 'steer') }}><IconChevronUpOutlineRegular size={12} />{t('立即', 'Now')}</button>
          <button className={css.queueAction} type="button" disabled={queueSaving !== null} aria-label={t('编辑排队消息', 'Edit queued message')} onClick={() => { setEditingQueue(item.id); setQueueText(item.text); setQueueError('') }}><IconEditOutlineRegular size={14} /></button></>}
          <button className={css.queueAction} type="button" aria-label={t('移除排队消息', 'Remove queued message')} onClick={() => onRemoveQueue(item.id)}><IconTrashOutlineRegular size={14} /></button></>}
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
      {pluginContexts.length > 0 && <div className={css.pluginContexts} role="group" aria-label={t('插件上下文', 'Plugin context')}>
        {pluginContexts.map(entry => {
          const key = `${entry.pluginId}:${entry.toolCallId ?? ''}`
          return <span key={key} className={css.pluginContextChip} data-plugin-context={key}>
            <span className={css.pluginContextId} title={entry.pluginId}>{entry.pluginId}</span>
            <span className={css.pluginContextText} title={entry.text}>{pluginContextPreview(entry.text)}</span>
            <button type="button" className={css.pluginContextRemove}
              aria-label={t(`移除插件上下文 ${entry.pluginId}`, `Remove plugin context ${entry.pluginId}`)}
              onClick={() => { onRemovePluginContext?.(key) }}><IconCloseOutlineRegular size={11} /></button>
          </span>
        })}
      </div>}
      <textarea ref={textarea} className={css.textarea} data-composer-input aria-label={t('发送消息', 'Message')} placeholder={hero ? t('描述你想要构建的内容，/ 调用指令、@ 文件、$ 技能', 'Describe what you want to build, / for commands, @ for files, $ for skills') : busy ? t('继续输入以排队后续修改', 'Keep typing to queue follow-up changes') : undefined}
        value={value} disabled={disabled || sending} rows={hero ? 2 : 1} onChange={event => updateValue(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={onKeyDown}
        onPaste={event => { const files = event.clipboardData.files; if (files.length) { event.preventDefault(); onAddImages(files) } }} />
      {trigger !== null && <div className={css.suggestionPanel} role="listbox" aria-label={trigger.type === 'command' ? t('指令', 'Commands') : trigger.type === 'skill' ? t('技能', 'Skills') : t('文件与文件夹', 'Files and folders')}>
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
        }) : trigger.type === 'skill' ? <>
          <div className={css.suggestionGroupTitle}>{t('技能', 'Skills')}</div>
          {skillMatches.map((skill, index) => <button key={skill.id} type="button" role="option" aria-selected={index === selectedSuggestion}
            className={`${css.suggestionItem} ${index === selectedSuggestion ? css.suggestionItemSelected : ''}`}
            onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelectedSuggestion(index)} onClick={() => chooseSuggestion(index)}>
            <span className={css.suggestionIcon}><IconSkillOutlineRegular size={16} /></span>
            <span className={css.suggestionName}>{skill.name}<small>${skill.source === 'plugin' ? ` · ${skill.pluginName ?? 'plugin'}` : ''}</small></span>
            <span className={css.suggestionDesc}>{skill.description}</span>
          </button>)}
        </> : <>
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
          {!hero && <GitBranchSwitcher workspaceId={workspace?.id} compact />}
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
      {props.stats !== undefined && <ComposerUsage stats={props.stats} contextWindow={selectedModel?.contextWindow} />}
      {busy && <Menu open={menu === 'mode'} onClose={() => setMenu(null)} side="top" portal selectedId={sendMode} items={[{ id: 'followUp', label: t('排队发送', 'Queue message') }, { id: 'steer', label: t('立即插入', 'Steer now') }]}
        onSelect={id => { props.onSendMode(id as BusySendMode); setMenu(null) }} anchor={<button className={css.modeButton} type="button" onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>{sendMode === 'steer' ? t('插入', 'Steer') : t('排队', 'Queue')}<IconChevronDownOutlineRegular size={10} /></button>} />}
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
