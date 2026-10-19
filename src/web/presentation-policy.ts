import type { CollapseTiming, TranscriptViewMode } from '../shared/types.ts'

/**
 * Presentation capabilities one work-details mode enables, copied from DSH so
 * pi-web's transcript folds, groups, and previews exactly like the reference.
 */
export interface ChatPresentationPolicy {
  readonly mode: TranscriptViewMode
  readonly collapseTiming: CollapseTiming
  /** Whether a completed turn folds its process rows behind the whole-turn control. */
  readonly foldCompletedTurns: boolean
  /** Collapsible group headers for all turns, historical turns only, or no turns. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Show the running command, path, query, or reasoning detail in group titles. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
}

type ModeCaps = Omit<ChatPresentationPolicy, 'collapseTiming'>

const POLICIES: Readonly<Record<TranscriptViewMode, ModeCaps>> = {
  compact: { mode: 'compact', foldCompletedTurns: true, stepGrouping: 'collapsed', liveProcessDetail: false, settledReasoningPreview: false },
  standard: { mode: 'standard', foldCompletedTurns: true, stepGrouping: 'collapsed', liveProcessDetail: true, settledReasoningPreview: true },
  detailed: { mode: 'detailed', foldCompletedTurns: true, stepGrouping: 'history', liveProcessDetail: true, settledReasoningPreview: true },
  verbose: { mode: 'verbose', foldCompletedTurns: false, stepGrouping: 'none', liveProcessDetail: false, settledReasoningPreview: true },
}

const TIMINGS: Readonly<Record<CollapseTiming, Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>>>> = {
  completion: Object.fromEntries(Object.entries(POLICIES).map(([mode, caps]) => [mode, { ...caps, collapseTiming: 'completion' as const }])) as Record<TranscriptViewMode, ChatPresentationPolicy>,
  'next-input': Object.fromEntries(Object.entries(POLICIES).map(([mode, caps]) => [mode, { ...caps, collapseTiming: 'next-input' as const }])) as Record<TranscriptViewMode, ChatPresentationPolicy>,
}

/** Resolve a stable policy for one detail mode and collapse timing. */
export function presentationPolicyFor(mode: TranscriptViewMode, collapseTiming: CollapseTiming = 'completion'): ChatPresentationPolicy {
  return TIMINGS[collapseTiming][mode]
}
