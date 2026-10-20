import { describe, expect, it } from 'vitest'
import { draftReasoningLevels, pinReasoningLevels } from '../src/web/reasoning-levels.ts'

const model = (thinkingLevelMap?: Record<string, unknown>) => ({ id: 'm', name: 'M', thinkingLevelMap })

describe('reasoning level drafts', () => {
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

  it('has no Off row when the map explicitly disables stopping thinking', () => {
    expect(draftReasoningLevels(model({ off: null, low: 'low', high: 'high' }))).toEqual([
      { level: 'low', value: 'low' },
      { level: 'high', value: 'high' },
    ])
  })

  it('leaves the switch off for a model with no map', () => {
    expect(draftReasoningLevels(model(undefined))).toBeUndefined()
  })

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
