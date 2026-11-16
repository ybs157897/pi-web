/**
 * 推理等级（thinking level）草稿与固定值的往返转换测试。
 *
 * 关键契约（draftReasoningLevels / pinReasoningLevels 互逆）：
 * - 草稿 = 地图上已声明的等级 + "off" 档；值为 null 的等级表示被钉为"禁用"，不出现在草稿中；
 * - 地图显式含 off 键时不再追加默认 Off 行；完全没有 thinkingLevelMap 的模型无开关；
 * - 草稿里删除某等级后保存（pin），该等级以 null 钉死，重新加载草稿仍不出现（删除状态可往返）；
 * - off 发送空值时 pin 丢弃 off 键，自定义线上值（如 high:'ultra'）原样往返。
 */
import { describe, expect, it } from 'vitest'
import { draftReasoningLevels, pinReasoningLevels } from '../src/web/reasoning-levels.ts'

/** 构造带可选 thinkingLevelMap 的最小模型 fixture。 */
const model = (thinkingLevelMap?: Record<string, unknown>) => ({ id: 'm', name: 'M', thinkingLevelMap })

/** 推理等级草稿/固定值的往返一致性测试。 */
describe('reasoning level drafts', () => {
  // 验证草稿生成：off 行排在首位；值为 null 的等级（minimal/xhigh/max）被视为显式禁用而不出现；
  // low/medium/high 按地图声明保留。
  it('shows declared levels plus Off and hides null-pinned levels', () => {
    expect(draftReasoningLevels(model({
      minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null,
    }))).toEqual([
      { level: 'off', value: null },
      { level: 'low', value: 'low' },
      { level: 'medium', value: 'medium' },
      { level: 'high', value: 'high' },
    ])
  })

  // 验证显式 off 键：地图自带 off:null（明确允许关闭思考）时不追加默认 Off 行，避免重复档位。
  it('has no Off row when the map explicitly disables stopping thinking', () => {
    expect(draftReasoningLevels(model({ off: null, low: 'low', high: 'high' }))).toEqual([
      { level: 'low', value: 'low' },
      { level: 'high', value: 'high' },
    ])
  })

  // 验证无地图模型：thinkingLevelMap 为 undefined 时草稿为 undefined，整个推理等级开关不显示。
  it('leaves the switch off for a model with no map', () => {
    expect(draftReasoningLevels(model(undefined))).toBeUndefined()
  })

  // 验证删除状态往返：草稿缺 medium → pin 写回 medium:null → 重新生成草稿 medium 仍缺席，
  // 删除不会在保存/重载循环中被"复活"。
  it('keeps a deleted level deleted across save and reload', () => {
    const pinned = pinReasoningLevels([
      { level: 'off', value: null },
      { level: 'low', value: 'low' },
      { level: 'high', value: 'high' },
    ])
    expect(pinned).toEqual({
      minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null,
    })
    expect(draftReasoningLevels(model(pinned))).toEqual([
      { level: 'off', value: null },
      { level: 'low', value: 'low' },
      { level: 'high', value: 'high' },
    ])
  })

  // 验证自定义线上值：high:'ultra' 保存并读回原样保留；off 发送空值时 pin 不写 off 键。
  it('round-trips a custom wire value and drops the Off key when Off sends nothing', () => {
    const pinned = pinReasoningLevels([
      { level: 'off', value: null },
      { level: 'low', value: 'low' },
      { level: 'high', value: 'ultra' },
    ])
    expect(pinned.off).toBeUndefined()
    expect(pinned.high).toBe('ultra')
    expect(draftReasoningLevels(model(pinned))).toContainEqual({ level: 'high', value: 'ultra' })
  })
})
