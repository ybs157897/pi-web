import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileEntry, WorkspaceSummary } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './WorkspaceBrowserPage.module.css'

interface WorkspaceBrowserPageProps {
  workspace: WorkspaceSummary
  onOpenFile: (path: string) => void
  /** The directory to open at; empty means the workspace root. */
  path?: string
  /** Fit the inspector sidebar instead of the full main column. */
  compact?: boolean
}

/** Browse one registered workspace using server-validated relative paths. */
export default function WorkspaceBrowserPage({ workspace, onOpenFile, path: initialPath = '', compact = false }: WorkspaceBrowserPageProps) {
  const { t } = useUiPreferences()
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // A different starting directory (a directory the answer pointed at) moves the
  // browser there; the same one keeps the folder the reader walked into.
  useEffect(() => { setPath(current => current === initialPath ? current : initialPath) }, [initialPath])
  // Another workspace starts at its own root, but the first render keeps the
  // directory it was told to open at.
  const previousWorkspace = useRef(workspace.id)
  useEffect(() => {
    if (previousWorkspace.current === workspace.id) return
    previousWorkspace.current = workspace.id
    setPath(initialPath)
  }, [initialPath, workspace.id])
  // A new folder starts at its first entry instead of inheriting the previous
  // folder's scroll offset.
  useEffect(() => { if (listRef.current !== null) listRef.current.scrollTop = 0 }, [path])
  useEffect(() => {
    let active = true
    setLoading(true)
    api.listWorkspaceFiles(workspace.id, path).then(result => {
      if (!active) return
      setEntries(result.entries)
      setError('')
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : t('无法读取此目录', 'Could not read this folder'))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [path, reload, t, workspace.id])

  const crumbs = useMemo(() => path === '' ? [] : path.split('/').filter(Boolean).map((name, index, items) => ({
    name, path: items.slice(0, index + 1).join('/'),
  })), [path])

  return <div className={`${css.page}${compact ? ` ${css.compact}` : ''}`}>
    <header className={css.header}>
      <div className={css.heading}>
        <div className={css.crumbs} aria-label={t('当前目录', 'Current folder')}>
          <button type="button" onClick={() => { setPath('') }}>{workspace.name}</button>
          {crumbs.map(crumb => <span className={css.crumb} key={crumb.path}>
            <IconChevronRightOutlineRegular size={13} />
            <button type="button" onClick={() => { setPath(crumb.path) }}>{crumb.name}</button>
          </span>)}
        </div>
        <p>{workspace.path}{path === '' ? '' : `/${path}`}</p>
      </div>
      <Button variant="ghost" size="sm" aria-label={t('刷新目录', 'Refresh folder')}
        icon={<IconRefreshOutlineRegular size={15} />} onClick={() => { setReload(value => value + 1) }} />
    </header>
    <div className={css.list} ref={listRef}>
      {path !== '' && <button type="button" className={css.entry} onClick={() => {
        const parts = path.split('/').filter(Boolean)
        parts.pop()
        setPath(parts.join('/'))
      }}>
        <IconFolderCloseRegular size={16} /> <span>..</span>
      </button>}
      {loading && <div className={css.skeleton}><i /><i /><i /><i /></div>}
      {!loading && error !== '' && <div className={css.notice} role="alert">
        <span>{error}</span><Button variant="outline" size="sm" onClick={() => { setReload(value => value + 1) }}>{t('重试', 'Retry')}</Button>
      </div>}
      {!loading && error === '' && entries.length === 0 && <p className={css.empty}>{t('此目录为空', 'This folder is empty')}</p>}
      {!loading && error === '' && entries.map(entry => <FileEntry key={entry.path} entry={entry}
        onOpen={() => { entry.type === 'directory' ? setPath(entry.path) : onOpenFile(entry.path) }} />)}
    </div>
  </div>
}

function FileEntry({ entry, onOpen }: { entry: WorkspaceFileEntry; onOpen: () => void }) {
  const { t, settings } = useUiPreferences()
  return <button type="button" className={css.entry} onClick={onOpen}>
    {entry.type === 'directory' ? <IconFolderCloseRegular size={16} /> : <span className={css.fileIcon} aria-hidden>·</span>}
    <span className={css.name}>{entry.name}</span>
    <small>{entry.type === 'directory' ? t('文件夹', 'Folder') : formatBytes(entry.size)}</small>
    <time>{entry.modifiedAt === undefined ? '' : formatDate(entry.modifiedAt, settings.locale)}</time>
  </button>
}

function formatBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}
