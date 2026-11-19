import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, LoaderCircle, Pencil } from 'lucide-react'
import type { AccessMode, ModelCatalog, ModelRef } from '../shared/types.ts'
import type { SkillSummary } from '../shared/skills.ts'
import { WORKBENCH_BOT_ICONS, type WorkbenchAgent, type WorkbenchBotIcon, type CreateWorkbenchBotInput } from '../shared/workbench.ts'
import { api } from './api.ts'
import { MessageDialog } from './message-rendering/Dialog.tsx'
import { accessModeLabel } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { botPortraitLabel, TaskAvatar } from './WorkbenchBotAvatar.tsx'
import { workbenchApi } from './workbench-api.ts'
import css from './WorkbenchBotEditor.module.css'

const modelKey = (model?: ModelRef) => model ? JSON.stringify([model.provider, model.modelId]) : ''

export function WorkbenchBotEditButton({ agent, onEdit, className, showLabel }: {
  agent: WorkbenchAgent
  onEdit: () => void
  className: string
  showLabel?: boolean
}) {
  const { t } = useUiPreferences()
  const name = t(`编辑 Bot：${agent.name}`, `Edit Bot: ${agent.name}`)
  return <button type="button" className={className} aria-label={name} title={name} aria-haspopup="dialog" onClick={onEdit}>
    <Pencil size={15} aria-hidden="true" />{showLabel && <span>{t('编辑', 'Edit')}</span>}
  </button>
}

