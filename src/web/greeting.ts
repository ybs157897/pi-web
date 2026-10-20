/** ZCode's empty-state greeting schedule (`ConversationDraftEmptyState.tsx:20-44`). */
const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const
const GREETING_MIN_FONT_SIZE_PX = 20
const GREETING_MAX_FONT_SIZE_PX = 30

export type ChatEmptyGreeting = 'morningEarly' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'lateNight'

export const CHAT_EMPTY_GREETINGS: Record<ChatEmptyGreeting, { zh: string; en: string }> = {
  morningEarly: { zh: '早上好呀，新的一天开始啦', en: 'Morning, ready when you are' },
  morning: { zh: '上午好呀，有什么想让我帮忙的吗', en: 'Morning, how can I help?' },
  noon: { zh: '中午好呀，要不要先休息一下', en: 'Noon break?' },
  afternoon: { zh: '下午好呀，接下来交给我吧', en: 'Good afternoon! Leave the rest to me.' },
  evening: { zh: '晚上好呀，今天辛苦啦', en: 'Evening, nice work today' },
  lateNight: { zh: '夜深啦，别忘了照顾好自己哦', en: "It's late—remember to take care of yourself." },
}

export function chatEmptyGreeting(date: Date): ChatEmptyGreeting {
  const hour = date.getHours()
  if (hour >= 5 && hour < 9) return 'morningEarly'
  if (hour >= 9 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 14) return 'noon'
  if (hour >= 14 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'lateNight'
}

/** Delay until the next greeting boundary, so an open draft switches wording without a reload. */
export function nextGreetingDelayMs(date: Date): number {
  const candidates = GREETING_BOUNDARY_HOURS.map(hour => {
    const boundary = new Date(date)
    boundary.setHours(hour, 0, 0, 0)
    return boundary
  })
  const tomorrow = new Date(date)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0)
  const next = candidates.find(candidate => candidate.getTime() > date.getTime()) ?? tomorrow
  return Math.max(1, next.getTime() - date.getTime())
}

/** Shrink 30px only when the natural greeting would collide with its container, never below 20px. */
export function greetingFontSizePx(availableWidthPx: number, naturalTextWidthPx: number): number {
  if (!Number.isFinite(availableWidthPx) || !Number.isFinite(naturalTextWidthPx) || availableWidthPx <= 0 || naturalTextWidthPx <= 0 || availableWidthPx >= naturalTextWidthPx) {
    return GREETING_MAX_FONT_SIZE_PX
  }
  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(GREETING_MAX_FONT_SIZE_PX, Math.floor(GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx))),
  )
}
