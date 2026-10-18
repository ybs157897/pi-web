import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  Button, FileTypeIcon, IconAgentPresetOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular,
  IconCloseOutlineRegular, IconEditOutlineRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular,
  IconSendOutlineRegular, IconStopFillRegular, Input, Menu, MenuItemButton, PermissionIconFullAccessRegular,
  PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, Tooltip, observeComposition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccessMode, AgentPreset, ConversationDetail, ModelCatalog, ModelOption, QueueActionInput, QueueItem, ThinkingLevel, WorkspaceFileEntry, WorkspaceSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { matchesShortcut, resolveShortcuts } from './keyboard.ts'
import css from './Composer.module.css'

export interface DraftImage { id: string; file: File; preview: string; data: string; mimeType: string }
export type BusySendMode = 'followUp' | 'steer'
export interface ComposerProps {
  value: string; images: readonly DraftImage[]; catalog: ModelCatalog | null
  model?: { provider: string; modelId: string }; thinkingLevel: ThinkingLevel; busy: boolean; disabled?: boolean
  queue: readonly QueueItem[]; sendMode: BusySendMode; sending: boolean
  onChange: (value: string) => void; onAddImages: (files: FileList | File[]) => void; onRemoveImage: (id: string) => void
  onSend: (mode?: BusySendMode) => void; onStop: () => void; onRemoveQueue: (id: string) => void
  onSelectModel: (model: ModelOption) => void; onThinkingLevel: (level: ThinkingLevel) => void; onSendMode: (mode: BusySendMode) => void
  hero?: boolean; workspace?: WorkspaceSummary; workspaces?: WorkspaceSummary[]; onSelectWorkspace?: (id: string) => void; onAddWorkspace?: () => void
  presetId?: string; presets?: AgentPreset[]; onSelectPreset?: (id: string) => void
  accessMode?: AccessMode; accessModes?: AccessMode[]; onAccessMode?: (mode: AccessMode) => void
  onUpdateQueue?: (id: string, action: QueueActionInput) => Promise<void>
  onOpenSettings?: () => void; onNewConversation?: () => void; onCompact?: () => void
  files?: WorkspaceFileEntry[]; onSearchFiles?: (query: string) => Promise<WorkspaceFileEntry[]>; onPreviewFile?: (path: string) => void
  usage?: ConversationDetail['usage']; runCount?: number; stepCount?: number; contextTokens?: number
}
const LEVEL_NAMES: Record<ThinkingLevel, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

