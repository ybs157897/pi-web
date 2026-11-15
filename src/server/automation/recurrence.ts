/**
 * 自动化重复规则：基于 `rrule` 的一个有界 RFC 5545 子集。
 *
 * 引擎按墙钟时间（wall clock）而非 UTC 对齐，因此"每天 09:00"的规则在夏令时
 * 切换后仍是当地 09:00。`rrule` 本身只认锚定 UTC 的日期，所以规则被当作
 * "伪 UTC"时钟迭代（把本地墙钟标注成 UTC），每个候选时刻再在此处换算回真实
 * 瞬间（instant）。生成的当地时刻若不存在（春令时跳变）则跳过；若因回拨出现
 * 两次（秋令时重叠）则取较早的瞬间。
 *
 * 接受的子集覆盖编辑器可产出的规则加合理的手写规则：一行 DTSTART、一行 RRULE、
 * 显式 IANA 时区、不支持 SECONDLY、BYSECOND 至多一个值、COUNT ≤ 1000、
 * MINUTELY/HOURLY 不带 BY 部分、BYMONTHDAY 与带序数的 BYDAY 仅限 MONTHLY/YEARLY、
 * BYYEARDAY/BYWEEKNO 仅限 YEARLY、UNTIL 必须是 UTC 瞬间。
 */
import rruleModule from 'rrule'
import { isValidTimeZone, splitRule, wallClockOf } from '../../shared/automation-timing.ts'

const { RRule } = rruleModule as unknown as typeof import('rrule')

const FREQUENCIES = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
const BY_PARTS = ['BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS']
const BYDAY_ORDINAL = /[+-]?\d/u

/** 规则校验失败时抛出的错误；message 直接面向模型展示。 */
export class RuleError extends Error {}

/** 已解析并编译好的重复规则。 */
export interface ParsedRule {
  /** 两行规则原文（DTSTART + RRULE），仅做空白归一化。 */
  text: string
  timeZone: string
  /** 规则声明的首次发生时刻，换算为真实 UTC 瞬间（毫秒时间戳）。 */
  startsAt: number
  /** 内部迭代状态，供 nextOccurrence 复用，勿手改。 */
  compiled: CompiledRule
}

interface CompiledRule {
  timeZone: string
  rule: InstanceType<typeof RRule>
}

/** 数字补零到指定宽度（默认 2 位），用于拼 iCalendar 时间戳。 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** 把伪 UTC 墙钟毫秒（Date.UTC 标注的本地时间）格式化为 iCalendar 的 YYYYMMDDTHHMMSS 形式。 */
function stampOf(wallMs: number): string {
  const date = new Date(wallMs)
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

/** 把真实瞬间换算成该时区的墙钟，再以伪 UTC 毫秒表示（供 rrule 迭代用）。 */
function wallOfInstant(instant: number, timeZone: string): number {
  if (timeZone === 'UTC') return Math.floor(instant / 1000) * 1000
  const clock = wallClockOf(instant, timeZone)
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second)
}

/** 该时区在指定瞬间对 UTC 的偏移毫秒数（伪 UTC 墙钟减真实瞬间）。 */
function zoneOffsetMs(timeZone: string, instant: number): number {
  if (timeZone === 'UTC') return 0
  return wallOfInstant(instant, timeZone) - Math.floor(instant / 1000) * 1000
}

/**
 * 功能：把伪 UTC 墙钟换算回该时区下的真实瞬间；当地时刻不存在时返回 `undefined`。
 * 内部逻辑：两次迭代收敛时区偏移得到候选瞬间，逐个验证其墙钟是否等于目标；
 * 回拨导致的歧义墙钟（出现两次）取较早的瞬间；全部候选无效说明该墙钟不存在（春令时跳变）。
 */
function wallToInstant(wallMs: number, timeZone: string): number | undefined {
  if (timeZone === 'UTC') return wallMs
  const first = wallMs - zoneOffsetMs(timeZone, wallMs)
  const second = wallMs - zoneOffsetMs(timeZone, first)
  const candidates = [first, second].filter(value => wallOfInstant(value, timeZone) === wallMs)
  if (candidates.length === 0) return undefined
  // An ambiguous wall clock (fall back) happens twice; take the earlier instant.
  return Math.min(...candidates)
}

