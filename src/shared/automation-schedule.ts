/**
 * Schedule helpers shared by the server (which schedules) and the web client
 * (which describes a schedule to the operator).
 */
import type { AutomationSchedule } from './types.ts'

/** "HH:MM" → hours and minutes; anything malformed reads as midnight. */
export function parseTimeOfDay(value: string | undefined): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value?.trim() ?? '')
  if (match === null) return { hour: 0, minute: 0 }
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute }
}

/** Minutes past midnight → "HH:MM". */
export function formatTimeOfDay(minutes: number): string {
  const clamped = Math.min(24 * 60 - 1, Math.max(0, Math.round(minutes)))
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

export const WEEKDAY_LABELS: readonly string[] = ['日', '一', '二', '三', '四', '五', '六']

/** A short Chinese description of the schedule, for the task list. */
export function describeSchedule(schedule: AutomationSchedule): string {
  const time = parseTimeOfDay(schedule.timeOfDay)
  const clock = `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
  switch (schedule.unit) {
    case 'hour': return `每小时 ${String(time.minute).padStart(2, '0')} 分`
    case 'day': return `每天 ${clock}`
    case 'week': return `每${WEEKDAY_LABELS[schedule.dayOfWeek ?? 0]} ${clock}`
    case 'month': return `每月 ${schedule.dayOfMonth ?? 1} 日 ${clock}`
  }
}
