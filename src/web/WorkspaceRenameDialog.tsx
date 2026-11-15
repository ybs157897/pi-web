import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './WorkspaceDialog.module.css'

/**
 * 功能：工作区重命名对话框——以 Modal 形式浮层出现，只修改工作区的显示名称，
 * 不改变其已注册的磁盘路径。
 * @param props workspace 为待重命名的工作区（null 时对话框关闭）；onClose 关闭对话框回调；
 *              onSave 提交保存（携带工作区与修剪后的新名称）。
 * 内部逻辑：name 状态保存输入框文本；workspace 变化时用 useEffect 同步重置为当前名称；
 * 保存按钮在名称为空或 workspace 为 null 时禁用，点击后以 trim 后的名称回调 onSave。
 */
export default function WorkspaceRenameDialog({ workspace, onClose, onSave }: {
  workspace: WorkspaceSummary | null
  onClose: () => void
  onSave: (workspace: WorkspaceSummary, name: string) => void
}) {
  const { t } = useUiPreferences()
  const [name, setName] = useState(workspace?.name ?? '')
  useEffect(() => { setName(workspace?.name ?? '') }, [workspace])
  const open = workspace !== null
  return <Modal open={open} onClose={onClose} title={t('重命名工作区', 'Rename workspace')}
    description={workspace?.path} closeLabel={t('关闭工作区重命名', 'Close workspace rename')} className={css.renameModal}
    footer={<div className={css.renameActions}>
      <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
      <Button variant="primary" disabled={workspace === null || name.trim() === ''}
        onClick={() => { if (workspace !== null) onSave(workspace, name.trim()) }}>{t('保存', 'Save')}</Button>
    </div>}>
    <label className={css.renameLabel} htmlFor="workspace-rename">{t('显示名称', 'Display name')}</label>
    <Input id="workspace-rename" value={name} data-modal-autofocus onChange={event => { setName(event.currentTarget.value) }} />
  </Modal>
}
