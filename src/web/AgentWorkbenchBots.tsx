import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, ListChecks, Plus } from 'lucide-react'
import type { AccessMode, ModelCatalog, ModelRef } from '../shared/types.ts'
import type { WorkbenchAgent, WorkbenchView, WorkItem } from '../shared/workbench.ts'
import { TaskAvatar } from './WorkbenchBotAvatar.tsx'
import { WorkbenchBotEditButton, WorkbenchBotEditor } from './WorkbenchBotEditor.tsx'
import { WorkbenchChildConversation, WorkbenchProgress } from './AgentWorkbenchConversation.tsx'
import { accessModeLabel } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './AgentWorkbench.module.css'

export default function AgentWorkbenchBots({ workspaceId, workspacePath, view, model, catalog, accessModes = [], onOpenModels, onFileOpen, onChange, onAgentSaved, onAgent }: {
  workspaceId: string
  workspacePath?: string
  catalog?: ModelCatalog | null
  accessModes?: readonly AccessMode[]
  onOpenModels?: () => void
  view: WorkbenchView
  model?: ModelRef
  onFileOpen?: (path: string, line?: number) => void
  onChange: () => void
  onAgentSaved: (agent: WorkbenchAgent) => void
  onAgent?: (botId?: string) => void
}) {
  const { t, settings } = useUiPreferences()
  const rosterBody = useRef<HTMLDivElement>(null)
  const [selectedAgent, setSelectedAgent] = useState<string>()
  const [editor, setEditor] = useState<{ agent?: WorkbenchAgent }>()
  const [selectedTask, setSelectedTask] = useState<string>()
  const [compactPanel, setCompactPanel] = useState<'chat' | 'details'>('chat')
  const lead = view.agents.find(agent => agent.id === 'lead')
  const bots = view.agents.filter(agent => agent.id !== 'lead')
  const byWorker = new Map<string, WorkItem[]>()
  for (const item of view.items) {
    const recent = byWorker.get(item.assignee) ?? []
    recent.push(item)
    byWorker.set(item.assignee, recent)
  }
  const agent = view.agents.find(bot => bot.id === selectedAgent) ??
    bots.find(bot => byWorker.has(bot.id)) ?? bots[0] ?? lead
  useLayoutEffect(() => {
    const selected = rosterBody.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
    selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [agent?.id])
  const tasks = (byWorker.get(agent?.id ?? '') ?? []).toSorted((left, right) => right.updatedAt - left.updatedAt)
  const item = tasks.find(task => task.id === selectedTask) ?? tasks.find(task => task.childId === agent?.conversationId) ?? tasks[0]
  const lastRunAt = agent?.id === 'lead' ? view.messages.at(-1)?.at : tasks[0]?.updatedAt
  const agentRole = agent?.role && agent.role !== 'lead' ? agent.role : t('任务拆解与调度', 'Planning and dispatch')
  const modelName = agent?.model?.modelId ?? (agent?.id === 'lead' ? view.main.conversation.model?.modelId : undefined) ?? model?.modelId
  const access = agent?.config?.accessMode ?? agent?.accessMode
  const selectable = (next: WorkbenchAgent) => {
    setSelectedAgent(next.id)
    setSelectedTask(undefined)
    setCompactPanel('chat')
  }
  const inboxCount = (candidate: WorkbenchAgent) => (byWorker.get(candidate.id) ?? [])
    .filter(task => task.status === 'needs_human' || task.status === 'pending_review').length

  return <section className={css.botsPage} data-compact-panel={compactPanel} aria-label={t('Bot 管理', 'Bot directory')}>
    <aside className={css.botRoster} aria-label={t('Bot 名册', 'Bot roster')}>
      <header className={css.botPanelHeader}><h1>Bot</h1><span className={css.count}>{bots.length}</span>
        <button type="button" className={css.botManageAction} onClick={() => setEditor({})} aria-label={t('创建 Bot', 'Create Bot')}>
          <Plus size={15} /><span>{t('创建', 'Create')}</span>
        </button></header>
      <div className={css.botRosterBody} ref={rosterBody}>
        {lead !== undefined && <button type="button" className={css.leadCard}
          aria-pressed={agent?.id === lead.id} onClick={() => selectable(lead)}>
          <TaskAvatar agent={lead} />
          <span className={css.botRowText}><strong>{lead.name}</strong><small>{t('任务拆解与调度', 'Planning and dispatch')}</small></span>
        </button>}
        {bots.map(bot => {
          const waiting = inboxCount(bot)
          return <div className={css.botRosterEntry} data-active={agent?.id === bot.id || undefined} key={bot.id}>
            <button type="button" className={css.botRow} aria-pressed={agent?.id === bot.id} onClick={() => selectable(bot)}>
              <TaskAvatar agent={bot} />
              <span className={css.botRowText}><strong>{bot.name}</strong><small>
                {waiting > 0 ? t(`${waiting} 项等你处理`, `${waiting} awaiting you`) : (byWorker.get(bot.id)?.at(-1)?.title ?? bot.role ?? bot.description)}
              </small></span>
              <span className={css.botRowStatus} data-running={bot.status === 'running'}>
                <span className={css.statusDot} aria-hidden="true" />
                <span className={css.srOnly}>{bot.status === 'running' ? t('进行中', 'In progress') : t('空闲', 'Idle')}</span>
              </span>
            </button>
            <WorkbenchBotEditButton agent={bot} className={css.rosterEdit} onEdit={() => setEditor({ agent: bot })} />
          </div>
        })}
      </div>
    </aside>

    <section className={css.botCenter} aria-label={t('选中的 Bot 会话', 'Selected bot conversation')}>
      <header className={css.botPanelHeader}>
        <TaskAvatar agent={agent} /><h2>{agent?.name ?? 'Bot'}</h2>
        {agent?.status === 'running' && <WorkbenchProgress running />}
        <div className={css.botHeaderActions}>
          {agent && agent.id !== 'lead' && <WorkbenchBotEditButton agent={agent} className={css.chatEdit} showLabel onEdit={() => setEditor({ agent })} />}
          <button type="button" className={css.compactDetails} aria-expanded={compactPanel === 'details'}
            onClick={() => setCompactPanel(value => value === 'chat' ? 'details' : 'chat')}>
            <ListChecks size={16} aria-hidden="true" /> {compactPanel === 'chat' ? t('详情', 'Details') : t('回会话', 'Conversation')}
          </button>
        </div>
      </header>
      {tasks.length > 1 && <label className={css.taskPicker}>{t('任务', 'Task')}
        <select value={item?.id ?? ''} onChange={event => setSelectedTask(event.currentTarget.value)}>
          {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </label>}
      {item === undefined ? <div className={css.botEmpty}>
        <TaskAvatar agent={agent} large />
        <p>{agent?.id === 'lead' ? t('主 Agent 的对话在 Agent 页面。', 'The lead conversation is on the Agent page.')
          : t('这个 Bot 还没有收到任务。', 'This bot has no dispatched tasks yet.')}</p>
        {onAgent !== undefined && <button type="button" className={css.linkButton} onClick={() => onAgent(agent?.id === 'lead' ? undefined : agent?.id)}>
          {agent?.id === 'lead' ? t('打开 Agent 对话', 'Open the Agent conversation') : t('给该 Bot 派发任务', 'Assign a task to this Bot')}<ArrowRight size={14} aria-hidden="true" />
        </button>}
      </div> : <WorkbenchChildConversation key={item.id} workspaceId={workspaceId} workspacePath={workspacePath} catalog={catalog} onOpenModels={onOpenModels} item={item} agent={agent}
        onFileOpen={onFileOpen} onChange={onChange} embedded />}
    </section>

    <aside className={css.botDetail} aria-label={t('Bot 详情', 'Bot details')}>
      <div className={css.botDetailHeading}><TaskAvatar agent={agent} large /><div><h2>{agent?.name ?? 'Bot'}</h2><p>{agent?.description}</p></div></div>
      {agent && agent.id !== 'lead' && <WorkbenchBotEditButton agent={agent} className={css.editBot} showLabel onEdit={() => setEditor({ agent })} />}
      <dl className={css.botFields}>
        <div><dt>{t('角色', 'Role')}</dt><dd>{agentRole}</dd></div>
        <div><dt>{t('模型', 'Model')}</dt><dd>{modelName ?? t('跟随工作区设置', 'Workspace default')}</dd></div>
        <div><dt>{t('权限上限', 'Access limit')}</dt><dd>{access === undefined ? t('跟随工作区设置', 'Workspace default') : accessModeLabel(access, t)}</dd></div>
        <div><dt>{t('最近运行', 'Last run')}</dt><dd>{lastRunAt === undefined ? t('暂无', 'None yet')
          : new Date(lastRunAt).toLocaleString(settings.locale === 'en' ? 'en' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
      </dl>
      <section className={css.botSkills} aria-label={t('技能', 'Skills')}>
        <h3>{t('技能', 'Skills')}</h3>
        {agent?.config?.skillIds === null && <p>{t('全部可用技能', 'All available skills')}</p>}
        {agent?.skills.length ? <ul>{agent.skills.map(skill => <li key={skill}>{skill}</li>)}</ul>
          : <p>{t('暂无可用技能', 'No available skills')}</p>}
      </section>
    </aside>
    {editor && <WorkbenchBotEditor workspaceId={workspaceId} catalog={catalog} accessModes={accessModes} agent={editor.agent}
      onClose={() => setEditor(undefined)} onSaved={saved => {
        if (editor.agent === undefined) {
          setSelectedAgent(saved.id)
          setSelectedTask(undefined)
          setCompactPanel('chat')
        }
        setEditor(undefined)
        onAgentSaved(saved)
      }} />}
  </section>
}
