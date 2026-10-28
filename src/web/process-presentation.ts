import type { RenderRun } from './render-model.ts'
import type { ChatPresentationPolicy } from './presentation-policy.ts'
import type { Translate } from './render-labels.ts'

/** Keep interleaved user inputs visible and respect the selected detail policy. */
export function defaultProcessOpen(policy: ChatPresentationPolicy, latest: boolean, live: boolean, hasInterleavedUser: boolean): boolean {
  const folds = policy.foldCompletedTurns && (policy.collapseTiming === 'completion' || !latest)
  return hasInterleavedUser || live || !folds || policy.stepGrouping === 'history' && latest
}

/** Why a work group's auto-open state may change: only these boundaries, never an ordinary frame. */
export type ProcessGroupBoundary = 'live-start' | 'live-end' | 'demote' | 'none'

/**
 * Derive the boundary between two rendered frames. Live and latest are the only facts that
 * may fold or unfold a group the user never touched, and each may fire once: `live-start`
 * when the run takes over, `live-end` when it settles, `demote` when a newer run appears.
 */
export function processGroupBoundary(was: { live: boolean; latest: boolean }, now: { live: boolean; latest: boolean }): ProcessGroupBoundary {
  if (!was.live && now.live) return 'live-start'
  if (was.live && !now.live) return 'live-end'
  if (!now.live && was.latest && !now.latest) return 'demote'
  return 'none'
}

/**
 * The auto open state across one boundary. Everything else keeps the previous value, so a
 * stream of re-projected frames cannot make a group flap open and folded on its own.
 */
export function processGroupAutoOpen(previousOpen: boolean, boundary: ProcessGroupBoundary, defaultOpen: boolean): boolean {
  if (boundary === 'live-start') return true
  if (boundary === 'live-end' || boundary === 'demote') return defaultOpen
  return previousOpen
}

/** The live summary follows the latest non-empty line of the thought stream. */
export function latestReasoningLine(text: string): string {
  return text.replace(/\r\n?/gu, '\n').split('\n').findLast(line => line.trim() !== '')?.trim() ?? ''
}

/** Use only recorded duration; an unavailable duration is not guessed from wall time. */
export function workGroupTitle(run: Pick<RenderRun, 'status' | 'durationMs'>, t: Translate, live = run.status === 'running'): string {
  // A run's status drops to completed between two tool rounds. The conversation-level
  // live flag keeps the header in the working state until the turn actually settles.
  if (live) return t('工作中', 'Working')
  if (run.status === 'error') return t('处理失败', 'Turn failed')
  if (run.status === 'cancelled') return t('已停止', 'Stopped')
  const duration = run.durationMs === undefined || !Number.isFinite(run.durationMs) ? undefined : Math.max(0, Math.floor(run.durationMs / 1000))
  const time = duration === undefined ? undefined : duration >= 60
    ? t(`${Math.floor(duration / 60)} 分 ${duration % 60} 秒`, `${Math.floor(duration / 60)} min ${duration % 60} sec`)
    : t(`${duration} 秒`, `${duration} sec`)
  if (run.status === 'running') return time === undefined ? t('工作中', 'Working') : t(`工作中 ${time}`, `Working ${time}`)
  return time === undefined ? t('已工作', 'Worked') : t(`已工作 ${time}`, `Worked ${time}`)
}