/** 把 DTSTART 的日期（YYYY-MM-DD）与时间（HH:MM）拼成伪 UTC 墙钟毫秒，秒固定为 0。 */
function wallOfDateTime(date: string, time: string): number {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(3, 5))
  return Date.UTC(year, month - 1, day, hour, minute, 0)
}

/** 把 RRULE 参数串按 `;` 拆成 键→值 的 Map；键值均转大写，无 `=` 或键为空的片段跳过。 */
function ruleParts(rule: string): Map<string, string> {
  const parts = new Map<string, string>()
  for (const piece of rule.split(';')) {
    const index = piece.indexOf('=')
    if (index <= 0) continue
    parts.set(piece.slice(0, index).toUpperCase(), piece.slice(index + 1).toUpperCase())
  }
  return parts
}

/** 把 UNTIL 的 UTC 瞬间改写为规则迭代所用的伪 UTC 墙钟；时区为 UTC 或无 UNTIL 时原样返回。 */
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

/**
 * 功能：校验 RRULE 是否落在受支持的有界子集内，越界即抛 `RuleError`。
 * 内部逻辑（校验顺序）：FREQ 必填且禁止 SECONDLY → BYSECOND 至多一个值 →
 * COUNT 为正整数且 ≤ 1000（更长用 UNTIL）→ UNTIL 必须以 Z 结尾的 UTC 瞬间 →
 * MINUTELY/HOURLY 禁带任何 BY 部分 → 带序数的 BYDAY 仅限 MONTHLY/YEARLY 且不得
 * 与 BYWEEKNO 同用 → BYMONTHDAY 仅限 MONTHLY/YEARLY → BYYEARDAY/BYWEEKNO 仅限 YEARLY。
 */
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

/**
 * 功能：校验并编译两行规则（DTSTART + RRULE），供后续 nextOccurrence 反复求值。
 * @param text 规则文本，格式为「DTSTART:YYYYMMDDTHHMMSS / RRULE:... / TZ=时区」
 * @returns ParsedRule，含归一化原文、时区、首发生瞬间与编译好的 rrule 实例
 * 内部逻辑：先经 splitRule 拆行并校验时区与日期时间格式；DTSTART 墙钟必须在该
 * 时区真实存在（否则 RuleError）；再经 assertSubset 限制 RRULE 子集；DTSTART 墙钟
 * 与改写过的 UNTIL 都标注为伪 UTC 后交给 RRule.fromString 编译。
 */
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

/**
 * 功能：求规则在 `from` 之后（严格大于）的下一次发生时刻，供调度器推进游标。
 * @param parsed 已编译规则（parseRule 的返回值）
 * @param from 当前游标：真实 UTC 瞬间（毫秒），从此刻之后找下一次发生
 * @returns 下一次发生的真实瞬间毫秒数；规则已穷尽或找不到有效时刻时返回 undefined
 * 内部逻辑：游标从 `from`（而非 DTSTART）起算，避免老规则回放大量历史发生点；
 * rrule 产出候选后逐个换算回真实瞬间——墙钟不存在的候选（春令时跳变）跳过，
 * 换算后不晚于 `from` 的候选继续向后走；至多试探 64 个候选防死循环。
 */
export function nextOccurrence(parsed: ParsedRule, from: number): number | undefined {
  const { timeZone, rule } = parsed.compiled
  // 从 `from` 而非 DTSTART 起算：锚定在很久以前的规则，其历史发生点远多于
  // 下面循环需要遍历的数量。
  let cursor = new Date(wallOfInstant(from, timeZone) - 1000)
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = rule.after(cursor, false)
    if (candidate === null) return undefined
    const instant = wallToInstant(candidate.getTime(), timeZone)
    if (instant !== undefined && instant > from) return instant
    // 生成的当地时刻若不存在（春令时跳变）则跳过，而不是提前投递。
    cursor = candidate
  }
  return undefined
}

/** 便捷入口：一步完成解析与下一次发生计算；规则非法时抛 `RuleError`。 */
export function nextRunOf(text: string, from: number): number | undefined {
  return nextOccurrence(parseRule(text), from)
}