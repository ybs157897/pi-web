import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './WorkspaceDialog.module.css'

/** Rename the visible label while keeping a workspace's registered path stable. */
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
