import { useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { useBrowserLayoutEffect } from './hooks.ts'
import css from './Dialog.module.css'
import './theme.css'

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
