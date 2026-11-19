import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Code, Copy, FolderOpen, ListChecks, Mail, Moon, Search, Sun, X } from 'lucide-react'
import type { AccessMode, ConversationDetail, ModelCatalog, ModelRef, ThinkingLevel, WorkspaceSummary } from '../shared/types.ts'
import type { WorkbenchAgent, WorkbenchMessage, WorkbenchSubmitInput, WorkbenchView, WorkItem, WorkItemStatus, WorkItemType } from '../shared/workbench.ts'
import AgentWorkbenchBots from './AgentWorkbenchBots.tsx'
import { AgentWorkbenchComposer, splitWorkbenchReferences, WorkbenchReferenceIcon, type WorkbenchDraft } from './AgentWorkbenchComposer.tsx'
import { WorkbenchFailureActions } from './WorkbenchFailureActions.tsx'
import { TaskAvatar } from './WorkbenchBotAvatar.tsx'
import { WorkbenchBotEditButton, WorkbenchBotEditor } from './WorkbenchBotEditor.tsx'
import { WorkbenchChildConversation, WorkbenchQuestions } from './AgentWorkbenchConversation.tsx'
import { MessageDialog } from './message-rendering/Dialog.tsx'
import { useDecisionInboxPresence } from './use-decision-inbox-presence.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { workbenchApi } from './workbench-api.ts'
import css from './AgentWorkbench.module.css'

export { AgentWorkbenchOnboarding } from './AgentWorkbenchOnboarding.tsx'

export type WorkbenchFocus = { taskId: string; nonce: number; fromInbox?: boolean }

type AgentWorkbenchProps = {
  workspace?: WorkspaceSummary
  page: 'agent' | 'bots'
  focus?: WorkbenchFocus
  composeNonce?: number
  onComposeHandled?: (nonce: number) => void
  onActivityChange?: (running: number) => void
  onAgent?: () => void
  onInbox: () => void
  onReturnFromInbox?: () => void
  onFileOpen?: (path: string, line?: number) => void
  onToggleTheme?: () => void
  themeDark?: boolean
  user?: string
  catalog?: ModelCatalog | null
  onOpenModels?: () => void
  accessModes?: readonly AccessMode[]
  model?: ModelRef
  thinkingLevel?: ThinkingLevel
}

const workItemLabels: Record<WorkItemStatus, readonly [string, string]> = {
  clarifying: ['待澄清', 'Clarifying'],
  ready: ['等待派发', 'Awaiting dispatch'],
  running: ['进行中', 'Running'],
  pending_review: ['结果待验收', 'Awaiting review'],
  needs_human: ['等你答复', 'Awaiting your reply'],
  ended: ['已结束', 'Ended'],
}

/** 工作项类型标签（卡片顶部 meta 的第二段）。 */
const workItemKindLabels: Record<WorkItemType, readonly [string, string]> = {
  build: ['实现', 'Build'],
  investigate: ['调研', 'Investigate'],
  decide: ['决策', 'Decide'],
}

/**
 * 功能：算证据条进度百分比。
 * @param item 工作项
 * @returns 0-100 的整数；无证据返回 0
 * 内部逻辑：把 passed/recorded 视为已完成，failed/insufficient 视为未完成，
 * 让卡片底部的进度条对应「证据收集进展」而非任务完成度。
 */
function evidenceRatio(item: WorkItem): number {
  if (item.evidence.length === 0) return 0
  const done = item.evidence.filter(pointer => pointer.status === 'passed' || pointer.status === 'recorded').length
  return Math.round((done / item.evidence.length) * 100)
}

function useWorkbench(workspaceId: string) {
  const [view, setView] = useState<WorkbenchView>()
  const [error, setError] = useState('')
  const poll = useRef<AbortController>()
  const { t } = useUiPreferences()
  const loadError = t('无法读取 Agent 工作台', 'Could not load the Agent workbench')
  const reload = useCallback(() => {
    poll.current?.abort()
    const controller = new AbortController()
    poll.current = controller
    void workbenchApi.get(workspaceId, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setView(value)
      setError('')
    }, cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : loadError)
    }).finally(() => { if (poll.current === controller) poll.current = undefined })
  }, [workspaceId, loadError])
  useEffect(() => {
    reload()
    const timer = window.setInterval(() => {
      if (poll.current === undefined && document.visibilityState !== 'hidden') reload()
    }, 1700)
    const onVisible = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      poll.current?.abort()
    }
  }, [reload])

  const updateMain = (main: ConversationDetail) => {
    setView(current => current === undefined ? undefined : { ...current, main })
    reload()
  }
  const updateAgent = (agent: WorkbenchAgent) => {
    setView(current => {
      if (current === undefined) return current
      const agents = current.agents.some(candidate => candidate.id === agent.id)
        ? current.agents.map(candidate => candidate.id === agent.id ? agent : candidate)
        : [...current.agents, agent]
      return { ...current, agents }
    })
    reload()
  }
  return { view, error, reload, updateMain, updateAgent }
}

