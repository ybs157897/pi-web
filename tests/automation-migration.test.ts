import { describe, expect, it } from 'vitest'
import { migrateAutomation } from '../src/server/runtime/automations.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const SHANGHAI = 'Asia/Shanghai'
/** `compileRule` 把旧规则锚定到的挂钟日期：上海时区的 2026-11-10。 */
const TODAY = '20261110'

/** 迁移测试共用的最小旧版自动化记录（id/名称/提示词/时间戳）。 */
const base = {
  id: 'automation-1',
  name: 'Legacy task',
  prompt: 'run it',
  createdAt: 1,
  updatedAt: 1,
}

/**
 * 旧版自动化记录迁移测试。
 *
 * 验证 migrateAutomation 把 legacy 字段（intervalMs / enabled / schedule）编译成
 * RRULE 规则的关键契约：
 * - 分钟间隔 → FREQ=MINUTELY；日/周/月/小时计划 → 对应 FREQ 与 BYDAY/BYMONTHDAY；
 * - DTSTART 用任务时区的当日挂钟零点（或计划时刻）锚定；
 * - 无任何规则的记录保持手动且 paused；enabled=false 仍编译规则但状态为 paused；
 * - 迁移必须幂等：对已迁移记录再次迁移结果不变。
 */
/** 旧版自动化迁移：legacy 字段到 RRULE 的映射、状态判定与幂等性。 */
describe('legacy automation migration', () => {
  // 旧版分钟间隔（30 分钟）迁移为 FREQ=MINUTELY;INTERVAL=30，并剥掉 intervalMs/enabled/schedule 三个 legacy 字段。
  it('turns a minute interval into a MINUTELY rule with the same interval', () => {
    const migrated = migrateAutomation({ ...base, timeZone: SHANGHAI, intervalMs: 30 * 60_000 }, NOW)
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T000000\nRRULE:FREQ=MINUTELY;INTERVAL=30`)
    expect(migrated.timeZone).toBe(SHANGHAI)
    expect(migrated.status).toBe('active')
    expect(migrated.target).toBe('new')
    expect(migrated).not.toHaveProperty('intervalMs')
    expect(migrated).not.toHaveProperty('enabled')
    expect(migrated).not.toHaveProperty('schedule')
  })

  // 日计划（17:00）迁移为 FREQ=DAILY，DTSTART 锚定到当日 17:00 的挂钟时刻。
  it('turns a daily calendar schedule into a DAILY rule at its clock time', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true, schedule: { unit: 'day', timeOfDay: '17:00' },
    }, NOW)
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T170000\nRRULE:FREQ=DAILY`)
    expect(migrated.status).toBe('active')
    expect(migrated).not.toHaveProperty('schedule')
  })

  // 周计划携带的 dayOfWeek 数字映射为 RRULE 的 BYDAY 缩写（3 → WE 周三）。
  it('turns a weekly calendar schedule into a WEEKLY rule on the chosen weekday', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true,
      schedule: { unit: 'week', timeOfDay: '09:30', dayOfWeek: 3 },
    }, NOW)
    // 3 表示周三。
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T093000\nRRULE:FREQ=WEEKLY;BYDAY=WE`)
  })

  // 月计划的 dayOfMonth 映射为 RRULE 的 BYMONTHDAY。
  it('turns a monthly calendar schedule into a MONTHLY rule on the chosen day', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true,
      schedule: { unit: 'month', timeOfDay: '08:00', dayOfMonth: 15 },
    }, NOW)
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T080000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15`)
  })

  // 小时计划取 timeOfDay 的分钟部分：07:15 → FREQ=HOURLY，DTSTART 锚定到 07:15。
  it('turns an hourly calendar schedule into an HOURLY rule at the chosen minute', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true, schedule: { unit: 'hour', timeOfDay: '07:15' },
    }, NOW)
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T071500\nRRULE:FREQ=HOURLY`)
  })

  // 完全没有规则的旧记录迁移后保持手动（rrule/timeZone 均为空）且状态为 paused。
  it('leaves a record with no rule at all manual and paused', () => {
    const migrated = migrateAutomation({ ...base }, NOW)
    expect(migrated.rrule).toBeUndefined()
    expect(migrated.status).toBe('paused')
    expect(migrated.target).toBe('new')
    expect(migrated.timeZone).toBeUndefined()
  })

  // enabled=false 的任务仍会编译出规则（便于后续启用），但状态保持 paused 不参与调度。
  it('keeps a disabled task paused while still compiling its rule', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: false, schedule: { unit: 'day', timeOfDay: '12:00' },
    }, NOW)
    expect(migrated.status).toBe('paused')
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T120000\nRRULE:FREQ=DAILY`)
  })

  // 迁移幂等：对已迁移记录（含规则记录与手动记录）再迁移一次，结果与第一次完全相同。
  it('is idempotent: migrating a migrated record returns it unchanged', () => {
    const first = migrateAutomation({ ...base, timeZone: SHANGHAI, intervalMs: 90 * 60_000 }, NOW)
    const second = migrateAutomation(first, NOW)
    expect(second).toEqual(first)
    expect(second.rrule).toBe(first.rrule)

    const manual = migrateAutomation({ ...base }, NOW)
    expect(migrateAutomation(manual, NOW)).toEqual(manual)
  })
})
