/**
 * Automation timing: RRULE compile, decode and describe.
 *
 * Shared by the server (which validates a rule and schedules against it) and the
 * web client (which edits and describes it). Everything here is string-level and
 * runs without the recurrence engine, so the browser bundle stays free of it;
 * occurrence math lives in `src/server/automation/recurrence.ts`.
 *
 * A rule is exactly two lines, as in RFC 5545 practice:
 *
 *     DTSTART;TZID=Asia/Shanghai:20261110T090000
 *     RRULE:FREQ=DAILY
 *
 * `DTSTART` carries the task's wall clock (or a `Z` stamp for UTC), and the IANA
 * zone is the task's `timeZone`. Recurrence keeps the local clock fixed across
 * daylight-saving changes because the server advances the wall clock, not UTC.
 */

/** How a task repeats. `manual` never fires on its own. */
export type AutomationFrequency =
  | 'manual' | 'once' | 'minutes' | 'hourly' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'advanced'

/** The editable timing state shared by the create panel and inline edits. */
export interface TimingDraft {
  frequency: AutomationFrequency
  /** Positive integer as text, for the number inputs. */
  interval: string
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[]
  /** 1–31; used by `monthly`. */
  monthDay: number
  /** `YYYY-MM-DD` in `timeZone`; used by `once`. */
  date: string
  /** `HH:MM` in `timeZone`. */
  time: string
  /** IANA zone name. */
  timeZone: string
  /** Raw text for `advanced`; ignored otherwise. */
  rrule?: string
}

export const WEEKDAY_LABELS: readonly string[] = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAY_CODES: readonly string[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const CODE_TO_WEEKDAY: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

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

/** The machine's zone, used as the default for new tasks. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** True when the runtime knows the zone, so a stored rule cannot silently drift. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === 'UTC') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  partsFormatters.set(timeZone, formatter)
  return formatter
}

export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall clock an instant shows in `timeZone`. */
export function wallClockOf(instant: number, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant))
  const value = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0')
  return {
    year: value('year'), month: value('month'), day: value('day'),
    hour: value('hour'), minute: value('minute'), second: value('second'),
  }
}

/** `YYYY-MM-DD` for an instant in `timeZone`. */
export function dateInZone(instant: number, timeZone: string): string {
  const clock = wallClockOf(instant, timeZone)
  return `${String(clock.year).padStart(4, '0')}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`
}

function compactDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date.trim())
  return match === null ? '' : `${match[1]}${match[2]}${match[3]}`
}

function dtstartFor(date: string, time: string, timeZone: string): string {
  const compact = compactDate(date)
  const { hour, minute } = parseTimeOfDay(time)
  const stamp = `${compact}T${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}00`
  return timeZone === 'UTC' ? `DTSTART:${stamp}Z` : `DTSTART;TZID=${timeZone}:${stamp}`
}

function positiveInterval(value: string): number | undefined {
  const parsed = Number(value)
  return /^\d+$/u.test(value.trim()) && Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined
}

/** A new draft defaulting to a one-time run an hour from now, like DSH's editor. */
export function defaultTimingDraft(now: number, timeZone: string): TimingDraft {
  const later = new Date(now + 60 * 60 * 1000)
  const clock = wallClockOf(later.getTime(), timeZone)
  return {
    frequency: 'once',
    interval: '1',
    weekdays: [1],
    monthDay: clock.day,
    date: dateInZone(later.getTime(), timeZone),
    time: formatTimeOfDay(clock.hour * 60 + clock.minute),
    timeZone,
  }
}

