import { useState } from 'react'
import { Button, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AddWorkspaceInput, WorkspaceSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './WorkspaceDialog.module.css'

/** WorkspaceDialog 的属性定义：开关态、工作区列表与选择/创建回调。 */
interface WorkspaceDialogProps {
  open: boolean
  workspaces: readonly WorkspaceSummary[]
  currentWorkspaceId?: string
  busy?: boolean
  onClose: () => void
  onSelect: (id: string) => void
  onCreate: (input: AddWorkspaceInput) => Promise<WorkspaceSummary>
}

/**
 * 功能：工作区对话框——Modal 浮层，上半部分为已注册工作区的选择列表，
 * 下半部分为「添加已有目录」表单，把本地目录注册为工作区。
 * @param props open 是否打开；workspaces 已注册工作区列表；currentWorkspaceId 当前选中工作区；
 *              busy 外部是否忙碌（禁用交互）；onClose 关闭回调；onSelect 选中已有工作区回调；
 *              onCreate 注册新目录（返回新建的 WorkspaceSummary）。
 * 内部逻辑：path/name/error/creating 四个状态驱动添加表单；addWorkspace 校验路径非空后
 * 调 onCreate，成功则清空表单并自动选中新工作区，失败把错误信息写入 error 展示；
 * 表单 submit 与按钮共用 addWorkspace，creating/busy 期间禁用全部交互。
 */
export default function WorkspaceDialog({ open, workspaces, currentWorkspaceId, busy = false, onClose, onSelect, onCreate }: WorkspaceDialogProps) {
  const { t } = useUiPreferences()
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  /** 提交「添加已有目录」表单：校验路径、调用 onCreate 注册、成功后自动选中新工作区。 */
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
