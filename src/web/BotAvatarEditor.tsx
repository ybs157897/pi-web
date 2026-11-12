import { useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Modal, Slider } from 'antd'
import type { BotRecord } from '../shared/types.ts'
import { BOT_AVATAR_COLORS, BOT_COLOR_POOL, BOT_SHAPE_POOL } from './bot-avatar/shapes.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './BotAvatarEditor.module.css'

/** Crop output matches the app: a 256×256 square, the same size the original editor produced. */
const CROP_PX = 256

type Crop = {
  url: string
  width: number
  height: number
  /** Multiplier over the cover scale; 1 = the image just covers the square. */
  zoom: number
  offsetX: number
  offsetY: number
}

function coverScale(width: number, height: number): number {
  return CROP_PX / Math.min(width, height)
}

/** Display geometry of the image inside the 256 square for the current crop state. */
function geometry(crop: Crop): { left: number; top: number; width: number; height: number } {
  const scale = coverScale(crop.width, crop.height) * crop.zoom
  const width = crop.width * scale
  const height = crop.height * scale
  return { left: (CROP_PX - width) / 2 + crop.offsetX, top: (CROP_PX - height) / 2 + crop.offsetY, width, height }
}

function clampOffset(crop: Crop, offsetX: number, offsetY: number): { offsetX: number; offsetY: number } {
  const scale = coverScale(crop.width, crop.height) * crop.zoom
  const limitX = Math.max(0, (crop.width * scale - CROP_PX) / 2)
  const limitY = Math.max(0, (crop.height * scale - CROP_PX) / 2)
  return {
    offsetX: Math.max(-limitX, Math.min(limitX, offsetX)),
    offsetY: Math.max(-limitY, Math.min(limitY, offsetY)),
  }
}

/**
 * Grok Bot's avatar editor: pick a silhouette and palette, or drop in a photo and crop it
 * against the same square mask the roster uses.
 */
