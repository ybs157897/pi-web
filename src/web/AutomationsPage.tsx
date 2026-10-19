import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Button, IconClockOutlineRegular, IconEditOutlineRegular, IconPlayOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconTrashOutlineRegular, Input, Modal, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Automation, CreateAutomationInput, UpdateAutomationInput } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './AutomationsPage.module.css'

interface AutomationsPageProps {
  workspaceId?: string
  presetId?: string
  onOpenConversation: (id: string) => void
}

/** Status tabs. DSH also tracks finished runs; here only the enabled flag exists, so
 * 「已结束」 maps to a paused automation (`!enabled`) until a real end state lands. */
type StatusFilter = 'all' | 'enabled' | 'finished'

const STATUS_FILTERS: readonly { value: StatusFilter; zh: string; en: string }[] = [
  { value: 'all', zh: '全部', en: 'All' },
  { value: 'enabled', zh: '已开启', en: 'Enabled' },
  { value: 'finished', zh: '已结束', en: 'Finished' },
]

/** Manage recurring tasks and open each run in its durable conversation. */
export default function AutomationsPage({ workspaceId, presetId, onOpenConversation }: AutomationsPageProps) {
  const { t } = useUiPreferences()
  const [items, setItems] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState<Automation | null>(null)
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listAutomations()
      setItems(result.automations)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法读取自动化任务', 'Could not load automations'))
    } finally { setLoading(false) }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  const save = async (input: CreateAutomationInput | UpdateAutomationInput): Promise<void> => {
    setBusyId(editing?.id ?? '__new__')
    setNotice('')
    try {
      if (editing === null) {
        if (typeof input.name !== 'string' || typeof input.prompt !== 'string') throw new Error(t('请填写任务名称和提示词', 'Enter an automation name and prompt'))
        const result = await api.createAutomation({
          name: input.name,
          prompt: input.prompt,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(typeof input.intervalMs === 'number' ? { intervalMs: input.intervalMs } : {}),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(presetId === undefined ? {} : { presetId }),
        })
        setItems(current => [result.automation, ...current])
        setNotice(t('自动化任务已创建', 'Automation created'))
      } else {
        const result = await api.updateAutomation(editing.id, input)
        setItems(current => current.map(item => item.id === editing.id ? result.automation : item))
        setNotice(t('自动化任务已保存', 'Automation saved'))
      }
      setDialogOpen(false)
      setEditing(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法保存自动化任务', 'Could not save automation'))
    } finally { setBusyId(null) }
  }

  const runNow = async (automation: Automation): Promise<void> => {
    setBusyId(automation.id)
    setNotice('')
    try {
      const result = await api.runAutomation(automation.id)
      setItems(current => current.map(item => item.id === automation.id ? result.automation : item))
      setNotice(t(`已开始运行「${automation.name}」`, `Started “${automation.name}”`))
      if (result.conversationId !== undefined) onOpenConversation(result.conversationId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法启动自动化任务', 'Could not start automation'))
    } finally { setBusyId(null) }
  }

  const toggle = async (automation: Automation, enabled: boolean): Promise<void> => {
    setBusyId(automation.id)
    try {
      const result = await api.updateAutomation(automation.id, { enabled })
      setItems(current => current.map(item => item.id === automation.id ? result.automation : item))
      setNotice(enabled ? t('自动化任务已启用', 'Automation enabled') : t('自动化任务已暂停', 'Automation paused'))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法更新自动化任务', 'Could not update automation'))
    } finally { setBusyId(null) }
  }

  const remove = async (): Promise<void> => {
    if (deleting === null) return
    setBusyId(deleting.id)
    try {
      await api.deleteAutomation(deleting.id)
      setItems(current => current.filter(item => item.id !== deleting.id))
      setNotice(t('自动化任务已删除', 'Automation deleted'))
      setDeleting(null)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法删除自动化任务', 'Could not delete automation'))
    } finally { setBusyId(null) }
  }

  // 「已结束」 reads the paused flag, since automations have no separate end state yet.
  const visible = useMemo(() => {
    const byStatus = status === 'all' ? items : items.filter(item => status === 'enabled' ? item.enabled : !item.enabled)
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return byStatus
    return byStatus.filter(item => `${item.name}\n${item.prompt}`.toLocaleLowerCase().includes(needle))
  }, [items, query, status])

  return <main className={css.page}>
    <header className={css.pageHead}>
      <div><h1>{t('自动化任务', 'Automations')}</h1><p>{t('按计划运行提示词，并在会话中查看每次结果', 'Run prompts on a schedule and review each result in its conversation')}</p></div>
      <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={14} />}
        onClick={() => { setEditing(null); setDialogOpen(true) }}>{t('新建任务', 'New automation')}</Button>
    </header>
    <section className={css.filters} aria-label={t('筛选自动化任务', 'Filter automations')}>
      <div className={css.statusTabs} role="group" aria-label={t('按状态筛选', 'Filter by status')}>
        {STATUS_FILTERS.map(option => <button type="button" key={option.value} aria-pressed={status === option.value}
          data-selected={status === option.value || undefined}
          onClick={() => { setStatus(option.value) }}>{t(option.zh, option.en)}</button>)}
      </div>
      <Input className={css.search} icon={<IconSearchOutlineRegular size={15} />} value={query}
        onChange={event => { setQuery(event.currentTarget.value) }}
        placeholder={t('搜索自动化任务', 'Search automations')} aria-label={t('搜索自动化任务', 'Search automations')} />
    </section>
    {notice !== '' && <p className={css.notice} role="status">{notice}</p>}
    {error !== '' && <div className={css.failure} role="alert"><span>{error}</span><Button variant="outline" size="sm" onClick={() => { setLoading(true); void refresh() }}>{t('重试', 'Retry')}</Button></div>}
    {loading && items.length === 0 && <div className={css.skeleton} aria-label={t('正在读取任务', 'Loading tasks')}><i /><i /><i /></div>}
    {!loading && error === '' && items.length === 0 && <div className={css.empty}>
      <IconClockOutlineRegular size={24} /><p>{t('还没有自动化任务', 'No automations yet')}</p>
      <span>{t('新建任务后，可以立即运行或按固定间隔执行', 'Create a task to run a prompt now or on a repeating interval')}</span>
      <Button variant="outline" className={css.emptyAction}
        onClick={() => { setEditing(null); setDialogOpen(true) }}>{t('新建自动化任务', 'Create automation')}</Button>
    </div>}
    {!loading && error === '' && items.length > 0 && visible.length === 0
      && <p className={css.noMatch}>{t('没有匹配的自动化任务', 'No automations match')}</p>}
    <section className={css.list} aria-label={t('自动化任务列表', 'Automation list')}>
      {visible.map(automation => <article className={css.card} key={automation.id}>
        <div className={css.cardHead}>
          <div className={css.cardTitle}><h2>{automation.name}</h2><Schedule automation={automation} /></div>
          <div className={css.actions}>
            <Button variant="ghost" size="sm" aria-label={t(`运行 ${automation.name}`, `Run ${automation.name} now`)}
              disabled={busyId === automation.id} icon={<IconPlayOutlineRegular size={15} />} onClick={() => { void runNow(automation) }} />
            <Button variant="ghost" size="sm" aria-label={t(`编辑 ${automation.name}`, `Edit ${automation.name}`)}
              disabled={busyId === automation.id} icon={<IconEditOutlineRegular size={15} />} onClick={() => { setEditing(automation); setDialogOpen(true) }} />
            <Button variant="ghost" size="sm" aria-label={t(`删除 ${automation.name}`, `Delete ${automation.name}`)}
              disabled={busyId === automation.id} icon={<IconTrashOutlineRegular size={15} />} onClick={() => { setDeleting(automation) }} />
          </div>
        </div>
        <p className={css.prompt}>{automation.prompt}</p>
        <div className={css.cardFoot}>
          <span>{automation.enabled ? t('已启用', 'Enabled') : t('已暂停', 'Paused')}</span>
          <Switch checked={automation.enabled} disabled={busyId === automation.id} label={t(`启用 ${automation.name}`, `Enable ${automation.name}`)}
            onChange={enabled => { void toggle(automation, enabled) }} />
        </div>
        <RunResult automation={automation} onOpen={onOpenConversation} />
      </article>)}
    </section>
    <AutomationDialog key={editing?.id ?? 'new'} open={dialogOpen} automation={editing} saving={busyId !== null}
      onClose={() => { setDialogOpen(false); setEditing(null) }} onSave={input => { void save(input) }} />
    <Modal open={deleting !== null} onClose={() => { setDeleting(null) }} title={t('删除自动化任务', 'Delete automation')}
      description={t(`确定删除「${deleting?.name ?? ''}」？已生成的会话会保留。`, `Delete “${deleting?.name ?? ''}”? Existing conversations will remain.`)}
      closeLabel={t('关闭确认', 'Close confirmation')} footer={<div className={css.confirmActions}>
        <Button variant="ghost" onClick={() => { setDeleting(null) }}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" disabled={busyId !== null} onClick={() => { void remove() }}>{t('删除', 'Delete')}</Button>
      </div>} />
  </main>
}

