import { useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { Check, Copy, Maximize2, Minus, Plus, Scan } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { MessageCodeBlock } from './CodeBlock.tsx'
import { MessageFileIcon } from './FileIcon.tsx'
import { MessageDialog } from './Dialog.tsx'
import { useBrowserLayoutEffect, useCopyFeedback, useMessageTheme } from './hooks.ts'
import blockCss from './CodeBlock.module.css'
import css from './Diagram.module.css'
import { diagramSanitizeConfig } from './diagram-model.ts'

/**
 * 功能：判断 mermaid 源码是否值得进入渲染管线——超大的图直接回退成普通 mermaid 代码块。
 * @param source ```mermaid fenced 块内的源码
 * @returns 长度 ≤ 20k 字符、行数 ≤ 600 且「行数+边数+节点数」≤ 1500 时返回 true
 * 内部逻辑：边数按箭头/连线记号计数，节点数按 `标识符[形状]` 模式计数，都是行级正则启发式。
 */
export function canRenderDiagram(source: string): boolean {
  const lines = source.split('\n').length
  const edges = source.match(/(?:<-->|<--|-->|---|-\.->|==>|--x|--o|x--|o--)/gu)?.length ?? 0
  const nodes = source.match(/(?:^|\n)\s*[A-Za-z][\w-]*(?:\[[^\]\n]{0,200}\]|\([^\)\n]{0,200}\)|\{[^}\n]{0,200}\})/gu)?.length ?? 0
  return source.length <= 20_000 && lines <= 600 && lines + edges + nodes <= 1500
}
let queue: Promise<unknown> = Promise.resolve()
const cache = new Map<string, string>()
/**
 * 功能：消息正文中 mermaid fenced 块的渲染组件——把源码渲染为 SVG 图表，并带复制源码、双击全屏预览。
 * @param source mermaid 源码（对应 host DTO 的 fenced code block，language === 'mermaid'）
 * @param streaming 流式生成中：不渲染（直接回退代码块），等 block 完整后才开始
 * @param t 双语标签函数
 * 内部逻辑：mermaid/dompurify 均按需动态 import；渲染任务串入全局 queue 避免并发渲染竞态，结果按「主题:源码」缓存（LRU 24 条）；渲染成功经 diagramSanitizeConfig 消毒后注入；页面隐藏（visibilitychange）时暂停渲染省资源；不符合 canRenderDiagram 或渲染报错时回退 MessageCodeBlock；预览视图为 DiagramViewport。
 */
export function MessageDiagram({ source, streaming, t }: { source: string; streaming: boolean; t: Translate }) {
  const id = useId().replace(/[^a-z0-9]/giu, '')
  const { dark } = useMessageTheme()
  const [result, setResult] = useState<{ key: string; svg?: string; error?: boolean }>()
  const [preview, setPreview] = useState(false)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const { state, copy } = useCopyFeedback()
  const key = `${dark}:${source}`
  const eligible = !streaming && canRenderDiagram(source)
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  useEffect(() => {
    if (!eligible || !visible) return
    let active = true
    const saved = cache.get(key)
    if (saved) { setResult({ key, svg: saved }); return }
    const render = async () => {
      if (!active) return
      const [{ default: mermaid }, { default: purify }] = await Promise.all([import('mermaid'), import('dompurify')])
      if (!active) return
      const foreground = dark ? '#e5e5e5' : '#404040'
      const border = dark ? '#454545' : '#d8d8d8'
      const surface = dark ? '#262626' : '#f5f5f5'
      const background = dark ? '#262626' : '#ffffff'
      const accent = dark ? '#0c4a6e' : '#f0f9ff'
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        theme: 'base', fontFamily: 'ui-sans-serif, system-ui, sans-serif', maxTextSize: 20_000,
        themeVariables: { background, primaryColor: surface, primaryTextColor: foreground, primaryBorderColor: border,
          secondaryColor: accent, secondaryTextColor: foreground, secondaryBorderColor: border,
          tertiaryColor: background, tertiaryTextColor: foreground, tertiaryBorderColor: border,
          lineColor: dark ? '#aaa' : '#888', textColor: foreground, mainBkg: background, nodeBorder: border,
          actorBkg: background, actorBorder: border, actorTextColor: foreground, noteBkgColor: accent, noteTextColor: foreground, signalColor: foreground, signalTextColor: foreground },
      })
      const { svg } = await mermaid.render(`messageDiagram${id}`, source)
      const safe = purify.sanitize(svg, diagramSanitizeConfig)
      cache.set(key, safe)
      while (cache.size > 24) cache.delete(cache.keys().next().value!)
      if (active) setResult({ key, svg: safe })
    }
    queue = queue.then(render, render).catch(() => { if (active) setResult({ key, error: true }) })
    return () => { active = false }
  }, [eligible, visible, key, source, dark, id])
  const current = result?.key === key ? result : undefined
  if (!eligible || current?.error) return <MessageCodeBlock code={source} language="mermaid" streaming={streaming} t={t} />
  return <section className={blockCss.block} data-message-diagram>
    <div className={blockCss.header}><span className={blockCss.title}><MessageFileIcon language="mermaid" /><span>mermaid</span></span>
      <div className={blockCss.actions}>
        <button type="button" aria-label={t('预览图表', 'Preview diagram')} title={t('预览图表', 'Preview diagram')} disabled={!current?.svg} onClick={() => setPreview(true)}><Maximize2 size={14} aria-hidden="true" /></button>
        <button type="button" aria-label={state === 'copied' ? t('已复制', 'Copied') : t('复制代码', 'Copy code')} title={t('复制代码', 'Copy code')} onClick={() => { void copy(source) }}>{state === 'copied' ? <Check size={14} /> : <Copy size={14} />}</button>
      </div>
    </div>
    {current?.svg ? <div className={css.inline} role="img" aria-label={t('Mermaid 图表', 'Mermaid diagram')} onDoubleClick={() => setPreview(true)} dangerouslySetInnerHTML={{ __html: current.svg }} />
      : <div className={css.loading} role="status">{t('正在渲染图表…', 'Rendering diagram…')}</div>}
    {state === 'error' && <span className={blockCss.error} role="status">{t('复制失败', 'Copy failed')}</span>}
    <MessageDialog open={preview} onClose={() => setPreview(false)} title={t('图表预览', 'Diagram preview')} wide t={t}>
      {current?.svg && <DiagramViewport svg={current.svg} t={t} />}
    </MessageDialog>
  </section>
}

