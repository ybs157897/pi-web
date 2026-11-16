import { describe, expect, it } from 'vitest'
import {
  compileRule, decodeRule, defaultTimingDraft, describeRule, formatTimeOfDay,
  parseTimeOfDay, timingDraftValid, type TimingDraft,
} from '../src/shared/automation-timing.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const SHANGHAI = 'Asia/Shanghai'

/**
 * 构造一个 TimingDraft 草稿：以默认草稿为基底叠加测试自定义字段。
 * @param patch 要覆盖的字段（频率、时间、星期等）
 * @returns 合并后的完整 TimingDraft
 */
function draft(patch: Partial<TimingDraft>): TimingDraft {
  return { ...defaultTimingDraft(NOW, SHANGHAI), ...patch }
}

/**
 * 自动化定时草稿（编辑器模型）测试。
 *
 * 验证 TimingDraft 相关纯函数的契约：
 * - 默认草稿 = 在给定时区的一小时后单次运行；
 * - parseTimeOfDay 宽容解析（非法输入归零、越界钳制），formatTimeOfDay 反向格式化；
 * - timingDraftValid 按频率校验各自必填字段；
 * - compileRule / decodeRule 在草稿与 RRULE 文本之间双向转换，解析不了的规则降级为 advanced 原样保留；
 * - describeRule 为列表页生成中文摘要。
 */
/** 定时草稿契约：默认值、校验、编译/解码往返与中文描述。 */
describe('automation timing draft', () => {
  // 默认草稿是给定时区一小时后的单次运行：12:00Z 在上海是 20:00，默认落在当天 21:00。
  it('defaults to a one-time run an hour out in the given zone', () => {
    const value = defaultTimingDraft(NOW, SHANGHAI)
    expect(value.frequency).toBe('once')
    // 12:00Z 即上海 20:00，因此默认落在当天 21:00。
    expect(value.date).toBe('2026-11-10')
    expect(value.time).toBe('21:00')
    expect(value.timeZone).toBe(SHANGHAI)
  })

  // parseTimeOfDay 对非法输入宽容降级（归零）、越界值钳制到 23:59；formatTimeOfDay 从分钟数格式化回 HH:mm。
  it('reads and formats a clock time', () => {
    expect(parseTimeOfDay('17:00')).toEqual({ hour: 17, minute: 0 })
    expect(parseTimeOfDay('nonsense')).toEqual({ hour: 0, minute: 0 })
    expect(parseTimeOfDay('99:99')).toEqual({ hour: 23, minute: 59 })
    expect(formatTimeOfDay(17 * 60)).toBe('17:00')
  })

  // 各频率只校验自己需要的字段：manual 恒通过；daily 要求完整 HH:mm；weekly 需至少一个星期；monthly 需 1-31；minutes/advanced 非空。
  it('validates the fields each frequency needs', () => {
    expect(timingDraftValid(draft({ frequency: 'manual' }), NOW)).toBe(true)
    expect(timingDraftValid(draft({ frequency: 'daily', time: '09:00' }), NOW)).toBe(true)
    expect(timingDraftValid(draft({ frequency: 'daily', time: '9:00' }), NOW)).toBe(false)
    expect(timingDraftValid(draft({ frequency: 'weekly', weekdays: [] }), NOW)).toBe(false)
    expect(timingDraftValid(draft({ frequency: 'weekly', weekdays: [1, 3] }), NOW)).toBe(true)
    expect(timingDraftValid(draft({ frequency: 'monthly', monthDay: 0 }), NOW)).toBe(false)
    expect(timingDraftValid(draft({ frequency: 'monthly', monthDay: 31 }), NOW)).toBe(true)
    expect(timingDraftValid(draft({ frequency: 'minutes', interval: '0' }), NOW)).toBe(false)
    expect(timingDraftValid(draft({ frequency: 'advanced', rrule: '' }), NOW)).toBe(false)
    expect(timingDraftValid(draft({ frequency: 'advanced', rrule: 'DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY' }), NOW)).toBe(true)
  })
})