/** Whether the draft can be submitted — mirrors what the server will accept. */
export function timingDraftValid(draft: TimingDraft, now: number): boolean {
  if (draft.frequency === 'manual') return true
  if (draft.frequency === 'advanced') return (draft.rrule ?? '').trim() !== ''
  if (positiveInterval(draft.interval) === undefined) return false
  if (draft.frequency === 'once') {
    const compact = compactDate(draft.date)
    if (compact === '') return false
    const { hour, minute } = parseTimeOfDay(draft.time)
    // A one-time run already in the past would end the task on creation.
    const wall = Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)), hour, minute)
    return wall > now - 24 * 60 * 60 * 1000
  }
  if (draft.frequency === 'weekly' || draft.frequency === 'weekdays') return draft.weekdays.length > 0
  if (draft.frequency === 'monthly') return Number.isInteger(draft.monthDay) && draft.monthDay >= 1 && draft.monthDay <= 31
  if (draft.frequency === 'daily' || draft.frequency === 'hourly') {
    return /^([01]\d|2[0-3]):[0-5]\d$/u.test(draft.time)
  }
  return true
}

/** Compile a draft into its two-line rule; `manual` has no rule at all. */
export function compileRule(draft: TimingDraft, now: number): string | undefined {
  const clock = wallClockOf(now, draft.timeZone)
  const today = `${String(clock.year).padStart(4, '0')}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`
  const interval = positiveInterval(draft.interval) ?? 1
  const intervalPart = interval > 1 ? `;INTERVAL=${interval}` : ''
  switch (draft.frequency) {
    case 'manual':
      return undefined
    case 'once':
      return `${dtstartFor(draft.date, draft.time, draft.timeZone)}\nRRULE:FREQ=DAILY;COUNT=1`
    case 'minutes':
      return `${dtstartFor(today, draft.time, draft.timeZone)}\nRRULE:FREQ=MINUTELY;INTERVAL=${interval}`
    case 'hourly':
      return `${dtstartFor(today, draft.time, draft.timeZone)}\nRRULE:FREQ=HOURLY${intervalPart}`
    case 'daily':
      return `${dtstartFor(today, draft.time, draft.timeZone)}\nRRULE:FREQ=DAILY${intervalPart}`
    case 'weekly':
    case 'weekdays': {
      const days = draft.frequency === 'weekdays' ? [1, 2, 3, 4, 5] : draft.weekdays
      const codes = [...new Set(days)].sort((left, right) => left - right).map(day => WEEKDAY_CODES[day])
      return `${dtstartFor(today, draft.time, draft.timeZone)}\nRRULE:FREQ=WEEKLY;BYDAY=${codes.join(',')}${intervalPart}`
    }
    case 'monthly':
      return `${dtstartFor(today, draft.time, draft.timeZone)}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=${draft.monthDay}${intervalPart}`
    case 'advanced':
      return (draft.rrule ?? '').trim()
  }
}

interface ParsedLines {
  zone: string
  date: string
  time: string
  rule: string
}

