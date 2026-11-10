import { describe, expect, it } from 'vitest'
import {
  compileRule, decodeRule, defaultTimingDraft, describeRule, formatTimeOfDay,
  parseTimeOfDay, timingDraftValid, type TimingDraft,
} from '../src/shared/automation-timing.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const SHANGHAI = 'Asia/Shanghai'

function draft(patch: Partial<TimingDraft>): TimingDraft {
  return { ...defaultTimingDraft(NOW, SHANGHAI), ...patch }
}

describe('automation timing draft', () => {
  it('defaults to a one-time run an hour out in the given zone', () => {
    const value = defaultTimingDraft(NOW, SHANGHAI)
    expect(value.frequency).toBe('once')
    // 12:00Z is 20:00 in Shanghai, so the default lands at 21:00 the same day.
    expect(value.date).toBe('2026-11-10')
    expect(value.time).toBe('21:00')
    expect(value.timeZone).toBe(SHANGHAI)
  })

  it('reads and formats a clock time', () => {
    expect(parseTimeOfDay('17:00')).toEqual({ hour: 17, minute: 0 })
    expect(parseTimeOfDay('nonsense')).toEqual({ hour: 0, minute: 0 })
    expect(parseTimeOfDay('99:99')).toEqual({ hour: 23, minute: 59 })
    expect(formatTimeOfDay(17 * 60)).toBe('17:00')
  })

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

describe('automation timing compile and decode', () => {
  it('has no rule for a manual task', () => {
    expect(compileRule(draft({ frequency: 'manual' }), NOW)).toBeUndefined()
  })

  it('compiles a one-time rule', () => {
    const rule = compileRule(draft({ frequency: 'once', date: '2026-12-24', time: '18:30' }), NOW)
    expect(rule).toBe('DTSTART;TZID=Asia/Shanghai:20261224T183000\nRRULE:FREQ=DAILY;COUNT=1')
    expect(decodeRule(rule as string)).toMatchObject({ frequency: 'once', date: '2026-12-24', time: '18:30', timeZone: SHANGHAI })
  })

  it('compiles minute and hour intervals', () => {
    expect(compileRule(draft({ frequency: 'minutes', interval: '30' }), NOW))
      .toContain('RRULE:FREQ=MINUTELY;INTERVAL=30')
    expect(compileRule(draft({ frequency: 'hourly', interval: '2', time: '00:15' }), NOW))
      .toBe('DTSTART;TZID=Asia/Shanghai:20261110T001500\nRRULE:FREQ=HOURLY;INTERVAL=2')
  })

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

  it('writes UTC rules without a TZID parameter', () => {
    const rule = compileRule(draft({ frequency: 'daily', time: '09:00', timeZone: 'UTC' }), NOW)
    expect(rule).toBe('DTSTART:20261110T090000Z\nRRULE:FREQ=DAILY')
    expect(decodeRule(rule as string)).toMatchObject({ frequency: 'daily', timeZone: 'UTC' })
  })

  it('keeps an unparsable rule as advanced', () => {
    const rrule = 'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=MONTHLY;BYDAY=2TU'
    const decoded = decodeRule(rrule)
    expect(decoded?.frequency).toBe('advanced')
    expect(decoded?.rrule).toBe(rrule)
    expect(compileRule(draft({ frequency: 'advanced', rrule }), NOW)).toBe(rrule)
  })

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