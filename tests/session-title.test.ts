import { describe, expect, it } from 'vitest'
import {
  cleanTitleText, fallbackSessionTitle, frameTitleMessages, normalizeSessionTitle, titleSystemPrompt, TITLE_POLICY,
} from '../src/server/conversation/session-title.ts'

/**
 * 会话标题生成契约测试：验证 session-title 模块的确定性兜底标题、
 * 清洗规则与 LLM 生成标题的后处理。
 * 关键契约：标题长度受词数与 UTF-8 字节双重上限约束；截断不得劈开码点；
 * 清洗必须移除终端转义序列、不可见控制字符与换行；系统提示词使用 DSH 词汇。
 */
describe('session titles', () => {
  it('caps the deterministic fallback by words and by UTF-8 bytes', () => {
    expect(fallbackSessionTitle('one two three four five six seven eight nine ten'))
      .toBe('one two three four five six seven eight')
    // A space-less CJK prompt is one word, so the byte cap decides the cut.
    const long = '帮'.repeat(80)
    expect(Buffer.byteLength(fallbackSessionTitle(long), 'utf8')).toBeLessThanOrEqual(TITLE_POLICY.fallbackMaxBytes)
    expect(fallbackSessionTitle('   ')).toBe('')
  })

  // 标题是模型生成的自由文本，必须先压平为单行纯文本：ANSI 转义、零宽字符、
  // 双向控制符（U+202E）与制表/换行都要移除或折叠为空格。
  it('strips terminal escapes, invisible controls and line breaks', () => {
    expect(cleanTitleText('\u001B[31mred\u001B[0m title')).toBe('red title')
    expect(cleanTitleText('line one\nline two\t  spaced')).toBe('line one line two spaced')
    expect(cleanTitleText('zero\u200Bwidth\u202Eprompt')).toBe('zerowidthprompt')
  })

  // 边界：CJK 字符一个码点占 3 字节，超预算时必须按码点回退截断，
  // 而不是按 JS 字符串长度硬切，否则会产生半个字符。
  it('truncates a generated title inside the byte budget without splitting a code point', () => {
    expect(normalizeSessionTitle('  short title  ')).toBe('short title')
    const title = normalizeSessionTitle('中'.repeat(100))
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(TITLE_POLICY.maxTitleBytes)
    expect(title.length).toBe(40)
  })

  // 生成提示词契约：系统提示词须包含词数/字符数目标与「仅返回一行」约束；
  // 用户消息按 JSON 数组封装对话早期的人类消息供模型提取主题。
  it('frames generation with DSH vocabulary', () => {
    const prompt = titleSystemPrompt()
    expect(prompt).toContain(`约 ${TITLE_POLICY.targetWords} 个词`)
    expect(prompt).toContain(`${TITLE_POLICY.targetCjkCharacters} 个字符`)
    expect(prompt).toContain('仅返回一行自然语言纯文本标题')
    expect(frameTitleMessages([{ seq: 7, text: 'hello' }]))
      .toBe('根据以下人类消息 JSON 数组生成会话标题：\n[{"seq":7,"text":"hello"}]')
  })
})
