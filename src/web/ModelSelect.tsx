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

/** 下拉当前显示的面板：根菜单（两行入口）或钻入后的某个列表。 */
type Pane = 'root' | 'model' | 'effort'

/** 未定位时的 portal 卡片样式：隐藏但按固定原点布局，让 offsetWidth/offsetHeight 真实可测。 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** ModelSelect 的属性定义：模型列表、当前模型/等级及各级选择与命令回调。 */
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

/** 按提供商分组的模型组。 */
interface ModelGroup {
  readonly id: string
  readonly models: readonly ModelOption[]
}

/**
 * 功能：DSH 的两级模型选择座（位于 composer）：根菜单为「模型/推理等级」两行入口，
 * 各自钻入自己的列表；两级面板同属一张 portal 卡片，按触发按钮矩形定位。
 * 键盘行为与 composer 一致：方向键在当前面板内循环移动、Tab 如 Enter 确认、
 * Escape 与 Shift+Tab 先退出钻入面板；每次面板切换都明确指定键盘落点。
 * @param props models 模型选项；providerName 提供商显示名；current 当前模型；
 *              level/levels 当前与可选推理等级；levelName 等级显示名；disabled/busy
 *              禁用与忙碌态；onSelectModel/onSelectLevel 选择回调；onSearch 打开模型搜索；
 *              onManageProviders 打开提供商管理。
 * 内部逻辑：groups 按 provider 分组；未选模型时直接钻入 model 面板；paneFocus 记录
 * 面板切换的键盘意图并在 effect 中落焦；卡片位置经 useLayoutEffect 度量（隐藏布局）
 * 后贴触发按钮上方、右对齐并夹取在视口内，滚动/缩放/面板切换时重新放置；
 * mousedown preventDefault 防 WebKit 点前失焦；blur 到子树外即关闭。
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
  /** 打开菜单：聚焦触发按钮；未选模型时直接钻入模型列表面板。 */
  const show = (): void => {
    triggerRef.current?.focus()
    if (current === undefined) paneFocus.current = 'drill'
    setPane(current === undefined ? 'model' : 'root')
    setOpen(true)
  }
  /** 关闭菜单并复位到根面板；restoreFocus 为 true 时异步还焦点给触发按钮。 */
  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }
  /** 钻入指定面板，键盘落点为该面板当前选中（或首个可用）项。 */
  const drill = (next: Pane): void => {
    paneFocus.current = 'drill'
    setPane(next)
  }
  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
  }
  /** 选中模型：与当前相同时仅关闭，否则回调 onSelectModel 并关闭还焦。 */
  const choose = (model: ModelOption): void => {
    if (current?.provider === model.provider && current.modelId === model.modelId) { close(true); return }
    triggerRef.current?.focus()
    onSelectModel(model)
    close(true)
  }
  /** 选中推理等级：与当前相同时仅关闭，否则回调 onSelectLevel 并关闭还焦。 */
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

  /** 在当前面板的可聚焦项间移动焦点，循环回绕。 */
  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // 焦点不在行内（菜单打开时触发按钮仍持有焦点）时，按步进方向入场：向前从第一行、向后从最后一行。
    const next = active === -1 ? (offset > 0 ? 0 : items.length - 1) : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  /** 根容器的键盘处理：Escape/Shift+Tab 逐级退出，Tab 确认焦点行，方向键移动焦点。 */
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root') back(pane)
      else close(true)
      return
    }
    if (!open) return
    // Tab 像 Enter 一样确认、Shift+Tab 像 Escape 一样退出；两者都被消费，
    // 避免浏览器默认遍历进入打开中的卡片。
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

  /** 焦点离开根容器与 portal 卡片子树时关闭菜单。 */
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  itemRefs.current = []
  let itemIndex = 0
  /** 收集当前渲染面板内各可聚焦项的 ref，供键盘导航使用（每次渲染按顺序重排）。 */
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
