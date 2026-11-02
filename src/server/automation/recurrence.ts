/**
 * Calendar-aligned automation recurrence.
 *
 * An automation that repeats every N minutes drifts away from the clock; one that
 * repeats "every day at 17:00" must not. This module turns a schedule into the next
 * due timestamp, in the machine's local time.
 *
 * The functions are pure: they take the reference timestamp and return a new one, so
 * the scheduler stays testable without a clock.
 */
import type { AutomationSchedule } from '../../shared/types.ts'
import { parseTimeOfDay } from '../../shared/automation-schedule.ts'

function atLocalTime(base: Date, hour: number, minute: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0)
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/**
 * The first timestamp strictly after `from` that matches the schedule.
 *
 * A monthly run on the 31st lands on the 30th in a shorter month and on the 28th
 * (or 29th) in February: the day is clamped to the month's length rather than
 * skipped, so a monthly task never silently misses a month.
 */
export function nextRunAt(schedule: AutomationSchedule, from: number): number {
  const { hour, minute } = parseTimeOfDay(schedule.timeOfDay)
  const base = new Date(from)
  switch (schedule.unit) {
    case 'hour': {
      // The minute part is the offset inside every hour.
      const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), minute, 0, 0)
      if (candidate.getTime() <= from) candidate.setHours(candidate.getHours() + 1)
      return candidate.getTime()
    }
    case 'day': {
      const candidate = atLocalTime(base, hour, minute)
      if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)
      return candidate.getTime()
    }
    case 'week': {
      const target = schedule.dayOfWeek ?? base.getDay()
      const candidate = atLocalTime(base, hour, minute)
      let delta = (target - candidate.getDay() + 7) % 7
      if (delta === 0 && candidate.getTime() <= from) delta = 7
      candidate.setDate(candidate.getDate() + delta)
      return candidate.getTime()
    }
    case 'month': {
      const wanted = Math.min(31, Math.max(1, schedule.dayOfMonth ?? 1))
      const candidate = new Date(base.getFullYear(), base.getMonth(), Math.min(wanted, daysInMonth(base.getFullYear(), base.getMonth())), hour, minute, 0, 0)
      if (candidate.getTime() <= from) {
        const month = base.getMonth() + 1
        const year = base.getFullYear() + Math.floor(month / 12)
        const normalizedMonth = month % 12
        return new Date(year, normalizedMonth, Math.min(wanted, daysInMonth(year, normalizedMonth)), hour, minute, 0, 0).getTime()
      }
      return candidate.getTime()
    }
  }
}
