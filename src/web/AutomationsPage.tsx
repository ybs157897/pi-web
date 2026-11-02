import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Button, IconClockOutlineRegular, IconEditOutlineRegular, IconPlayOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconTrashOutlineRegular, Input, Modal, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Automation, AutomationRun, AutomationSchedule, CreateAutomationInput, UpdateAutomationInput } from '../shared/types.ts'
import { WEEKDAY_LABELS, describeSchedule, formatTimeOfDay, parseTimeOfDay } from '../shared/automation-schedule.ts'
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

/** How a task repeats. `none` is a manual task; `minutes` keeps the old fixed interval. */
type RepeatKind = 'none' | 'minutes' | 'hour' | 'day' | 'week' | 'month'

const REPEAT_KINDS: readonly { value: RepeatKind; zh: string; en: string }[] = [
  { value: 'none', zh: '手动', en: 'Manual' },
  { value: 'minutes', zh: '按分钟', en: 'Minutes' },
  { value: 'hour', zh: '每小时', en: 'Hourly' },
  { value: 'day', zh: '每天', en: 'Daily' },
  { value: 'week', zh: '每周', en: 'Weekly' },
  { value: 'month', zh: '每月', en: 'Monthly' },
]

function repeatKindOf(automation: Automation | null): RepeatKind {
  if (automation === null) return 'none'
  if (automation.schedule !== undefined) return automation.schedule.unit
  return automation.intervalMs === undefined ? 'none' : 'minutes'
}

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
          ...(input.schedule === undefined || input.schedule === null ? {} : { schedule: input.schedule }),
          ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
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
          <div className={css.cardTitle}>
            <h2>{automation.name}</h2>
            {automation.builtin !== undefined && <span className={css.builtin}>{t('内置', 'Built-in')}</span>}
            <Schedule automation={automation} />
          </div>
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
        <RunHistory automation={automation} onOpen={onOpenConversation} />
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
  const next = automation.enabled && automation.nextRunAt !== undefined
    ? new Intl.DateTimeFormat(settings.locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(automation.nextRunAt)
    : undefined
  let label: string
  if (automation.schedule !== undefined) label = describeSchedule(automation.schedule)
  else if (automation.intervalMs !== undefined) label = t(`每 ${Math.max(1, Math.round(automation.intervalMs / 60_000))} 分钟`, `Every ${Math.max(1, Math.round(automation.intervalMs / 60_000))} minutes`)
  else label = t('手动运行', 'Manual run')
  return <span className={css.schedule}>{label}{next === undefined ? '' : ` · ${t('下次', 'Next')} ${next}`}</span>
}

