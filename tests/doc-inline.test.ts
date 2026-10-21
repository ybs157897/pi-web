import { describe, expect, it } from 'vitest'
import { classifyCode, splitInline } from '../src/web/doc-inline.ts'

describe('splitInline', () => {
  it('keeps plain text as one token', () => {
    expect(splitInline('没有行内格式')).toEqual([{ kind: 'text', text: '没有行内格式' }])
  })

  it('splits inline code out of a sentence', () => {
    expect(splitInline('新增 `src/server/shell-tools.ts` 和 3 个测试')).toEqual([
      { kind: 'text', text: '新增 ' },
      { kind: 'code', text: 'src/server/shell-tools.ts' },
      { kind: 'text', text: ' 和 3 个测试' },
    ])
  })

  it('splits bold and links', () => {
    expect(splitInline('**结论**见 https://example.test/a。')).toEqual([
      { kind: 'strong', text: '结论' },
      { kind: 'text', text: '见 ' },
      { kind: 'link', text: 'https://example.test/a', href: 'https://example.test/a' },
      { kind: 'text', text: '。' },
    ])
  })

  it('leaves an unmatched backtick alone', () => {
    expect(splitInline('半截 `代码')).toEqual([{ kind: 'text', text: '半截 `代码' }])
  })
})

describe('classifyCode', () => {
  it('recognises file paths', () => {
    expect(classifyCode('src/server/shell-tools.ts')).toBe('path')
    expect(classifyCode('package.json')).toBe('path')
    expect(classifyCode('./docs/spec.md')).toBe('path')
    expect(classifyCode('src/server/')).toBe('path')
  })

  it('recognises commands', () => {
    expect(classifyCode('npm run build')).toBe('command')
    expect(classifyCode('npm test && npm run typecheck')).toBe('command')
    expect(classifyCode('git status')).toBe('command')
    expect(classifyCode('Stop-Process -Id 6316')).toBe('command')
    expect(classifyCode('tsc --noEmit')).toBe('command')
  })

  it('leaves everything else as plain code', () => {
    expect(classifyCode('462d428')).toBe('code')
    expect(classifyCode('GET /api/orders')).toBe('code')
    expect(classifyCode('{ code, label }')).toBe('code')
  })
})
