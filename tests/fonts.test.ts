import { describe, expect, it } from 'vitest'
import { normalizeFontFamily } from '../src/shared/fonts.ts'

describe('normalizeFontFamily', () => {
  it('quotes installed family names and keeps generic families unquoted', () => {
    expect(normalizeFontFamily('Inter, system-ui, SF Pro Text'))
      .toBe('"Inter", system-ui, "SF Pro Text"')
    expect(normalizeFontFamily('-apple-system, BlinkMacSystemFont, sans-serif'))
      .toBe('-apple-system, BlinkMacSystemFont, sans-serif')
  })

  it('drops quotes, backslashes, angle brackets and control characters', () => {
    expect(normalizeFontFamily('"JetBrains Mono", <script>, back\\slash'))
      .toBe('"JetBrains Mono", "script", "backslash"')
  })

  it('collapses whitespace and skips empty entries', () => {
    expect(normalizeFontFamily('  Fira   Code  ,, ,  ')).toBe('"Fira Code"')
    expect(normalizeFontFamily('   ')).toBe('')
    expect(normalizeFontFamily('')).toBe('')
  })

  it('is idempotent', () => {
    const once = normalizeFontFamily('Inter, ui-monospace, "Microsoft YaHei UI"')
    expect(normalizeFontFamily(once)).toBe(once)
  })
})
