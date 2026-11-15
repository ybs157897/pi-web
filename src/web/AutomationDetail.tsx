/**
 * 自动化主从页面的右侧详情面板：展示单个任务的规则与投递历史。
 *
 * 「任务运行记录」列出实际发生的事：`new`/`new_once` 运行带有结果
 * （completed/failed/interrupted）；`session` 投递只证明送达，显示为 `delivered`。
 * 两者都记录被触发的发生时刻，即时间列显示的内容。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconPauseOutlineRegular,
  IconPlayOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { describeRule } from '../shared/automation-timing.ts'
import type { Automation, AutomationRun, UpdateAutomationInput } from '../shared/types.ts'
import { formatInZone } from './time-zones.ts'
import { AutomationEditor, TARGET_LABELS, draftOf, inputOf, type AutomationDraft } from './AutomationEditor.tsx'
import { relativeText, statusLabel } from './AutomationListPane.tsx'
import type { Translate } from './render-labels.ts'
import css from './AutomationsPage.module.css'

/** 详情面板的两个页签：规则（查看/编辑）与任务运行记录。 */
type DetailTab = 'rule' | 'records'

/** 把单次运行状态映射为展示文案：已完成/失败/已中断/已投递/运行中。 */
export function runStatusLabel(status: AutomationRun['status'], t: Translate): string {
  switch (status) {
    case 'completed': return t('已完成', 'Completed')
    case 'failed': return t('失败', 'Failed')
    case 'interrupted': return t('已中断', 'Interrupted')
    case 'delivered': return t('已投递', 'Delivered')
    case 'running': return t('运行中', 'Running')
  }
}

/**
 * 功能：单个自动化任务的详情面板（主从页右侧）：头部为任务名 + 状态徽标 +
 * 编辑/暂停恢复/更多操作；下方「规则」「任务运行记录」两个页签分别展示
 * 规则事实（重复规则/执行位置/时区/任务内容/下次运行）与投递历史列表。
 * @param props automation 任务数据；runs 已加载的运行记录；totalRuns 记录总数
 *              （用于「加载更多」）；loadingRuns 是否在加载记录；now 当前时间戳；
 *              locale 时间格式化 locale；workspaces 编辑草稿可选的工作区；
 *              busy 外部忙碌（禁用操作）；onSave/onToggle/onRun/onDelete 分别为
 *              保存编辑、暂停恢复、立即执行、删除任务回调；onOpenConversation 打开
 *              关联会话；onLoadMoreRuns 加载更早的运行记录。
 * 内部逻辑：tab/editing/draft/menuOpen 四个状态驱动视图；automation.id 变化时重置
 * 全部本地状态回「规则」页查看态；dirty 比较 draft 与 draftOf(automation) 的序列化；
 * 保存按钮仅在 dirty 且名称/提示词非空时可用；取消编辑回滚草稿。
 */
