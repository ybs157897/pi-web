import { describe, expect, it } from 'vitest'
import { nextRunOf, parseRule, RuleError } from '../src/server/automation/recurrence.ts'

/**
 * 自动化循环规则（RRULE）引擎测试。
 *
 * 覆盖 nextRunOf / parseRule 的关键契约：
 * - DAILY/HOURLY/WEEKLY/MONTHLY 各频率的触发时刻按 DTSTART 声明的挂钟时间锚定，且到期瞬间之后只找下一次；
 * - 缺失日（如 2 月没有 31 日）跳过而非钳制；COUNT 用尽后返回 undefined；
 * - 夏令时切换时保持挂钟时间固定：不存在的本地时间跳过、重复出现的本地时间取较早瞬间；
 * - UTC 规则不做时区换算；UNTIL 按 UTC 瞬间理解；
 * - 非法规则（缺 DTSTART、未知时区、不存在的本地时间、不支持的频率/BY 组合、COUNT 超限等）抛 RuleError。
 */

/** 把毫秒时间戳转为 ISO 字符串，undefined 原样透传，便于断言可读。 */
const iso = (value: number | undefined): string | undefined => value === undefined ? undefined : new Date(value).toISOString()

/** 循环引擎核心契约：各频率触发时刻、边界跳过、夏令时与终止条件。 */
describe('automation recurrence engine', () => {
  // 每日 17:00（上海）固定挂钟触发；恰好落在到期瞬间时必须向前推进，永不重复同一瞬间。
  it('fires every day at the chosen wall clock in a zone', () => {
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261102T170000\nRRULE:FREQ=DAILY'
    // 上海 18:00 即 UTC 10:00，因此下一次触发是当地次日的 17:00。
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T10:00:00Z')))).toBe('2026-11-03T09:00:00.000Z')
    // 恰好在到期时刻也向前推进，绝不返回同一瞬间。
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T09:00:00Z')))).toBe('2026-11-03T09:00:00.000Z')
  })

  // 每小时规则只取 DTSTART 中的分钟（00:30），当前时刻不足 30 分则本小时触发，已过则下一小时。
  it('fires every hour at the minute named by DTSTART', () => {
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261102T003000\nRRULE:FREQ=HOURLY'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T02:10:00Z')))).toBe('2026-11-02T02:30:00.000Z')
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T02:45:00Z')))).toBe('2026-11-02T03:30:00.000Z')
  })

  // 周规则只在 BYDAY 指定的星期触发：同一星期内时刻已过则等下一周。
  it('fires on the chosen weekday', () => {
    // 2026-11-02 是周一；请求上海周三 09:00。
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261102T090000\nRRULE:FREQ=WEEKLY;BYDAY=WE'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-02T00:00:00Z')))).toBe('2026-11-04T01:00:00.000Z')
    // 同一星期内时刻已过则等待下一周。
    expect(iso(nextRunOf(rule, Date.parse('2026-11-04T02:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
  })

  // BYMONTHDAY=31 遇到没有 31 日的月份（2/4 月）直接跳到下一个含 31 日的月份，不做钳制（如 2 月 28 日）。
  it('skips a month without the requested day instead of clamping', () => {
    const rule = 'DTSTART;TZID=UTC:20260131T000000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31'
    expect(iso(nextRunOf(rule, Date.parse('2026-02-01T00:00:00Z')))).toBe('2026-03-31T00:00:00.000Z')
    expect(iso(nextRunOf(rule, Date.parse('2026-04-01T00:00:00Z')))).toBe('2026-05-31T00:00:00.000Z')
  })

  // COUNT=1 的规则：DTSTART 当天还能触发唯一一次，用尽后返回 undefined 表示规则结束。
  it('ends a rule whose COUNT is exhausted', () => {
    const once = 'DTSTART;TZID=Asia/Shanghai:20261101T090000\nRRULE:FREQ=DAILY;COUNT=1'
    expect(nextRunOf(once, Date.parse('2026-11-01T00:00:00Z'))).toBe(Date.parse('2026-11-01T01:00:00Z'))
    expect(nextRunOf(once, Date.parse('2026-11-02T00:00:00Z'))).toBeUndefined()
  })

  // 纽约 2026-03-08 春季拨快，当日 02:30 不存在：跳过该日，下一次触发落在次日 02:30。
  it('skips a local time that daylight saving removes', () => {
    // 纽约在 2026-03-08 春季拨快；当天 02:30 不存在。
    const rule = 'DTSTART;TZID=America/New_York:20260307T023000\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(rule, Date.parse('2026-03-07T20:00:00Z')))).toBe('2026-03-09T06:30:00.000Z')
  })

  // 纽约 2026-11-01 秋季拨回，01:30 出现两次：取第一次（EDT，即 UTC 05:30）。
  it('takes the earlier instant when a local time happens twice', () => {
    // 纽约在 2026-11-01 秋季拨回；01:30 先以 EDT（05:30Z）出现一次。
    const rule = 'DTSTART;TZID=America/New_York:20261031T013000\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(rule, Date.parse('2026-10-31T12:00:00Z')))).toBe('2026-11-01T05:30:00.000Z')
  })

  // 跨夏令时切换保持挂钟 09:00 不变：切换前为 EST（14:00Z），切换后为 EDT（13:00Z）。
  it('keeps the wall clock fixed across a daylight-saving change', () => {
    const rule = 'DTSTART;TZID=America/New_York:20260306T090000\nRRULE:FREQ=DAILY'
    const before = nextRunOf(rule, Date.parse('2026-03-06T20:00:00Z'))
    const after = nextRunOf(rule, Date.parse('2026-03-07T20:00:00Z'))
    // 09:00 EST 即 14:00Z；切换后 09:00 EDT 即 13:00Z。
    expect(iso(before)).toBe('2026-03-07T14:00:00.000Z')
    expect(iso(after)).toBe('2026-03-08T13:00:00.000Z')
  })

  // UTC 规则（DTSTART 带 Z、无 TZID）按绝对时刻触发，不做任何时区换算。
  it('reads a UTC rule without zone conversion', () => {
    const rule = 'DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-10T02:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
  })

  // UNTIL 是 UTC 瞬间：最后一次触发恰在 UNTIL 时刻仍可发生，之后再无下一次。
  it('honours UNTIL as a UTC instant', () => {
    const rule = 'DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY;UNTIL=20261112T010000Z'
    expect(iso(nextRunOf(rule, Date.parse('2026-11-10T12:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
    expect(nextRunOf(rule, Date.parse('2026-11-12T01:00:00Z'))).toBeUndefined()
  })

  // parseRule 的 startsAt 必须把 DTSTART 的本地挂钟时间解析成真实 UTC 瞬间。
  it('reports the declared start as a real instant', () => {
    expect(iso(parseRule('DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY').startsAt))
      .toBe('2026-11-10T01:00:00.000Z')
  })
})

/** 规则校验契约：非法规则抛出带具体原因的 RuleError，编辑器产出的合法形态全部通过。 */
describe('automation rule validation', () => {
  /**
   * 尝试解析一条规则并返回错误信息。
   * @param rule 待校验的规则文本
   * @returns 解析成功返回 'no error'；RuleError 返回其 message；其他异常返回 'wrong error: ...'
   */
  const bad = (rule: string): string => {
    try {
      parseRule(rule)
      return 'no error'
    } catch (error) {
      return error instanceof RuleError ? error.message : `wrong error: ${String(error)}`
    }
  }

  // 规则文本必须恰好包含一行 DTSTART 与一行 RRULE：缺失或多条都不允许。
  it('requires exactly one DTSTART and one RRULE line', () => {
    expect(bad('RRULE:FREQ=DAILY')).toContain('DTSTART')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY\nRRULE:FREQ=DAILY')).toContain('DTSTART')
  })

  // 未知时区（TZID）与不存在的本地时间（夏令时空洞）都必须被拒绝。
  it('rejects an unknown zone and a missing local time', () => {
    expect(bad('DTSTART;TZID=Mars/Olympus:20261110T010000\nRRULE:FREQ=DAILY')).toContain('time zone')
    // 纽约 2026-03-08 当天 02:30 不存在。
    expect(bad('DTSTART;TZID=America/New_York:20260308T023000\nRRULE:FREQ=DAILY')).toContain('does not exist')
  })

  // 不支持的频率（SECONDLY）、不支持的 BY 组合、带序号的 BYDAY、COUNT>1000、无时区的 UNTIL 都必须报错。
  it('rejects unsupported frequencies and BY combinations', () => {
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=SECONDLY')).toContain('SECONDLY')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=HOURLY;BYMINUTE=5')).toContain('BYMINUTE')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=WEEKLY;BYMONTHDAY=1')).toContain('BYMONTHDAY')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=WEEKLY;BYDAY=2MO')).toContain('ordinal BYDAY')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY;BYSECOND=1,2')).toContain('BYSECOND')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY;COUNT=1001')).toContain('1000')
    expect(bad('DTSTART:20261110T010000Z\nRRULE:FREQ=DAILY;UNTIL=20261231T000000')).toContain('UNTIL')
  })

  // 编辑器能产出的五种规则形态（日/小时间隔/工作日/月内日期/UTC 序号月规则）必须全部合法。
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
/** 长生命周期规则契约：锚定时间远早于当前时刻的规则仍能正确算出下一次触发。 */
describe('automation recurrence long-lived rules', () => {
  // 锚定在 400 天前的每日规则仍有未来触发点；数小时前锚定的分钟级规则不会被误判为已用尽。
  it('keeps firing for a rule anchored long before now', () => {
    // 创建于 400 天前的每日规则仍有未来触发点。
    const daily = 'DTSTART;TZID=Asia/Shanghai:20250101T090000\nRRULE:FREQ=DAILY'
    expect(iso(nextRunOf(daily, Date.parse('2026-11-10T12:00:00Z')))).toBe('2026-11-11T01:00:00.000Z')
    // 数小时前锚定的分钟级规则不能被误判为已耗尽。
    const minutely = 'DTSTART;TZID=Asia/Shanghai:20261110T000000\nRRULE:FREQ=MINUTELY;INTERVAL=15'
    expect(iso(nextRunOf(minutely, Date.parse('2026-11-10T12:00:00Z')))).toBe('2026-11-10T12:15:00.000Z')
  })
})
