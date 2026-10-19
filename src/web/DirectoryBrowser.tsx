import { useEffect, useState } from 'react'
import { Button, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryListing } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './WorkspaceDialog.module.css'

export interface DirectoryBrowserProps {
  open: boolean
  onClose: () => void
  /** Chosen absolute directory. */
  onPick: (path: string) => void
}

/**
 * DSH's browse directory picker: the hosts without a native panel (Windows today)
 * pick a workspace directory from the host filesystem here instead.
 * @param props - dialog visibility and the picked path.
 * @returns the directory browser dialog.
 */
export default function DirectoryBrowser({ open, onClose, onPick }: DirectoryBrowserProps) {
  const { t } = useUiPreferences()
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [folderDraft, setFolderDraft] = useState('')

  const load = async (path?: string): Promise<void> => {
    setLoading(true); setError('')
    try { setListing(await api.listDirectories(path)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('无法读取目录', 'Could not read the directory')) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (open) void load() }, [open])

  const createFolder = async (): Promise<void> => {
    if (listing === null || folderDraft.trim() === '') return
    setError('')
    try {
      await api.createDirectory(listing.path, folderDraft.trim())
      setFolderDraft('')
      await load(listing.path)
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('无法创建文件夹', 'Could not create the folder')) }
  }

  const visible = listing === null ? [] : listing.entries.filter(entry => showHidden || !entry.hidden)
  return <Modal open={open} onClose={onClose} title={t('选择工作区目录', 'Select Workspace Directory')}
    closeLabel={t('关闭', 'Close')} className={css.browser} description={listing?.path}
    footer={<>
      <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
      <Button variant="primary" disabled={listing === null || loading} onClick={() => { if (listing !== null) onPick(listing.path) }}>{t('打开', 'Open')}</Button>
    </>}>
    <div className={css.crumbs} aria-label={t('路径', 'Path')}>
      {listing?.crumbs.map((crumb, index) => <span className={css.crumb} key={crumb.path}>
        {index > 0 && <IconChevronRightOutlineRegular size={12} aria-hidden="true" />}
        <button type="button" onClick={() => { void load(crumb.path) }}
          aria-current={index === listing.crumbs.length - 1 ? 'page' : undefined}>
          {crumb.path === listing.home && index > 0 ? t('主目录', 'Home') : crumb.name}
        </button>
      </span>)}
    </div>
    {loading && <p className={css.status} role="status">{t('加载中…', 'Loading…')}</p>}
    {error !== '' && <p className={css.error} role="alert">{error}</p>}
    {listing !== null && <div className={css.entries} role="list">
      {visible.map(entry => <button type="button" role="listitem" className={css.entry} key={entry.path}
        data-hidden={entry.hidden || undefined} onClick={() => { void load(entry.path) }}>
        <IconFolderCloseRegular size={16} />
        <span className={css.entryName}>{entry.name}</span>
      </button>)}
      {visible.length === 0 && !loading && <p className={css.status}>{t('没有子文件夹', 'No subfolders')}</p>}
    </div>}
    {listing?.truncated === true && <p className={css.status}>{t('文件夹过多，仅显示开头部分。', 'Too many folders; only the beginning is shown.')}</p>}
    <div className={css.footerTools}>
      <label className={css.inlineField}>{t('新建文件夹', 'New folder')}
        <Input value={folderDraft} disabled={listing === null} aria-label={t('文件夹名称', 'Folder name')}
          placeholder={t('文件夹名称', 'Folder name')} onChange={event => setFolderDraft(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void createFolder() } }} />
      </label>
      <Button variant="outline" size="sm" disabled={listing === null || folderDraft.trim() === ''} onClick={() => { void createFolder() }}>{t('创建', 'Create')}</Button>
      <label className={css.checkboxField}>
        <input type="checkbox" checked={showHidden} onChange={event => { setShowHidden(event.currentTarget.checked) }} />
        {t('显示隐藏文件', 'Show hidden files')}
      </label>
    </div>
  </Modal>
}
