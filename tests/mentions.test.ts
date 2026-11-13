import { describe, expect, it } from 'vitest'
import { parseMentions, resolveMentions } from '../src/shared/mentions.ts'
import { BOT_NAME_POOL, suggestBotName } from '../src/shared/bot-names.ts'
import { splitMentions } from '../src/web/bots-view.ts'

const roster = ['Atlas', 'Aurora', 'Kepler'] as const

describe('resolveMentions', () => {
  it('treats a message with no @token as unmentioned', () => {
    expect(resolveMentions('大家好', roster)).toEqual({ hadMention: false, all: false, names: [] })
  })

  it('expands @all in any case to the provided names', () => {
    expect(resolveMentions('@ALL 全体注意', roster)).toEqual({ hadMention: true, all: true, names: [...roster] })
    expect(parseMentions('请 @all 看一下', roster)).toEqual([...roster])
  })

  it('matches mention tokens case-insensitively and keeps canonical casing', () => {
    expect(parseMentions('@atlas 看一下，也 @KEPLER', roster)).toEqual(['Atlas', 'Kepler'])
  })

  it('does not treat an unknown mention as an empty broadcast signal', () => {
    const missed = resolveMentions('@Lumen 你在吗', roster)
    expect(missed).toEqual({ hadMention: true, all: false, names: [] })
    expect(parseMentions('@Lumen 你在吗', roster)).toEqual([])
  })
})

describe('splitMentions', () => {
  it('chips @all and case-insensitive roster names', () => {
    const segments = splitMentions('请 @atlas 和 @ALL 看一下，忽略 @nobody', new Set(roster))
    expect(segments.filter(segment => segment.kind === 'mention').map(segment => segment.value)).toEqual(['Atlas', 'all'])
  })
})

describe('suggestBotName', () => {
  it('falls back to a hyphenated pool name once the pool is exhausted', () => {
    expect(suggestBotName(BOT_NAME_POOL)).toBe('Atlas-2')
    expect(suggestBotName([...BOT_NAME_POOL, 'Atlas-2'])).toBe('Atlas-3')
  })
})
