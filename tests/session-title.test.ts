import { describe, expect, it } from 'vitest'
import {
  cleanTitleText, fallbackSessionTitle, frameTitleMessages, normalizeSessionTitle, titleSystemPrompt, TITLE_POLICY,
} from '../src/server/conversation/session-title.ts'

describe('session titles', () => {
  it('caps the deterministic fallback by words and by UTF-8 bytes', () => {
    expect(fallbackSessionTitle('one two three four five six seven eight nine ten'))
      .toBe('one two three four five six seven eight')
    // A space-less CJK prompt is one word, so the byte cap decides the cut.
    const long = '帮'.repeat(80)
    expect(Buffer.byteLength(fallbackSessionTitle(long), 'utf8')).toBeLessThanOrEqual(TITLE_POLICY.fallbackMaxBytes)
    expect(fallbackSessionTitle('   ')).toBe('')
  })

  it('strips terminal escapes, invisible controls and line breaks', () => {
    expect(cleanTitleText('\u001B[31mred\u001B[0m title')).toBe('red title')
    expect(cleanTitleText('line one\nline two\t  spaced')).toBe('line one line two spaced')
    expect(cleanTitleText('zero\u200Bwidth\u202Eprompt')).toBe('zerowidthprompt')
  })

  it('truncates a generated title inside the byte budget without splitting a code point', () => {
    expect(normalizeSessionTitle('  short title  ')).toBe('short title')
    const title = normalizeSessionTitle('中'.repeat(100))
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(TITLE_POLICY.maxTitleBytes)
    expect(title.length).toBe(40)
  })

  it('frames generation with DSH vocabulary', () => {
    const prompt = titleSystemPrompt()
    expect(prompt).toContain(`约 ${TITLE_POLICY.targetWords} 个词`)
    expect(prompt).toContain(`${TITLE_POLICY.targetCjkCharacters} 个字符`)
    expect(prompt).toContain('仅返回一行自然语言纯文本标题')
    expect(frameTitleMessages([{ seq: 7, text: 'hello' }]))
      .toBe('根据以下人类消息 JSON 数组生成会话标题：\n[{"seq":7,"text":"hello"}]')
  })
})
