import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquareText } from 'lucide-react'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SelectionChatPane.module.css'

export interface SelectionAskPopoverProps {
  /** Element whose text selections summon the floating ask button (the transcript body). */
  containerRef: RefObject<HTMLElement | null>
  onAsk: (quote: string) => void
}

/** Fixed-position anchor for the floating button: clamped center x, top or bottom y, and the quote. */
interface SelectionAnchor { top: number; left: number; quote: string }

/** Half the floating button's width, used to clamp its center inside the viewport. */
const POPOVER_HALF_WIDTH = 96
/** Button height plus the gap to the selection rect. */
const POPOVER_OFFSET = 40

/**
 * The transcript's selection affordance: while a non-empty selection lives inside the
 * container, a floating「在侧聊中提问」button appears above it (below when there is no room),
 * portaled to the document body. Selecting elsewhere, collapsing the selection, scrolling or
 * losing the container hides it. Clicking reports the quote, clears the selection and hides.
 */
export default function SelectionAskPopover({ containerRef, onAsk }: SelectionAskPopoverProps) {
  const { t } = useUiPreferences()
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)
  const frame = useRef(0)

  const measure = useCallback((): void => {
    const container = containerRef.current
    const selection = typeof window === 'undefined' ? null : window.getSelection()
    const inside = (node: Node | null): boolean => node !== null && container !== null && container.contains(node)
    const range = selection !== null && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const quote = selection === null ? '' : selection.toString().trim()
    const rect = range?.getBoundingClientRect()
    if (container === null || selection === null || quote === '' || rect === undefined
      || !inside(selection.anchorNode) || !inside(selection.focusNode)
      || (rect.width === 0 && rect.height === 0)) {
      setAnchor(null)
      return
    }
    const center = rect.left + rect.width / 2
    const left = Math.min(Math.max(center, POPOVER_HALF_WIDTH + 8), Math.max(window.innerWidth - POPOVER_HALF_WIDTH - 8, POPOVER_HALF_WIDTH + 8))
    const above = rect.top - POPOVER_OFFSET
    setAnchor({ top: above >= 8 ? above : rect.bottom + 8, left, quote })
  }, [containerRef])

  useEffect(() => {
    const schedule = (): void => {
      if (frame.current !== 0) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        measure()
      })
    }
    const hide = (): void => setAnchor(null)
    document.addEventListener('mouseup', schedule)
    document.addEventListener('selectionchange', schedule)
    window.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('mouseup', schedule)
      document.removeEventListener('selectionchange', schedule)
      window.removeEventListener('scroll', hide, true)
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [measure])

  // The selection survives until the click lands; preventDefault keeps mousedown from moving it.
  const ask = (): void => {
    const quote = anchor?.quote ?? ''
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
    if (quote !== '') onAsk(quote)
  }

  if (anchor === null) return null
  return createPortal(
    <div className={css.askPopover} style={{ top: anchor.top, left: anchor.left, transform: 'translateX(-50%)' }}>
      <button type="button" className={css.askButton} onMouseDown={event => event.preventDefault()} onClick={ask}>
        <MessageSquareText size={14} aria-hidden="true" />
        {t('在侧聊中提问', 'Ask in side chat')}
      </button>
    </div>,
    document.body,
  )
}
