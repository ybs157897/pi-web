import { useEffect, useMemo, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentSummary } from '../shared/types.ts'
import { formatTokens, type Translate } from './render-labels.ts'
import {
  formatSubagentSeconds, subagentEntryDurationMs, subagentRunEntries, subagentRunHeadline,
  type SubagentRunEntry, type SubagentRunGroup,
} from './subagent-run-model.ts'
import css from './SubagentRunStrip.module.css'

/**
 * One turn's consecutive `subagent` calls as a single line of colored chips. Every child keeps
 * its own hue, a running child shows a spinner ring and its live duration, a finished one shows
 * its token spend, and a failed one is outlined in the error color. Clicking a chip opens that
 * child conversation through the ordinary selection path, which is DSH's catalog jump.
 */
export default function SubagentRunStrip({ group, summaries, t, onOpen }: {
  group: SubagentRunGroup
  /** The parent's projected children; absent until the first child list arrives. */
  summaries?: readonly SubagentSummary[]
  t: Translate
  /** Open the child conversation a chip stands for. */
  onOpen?: (conversationId: string) => void
}) {
  const entries = useMemo(() => subagentRunEntries(group, summaries, t), [group, summaries, t])
  const headline = useMemo(() => subagentRunHeadline(entries, t), [entries, t])
  const running = entries.some(entry => entry.status === 'running' || entry.status === 'creating')
  /** Wall clock for the running chips' durations; DSH advances the catalog the same way. */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [running])

  return <div className={css.root} data-subagent-strip data-status={headline.tone}>
    <div className={css.lead} role="status">
      {headline.tone === 'running' || headline.tone === 'creating'
        ? <span className={css.spinner} aria-hidden="true" />
        : headline.tone === 'failed'
          ? <StateDot state="error" size={14} />
          : <span className={css.doneMark} aria-hidden="true">✓</span>}
      <span className={css.title}>{headline.title}</span>
      {headline.count !== '' && <span className={css.count}>{headline.count}</span>}
    </div>
    <div className={css.chips}>
      {entries.map(entry => <button key={entry.key} type="button" className={css.chip} data-color={entry.colorIndex}
        data-status={entry.status} disabled={onOpen === undefined || entry.childId === undefined}
        aria-label={`${entry.label} · ${statusText(entry.status, t)}${entry.tokens === undefined ? '' : ` · ${formatTokens(entry.tokens)} tok`}`}
        onClick={() => { if (entry.childId !== undefined) onOpen?.(entry.childId) }}>
        <span className={css.dot} aria-hidden="true">
          {entry.status === 'running' || entry.status === 'creating' ? <span className={css.ring} />
            : entry.status === 'done' ? <span className={css.tick} />
              : <span className={css.cross}>×</span>}
        </span>
        <span className={css.label}>{entry.label}</span>
        <ChipMeta entry={entry} now={now} t={t} />
      </button>)}
    </div>
  </div>
}

/** The chip's trailing metric: live duration while running, spend once settled. */
function ChipMeta({ entry, now, t }: { entry: SubagentRunEntry; now: number; t: Translate }) {
  if (entry.status === 'creating') return <span className={css.meta}>{t('创建中', 'Creating')}</span>
  if (entry.status === 'failed') return <span className={css.meta}>{t('失败', 'Failed')}</span>
  if (entry.status === 'running') {
    // A child's first run has no settled duration yet; its live token spend is the next best signal.
    const duration = subagentEntryDurationMs(entry, now)
    if (duration !== undefined) return <span className={css.meta}>{formatSubagentSeconds(duration)}</span>
    return entry.tokens === undefined || entry.tokens === 0 ? null : <span className={css.meta}>{formatTokens(entry.tokens)}</span>
  }
  return entry.tokens === undefined ? null : <span className={css.meta}>{formatTokens(entry.tokens)}</span>
}

function statusText(status: SubagentRunEntry['status'], t: Translate): string {
  if (status === 'creating') return t('创建中', 'creating')
  if (status === 'running') return t('运行中', 'running')
  return status === 'failed' ? t('失败', 'failed') : t('已完成', 'finished')
}