/** DSH's shared hero/docked composer, connected to Pi conversation operations. */
export default function Composer(props: ComposerProps) {
  const { value, images, catalog, model, thinkingLevel, busy, disabled = false, queue, sendMode, sending,
    onChange, onAddImages, onRemoveImage, onSend, onStop, onRemoveQueue, onSelectModel, onThinkingLevel,
    hero = false, workspace, workspaces = [], presets = [], presetId, accessMode = 'fullAccess',
    accessModes = ['readOnly', 'fullAccess'], onUpdateQueue, onSearchFiles } = props
  const { t, settings } = useUiPreferences()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const queueAttempt = useRef<{ key: string; requestId: string } | null>(null)
  const guard = useRef<ReturnType<typeof observeComposition> | null>(null)
  const modelSearch = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<'model' | 'search' | 'access' | 'add' | 'workspace' | 'preset' | 'mode' | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [editingQueue, setEditingQueue] = useState<string | null>(null)
  const [queueText, setQueueText] = useState('')
  const [queueSaving, setQueueSaving] = useState<string | null>(null)
  const [queueError, setQueueError] = useState('')
  const [trigger, setTrigger] = useState<{ type: 'command' | 'file'; query: string; from: number; to: number } | null>(null)
  const [matches, setMatches] = useState<WorkspaceFileEntry[]>([])
  const [fileError, setFileError] = useState('')
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const modelChoices = catalog?.models ?? []
  const selectedModel = modelChoices.find(item => item.provider === model?.provider && item.modelId === model.modelId)
  const thinkingChoices = selectedModel?.thinkingLevels?.length ? selectedModel.thinkingLevels : selectedModel?.reasoning ? catalog?.thinkingLevels ?? [] : ['off'] as ThinkingLevel[]
  const availableModels = useMemo(() => modelChoices.filter(item => item.available), [modelChoices])
  const matchingModels = useMemo(() => availableModels.filter(item => `${item.name} ${item.modelId} ${item.provider}`.toLowerCase().includes(modelQuery.toLowerCase())).slice(0, 60), [availableModels, modelQuery])
  const selectedPreset = presets.find(item => item.id === presetId)
  const canSend = (value.trim() !== '' || images.length > 0) && !disabled && !sending
  const accessLabel = (mode: AccessMode) => mode === 'readOnly' ? t('只读', 'Read only') : mode === 'workspaceWrite' ? t('工作区内修改', 'Workspace write') : t('完全访问', 'Full access')
  const accessIcon = (mode: AccessMode): ReactNode => mode === 'readOnly' ? <PermissionIconReadOnlyRegular size={14} /> : mode === 'workspaceWrite' ? <PermissionIconWorkspaceWriteRegular size={14} /> : <PermissionIconFullAccessRegular size={14} />

  useEffect(() => { guard.current = observeComposition(document); return () => { guard.current?.dispose(); guard.current = null } }, [])
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
      void onSearchFiles(trigger.query).then(items => { if (active) setMatches(items.filter(item => item.type === 'file').slice(0, 12)) })
        .catch(() => { if (active) { setMatches([]); setFileError(t('无法读取文件列表', 'Could not list files')) } })
    }, 100)
    return () => { active = false; clearTimeout(timer) }
  }, [trigger, onSearchFiles, t])

  const commands = [
    { id: 'model', label: t('选择模型', 'Select model'), run: () => setMenu('search') },
    { id: 'settings', label: t('打开设置', 'Open settings'), run: () => props.onOpenSettings?.() },
    { id: 'new', label: t('新建会话', 'New conversation'), run: () => props.onNewConversation?.() },
    ...(busy ? [{ id: 'stop', label: t('停止当前回答', 'Stop response'), run: onStop }] : []),
    ...(props.onCompact ? [{ id: 'compact', label: t('压缩上下文', 'Compact context'), run: props.onCompact }] : []),
  ]
  const commandMatches = trigger?.type === 'command' ? commands.filter(item => item.id.startsWith(trigger.query.toLowerCase())) : []
  const suggestionCount = trigger?.type === 'command' ? commandMatches.length : matches.length
  const chooseSuggestion = (index: number) => {
    if (!trigger) return
    if (trigger.type === 'command') {
      const command = commandMatches[index]
      if (!command) return
      onChange(value.slice(0, trigger.from) + value.slice(trigger.to))
      command.run()
    } else {
      const file = matches[index]
      if (!file) return
      const insertion = file.path.includes(' ') ? `@"${file.path}" ` : `@${file.path} `
      onChange(value.slice(0, trigger.from) + insertion + value.slice(trigger.to))
      requestAnimationFrame(() => {
        textarea.current?.focus()
        const caret = trigger.from + insertion.length
        textarea.current?.setSelectionRange(caret, caret)
      })
    }
    setTrigger(null)
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
        </form> : <><span className={css.queueText}>{item.text || t('附件消息', 'Attachments')}</span><span className={css.queueMode}>{item.mode === 'steer' ? t('插入', 'Steer') : t('排队', 'Queued')}</span>
          {onUpdateQueue && <><button className={css.queueAction} type="button" disabled={queueSaving !== null} aria-label={t('编辑排队消息', 'Edit queued message')} onClick={() => { setEditingQueue(item.id); setQueueText(item.text); setQueueError('') }}><IconEditOutlineRegular size={14} /></button>
          {item.mode !== 'steer' && <button className={css.queueAction} type="button" disabled={queueSaving !== null} onClick={() => { void submitQueueEdit(item, item.text, 'steer') }}>{t('立即插入', 'Steer now')}</button>}</>}
          <button className={css.queueAction} type="button" aria-label={t('移除排队消息', 'Remove queued message')} onClick={() => onRemoveQueue(item.id)}><IconCloseOutlineRegular size={14} /></button></>}
      </div>)}
    </div>}
    <div className={css.card} ref={card} onDragOver={event => { event.preventDefault() }} onDrop={event => { event.preventDefault(); if (!disabled) onAddImages(event.dataTransfer.files) }}>
      {images.length > 0 && <div className={css.attachments}>{images.map(image => <div key={image.id} className={css.attachment}>
        {image.mimeType.startsWith('image/') ? <img src={image.preview} alt={image.file.name} /> : <FileTypeIcon path={image.file.name} />}
        <span>{image.file.name}</span><button type="button" aria-label={t('移除附件', 'Remove attachment')} onClick={() => onRemoveImage(image.id)}><IconCloseOutlineRegular size={12} /></button>
      </div>)}</div>}
      <textarea ref={textarea} className={css.textarea} aria-label={t('发送消息', 'Message')} placeholder={hero ? t('描述你想要构建的内容, / 调用指令, @ 文件或对话', 'Describe what you want to build, / for commands, @ for files') : t('发消息或创建任务, / 调用指令, @ 文件或对话', 'Send a message or create a task, / commands, @ files')}
        value={value} disabled={disabled || sending} rows={hero ? 2 : 1} onChange={event => updateValue(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={onKeyDown}
        onPaste={event => { const files = event.clipboardData.files; if (files.length) { event.preventDefault(); onAddImages(files) } }} />
      <Menu open={trigger !== null} anchor={<span className={css.menuAnchor} aria-hidden />} getAnchorRect={() => card.current?.getBoundingClientRect() ?? null} side="top" portal onClose={() => setTrigger(null)} listClassName={css.suggestionMenu}
        items={trigger?.type === 'command' ? commandMatches.map((item, index) => ({ id: String(index), label: <span className={css.suggestionRow}><b>/{item.id}</b><span>{item.label}</span></span> })) : matches.map((item, index) => ({ id: String(index), label: <span className={css.suggestionRow}><FileTypeIcon path={item.path} /><span>{item.path}</span></span> }))}
        selectedId={String(selectedSuggestion)} onSelect={id => chooseSuggestion(Number(id))}>
        {suggestionCount === 0 && <div className={css.emptyMenu}>{fileError || t('没有匹配项', 'No matches')}</div>}
      </Menu>
      <div className={css.toolbar}>
        <div className={css.tools}>
          <input ref={fileInput} type="file" multiple className={css.fileInput} onChange={event => { if (event.currentTarget.files) onAddImages(event.currentTarget.files); event.currentTarget.value = '' }} />
          <Menu open={menu === 'add'} onClose={() => setMenu(null)} side="top" portal items={[
            { id: 'upload', label: t('添加文件', 'Add files'), icon: <IconPlusOutlineRegular size={14} /> },
            { id: 'reference', label: t('引用工作区文件', 'Reference workspace file'), disabled: !workspace },
            { id: 'commands', label: t('调用指令', 'Commands') },
          ]} onSelect={id => { setMenu(null); if (id === 'upload') fileInput.current?.click(); else { const symbol = id === 'reference' ? '@' : '/'; const next = `${value}${value ? ' ' : ''}${symbol}`; updateValue(next, next.length); requestAnimationFrame(() => textarea.current?.focus()) } }}
            anchor={<button type="button" className={css.add} aria-label={t('添加文件或调用指令', 'Add files or commands')} disabled={disabled} onClick={() => setMenu(menu === 'add' ? null : 'add')}><IconPlusOutlineRegular size={16} /></button>} />
          <Menu open={menu === 'access'} onClose={() => setMenu(null)} side="top" portal items={accessModes.map(mode => ({ id: mode, label: accessLabel(mode), icon: accessIcon(mode) }))} selectedId={accessMode}
            onSelect={id => { props.onAccessMode?.(id as AccessMode); setMenu(null) }} anchor={<button type="button" className={css.select} aria-label={`${t('访问模式，当前：', 'Access mode: ')}${accessLabel(accessMode)}`} onClick={() => setMenu(menu === 'access' ? null : 'access')} disabled={disabled}>{accessIcon(accessMode)}<span className={css.accessText}>{accessLabel(accessMode)}</span><IconChevronDownOutlineRegular size={11} /></button>} />
        </div>
        <div className={css.trailing}>
          <Menu open={menu === 'model'} onClose={() => setMenu(null)} side="top" align="end" portal items={[
            { id: 'models', label: <span className={css.modelMenuRow}><span>{t('模型', 'Model')}</span><span>{selectedModel?.name ?? t('选择模型', 'Select model')}</span></span>, submenu: [
              { id: '__search', label: t('搜索模型…', 'Search models…') }, ...availableModels.slice(0, 40).map(item => ({ id: `model:${item.provider}/${item.modelId}`, label: item.name })),
            ] },
            { id: 'thinking', label: <span className={css.modelMenuRow}><span>{t('推理等级', 'Reasoning effort')}</span><span>{LEVEL_NAMES[thinkingLevel]}</span></span>, submenu: thinkingChoices.map(level => ({ id: `thinking:${level}`, label: LEVEL_NAMES[level] })) },
          ]} selectedIds={[`model:${model?.provider}/${model?.modelId}`, `thinking:${thinkingLevel}`]} onSelect={id => {
            if (id === '__search') { setMenu('search'); return }
            if (id.startsWith('thinking:')) onThinkingLevel(id.slice(9) as ThinkingLevel)
            else { const selected = availableModels.find(item => `model:${item.provider}/${item.modelId}` === id); if (selected) onSelectModel(selected) }
            setMenu(null)
          }} anchor={<button type="button" className={css.select} aria-label={t('模型与推理等级', 'Model and reasoning effort')} onClick={() => setMenu(menu === 'model' ? null : 'model')} disabled={disabled}>
            <span className={css.modelName}>{selectedModel?.name ?? model?.modelId ?? t('请选择模型', 'Select a model')}</span><span className={css.thinkingLevel}>{LEVEL_NAMES[thinkingLevel]}</span><IconChevronDownOutlineRegular size={11} />
          </button>} />
          <Menu open={menu === 'search'} onClose={() => setMenu(null)} side="top" align="end" portal anchor={<span className={css.menuAnchor} aria-hidden />} getAnchorRect={() => card.current?.getBoundingClientRect() ?? null} listClassName={css.modelSearchMenu}>
            <div className={css.modelSearch}><Input ref={modelSearch} value={modelQuery} placeholder={t('搜索模型', 'Search models')} onChange={event => setModelQuery(event.currentTarget.value)} /></div>
            {matchingModels.map(item => <MenuItemButton key={`${item.provider}/${item.modelId}`} onSelect={() => { onSelectModel(item); setMenu(null) }}><span className={css.modelMenuRow}><span>{item.name}<small>{item.provider}</small></span>{item.provider === model?.provider && item.modelId === model.modelId && <IconCheckOutlineRegular size={14} />}</span></MenuItemButton>)}
            {matchingModels.length === 0 && <div className={css.emptyMenu}>{t('没有可用模型', 'No available models')}</div>}
            <MenuItemButton separatorBefore onSelect={() => { setMenu(null); props.onOpenSettings?.() }}>{t('管理模型提供商', 'Manage model providers')}</MenuItemButton>
          </Menu>
          {busy && canSend && <Tooltip label={t('停止当前回答', 'Stop current response')} portal><button className={css.stopSecondary} type="button" aria-label={t('停止当前回答', 'Stop current response')} onClick={onStop}><IconStopFillRegular size={14} /></button></Tooltip>}
          <Tooltip label={busy && !canSend ? t('停止当前回答', 'Stop current response') : busy ? sendMode === 'steer' ? t('立即插入', 'Steer now') : t('排队发送', 'Queue message') : t('发送消息', 'Send message')} portal>
            <button type="button" className={css.send} disabled={disabled || sending || !busy && !canSend} aria-label={busy && !canSend ? t('停止当前回答', 'Stop current response') : t('发送消息', 'Send message')}
              onClick={() => { setTrigger(null); if (busy && !canSend) onStop(); else onSend(sendMode) }}>{busy && !canSend ? <IconStopFillRegular size={16} /> : <IconSendOutlineRegular size={20} />}</button>
          </Tooltip>
        </div>
      </div>
    </div>
    {!hero && <div className={css.statusStrip}>
      {props.runCount !== undefined && <span>{props.runCount} {t('轮', 'runs')} {props.stepCount ?? 0} {t('步', 'steps')}</span>}
      {props.usage && <Tooltip label={`${t('输入', 'Input')} ${props.usage.input.toLocaleString()} · ${t('输出', 'Output')} ${props.usage.output.toLocaleString()} · $${props.usage.totalCost.toFixed(5)}`} portal><span>{(props.usage.input + props.usage.output).toLocaleString()} tok</span></Tooltip>}
      {props.contextTokens !== undefined && selectedModel?.contextWindow ? <span>{t('上下文', 'Context')} {Math.min(100, Math.round(props.contextTokens / selectedModel.contextWindow * 100))}%</span> : null}
      {busy && <Menu open={menu === 'mode'} onClose={() => setMenu(null)} side="top" portal selectedId={sendMode} items={[{ id: 'followUp', label: t('排队发送', 'Queue message') }, { id: 'steer', label: t('立即插入', 'Steer now') }]}
        onSelect={id => { props.onSendMode(id as BusySendMode); setMenu(null) }} anchor={<button type="button" onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>{sendMode === 'steer' ? t('插入', 'Steer') : t('排队', 'Queue')}<IconChevronDownOutlineRegular size={10} /></button>} />}
    </div>}
  </div>
}