export function BotAvatarEditorModal({ bot, open, onClose, onSaved }: {
  bot: BotRecord | undefined
  open: boolean
  onClose: () => void
  onSaved: (bot: BotRecord) => void
}) {
  const { t } = useUiPreferences()
  const { message } = AntdApp.useApp()
  const [shape, setShape] = useState<string | undefined>(bot?.avatarShape)
  const [color, setColor] = useState<string | undefined>(bot?.avatarColor)
  const [crop, setCrop] = useState<Crop>()
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState(1.4)
  const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setShape(bot?.avatarShape)
    setColor(bot?.avatarColor)
    setCrop(undefined)
    setZoom(1.4)
  }, [open, bot])

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      setCrop({ url, width: image.naturalWidth, height: image.naturalHeight, zoom: 1, offsetX: 0, offsetY: 0 })
      setZoom(1)
    }
    image.onerror = () => { URL.revokeObjectURL(url); message.error(t('无法读取这张图片', 'That image could not be read')) }
    image.src = url
  }

  const setCropZoom = (next: number): void => {
    setZoom(next)
    if (crop === undefined) return
    setCrop({ ...crop, zoom: next, ...clampOffset({ ...crop, zoom: next }, crop.offsetX, crop.offsetY) })
  }

  const save = async (): Promise<void> => {
    if (bot === undefined) return
    setBusy(true)
    try {
      let saved: BotRecord
      if (crop === undefined) {
        saved = (await api.updateBot(bot.id, { avatarShape: shape ?? undefined, avatarColor: color ?? undefined })).bot
      } else {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image()
          element.onload = () => resolve(element)
          element.onerror = () => reject(new Error('image load failed'))
          element.src = crop.url
        })
        const canvas = document.createElement('canvas')
        canvas.width = CROP_PX
        canvas.height = CROP_PX
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('2d context unavailable')
        const box = geometry(crop)
        context.drawImage(image, box.left, box.top, box.width, box.height)
        saved = (await api.setBotAvatarImage(bot.id, canvas.toDataURL('image/png'))).bot
      }
      onSaved(saved)
      onClose()
    } catch (cause) {
      message.error(t('保存头像失败', 'Could not save the avatar') + `：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  const removePhoto = async (): Promise<void> => {
    if (bot === undefined) return
    setBusy(true)
    try {
      onSaved((await api.clearBotAvatarImage(bot.id)).bot)
      onClose()
    } catch (cause) {
      message.error(t('移除照片失败', 'Could not remove the photo') + `：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  const box = crop === undefined ? undefined : geometry(crop)
  return <Modal open={open} onCancel={onClose} width={560}
    title={t('编辑头像', 'Edit avatar')} okText={t('保存', 'Save')} cancelText={t('取消', 'Cancel')}
    okButtonProps={{ loading: busy }} onOk={() => { void save() }}>
    <div className={css.editor}>
      <div className={css.stage}>
        {crop === undefined
          ? <BotAvatar id={bot?.id ?? 'preview'} name={bot?.name} shape={shape} color={color}
            image={bot?.avatarImage} size="xl" animated={false} />
          : <div className={css.crop}
            onPointerDown={event => {
              drag.current = { x: event.clientX, y: event.clientY, offsetX: crop.offsetX, offsetY: crop.offsetY }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={event => {
              const start = drag.current
              if (start === undefined) return
              const next = clampOffset(crop, start.offsetX + event.clientX - start.x, start.offsetY + event.clientY - start.y)
              setCrop({ ...crop, ...next })
            }}
            onPointerUp={() => { drag.current = undefined }}
            onPointerCancel={() => { drag.current = undefined }}>
            <img src={crop.url} alt="" draggable={false}
              style={{ width: box?.width, height: box?.height, left: box?.left, top: box?.top }} />
            <span className={css.cropRing} aria-hidden />
          </div>}
      </div>
      <div className={css.controls}>
        <div className={css.row}>
          <span className={css.label}>{t('形状', 'Shape')}</span>
          <div className={css.swatches}>
            {BOT_SHAPE_POOL.map(name => <button key={name} type="button" title={name}
              className={css.shapeButton} data-active={shape === name || undefined}
              onClick={() => { setShape(name); setCrop(undefined) }}>
              <BotAvatar id={`shape-${name}`} name={name} shape={name} color={color ?? 'black'} size="md" animated={false} />
            </button>)}
          </div>
        </div>
        <div className={css.row}>
          <span className={css.label}>{t('颜色', 'Color')}</span>
          <div className={css.colors}>
            {BOT_COLOR_POOL.map(name => <button key={name} type="button" title={name}
              className={css.colorButton} data-active={color === name || undefined}
              style={{ background: BOT_AVATAR_COLORS[name as keyof typeof BOT_AVATAR_COLORS].lightTo }}
              aria-label={name}
              onClick={() => { setColor(name); setCrop(undefined) }} />)}
          </div>
        </div>
        {crop === undefined
          ? <div className={css.photoRow}>
            <Button size="small" onClick={() => { fileInput.current?.click() }}>{t('上传照片', 'Upload photo')}</Button>
            {bot?.avatarImage !== undefined && <Button size="small" danger type="text" onClick={() => { void removePhoto() }}>{t('移除照片', 'Remove photo')}</Button>}
          </div>
          : <div className={css.zoomRow}>
            <span className={css.label}>{t('缩放', 'Zoom')}</span>
            <Slider min={1} max={3} step={0.01} value={zoom} onChange={setCropZoom} className={css.zoomSlider} />
            <Button size="small" type="text" onClick={() => { setCrop(undefined) }}>{t('取消裁剪', 'Cancel crop')}</Button>
          </div>}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden
          onChange={event => { void pickFile(event.target.files?.[0]) }} />
        <p className={css.hint}>{t('照片会居中裁成 256×256 的圆；不传照片就用形状与颜色。', 'Photos crop to a 256×256 circle; without one the shape and color are used.')}</p>
      </div>
    </div>
  </Modal>
}
