import { describe, expect, it } from 'vitest'
import { migrateAutomation } from '../src/server/runtime/automations.ts'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const SHANGHAI = 'Asia/Shanghai'
/** The wall clock `compileRule` anchors a legacy rule to: 2026-11-10 in Shanghai. */
const TODAY = '20261110'

const base = {
  id: 'automation-1',
  name: 'Legacy task',
  prompt: 'run it',
  createdAt: 1,
  updatedAt: 1,
}

describe('legacy automation migration', () => {
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

  it('turns a daily calendar schedule into a DAILY rule at its clock time', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true, schedule: { unit: 'day', timeOfDay: '17:00' },
    }, NOW)
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T170000\nRRULE:FREQ=DAILY`)
    expect(migrated.status).toBe('active')
    expect(migrated).not.toHaveProperty('schedule')
  })

  it('turns a weekly calendar schedule into a WEEKLY rule on the chosen weekday', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true,
      schedule: { unit: 'week', timeOfDay: '09:30', dayOfWeek: 3 },
    }, NOW)
    // 3 is Wednesday.
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T093000\nRRULE:FREQ=WEEKLY;BYDAY=WE`)
  })

  it('turns a monthly calendar schedule into a MONTHLY rule on the chosen day', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true,
      schedule: { unit: 'month', timeOfDay: '08:00', dayOfMonth: 15 },
    }, NOW)
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T080000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15`)
  })

  it('turns an hourly calendar schedule into an HOURLY rule at the chosen minute', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: true, schedule: { unit: 'hour', timeOfDay: '07:15' },
    }, NOW)
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T071500\nRRULE:FREQ=HOURLY`)
  })

  it('leaves a record with no rule at all manual and paused', () => {
    const migrated = migrateAutomation({ ...base }, NOW)
    expect(migrated.rrule).toBeUndefined()
    expect(migrated.status).toBe('paused')
    expect(migrated.target).toBe('new')
    expect(migrated.timeZone).toBeUndefined()
  })

  it('keeps a disabled task paused while still compiling its rule', () => {
    const migrated = migrateAutomation({
      ...base, timeZone: SHANGHAI, enabled: false, schedule: { unit: 'day', timeOfDay: '12:00' },
    }, NOW)
    expect(migrated.status).toBe('paused')
    expect(migrated.rrule).toBe(`DTSTART;TZID=${SHANGHAI}:${TODAY}T120000\nRRULE:FREQ=DAILY`)
  })

  it('is idempotent: migrating a migrated record returns it unchanged', () => {
    const first = migrateAutomation({ ...base, timeZone: SHANGHAI, intervalMs: 90 * 60_000 }, NOW)
    const second = migrateAutomation(first, NOW)
    expect(second).toEqual(first)
    expect(second.rrule).toBe(first.rrule)

    const manual = migrateAutomation({ ...base }, NOW)
    expect(migrateAutomation(manual, NOW)).toEqual(manual)
  })
})