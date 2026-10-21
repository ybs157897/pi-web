import { describe, expect, it } from 'vitest'
import { splitDocBlocks } from '../src/web/doc-split.ts'

describe('splitDocBlocks', () => {
  it('keeps plain markdown as one segment', () => {
    expect(splitDocBlocks('## 标题\n\n正文')).toEqual([{ kind: 'markdown', text: '## 标题\n\n正文' }])
  })

  it('returns nothing for empty text', () => {
    expect(splitDocBlocks('')).toEqual([])
  })

  it('splits a doc fence out of the surrounding markdown', () => {
    const text = '## 标题\n\n```doc\ntype: cards\nitems:\n  - title: 甲\n```\n\n结尾'
    expect(splitDocBlocks(text)).toEqual([
      { kind: 'markdown', text: '## 标题\n\n' },
      { kind: 'doc', text: 'type: cards\nitems:\n  - title: 甲\n', partial: false },
      { kind: 'markdown', text: '\n结尾' },
    ])
  })

  it('reads the doc body without its fences', () => {
    const segments = splitDocBlocks('```doc\ntype: note\ntitle: 提示\n```')
    expect(segments).toEqual([{ kind: 'doc', text: 'type: note\ntitle: 提示\n', partial: false }])
  })

  it('accepts an info string that names the block first', () => {
    const segments = splitDocBlocks('```doc yaml\ntype: note\n```')
    expect(segments).toEqual([{ kind: 'doc', text: 'type: note\n', partial: false }])
  })

  it('accepts tilde fences', () => {
    const segments = splitDocBlocks('~~~doc\ntype: note\n~~~')
    expect(segments).toEqual([{ kind: 'doc', text: 'type: note\n', partial: false }])
  })

  it('marks an unclosed doc fence as a partial block while the model is still streaming', () => {
    const text = '```doc\ntype: cards\nitems:'
    expect(splitDocBlocks(text)).toEqual([{ kind: 'doc', text: 'type: cards\nitems:', partial: true }])
  })

  it('keeps an unclosed fence of another language in the markdown stream', () => {
    const text = '```ts\nconst a = 1'
    expect(splitDocBlocks(text)).toEqual([{ kind: 'markdown', text }])
  })

  it('does not read a doc fence that sits inside a code block', () => {
    const text = '```bash\n```doc\ntype: cards\n```\n```'
    expect(splitDocBlocks(text)).toEqual([{ kind: 'markdown', text }])
  })

  it('keeps a plain code block in the markdown stream', () => {
    const text = '前\n\n```ts\nconst a = 1\n```\n\n后'
    expect(splitDocBlocks(text)).toEqual([{ kind: 'markdown', text }])
  })

  it('numbers several doc blocks in one answer', () => {
    const text = '```doc\ntype: cards\n```\n\n中间\n\n```doc\ntype: note\n```'
    expect(splitDocBlocks(text)).toEqual([
      { kind: 'doc', text: 'type: cards\n', partial: false },
      { kind: 'markdown', text: '\n中间\n\n' },
      { kind: 'doc', text: 'type: note\n', partial: false },
    ])
  })

  it('does not lose the answer text around a doc block', () => {
    const text = '结论先行。\n\n```doc\ntype: compare\nleft:\n  title: 普通\nright:\n  title: 高级\n```\n\n后续说明。\n'
    const segments = splitDocBlocks(text)
    expect(segments.map(segment => segment.kind)).toEqual(['markdown', 'doc', 'markdown'])
    expect(segments[0].text).toBe('结论先行。\n\n')
    expect(segments[2].text).toBe('\n后续说明。\n')
  })
})
