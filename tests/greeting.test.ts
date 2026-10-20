import { describe, expect, it } from 'vitest'
import { chatEmptyGreeting, greetingFontSizePx, nextGreetingDelayMs } from '../src/web/greeting.ts'

function at(hour: number, minute = 0): Date {
  return new Date(2026, 9, 20, hour, minute, 0, 0)
}

describe('empty-state greeting', () => {
  it('follows ZCode boundary hours', () => {
    expect(chatEmptyGreeting(at(0))).toBe('lateNight')
    expect(chatEmptyGreeting(at(4, 59))).toBe('lateNight')
    expect(chatEmptyGreeting(at(5))).toBe('morningEarly')
    expect(chatEmptyGreeting(at(8, 59))).toBe('morningEarly')
    expect(chatEmptyGreeting(at(9))).toBe('morning')
    expect(chatEmptyGreeting(at(11, 59))).toBe('morning')
    expect(chatEmptyGreeting(at(12))).toBe('noon')
    expect(chatEmptyGreeting(at(13, 59))).toBe('noon')
    expect(chatEmptyGreeting(at(14))).toBe('afternoon')
    expect(chatEmptyGreeting(at(17, 59))).toBe('afternoon')
    expect(chatEmptyGreeting(at(18))).toBe('evening')
    expect(chatEmptyGreeting(at(22, 59))).toBe('evening')
    expect(chatEmptyGreeting(at(23))).toBe('lateNight')
  })

  it('wakes at the next boundary, including across midnight', () => {
    expect(nextGreetingDelayMs(at(4))).toBe(60 * 60 * 1000)
    expect(nextGreetingDelayMs(at(9))).toBe(3 * 60 * 60 * 1000)
    expect(nextGreetingDelayMs(at(23, 30))).toBe(5.5 * 60 * 60 * 1000)
  })

  it('keeps 30px while the text fits and shrinks no lower than 20px', () => {
    expect(greetingFontSizePx(800, 600)).toBe(30)
    expect(greetingFontSizePx(400, 500)).toBe(24)
    expect(greetingFontSizePx(100, 900)).toBe(20)
    expect(greetingFontSizePx(0, 0)).toBe(30)
  })
})
