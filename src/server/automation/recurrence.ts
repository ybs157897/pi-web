/**
 * Automation recurrence: a bounded RFC 5545 subset on top of `rrule`.
 *
 * The engine works on wall-clock time, not UTC, so a rule written for 09:00
 * keeps 09:00 across daylight-saving changes. `rrule` itself only understands
 * UTC-anchored dates, so a rule is iterated as a "pseudo-UTC" clock (the local
 * wall clock labelled as UTC) and every candidate is converted back to a real
 * instant here. Generated local times that do not exist are skipped; one that
 * happens twice resolves to the earlier instant.
 *
 * The accepted subset mirrors what the editor can produce plus reasonable
 * hand-authored rules: one DTSTART line, one RRULE line, an explicit IANA zone,
 * no SECONDLY, at most one BYSECOND value, COUNT ≤ 1000, no BY parts on
 * MINUTELY/HOURLY, BYMONTHDAY or ordinal BYDAY only on MONTHLY/YEARLY,
 * BYYEARDAY/BYWEEKNO only on YEARLY, and UNTIL as a UTC instant.
 */
import rruleModule from 'rrule'
import { isValidTimeZone, splitRule, wallClockOf } from '../../shared/automation-timing.ts'

const { RRule } = rruleModule as unknown as typeof import('rrule')

const FREQUENCIES = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
const BY_PARTS = ['BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS']
const BYDAY_ORDINAL = /[+-]?\d/u

/** A rule that failed validation; the message is model-facing. */
export class RuleError extends Error {}

export interface ParsedRule {
  /** The two-line text, whitespace-normalized. */
  text: string
  timeZone: string
  /** The first occurrence the rule declares, as a real UTC instant. */
  startsAt: number
  /** Internal iteration state. */
  compiled: CompiledRule
}

interface CompiledRule {
  timeZone: string
  rule: InstanceType<typeof RRule>
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function stampOf(wallMs: number): string {
  const date = new Date(wallMs)
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

function wallOfInstant(instant: number, timeZone: string): number {
  if (timeZone === 'UTC') return Math.floor(instant / 1000) * 1000
  const clock = wallClockOf(instant, timeZone)
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second)
}

function zoneOffsetMs(timeZone: string, instant: number): number {
  if (timeZone === 'UTC') return 0
  return wallOfInstant(instant, timeZone) - Math.floor(instant / 1000) * 1000
}

/** The instant a wall clock names in the zone; `undefined` when that local time does not exist. */
function wallToInstant(wallMs: number, timeZone: string): number | undefined {
  if (timeZone === 'UTC') return wallMs
  const first = wallMs - zoneOffsetMs(timeZone, wallMs)
  const second = wallMs - zoneOffsetMs(timeZone, first)
  const candidates = [first, second].filter(value => wallOfInstant(value, timeZone) === wallMs)
  if (candidates.length === 0) return undefined
  // An ambiguous wall clock (fall back) happens twice; take the earlier instant.
  return Math.min(...candidates)
}

function wallOfDateTime(date: string, time: string): number {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(3, 5))
  return Date.UTC(year, month - 1, day, hour, minute, 0)
}

function ruleParts(rule: string): Map<string, string> {
  const parts = new Map<string, string>()
  for (const piece of rule.split(';')) {
    const index = piece.indexOf('=')
    if (index <= 0) continue
    parts.set(piece.slice(0, index).toUpperCase(), piece.slice(index + 1).toUpperCase())
  }
  return parts
}

/** Rewrite a UTC UNTIL into the pseudo-UTC clock the rule iterates on. */
function pseudoRule(rule: string, timeZone: string): string {
  return rule.replace(/UNTIL=(\d{8}T\d{6})Z/iu, (whole, value: string) => {
    if (timeZone === 'UTC') return whole
    const instant = Date.UTC(
      Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)),
      Number(value.slice(9, 11)), Number(value.slice(11, 13)), Number(value.slice(13, 15)),
    )
    return `UNTIL=${stampOf(wallOfInstant(instant, timeZone))}Z`
  })
}