export function WorkbenchBotEditor({ workspaceId, agent, catalog, accessModes, onClose, onSaved }: {
  workspaceId: string
  agent?: WorkbenchAgent
  catalog?: ModelCatalog | null
  accessModes: readonly AccessMode[]
  onClose: () => void
  onSaved: (agent: WorkbenchAgent) => void
}) {
  const { t } = useUiPreferences()
  const config = agent?.config
  const [name, setName] = useState(agent?.name ?? '')
  const [role, setRole] = useState(agent?.role ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [instructions, setInstructions] = useState(config?.instructions ?? '')
  const [icon, setIcon] = useState<WorkbenchBotIcon>(config?.icon ?? 'bot')
  const [model, setModel] = useState(modelKey(config?.model))
  const [access, setAccess] = useState<AccessMode>(config?.accessMode ?? (accessModes.includes('workspaceWrite') ? 'workspaceWrite' : 'readOnly'))
  const [skillIds, setSkillIds] = useState<string[] | null>(config?.skillIds ?? null)
  const [skills, setSkills] = useState<SkillSummary[]>()
  const [skillsError, setSkillsError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const [showPortraits, setShowPortraits] = useState(false)
  const avatarButton = useRef<HTMLButtonElement>(null)
  const choices = catalog?.models.filter(value => value.available) ?? []
  const defaultModel = catalog?.defaultModel?.modelId

  useEffect(() => {
    let active = true
    setSkillsError('')
    void api.getSkills(workspaceId).then(result => {
      if (active) { setSkills(result.skills); setSkillsError('') }
    }, () => { if (active) setSkillsError(t('技能列表读取失败', 'Could not load skills')) })
    return () => { active = false }
  }, [workspaceId, refresh, t])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (pending.current || !name.trim()) return
    const selectedModel = choices.find(choice => modelKey(choice) === model)
    const payload: CreateWorkbenchBotInput = {
      name: name.trim(), ...(role.trim() ? { role: role.trim() } : {}), description: description.trim(), instructions: instructions.trim(), icon,
      accessMode: access, skillIds, model: selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : model ? config?.model : null,
    }
    // On edit, omit unchanged fields, including any temporarily unavailable model/skill.
    const previous: Partial<CreateWorkbenchBotInput> = {
      ...config, name: agent?.name, role: agent?.role, description: agent?.description, model: config?.model ?? null,
    }
    const changes = agent ? Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
      JSON.stringify(previous[key as keyof CreateWorkbenchBotInput]) !== JSON.stringify(value))) : payload
    pending.current = true
    setSaving(true)
    setError('')
    try {
      if (agent && !Object.keys(changes).length) { onClose(); return }
      const result = agent ? await workbenchApi.updateBot(workspaceId, agent.id, changes) : await workbenchApi.createBot(workspaceId, payload)
      onSaved(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('保存失败，请重试', 'Could not save. Try again.'))
    } finally { pending.current = false; setSaving(false) }
  }

  return <MessageDialog open drawer title={agent ? t('编辑 Bot', 'Edit Bot') : t('创建 Bot', 'Create Bot')} description={agent?.name}
    onClose={() => { if (!pending.current) onClose() }} t={t}>
    <form className={css.form} onSubmit={event => void save(event)}>
      <div className={css.fields}>
        <div className={css.identity}>
          <button ref={avatarButton} type="button" className={css.avatarButton} aria-expanded={showPortraits} onClick={() => setShowPortraits(v => !v)}>
            <TaskAvatar icon={icon} large /><span>{t('更换头像', 'Change avatar')}</span>
          </button>
          <label>{t('名称', 'Name')}<input required maxLength={60} value={name} onChange={e => setName(e.currentTarget.value)} /></label>
        </div>
        {showPortraits && <fieldset className={css.portraits}><legend>{t('选择头像', 'Select avatar')}</legend>
          {WORKBENCH_BOT_ICONS.map(key => <button key={key} type="button" title={botPortraitLabel(key, t)} aria-label={botPortraitLabel(key, t)}
            aria-pressed={icon === key} onClick={() => { setIcon(key); setShowPortraits(false); avatarButton.current?.focus() }}><TaskAvatar icon={key} /></button>)}
        </fieldset>}
        <label>{t('角色', 'Role')}<input required={Boolean(agent)} maxLength={100} value={role} onChange={e => setRole(e.currentTarget.value)} placeholder={t('例如：数据校验', 'For example: data validation')} /></label>
        <label>{t('适用任务', 'When to use')}<textarea rows={2} maxLength={500} value={description} onChange={e => setDescription(e.currentTarget.value)}
          placeholder={t('主 Agent 根据这段描述选择执行者', 'Used by the lead to find the right Bot')} /></label>
        <label>{t('工作指令', 'Instructions')}<textarea rows={4} maxLength={4000} value={instructions} onChange={e => setInstructions(e.currentTarget.value)}
          placeholder={t('写明职责、边界和交付要求', 'Describe responsibilities, boundaries and deliverables')} /></label>
        <fieldset className={css.runtime}><legend>{t('运行配置', 'Runtime configuration')}</legend>
          <div className={css.runtimeFields}>
            <label>{t('模型', 'Model')}<select value={model} onChange={e => setModel(e.currentTarget.value)}>
              <option value="">{t('跟随默认模型', 'Use default model')}{defaultModel ? ' · ' + defaultModel : ''}</option>
              {model && !choices.some(option => modelKey(option) === model) && <option value={model} disabled>{t('当前不可用', 'Unavailable')} · {config?.model?.modelId}</option>}
              {choices.map(option => <option key={modelKey(option)} value={modelKey(option)}>{option.name} · {option.provider}</option>)}
            </select></label>
            <label>{t('权限上限', 'Access limit')}<select value={access} onChange={e => setAccess(e.currentTarget.value as AccessMode)}>
              {!accessModes.includes(access) && <option disabled value={access}>{accessModeLabel(access, t)}</option>}
              {accessModes.map(value => <option key={value} value={value}>{accessModeLabel(value, t)}</option>)}
            </select></label>
            <fieldset className={css.skills}><legend>{t('技能', 'Skills')}</legend>
              <label><input type="checkbox" checked={skillIds === null} onChange={e => setSkillIds(e.currentTarget.checked ? null : [])} />{t('全部可用技能', 'All available skills')}</label>
              {skillIds !== null && <div className={css.skillList}>
                {skills?.map(skill => <label key={skill.id} title={skill.description}><input type="checkbox" checked={skillIds.includes(skill.id)}
                  onChange={e => setSkillIds(e.currentTarget.checked ? [...skillIds, skill.id] : skillIds.filter(id => id !== skill.id))} />{skill.name}<small>{skill.source}</small></label>)}
                {skills === undefined && !skillsError && <small role="status">{t('正在读取技能…', 'Loading skills…')}</small>}
                {skills?.length === 0 && <small>{t('当前没有可选技能', 'No skills available')}</small>}
                {skillsError && <p role="alert">{skillsError} <button type="button" onClick={() => setRefresh(v => v + 1)}>{t('重试', 'Retry')}</button></p>}
              </div>}
            </fieldset>
          </div>
        </fieldset>
      </div>
      {error && <p role="alert" className={css.error}>{error}</p>}
      <footer><button type="button" onClick={onClose} disabled={saving}>{t('取消', 'Cancel')}</button>
        <button className={css.save} type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle size={15} /> : <Check size={15} />}
          {saving ? t('正在保存', 'Saving') : agent ? t('保存修改', 'Save changes') : t('创建 Bot', 'Create Bot')}</button></footer>
    </form>
  </MessageDialog>
}
