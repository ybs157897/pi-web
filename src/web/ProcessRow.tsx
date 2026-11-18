import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import './message-rendering/theme.css'
import css from './ProcessRow.module.css'

/** ProcessRow 的属性定义：控制行头图标/标题/摘要、展开行为与挂载动画。 */
interface ProcessRowProps {
  icon: ReactNode
  showIcon?: boolean
  title: string
  open: boolean
  expandable: boolean
  onToggle: () => void
  /** 该行是动作行而非折叠行（对应 ZCode 的 Agent 摘要行），点击触发 onActivate。 */
  onActivate?: () => void
  running?: boolean
  summary?: ReactNode
  accessory?: ReactNode
  children?: ReactNode
  interactiveSummary?: boolean
  keepSummaryWhenOpen?: boolean
  toggleLabel?: string
}

/**
 * 功能：ZCode 风格的紧凑工作行，用于流程/工具条目列表（含可折叠详情区）；
 * 折叠收起时详情延迟卸载 300ms，保证完整播放关闭动画。
 * @param props icon/showIcon 行头图标及是否显示；title 行标题；open 是否展开；
 *              expandable 是否可折叠；onToggle 切换展开回调；onActivate 动作行点击回调；
 *              running 是否运行中（影响标题样式）；summary 摘要内容；accessory 行尾附加控件；
 *              interactiveSummary 摘要与标题分开两个点击区；keepSummaryWhenOpen 展开后仍保留摘要；
 *              toggleLabel 无障碍标签。
 * 内部逻辑：mounted 状态延迟收起子内容——open 变 false 后启动 300ms 定时器再卸载，
 * 期间 details 区域以 inert + aria-hidden 隐藏；头部按 onActivate / expandable /
 * interactiveSummary 组合渲染为动作按钮、分离式折叠按钮或静态文本。
 */
export function ProcessRow({ icon, showIcon = true, title, open, expandable, onToggle, onActivate, running = false, summary, accessory, children, interactiveSummary = false, keepSummaryWhenOpen = false, toggleLabel }: ProcessRowProps) {
  const id = useId()
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) { setMounted(true); return }
    const timer = window.setTimeout(() => setMounted(false), 300)
    return () => window.clearTimeout(timer)
  }, [open])
  const leading = <>{showIcon && <span className={css.icon} data-process-leading-icon aria-hidden="true">{icon}</span>}<span className={css.title} data-running={running || undefined}>{title}</span></>
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
