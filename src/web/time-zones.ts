/**
 * Time-zone choices for the automation editor.
 *
 * The machine's zone leads the list, the rest follow by current UTC offset so
 * nearby zones sit together, and the last five picks are remembered locally.
 */

export interface ZoneOption {
  id: string
  label: string
  /** Current offset in minutes, used for ordering. */
  offset: number
}

const RECENT_KEY = 'pi-web.automation.recent-time-zones'
const RECENT_LIMIT = 5

function offsetMinutes(timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(now))
  const value = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0')
  const wall = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
  return Math.round((wall - Math.floor(now / 1000) * 1000) / 60_000)
}

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

function zoneName(timeZone: string, now: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, timeZoneName: 'long' }).formatToParts(new Date(now))
  return parts.find(part => part.type === 'timeZoneName')?.value ?? timeZone
}

/** `UTC+08:00 · 中国标准时间（系统）`, matching the editor row. */
export function zoneLabel(timeZone: string, now = Date.now()): string {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${offsetLabel(offsetMinutes(timeZone, now))} · ${zoneName(timeZone, now)}${timeZone === system ? '（系统）' : ''}`
}

function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  const supported = intl.supportedValuesOf?.('timeZone') ?? []
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = new Set<string>(supported)
  zones.add('UTC')
  if (system !== '') zones.add(system)
  return [...zones]
}

export function recentZones(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function rememberZone(timeZone: string): void {
  try {
    const next = [timeZone, ...recentZones().filter(value => value !== timeZone)].slice(0, RECENT_LIMIT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // A disabled storage keeps the list static; the picker still works.
  }
}

/** Every zone, the machine's first and the recently used ones next, ordered by offset. */
export function zoneOptions(now = Date.now()): ZoneOption[] {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone
  const recent = recentZones().filter(zone => zone !== system)
  const rest = allZones().filter(zone => zone !== system && !recent.includes(zone))
  const render = (timeZone: string): ZoneOption => ({
    id: timeZone, label: zoneLabel(timeZone, now), offset: offsetMinutes(timeZone, now),
  })
  const pinned = [system, ...recent].filter(zone => zone !== '').map(render)
  const ordered = rest.map(render).sort((left, right) => left.offset - right.offset || left.id.localeCompare(right.id))
  return [...pinned, ...ordered]
}
/** `2026/11/10 20:23` for an instant in the task's own zone. */
export function formatInZone(instant: number, timeZone: string | undefined, locale: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      ...options, ...(timeZone === undefined ? {} : { timeZone }),
    }).format(instant)
  } catch {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', options).format(instant)
  }
}
