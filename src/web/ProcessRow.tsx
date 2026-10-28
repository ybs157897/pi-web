import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import './message-rendering/theme.css'
import css from './ProcessRow.module.css'

interface ProcessRowProps {
  icon: ReactNode
  showIcon?: boolean
  title: string
  open: boolean
  expandable: boolean
  onToggle: () => void
  /** A row that is an action, not a disclosure (ZCode's Agent summary row). */
  onActivate?: () => void
  running?: boolean
  summary?: ReactNode
  accessory?: ReactNode
  children?: ReactNode
  interactiveSummary?: boolean
  keepSummaryWhenOpen?: boolean
  toggleLabel?: string
}

/** Compact ZCode-style work row with delayed unmount for a complete close animation. */
export function ProcessRow({ icon, showIcon = true, title, open, expandable, onToggle, onActivate, running = false, summary, accessory, children, interactiveSummary = false, keepSummaryWhenOpen = false, toggleLabel }: ProcessRowProps) {
  const id = useId()
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) { setMounted(true); return }
    const timer = window.setTimeout(() => setMounted(false), 300)
    return () => window.clearTimeout(timer)
  }, [open])
  const leading = <>{showIcon && <span className={css.icon} aria-hidden="true">{icon}</span>}<span className={css.title} data-running={running || undefined}>{title}</span></>
  const visibleSummary = keepSummaryWhenOpen || !open ? summary : null
  const arrow = expandable ? <ChevronRight className={css.chevron} size={16} aria-hidden="true" /> : null
  return <div className={css.root} data-open={open || undefined} data-running={running || undefined}>
    <div className={css.header}>
      {onActivate !== undefined
        ? <button type="button" className={css.toggle} aria-label={toggleLabel ?? title} onClick={onActivate}>{leading}{visibleSummary}</button>
        : expandable ? interactiveSummary ? <>
        <button type="button" className={css.toggle} aria-label={toggleLabel ?? title} aria-expanded={open} aria-controls={id} onClick={onToggle}>{leading}</button>
        {visibleSummary}
        <button type="button" className={css.arrowButton} tabIndex={-1} aria-hidden="true" onClick={onToggle}>{arrow}</button>
      </> : <button type="button" className={css.toggle} aria-label={toggleLabel} aria-expanded={open} aria-controls={id} onClick={onToggle}>{leading}{visibleSummary}{arrow}</button>
        : <div className={css.static}>{leading}{visibleSummary}</div>}
      {accessory}
    </div>
    {expandable && <div id={id} className={css.details} data-open={open || undefined} aria-hidden={!open} {...(!open ? { inert: '' } : {})}>
      <div className={css.clip}>{(open || mounted) && <div className={css.spacing}>{children}</div>}</div>
    </div>}
  </div>
}
