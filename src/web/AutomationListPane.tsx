/**
 * 自动化主从页面（AutomationsPage）左侧的任务列表。
 *
 * 每行展示任务名称、重复规则，以及——对已开启的任务——下次触发时间
 * （绝对时间 + 相对时间两种表述）。点击某行即在右侧打开对应详情；
 * 加载与过滤由页面自身负责，本组件只做纯展示。
 */
import { IconAlarmClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { describeRule } from '../shared/automation-timing.ts'
import type { Automation } from '../shared/types.ts'
import { formatInZone } from './time-zones.ts'
import type { Translate } from './render-labels.ts'
import css from './AutomationsPage.module.css'

/**
 * 把一个时间戳渲染成相对时间文案：如「3 小时后」「5 分钟前」「即将」。
 * @param value 目标时间戳（毫秒）；now 当前时间戳，用于计算差值；t 双语翻译函数；
 *              locale 数字格式化用的 locale；timeZone 超过 30 天时回退为绝对时间所用时区。
 * @returns 相对时间字符串；差值超出 30 天时返回 formatInZone 的绝对时间戳——
 *          那个尺度上倒数已无帮助。
 */
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

/** 把任务状态映射为展示文案：active → 已开启、paused → 已暂停、其余 → 已结束。 */
export function statusLabel(status: Automation['status'], t: Translate): string {
  if (status === 'active') return t('已开启', 'Active')
  if (status === 'paused') return t('已暂停', 'Paused')
  return t('已结束', 'Ended')
}

/**
 * 功能：自动化任务列表（主从页左侧栏），以 listbox 形式渲染任务行，
 * 行内展示闹钟图标、任务名（内置任务附「内置」徽标）、重复规则与下次执行时间摘要。
 * @param props items 任务列表；selectedId 当前选中任务 id（高亮行）；now 当前时间戳
 *              （计算相对时间）；locale 数字/时间格式化 locale；onSelect 选中任务回调；
 *              t 双语翻译函数。
 * 内部逻辑：每行按 status 计算 active 态的 nextRunAt，有下次时间时摘要为
 * 「下次计划时间：绝对时间（相对时间）」，否则仅显示状态标签（已开启/已暂停/已结束）；
 * 行以 role=option + aria-selected 表达选中态。
 */
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