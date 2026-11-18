import { describe, expect, it } from 'vitest'
import { inspectorLayout } from '../src/web/inspector-layout.ts'

describe('inspector divider', () => {
  it('uses the main body width and can grow past the old 760px limit', () => {
    expect(inspectorLayout(1800)).toEqual({ min: 240, max: 1432, width: 806 })
    expect(inspectorLayout(1800, 2000)).toEqual({ min: 240, max: 1432, width: 1432 })
  })

  it('clamps the preferred width when space is limited and restores it as space returns', () => {
    const preferred = 1000
    expect(inspectorLayout(900, preferred)?.width).toBe(532)
    expect(inspectorLayout(1800, preferred)?.width).toBe(preferred)
    expect(inspectorLayout(900, -100)?.width).toBe(240)
  })

  it('uses the overlay when a divider would leave too little room for either pane', () => {
    expect(inspectorLayout(608)).toBeNull()
    expect(inspectorLayout(609)).toEqual({ min: 240, max: 241, width: 241 })
  })

  it('handles unmeasurable widths and ignores invalid preferences', () => {
    expect(inspectorLayout(0)).toBeNull()
    expect(inspectorLayout(Number.NaN)).toBeNull()
    expect(inspectorLayout(Infinity)).toBeNull()
    expect(inspectorLayout(1000, Number.NaN)).toEqual(inspectorLayout(1000))
  })
})