function assertSubset(rule: string): void {
  const parts = ruleParts(rule)
  const frequency = parts.get('FREQ')
  if (frequency === undefined || !FREQUENCIES.has(frequency)) throw new RuleError('RRULE must name a FREQ of DAILY, WEEKLY, MONTHLY, YEARLY, HOURLY or MINUTELY.')
  if (frequency === 'SECONDLY') throw new RuleError('SECONDLY is not supported.')
  const bySecond = parts.get('BYSECOND')
  if (bySecond !== undefined && bySecond.split(',').length > 1) throw new RuleError('BYSECOND accepts at most one value.')
  const count = parts.get('COUNT')
  if (count !== undefined) {
    if (!/^\d+$/u.test(count) || Number(count) < 1) throw new RuleError('COUNT must be a positive integer.')
    if (Number(count) > 1000) throw new RuleError('COUNT is at most 1000; use UNTIL for longer rules.')
  }
  const until = parts.get('UNTIL')
  if (until !== undefined && !/^\d{8}T\d{6}Z$/u.test(until)) throw new RuleError('UNTIL must be a UTC instant ending in Z.')
  if (frequency === 'MINUTELY' || frequency === 'HOURLY') {
    const offending = BY_PARTS.find(part => parts.has(part))
    if (offending !== undefined) throw new RuleError(`${offending} is not supported with ${frequency}; set the clock time in DTSTART instead.`)
  }
  const byDay = parts.get('BYDAY')
  if (byDay !== undefined) {
    const values = byDay.split(',')
    const ordinal = values.some(value => BYDAY_ORDINAL.test(value))
    if (ordinal && frequency !== 'MONTHLY' && frequency !== 'YEARLY') throw new RuleError('An ordinal BYDAY requires MONTHLY or YEARLY.')
    if (ordinal && parts.has('BYWEEKNO')) throw new RuleError('An ordinal BYDAY cannot be combined with BYWEEKNO.')
  }
  const byMonthDay = parts.get('BYMONTHDAY')
  if (byMonthDay !== undefined && frequency !== 'MONTHLY' && frequency !== 'YEARLY') throw new RuleError('BYMONTHDAY requires MONTHLY or YEARLY.')
  if (parts.has('BYYEARDAY') && frequency !== 'YEARLY') throw new RuleError('BYYEARDAY requires YEARLY.')
  if (parts.has('BYWEEKNO') && frequency !== 'YEARLY') throw new RuleError('BYWEEKNO requires YEARLY.')
}

/** Validate and compile a two-line rule. Throws `RuleError` with a model-facing message. */
export function parseRule(text: string): ParsedRule {
  const parsed = splitRule(text)
  if (parsed === undefined) throw new RuleError('A rule is one DTSTART line followed by one RRULE line.')
  if (!isValidTimeZone(parsed.zone)) throw new RuleError(`Unknown time zone: ${parsed.zone}.`)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(parsed.date) || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(parsed.time)) {
    throw new RuleError('DTSTART must use YYYYMMDDTHHMMSS.')
  }
  const startWall = wallOfDateTime(parsed.date, parsed.time)
  const startsAt = wallToInstant(startWall, parsed.zone)
  if (startsAt === undefined) throw new RuleError('DTSTART names a local time that does not exist in that zone.')
  assertSubset(parsed.rule)
  const rule = RRule.fromString(`DTSTART:${stampOf(startWall)}Z\nRRULE:${pseudoRule(parsed.rule, parsed.zone)}`)
  return { text, timeZone: parsed.zone, startsAt, compiled: { timeZone: parsed.zone, rule } }
}

/** True when the rule still has an occurrence strictly after `from`. */
export function nextOccurrence(parsed: ParsedRule, from: number): number | undefined {
  const { timeZone, rule } = parsed.compiled
  // Start from `from`, not from DTSTART: a rule anchored long ago has more past
  // occurrences than the loop below will ever need to walk.
  let cursor = new Date(wallOfInstant(from, timeZone) - 1000)
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = rule.after(cursor, false)
    if (candidate === null) return undefined
    const instant = wallToInstant(candidate.getTime(), timeZone)
    if (instant !== undefined && instant > from) return instant
    // A generated local time that does not exist is skipped rather than delivered early.
    cursor = candidate
  }
  return undefined
}

/** Convenience: validate and compute in one call. Throws `RuleError` on a bad rule. */
export function nextRunOf(text: string, from: number): number | undefined {
  return nextOccurrence(parseRule(text), from)
}