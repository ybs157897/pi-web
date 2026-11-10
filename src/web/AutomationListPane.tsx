/**
 * The left list of the automations master-detail page.
 *
 * A row shows what the task is called, how it repeats, and — for an active task —
 * when it fires next as an absolute time plus a relative one. Selecting a row opens
 * its detail on the right; the page owns loading and filtering.
 */
import { IconAlarmClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { describeRule } from '../shared/automation-timing.ts'
import type { Automation } from '../shared/types.ts'
import { formatInZone } from './time-zones.ts'
import type { Translate } from './render-labels.ts'
import css from './AutomationsPage.module.css'

/** 「3 小时后」, or an absolute stamp far enough out that a count stops helping. */
export function relativeText(value: number, now: number, t: Translate, locale: string, timeZone?: string): string {
  const delta = value - now
  const absolute = Math.abs(delta)
  const future = delta >= 0
  if (absolute < 60_000) return future ? t('即将', 'soon') : t('刚刚', 'just now')
  if (absolute < 3_600_000) {
    const count = Math.max(1, Math.round(absolute / 60_000))
    return future ? t(`${count} 分钟后`, `in ${count} min`) : t(`${count} 分钟前`, `${count} min ago`)
  }
  if (absolute < 86_400_000) {
    const count = Math.max(1, Math.round(absolute / 3_600_000))
    return future ? t(`${count} 小时后`, `in ${count} h`) : t(`${count} 小时前`, `${count} h ago`)
  }
  if (absolute < 30 * 86_400_000) {
    const count = Math.max(1, Math.round(absolute / 86_400_000))
    return future ? t(`${count} 天后`, `in ${count} d`) : t(`${count} 天前`, `${count} d ago`)
  }
  return formatInZone(value, timeZone, locale)
}

export function statusLabel(status: Automation['status'], t: Translate): string {
  if (status === 'active') return t('已开启', 'Active')
  if (status === 'paused') return t('已暂停', 'Paused')
  return t('已结束', 'Ended')
}

export function AutomationListPane({ items, selectedId, now, locale, onSelect, t }: {
  items: readonly Automation[]
  selectedId: string | undefined
  now: number
  locale: string
  onSelect: (id: string) => void
  t: Translate
}) {
  return <ul className={css.taskList} role="listbox" aria-label={t('自动化任务列表', 'Automation list')}>
    {items.map(automation => {
      const active = automation.status === 'active'
      const next = active ? automation.nextRunAt : undefined
      const summary = next === undefined
        ? statusLabel(automation.status, t)
        : `${t('下次计划时间', 'Next run')}：${formatInZone(next, automation.timeZone, locale)}（${relativeText(next, now, t, locale, automation.timeZone)}）`
      return <li key={automation.id}>
        <button type="button" role="option" aria-selected={automation.id === selectedId}
          data-selected={automation.id === selectedId || undefined} data-status={automation.status}
          className={css.taskRow} onClick={() => { onSelect(automation.id) }}>
          <IconAlarmClockOutlineRegular size={15} />
          <span className={css.taskText}>
            <span className={css.taskTitle}>
              {automation.name}
              {automation.builtin !== undefined && <span className={css.builtin}>{t('内置', 'Built-in')}</span>}
            </span>
            <span className={css.taskMeta}>
              <span data-status={automation.status}>{describeRule(automation.rrule)}</span>
              <span className={css.taskDot}>·</span>
              <span>{summary}</span>
            </span>
          </span>
        </button>
      </li>
    })}
  </ul>
}