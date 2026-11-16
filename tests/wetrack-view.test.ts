import { describe, expect, it } from 'vitest'
import type { WetrackDefectItem } from '../src/shared/types.ts'
import {
  compareDefectsNewest, defectDescriptionText, fieldText, filterDefects, groupDefectsByProject, projectKeyOf, projectLabelOf, severityTone, statusTone, workflowOf,
} from '../src/web/wetrack-view.ts'

/**
 * WeTrack 前端视图层纯函数契约测试：项目分组、文本过滤、工作流归类排序、
 * 详情 HTML 转文本与状态/严重度标签配色。
 */

/**
 * 构造缺陷条目 fixture。
 * @param overrides 覆盖默认字段的属性
 * @returns 一条「一般 / 待开发解决问题」基准缺陷，便于各用例只写差异字段
 */
function defect(overrides: Partial<WetrackDefectItem> = {}): WetrackDefectItem {
  return { defectNumber: 'DTS006749813', simpleDesc: '设备删除后无提示', severityName: '一般', defectStatusName: '待开发解决问题', projectNumber: 'DH3.RDA000897', ...overrides }
}

describe('wetrack view grouping', () => {
  // 分组契约：按 projectNumber 分组、保持首次出现顺序、组内保留原顺序、
  // 组标签取 projectName。
  it('groups by project number and keeps the first-seen order', () => {
    const groups = groupDefectsByProject([
      defect({ defectNumber: 'DTS1', projectNumber: 'DH3.A', projectName: 'Pro 融合' }),
      defect({ defectNumber: 'DTS2', projectNumber: 'DH3.B' }),
      defect({ defectNumber: 'DTS3', projectNumber: 'DH3.A', projectName: 'Pro 融合' }),
    ])
    expect(groups.map(group => group.key)).toEqual(['DH3.A', 'DH3.B'])
    expect(groups[0]?.label).toBe('Pro 融合')
    expect(groups[0]?.items.map(item => item.defectNumber)).toEqual(['DTS1', 'DTS3'])
    expect(groups[1]?.label).toBe('DH3.B')
  })

  // 回退链：无编号时按项目名分组（key 前缀 name:）；两者皆无时归入「未分类」桶。
  it('falls back to project names and then to an uncategorized bucket', () => {
    const groups = groupDefectsByProject([
      defect({ defectNumber: 'DTS1', projectNumber: undefined, projectName: '安保服务' }),
      defect({ defectNumber: 'DTS2', projectNumber: undefined, projectName: undefined }),
      defect({ defectNumber: 'DTS3', projectNumber: undefined, projectName: '安保服务' }),
    ])
    expect(groups.map(group => group.key)).toEqual(['name:安保服务', 'none'])
    expect(groups[0]?.label).toBe('安保服务')
    expect(groups[1]?.label).toBe('未分类')
    expect(groups[0]?.items).toHaveLength(2)
  })

  // 稳定性：分组键优先用编号，项目改名只换标签不换 tab 身份。
  it('keys rows by number first, so a renamed project keeps its tab', () => {
    expect(projectKeyOf(defect({ projectNumber: 'DH3.A', projectName: 'old' }))).toBe('DH3.A')
    expect(projectLabelOf(defect({ projectNumber: 'DH3.A', projectName: 'new' }))).toBe('new')
  })
})

describe('wetrack view filtering', () => {
  const items = [
    defect({ defectNumber: 'DTS1', simpleDesc: '安保服务无法同步', defectStatusName: '待开发解决问题', severityName: '严重' }),
    defect({ defectNumber: 'DTS2', simpleDesc: 'Convert 解除安保', defectStatusName: '待开发自验', severityName: '一般', projectName: 'Pro 融合' }),
  ]

  // 检索契约：空格分词 AND 语义（每个词都必须命中），大小写不敏感。
  it('requires every whitespace-separated term and ignores case', () => {
    expect(filterDefects(items, 'convert 安保').map(item => item.defectNumber)).toEqual(['DTS2'])
    expect(filterDefects(items, '安保 同步').map(item => item.defectNumber)).toEqual(['DTS1'])
    expect(filterDefects(items, 'DTS2').map(item => item.defectNumber)).toEqual(['DTS2'])
  })

  // 检索范围不止描述文本：状态、严重度、项目列同样可命中。
  it('searches status, severity and project columns too', () => {
    expect(filterDefects(items, '自验').map(item => item.defectNumber)).toEqual(['DTS2'])
    expect(filterDefects(items, '严重').map(item => item.defectNumber)).toEqual(['DTS1'])
    expect(filterDefects(items, 'pro 融合').map(item => item.defectNumber)).toEqual(['DTS2'])
  })

  // 边界：空查询返回等值副本而非原数组引用，保证调用方改动不污染源数据。
  it('returns a fresh copy for an empty query', () => {
    const result = filterDefects(items, '   ')
    expect(result).toEqual(items)
    expect(result).not.toBe(items)
  })
})

