import { useRef, useState } from 'react'
import { ArrowRight, Check, Folder, FolderPlus } from 'lucide-react'
import type { WorkspaceSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './AgentWorkbench.module.css'

export function AgentWorkbenchOnboarding({ workspaces, busy = false, user, currentWorkspaceId, onSelect, onCreate }: {
  workspaces: readonly WorkspaceSummary[]
  busy?: boolean
  user?: string
  currentWorkspaceId?: string
  onSelect: (id: string) => Promise<void> | void
  onCreate: (name: string) => Promise<void>
}) {
  const { t } = useUiPreferences()
  const saving = useRef(false)
  const [name, setName] = useState('')
  const [active, setActive] = useState<string>()
  const [error, setError] = useState('')
  const apply = async (target: string, action: () => Promise<void> | void) => {
    if (saving.current || busy) return
    saving.current = true
    setActive(target)
    setError('')
    try { await action() }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法打开工作空间，请重试。', 'The workspace could not be opened. Try again.'))
    } finally {
      saving.current = false
      setActive(undefined)
    }
  }

  const switching = currentWorkspaceId !== undefined
  return <section className={css.onboarding} data-switching={switching || undefined} aria-labelledby={switching ? undefined : 'workbench-onboarding-title'}>
    <div className={css.onboardingContent}>
      {!switching && <>
        <span className={css.onboardingBrand}>π</span>
        <h1 id="workbench-onboarding-title">{user ? t(`你好，${user}！先选一个工作空间。`, `Welcome, ${user}. Choose a workspace.`)
          : t('先选一个工作空间', 'Choose a workspace')}</h1>
        <p>{t('打开已有工作空间，或给新空间起个名字。', 'Open an existing workspace or name a new one.')}</p>
      </>}
      {workspaces.length > 0 && <div className={css.workspacePicks} aria-label={t('已有工作空间', 'Existing workspaces')}>
        {workspaces.map(workspace => <button key={workspace.id} type="button" className={css.workspacePick}
          aria-current={workspace.id === currentWorkspaceId || undefined}
          disabled={busy || active !== undefined} onClick={() => void apply(workspace.id, () => onSelect(workspace.id))}>
          <span className={css.workspaceIcon}><Folder size={17} aria-hidden="true" /></span>
          <span className={css.workspaceLabel}><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small></span>
          <span className={css.pickAction}>
            {active === workspace.id ? t('正在打开…', 'Opening…')
              : workspace.id === currentWorkspaceId ? <><Check size={14} aria-hidden="true" />{t('当前', 'Current')}</>
                : <ArrowRight size={15} aria-hidden="true" />}
          </span>
        </button>)}
      </div>}
      <form className={css.workspaceForm} onSubmit={event => {
        event.preventDefault()
        if (name.trim() !== '') void apply('new', () => onCreate(name.trim()))
      }}>
        <label htmlFor="workbench-workspace-name">{workspaces.length > 0 ? t('或新建', 'Or create one') : t('新建工作空间', 'New workspace')}</label>
        <div className={css.workspaceInput}>
          <FolderPlus size={18} aria-hidden="true" />
          <input id="workbench-workspace-name" placeholder={t('输入工作空间名称', 'Enter a workspace name')}
            maxLength={120} value={name} onChange={event => setName(event.currentTarget.value)} disabled={busy || active !== undefined} />
          <button type="submit" className={css.primaryButton} disabled={busy || active !== undefined || name.trim() === ''}>
            {active === 'new' ? t('正在创建…', 'Creating…') : t('创建并打开', 'Create and open')}<ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      </form>
      {error && <p role="alert" className={css.error}>{error}</p>}
    </div>
  </section>
}
