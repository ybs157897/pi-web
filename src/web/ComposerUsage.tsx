import { useEffect, useId, useRef, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconGaugeOutlineRegular, MenuSurface,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cacheHitPercent, formatTokens } from './render-labels.ts'
import type { ConversationStats } from './render-model.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './ComposerUsage.module.css'

export default function ComposerUsage({ stats, contextWindow }: { stats: ConversationStats; contextWindow?: number }) {
  const { settings, t } = useUiPreferences()
  const [expanded, setExpanded] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const compact = settings.performanceUsage === 'compact'
  const hasActivity = stats.runCount > 0 || stats.stepCount > 0
  const hasUsage = stats.totalTokens > 0
  const contextPercent = contextWindow !== undefined && contextWindow > 0 && stats.contextTokens > 0
    ? Math.min(100, Math.round(stats.contextTokens / contextWindow * 100))
    : undefined
  const hasStats = hasActivity || hasUsage || contextPercent !== undefined
  const open = hasStats && expanded

  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    return () => document.removeEventListener('pointerdown', dismissOutside)
  }, [open])

  if (!hasStats) return null

  const label = t('用量', 'Usage')
  const count = (value: number) => value.toLocaleString(settings.locale)
  const activity = stats.runCount > 0
    ? t(`${count(stats.runCount)} 轮`, `${count(stats.runCount)} ${stats.runCount === 1 ? 'run' : 'runs'}`)
    : t(`${count(stats.stepCount)} 步`, `${count(stats.stepCount)} ${stats.stepCount === 1 ? 'step' : 'steps'}`)
  const showContext = !compact && contextPercent !== undefined
  const summary = hasUsage ? `${formatTokens(stats.totalTokens)} tok` : hasActivity ? activity : `${contextPercent}%`
  const cacheHit = cacheHitPercent(stats.cacheRead, stats.input + stats.cacheRead + stats.cacheWrite)
  const accessibleSummary = showContext ? t(`上下文已用 ${contextPercent}%`, `Context used ${contextPercent}%`) : summary
  const Chevron = open ? IconChevronDownOutlineRegular : IconChevronUpOutlineRegular

  return <div ref={root}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false)
    }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      setExpanded(false)
      button.current?.focus()
    }}>
    <button ref={button} type="button" className={css.trigger} aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`${label} · ${accessibleSummary}`}
      onClick={() => setExpanded(current => !current)}>
      {!compact && <><IconGaugeOutlineRegular size={13} aria-hidden="true" />{label}</>}
      {showContext ? <span className={css.context}><ContextRing percent={contextPercent} />{contextPercent}%</span> : summary}
      <Chevron size={11} aria-hidden="true" />
    </button>
    {open && <MenuSurface className={css.panel}>
      <div id={panelId} className={css.panelBody} role="region" tabIndex={0} aria-label={t('用量详情', 'Usage details')}>
        {(hasActivity || stats.tokensPerSecond !== undefined) && <dl className={css.rows}>
          <StatRow label={t('轮数', 'Runs')} value={count(stats.runCount)} />
          <StatRow label={t('步数', 'Steps')} value={count(stats.stepCount)} />
          {stats.tokensPerSecond !== undefined && <StatRow label={t('输出速度', 'Output speed')} value={`${count(Math.round(stats.tokensPerSecond))} tok/s`} />}
        </dl>}
        {hasUsage && <dl className={css.rows}>
          <StatRow label={t('Token 总量', 'Total tokens')} value={count(stats.totalTokens)} />
          {cacheHit !== undefined && <StatRow label={t('缓存命中', 'Cache hit')} value={`${cacheHit}%`} />}
          <StatRow label={t('未缓存输入', 'Uncached input')} value={count(stats.input)} />
          <StatRow label={t('缓存读取', 'Cache read')} value={count(stats.cacheRead)} />
          {stats.cacheWrite > 0 && <StatRow label={t('缓存写入', 'Cache write')} value={count(stats.cacheWrite)} />}
          <StatRow label={t('输出', 'Output')} value={count(stats.output)} />
        </dl>}
        {contextPercent !== undefined && contextWindow !== undefined && <dl className={css.rows}>
          <StatRow label={t('上下文已用', 'Context used')} value={`~${formatTokens(stats.contextTokens)} / ${formatTokens(contextWindow)} (${contextPercent}%)`} />
        </dl>}
      </div>
    </MenuSurface>}
  </div>
}

function StatRow({ label, value }: { label: string; value: string }) {
  return <div className={css.row}><dt>{label}</dt><dd>{value}</dd></div>
}

/** DSH 的上下文占用圆环，弧长表示已用比例。 */
function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5
  const circumference = 2 * Math.PI * radius
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
    <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      strokeDasharray={`${circumference * percent / 100} ${circumference}`} transform="rotate(-90 7 7)" />
  </svg>
}
