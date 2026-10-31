import { useEffect, useMemo, useState } from 'react'
import { Bot, CircleCheck, Loader } from 'lucide-react'
import type { SubagentSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SubagentDirectory.module.css'

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

function formatElapsed(ms: number, t: (zh: string, en: string) => string): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t(`${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`, `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`)
  return t(`${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`, `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`)
}

function elapsedOf(subagent: SubagentSummary, now: number): number | undefined {
  if (subagent.durationMs === undefined) return undefined
  if (subagent.status !== 'running' || subagent.metricsAt === undefined) return subagent.durationMs
  return subagent.durationMs + Math.max(0, now - subagent.metricsAt)
}

/**
 * ZCode's subagent directory (`SubagentDirectorySidePane.tsx`): every child the parent delegated,
 * grouped by live state, each row opening the read-only session tab. It is the destination of the
 * status card's 「已结束的智能体」 footer instead of an expanding list inside the card.
 */
export default function SubagentDirectory({ subagents, onOpen }: {
  subagents: readonly SubagentSummary[]
  onOpen: (childId: string, title?: string) => void
}) {
  const { t } = useUiPreferences()
  const running = useMemo(() => subagents.filter(item => item.status === 'running'), [subagents])
  const ended = useMemo(() => subagents.filter(item => item.status !== 'running'), [subagents])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (running.length === 0) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [running.length])

  if (subagents.length === 0) {
    return <div className={css.empty} data-subagent-directory>{t('这个会话还没有子智能体', 'No subagents in this conversation yet')}</div>
  }

  const rows = (items: readonly SubagentSummary[], live: boolean) => items.map(subagent => {
    const elapsed = elapsedOf(subagent, now)
    const metrics = [
      ...(subagent.tokens === undefined ? [] : [`${formatTokens(subagent.tokens)} tok`]),
      ...(elapsed === undefined ? [] : [formatElapsed(elapsed, t)]),
    ].join(' · ')
    return <button key={subagent.id} type="button" className={css.row} data-subagent-id={subagent.id}
      data-status={subagent.status} title={subagent.title || subagent.label}
      onClick={() => { onOpen(subagent.id, subagent.title || subagent.label) }}>
      <span className={css.icon}>
        {live ? <Loader size={15} className={css.spin} aria-hidden="true" /> : <CircleCheck size={15} aria-hidden="true" />}
      </span>
      <span className={css.main}>
        <span className={css.titleLine}>
          <span className={css.title}>{subagent.title || subagent.label}</span>
          <span className={css.status}>{live ? t('运行中', 'Running') : t('已结束', 'Ended')}</span>
        </span>
        {subagent.answer !== '' && <span className={css.summary}>{subagent.answer}</span>}
      </span>
      {metrics !== '' && <span className={css.meta}>{metrics}</span>}
    </button>
  })

  return <div className={css.root} data-subagent-directory>
    {running.length > 0 && <section className={css.group} data-subagent-group="running">
      <h3 className={css.groupTitle}>{t('正在运行', 'Running')}</h3>
      {rows(running, true)}
    </section>}
    {ended.length > 0 && <section className={css.group} data-subagent-group="ended">
      <h3 className={css.groupTitle}>{t('已结束', 'Ended')}</h3>
      {rows(ended, false)}
    </section>}
  </div>
}
