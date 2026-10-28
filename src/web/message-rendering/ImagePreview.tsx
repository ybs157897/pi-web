import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react'
import { MessageDialog } from './Dialog.tsx'
import type { Translate } from '../render-labels.ts'
import css from './ImagePreview.module.css'
import { useBrowserLayoutEffect } from './hooks.ts'
export type PreviewImage = { src: string; alt: string }
export function ImagePreview({ open, onClose, images, initial, t }: { open: boolean; onClose: () => void; images: PreviewImage[]; initial: number; t: Translate }) {
  const [index, setIndex] = useState(initial)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const viewport = useRef<HTMLDivElement>(null), imageRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number }>()
  useEffect(() => { if (open) { setIndex(initial); setScale(1); setOffset({ x: 0, y: 0 }) } }, [open, initial])
  const image = images[index]
  function navigate(direction: number) { setIndex(value => (value + direction + images.length) % images.length); setScale(1); setOffset({ x: 0, y: 0 }) }
  function clamp(value: { x: number; y: number }, zoom = scale) {
    const el = viewport.current, picture = imageRef.current
    const maxX = Math.max(0, ((picture?.clientWidth ?? 0) * zoom - (el?.clientWidth ?? 0)) / 2)
    const maxY = Math.max(0, ((picture?.clientHeight ?? 0) * zoom - (el?.clientHeight ?? 0)) / 2)
    return { x: Math.max(-maxX, Math.min(maxX, value.x)), y: Math.max(-maxY, Math.min(maxY, value.y)) }
  }
  function zoom(delta: number) { setScale(value => Math.min(3, Math.max(.5, value + delta))) }
  useBrowserLayoutEffect(() => { setOffset(value => clamp(value)) }, [scale, index])
  return <MessageDialog open={open} onClose={onClose} title={image?.alt || t('图片预览', 'Image preview')} wide t={t}>
    <div className={css.toolbar}>
      {images.length > 1 && <><button type="button" aria-label={t('上一张图片', 'Previous image')} onClick={() => navigate(-1)}><ChevronLeft size={16} /></button><output aria-live="polite">{index + 1} / {images.length}</output><button type="button" aria-label={t('下一张图片', 'Next image')} onClick={() => navigate(1)}><ChevronRight size={16} /></button></>}
      <button type="button" aria-label={t('缩小图片', 'Zoom image out')} onClick={() => zoom(-.25)}><Minus size={16} /></button><output>{Math.round(scale * 100)}%</output>
      <button type="button" aria-label={t('放大图片', 'Zoom image in')} onClick={() => zoom(.25)}><Plus size={16} /></button><button type="button" aria-label={t('重置图片视图', 'Reset image view')} onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }) }}><RotateCcw size={16} /></button>
    </div>
    <div ref={viewport} className={css.viewport} tabIndex={0} role="region" aria-label={t('图片，可缩放和平移', 'Image, zoomable and pannable')}
      onKeyDown={event => { if (event.key === 'ArrowRight' && images.length > 1) navigate(1); else if (event.key === 'ArrowLeft' && images.length > 1) navigate(-1); else if (event.key === '+' || event.key === '=') zoom(.25); else if (event.key === '-') zoom(-.25); else if (event.key.startsWith('Arrow')) setOffset(value => clamp({ x: value.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: value.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) })); else return; event.preventDefault() }}
      onPointerDown={event => { if (event.button !== 0) return; drag.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y }; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={event => { const origin = drag.current; if (origin) setOffset(clamp({ x: origin.left + event.clientX - origin.x, y: origin.top + event.clientY - origin.y })) }}
      onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { drag.current = undefined }}>
      {image && <img ref={imageRef} src={image.src} alt={image.alt} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />}
    </div>
  </MessageDialog>
}