/** Split a two-line rule into its DTSTART and RRULE parts. */
export function splitRule(rrule: string): ParsedLines | undefined {
  const lines = rrule.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  if (lines.length !== 2) return undefined
  const startLine = lines.find(line => line.startsWith('DTSTART'))
  const ruleLine = lines.find(line => line.startsWith('RRULE:'))
  if (startLine === undefined || ruleLine === undefined) return undefined
  const anchor = /^DTSTART(?:;(TZID=)([^:]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(startLine)
  if (anchor === null) return undefined
  const [, tzidPrefix, tzid, year, month, day, hour, minute] = anchor as unknown as string[]
  const zone = tzidPrefix !== undefined ? (tzid as string) : 'UTC'
  return {
    zone,
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    rule: ruleLine.slice('RRULE:'.length),
  }
}

function ruleParts(rule: string): Map<string, string> {
  const parts = new Map<string, string>()
  for (const piece of rule.split(';')) {
    const [key, value] = piece.split('=')
    if (key !== undefined && value !== undefined) parts.set(key.toUpperCase(), value.toUpperCase())
  }
  return parts
}

/** Reverse a rule into the editor's draft; unknown shapes fall back to `advanced`. */
export function decodeRule(rrule: string): TimingDraft | undefined {
  const parsed = splitRule(rrule)
  if (parsed === undefined) return undefined
  const parts = ruleParts(parsed.rule)
  const interval = parts.get('INTERVAL')
  const base: TimingDraft = {
    frequency: 'advanced', interval: interval === undefined ? '1' : String(Number(interval)),
    weekdays: [1], monthDay: 1, date: parsed.date, time: parsed.time,
    timeZone: parsed.zone, rrule,
  }
  const frequency = parts.get('FREQ')
  const hasTimePart = parts.has('BYHOUR') || parts.has('BYMINUTE') || parts.has('BYSECOND')
  if (frequency === 'DAILY' && parts.get('COUNT') === '1' && parts.size === 2 && !hasTimePart) {
    return { ...base, frequency: 'once' }
  }
  if (frequency === 'MINUTELY' && !hasTimePart && parts.size <= 2) return { ...base, frequency: 'minutes' }
  if (frequency === 'HOURLY' && !hasTimePart && !parts.has('BYDAY') && !parts.has('BYMONTHDAY') && parts.size <= 2) {
    return { ...base, frequency: 'hourly' }
  }
  if (frequency === 'DAILY' && !hasTimePart && parts.size <= 2) return { ...base, frequency: 'daily' }
  if (frequency === 'WEEKLY' && !hasTimePart) {
    const byDay = parts.get('BYDAY')
    if (byDay === undefined) return undefined
    const days = byDay.split(',').map(code => CODE_TO_WEEKDAY[code]).filter((day): day is number => day !== undefined)
    if (days.length === 0) return base
    const weekdays = days.length === 5 && [1, 2, 3, 4, 5].every(day => days.includes(day))
    return { ...base, frequency: weekdays ? 'weekdays' : 'weekly', weekdays: days, ...(weekdays ? { weekdays: days } : {}) }
  }
  if (frequency === 'MONTHLY' && !hasTimePart && !parts.has('BYDAY')) {
    const monthDay = Number(parts.get('BYMONTHDAY'))
    if (Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31) return { ...base, frequency: 'monthly', monthDay }
  }
  return base
}

function intervalLabel(draft: TimingDraft): string {
  const interval = Number(draft.interval)
  return interval > 1 ? String(interval) : ''
}

/** 「每天」/「每 2 天」: the unit follows the count without doubling the 每. */
function perInterval(every: string, unit: string): string {
  return every === '' ? `每${unit}` : `每 ${every} ${unit}`
}

/** A short Chinese description for the list, e.g. 「每天 09:00」. */
export function describeRule(rrule: string | undefined): string {
  if (rrule === undefined || rrule.trim() === '') return '手动'
  const draft = decodeRule(rrule)
  if (draft === undefined) return '自定义规则'
  const every = intervalLabel(draft)
  switch (draft.frequency) {
    case 'manual': return '手动'
    case 'once': return `仅一次 ${draft.date.slice(5).replace('-', '/')} ${draft.time}`
    case 'minutes': return `每 ${draft.interval} 分钟`
    case 'hourly': return `${perInterval(every, '小时')} ${String(parseTimeOfDay(draft.time).minute).padStart(2, '0')} 分`
    case 'daily': return `${perInterval(every, '天')} ${draft.time}`
    case 'weekly': {
      const labels = [...new Set(draft.weekdays)].sort((left, right) => left - right).map(day => WEEKDAY_LABELS[day]).join('、')
      return `${perInterval(every, '周')}${labels} ${draft.time}`
    }
    case 'weekdays': return `${perInterval(every, '周')}一至周五 ${draft.time}`
    case 'monthly': return `${perInterval(every, '月')} ${draft.monthDay} 日 ${draft.time}`
    case 'advanced': return '自定义规则'
  }
}

/** One-line summary of the zone, used by the picker label. */
export function describeZone(timeZone: string): string {
  if (timeZone === systemTimeZone()) return `${timeZone}（系统）`
  return timeZone
}