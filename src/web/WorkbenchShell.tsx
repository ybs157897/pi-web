import { lazy, Suspense, useEffect, useRef, useState, type Ref } from 'react'
import { Bot, Clock, FolderOpen, History, ListChecks, Mail, MessageSquare, Plus, Settings } from 'lucide-react'
import type { AccessMode, AppSettings, ModelCatalog, ModelRef, WorkspaceSummary } from '../shared/types.ts'
import { api } from './api.ts'
import { decisionInboxApi, DECISION_INBOX_CHANGED } from './decision-inbox-api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { FileContents } from './Inspector.tsx'
import { workspacePreview } from './workspace-preview.ts'
import { MessageDialog } from './message-rendering/Dialog.tsx'
import type { TabFile } from './inspector-tabs.ts'
import css from './WorkbenchShell.module.css'

const AgentWorkbench = lazy(() => import('./AgentWorkbench.tsx'))
const Onboarding = lazy(() => import('./AgentWorkbench.tsx').then(module => ({ default: module.AgentWorkbenchOnboarding })))
const Inbox = lazy(() => import('./InboxPage.tsx'))

export type WorkbenchPage = 'agent' | 'bots' | 'inbox'
type Destination = WorkbenchPage | 'defects' | 'automations' | 'chat'
const SPACE_KEY = 'pi-durable-web:workbench-space'
const navigation = [
  { page: 'inbox', label: '收件箱', en: 'Inbox', icon: Mail },
  { page: 'agent', label: 'Agent', en: 'Agent', icon: MessageSquare },
  { page: 'bots', label: 'Bot', en: 'Bots', icon: Bot },
  { page: 'defects', label: '问题清单', en: 'Issues', icon: ListChecks },
  { page: 'automations', label: '自动化任务', en: 'Automations', icon: Clock },
] as const

function lastWorkspace(): string | null {
  try { return localStorage.getItem(SPACE_KEY) } catch { return null }
}

