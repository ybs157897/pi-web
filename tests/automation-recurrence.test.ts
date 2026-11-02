import { describe, expect, it } from 'vitest'
import { nextRunAt } from '../src/server/automation/recurrence.ts'
import { describeSchedule, parseTimeOfDay, formatTimeOfDay } from '../src/shared/automation-schedule.ts'

/** A local timestamp, so the assertions do not depend on the machine's timezone. */
const at = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime()

const read = (value: number): { day: number; hour: number; minute: number } => {
  const date = new Date(value)
  return { day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() }
}

describe('automation recurrence', () => {
  it('fires every day at the chosen local time', () => {
    const schedule = { unit: 'day' as const, timeOfDay: '17:00' }
    expect(read(nextRunAt(schedule, at(2026, 11, 2, 10, 0)))).toEqual({ day: 2, hour: 17, minute: 0 })
    expect(read(nextRunAt(schedule, at(2026, 11, 2, 18, 0)))).toEqual({ day: 3, hour: 17, minute: 0 })
    // Exactly on the due time moves to the next day, never to the same instant.
    expect(read(nextRunAt(schedule, at(2026, 11, 2, 17, 0)))).toEqual({ day: 3, hour: 17, minute: 0 })
  })

  it('fires every hour at the chosen minute', () => {
    const schedule = { unit: 'hour' as const, timeOfDay: '00:30' }
    expect(read(nextRunAt(schedule, at(2026, 11, 2, 10, 10)))).toEqual({ day: 2, hour: 10, minute: 30 })
    expect(read(nextRunAt(schedule, at(2026, 11, 2, 10, 45)))).toEqual({ day: 2, hour: 11, minute: 30 })
  })

  it('fires on the chosen weekday', () => {
    // 2026-11-02 is a Monday; ask for Wednesday 09:00.
    const schedule = { unit: 'week' as const, timeOfDay: '09:00', dayOfWeek: 3 }
    expect(read(nextRunAt(schedule, at(2026, 11, 2, 8, 0)))).toEqual({ day: 4, hour: 9, minute: 0 })
    // Later on the same weekday waits for the next week.
    expect(read(nextRunAt(schedule, at(2026, 11, 4, 10, 0)))).toEqual({ day: 11, hour: 9, minute: 0 })
  })

  it('clamps a monthly run to the length of the month instead of skipping it', () => {
    const schedule = { unit: 'month' as const, timeOfDay: '00:00', dayOfMonth: 31 }
    expect(read(nextRunAt(schedule, at(2026, 1, 1)))).toEqual({ day: 31, hour: 0, minute: 0 })
    // February 2026 has 28 days, so the 31st lands on the 28th.
    const february = nextRunAt(schedule, at(2026, 2, 1))
    expect(read(february)).toEqual({ day: 28, hour: 0, minute: 0 })
    const date = new Date(february)
    expect(date.getMonth()).toBe(1)
  })

  it('reads a malformed time as midnight and formats minutes back', () => {
    expect(parseTimeOfDay('17:00')).toEqual({ hour: 17, minute: 0 })
    expect(parseTimeOfDay('nonsense')).toEqual({ hour: 0, minute: 0 })
    expect(parseTimeOfDay('99:99')).toEqual({ hour: 23, minute: 59 })
    expect(formatTimeOfDay(17 * 60)).toBe('17:00')
    expect(formatTimeOfDay(0)).toBe('00:00')
  })

  it('describes a schedule for the task list', () => {
    expect(describeSchedule({ unit: 'day', timeOfDay: '17:00' })).toBe('每天 17:00')
    expect(describeSchedule({ unit: 'week', timeOfDay: '09:00', dayOfWeek: 1 })).toBe('每一 09:00')
    expect(describeSchedule({ unit: 'month', timeOfDay: '00:00', dayOfMonth: 31 })).toBe('每月 31 日 00:00')
  })
})