/** 草稿与 RRULE 的编译/解码契约：双向往返、UTC 特例、advanced 降级与中文摘要。 */
describe('automation timing compile and decode', () => {
  // 手动任务不产生任何调度规则，compileRule 返回 undefined。
  it('has no rule for a manual task', () => {
    expect(compileRule(draft({ frequency: 'manual' }), NOW)).toBeUndefined()
  })

  // 单次运行编译为 COUNT=1 的 DAILY 规则，且 decodeRule 能还原出频率/日期/时刻/时区。
  it('compiles a one-time rule', () => {
    const rule = compileRule(draft({ frequency: 'once', date: '2026-12-24', time: '18:30' }), NOW)
    expect(rule).toBe('DTSTART;TZID=Asia/Shanghai:20261224T183000\nRRULE:FREQ=DAILY;COUNT=1')
    expect(decodeRule(rule as string)).toMatchObject({ frequency: 'once', date: '2026-12-24', time: '18:30', timeZone: SHANGHAI })
  })

  // 分钟间隔编译为 FREQ=MINUTELY;INTERVAL；小时间隔带 DTSTART 锚定的分钟（00:15）与 INTERVAL。
  it('compiles minute and hour intervals', () => {
    expect(compileRule(draft({ frequency: 'minutes', interval: '30' }), NOW))
      .toContain('RRULE:FREQ=MINUTELY;INTERVAL=30')
    expect(compileRule(draft({ frequency: 'hourly', interval: '2', time: '00:15' }), NOW))
      .toBe('DTSTART;TZID=Asia/Shanghai:20261110T001500\nRRULE:FREQ=HOURLY;INTERVAL=2')
  })

  // daily / weekdays（周一至周五）/ weekly（星期集合排序去重为 BYDAY）/ monthly（BYMONTHDAY）各自编译出对应 RRULE。
  it('compiles daily, weekday and monthly rules', () => {
    expect(compileRule(draft({ frequency: 'daily', time: '09:00' }), NOW))
      .toBe('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY')
    expect(compileRule(draft({ frequency: 'weekdays', time: '09:00' }), NOW))
      .toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
    expect(compileRule(draft({ frequency: 'weekly', weekdays: [3, 1], time: '09:00' }), NOW))
      .toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE')
    expect(compileRule(draft({ frequency: 'monthly', monthDay: 31, time: '00:00' }), NOW))
      .toContain('RRULE:FREQ=MONTHLY;BYMONTHDAY=31')
  })

  // UTC 时区编译出不带 TZID、以 Z 结尾的规则，解码后时区仍是 UTC。
  it('writes UTC rules without a TZID parameter', () => {
    const rule = compileRule(draft({ frequency: 'daily', time: '09:00', timeZone: 'UTC' }), NOW)
    expect(rule).toBe('DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY')
    expect(decodeRule(rule as string)).toMatchObject({ frequency: 'daily', timeZone: 'UTC' })
  })

  // 解析不了的规则（如带序号 BYDAY 的月规则）降级为 advanced 频率并原样保留文本；再次编译原样输出不破坏。
  it('keeps an unparsable rule as advanced', () => {
    const rrule = 'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=MONTHLY;BYDAY=2TU'
    const decoded = decodeRule(rrule)
    expect(decoded?.frequency).toBe('advanced')
    expect(decoded?.rrule).toBe(rrule)
    expect(compileRule(draft({ frequency: 'advanced', rrule }), NOW)).toBe(rrule)
  })

  // describeRule 为每种规则形态生成中文摘要（手动/每天/每 N 天/每周选中日/工作日/每月 N 日/每 N 分钟/每小时/仅一次/自定义）。
  it('describes each frequency for the list', () => {
    expect(describeRule(undefined)).toBe('手动')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY')).toBe('每天 09:00')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY;INTERVAL=2')).toBe('每 2 天 09:00')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T093000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE')).toBe('每周一、三 09:30')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('每周一至周五 09:00')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T000000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31')).toBe('每月 31 日 00:00')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T001500\nRRULE:FREQ=MINUTELY;INTERVAL=15')).toBe('每 15 分钟')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T001500\nRRULE:FREQ=HOURLY')).toBe('每小时 15 分')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261224T183000\nRRULE:FREQ=DAILY;COUNT=1')).toBe('仅一次 12/24 18:30')
    expect(describeRule('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=MONTHLY;BYDAY=2TU')).toBe('自定义规则')
  })
})
