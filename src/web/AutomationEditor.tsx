/**
 * 创建面板与行内编辑共用的规则编辑器。
 *
 * 草稿同时保留面向用户的频率选项与原始值；`compileRule` 把它编译为服务端存储的
 * 两行 RRULE。`advanced`（自定义）频率直接保留原始规则，使手写或模型生成的规则
 * 仍可作为文本编辑。
 */
import { useId } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Automation, CreateAutomationInput, UpdateAutomationInput, WorkspaceSummary } from '../shared/types.ts'
import {
  WEEKDAY_LABELS, compileRule, decodeRule, systemTimeZone, type AutomationFrequency, type TimingDraft,
} from '../shared/automation-timing.ts'
import { zoneOptions } from './time-zones.ts'
import type { Translate } from './render-labels.ts'
import css from './AutomationsPage.module.css'

/** 编辑器草稿：任务名、指令、投递目标、关联工作区与人类可读的时机草稿。 */
export interface AutomationDraft {
  name: string
  prompt: string
  target: 'new_once' | 'new'
  workspaceId: string
  timing: TimingDraft
}

/** 频率下拉的候选值与中英文案。 */
const FREQUENCIES: readonly { value: AutomationFrequency; zh: string; en: string }[] = [
  { value: 'weekly', zh: '每周', en: 'Weekly' },
  { value: 'weekdays', zh: '周一至周五', en: 'Weekdays' },
  { value: 'daily', zh: '每天', en: 'Daily' },
  { value: 'hourly', zh: '每 N 小时', en: 'Every N hours' },
  { value: 'minutes', zh: '每 N 分钟', en: 'Every N minutes' },
  { value: 'monthly', zh: '每月', en: 'Monthly' },
  { value: 'once', zh: '仅一次', en: 'Once' },
  { value: 'advanced', zh: '自定义', en: 'Custom' },
  { value: 'manual', zh: '手动', en: 'Manual' },
]

/** 执行位置下拉的候选值与中英文案（编辑器内只暴露两个非 session 选项）。 */
const TARGETS: readonly { value: 'new_once' | 'new'; zh: string; en: string }[] = [
  { value: 'new_once', zh: '新建会话并复用', en: 'New session, reused' },
  { value: 'new', zh: '每次新建会话', en: 'New session each run' },
]

/** 全部投递目标（含 session）的中英文标签，供详情面板展示。 */
export const TARGET_LABELS: Readonly<Record<string, { zh: string; en: string }>> = {
  session: { zh: '当前会话', en: 'This session' },
  new_once: { zh: '新建会话并复用', en: 'New session, reused' },
  new: { zh: '每次新建会话', en: 'New session each run' },
}