function TaskStatusDrawer({ items, agents, close, openItem }: { items: WorkItem[]; agents: WorkbenchAgent[]; close: () => void; openItem: (id: string) => void }) {
  const { t } = useUiPreferences()
  const active = items.filter(item => item.status !== 'ended' || item.error !== undefined)
  const open = active.filter(item => item.error === undefined)
  const groups = [
    { label: t('进行中', 'In progress'), list: open.filter(item => item.status === 'running') },
    { label: t('等待处理', 'Waiting'), list: open.filter(item => item.status !== 'running') },
    { label: t('已停止', 'Stopped'), list: active.filter(item => item.failure?.code === 'CONVERSATION_INTERRUPTED') },
    { label: t('异常', 'Exceptions'), list: active.filter(item => item.error !== undefined && item.failure?.code !== 'CONVERSATION_INTERRUPTED') },
  ]
  return <MessageDialog open drawer title={t('内部状态', 'Internal status')} description={t('工作项的执行与等待状态', 'Work item execution and wait states')} onClose={close} t={t}>
    {active.length === 0 ? <p className={css.drawerNotice}>{t('当前没有进行中或等待中的工作。', 'No work is running or waiting.')}</p>
      : <div className={css.drawerBody}>{groups.filter(group => group.list.length > 0).map(group => <section key={group.label}>
        <h3>{group.label} <span>{group.list.length}</span></h3>
        <ul>{group.list.map(item => {
          const assignee = agents.find(agent => agent.id === item.assignee)?.name ?? t('子智能体', 'Worker')
          const dependencies = item.waitingOn.kind === 'dependencies'
            ? items.filter(other => item.dependencies.includes(other.id) && other.status !== 'ended').map(other => other.title).join('、') : ''

          return <li key={item.id}>
            <button className={css.drawerRow} type="button" onClick={() => { close(); openItem(item.id) }}>
              <strong>{item.title}</strong>
              <span>{item.error || (dependencies ? t(`等待「${dependencies}」`, `Waiting for ${dependencies}`) : assignee)}</span>
              <small><WorkbenchItemStatus item={item} /></small>
            </button>
          </li>
        })}</ul>
      </section>)}</div>}
  </MessageDialog>
}

function WorkbenchItemStatus({ item }: { item: WorkItem }) {
  const { t } = useUiPreferences()
  if (item.failure?.code === 'CONVERSATION_INTERRUPTED') return <span className={css.status}>{t('已停止', 'Stopped')}</span>
  if (item.error) return <span className={css.error}>{t('执行异常', 'Failed')}</span>
  const label = item.waitingOn.kind === 'dependencies' ? t('等待依赖', 'Waiting for dependencies') : t(...workItemLabels[item.status])
  return <span className={css.status} data-running={item.status === 'running'} data-ended={item.status === 'ended'}
    data-needs-user={item.waitingOn.kind === 'human' || undefined}><span className={css.statusDot} aria-hidden="true" />{label}</span>
}

