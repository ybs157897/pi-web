import { describe, expect, it } from 'vitest'
import { chatEmptyGreeting, greetingFontSizePx, nextGreetingDelayMs } from '../src/web/greeting.ts'

/**
 * 构造一个 2026-10-20 当天指定时刻的 Date，用于按小时边界测试问候语。
 * @param hour 小时（0-23）
 * @param minute 分钟，默认 0
 * @returns 对应时刻的 Date
 */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 9, 20, hour, minute, 0, 0)
}

/**
 * 空状态问候语测试。
 *
 * 关键契约：
 * - chatEmptyGreeting 按 ZCode 的边界小时分段：0:00-4:59 深夜、5:00-8:59 清晨、9:00-11:59 上午、
 *   12:00-13:59 午间、14:00-17:59 下午、18:00-22:59 晚间、23:00 起回到深夜；
 * - nextGreetingDelayMs 计算到下一个边界的毫秒数，跨午夜也正确；
 * - greetingFontSizePx 按视口尺寸自适应 30→20px，异常尺寸（0,0）回退 30px。
 */
describe('empty-state greeting', () => {
  // 每个分段边界（起点、终点 59 分）都落到正确的问候语分组，23:00 起回到深夜（lateNight）。
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

  // 到下一边界的延迟：04:00 距 5:00 一小时、09:00 距 12:00 三小时、23:30 跨午夜距次日 5:00 五个半小时。
  it('wakes at the next boundary, including across midnight', () => {
    expect(nextGreetingDelayMs(at(4))).toBe(60 * 60 * 1000)
    expect(nextGreetingDelayMs(at(9))).toBe(3 * 60 * 60 * 1000)
    expect(nextGreetingDelayMs(at(23, 30))).toBe(5.5 * 60 * 60 * 1000)
  })

  // 文字放得下保持 30px；中等视口缩到 24px；窄高视口最低 20px 不再缩小；无效尺寸 (0,0) 回退默认 30px。
  it('keeps 30px while the text fits and shrinks no lower than 20px', () => {
    expect(greetingFontSizePx(800, 600)).toBe(30)
    expect(greetingFontSizePx(400, 500)).toBe(24)
    expect(greetingFontSizePx(100, 900)).toBe(20)
    expect(greetingFontSizePx(0, 0)).toBe(30)
  })
})
