import { useCallback, useEffect, useState } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HookEntryView, HooksListView, HookSourceView } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './HooksPanel.module.css'

/**
 * 功能：钩子设置面板——用户级（~/.pi-web/hooks.json）与项目级（<workspace>/.pi-web/hooks.json）
 * 两来源的清单、逐条启停/删除、项目级信任批准/撤销。
 * 内部逻辑：挂载与 workspaceId 变化时拉取清单（active 标记防卸载后 setState）；
 * 启停/删除直接用服务端返回的新清单更新视图；批准/撤销后重拉；删除走确认弹窗。
 * 项目级外部声明（git clone 带来）默认 pending 不执行，须在此批准——与 manage_hooks
 * 工具「agent 创建即用户确认」的自动信任是两条边界。
 */
export default function HooksPanel({ workspaceId }: { workspaceId?: string }) {
  const { settings } = useUiPreferences()
  const t = (chinese: string, english: string) => settings.locale === 'en' ? english : chinese
  const [view, setView] = useState<HooksListView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{ scope: 'user' | 'project'; entry: HookEntryView } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setView(await api.getHooks(workspaceId)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('读取钩子配置失败', 'Could not load hooks')) }
    finally { setLoading(false) }
  }, [workspaceId, settings.locale])

  useEffect(() => {
    let active = true
    setLoading(true)
    void api.getHooks(workspaceId).then(next => { if (active) setView(next) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : t('读取钩子配置失败', 'Could not load hooks')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [workspaceId, settings.locale])

  /** 包装写操作：busy 防重入，错误落 error 横幅。 */
  const run = async (action: () => Promise<HooksListView | { ok: boolean }>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if ('user' in result) setView(result)
      else await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('操作失败', 'Operation failed'))
    } finally { setBusy(false) }
  }

  const pendingCount = view?.project?.entries.filter(entry => entry.trust === 'pending').length ?? 0
  const toggle = (scope: 'user' | 'project', entry: HookEntryView, enabled: boolean) =>
    void run(() => api.setHookEnabled({ scope, workspaceId, event: entry.event, index: entry.index, enabled }))
  const remove = (scope: 'user' | 'project', entry: HookEntryView) =>
    void run(() => api.removeHookEntry({ scope, workspaceId, event: entry.event, index: entry.index }))
  const trust = (entry: HookEntryView) => {
    if (workspaceId === undefined) return
    void run(() => api.trustHook({ workspaceId, digest: entry.digest }))
  }
  const revoke = (entry: HookEntryView) => {
    if (workspaceId === undefined) return
    void run(() => api.revokeHook({ workspaceId, digest: entry.digest }))
  }

  /** 一个来源的分组：标题、路径、来源级状态与条目列表。 */
  const renderSource = (scope: 'user' | 'project', source: HookSourceView) => <section className={css.source} key={scope}>
    <div className={css.sourceHead}>
      <h3>{scope === 'user' ? t('用户级', 'User') : t('项目级', 'Project')}</h3>
      <span className={css.sourceMeta}>
        {source.enabled ? t('已启用', 'Enabled') : t('来源已禁用', 'Source disabled')}
        {' · '}{t(`默认超时 ${source.timeoutMs / 1000} 秒`, `default timeout ${source.timeoutMs / 1000}s`)}
      </span>
      <Button size="sm" variant="ghost" disabled={busy || loading} onClick={() => void load()}>{t('刷新', 'Refresh')}</Button>
    </div>
    <code className={css.path}>{source.path}</code>
    {source.error !== undefined && <p className={css.error} role="alert">{source.error}</p>}
    {source.entries.length === 0
      ? <p className={css.empty} role="status">{t('还没有钩子。可以让 agent 用 manage_hooks 工具创建。', 'No hooks yet. Ask the agent to create one with manage_hooks.')}</p>
      : <ul className={css.entries}>{source.entries.map(entry => <li className={css.entry} key={`${entry.event}-${entry.index}`}>
        <div className={css.entryMain}>
          <span className={css.event}>{entry.event}</span>
          {entry.matcher !== undefined && entry.matcher !== '' && <span className={css.matcher}>{entry.matcher}</span>}
          {scope === 'project' && <TrustBadge trust={entry.trust} t={t} />}
          <code className={css.command} title={entry.entry.type === 'process' ? [entry.entry.command, ...(entry.entry.args ?? [])].join(' ') : entry.entry.command}>
            {entry.entry.type === 'process' ? [entry.entry.command, ...(entry.entry.args ?? [])].join(' ') : entry.entry.command}
          </code>
          <span className={css.timeout}>{entry.entry.timeoutMs !== undefined ? `${entry.entry.timeoutMs / 1000}s` : t('默认', 'default')}</span>
        </div>
        <div className={css.entryActions}>
          {scope === 'project' && entry.trust === 'pending' && <Button size="sm" variant="outline" disabled={busy} onClick={() => trust(entry)}>{t('批准', 'Approve')}</Button>}
          {scope === 'project' && entry.trust === 'trusted' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => revoke(entry)}>{t('撤销信任', 'Revoke trust')}</Button>}
          <button type="button" role="switch" aria-label={t('启停钩子', 'Toggle hook')} aria-checked={entry.entry.enabled !== false} disabled={busy}
            className={css.toggle} onClick={() => toggle(scope, entry, entry.entry.enabled === false)}><span /></button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete({ scope, entry })}>{t('删除', 'Delete')}</Button>
        </div>
      </li>)}</ul>}
  </section>

  return <div className={css.panel}>
    {pendingCount > 0 && <p className={css.pendingBanner} role="status">
      {t(`${pendingCount} 条项目级钩子待批准——外部带来的声明批准后才会执行。`, `${pendingCount} project hook(s) pending approval — external declarations only run after approval.`)}
    </p>}
    {error !== '' && <p className={css.error} role="alert">{error}</p>}
    {loading && view === null && <p className={css.empty} role="status">{t('正在读取钩子配置…', 'Loading hooks…')}</p>}
    {view !== null && <>
      {renderSource('user', view.user)}
      {workspaceId === undefined
        ? <p className={css.empty}>{t('当前会话没有工作区，项目级钩子不可用。', 'No workspace in this conversation; project hooks are unavailable.')}</p>
        : view.project !== undefined && renderSource('project', view.project)}
    </>}
    <p className={css.description}>
      {t('修改立即生效（每次触发读取最新配置）。项目级钩子随仓库共享；创建钩子可直接让 agent 用 manage_hooks 工具完成，创建前会向你确认超时时间（默认 15 秒）。',
        'Changes apply immediately (config is re-read on every trigger). Project hooks travel with the repo; ask the agent to create hooks via manage_hooks — it confirms the timeout (default 15s) first.')}
    </p>
    <Modal open={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title={t('删除钩子', 'Delete hook')} closeLabel={t('关闭', 'Close')}>
      {confirmDelete !== null && <>
        <p className={css.description}>
          {t(`确认删除 ${confirmDelete.entry.event} 钩子？`, `Delete the ${confirmDelete.entry.event} hook?`)}
          <code className={css.command}>{confirmDelete.entry.entry.command}</code>
        </p>
        <div className={css.confirmActions}>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>{t('取消', 'Cancel')}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { const target = confirmDelete; setConfirmDelete(null); remove(target.scope, target.entry) }}>{t('删除', 'Delete')}</Button>
        </div>
      </>}
    </Modal>
  </div>
}

/** 项目级信任状态徽标：状态点 + 文字（对读屏器友好）。 */
function TrustBadge({ trust, t }: { trust: HookEntryView['trust']; t: (chinese: string, english: string) => string }) {
  if (trust === 'not_required') return null
  const dot = trust === 'trusted' ? 'done' : trust === 'pending' ? 'idle' : 'error'
  const label = trust === 'trusted' ? t('已信任', 'Trusted') : trust === 'pending' ? t('待批准', 'Pending') : t('信任存储损坏', 'Trust store corrupt')
  return <span className={css.trust} data-trust={trust}><StateDot state={dot} size={8} />{label}</span>
}