describe('wetrack workflow and ordering', () => {
  // 工作流归类：「待开发」族归 development、「待验证」族归 verification；
  // 排序按提交时间新→旧。
  it('separates development and verification and puts the newest defect first', () => {
    const older = defect({ defectNumber: 'DTS1', submitTime: '2026-10-01 10:00:00' })
    const newest = defect({ defectNumber: 'DTS2', submitTime: '2026-10-31 10:00:00', defectStatusName: '待开发自验' })
    expect(workflowOf(older)).toBe('development')
    expect(workflowOf(newest)).toBe('verification')
    expect([older, newest].sort(compareDefectsNewest).map(item => item.defectNumber)).toEqual(['DTS2', 'DTS1'])
  })
})

describe('wetrack detail text', () => {
  // 标量字段展示规则：字符串修剪空白、数字/布尔转字符串，其余（对象/空值）丢弃。
  it('reads scalar fields and drops the rest', () => {
    expect(fieldText('  严重 ')).toBe('严重')
    expect(fieldText(3)).toBe('3')
    expect(fieldText(true)).toBe('true')
    expect(fieldText(null)).toBe('')
    expect(fieldText({ a: 1 })).toBe('')
    expect(fieldText(undefined)).toBe('')
  })

  // HTML→文本转换契约：块级标签换行、图片折叠为 [图片] 占位、script 内容剥除、
  // 实体还原为可读字符（&nbsp;→空格、&amp;→&），不允许任何标签漏出。
  it('turns WeTrack HTML into readable text without leaking markup', () => {
    const html = '<p>【步骤】</p><p>1. convert 上解除安保<br />2. care 未同步</p>'
      + '<p><img src="https://example.com/1.png" border="0" /></p>'
      + '<script>alert(1)</script><p>a&nbsp;&amp;&nbsp;b&nbsp;&lt;tag&gt;</p>'
    const text = defectDescriptionText(html)
    expect(text).toBe('【步骤】\n1. convert 上解除安保\n2. care 未同步\n[图片]\na & b <tag>')
    expect(text).not.toContain('<p>')
    expect(text).not.toContain('alert(1)')
  })

  // 版式保真：ul/li 保留「· 」圆点；连续空段折叠为单个空行。
  it('keeps list bullets and collapses blank runs', () => {
    expect(defectDescriptionText('<ul><li>a</li><li>b</li></ul>')).toBe('· a\n· b')
    expect(defectDescriptionText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })
})

describe('wetrack tags', () => {
  // 严重度→配色映射：致命/严重/一般/轻微对应四级色，未知回退 default。
  it('maps severity names to tones', () => {
    expect(severityTone('致命')).toBe('red')
    expect(severityTone('严重')).toBe('volcano')
    expect(severityTone('一般')).toBe('blue')
    expect(severityTone('轻微')).toBe('cyan')
    expect(severityTone(undefined)).toBe('default')
  })

  // 状态→配色映射的判定次序：前缀「待」先命中（gold）；「已解决」才算绿色，
  // 「验证中」是 cyan，未识别状态回退蓝。
  it('maps workflow states to tones, reading 待 before 验证 and 解决 only as 已解决', () => {
    expect(statusTone('待开发解决问题')).toBe('gold')
    expect(statusTone('待开发自验')).toBe('gold')
    expect(statusTone('已解决')).toBe('green')
    expect(statusTone('关闭')).toBe('default')
    expect(statusTone('验证中')).toBe('cyan')
    expect(statusTone('其他')).toBe('blue')
  })
})
