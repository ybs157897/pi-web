import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MessageFileIcon } from './message-rendering/FileIcon.tsx'
import type { WorkspaceFileEntry, WorkspaceSummary } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './WorkspaceBrowserPage.module.css'

/** WorkspaceBrowserPage 的属性定义：目标工作区、文件打开回调、初始目录与紧凑模式。 */
interface WorkspaceBrowserPageProps {
  workspace: WorkspaceSummary
  onOpenFile: (path: string) => void
  /** 初始打开的目录；空串表示工作区根目录。 */
  path?: string
  /** 以 Inspector 侧栏尺寸渲染，而非占满主列。 */
  compact?: boolean
}

/**
 * 功能：浏览某个已注册工作区的文件页面（经服务端校验的相对路径）：
 * 头部为工作区名 + 相对路径面包屑与刷新按钮，主体为目录条目列表（.. 返回上级）。
 * @param props workspace 目标工作区；onOpenFile 打开文件回调；path 初始目录（空为根）；
 *              compact 是否以侧栏紧凑尺寸渲染。
 * 内部逻辑：path/entries/loading/error/reload 状态驱动列表；initialPath 变化（如答案
 * 指向某目录）时跳转，同值则保留用户已进入的目录；切换工作区时重置到初始目录；
 * 进入新目录时列表滚动归零；数据经 api.listWorkspaceFiles 拉取，失败时展示错误 + 重试；
 * crumbs 由 path 按段拆分生成，点击回跳对应层级。
 */
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
  const fullPath = path === '' ? workspace.path : `${workspace.path}/${path}`

  return <div className={`${css.page}${compact ? ` ${css.compact}` : ''}`}>
    <header className={css.header}>
      <div className={css.heading}>
        <div className={css.crumbs} aria-label={t('当前目录', 'Current folder')}>
          <button type="button" title={workspace.name} aria-current={path === '' ? 'location' : undefined}
            onClick={() => { setPath('') }}>{workspace.name}</button>
          {crumbs.map(crumb => <span className={css.crumb} key={crumb.path}>
            <IconChevronRightOutlineRegular size={13} aria-hidden="true" />
            <button type="button" title={crumb.name} aria-current={crumb.path === path ? 'location' : undefined}
              onClick={() => { setPath(crumb.path) }}>{crumb.name}</button>
          </span>)}
        </div>
        <p title={fullPath}>{fullPath}</p>
      </div>
      <Button variant="ghost" size="sm" aria-label={t('刷新目录', 'Refresh folder')}
        icon={<IconRefreshOutlineRegular size={15} />} onClick={() => { setReload(value => value + 1) }} />
    </header>
    <div className={css.list} ref={listRef}>
      {path !== '' && <button type="button" className={css.entry} aria-label={t('返回上级目录', 'Go to parent folder')} onClick={() => {
        const parts = path.split('/').filter(Boolean)
        parts.pop()
        setPath(parts.join('/'))
      }}>
        <IconFolderCloseRegular size={16} aria-hidden="true" /> <span className={css.name}>..</span>
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

/** 单个文件/目录条目行：图标 + 名称 + 类型或大小 + 修改时间；点击经 onOpen 进入或打开。 */
function FileEntry({ entry, onOpen }: { entry: WorkspaceFileEntry; onOpen: () => void }) {
  const { t, settings } = useUiPreferences()
  const directory = entry.type === 'directory'
  return <button type="button" className={css.entry} title={entry.name} onClick={onOpen}>
    {directory ? <IconFolderCloseRegular size={16} aria-hidden="true" /> : <MessageFileIcon path={entry.path} />}
    <span className={css.name}>{entry.name}</span>
    <small>{directory ? t('文件夹', 'Folder') : formatBytes(entry.size)}</small>
    <time>{entry.modifiedAt === undefined ? '' : formatDate(entry.modifiedAt, settings.locale)}</time>
    <span className={css.entryAction} aria-hidden="true">{directory && <IconChevronRightOutlineRegular size={14} />}</span>
  </button>
}

/** 把字节数格式化为 B/KB/MB 文案。 */
function formatBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 按界面语言把时间戳格式化为「月/日 时:分」。 */
function formatDate(value: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}