function RunHistory({ automation, onOpen }: { automation: Automation; onOpen: (id: string) => void }) {
  const { t, settings } = useUiPreferences()
  const runs: AutomationRun[] = automation.runs ?? (automation.lastRun === undefined ? [] : [automation.lastRun])
  if (runs.length === 0) return null
  const format = (value: number): string =>
    new Intl.DateTimeFormat(settings.locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
  const label = (status: AutomationRun['status']): string => status === 'completed' ? t('已完成', 'Completed')
    : status === 'running' ? t('运行中', 'Running')
      : status === 'failed' ? t('失败', 'Failed') : t('已中断', 'Interrupted')
  const shown = runs.slice(0, 8)
  return <div className={css.runList}>
    <div className={css.runHead}>{t('执行记录', 'Run history')}<span>{t(`${runs.length} 次`, `${runs.length} runs`)}</span></div>
    {shown.map(run => <div className={css.runRow} data-status={run.status} key={run.id}>
      <span className={css.runStatus}>{label(run.status)}</span>
      <span className={css.runTime}>{format(run.startedAt)}</span>
      {run.error !== undefined && <span className={css.runError}>{run.error}</span>}
      {run.conversationId !== undefined
        ? <Button variant="ghost" size="sm" onClick={() => { onOpen(run.conversationId as string) }}>{t('打开会话', 'Open conversation')}</Button>
        : null}
    </div>)}
    {runs.length > shown.length && <span className={css.runMore}>{t(`另有 ${runs.length - shown.length} 条记录`, `${runs.length - shown.length} more runs`)}</span>}
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
  const [kind, setKind] = useState<RepeatKind>(repeatKindOf(automation))
  const [minutes, setMinutes] = useState(automation?.intervalMs === undefined ? '30' : String(Math.round(automation.intervalMs / 60_000)))
  const [timeOfDay, setTimeOfDay] = useState(formatTimeOfDay((parseTimeOfDay(automation?.schedule?.timeOfDay).hour * 60) + parseTimeOfDay(automation?.schedule?.timeOfDay).minute))
  const [dayOfWeek, setDayOfWeek] = useState(automation?.schedule?.dayOfWeek ?? 1)
  const [dayOfMonth, setDayOfMonth] = useState(automation?.schedule?.dayOfMonth ?? 1)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setName(automation?.name ?? '')
    setPrompt(automation?.prompt ?? '')
    setKind(repeatKindOf(automation))
    setMinutes(automation?.intervalMs === undefined ? '30' : String(Math.round(automation.intervalMs / 60_000)))
    const time = parseTimeOfDay(automation?.schedule?.timeOfDay)
    setTimeOfDay(formatTimeOfDay(time.hour * 60 + time.minute))
    setDayOfWeek(automation?.schedule?.dayOfWeek ?? 1)
    setDayOfMonth(automation?.schedule?.dayOfMonth ?? 1)
    setError('')
  }, [automation, open])

  const buildSchedule = (): AutomationSchedule | undefined => {
    if (kind === 'hour') return { unit: 'hour', timeOfDay }
    if (kind === 'day') return { unit: 'day', timeOfDay }
    if (kind === 'week') return { unit: 'week', timeOfDay, dayOfWeek }
    if (kind === 'month') return { unit: 'month', timeOfDay, dayOfMonth }
    return undefined
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const normalizedName = name.trim()
    const normalizedPrompt = prompt.trim()
    if (normalizedName === '' || normalizedPrompt === '') {
      setError(t('请填写名称和提示词', 'Enter a name and a prompt'))
      return
    }
    const parsedMinutes = Number(minutes)
    if (kind === 'minutes' && (!Number.isFinite(parsedMinutes) || parsedMinutes < 1)) {
      setError(t('间隔分钟数至少为 1', 'The interval must be at least one minute'))
      return
    }
    const schedule = buildSchedule()
    if (automation === null) {
      const input: CreateAutomationInput = {
        name: normalizedName,
        prompt: normalizedPrompt,
        ...(kind === 'minutes' ? { intervalMs: Math.floor(parsedMinutes * 60_000) } : {}),
        ...(schedule === undefined ? {} : { schedule }),
        ...(kind === 'none' ? { enabled: false } : {}),
      }
      onSave(input)
      return
    }
    const input: UpdateAutomationInput = {
      name: normalizedName,
      prompt: normalizedPrompt,
      // Both mechanisms are exclusive: the minute interval and the calendar schedule
      // each clear the other, so the task never keeps two conflicting due times.
      intervalMs: kind === 'minutes' ? Math.floor(parsedMinutes * 60_000) : null,
      schedule: kind === 'none' || kind === 'minutes' ? null : schedule,
      enabled: kind === 'none' ? false : automation.enabled,
    }
    onSave(input)
  }

  return <Modal open={open} onClose={onClose} title={automation === null ? t('新建自动化任务', 'New automation') : t('编辑自动化任务', 'Edit automation')}
    description={t('任务结果会保存为 Pi 会话，可以从执行记录重新打开', 'Each result is saved as a Pi conversation and can be reopened from the run history')}
    closeLabel={t('关闭任务表单', 'Close automation form')} className={css.dialog}>
    <form className={css.form} onSubmit={submit}>
      <label htmlFor="automation-name">{t('任务名称', 'Name')}</label>
      <input id="automation-name" value={name} onChange={event => { setName(event.currentTarget.value) }} data-modal-autofocus />
      <label htmlFor="automation-prompt">{t('提示词', 'Prompt')}</label>
      <textarea id="automation-prompt" value={prompt} rows={7} onChange={event => { setPrompt(event.currentTarget.value) }} />
      <label>{t('重复方式', 'Repeat')}</label>
      <div className={css.unitTabs} role="group" aria-label={t('选择重复方式', 'Choose how the task repeats')}>
        {REPEAT_KINDS.map(option => <button type="button" key={option.value} aria-pressed={kind === option.value}
          data-selected={kind === option.value || undefined}
          onClick={() => { setKind(option.value) }}>{t(option.zh, option.en)}</button>)}
      </div>
      {kind === 'minutes' && <>
        <label htmlFor="automation-interval">{t('间隔分钟数', 'Interval in minutes')}</label>
        <input id="automation-interval" value={minutes} inputMode="numeric"
          onChange={event => { setMinutes(event.currentTarget.value) }} />
      </>}
      {kind === 'hour' && <>
        <label htmlFor="automation-time">{t('每小时的第几分钟', 'Minute of the hour')}</label>
        <input id="automation-time" type="time" value={timeOfDay}
          onChange={event => { setTimeOfDay(event.currentTarget.value) }} />
      </>}
      {(kind === 'day' || kind === 'week' || kind === 'month') && <>
        <label htmlFor="automation-time">{t('执行时间', 'Time of day')}</label>
        <input id="automation-time" type="time" value={timeOfDay}
          onChange={event => { setTimeOfDay(event.currentTarget.value) }} />
      </>}
      {kind === 'week' && <>
        <label>{t('星期', 'Day of the week')}</label>
        <div className={css.unitTabs} role="group" aria-label={t('选择星期', 'Choose a weekday')}>
          {WEEKDAY_LABELS.map((label, index) => <button type="button" key={label} aria-pressed={dayOfWeek === index}
            data-selected={dayOfWeek === index || undefined}
            onClick={() => { setDayOfWeek(index) }}>{label}</button>)}
        </div>
      </>}
      {kind === 'month' && <>
        <label htmlFor="automation-day">{t('每月第几日', 'Day of the month')}</label>
        <input id="automation-day" type="number" min={1} max={31} value={dayOfMonth} inputMode="numeric"
          onChange={event => { setDayOfMonth(Math.min(31, Math.max(1, Number(event.currentTarget.value) || 1))) }} />
      </>}
      {kind === 'none' && <p className={css.formHint}>{t('手动任务不会被定时触发，只能点「立即运行」。', 'A manual task never fires on its own; run it on demand.')}</p>}
      {error !== '' && <p className={css.formError} role="alert">{error}</p>}
      <div className={css.formActions}><Button variant="ghost" type="button" disabled={saving} onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" type="submit" disabled={saving}>{saving ? t('保存中…', 'Saving…') : t('保存任务', 'Save automation')}</Button></div>
    </form>
  </Modal>
}
