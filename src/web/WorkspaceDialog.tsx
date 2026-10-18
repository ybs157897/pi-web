import { useState } from 'react'
import { Button, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AddWorkspaceInput, WorkspaceSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './WorkspaceDialog.module.css'

interface WorkspaceDialogProps {
  open: boolean
  workspaces: readonly WorkspaceSummary[]
  currentWorkspaceId?: string
  busy?: boolean
  onClose: () => void
  onSelect: (id: string) => void
  onCreate: (input: AddWorkspaceInput) => Promise<WorkspaceSummary>
}

/** Select a registered workspace or register an existing local directory. */
export default function WorkspaceDialog({ open, workspaces, currentWorkspaceId, busy = false, onClose, onSelect, onCreate }: WorkspaceDialogProps) {
  const { t } = useUiPreferences()
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const addWorkspace = async (): Promise<void> => {
    const normalizedPath = path.trim()
    if (normalizedPath === '') {
      setError(t('请输入工作区目录', 'Enter a workspace directory'))
      return
    }
    setCreating(true)
    setError('')
    try {
      const workspace = await onCreate({ path: normalizedPath, ...(name.trim() === '' ? {} : { name: name.trim() }) })
      setPath('')
      setName('')
      onSelect(workspace.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('无法添加工作区', 'Could not add the workspace'))
    } finally {
      setCreating(false)
    }
  }

  return <Modal open={open} onClose={onClose} title={t('工作区', 'Workspaces')}
    description={t('选择对话工作的目录，或添加一个已有目录', 'Choose a working directory or add an existing folder')}
    closeLabel={t('关闭工作区', 'Close workspaces')} className={css.modal}>
    <div className={css.content}>
      <section className={css.list} aria-label={t('已添加的工作区', 'Registered workspaces')}>
        {workspaces.length === 0
          ? <p className={css.empty}>{t('还没有工作区', 'No workspaces yet')}</p>
          : workspaces.map(workspace => <button type="button" key={workspace.id}
            className={css.workspace} data-current={workspace.id === currentWorkspaceId || undefined}
            disabled={busy || creating} onClick={() => { onSelect(workspace.id) }}>
            <IconFolderOpenOutlineRegular size={16} />
            <span className={css.workspaceText}><strong>{workspace.name}</strong><small>{workspace.path}</small></span>
            {workspace.id === currentWorkspaceId && <span className={css.current}>{t('当前', 'Current')}</span>}
          </button>)}
      </section>
      <form className={css.form} onSubmit={event => { event.preventDefault(); void addWorkspace() }}>
        <h3>{t('添加已有目录', 'Add an existing folder')}</h3>
        <label htmlFor="workspace-path">{t('目录路径', 'Folder path')}</label>
        <Input id="workspace-path" value={path} placeholder="/Users/you/project" autoComplete="off"
          data-modal-autofocus onChange={event => { setPath(event.currentTarget.value) }} />
        <label htmlFor="workspace-name">{t('显示名称（可选）', 'Display name (optional)')}</label>
        <Input id="workspace-name" value={name} placeholder={t('使用文件夹名称', 'Use folder name')}
          onChange={event => { setName(event.currentTarget.value) }} />
        {error !== '' && <p className={css.error} role="alert">{error}</p>}
        <Button type="submit" variant="primary" disabled={creating || busy || path.trim() === ''}
          icon={<IconPlusOutlineRegular size={15} />}>{creating ? t('添加中…', 'Adding…') : t('添加工作区', 'Add workspace')}</Button>
      </form>
    </div>
  </Modal>
}
