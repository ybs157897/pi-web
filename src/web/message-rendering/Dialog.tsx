import { useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { useBrowserLayoutEffect } from './hooks.ts'
import css from './Dialog.module.css'
import './theme.css'

/**
 * 功能：消息渲染体系共用的模态对话框，基于原生 `<dialog>.showModal()` + portal 到 body。
 * @param open 是否打开
 * @param onClose 关闭回调（Esc 键、原生 cancel 事件、点击 header 关闭按钮、点击 dialog 外的遮罩区域）
 * @param title 标题（aria-labelledby 引用）
 * @param description 可选描述（aria-describedby 引用）
 * @param children 对话框内容
 * @param wide 宽版布局
 * @param t 双语标签函数
 * 内部逻辑：open 翻 true 时 showModal 并把焦点移到 [data-dialog-close] 按钮，关闭时恢复之前的焦点元素；遮罩点击用 getBoundingClientRect 判断命中点在 dialog 矩形之外才触发 onClose。
 */
export function MessageDialog({ open, onClose, title, description, children, wide = false, t }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean; t: Translate
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId(); const descriptionId = useId()
  useBrowserLayoutEffect(() => {
    if (!open || !dialog.current) return
    const element = dialog.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    element.showModal()
    element.querySelector<HTMLButtonElement>('[data-dialog-close]')?.focus()
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [open])
  if (!open || typeof document === 'undefined') return null
  return createPortal(<dialog ref={dialog} className={css.dialog} data-message-dialog data-wide={wide || undefined}
    role="dialog" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-modal="true"
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}
    onCancel={event => { event.preventDefault(); onClose() }} onClick={event => {
      if (event.target !== event.currentTarget) return
      const r = event.currentTarget.getBoundingClientRect()
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose()
    }}>
    <header className={css.header}><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
      <button type="button" onClick={onClose} aria-label={t('关闭', 'Close')} title={t('关闭', 'Close')} data-dialog-close><X size={16} aria-hidden="true" /></button>
    </header>
    {children}
  </dialog>, document.body)
}
