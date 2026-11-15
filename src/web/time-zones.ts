/**
 * 自动化编辑器的时区选择模型。
 *
 * 列表以本机时区打头，其余按当前 UTC 偏移排序让邻近时区相邻；
 * 最近 5 次选择记在 localStorage。
 */

export interface ZoneOption {
  id: string
  label: string
  /** 当前偏移（分钟），用于排序。 */
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

/**
 * 功能：生成一个时区的展示标签，格式与编辑器行一致。
 * @returns 形如 `UTC+08:00 · 中国标准时间（系统）`；本机时区加「（系统）」后缀
 */
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

/**
 * 功能：读最近使用过的时区列表（localStorage 持久化）。
 * @returns 字符串数组；存储损坏或不可用时返回空数组
 */
export function recentZones(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

/**
 * 功能：把一个时区记为最近使用（去重后置顶，超出 5 个截断）。
 * @param timeZone 时区 id；存储被禁用时静默忽略，选择器照常工作
 */
export function rememberZone(timeZone: string): void {
  try {
    const next = [timeZone, ...recentZones().filter(value => value !== timeZone)].slice(0, RECENT_LIMIT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // 存储被禁用时列表保持不变，选择器仍然可用。
  }
}

/**
 * 功能：生成完整时区选项列表：本机时区与最近使用打头（保持记忆顺序），其余按
 * 当前 UTC 偏移升序、偏移相同按 id 字典序。
 * @param now 计算偏移与名称的时间点，默认当前
 * @returns ZoneOption 数组
 */
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
/**
 * 功能：把某个时刻格式化为任务所属时区的本地时间。
 * @param instant 时刻（epoch 毫秒）
 * @param timeZone 目标时区；undefined 时用运行环境的默认时区
 * @param locale UI 语言（'zh' / 其他按 en-US 处理）
 * @returns 形如 `2026/11/10 20:23` 的字符串；时区名非法时回落默认时区
 */
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
