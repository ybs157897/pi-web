import type { CollapseTiming, TranscriptViewMode } from '../shared/types.ts'

/**
 * 转录区「工作详情档位」的呈现能力集合。
 */
export interface ChatPresentationPolicy {
  readonly mode: TranscriptViewMode
  readonly collapseTiming: CollapseTiming
  /** 已完成的回合是否把过程行折叠进整回合的控制条。 */
  readonly foldCompletedTurns: boolean
  /** 回合分组策略：collapsed 全部折叠；history 保留最新回合展开；none 平铺不分组。 */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** 折叠的流式思考旁是否显示最新一行摘要。 */
  readonly liveReasoningPreview: boolean
}

type ModeCaps = Omit<ChatPresentationPolicy, 'collapseTiming'>

const POLICIES: Readonly<Record<TranscriptViewMode, ModeCaps>> = {
  compact: { mode: 'compact', foldCompletedTurns: true, stepGrouping: 'collapsed', liveReasoningPreview: false },
  standard: { mode: 'standard', foldCompletedTurns: true, stepGrouping: 'collapsed', liveReasoningPreview: true },
  detailed: { mode: 'detailed', foldCompletedTurns: true, stepGrouping: 'history', liveReasoningPreview: true },
  verbose: { mode: 'verbose', foldCompletedTurns: false, stepGrouping: 'none', liveReasoningPreview: true },
}

const TIMINGS: Readonly<Record<CollapseTiming, Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>>>> = {
  completion: Object.fromEntries(Object.entries(POLICIES).map(([mode, caps]) => [mode, { ...caps, collapseTiming: 'completion' as const }])) as Record<TranscriptViewMode, ChatPresentationPolicy>,
  'next-input': Object.fromEntries(Object.entries(POLICIES).map(([mode, caps]) => [mode, { ...caps, collapseTiming: 'next-input' as const }])) as Record<TranscriptViewMode, ChatPresentationPolicy>,
}

/**
 * 功能：按详情档位与折叠时机解析出一份稳定的呈现策略（查表，不做运行时合成）。
 * @param mode 转录视图档位（compact/standard/detailed/verbose）
 * @param collapseTiming 折叠时机（回合完成时 / 下一次输入时），默认 completion
 * @returns 该组合下固定的策略对象
 */
export function presentationPolicyFor(mode: TranscriptViewMode, collapseTiming: CollapseTiming = 'completion'): ChatPresentationPolicy {
  return TIMINGS[collapseTiming][mode]
}
