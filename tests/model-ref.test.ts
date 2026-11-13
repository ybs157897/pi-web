import { describe, expect, it } from 'vitest'
import { formatModelRef, parseModelRef } from '../src/shared/model-ref.ts'

describe('model-ref', () => {
  it('formats and parses provider/modelId, including slashes in the model id', () => {
    expect(formatModelRef({ provider: 'commandcode', modelId: 'deepseek/deepseek-v4.1-flash' }))
      .toBe('commandcode/deepseek/deepseek-v4.1-flash')
    expect(parseModelRef('commandcode/deepseek/deepseek-v4.1-flash')).toEqual({
      provider: 'commandcode', modelId: 'deepseek/deepseek-v4.1-flash',
    })
  })

  it('treats empty or malformed values as unset', () => {
    expect(parseModelRef(undefined)).toBeUndefined()
    expect(parseModelRef('')).toBeUndefined()
    expect(parseModelRef('  ')).toBeUndefined()
    expect(parseModelRef('no-slash')).toBeUndefined()
    expect(parseModelRef('/missing-provider')).toBeUndefined()
    expect(parseModelRef('provider/')).toBeUndefined()
  })
})