interface Props {
  page: WorkbenchPage
  workspaces: WorkspaceSummary[]
  loading: boolean
  error: string
  reload: () => Promise<void>
  onWorkspaceChange: (workspaceId?: string) => void
  onAdded: (workspace: WorkspaceSummary) => void
  navigate: (page: Destination) => void
  openConversation: (id: string) => void
  onOpenModels: () => void
  catalog: ModelCatalog | null
  accessModes: AccessMode[]
  onSettings: () => void
  onTheme: () => void
  user: string
  version: string
  settings: AppSettings
  model?: ModelRef
  onComposeHandled: (nonce: number) => void
  composeNonce: number
  newInput: () => void
  contentRef?: Ref<HTMLElement>
}
export default function WorkbenchShell({ page, workspaces, loading, error, reload, onWorkspaceChange, onAdded, navigate, openConversation,
  onSettings, onOpenModels, catalog, accessModes, onTheme, user, version, settings, model, composeNonce, onComposeHandled, newInput, contentRef }: Props) {
  const { t, dark } = useUiPreferences()
  const [selected, setSelected] = useState(lastWorkspace)
  const [picking, setPicking] = useState(false)
  const [preview, setPreview] = useState<{ path: string; workspaceId: string; file?: TabFile; error?: string }>()
  const fileRequest = useRef(0)
  const [focus, setFocus] = useState<{ taskId: string; nonce: number; fromInbox: boolean }>()
  const [activity, setActivity] = useState<number>()
  const [unread, setUnread] = useState<number>()
  const [sourceMailId, setSourceMailId] = useState<string>()
  const request = useRef<{ name: string; id: string }>()
  const workspace = workspaces.find(item => item.id === selected)

  useEffect(() => { onWorkspaceChange(workspace?.id) }, [onWorkspaceChange, workspace?.id])
  useEffect(() => {
    setUnread(undefined)
    if (!workspace) return
    let active = true
    let generation = 0
    const read = async () => {
      const current = ++generation
      try {
        const result = await decisionInboxApi.list(workspace.id)
        if (active && current === generation) setUnread(result.pendingCount)
      } catch { if (active && current === generation) setUnread(undefined) }
    }
    void read()
    const timer = window.setInterval(() => { if (!document.hidden) void read() }, 5000)
    const changed = () => { void read() }
    window.addEventListener(DECISION_INBOX_CHANGED, changed)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(DECISION_INBOX_CHANGED, changed) }
  }, [workspace?.id, page])

  function choose(id: string) {
    setPicking(false)
    if (id === selected && workspace) return
    setFocus(undefined)
    setSourceMailId(undefined)
    setPreview(undefined)
    fileRequest.current++
    setActivity(undefined)
    setSelected(id)
    try { localStorage.setItem(SPACE_KEY, id) } catch { /* 当前标签页仍可使用。 */ }
    navigate('agent')
  }

  async function openFile(path: string, line?: number) {
    if (!workspace) return
    const id = ++fileRequest.current
    const workspaceId = workspace.id
    setPreview({ workspaceId, path })
    try {
      const file = await api.getWorkspaceFile(workspaceId, path, line)
      if (id !== fileRequest.current) return
      if (file.kind === 'directory') throw new Error(t('此引用指向目录', 'This reference points to a folder'))
      setPreview({ workspaceId, path, file: workspacePreview(file, workspaceId, line, id) })
    } catch (cause) {
      if (id === fileRequest.current) setPreview({ workspaceId, path, error: cause instanceof Error ? cause.message : t('无法打开此文件', 'Could not open file') })
    }
  }

  async function create(name: string) {
    if (request.current?.name !== name) request.current = { name, id: crypto.randomUUID() }
    const result = await api.createNamedWorkspace(name, request.current.id)
    onAdded(result.workspace)
    choose(result.workspace.id)
    request.current = undefined
  }
  const pending = <div className={css.notice} role="status">{t('正在载入工作台…', 'Loading workbench…')}</div>
  if (loading && !workspace) return pending
  if (error && !workspace) return <div className={css.notice} role="alert">{error}<button onClick={() => void reload()}>{t('重试', 'Retry')}</button></div>
  if (!workspace) return <Suspense fallback={pending}>
    <Onboarding user={user} workspaces={workspaces} onSelect={choose} onCreate={create} />
  </Suspense>

  const inboxCount = typeof unread === 'number' && unread > 0
    ? <span className={css.count} aria-label={t(`${unread} 项待处理`, `${unread} items to handle`)}>{unread}</span> : null
  const go = (next: Destination) => { setFocus(undefined); setSourceMailId(undefined); navigate(next) }
  const compose = () => { setFocus(undefined); setSourceMailId(undefined); newInput() }

  return <div className={css.shell}>
    <nav className={css.rail} aria-label={t('快捷导航', 'Quick navigation')}>
      <span className={css.mark} aria-hidden>π</span>
      <button className={css.mobileOnly} type="button" title={t('新对话', 'New conversation')} aria-label={t('新对话', 'New conversation')} onClick={compose}><Plus size={16} /></button>
      {[navigation[1], navigation[0], navigation[2], navigation[3], navigation[4]].map(({ page: id, label, en, icon: Icon }) =>
        <button key={id} type="button" title={t(label, en)} aria-label={t(label, en)}
          aria-current={page === id ? 'page' : undefined} onClick={() => go(id)}>
          <Icon size={16} />{id === 'inbox' && inboxCount && <i className={css.dot} />}
        </button>)}
      <button className={css.mobileOnly} type="button" title={t('切换工作空间', 'Switch workspace')} aria-label={t('切换工作空间', 'Switch workspace')} onClick={() => setPicking(true)}><FolderOpen size={16} /></button>
      <button className={css.mobileOnly} type="button" title={t('历史会话', 'Conversation history')} aria-label={t('历史会话', 'Conversation history')} onClick={() => go('chat')}><History size={16} /></button>
      <button className={css.railBottom} title={t('设置', 'Settings')} aria-label={t('设置', 'Settings')} onClick={onSettings}><Settings size={16} /></button>
    </nav>
    <aside className={css.sidebar}>
      <div className={css.brand}><strong>PI Durable</strong><small>{version && 'v' + version}</small></div>
      <button className={css.compose} onClick={compose}><Plus size={14} />{t('新对话', 'New conversation')}</button>
      <nav className={css.nav} aria-label={t('工作台导航', 'Workbench navigation')}>
        {navigation.map(({ page: id, label, en, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => go(id)}>
          <Icon size={14} /><span>{t(label, en)}</span>{id === 'inbox' && inboxCount}
        </button>)}
      </nav>
      <div className={css.heading}>{t('工作区', 'Workspaces')}<button aria-label={t('选择或新建工作空间', 'Choose or create workspace')} title={t('选择或新建工作空间', 'Choose or create workspace')} onClick={() => setPicking(true)}><Plus size={14} /></button></div>
      <div className={css.spaces}>
        {workspaces.map(space => <button key={space.id} aria-current={space.id === workspace.id || undefined} title={space.path} onClick={() => choose(space.id)}>
          <span>{space.name}</span>{space.id === workspace.id && activity !== undefined && activity > 0 && <small>{t(`${activity} 件在跑`, `${activity} running`)}</small>}
        </button>)}
      </div>
      <footer><button onClick={onSettings} title={t('设置', 'Settings')}><span className={css.avatar}>{user.slice(0, 1).toUpperCase() || 'π'}</span>{user}</button>
        <button onClick={() => go('chat')} title={t('历史会话', 'Conversation history')} aria-label={t('历史会话', 'Conversation history')}><History size={15} /></button>
        <button aria-label={t('切换工作空间', 'Switch workspace')} onClick={() => setPicking(true)}>{t('切换', 'Switch')}</button>
      </footer>
    </aside>
    <section className={css.content} ref={contentRef} tabIndex={-1} aria-label={t('主内容', 'Main content')} key={workspace.id}>
      <Suspense fallback={pending}>
        {page === 'inbox'
          ? <Inbox workspaceId={workspace.id} initialMailId={sourceMailId} onOpenFile={(path, line) => { void openFile(path, line) }} onOpenConversation={(link, mailId) => {
              if (!link.workItemId) { openConversation(link.conversationId); return }
              setFocus({ taskId: link.workItemId, nonce: Date.now(), fromInbox: true })
              setSourceMailId(mailId)
              navigate('agent')
            }} />
          : <AgentWorkbench workspace={workspace} page={page} focus={focus} composeNonce={composeNonce}
              onComposeHandled={onComposeHandled} onAgent={() => go('agent')} onFileOpen={(path, line) => { void openFile(path, line) }}
              onActivityChange={setActivity} onReturnFromInbox={() => navigate('inbox')} onInbox={() => go('inbox')} user={user} themeDark={dark} onToggleTheme={onTheme}
              model={model} catalog={catalog} accessModes={accessModes} onOpenModels={onOpenModels} thinkingLevel={settings.defaultThinkingLevel} />}
      </Suspense>
    </section>
    {picking && <MessageDialog open title={t('切换工作空间', 'Switch workspace')}
      description={t('打开已有工作空间，或给新空间起个名字。', 'Open an existing workspace or name a new one.')}
      onClose={() => setPicking(false)} t={t}>
      <Suspense fallback={pending}>
        <Onboarding currentWorkspaceId={workspace.id} workspaces={workspaces} onSelect={choose} onCreate={create} />
      </Suspense>
    </MessageDialog>}
    {preview?.workspaceId === workspace.id && <MessageDialog open wide title={preview.path.split(/[\\/]/u).at(-1) || preview.path}
      description={preview.file && !/^(?:[\\/]|[A-Za-z]:)/u.test(preview.file.path)
        ? `${workspace.name} / ${preview.file.path}` : preview.path} t={t}
      onClose={() => { fileRequest.current++; setPreview(undefined) }}>
      {preview.file ? <FileContents file={preview.file} /> : <p role={preview.error ? 'alert' : 'status'}>{preview.error ?? t('正在读取…', 'Loading…')}</p>}
    </MessageDialog>}
  </div>
}
