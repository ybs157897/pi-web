import { describe, expect, it } from 'vitest'
import type { WetrackDefectItem } from '../src/shared/types.ts'
import {
  defectDescriptionText, fieldText, filterDefects, groupDefectsByProject, projectKeyOf, projectLabelOf, severityTone, statusTone,
} from '../src/web/wetrack-view.ts'

function defect(overrides: Partial<WetrackDefectItem> = {}): WetrackDefectItem {
  return { defectNumber: 'DTS006749813', simpleDesc: '设备删除后无提示', severityName: '一般', defectStatusName: '待开发解决问题', projectNumber: 'DH3.RDA000897', ...overrides }
}

describe('wetrack view grouping', () => {
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

  it('requires every whitespace-separated term and ignores case', () => {
    expect(filterDefects(items, 'convert 安保').map(item => item.defectNumber)).toEqual(['DTS2'])
    expect(filterDefects(items, '安保 同步').map(item => item.defectNumber)).toEqual(['DTS1'])
    expect(filterDefects(items, 'DTS2').map(item => item.defectNumber)).toEqual(['DTS2'])
  })

  it('searches status, severity and project columns too', () => {
    expect(filterDefects(items, '自验').map(item => item.defectNumber)).toEqual(['DTS2'])
    expect(filterDefects(items, '严重').map(item => item.defectNumber)).toEqual(['DTS1'])
    expect(filterDefects(items, 'pro 融合').map(item => item.defectNumber)).toEqual(['DTS2'])
  })

  it('returns a fresh copy for an empty query', () => {
    const result = filterDefects(items, '   ')
    expect(result).toEqual(items)
    expect(result).not.toBe(items)
  })
})

describe('wetrack detail text', () => {
  it('reads scalar fields and drops the rest', () => {
    expect(fieldText('  严重 ')).toBe('严重')
    expect(fieldText(3)).toBe('3')
    expect(fieldText(true)).toBe('true')
    expect(fieldText(null)).toBe('')
    expect(fieldText({ a: 1 })).toBe('')
    expect(fieldText(undefined)).toBe('')
  })

  it('turns WeTrack HTML into readable text without leaking markup', () => {
    const html = '<p>【步骤】</p><p>1. convert 上解除安保<br />2. care 未同步</p>'
      + '<p><img src="https://example.com/1.png" border="0" /></p>'
      + '<script>alert(1)</script><p>a&nbsp;&amp;&nbsp;b&nbsp;&lt;tag&gt;</p>'
    const text = defectDescriptionText(html)
    expect(text).toBe('【步骤】\n1. convert 上解除安保\n2. care 未同步\n[图片]\na & b <tag>')
    expect(text).not.toContain('<p>')
    expect(text).not.toContain('alert(1)')
  })

  it('keeps list bullets and collapses blank runs', () => {
    expect(defectDescriptionText('<ul><li>a</li><li>b</li></ul>')).toBe('· a\n· b')
    expect(defectDescriptionText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })
})

describe('wetrack tags', () => {
  it('maps severity names to tones', () => {
    expect(severityTone('致命')).toBe('red')
    expect(severityTone('严重')).toBe('volcano')
    expect(severityTone('一般')).toBe('blue')
    expect(severityTone('轻微')).toBe('cyan')
    expect(severityTone(undefined)).toBe('default')
  })

  it('maps workflow states to tones, reading 待 before 验证 and 解决 only as 已解决', () => {
    expect(statusTone('待开发解决问题')).toBe('gold')
    expect(statusTone('待开发自验')).toBe('gold')
    expect(statusTone('已解决')).toBe('green')
    expect(statusTone('关闭')).toBe('default')
    expect(statusTone('验证中')).toBe('cyan')
    expect(statusTone('其他')).toBe('blue')
  })
})
