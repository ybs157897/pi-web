import { useState } from 'react'
import { Button, IconEditOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccessMode, AgentPreset, CreateAgentPresetInput, ModelOption, ThinkingLevel, UpdateAgentPresetInput } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './PresetsPanel.module.css'

export interface PresetsPanelProps {
  presets: readonly AgentPreset[]
  models?: readonly ModelOption[]
  defaultPresetId?: string
  loading?: boolean
  error?: string
  onRefresh?: () => void
  onChange: (presets: AgentPreset[]) => void
  onSetDefault: (id?: string) => void
}

/** Manage reusable agent instructions, model defaults, tools, and access mode. */
export default function PresetsPanel({ presets, models = [], defaultPresetId, loading = false, error = '', onRefresh, onChange, onSetDefault }: PresetsPanelProps) {
  const { t } = useUiPreferences()
  const [editing, setEditing] = useState<AgentPreset | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<AgentPreset | null>(null)
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState('')
  const panelError = error || mutationError

  const save = async (input: CreateAgentPresetInput | UpdateAgentPresetInput): Promise<void> => {
    setBusy(true)
    setMutationError('')
    try {
      if (editing === null) {
        const result = await api.createPreset(input as CreateAgentPresetInput)
        onChange([result.preset, ...presets])
      } else {
        const result = await api.updatePreset(editing.id, input)
        onChange(presets.map(item => item.id === editing.id ? result.preset : item))
      }
      setEditing(null)
      setCreating(false)
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : t('无法保存 Agent 预设', 'Could not save the agent preset'))
    } finally { setBusy(false) }
  }

  const remove = async (): Promise<void> => {
    if (deleting === null) return
    setBusy(true)
    try {
      await api.deletePreset(deleting.id)
      onChange(presets.filter(item => item.id !== deleting.id))
      if (defaultPresetId === deleting.id) onSetDefault(undefined)
      setDeleting(null)
      setMutationError('')
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : t('无法删除 Agent 预设', 'Could not delete the agent preset'))
    } finally { setBusy(false) }
  }

  return <div className={css.panel}>
    <div className={css.head}><p>{t('保存常用指令、工具和访问级别，快速应用到新会话', 'Save instructions, tools, and access levels for new conversations')}</p>
      {onRefresh !== undefined && <Button variant="ghost" size="sm" aria-label={t('刷新预设', 'Refresh presets')} icon={<IconRefreshOutlineRegular size={15} />} onClick={onRefresh} />}
      <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={14} />} onClick={() => { setEditing(null); setCreating(true) }}>{t('新建预设', 'New preset')}</Button></div>
    {panelError !== '' && <p className={css.error} role="alert">{panelError}</p>}
    {loading && presets.length === 0 && <div className={css.skeleton} aria-label={t('正在读取预设', 'Loading presets')}><i /><i /></div>}
    {!loading && error !== '' && presets.length === 0 && onRefresh !== undefined && <Button variant="outline" size="sm" onClick={onRefresh}>{t('重试', 'Retry')}</Button>}
    {!loading && error === '' && presets.length === 0
      ? <p className={css.empty}>{t('还没有 Agent 预设', 'No agent presets yet')}</p>
      : <ul className={css.list}>{presets.map(preset => <li className={css.card} key={preset.id}>
        <div className={css.cardHead}><div className={css.main}><div className={css.title}><strong>{preset.name}</strong>
          {preset.id === defaultPresetId && <span>{t('默认', 'Default')}</span>}</div>
          <p>{preset.description || preset.instructions || t('未填写说明', 'No description')}</p>
          <small>{t(`${preset.tools.length} 个工具 · ${accessLabel(preset.accessMode, 'zh')}`, `${preset.tools.length} tools · ${accessLabel(preset.accessMode, 'en')}`)}</small>
        </div><div className={css.actions}>
          <Button variant="ghost" size="sm" aria-label={t(`编辑预设 ${preset.name}`, `Edit preset ${preset.name}`)} icon={<IconEditOutlineRegular size={15} />}
            onClick={() => { setEditing(preset); setCreating(true) }} />
          <Button variant="ghost" size="sm" aria-label={t(`删除预设 ${preset.name}`, `Delete preset ${preset.name}`)} icon={<IconTrashOutlineRegular size={15} />}
            onClick={() => { setDeleting(preset) }} />
        </div></div>
        <div className={css.cardFoot}><span>{preset.model ? `${preset.model.provider} · ${preset.model.modelId}` : t('使用当前默认模型', 'Use current default model')}</span>
          <Switch checked={preset.id === defaultPresetId} label={t(`设为默认预设 ${preset.name}`, `Make ${preset.name} the default preset`)}
            onChange={checked => { onSetDefault(checked ? preset.id : undefined) }} /></div>
      </li>)}</ul>}
    <PresetDialog key={editing?.id ?? (creating ? 'new' : 'closed')} open={creating} preset={editing} models={models} busy={busy}
      onClose={() => { setCreating(false); setEditing(null) }} onSave={input => { void save(input) }} />
    <Modal open={deleting !== null} onClose={() => { setDeleting(null) }} title={t('删除 Agent 预设', 'Delete agent preset')}
      description={t(`确定删除「${deleting?.name ?? ''}」？已创建的会话不会改变。`, `Delete “${deleting?.name ?? ''}”? Existing conversations will not change.`)}
      closeLabel={t('关闭确认', 'Close confirmation')} footer={<div className={css.modalActions}>
        <Button variant="ghost" onClick={() => { setDeleting(null) }}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void remove() }}>{t('删除', 'Delete')}</Button>
      </div>} />
  </div>
}

