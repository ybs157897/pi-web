/** 问候语分界时刻表（参照 ZCode 的空态问候实现），每个数字是一天的切换点（本地时区小时）。 */
const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const
const GREETING_MIN_FONT_SIZE_PX = 20
const GREETING_MAX_FONT_SIZE_PX = 30

/** 空态问候语按时段划分的六种档位：清晨、上午、中午、下午、傍晚、深夜。 */
export type ChatEmptyGreeting = 'morningEarly' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'lateNight'

/** 各时段问候语的中英文文案，由空态 UI 按 UI 语言取用。 */
export const CHAT_EMPTY_GREETINGS: Record<ChatEmptyGreeting, { zh: string; en: string }> = {
  morningEarly: { zh: '早上好呀，新的一天开始啦', en: 'Morning, ready when you are' },
  morning: { zh: '上午好呀，有什么想让我帮忙的吗', en: 'Morning, how can I help?' },
  noon: { zh: '中午好呀，要不要先休息一下', en: 'Noon break?' },
  afternoon: { zh: '下午好呀，接下来交给我吧', en: 'Good afternoon! Leave the rest to me.' },
  evening: { zh: '晚上好呀，今天辛苦啦', en: 'Evening, nice work today' },
  lateNight: { zh: '夜深啦，别忘了照顾好自己哦', en: "It's late—remember to take care of yourself." },
}

/**
 * 功能：按本地时间的小时数选出当前时段对应的问候档位。
 * @param date 当前时间
 * @returns 六个档位之一；[5,9) 清晨、[9,12) 上午、[12,14) 中午、[14,18) 下午、[18,23) 傍晚，其余算深夜
 */
export function chatEmptyGreeting(date: Date): ChatEmptyGreeting {
  const hour = date.getHours()
  if (hour >= 5 && hour < 9) return 'morningEarly'
  if (hour >= 9 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 14) return 'noon'
  if (hour >= 14 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'lateNight'
}

/**
 * 功能：计算距下一个问候切换点还差多少毫秒，让已打开的空态到点自动换文案而无需刷新。
 * @param date 当前时间
 * @returns 剩余毫秒数；若今天已过全部分界则指向明天第一个分界，最小 1ms
 */
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

/**
 * 功能：空态问候语的字号自适应——自然宽度放不下时按比例缩小。
 * @param availableWidthPx 容器可用宽度（px）
 * @param naturalTextWidthPx 问候语按 30px 字号排版的自然宽度（px）
 * @returns 字号（px）：放得下保持 30px；放不下按宽度比例折算，下限 20px 不再缩小
 * 内部逻辑：任一入参非法（非有限数 / 非正数）或容器够宽时直接返回最大字号。
 */
export function greetingFontSizePx(availableWidthPx: number, naturalTextWidthPx: number): number {
  if (!Number.isFinite(availableWidthPx) || !Number.isFinite(naturalTextWidthPx) || availableWidthPx <= 0 || naturalTextWidthPx <= 0 || availableWidthPx >= naturalTextWidthPx) {
    return GREETING_MAX_FONT_SIZE_PX
  }
  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(GREETING_MAX_FONT_SIZE_PX, Math.floor(GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx))),
  )
}
