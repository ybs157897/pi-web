/**
 * Automations: a task list on the left, the selected task's rule and run history on
 * the right, and a creation sheet for a task written by hand.
 *
 * A task's rule is an RRULE the server schedules; `new` and `new_once` runs open a
 * conversation, while a task created from a conversation messages that conversation
 * directly. The list filters by the stored status, and 「已结束」 is a real state: the
 * rule has no occurrence left.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, IconAlarmClockOutlineRegular, IconChevronDownOutlineRegular, IconEditOutlineRegular,
  IconEllipsisOutlineRegular, IconNewChatOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular,
  Input, Menu, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Automation, AutomationRun, CreateAutomationInput, UpdateAutomationInput, WorkspaceSummary,
} from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { AutomationCreatePanel } from './AutomationCreatePanel.tsx'
import { AutomationDetail } from './AutomationDetail.tsx'
import { AutomationListPane } from './AutomationListPane.tsx'
import css from './AutomationsPage.module.css'

type StatusFilter = 'active' | 'paused' | 'ended' | 'all'

const STATUS_FILTERS: readonly { value: StatusFilter; zh: string; en: string }[] = [
  { value: 'active', zh: '已开启', en: 'Active' },
  { value: 'paused', zh: '已暂停', en: 'Paused' },
  { value: 'ended', zh: '已结束', en: 'Ended' },
  { value: 'all', zh: '全部', en: 'All' },
]

const PAGE_SIZE = 20

interface RunPage {
  items: AutomationRun[]
  total: number
}

export default function AutomationsPage({ workspaceId, workspaces, onOpenConversation, onNewConversation }: {
  workspaceId?: string
  workspaces: readonly WorkspaceSummary[]
  onOpenConversation: (id: string) => void
  onNewConversation: () => void
}) {
  const { t, settings } = useUiPreferences()
  const [items, setItems] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<StatusFilter>('active')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [panelOpen, setPanelOpen] = useState(false)
  const [createMenu, setCreateMenu] = useState(false)
  const [listMenu, setListMenu] = useState(false)
  const [deleting, setDeleting] = useState<Automation | null>(null)
  const [runs, setRuns] = useState<Record<string, RunPage>>({})
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await api.listAutomations()
      setItems(result.automations)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法读取自动化任务', 'Could not load automations'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [])

  const loadRuns = useCallback(async (id: string, offset: number): Promise<void> => {
    setLoadingRuns(true)
    try {
      const page = await api.automationRuns(id, PAGE_SIZE, offset)
      setRuns(current => {
        const previous = current[id]
        return {
          ...current,
          [id]: {
            items: offset === 0 || previous === undefined ? page.runs : [...previous.items, ...page.runs],
            total: page.total,
          },
        }
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法读取运行记录', 'Could not load runs'))
    } finally {
      setLoadingRuns(false)
    }
  }, [t])

  const visible = useMemo(() => {
    const byStatus = status === 'all' ? items : items.filter(item => item.status === status)
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return byStatus
    return byStatus.filter(item => `${item.name}\n${item.prompt}\n${item.sessionId ?? ''}`.toLocaleLowerCase().includes(needle))
  }, [items, query, status])

  // Keep a selection inside the current list, so the detail pane never shows a hidden task.
  useEffect(() => {
    if (visible.length === 0) {
      if (selectedId !== undefined) setSelectedId(undefined)
      return
    }
    if (selectedId === undefined || !visible.some(item => item.id === selectedId)) setSelectedId(visible[0]?.id)
  }, [visible, selectedId])

  const selected = selectedId === undefined ? undefined : items.find(item => item.id === selectedId)

  useEffect(() => {
    if (selectedId === undefined) return
    void loadRuns(selectedId, 0)
  }, [selectedId, loadRuns])

  const replace = (automation: Automation): void => {
    setItems(current => current.map(item => item.id === automation.id ? automation : item))
  }

  const create = async (input: CreateAutomationInput): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const result = await api.createAutomation({
        ...input,
        ...(workspaceId === undefined || input.workspaceId !== undefined ? {} : { workspaceId }),
      })
      setItems(current => [result.automation, ...current])
      setSelectedId(result.automation.id)
      // Land on the tab the new task belongs to, so it is visible either way.
      setStatus(result.automation.status)
      setPanelOpen(false)
      setNotice(t('自动化任务已创建', 'Automation created'))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法创建自动化任务', 'Could not create automation'))
    } finally {
      setBusy(false)
    }
  }

  const save = async (id: string, input: UpdateAutomationInput): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const result = await api.updateAutomation(id, input)
      replace(result.automation)
      setNotice(t('自动化任务已保存', 'Automation saved'))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法保存自动化任务', 'Could not save automation'))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (automation: Automation, next: 'active' | 'paused'): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const result = await api.updateAutomation(automation.id, { status: next })
      replace(result.automation)
      setNotice(next === 'active'
        ? t('自动化任务已恢复', 'Automation resumed')
        : t('自动化任务已暂停', 'Automation paused'))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法更新自动化任务', 'Could not update automation'))
    } finally {
      setBusy(false)
    }
  }

  const runNow = async (automation: Automation): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      const result = await api.runAutomation(automation.id)
      replace(result.automation)
      setNotice(t(`已开始运行「${automation.name}」`, `Started “${automation.name}”`))
      setError('')
      void loadRuns(automation.id, 0)
      if (result.conversationId !== undefined) onOpenConversation(result.conversationId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法启动自动化任务', 'Could not start automation'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (deleting === null) return
    setBusy(true)
    try {
      await api.deleteAutomation(deleting.id)
      setItems(current => current.filter(item => item.id !== deleting.id))
      if (selectedId === deleting.id) setSelectedId(undefined)
      setNotice(t('自动化任务已删除', 'Automation deleted'))
      setError('')
      setDeleting(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法删除自动化任务', 'Could not delete automation'))
    } finally {
      setBusy(false)
    }
  }

  const purgeEnded = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.purgeEndedAutomations()
      await refresh()
      setNotice(t(`已清除 ${result.removed} 个已结束任务`, `Removed ${result.removed} ended tasks`))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法清除已结束任务', 'Could not purge ended tasks'))
    } finally {
      setBusy(false)
    }
  }

  const endedCount = items.filter(item => item.status === 'ended').length
  const emptyText = status === 'active' ? t('没有已开启的自动化任务', 'No active tasks')
    : status === 'paused' ? t('没有已暂停的自动化任务', 'No paused tasks')
      : status === 'ended' ? t('没有已结束的自动化任务', 'No ended tasks')
        : t('还没有自动化任务', 'No tasks yet')

  return <main className={css.page} data-panel={panelOpen || undefined}>
    <header className={css.pageHead}>
      <h1>{t('自动化任务', 'Automations')}</h1>
      <div className={css.createGroup}>
        <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={14} />}
          onClick={onNewConversation}>{t('新建', 'New')}</Button>
        <Menu open={createMenu} onClose={() => { setCreateMenu(false) }} align="end" portal
          anchor={<Button variant="primary" size="sm" className={css.createChevron}
            aria-label={t('选择创建方式', 'Choose how to create')}
            icon={<IconChevronDownOutlineRegular size={14} />}
            onClick={() => { setCreateMenu(value => !value) }} />}
          items={[
            { id: 'session', label: t('在会话中创建', 'Create in a session'), icon: <IconNewChatOutlineRegular size={15} /> },
            { id: 'manual', label: t('手动创建', 'Create manually'), icon: <IconEditOutlineRegular size={15} /> },
          ]}
          onSelect={id => {
            setCreateMenu(false)
            if (id === 'session') onNewConversation()
            if (id === 'manual') setPanelOpen(true)
          }} />
      </div>
    </header>
    <div className={css.body}>
      <div className={css.listPane} data-empty={visible.length === 0 || undefined}>
        <div className={css.toolbar}>
          <div className={css.statusTabs} role="group" aria-label={t('按状态筛选', 'Filter by status')}>
            {STATUS_FILTERS.map(option => <button type="button" key={option.value} aria-pressed={status === option.value}
              data-selected={status === option.value || undefined}
              onClick={() => { setStatus(option.value) }}>{t(option.zh, option.en)}</button>)}
          </div>
          {endedCount > 0 && <Menu open={listMenu} onClose={() => { setListMenu(false) }} align="end" portal
            anchor={<Button variant="ghost" size="sm" aria-label={t('更多', 'More')}
              icon={<IconEllipsisOutlineRegular size={15} />} onClick={() => { setListMenu(value => !value) }} />}
            items={[{ id: 'purge', label: t('清除全部已结束任务', 'Clear ended tasks'), danger: true }]}
            onSelect={id => { setListMenu(false); if (id === 'purge') void purgeEnded() }} />}
        </div>
        <Input className={css.search} icon={<IconSearchOutlineRegular size={15} />} value={query}
          onChange={event => { setQuery(event.currentTarget.value) }}
          placeholder={t('搜索自动化任务', 'Search automations')} aria-label={t('搜索自动化任务', 'Search automations')} />
        {notice !== '' && <p className={css.notice} role="status">{notice}</p>}
        {error !== '' && <div className={css.failure} role="alert"><span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); void refresh() }}>{t('重试', 'Retry')}</Button></div>}
        {loading && items.length === 0 && <div className={css.skeleton} aria-label={t('正在读取任务', 'Loading tasks')}><i /><i /><i /></div>}
        {!loading && visible.length > 0 && <AutomationListPane items={visible} selectedId={selectedId} now={now}
          locale={settings.locale} onSelect={setSelectedId} t={t} />}
      </div>
      {selected !== undefined && <div className={css.detailArea}>
        <AutomationDetail automation={selected}
          runs={runs[selected.id]?.items ?? []} totalRuns={runs[selected.id]?.total ?? 0} loadingRuns={loadingRuns}
          now={now} locale={settings.locale} workspaces={workspaces} busy={busy} t={t}
          onSave={input => { void save(selected.id, input) }}
          onToggle={next => { void toggle(selected, next) }}
          onRun={() => { void runNow(selected) }}
          onDelete={() => { setDeleting(selected) }}
          onOpenConversation={onOpenConversation}
          onLoadMoreRuns={() => { void loadRuns(selected.id, runs[selected.id]?.items.length ?? 0) }} />
      </div>}
      {!loading && error === '' && visible.length === 0 && <div className={css.empty}>
        <IconAlarmClockOutlineRegular size={26} />
        <p>{query.trim() !== '' ? t('没有匹配的自动化任务', 'No tasks match') : emptyText}</p>
        <span>{t('按计划运行提示词，结果保存在会话里', 'Run prompts on a schedule and keep each result in a conversation')}</span>
        <Button variant="outline" className={css.emptyAction}
          onClick={() => { setPanelOpen(true) }}>{t('新建自动化任务', 'Create automation')}</Button>
      </div>}
    </div>
    {panelOpen && <AutomationCreatePanel defaultWorkspaceId={workspaceId ?? ''} workspaces={workspaces}
      saving={busy} t={t} onClose={() => { setPanelOpen(false) }} onCreate={input => { void create(input) }} />}
    <Modal open={deleting !== null} onClose={() => { setDeleting(null) }} title={t('删除此任务？', 'Delete this task?')}
      description={t(`确定删除「${deleting?.name ?? ''}」？已生成的会话会保留。`, `Delete “${deleting?.name ?? ''}”? Existing conversations remain.`)}
      closeLabel={t('关闭确认', 'Close confirmation')} footer={<div className={css.confirmActions}>
        <Button variant="ghost" onClick={() => { setDeleting(null) }}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void remove() }}>{t('确认删除', 'Delete')}</Button>
      </div>} />
  </main>
}