function PresetDialog({ open, preset, models, busy, onClose, onSave }: {
  open: boolean
  preset: AgentPreset | null
  models: readonly ModelOption[]
  busy: boolean
  onClose: () => void
  onSave: (input: CreateAgentPresetInput | UpdateAgentPresetInput) => void
}) {
  const { t } = useUiPreferences()
  const [name, setName] = useState(preset?.name ?? '')
  const [description, setDescription] = useState(preset?.description ?? '')
  const [instructions, setInstructions] = useState(preset?.instructions ?? '')
  const [tools, setTools] = useState((preset?.tools ?? []).join(', '))
  const [extensions, setExtensions] = useState((preset?.extensions ?? []).join(', '))
  const [modelKey, setModelKey] = useState(preset?.model ? `${preset.model.provider}/${preset.model.modelId}` : '')
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(preset?.thinkingLevel ?? 'off')
  const [accessMode, setAccessMode] = useState<AccessMode>(preset?.accessMode ?? 'fullAccess')
  const [error, setError] = useState('')

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalizedName = name.trim()
    if (normalizedName === '') {
      setError(t('请填写预设名称', 'Enter a preset name'))
      return
    }
    const model = models.find(item => `${item.provider}/${item.modelId}` === modelKey)
    const input: CreateAgentPresetInput = {
      name: normalizedName,
      description: description.trim(),
      instructions: instructions.trim(),
      tools: splitNames(tools),
      extensions: splitNames(extensions),
      accessMode,
      thinkingLevel,
      ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
    }
    setError('')
    onSave(input)
  }

  return <Modal open={open} onClose={onClose} title={preset === null ? t('新建 Agent 预设', 'New agent preset') : t('编辑 Agent 预设', 'Edit agent preset')}
    description={t('预设在新会话中应用，不会改写已有会话', 'Presets apply to new conversations and do not rewrite existing ones')}
    closeLabel={t('关闭预设编辑', 'Close preset editor')} className={css.dialog}>
    <form className={css.form} onSubmit={submit}>
      <Field id="preset-name" label={t('名称', 'Name')} value={name} onChange={setName} />
      <Field id="preset-description" label={t('说明', 'Description')} value={description} onChange={setDescription} />
      <label htmlFor="preset-instructions">{t('系统指令', 'Instructions')}</label>
      <textarea id="preset-instructions" rows={5} value={instructions} onChange={event => { setInstructions(event.currentTarget.value) }} />
      <Field id="preset-tools" label={t('工具名称（逗号分隔）', 'Tool names (comma separated)')} value={tools} onChange={setTools} />
      <Field id="preset-extensions" label={t('扩展 ID（逗号分隔）', 'Extension IDs (comma separated)')} value={extensions} onChange={setExtensions} />
      <label htmlFor="preset-model">{t('默认模型', 'Default model')}</label>
      <select id="preset-model" value={modelKey} onChange={event => { setModelKey(event.currentTarget.value) }}>
        <option value="">{t('跟随全局默认', 'Use global default')}</option>
        {models.map(model => <option key={`${model.provider}/${model.modelId}`} value={`${model.provider}/${model.modelId}`}>{model.name} · {model.provider}</option>)}
      </select>
      <div className={css.twoColumns}>
        <div><label htmlFor="preset-thinking">{t('思考等级', 'Thinking level')}</label><select id="preset-thinking" value={thinkingLevel} onChange={event => { setThinkingLevel(event.currentTarget.value as ThinkingLevel) }}>
          {(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(level => <option key={level} value={level}>{level}</option>)}
        </select></div>
        <div><label htmlFor="preset-access">{t('访问级别', 'Access mode')}</label><select id="preset-access" value={accessMode} onChange={event => { setAccessMode(event.currentTarget.value as AccessMode) }}>
          <option value="readOnly">{t('只读', 'Read only')}</option><option value="fullAccess">{t('完整访问', 'Full access')}</option>
        </select></div>
      </div>
      {error !== '' && <p className={css.error} role="alert">{error}</p>}
      <div className={css.modalActions}><Button variant="ghost" type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? t('保存中…', 'Saving…') : t('保存预设', 'Save preset')}</Button></div>
    </form>
  </Modal>
}

function Field({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <div className={css.field}><label htmlFor={id}>{label}</label><input id={id} value={value} onChange={event => { onChange(event.currentTarget.value) }} /></div>
}

function splitNames(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function accessLabel(mode: AccessMode, locale: 'zh' | 'en'): string {
  if (mode === 'readOnly') return locale === 'zh' ? '仅可查看' : 'Read only'
  if (mode === 'workspaceWrite') return locale === 'zh' ? '工作区内修改' : 'Workspace write'
  return locale === 'zh' ? '完全权限' : 'Full access'
}
