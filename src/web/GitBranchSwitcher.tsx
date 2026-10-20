import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconPlusOutlineRegular,
  Input, Menu, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitBranchIssue, GitBranchMutation, GitBranchSnapshot } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './GitBranchSwitcher.module.css'

interface GitBranchSwitcherProps {
  workspaceId: string | undefined
  /** Tighter trigger used inside the composer toolbar. */
  compact?: boolean
}

/**
 * Local branch picker mirroring ZCode's `GitBranchSwitcher`: every open re-reads the branch list,
 * the current branch is pinned first, and the footer creates a branch at HEAD and switches to it.
 * Switching stays Git-native — blocked switches keep the menu open with ZCode's structured issues.
 */
export default function GitBranchSwitcher({ workspaceId, compact = false }: GitBranchSwitcherProps) {
  const { t } = useUiPreferences()
  const [snapshot, setSnapshot] = useState<GitBranchSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [issues, setIssues] = useState<GitBranchIssue[]>([])
  const [problem, setProblem] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState('')
  const request = useRef(0)

  useEffect(() => {
    setSnapshot(null)
    setOpen(false)
    setQuery('')
    setCreating(false)
    setIssues([])
    setProblem('')
    if (!workspaceId) return
    let live = true
    void api.getGitBranches(workspaceId).then(value => { if (live) setSnapshot(value) }).catch(() => { if (live) setSnapshot(null) })
    return () => { live = false }
  }, [workspaceId])

  /** ZCode reloads on every open so a switch made in another terminal is not hidden by a stale list. */
  const load = async (): Promise<void> => {
    if (!workspaceId) return
    const ticket = ++request.current
    try {
      const value = await api.getGitBranches(workspaceId)
      if (request.current === ticket) setSnapshot(value)
    } catch {
      // Keep the last good snapshot; the trigger still shows the branch it knew.
    }
  }

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setIssues([])
    setProblem('')
    setCreating(false)
    setNewName('')
    setCreateError('')
    void load()
  }

  const apply = (result: GitBranchMutation): boolean => {
    setSnapshot(result.snapshot)
    if (!result.ok) {
      setIssues(result.issues)
      return false
    }
    setIssues([])
    setProblem('')
    setQuery('')
    setCreating(false)
    setNewName('')
    setOpen(false)
    return true
  }

  const switchTo = async (name: string): Promise<void> => {
    if (!workspaceId || pending) return
    setPending(true)
    setIssues([])
    setProblem('')
    try {
      apply(await api.switchGitBranch(workspaceId, name))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : t('切换分支失败', 'Could not switch branches'))
    } finally {
      setPending(false)
    }
  }

  const createAndSwitch = async (): Promise<void> => {
    if (!workspaceId || pending) return
    const name = newName.trim()
    if (name === '') {
      setCreateError(t('请输入分支名', 'Enter a branch name'))
      return
    }
    setPending(true)
    setIssues([])
    setProblem('')
    setCreateError('')
    try {
      const result = await api.createGitBranch(workspaceId, name)
      setSnapshot(result.snapshot)
      if (result.ok) {
        setIssues([])
        setProblem('')
        setQuery('')
        setCreating(false)
        setNewName('')
        setOpen(false)
        return
      }
      // Creation failures are name-level (invalid, duplicate): keep the form open and show the
      // reason inline instead of stacking a second error card behind it.
      setIssues([])
      setCreateError(result.issues[0]?.detail?.trim() || result.issues[0]?.message || t('创建分支失败', 'Could not create the branch'))
      setCreating(true)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t('创建分支失败', 'Could not create the branch'))
    } finally {
      setPending(false)
    }
  }

  const branches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const list = snapshot?.branches ?? []
    return needle === '' ? list : list.filter(branch => branch.name.toLocaleLowerCase().includes(needle))
  }, [query, snapshot])

  if (!snapshot || !snapshot.isGitAvailable || !snapshot.isRepository) return null
  const label = snapshot.headRefType === 'detached'
    ? t('游离 HEAD', 'Detached HEAD')
    : snapshot.currentBranchName ?? t('分支', 'Branch')
  const issueText = (issue: GitBranchIssue): string => {
    switch (issue.code) {
      case 'tracked-changes-would-be-overwritten': return t('你对以下文件的更改将被检出操作覆盖：', 'Your changes to these files would be overwritten by the switch:')
      case 'untracked-changes-would-be-overwritten': return t('以下未跟踪文件会被检出操作覆盖：', 'These untracked files would be overwritten by the switch:')
      case 'conflicts-present': return t('仓库仍有未解决的冲突', 'The repository still has unresolved conflicts')
      case 'operation-in-progress': return t('有其他 Git 操作尚未结束', 'Another Git operation is still in progress')
      case 'branch-in-other-worktree': return t('该分支已在其他 worktree 中检出', 'That branch is checked out in another worktree')
      case 'branch-already-exists': return t('分支已存在', 'That branch already exists')
      case 'target-branch-not-found': return t('目标分支不存在', 'That branch does not exist')
      case 'invalid-branch-name': return t('分支名不合法', 'That branch name is not valid')
      default: return issue.detail?.trim() || issue.message
    }
  }

  return <Menu open={open} onClose={() => setOpen(false)} side="top" align="start" portal listClassName={css.menu}
    anchor={<button type="button" className={`${css.trigger} ${compact ? css.compact : ''}`}
      aria-label={`${t('切换 Git 分支，当前：', 'Switch Git branch, current: ')}${label}`} aria-expanded={open} aria-haspopup="menu"
      onClick={toggle}>
      <IconBranchOutlineRegular size={14} />
      <span className={css.label}>{label}</span>
      <IconChevronDownOutlineRegular size={11} />
    </button>}>
    <div className={css.search}>
      <Input className={css.searchInput} value={query} placeholder={t('搜索分支', 'Search branches')} aria-label={t('搜索分支', 'Search branches')}
        onChange={event => setQuery(event.currentTarget.value)} />
    </div>
    <div className={css.section}>{t('分支', 'Branches')}</div>
    <div className={css.list}>
      {branches.map(branch => <MenuItemButton key={branch.name} disabled={pending} icon={<IconBranchOutlineRegular size={14} />}
        onSelect={() => { void switchTo(branch.name) }}>
        <span className={css.row}>
          <span className={css.name}>{branch.name}</span>
          {branch.name === snapshot.currentBranchName && <IconCheckOutlineRegular size={14} />}
        </span>
      </MenuItemButton>)}
      {branches.length === 0 && <div className={css.empty}>{t('未找到匹配分支', 'No matching branches')}</div>}
    </div>
    {problem !== '' && <p className={css.issue} role="alert">{problem}</p>}
    {issues.length > 0 && <div className={css.issue} role="alert">
      <p>{issueText(issues[0]!)}</p>
      {(issues[0]?.paths?.length ?? 0) > 0 && <ul>{issues[0]!.paths!.slice(0, 6).map(path => <li key={path}>{path}</li>)}</ul>}
      {(issues[0]?.paths?.length ?? 0) > 6 && <p>{t(`另有 ${issues[0]!.paths!.length - 6} 个文件`, `${issues[0]!.paths!.length - 6} more files`)}</p>}
      <p className={css.hint}>{t('请先提交当前更改，再继续切换分支。', 'Commit your current changes before switching.')}</p>
    </div>}
    {creating
      ? <form className={css.createForm} onSubmit={event => { event.preventDefault(); void createAndSwitch() }}>
        <label className={css.createLabel}>{t('分支名', 'Branch name')}
          <Input className={css.searchInput} autoFocus value={newName} placeholder={t('例如 feature/branch-switcher', 'For example, feature/branch-switcher')}
            onChange={event => { setNewName(event.currentTarget.value); setCreateError('') }} />
        </label>
        {createError !== '' && <p className={css.createError} role="alert">{createError}</p>}
        <div className={css.createActions}>
          <button type="button" className={css.secondary} disabled={pending} onClick={() => { setCreating(false); setCreateError(''); setNewName('') }}>{t('取消', 'Cancel')}</button>
          <button type="submit" className={css.primary} disabled={pending || newName.trim() === ''}>{pending ? t('创建中…', 'Creating…') : t('创建并切换', 'Create and switch')}</button>
        </div>
      </form>
      : <div className={css.footer}>
        <button type="button" className={css.createAction} disabled={pending} onClick={() => { setCreating(true); setCreateError(''); setIssues([]) }}>
          <IconPlusOutlineRegular size={14} />
          <span>{t('创建并检出新分支...', 'Create and switch to new branch...')}</span>
        </button>
      </div>}
  </Menu>
}