function Schedule({ automation }: { automation: Automation }) {
  const { t, settings } = useUiPreferences()
  if (automation.intervalMs === undefined) return <span className={css.schedule}>{t('手动运行', 'Manual run')}</span>
  const interval = t(`每 ${Math.max(1, Math.round(automation.intervalMs / 60_000))} 分钟`, `Every ${Math.max(1, Math.round(automation.intervalMs / 60_000))} minutes`)
  const next = automation.enabled && automation.nextRunAt !== undefined
    ? new Intl.DateTimeFormat(settings.locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(automation.nextRunAt)
    : undefined
  return <span className={css.schedule}>{interval}{next === undefined ? '' : ` · ${t('下次', 'Next')} ${next}`}</span>
}

function RunResult({ automation, onOpen }: { automation: Automation; onOpen: (id: string) => void }) {
  const { t } = useUiPreferences()
  const run = automation.lastRun
  if (run === undefined) return null
  const status = run.status === 'completed' ? t('已完成', 'Completed')
    : run.status === 'running' ? t('运行中', 'Running')
      : run.status === 'failed' ? t('失败', 'Failed') : t('已中断', 'Interrupted')
  return <div className={css.lastRun} data-status={run.status}>
    <span>{t('最近运行', 'Last run')} · {status}{run.error ? ` · ${run.error}` : ''}</span>
    {run.conversationId && <Button variant="ghost" size="sm" onClick={() => { onOpen(run.conversationId as string) }}>{t('打开结果会话', 'Open result conversation')}</Button>}
  </div>
}

function AutomationDialog({ open, automation, saving, onClose, onSave }: {
  open: boolean
  automation: Automation | null
  saving: boolean
  onClose: () => void
  onSave: (input: CreateAutomationInput | UpdateAutomationInput) => void
}) {
  const { t } = useUiPreferences()
  const [name, setName] = useState(automation?.name ?? '')
  const [prompt, setPrompt] = useState(automation?.prompt ?? '')
  const [interval, setInterval] = useState(automation?.intervalMs === undefined ? '' : String(Math.round(automation.intervalMs / 60_000)))
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName(automation?.name ?? '')
    setPrompt(automation?.prompt ?? '')
    setInterval(automation?.intervalMs === undefined ? '' : String(Math.round(automation.intervalMs / 60_000)))
    setError('')
  }, [automation, open])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalizedName = name.trim()
    const normalizedPrompt = prompt.trim()
    const minutes = interval.trim() === '' ? undefined : Number(interval)
    if (normalizedName === '' || normalizedPrompt === '' || minutes !== undefined && (!Number.isFinite(minutes) || minutes < 1)) {
      setError(t('请填写名称和提示词，间隔至少为 1 分钟', 'Enter a name and prompt. The interval must be at least 1 minute.'))
      return
    }
    if (automation === null) {
      const input: CreateAutomationInput = {
        name: normalizedName,
        prompt: normalizedPrompt,
        ...(minutes === undefined ? {} : { intervalMs: Math.floor(minutes * 60_000) }),
      }
      onSave(input)
    } else {
      const input: UpdateAutomationInput = {
        name: normalizedName,
        prompt: normalizedPrompt,
        intervalMs: minutes === undefined ? null : Math.floor(minutes * 60_000),
      }
      onSave(input)
    }
  }

  return <Modal open={open} onClose={onClose} title={automation === null ? t('新建自动化任务', 'New automation') : t('编辑自动化任务', 'Edit automation')}
    description={t('任务结果会保存为 Pi 会话，可以从运行记录重新打开', 'Each result is saved as a Pi conversation and can be reopened from the run history')}
    closeLabel={t('关闭任务表单', 'Close automation form')} className={css.dialog}>
    <form className={css.form} onSubmit={submit}>
      <label htmlFor="automation-name">{t('任务名称', 'Name')}</label>
      <input id="automation-name" value={name} onChange={event => { setName(event.currentTarget.value) }} data-modal-autofocus />
      <label htmlFor="automation-prompt">{t('提示词', 'Prompt')}</label>
      <textarea id="automation-prompt" value={prompt} rows={7} onChange={event => { setPrompt(event.currentTarget.value) }} />
      <label htmlFor="automation-interval">{t('重复间隔（分钟，可选）', 'Repeat interval (minutes, optional)')}</label>
      <input id="automation-interval" value={interval} inputMode="numeric" placeholder={t('留空表示手动运行', 'Leave blank for manual runs')}
        onChange={event => { setInterval(event.currentTarget.value) }} />
      {error !== '' && <p className={css.formError} role="alert">{error}</p>}
      <div className={css.formActions}><Button variant="ghost" type="button" disabled={saving} onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" type="submit" disabled={saving}>{saving ? t('保存中…', 'Saving…') : t('保存任务', 'Save automation')}</Button></div>
    </form>
  </Modal>
}
