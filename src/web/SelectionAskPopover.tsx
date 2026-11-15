import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquareText } from 'lucide-react'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SelectionChatPane.module.css'

export interface SelectionAskPopoverProps {
  /** 文本被选中后召唤浮动提问按钮的容器元素（即会话正文区域）。 */
  containerRef: RefObject<HTMLElement | null>
  onAsk: (quote: string) => void
}

/** 浮动按钮的固定定位锚点：夹取后的中心 x、上/下放置的 y 与选中的引文。 */
interface SelectionAnchor { top: number; left: number; quote: string }

/** 浮动按钮宽度的一半，用于把按钮中心夹取在视口内。 */
const POPOVER_HALF_WIDTH = 96
/** 按钮高度加上与选区矩形的间距。 */
const POPOVER_OFFSET = 40

/**
 * 功能：会话正文的选中文本浮层——当容器内存在非空选区时，「在侧聊中提问」浮动按钮
 * 出现在选区上方（空间不足时改到下方），通过 portal 渲染到 document.body。
 * 在别处选择、收起选区、滚动或焦点离开容器都会隐藏按钮；点击按钮即上报引文并清空选区。
 * @param props containerRef 被监听的容器引用；onAsk 以选中引文回调（用于发起侧聊提问）。
 * 内部逻辑：measure 读取 window.getSelection，校验锚点/焦点节点都在容器内且引文非空，
 * 再按选区矩形计算位置（中心 x 夹取在视口内，上方放不下则放下方）；mouseup 与
 * selectionchange 经 requestAnimationFrame 节流触发 measure，scroll 捕获阶段直接隐藏；
 * ask() 先 setAnchor(null) 清选区再回调，按钮 mousedown preventDefault 防止选区被点掉。
 */
export default function SelectionAskPopover({ containerRef, onAsk }: SelectionAskPopoverProps) {
  const { t } = useUiPreferences()
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)
  const frame = useRef(0)

  /** 读取当前选区并计算浮动按钮位置：不在容器内、引文为空或选区矩形为零面积时隐藏。 */
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

  // 选区会一直保留到点击落下的那一刻；按钮上的 mousedown preventDefault 防止选区被移动。
  /** 点击提问按钮：隐藏浮层、清空选区并把引文经 onAsk 交给侧聊。 */
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