function MainMessage({ message, mention }: { message: WorkbenchMessage; mention?: WorkbenchAgent }) {
  const { t, settings } = useUiPreferences()
  const [copied, setCopied] = useState(false)
  const { text, references } = splitWorkbenchReferences(message.text)
  const labelOf = (reference: typeof references[number]) => reference.kind === 'computer' ? t('本机', 'This computer') : reference.name
  const copy = () => {
    const names = references.map(reference => `@${labelOf(reference)}`)
    if (mention !== undefined) names.push(`@${mention.name}`)
    void navigator.clipboard?.writeText([...names, text].join(' ')).then(() => setCopied(true), () => setCopied(false))
  }
  return <div className={css.userMessage}>
    <div className={css.userBubble}>
      {references.map((reference, index) => <span key={index} className={css.mentionPill}>
        <WorkbenchReferenceIcon kind={reference.kind} /><span>@{labelOf(reference)}</span>
      </span>)}
      {mention !== undefined && <span className={css.mentionPill}><TaskAvatar agent={mention} small /><span>@{mention.name}</span></span>}
      {text}
    </div>
    <div className={css.messageMeta}>
      <time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString(settings.locale === 'en' ? 'en' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
      <button className={css.iconButton} type="button" aria-label={copied ? t('已复制', 'Copied') : t('复制消息', 'Copy message')} onClick={copy}>
        <Copy size={14} aria-hidden="true" />
      </button>
    </div>
  </div>
}

function EmptyExamples({ onExample }: { onExample: (text: string) => void }) {
  const { t } = useUiPreferences()
  const [visible, setVisible] = useState(true)
  const examples = [
    { icon: Search, title: t('查日志定位问题', 'Investigate a log'), detail: t('从日志和代码定位原因，给出证据。', 'Trace a failure through logs and code.'),
      prompt: t('看一下最近的告警日志，定位轮询重复请求的原因。', 'Look at recent warning logs and identify the cause of repeated polling requests.') },
    { icon: Code, title: t('改一个模块', 'Change a module'), detail: t('修改指定模块，运行验证并交回结果。', 'Change a module and bring back verification.'),
      prompt: t('把导入校验改成拒绝空值，README 导入除外。', 'Update import validation to reject blank input, except for README imports.') },
    { icon: ListChecks, title: t('整理需求', 'Refine requirements'), detail: t('梳理边界和代价，列出需要你决定的事。', 'Clarify scope and surface decisions for you.'),
      prompt: t('整理导入功能的需求边界，拆成可执行的任务。', 'Clarify the scope of imports and break it into actionable tasks.') },
  ]
  if (!visible) return null
  return <section className={css.examples} aria-label={t('从这些开始', 'Try an example')}>
    <div className={css.exampleHeader}>
      <span>{t('从这些开始', 'Try an example')}</span>
      <button type="button" className={css.iconButton} aria-label={t('关闭示例', 'Hide examples')} onClick={() => setVisible(false)}><X size={15} aria-hidden="true" /></button>
    </div>
    <div className={css.exampleGrid}>{examples.map(({ icon: Icon, ...example }) => <button key={example.title}
      className={css.example} type="button" onClick={() => onExample(example.prompt)}>
      <span className={css.exampleIcon}><Icon size={16} aria-hidden="true" /></span>
      <strong>{example.title}</strong><small>{example.detail}</small>
    </button>)}</div>
  </section>
}

export default function AgentWorkbench(props: AgentWorkbenchProps) {
  const { t } = useUiPreferences()
  if (props.workspace === undefined) return <section className={css.blank}><FolderOpen size={27} aria-hidden="true" />
    <p>{t('选择一个工作空间后开始。', 'Choose a workspace to get started.')}</p></section>
  return <ActiveWorkbench key={props.workspace.id} {...props} workspace={props.workspace} />
}

function ActiveWorkbench({ workspace, page, focus, composeNonce = 0, onComposeHandled, onActivityChange, onAgent, onInbox, onReturnFromInbox, onFileOpen, onToggleTheme, themeDark, user, model, catalog, onOpenModels, accessModes, thinkingLevel }: AgentWorkbenchProps & { workspace: WorkspaceSummary }) {
  const { t } = useUiPreferences()
  const { view, error, reload, updateMain, updateAgent } = useWorkbench(workspace.id)
  const [childTask, setChildTask] = useState<string | undefined>(focus?.taskId)
  const [drawer, setDrawer] = useState(false)
  const [editingAgent, setEditingAgent] = useState<WorkbenchAgent>()
  const [fresh, setFresh] = useState(composeNonce !== 0)
  const [composeKey, setComposeKey] = useState(0)
  const [example, setExample] = useState<WorkbenchDraft>()
  // 派发权限：undefined 表示跟随 Bot 配置，显式选择时才作为本轮上限发送。
  const [dispatchAccess, setDispatchAccess] = useState<AccessMode | undefined>(undefined)
  const mailNavigation = useRef<number>()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const returnFocus = useRef<string>()
  const lastCompose = useRef(0)
  const scroll = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const stayAtEnd = useRef(true)
  const runningCount = view?.items.filter(item => item.status === 'running').length ?? 0
  const currentItem = view?.items.find(item => item.id === childTask)
  const childAgent = view?.agents.find(agent => agent.id === currentItem?.assignee)
  const hero = currentItem === undefined && (fresh || (view?.messages.length ?? 0) === 0)
  useDecisionInboxPresence(workspace.id, page === 'agent' && !childTask && !hero ? view?.main.conversation.id : undefined,
    { interactions: view?.main.interactions, surface: scroll })
  const fromMail = focus?.fromInbox === true && childTask === focus.taskId
  const tasksByRequest = useMemo(() => {
    const tasks = new Map<string, WorkItem[]>()
    for (const item of view?.items ?? []) {
      const grouped = tasks.get(item.requestId) ?? []
      grouped.push(item)
      tasks.set(item.requestId, grouped)
    }
    return tasks
  }, [view?.items])

  useEffect(() => onActivityChange?.(runningCount), [runningCount, onActivityChange])
  useEffect(() => {
    if (composeNonce === lastCompose.current || page !== 'agent') return
    lastCompose.current = composeNonce
    if (composeNonce === 0) return
    setChildTask(undefined)
    setFresh(true)
    setComposeKey(previous => previous + 1)
    setExample(undefined)
    onComposeHandled?.(composeNonce)
  }, [composeNonce, onComposeHandled, page])
  useLayoutEffect(() => {
    if (returnFocus.current === undefined || currentItem !== undefined || page !== 'agent' || hero) return
    const card = cards.current.get(returnFocus.current)
    returnFocus.current = undefined
    if (card === undefined) return
    stayAtEnd.current = false
    card.scrollIntoView?.({ block: 'center' })
    card.focus({ preventScroll: true })
  }, [currentItem, page, hero])
  useLayoutEffect(() => {
    if (!focus) {
      if (mailNavigation.current !== undefined) setChildTask(undefined)
      mailNavigation.current = undefined
      return
    }
    if (page !== 'agent' || mailNavigation.current === focus.nonce) return
    mailNavigation.current = focus.nonce
    setFresh(false)
    setChildTask(focus.taskId)
  }, [focus, page])
  useLayoutEffect(() => {
    if (fromMail && currentItem) titleRef.current?.focus({ preventScroll: true })
  }, [fromMail, currentItem?.id])
  useLayoutEffect(() => {
    if (stayAtEnd.current && scroll.current !== null && !hero && currentItem === undefined) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [view?.messages.length, view?.items.length, page, hero, currentItem])

  const dispatch = async (input: WorkbenchSubmitInput) => {
    await workbenchApi.submit(workspace.id, {
      ...input, model, thinkingLevel, whenBusy: 'followUp',
      ...(input.accessMode ?? dispatchAccess === undefined ? {} : { accessMode: dispatchAccess }),
    })
    stayAtEnd.current = true
    setFresh(false)
    setExample(undefined)
    reload()
  }

  const mainTitle = currentItem === undefined ? 'Agent' : childAgent?.name ?? t('子智能体', 'Worker')
  if (page === 'bots' && view !== undefined) return <AgentWorkbenchBots view={view} workspaceId={workspace.id} workspacePath={workspace.path} model={model} catalog={catalog} onOpenModels={onOpenModels} accessModes={accessModes}
    onFileOpen={onFileOpen} onChange={reload} onAgentSaved={updateAgent} onAgent={onAgent && (botId => {
      setChildTask(undefined)
      if (botId) {
        setFresh(true)
        setComposeKey(previous => previous + 1)
        setExample({ text: '', mention: botId, key: Date.now() })
      } else {
        setFresh(false)
        setExample(undefined)
      }
      onAgent()
    })} />

  const openItem = (itemId: string) => {
    setChildTask(itemId)
  }

  return <section className={css.workbench} aria-label={t('Agent 工作台', 'Agent workbench')}>
    <header className={css.top} data-child={currentItem !== undefined || undefined}>
      {fromMail ? <button className={css.backButton} type="button" aria-label={t('回到收件箱', 'Back to Inbox')} onClick={() => (onReturnFromInbox ?? onInbox)()}>
        <ArrowLeft size={15} aria-hidden="true" /><span>{t('回到收件箱', 'Back to Inbox')}</span>
      </button> : currentItem !== undefined && <button className={css.backButton} type="button" aria-label={t('主对话', 'Main conversation')} onClick={() => { returnFocus.current = currentItem.id; setChildTask(undefined) }}>
        <ArrowLeft size={15} aria-hidden="true" /><span>{t('主对话', 'Main conversation')}</span>
      </button>}
      <TaskAvatar agent={currentItem ? childAgent : view?.agents.find(agent => agent.id === 'lead')} />
      <h1 ref={titleRef} tabIndex={-1}>{mainTitle}</h1>
      {currentItem !== undefined ? <WorkbenchItemStatus item={currentItem} />
        : runningCount > 0 && <span className={css.status} data-running="true"><span className={css.statusDot} aria-hidden="true" />
          {t(`${runningCount} 件在跑`, `${runningCount} running`)}</span>}
      <div className={css.headerActions}>
        {childAgent && childAgent.id !== 'lead' && <WorkbenchBotEditButton agent={childAgent} className={css.chatEdit} showLabel onEdit={() => setEditingAgent(childAgent)} />}
        <button type="button" className={`${css.iconButton} ${css.inboxShortcut}`} aria-label={t('收件箱', 'Inbox')} title={t('收件箱', 'Inbox')}
          onClick={() => onInbox()}><Mail size={17} aria-hidden="true" /></button>
        <button type="button" className={css.iconButton} aria-label={t('内部状态', 'Internal status')} title={t('内部状态', 'Internal status')}
          onClick={() => setDrawer(true)}><ListChecks size={17} aria-hidden="true" /></button>
        {onToggleTheme !== undefined && <button type="button" className={css.iconButton} aria-label={t('切换主题', 'Toggle theme')} title={t('切换主题', 'Toggle theme')}
          onClick={onToggleTheme}>{themeDark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}</button>}
      </div>
    </header>
    {error && <p className={css.loadError} role="alert">{error}
      <button className={css.linkButton} type="button" onClick={reload}>{t('重试', 'Retry')}</button></p>}
    {view === undefined ? error === '' && <p className={css.notice} role="status">{t('正在打开工作空间…', 'Opening the workspace…')}</p>
      : currentItem !== undefined ? <WorkbenchChildConversation key={currentItem.id} workspaceId={workspace.id} workspacePath={workspace.path} catalog={catalog} onOpenModels={onOpenModels} item={currentItem} agent={childAgent}
          onFileOpen={onFileOpen} onChange={reload} />
        : fromMail ? <p role="status" className={css.notice}>{t('此工作项已无法打开。', 'This work item is no longer available.')}</p>
        : hero ? <div className={css.heroScroll}>
            <div className={css.hero}>
              {view.messages.length > 0 && <button className={css.historyLink} type="button" onClick={() => setFresh(false)}>
                <ArrowLeft size={15} aria-hidden="true" />{t('返回主线记录', 'Back to conversation history')}
              </button>}
              <TaskAvatar large agent={view.agents.find(agent => agent.id === 'lead')} />
              <h2>{t('有什么要做的？', 'What needs to get done?')}</h2>
              <p>{t('发任务、查问题、聊需求，都在这里。拆解和排期由 Agent 处理。', 'Send work, investigate an issue, or discuss requirements. Agent handles planning and dispatch.')}</p>
              <AgentWorkbenchComposer key={composeKey} workspaceId={workspace.id} agents={view.agents} user={user} hero onOpenModels={onOpenModels} onSend={dispatch} example={example}
                accessModes={accessModes} onAccessMode={setDispatchAccess}
                placeholder={t('比如：帮我看下导入资料那边的校验问题', 'For example: Investigate validation during file imports')} />
              <EmptyExamples onExample={text => setExample({ text, key: Date.now() })} />
            </div>
          </div>
          : <>
            <div ref={scroll} className={css.mainScroll} onScroll={event => {
              const node = event.currentTarget
              stayAtEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96
            }}>
              <div className={css.mainStream}>
                {view.messages.map(message => {
                  const delivered = tasksByRequest.get(message.requestId) ?? []
                  return <article className={css.mainTurn} key={message.requestId}>
                    <MainMessage message={message} mention={view.agents.find(agent => agent.id === message.mention)} />
                    {message.failure ? <WorkbenchFailureActions failure={message.failure} workspaceId={workspace.id}
                      target={{ requestId: message.requestId, attempt: message.failureAttempt ?? 1 }} catalog={catalog} onOpenModels={onOpenModels} reload={reload} />
                      : message.error ? <div className={css.error} role="status">{message.error}
                      <button className={css.linkButton} type="button" onClick={() => setExample({
                        ...splitWorkbenchReferences(message.text), mention: message.mention, key: Date.now(),
                      })}>
                        {t('载入草稿', 'Reload draft')}
                      </button></div>
                      : delivered.length === 0 && <div className={css.receipt}>{t('已收到，正在拆解任务。', 'Received. Planning the work.')}</div>}
                    {message.createdBotId && <div className={css.incubation}>{t('已创建专属 Bot', 'Created a specialist Bot')} · {view.agents.find(agent => agent.id === message.createdBotId)?.name}</div>}
                    {delivered.map(item => {
                      const agent = view.agents.find(entry => entry.id === item.assignee)
                      const titleId = `workbench-task-title-${item.id}`
                      return <div key={item.id} className={css.workItem} role="group" aria-labelledby={titleId}>
                        <button ref={element => {
                          if (element === null) cards.current.delete(item.id)
                          else cards.current.set(item.id, element)
                        }} type="button" className={css.summonCard} data-work-item={item.id}
                          data-status={item.status} data-failed={item.error ? '' : undefined}
                          aria-label={t(`打开会话：${item.title}`, `Open conversation: ${item.title}`)} onClick={() => openItem(item.id)}>
                          <span className={css.summonTop}>
                            <TaskAvatar agent={agent} />
                            <span className={css.summonMeta}>
                              <span className={css.summonAgent}>{agent?.name ?? t('子智能体', 'Worker')}</span>
                              <span className={css.summonKind}>{t(...workItemKindLabels[item.type])}</span>
                            </span>
                          </span>
                          <span className={css.summonTitle} id={titleId}>{item.title}</span>
                          <span className={css.summonState}><WorkbenchItemStatus item={item} /></span>
                          <span className={css.summonStats}>
                            <span className={css.summonStatColumn}>
                              <span className={css.summonStatLabel}>{t('证据', 'Evidence')}</span>
                              <span className={css.summonStatValue}>
                                <span className={css.summonBar} data-status={item.status} aria-hidden="true">
                                  <span style={{ width: `${evidenceRatio(item)}%` }} />
                                </span>
                                {item.evidence.length}
                                <ArrowRight className={css.summonArrow} size={14} aria-hidden="true" />
                              </span>
                            </span>
                            <span className={css.summonStatColumn}>
                              <span className={css.summonStatLabel}>{t('尝试', 'Attempts')}</span>
                              <span className={css.summonStatValue}>{item.attempt}</span>
                            </span>
                          </span>
                        </button>
                        {item.failure && <WorkbenchFailureActions failure={item.failure} workspaceId={workspace.id} target={{ itemId: item.id, attempt: item.attempt }}
                          catalog={catalog} onOpenModels={onOpenModels} reload={reload} />}
                      </div>
                    })}
                  </article>
                })}
              </div>
            </div>
            <div className={css.mainFooter}>
              <WorkbenchQuestions detail={view.main} onAnswered={updateMain} />
              <AgentWorkbenchComposer workspaceId={workspace.id} agents={view.agents} user={user} onOpenModels={onOpenModels} onSend={dispatch} example={example}
                accessModes={accessModes} onAccessMode={setDispatchAccess}
                placeholder={t('输入任务，或用 @ 指定智能体…', 'Describe a task or @mention a worker…')} />
            </div>
          </>}
    {drawer && <TaskStatusDrawer close={() => setDrawer(false)} openItem={openItem} items={view?.items ?? []} agents={view?.agents ?? []} />}
    {editingAgent && <WorkbenchBotEditor workspaceId={workspace.id} catalog={catalog} accessModes={accessModes ?? []} agent={editingAgent}
      onClose={() => setEditingAgent(undefined)} onSaved={saved => { updateAgent(saved); setEditingAgent(undefined) }} />}
  </section>
}