/** 生成新任务的空白草稿：时机默认「仅一次」，定在 now + 1 小时的整分钟时刻。 */
export function newDraft(workspaceId: string, timeZone: string, now = Date.now()): AutomationDraft {
  const later = new Date(now + 60 * 60 * 1000)
  const date = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`
  return {
    name: '',
    prompt: '',
    target: 'new_once',
    workspaceId,
    timing: {
      frequency: 'once', interval: '1', weekdays: [1], monthDay: later.getDate(),
      date, time: `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`,
      timeZone,
    },
  }
}

/**
 * 功能：自动化规则编辑器表单（创建面板与详情行内编辑共用）：任务名、任务内容、
 * 执行位置与关联工作区，以及「运行时间」区（重复频率、间隔、星期、日期、时间、
 * 时区、自定义 RRULE）。
 * @param props draft 受控草稿；onChange 以 patch 合并回传更新；workspaces 可选工作区；
 *              disabled 是否禁用整表（busy 期间）；t 双语翻译函数。
 * 内部逻辑：各字段直接把变更以 patch 回传（受控组件）；patchTiming 合并时机草稿；
 * 按频率条件渲染行——非 advanced/minutes/hourly 显示时钟输入、除 once/advanced/manual
 * 外显示间隔输入、weekly/weekdays 显示星期按钮组、monthly 显示每月日期、once 显示日期、
 * manual 显示提示、advanced 显示 RRULE 文本域；字段 id 由 useId 生成保证唯一。
 */
export function AutomationEditor({ draft, onChange, workspaces, disabled, t }: {
  draft: AutomationDraft
  onChange: (patch: Partial<AutomationDraft>) => void
  workspaces: readonly WorkspaceSummary[]
  disabled?: boolean
  t: Translate
}) {
  const id = useId()
  const rowId = (name: string): string => `${id}-${name}`
  const timing = draft.timing
  const patchTiming = (patch: Partial<TimingDraft>): void => { onChange({ timing: { ...timing, ...patch } }) }
  const zones = zoneOptions()
  const showClock = timing.frequency !== 'advanced' && timing.frequency !== 'minutes' && timing.frequency !== 'hourly'
  const showInterval = timing.frequency !== 'once' && timing.frequency !== 'advanced' && timing.frequency !== 'manual'
  return <fieldset disabled={disabled} className={css.editor}>
    <label className={css.field} htmlFor={rowId('name')}>
      <span>{t('自动化任务名称', 'Task name')}</span>
      <Input id={rowId('name')} value={draft.name} maxLength={120} placeholder={t('例如：每日阅读摘要', 'e.g. Daily reading digest')}
        onChange={event => { onChange({ name: event.currentTarget.value }) }} />
    </label>
    <label className={css.field} htmlFor={rowId('prompt')}>
      <span>{t('自动化任务内容', 'Task instruction')}</span>
      <textarea id={rowId('prompt')} className={css.instruction} value={draft.prompt}
        placeholder={t('说明任务内容和预期结果\n例如：汇总阅读清单中的新文章，并附原文链接', 'Describe the task and the expected result\ne.g. Summarize new articles from the reading list with links')}
        onChange={event => { onChange({ prompt: event.currentTarget.value }) }} />
    </label>
    <div className={css.ruleGroup}>
      <div className={css.ruleRow}>
        <label htmlFor={rowId('target')}>{t('执行位置', 'Delivered to')}</label>
        <select id={rowId('target')} className={css.rowSelect} value={draft.target}
          onChange={event => { onChange({ target: event.currentTarget.value as 'new_once' | 'new' }) }}>
          {TARGETS.map(option => <option key={option.value} value={option.value}>{t(option.zh, option.en)}</option>)}
        </select>
      </div>
      <div className={css.ruleRow}>
        <label htmlFor={rowId('workspace')}>{t('关联工作区', 'Workspace')}</label>
        <select id={rowId('workspace')} className={css.rowSelect} value={draft.workspaceId}
          onChange={event => { onChange({ workspaceId: event.currentTarget.value }) }}>
          <option value="">{t('默认工作区', 'Default workspace')}</option>
          {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select>
      </div>
    </div>
    <section className={css.timing} aria-label={t('运行时间', 'Timing')}>
      <h3>{t('运行时间', 'Timing')}</h3>
      <div className={css.ruleGroup}>
        <div className={css.ruleRow}>
          <label htmlFor={rowId('frequency')}>{t('重复', 'Repeat')}</label>
          <select id={rowId('frequency')} className={css.rowSelect} value={timing.frequency}
            onChange={event => { patchTiming({ frequency: event.currentTarget.value as AutomationFrequency }) }}>
            {FREQUENCIES.map(option => <option key={option.value} value={option.value}>{t(option.zh, option.en)}</option>)}
          </select>
        </div>
        {showInterval && <div className={css.ruleRow}>
          <label htmlFor={rowId('interval')}>{t('重复间隔', 'Interval')}</label>
          <input id={rowId('interval')} className={css.rowInput} inputMode="numeric" value={timing.interval}
            onChange={event => { patchTiming({ interval: event.currentTarget.value.replace(/[^0-9]/gu, '') }) }} />
        </div>}
        {(timing.frequency === 'weekly' || timing.frequency === 'weekdays') && <div className={css.ruleRow}>
          <span className={css.ruleLabel}>{t('星期', 'Weekdays')}</span>
          <div className={css.weekdays} role="group" aria-label={t('选择星期', 'Choose weekdays')}>
            {WEEKDAY_LABELS.map((label, index) => <button type="button" key={label}
              aria-pressed={timing.weekdays.includes(index)} data-selected={timing.weekdays.includes(index) || undefined}
              disabled={timing.frequency === 'weekdays'}
              onClick={() => { patchTiming({
                weekdays: timing.weekdays.includes(index)
                  ? timing.weekdays.filter(day => day !== index)
                  : [...timing.weekdays, index].sort((left, right) => left - right),
              }) }}>{label}</button>)}
          </div>
        </div>}
        {timing.frequency === 'monthly' && <div className={css.ruleRow}>
          <label htmlFor={rowId('monthDay')}>{t('每月日期', 'Day of month')}</label>
          <input id={rowId('monthDay')} className={css.rowInput} inputMode="numeric" value={String(timing.monthDay)}
            onChange={event => {
              const next = Math.min(31, Math.max(1, Number(event.currentTarget.value.replace(/[^0-9]/gu, '')) || 1))
              patchTiming({ monthDay: next })
            }} />
        </div>}
        {timing.frequency === 'once' && <div className={css.ruleRow}>
          <label htmlFor={rowId('date')}>{t('日期', 'Date')}</label>
          <input id={rowId('date')} className={css.rowInput} type="date" value={timing.date}
            onChange={event => { patchTiming({ date: event.currentTarget.value }) }} />
        </div>}
        {showClock && <div className={css.ruleRow}>
          <label htmlFor={rowId('time')}>{t('时间', 'Time')}</label>
          <input id={rowId('time')} className={css.rowInput} type="time" value={timing.time}
            onChange={event => { patchTiming({ time: event.currentTarget.value }) }} />
        </div>}
        {timing.frequency !== 'advanced' && <div className={css.ruleRow}>
          <label htmlFor={rowId('zone')}>{t('时区', 'Time zone')}</label>
          <select id={rowId('zone')} className={css.rowSelect} value={timing.timeZone}
            onChange={event => { patchTiming({ timeZone: event.currentTarget.value }) }}>
            {zones.map(zone => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
          </select>
        </div>}
      </div>
      {timing.frequency === 'manual' && <p className={css.hint}>
        {t('手动任务不会被定时触发，只能点「立即执行」。', 'A manual task never fires on its own; run it on demand.')}
      </p>}
      {timing.frequency === 'advanced' && <label className={css.field} htmlFor={rowId('rrule')}>
        <span>{t('自定义规则', 'Custom rule')}</span>
        <textarea id={rowId('rrule')} className={css.instruction} value={timing.rrule ?? ''}
          placeholder={'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=MONTHLY;BYDAY=2TU'}
          onChange={event => { patchTiming({ rrule: event.currentTarget.value }) }} />
      </label>}
    </section>
  </fieldset>
}
/** 把已存储的任务还原为编辑器草稿；无法解析的规则保留在 `advanced` 频率下作为原文编辑。 */
export function draftOf(automation: Automation): AutomationDraft {
  const timing = (automation.rrule === undefined ? undefined : decodeRule(automation.rrule))
    ?? {
      frequency: 'manual' as const, interval: '1', weekdays: [1], monthDay: 1,
      date: '', time: '00:00', timeZone: automation.timeZone ?? systemTimeZone(),
    }
  return {
    name: automation.name,
    prompt: automation.prompt,
    target: automation.target === 'session' ? 'new_once' : automation.target,
    workspaceId: automation.workspaceId ?? '',
    timing,
  }
}

/** 行内保存的更新补丁；原目标为 session 时保留原投递目的地不变。 */
export function inputOf(draft: AutomationDraft, original: Automation, now = Date.now()): UpdateAutomationInput {
  const rrule = compileRule(draft.timing, now) ?? null
  return {
    name: draft.name.trim(),
    prompt: draft.prompt,
    rrule,
    timeZone: draft.timing.timeZone,
    ...(original.target === 'session' ? {} : {
      target: draft.target,
      ...(original.target === 'new_once' && draft.target === 'new' ? { sessionId: null } : {}),
    }),
    ...(draft.workspaceId === '' ? { workspaceId: undefined } : { workspaceId: draft.workspaceId }),
  }
}

/** 创建任务的提交载荷：无可编译规则时以 paused 状态创建（手动任务）。 */
export function createInputOf(draft: AutomationDraft, now = Date.now()): CreateAutomationInput {
  const rrule = compileRule(draft.timing, now)
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    target: draft.target,
    status: rrule === undefined ? 'paused' : 'active',
    ...(rrule === undefined ? {} : { rrule, timeZone: draft.timing.timeZone }),
    ...(draft.workspaceId === '' ? {} : { workspaceId: draft.workspaceId }),
  }
}
