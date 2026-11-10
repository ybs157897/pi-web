import { describe, expect, it } from 'vitest'
import { nextRunOf, parseRule, RuleError } from '../src/server/automation/recurrence.ts'

const iso = (value: number | undefined): string | undefined => value === undefined ? undefined : new Date(value).toISOString()

describe('automation recurrence engine', () => {
  it('fires every day at the chosen wall clock in a zone', () => {
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261102T170000\nRRULE:FREQ=DAILY'
    // 18:00 in Shanghai is 10:00Z, so the next run is the following 17:00 there.
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T10:00:00Z')))).toBe('2026-11-03T09:00:00.000Z')
    // Exactly on the due time moves forward, never to the same instant.
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T09:00:00Z')))).toBe('2026-11-03T09:00:00.000Z')
  })

  it('fires every hour at the minute named by DTSTART', () => {
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261102T003000\nRRULE:FREQ=HOURLY'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T02:10:00Z')))).toBe('2026-11-02T02:30:00.000Z')
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T02:45:00Z')))).toBe('2026-11-02T03:30:00.000Z')
  })

  it('fires on the chosen weekday', () => {
    // 2026-11-02 is a Monday; ask for Wednesday 09:00 Shanghai.
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261102T090000\nRRULE:FREQ=WEEKLY;BYDAY=WE'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T00:00:00Z')))).toBe('2026-11-04T01:00:00.000Z')
    // Later on the same weekday waits for the next week.
    expect(iso(nextRunOf(rule, Date.parse('2026-11-04T02:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
  })

  it('skips a month without the requested day instead of clamping', () => {
    const rule = 'DTSTART;TZID=UTC:20260131T000000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31'
    expect(iso(nextRunOf(rule, Date.parse('2026-02-01T00:00:00Z')))).toBe('2026-03-31T00:00:00.000Z')
    expect(iso(nextRunOf(rule, Date.parse('2026-04-01T00:00:00Z')))).toBe('2026-05-31T00:00:00.000Z')
  })

  it('ends a rule whose COUNT is exhausted', () => {
    const once = 'DTSTART;TZID=Asia/Shanghai:20261101T090000\nRRULE:FREQ=DAILY;COUNT=1'
    expect(nextRunOf(once, Date.parse('2026-11-01T00:00:00Z'))).toBe(Date.parse('2026-11-01T01:00:00Z'))
    expect(nextRunOf(once, Date.parse('2026-11-02T00:00:00Z'))).toBeUndefined()
  })

  it('skips a local time that daylight saving removes', () => {
    // New York springs forward on 2026-03-08; 02:30 does not exist that day.
    const rule = 'DTSTART;TZID=America/New_York:20260307T023000\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(rule, Date.parse('2026-03-07T20:00:00Z')))).toBe('2026-03-09T06:30:00.000Z')
  })

  it('takes the earlier instant when a local time happens twice', () => {
    // New York falls back on 2026-11-01; 01:30 occurs first as EDT (05:30Z).
    const rule = 'DTSTART;TZID=America/New_York:20261031T013000\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(rule, Date.parse('2026-10-31T12:00:00Z')))).toBe('2026-11-01T05:30:00.000Z')
  })

  it('keeps the wall clock fixed across a daylight-saving change', () => {
    const rule = 'DTSTART;TZID=America/New_York:20260306T090000\nRRULE:FREQ=DAILY'
    const before = nextRunOf(rule, Date.parse('2026-03-06T20:00:00Z'))
    const after = nextRunOf(rule, Date.parse('2026-03-07T20:00:00Z'))
    // 09:00 EST is 14:00Z; after the switch 09:00 EDT is 13:00Z.
    expect(iso(before)).toBe('2026-03-07T14:00:00.000Z')
    expect(iso(after)).toBe('2026-03-08T13:00:00.000Z')
  })

  it('reads a UTC rule without zone conversion', () => {
    const rule = 'DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-10T02:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
  })

  it('honours UNTIL as a UTC instant', () => {
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY;UNTIL=20261112T010000Z'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-10T12:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
    expect(nextRunOf(rule, Date.parse('2026-11-12T01:00:00Z'))).toBeUndefined()
  })

  it('reports the declared start as a real instant', () => {
    expect(iso(parseRule('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY').startsAt))
      .toBe('2026-11-10T01:00:00.000Z')
  })
})

describe('automation rule validation', () => {
  const bad = (rule: string): string => {
    try {
      parseRule(rule)
      return 'no error'
    } catch (error) {
      return error instanceof RuleError ? error.message : `wrong error: ${String(error)}`
    }
  }

  it('requires exactly one DTSTART and one RRULE line', () => {
    expect(bad('RRULE:FREQ=DAILY')).toContain('DTSTART')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY\nRRULE:FREQ=DAILY')).toContain('DTSTART')
  })

  it('rejects an unknown zone and a missing local time', () => {
    expect(bad('DTSTART;TZID=Mars/Olympus:20261110T010000\nRRULE:FREQ=DAILY')).toContain('time zone')
    // 02:30 does not exist in New York on 2026-03-08.
    expect(bad('DTSTART;TZID=America/New_York:20260308T023000\nRRULE:FREQ=DAILY')).toContain('does not exist')
  })

  it('rejects unsupported frequencies and BY combinations', () => {
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=SECONDLY')).toContain('SECONDLY')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=HOURLY;BYMINUTE=5')).toContain('BYMINUTE')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=WEEKLY;BYMONTHDAY=1')).toContain('BYMONTHDAY')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=WEEKLY;BYDAY=2MO')).toContain('ordinal BYDAY')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY;BYSECOND=1,2')).toContain('BYSECOND')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY;COUNT=1001')).toContain('1000')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY;UNTIL=20261231T000000')).toContain('UNTIL')
  })

  it('accepts the shapes the editor produces', () => {
    for (const rule of [
      'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY',
      'DTSTART;TZID=Asia/Shanghai:20261110T001500\nRRULE:FREQ=HOURLY;INTERVAL=2',
      'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      'DTSTART;TZID=Asia/Shanghai:20261110T000000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31',
      'DTSTART:20261110T010000Z\nRRULE:FREQ=MONTHLY;BYDAY=2TU',
    ]) {
      expect(() => parseRule(rule)).not.toThrow()
    }
  })
})
describe('automation recurrence long-lived rules', () => {
  it('keeps firing for a rule anchored long before now', () => {
    // A daily rule created 400 days ago still has a future occurrence.
    const daily = 'DTSTART;TZID=Asia/Shanghai:20250101T090000\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(daily, Date.parse('2026-11-10T12:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
    // A minutely rule anchored hours ago must not be mistaken for exhausted.
    const minutely = 'DTSTART;TZID=Asia/Shanghai:20261110T000000\nRRULE:FREQ=MINUTELY;INTERVAL=15'
    expect(iso(nextRunOf(minutely, Date.parse('2026-11-10T12:00:00Z')))).toBe('2026-11-10T12:15:00.000Z')
  })
})
