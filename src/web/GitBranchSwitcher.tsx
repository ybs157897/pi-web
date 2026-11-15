import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconPlusOutlineRegular,
  Input, Menu, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitBranchIssue, GitBranchMutation, GitBranchSnapshot } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './GitBranchSwitcher.module.css'

/** GitBranchSwitcher 的属性定义：目标工作区、触发按钮紧凑模式与菜单弹出方向。 */
interface GitBranchSwitcherProps {
  workspaceId: string | undefined
  /** 输入框工具栏里使用的更紧凑触发按钮。 */
  compact?: boolean
  /** 从 composer 弹出时朝上，从状态卡弹出时朝下。 */
  side?: 'top' | 'bottom'
}

/**
 * 功能：本地分支切换器（对应 ZCode 的 `GitBranchSwitcher`）：触发按钮显示当前分支，
 * 打开后为搜索 + 分支列表 + 底部「创建并检出新分支」表单。出现在 composer 工具栏
 * 与状态卡中。切换保持 Git 原生语义——被阻塞的切换保持菜单打开并展示结构化问题。
 * @param props workspaceId 目标工作区；compact 是否紧凑触发按钮；side 菜单弹出方向。
 * 内部逻辑：每次打开都重新拉取分支列表（避免其他终端的切换被过期列表掩盖），
 * 请求票据（request.current）丢弃过期响应；workspaceId 变化时清空快照重新加载；
 * switchTo 失败时 issues/problem 展示结构化原因（如文件将被覆盖）并保持菜单；
 * createAndSwitch 失败保留表单并内联显示原因；branches 按 query 过滤。
 */
export default function GitBranchSwitcher({ workspaceId, compact = false, side = 'top' }: GitBranchSwitcherProps) {
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

  /** 每次打开菜单都重新加载分支列表（与 ZCode 一致），确保其他终端的切换不会藏在过期列表里。 */
  const load = async (): Promise<void> => {
    if (!workspaceId) return
    const ticket = ++request.current
    try {
      const value = await api.getGitBranches(workspaceId)
      if (request.current === ticket) setSnapshot(value)
      } catch {
      // 保留上一个有效快照；触发按钮仍显示已知的当前分支。
    }
  }

  /** 打开/关闭菜单：打开时清空问题与创建表单并重新加载分支列表。 */
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

  /** 应用分支变更结果：成功则更新快照并关闭菜单；失败则记录结构化 issues 并保持打开。 */
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

  /** 切换到指定分支：pending 期间防重入，失败时展示 problem 或结构化 issues。 */
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

  /** 创建分支并切换：名为空时提示；创建失败（重名/非法名）保留表单并内联报错。 */
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
      // 创建失败属于名称层面（非法/重复）：保持表单打开并内联显示原因，
      // 而不是在其后再叠一张错误卡。
      setIssues([])
      setCreateError(result.issues[0]?.detail?.trim() || result.issues[0]?.message || t('创建分支失败', 'Could not create the branch'))
      setCreating(true)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t('创建分支失败', 'Could not create the branch'))
    } finally {
      setPending(false)
    }
  }

  /** 按搜索词过滤分支列表（大小写不敏感的包含匹配）。 */
  const branches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const list = snapshot?.branches ?? []
    return needle === '' ? list : list.filter(branch => branch.name.toLocaleLowerCase().includes(needle))
  }, [query, snapshot])

  if (!snapshot || !snapshot.isGitAvailable || !snapshot.isRepository) return null
  const label = snapshot.headRefType === 'detached'
    ? t('游离 HEAD', 'Detached HEAD')
    : snapshot.currentBranchName ?? t('分支', 'Branch')
  /** 把结构化 Git 问题映射为面向用户的中文文案；未知代码回退到 detail/message。 */
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

  return <Menu open={open} onClose={() => setOpen(false)} side={side} align="start" portal listClassName={css.menu}
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
