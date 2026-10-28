import { useEffect, useMemo, useState } from 'react'
import { IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentSummary } from '../shared/types.ts'
import type { Translate } from './render-labels.ts'
import { formatTokens } from './render-labels.ts'
import {
  formatSubagentSeconds, subagentEntryDurationMs, subagentRunEntries, subagentRunHeadline,
  type SubagentRunEntry, type SubagentRunGroup, type SubagentRunStatus,
} from './subagent-run-model.ts'
import css from './SubagentRunStrip.module.css'

/**
 * The transcript's inline subagent strip: one row of colored chips naming every
 * delegation of a run, with a headline counting what settled. Clicking a chip opens the
 * child conversation as the Inspector's read-only tab — it never replaces the main column.
 */
export default function SubagentRunStrip({ group, summaries, t, onOpen }: {
  group: SubagentRunGroup
  summaries?: readonly SubagentSummary[]
  t: Translate
  /** Open a child conversation as a read-only inspector tab; the chip's label names it. */
  onOpen?: (conversationId: string, title?: string) => void
}) {
  const entries = useMemo(() => subagentRunEntries(group, summaries, t), [group, summaries, t])
  const headline = subagentRunHeadline(entries, t)
  const live = entries.some(entry => entry.status === 'running' || entry.status === 'creating')
  // Only a live strip ticks; a settled one renders its sampled metrics and stops.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [live])
  return (
    <div className={css.strip} data-tone={headline.tone} role="group" aria-label={headline.title}>
      <div className={css.headline} role="status">
        <span className={css.headlineMark} data-tone={headline.tone} aria-hidden="true">
          {headline.tone === 'running' || headline.tone === 'creating'
            ? <IconLoadingOutlineRegular size={12} />
            : <SubagentStatusGlyph status={headline.tone} />}
        </span>
        <span className={css.headlineTitle}>{headline.title}</span>
        {headline.count !== '' && <span className={css.headlineCount}>{headline.count}</span>}
      </div>
      <div className={css.chips}>
        {entries.map(entry => <SubagentChip key={entry.key} entry={entry} now={now} onOpen={onOpen} t={t} />)}
      </div>
    </div>
  )
}

function SubagentChip({ entry, now, onOpen, t }: {
  entry: SubagentRunEntry
  now: number
  onOpen?: (conversationId: string, title?: string) => void
  t: Translate
}) {
  const statusLabel = entry.status === 'creating' ? t('创建中', 'Creating')
    : entry.status === 'running' ? t('运行中', 'Running')
      : entry.status === 'failed' ? t('失败', 'Failed')
        : t('已完成', 'Finished')
  const meta = chipMeta(entry, now, t)
  const aria = [entry.label, statusLabel, entry.tokens === undefined ? undefined : formatTokens(entry.tokens)]
    .filter(part => part !== undefined).join(t('，', ', '))
  return (
    <button type="button" className={css.chip} data-color={entry.colorIndex} data-status={entry.status}
      disabled={onOpen === undefined || entry.childId === undefined}
      aria-label={aria}
      title={entry.task === undefined ? entry.label : `${entry.label}\n${entry.task}`}
      onClick={() => { if (entry.childId !== undefined) onOpen?.(entry.childId, entry.label) }}>
      <span className={css.chipMark} aria-hidden="true">
        {entry.status === 'running' || entry.status === 'creating'
          ? <IconLoadingOutlineRegular size={12} />
          : <SubagentStatusGlyph status={entry.status} />}
      </span>
      <span className={css.chipLabel}>{entry.label}</span>
      {meta !== '' && <span className={css.chipMeta}>{meta}</span>}
    </button>
  )
}

/** Chip trailing text: the creating word, elapsed seconds, or the token spend once settled. */
function chipMeta(entry: SubagentRunEntry, now: number, t: Translate): string {
  if (entry.status === 'creating') return t('创建中', 'Creating')
  if (entry.status === 'failed') return t('失败', 'Failed')
  if (entry.status === 'running') {
    const duration = subagentEntryDurationMs(entry, now)
    if (duration !== undefined) return formatSubagentSeconds(duration)
    return entry.tokens === undefined || entry.tokens === 0 ? '' : formatTokens(entry.tokens)
  }
  return entry.tokens === undefined ? '' : formatTokens(entry.tokens)
}

/** The settled mark: a filled check, or the red cross on a failed delegation. */
function SubagentStatusGlyph({ status }: { status: SubagentRunStatus }) {
  if (status === 'failed') {
    return (
      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
      <path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
