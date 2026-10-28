import type { CollapseTiming, TranscriptViewMode } from '../shared/types.ts'

/**
 * Presentation capabilities for the transcript's work-details modes.
 */
export interface ChatPresentationPolicy {
  readonly mode: TranscriptViewMode
  readonly collapseTiming: CollapseTiming
  /** Whether a completed turn folds its process rows behind the whole-turn control. */
  readonly foldCompletedTurns: boolean
  /** Group all turns; `history` keeps the latest expanded, or `none` renders flat. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Show the latest line alongside a collapsed, streaming thought. */
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

/** Resolve a stable policy for one detail mode and collapse timing. */
export function presentationPolicyFor(mode: TranscriptViewMode, collapseTiming: CollapseTiming = 'completion'): ChatPresentationPolicy {
  return TIMINGS[collapseTiming][mode]
}
