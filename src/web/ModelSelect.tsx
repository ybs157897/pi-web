import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, FocusEvent, KeyboardEvent } from 'react'
import clsx from 'clsx'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, MenuSurface, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelOption, ThinkingLevel } from '../shared/types.ts'
import type { Translate } from './render-labels.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

export interface ModelSelectProps {
  models: readonly ModelOption[]
  providerName: (provider: string) => string
  current?: { provider: string; modelId: string }
  level: ThinkingLevel
  levels: readonly ThinkingLevel[]
  levelName: (level: ThinkingLevel) => string
  disabled?: boolean
  busy?: boolean
  t: Translate
  onSelectModel: (model: ModelOption) => void
  onSelectLevel: (level: ThinkingLevel) => void
  onSearch: () => void
  onManageProviders: () => void
}

interface ModelGroup {
  readonly id: string
  readonly models: readonly ModelOption[]
}

/**
 * DSH's two-level model seat: the root menu is the Model / Effort row pair, each
 * drilling into its own list, and both panes are one portaled card placed from the
 * trigger's rect. Keys mirror the composer: arrows walk the shown pane with
 * wrapping, Tab settles like Enter, Escape and Shift+Tab leave a drilled pane
 * first, and every pane switch names where the keyboard lands.
 */
export default function ModelSelect({
  models, providerName, current, level, levels, levelName, disabled = false, busy = false, t,
  onSelectModel, onSelectLevel, onSearch, onManageProviders,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const paneFocus = useRef<'drill' | 'model' | 'effort' | null>(null)
  const id = useId()

  const groups = useMemo<readonly ModelGroup[]>(() => {
    const grouped = new Map<string, ModelOption[]>()
    for (const model of models) {
      const bucket = grouped.get(model.provider) ?? []
      bucket.push(model)
      grouped.set(model.provider, bucket)
    }
    return [...grouped.entries()].map(([groupId, grouped_models]) => ({ id: groupId, models: grouped_models }))
  }, [models])
  const currentModel = current === undefined ? undefined
    : models.find(model => model.provider === current.provider && model.modelId === current.modelId)
  const modelLabel = currentModel?.name ?? current?.modelId ?? t('请选择模型', 'Select a model')
  const triggerLabel = `${modelLabel} · ${levelName(level)}`
  const triggerAria = current === undefined
    ? t('选择模型', 'Select a model')
    : t(`选择模型，当前 ${modelLabel}，推理等级 ${levelName(level)}`, `Select a model: ${modelLabel}, reasoning effort ${levelName(level)}`)
  const show = (): void => {
    triggerRef.current?.focus()
    if (current === undefined) paneFocus.current = 'drill'
    setPane(current === undefined ? 'model' : 'root')
    setOpen(true)
  }
  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }
  const drill = (next: Pane): void => {
    paneFocus.current = 'drill'
    setPane(next)
  }
  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
  }
  const choose = (model: ModelOption): void => {
    if (current?.provider === model.provider && current.modelId === model.modelId) { close(true); return }
    triggerRef.current?.focus()
    onSelectModel(model)
    close(true)
  }
  const chooseLevel = (next: ThinkingLevel): void => {
    if (level === next) { close(true); return }
    triggerRef.current?.focus()
    onSelectLevel(next)
    close(true)
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card sits outside the trigger subtree; both must be checked.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // A pane switch unmounts the row that had focus, dropping it onto the page body
  // outside this subtree. Every switch therefore names where the keyboard lands:
  // drilling on the value in use, coming back on the cell that opened the pane.
  useEffect(() => {
    const intent = paneFocus.current
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const target = checked ?? itemRefs.current.find(item => item !== null && !item.disabled)
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const cell = itemRefs.current[intent === 'effort' ? 1 : 0]
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane])

  // Portaled placement, matching the Menu primitive's portal rules: measured
  // before paint, opened above the trigger with right edges aligned, then
  // clamped inside the viewport. Pane switches resize the card, so they re-place.
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const width = menuRef.current?.offsetWidth ?? 0
      const height = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - width
      let y = rect.top - 8 - height
      if (width > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - width - MARGIN)
      if (height > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - height - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, groups])

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger keeps it while the menu opens) enters
    // at the end the step comes from: the first row forward, the last backward.
    const next = active === -1 ? (offset > 0 ? 0 : items.length - 1) : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root') back(pane)
      else close(true)
      return
    }
    if (!open) return
    // Tab settles like Enter and Shift+Tab leaves like Escape; both are consumed
    // so the browser's traversal stays out of the open card.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root') back(pane)
        else close(true)
        return
      }
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}
      onMouseDown={event => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}>
      <button ref={triggerRef} type="button" className={css.trigger} disabled={disabled}
        aria-label={triggerAria} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel} aria-busy={busy} onClick={() => { if (open) close(true); else show() }}>
        <span className={css.triggerModel}>{modelLabel}</span><span className={css.triggerLevel}>{levelName(level)}</span>
        {busy ? <StateDot state="ongoing" /> : <IconChevronDownOutlineRegular size={11} />}
      </button>
      {open && createPortal(
        <MenuSurface ref={menuRef} id={`${id}-menu`} className={css.card} style={menuPos ?? MEASURE_STYLE}
          role="menu" aria-label={t('模型与推理等级', 'Model and reasoning effort')}>
          {pane === 'root' && <>
            <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => drill('model')}>
              <span className={css.cellLabel}>{t('模型', 'Model')}</span>
              <span className={css.cellValue}>{modelLabel}</span>
              <IconChevronRightOutlineRegular size={14} />
            </button>
            <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => drill('effort')}>
              <span className={css.cellLabel}>{t('推理等级', 'Reasoning effort')}</span>
              <span className={css.cellValue}>{levelName(level)}</span>
              <IconChevronRightOutlineRegular size={14} />
            </button>
          </>}
          {pane === 'model' && <>
            <div className={css.groups}>
              {groups.map(group => {
                const headingId = `${id}-${group.id}`
                return <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                  <div className={css.groupTitle} id={headingId}>{providerName(group.id)}</div>
                  {group.models.map(model => {
                    const selected = current?.provider === model.provider && current.modelId === model.modelId
                    return <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={selected}
                      className={clsx(css.option, selected && css.selected)} key={`${model.provider}/${model.modelId}`}
                      title={model.name} disabled={busy} onClick={() => choose(model)}>
                      <span className={css.optionCopy}>{model.name}</span>
                      <span className={css.check}>{selected ? <IconCheckOutlineRegular size={14} /> : null}</span>
                    </button>
                  })}
                </section>
              })}
            </div>
            <button ref={itemRef()} type="button" role="menuitem" className={css.command} onClick={() => { close(); onSearch() }}>{t('搜索模型…', 'Search models…')}</button>
            <button ref={itemRef()} type="button" role="menuitem" className={css.command} onClick={() => { close(); onManageProviders() }}>{t('管理模型提供商', 'Manage model providers')}</button>
          </>}
          {pane === 'effort' && levels.map(item => {
            const selected = item === level
            return <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={selected}
              className={clsx(css.option, selected && css.selected)} key={item} disabled={busy} onClick={() => chooseLevel(item)}>
              <span className={css.optionCopy}>{levelName(item)}</span>
              <span className={css.check}>{selected ? <IconCheckOutlineRegular size={14} /> : null}</span>
            </button>
          })}
        </MenuSurface>,
        document.body,
      )}
    </div>
  )
}