export function AutomationDetail({ automation, runs, totalRuns, loadingRuns, now, locale, workspaces, busy, t, onSave, onToggle, onRun, onDelete, onOpenConversation, onLoadMoreRuns }: {
  automation: Automation
  runs: readonly AutomationRun[]
  totalRuns: number
  loadingRuns: boolean
  now: number
  locale: string
  workspaces: readonly import('../shared/types.ts').WorkspaceSummary[]
  busy: boolean
  t: Translate
  onSave: (input: UpdateAutomationInput) => void
  onToggle: (status: 'active' | 'paused') => void
  onRun: () => void
  onDelete: () => void
  onOpenConversation: (id: string) => void
  onLoadMoreRuns: () => void
}) {
  const [tab, setTab] = useState<DetailTab>('rule')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<AutomationDraft>(() => draftOf(automation))
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setDraft(draftOf(automation))
    setEditing(false)
    setMenuOpen(false)
    setTab('rule')
  }, [automation.id])

  const active = automation.status === 'active'
  const target = TARGET_LABELS[automation.target]
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(automation)), [draft, automation])
  const canSave = dirty && draft.name.trim() !== '' && draft.prompt.trim() !== ''

  return <section className={css.detail} aria-label={automation.name}>
    <header className={css.detailHead}>
      <div className={css.detailTitle}>
        <h2>{automation.name}</h2>
        <span className={css.statusPill} data-status={automation.status}>{statusLabel(automation.status, t)}</span>
        {automation.builtin !== undefined && <span className={css.builtin}>{t('内置', 'Built-in')}</span>}
      </div>
      <div className={css.detailActions}>
        {!editing && <Button variant="ghost" size="sm" disabled={busy}
          onClick={() => { setEditing(true) }}>{t('编辑', 'Edit')}</Button>}
        {(active || automation.status === 'paused') && <Button variant="ghost" size="sm" disabled={busy}
          aria-label={active ? t('暂停任务', 'Pause task') : t('恢复任务', 'Resume task')}
          icon={active ? <IconPauseOutlineRegular size={15} /> : <IconPlayOutlineRegular size={15} />}
          onClick={() => { onToggle(active ? 'paused' : 'active') }} />}
        <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} align="end" portal
          anchor={<Button variant="ghost" size="sm" aria-label={t('更多操作', 'More actions')}
            icon={<IconEllipsisOutlineRegular size={15} />} onClick={() => { setMenuOpen(value => !value) }} />}
          items={[
            { id: 'run', label: t('立即执行', 'Run now'), disabled: busy || automation.lastRun?.status === 'running' },
            { type: 'separator', id: 'sep' },
            { id: 'delete', label: t('删除任务', 'Delete task'), danger: true },
          ]}
          onSelect={id => {
            setMenuOpen(false)
            if (id === 'run') onRun()
            if (id === 'delete') onDelete()
          }} />
      </div>
    </header>
    <nav className={css.detailTabs} role="tablist" aria-label={t('任务详情', 'Task detail')}>
      <button type="button" role="tab" aria-selected={tab === 'rule'} data-selected={tab === 'rule' || undefined}
        onClick={() => { setTab('rule') }}>{t('规则', 'Rule')}</button>
      <button type="button" role="tab" aria-selected={tab === 'records'} data-selected={tab === 'records' || undefined}
        onClick={() => { setTab('records') }}>{t('任务运行记录', 'Runs')}</button>
    </nav>
    <div className={css.detailBody}>
      {tab === 'rule' && (editing
        ? <>
          <AutomationEditor draft={draft} onChange={patch => { setDraft(current => ({ ...current, ...patch })) }}
            workspaces={workspaces} disabled={busy} t={t} />
          <div className={css.editActions}>
            <Button variant="ghost" onClick={() => { setEditing(false); setDraft(draftOf(automation)) }}>{t('取消', 'Cancel')}</Button>
            <Button variant="primary" disabled={!canSave || busy}
              onClick={() => { onSave(inputOf(draft, automation)) }}>{t('保存', 'Save')}</Button>
          </div>
        </>
        : <>
          <p className={css.detailNext}>
            {active && automation.nextRunAt !== undefined
              ? <>{t('下次运行', 'Next run')}：{formatInZone(automation.nextRunAt, automation.timeZone, locale)}
                {' · '}{relativeText(automation.nextRunAt, now, t, locale, automation.timeZone)}</>
              : <>{statusLabel(automation.status, t)}{automation.rrule === undefined ? ` · ${t('手动运行', 'Manual')}` : ''}</>}
          </p>
          <div className={css.ruleFacts}>
            <div className={css.ruleRow}>
              <span className={css.ruleLabel}>{t('重复', 'Repeat')}</span>
              <span>{describeRule(automation.rrule)}</span>
            </div>
            <div className={css.ruleRow}>
              <span className={css.ruleLabel}>{t('执行位置', 'Delivered to')}</span>
              <span>{target === undefined ? automation.target : t(target.zh, target.en)}</span>
            </div>
            {automation.timeZone !== undefined && <div className={css.ruleRow}>
              <span className={css.ruleLabel}>{t('时区', 'Time zone')}</span>
              <span>{automation.timeZone}</span>
            </div>}
          </div>
          <div className={css.instructionBlock}>
            <h3>{t('任务内容', 'Instruction')}</h3>
            <pre>{automation.prompt}</pre>
          </div>
          {automation.sessionId !== undefined && <div className={css.detailFoot}>
            <Button variant="outline" size="sm"
              onClick={() => { onOpenConversation(automation.sessionId as string) }}>{t('打开关联会话', 'Open conversation')}</Button>
          </div>}
        </>)}
      {tab === 'records' && <>
        {runs.length === 0
          ? <p className={css.recordsEmpty}>{t('暂无任务运行记录', 'No runs yet')}</p>
          : <ul className={css.records}>
            {runs.map(run => <li key={run.id} className={css.recordRow} data-status={run.status}>
              <span className={css.recordTime}>
                {formatInZone(run.plannedAt ?? run.startedAt ?? run.finishedAt ?? automation.updatedAt, automation.timeZone, locale)}
              </span>
              <span className={css.recordStatus}>{runStatusLabel(run.status, t)}</span>
              {run.error !== undefined && <span className={css.recordError}>{run.error}</span>}
              {run.conversationId !== undefined && <Button variant="ghost" size="sm"
                onClick={() => { onOpenConversation(run.conversationId as string) }}>{t('查看会话', 'View session')}</Button>}
            </li>)}
          </ul>}
        {runs.length < totalRuns && <div className={css.recordsMore}>
          <Button variant="outline" size="sm" disabled={loadingRuns}
            onClick={() => { onLoadMoreRuns() }}>{loadingRuns ? t('加载中…', 'Loading…') : t('加载更多', 'Load more')}</Button>
        </div>}
        {runs.length > 0 && <p className={css.recordsNote}>{t('更早的运行记录已清理，只保留最近 50 条。', 'Older runs are pruned; the latest 50 are kept.')}</p>}
      </>}
    </div>
  </section>
}