/** 预览视口的视图状态：平移偏移与缩放比例。 */
type View = { x: number; y: number; scale: number }
/**
 * 功能：图表全屏预览的交互视口：滚轮以光标为锚缩放（0.1–4x）、拖拽平移、键盘 +/-/f/方向键、自动适应视口。
 * @param svg 已消毒的 mermaid SVG 字符串
 * @param t 双语标签函数
 * 内部逻辑：fit 按 SVG viewBox 尺寸（缺省 600x400）计算居中缩放（0.1–2x），ResizeObserver 随容器尺寸重算；zoom 沿「锚点不动」的比例变换更新偏移；wheel 监听需 passive:false 才能 preventDefault。
 */
function DiagramViewport({ svg, t }: { svg: string; t: Translate }) {
  const viewport = useRef<HTMLDivElement>(null), picture = useRef<HTMLDivElement>(null)
  const bounds = useRef({ width: 1, height: 1 })
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const dragging = useRef<{ x: number; y: number; origin: View }>()
  function fit() {
    const box = viewport.current
    if (!box) return
    const { width, height } = bounds.current
    const scale = Math.max(.1, Math.min(2, (box.clientWidth - 48) / width, (box.clientHeight - 48) / height))
    setView({ scale, x: (box.clientWidth - width * scale) / 2, y: (box.clientHeight - height * scale) / 2 })
  }
  useBrowserLayoutEffect(() => {
    const element = picture.current?.querySelector('svg')
    if (!element || !viewport.current) return
    const parts = element.getAttribute('viewBox')?.split(/[ ,]+/u).map(Number)
    const width = parts?.[2] || Number.parseFloat(element.getAttribute('width') ?? '') || 600
    const height = parts?.[3] || Number.parseFloat(element.getAttribute('height') ?? '') || 400
    bounds.current = { width, height }
    element.style.width = `${width}px`; element.style.height = `${height}px`; element.style.maxWidth = 'none'
    fit()
    const observer = new ResizeObserver(fit); observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [svg])
  function zoom(next: number, point?: { x: number; y: number }) {
    const box = viewport.current
    if (!box) return
    const anchor = point ?? { x: box.clientWidth / 2, y: box.clientHeight / 2 }
    setView(old => { const scale = Math.max(.1, Math.min(4, next)); const ratio = scale / old.scale
      return { scale, x: anchor.x - (anchor.x - old.x) * ratio, y: anchor.y - (anchor.y - old.y) * ratio } })
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = dragging.current
    if (start) setView({ ...start.origin, x: start.origin.x + event.clientX - start.x, y: start.origin.y + event.clientY - start.y })
  }
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: globalThis.WheelEvent) => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      const point = { x: event.clientX - box.left, y: event.clientY - box.top }
      setView(old => {
        const scale = Math.max(.1, Math.min(4, old.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)))
        const ratio = scale / old.scale
        return { scale, x: point.x - (point.x - old.x) * ratio, y: point.y - (point.y - old.y) * ratio }
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])
  return <div className={css.preview}>
    <div className={css.toolbar}>
      <button type="button" onClick={() => zoom(view.scale / 1.25)} aria-label={t('缩小图表', 'Zoom out')}><Minus size={16} /></button>
      <output aria-label={t('缩放比例', 'Zoom level')}>{Math.round(view.scale * 100)}%</output>
      <button type="button" onClick={() => zoom(view.scale * 1.25)} aria-label={t('放大图表', 'Zoom in')}><Plus size={16} /></button>
      <button type="button" onClick={fit} aria-label={t('适应视口', 'Fit to view')}><Scan size={16} /></button>
    </div>
    <div ref={viewport} className={css.viewport} tabIndex={0} role="region" aria-label={t('图表，可缩放和平移', 'Diagram, zoomable and pannable')}
      onPointerDown={event => { if (event.button !== 0) return; dragging.current = { x: event.clientX, y: event.clientY, origin: view }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={pointerMove}
      onPointerUp={event => { dragging.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { dragging.current = undefined }}
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') zoom(view.scale * 1.25)
        else if (event.key === '-') zoom(view.scale / 1.25)
        else if (event.key.toLowerCase() === 'f' || event.key === 'Home') fit()
        else if (event.key.startsWith('Arrow')) setView(old => ({ ...old, x: old.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: old.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) }))
        else return
        event.preventDefault()
      }}>
      <div ref={picture} className={css.picture} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  </div>
}
