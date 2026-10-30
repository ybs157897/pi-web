import type { WetrackDefectItem } from '../shared/types.ts'

export interface WetrackProjectGroup {
  key: string
  label: string
  items: WetrackDefectItem[]
}

const UNCATEGORIZED = '未分类'

function text(value: string | number | boolean | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Group by project number when present; name-only rows still get their own stable bucket. */
export function projectKeyOf(item: WetrackDefectItem): string {
  const number = text(item.projectNumber)
  if (number !== '') return number
  const name = text(item.projectName)
  return name !== '' ? `name:${name}` : 'none'
}

export function projectLabelOf(item: WetrackDefectItem): string {
  const name = text(item.projectName)
  if (name !== '') return name
  const number = text(item.projectNumber)
  return number !== '' ? number : UNCATEGORIZED
}

/** Insertion order follows the CLI, so the tab strip stays stable between refreshes. */
export function groupDefectsByProject(items: readonly WetrackDefectItem[]): WetrackProjectGroup[] {
  const groups = new Map<string, WetrackProjectGroup>()
  for (const item of items) {
    const key = projectKeyOf(item)
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { key, label: projectLabelOf(item), items: [item] })
    else existing.items.push(item)
  }
  return [...groups.values()]
}

const FILTER_FIELDS = ['defectNumber', 'simpleDesc', 'defectStatusName', 'severityName', 'projectName', 'projectNumber', 'creatorName'] as const

/** Whitespace-separated terms must all match about any visible column, case-insensitively. */
export function filterDefects(items: readonly WetrackDefectItem[], query: string): WetrackDefectItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(term => term !== '')
  if (terms.length === 0) return [...items]
  return items.filter(item => {
    const haystack = FILTER_FIELDS.map(field => text(item[field])).join('\n').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

export type TagTone = 'red' | 'volcano' | 'gold' | 'blue' | 'cyan' | 'green' | 'default'

const SEVERITY_TONES: ReadonlyArray<readonly [RegExp, TagTone]> = [
  [/致命|阻塞|blocker|critical|fatal/iu, 'red'],
  [/严重|major|high/iu, 'volcano'],
  [/一般|normal|medium/iu, 'blue'],
  [/轻微|minor|low|trivial/iu, 'cyan'],
]

export function severityTone(name: string | undefined): TagTone {
  const value = text(name)
  for (const [pattern, tone] of SEVERITY_TONES) if (pattern.test(value)) return tone
  return 'default'
}

const STATUS_TONES: ReadonlyArray<readonly [RegExp, TagTone]> = [
  [/关闭|closed|已结束/iu, 'default'],
  [/已解决|已修复|已通过|resolved|fixed|passed/iu, 'green'],
  [/拒绝|reject|won.?t/iu, 'default'],
  [/待|挂起|pending|open|todo/iu, 'gold'],
  [/验证|自验|测试|verify|test/iu, 'cyan'],
]

export function statusTone(name: string | undefined): TagTone {
  const value = text(name)
  for (const [pattern, tone] of STATUS_TONES) if (pattern.test(value)) return tone
  return 'blue'
}
