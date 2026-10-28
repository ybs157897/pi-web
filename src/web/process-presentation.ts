import type { RenderRun } from './render-model.ts'
import type { ChatPresentationPolicy } from './presentation-policy.ts'
import type { Translate } from './render-labels.ts'

/** Keep interleaved user inputs visible and respect the selected detail policy. */
export function defaultProcessOpen(policy: ChatPresentationPolicy, latest: boolean, live: boolean, hasInterleavedUser: boolean): boolean {
  const folds = policy.foldCompletedTurns && (policy.collapseTiming === 'completion' || !latest)
  return hasInterleavedUser || live || !folds || policy.stepGrouping === 'history' && latest
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
