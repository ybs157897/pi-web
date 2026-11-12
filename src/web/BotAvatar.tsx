import { useId, useRef } from 'react'
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, BOT_COLOR_POOL, BOT_DEFAULT_SHAPE_POOL } from './bot-avatar/shapes.ts'
import type { BotAvatarColor, BotAvatarShape } from './bot-avatar/shapes.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './BotAvatar.module.css'

/** Avatar tiers observed in Grok Bot: 16 / 22 / 28 / 36 / 72 with 28 as the default. */
export type BotAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/** The subset of Grok Bot's 53 avatar states this roster actually drives. */
export type BotAvatarState =
  | 'idle' | 'thinking' | 'working' | 'streaming' | 'waiting' | 'failed' | 'happy' | 'sleeping'

const SIZE_PX: Record<BotAvatarSize, number> = { xs: 16, sm: 22, md: 28, lg: 36, xl: 72 }

const SHAPE_SET = new Set<string>(Object.keys(BOT_AVATAR_SHAPES))
const COLOR_SET = new Set<string>(BOT_COLOR_POOL)

/** 32-bit mixer; two seeds keep shape and color independent for the same id. */
function mix(value: string, seed: number): number {
  let hash = seed | 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 2654435769)
  }
  hash = Math.imul(hash ^ (hash >>> 16), 73244475)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
  return (hash ^ (hash >>> 16)) >>> 0
}

/**
 * Stored avatar beats the hash default; an unknown stored value falls back to the hash too,
 * so a hand-edited app-state file can never blank out a roster row.
 */
export function resolveBotAvatar(
  id: string,
  shape?: string,
  color?: string,
): { shape: BotAvatarShape; color: BotAvatarColor } {
  const resolvedShape = shape !== undefined && SHAPE_SET.has(shape)
    ? shape as BotAvatarShape
    : BOT_DEFAULT_SHAPE_POOL[mix(id, 1) % BOT_DEFAULT_SHAPE_POOL.length]!
  const resolvedColor = color !== undefined && COLOR_SET.has(color)
    ? color as BotAvatarColor
    : BOT_COLOR_POOL[mix(id, 2) % BOT_COLOR_POOL.length]!
  return { shape: resolvedShape, color: resolvedColor }
}

/**
 * Shape fill plus two eye cut-outs; the eyes read as whatever surface the avatar sits on.
 * Animation follows Grok Bot's anatomy: the body breathes, the eyes blink on a slow clock,
 * and `follow` lets the pupils drift toward the pointer.
 */
export function BotAvatar({ id, name, shape, color, image, size = 'md', state = 'idle', animated = true, follow = false, className }: {
  id: string
  name?: string
  shape?: string
  color?: string
  /** Uploaded photo; takes precedence over the procedural silhouette. */
  image?: string
  size?: BotAvatarSize
  state?: BotAvatarState
  animated?: boolean
  follow?: boolean
  className?: string
}) {
  const { dark } = useUiPreferences()
  const uid = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const resolved = resolveBotAvatar(id, shape, color)
  const silhouette = BOT_AVATAR_SHAPES[resolved.shape]
  const [x, y, width, height] = silhouette.viewBox.split(' ').map(Number) as [number, number, number, number]
  const palette = BOT_AVATAR_COLORS[resolved.color]
  const side = Math.min(width, height)
  const eyeWidth = side * 0.093
  const eyeHeight = side * 0.164
  const eyeGap = side * 0.086
  const eyeRadius = eyeWidth / 2
  const centerX = x + width / 2
  const centerY = y + height / 2 - side * 0.05
  const eyeTop = centerY - eyeHeight / 2
  const px = SIZE_PX[size]
  if (image !== undefined && image !== '') {
    return <img
      className={`${css.photo} ${className ?? ''}`}
      src={image}
      width={px}
      height={px}
      alt={name === undefined ? '' : `${name} avatar`}
      aria-hidden={name === undefined ? true : undefined}
      data-bot-avatar={resolved.shape}
      data-bot-avatar-color={resolved.color}
      data-bot-avatar-photo=""
      draggable={false}
    />
  }
  // Pointer tracking writes CSS variables straight onto the SVG: no re-render per move, and the
  // same mechanism works inside any song list, chat row or dialog.
  const track = follow
    ? (event: React.PointerEvent<SVGSVGElement>): void => {
      const node = svgRef.current
      if (node === null) return
      const box = node.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return
      const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2)
      const dy = (event.clientY - (box.top + box.height / 2)) / (box.height / 2)
      const limit = side * 0.028
      // Same sign as the pointer offset: positive dx moves the pupils right, positive dy down.
      node.style.setProperty('--gaze-x', `${(Math.max(-1, Math.min(1, dx)) * limit).toFixed(2)}px`)
      node.style.setProperty('--gaze-y', `${(Math.max(-1, Math.min(1, dy)) * limit).toFixed(2)}px`)
    }
    : undefined
  return <svg
    ref={svgRef}
    className={`${css.avatar} ${className ?? ''}`}
    data-bot-avatar={resolved.shape}
    data-bot-avatar-color={resolved.color}
    data-bot-avatar-state={state}
    data-bot-avatar-animated={animated ? '' : undefined}
    width={px}
    height={px}
    viewBox={silhouette.viewBox}
    role="img"
    aria-label={name === undefined ? undefined : `${name} avatar`}
    aria-hidden={name === undefined ? true : undefined}
    focusable="false"
    onPointerMove={track}
    onPointerLeave={track === undefined ? undefined : () => {
      const node = svgRef.current
      if (node === null) return
      node.style.setProperty('--gaze-x', '0px')
      node.style.setProperty('--gaze-y', '0px')
    }}
  >
    <defs>
      <linearGradient id={`bot-avatar-fill-${uid}`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={dark ? palette.darkFrom : palette.lightFrom} />
        <stop offset="1" stopColor={dark ? palette.darkTo : palette.lightTo} />
      </linearGradient>
      <mask id={`bot-avatar-mask-${uid}`} maskUnits="userSpaceOnUse" x={x} y={y} width={width} height={height}>
        <path d={silhouette.d} fill="#fff" fillRule="evenodd" />
        <g className={css.eyes}>
          <g className={css.eyeState}>
            <rect className={css.eyeBlink} x={centerX - eyeGap / 2 - eyeWidth} y={eyeTop} width={eyeWidth} height={eyeHeight} rx={eyeRadius} fill="#000" />
            <rect className={css.eyeBlink} x={centerX + eyeGap / 2} y={eyeTop} width={eyeWidth} height={eyeHeight} rx={eyeRadius} fill="#000" />
          </g>
        </g>
      </mask>
    </defs>
    <g className={css.body}>
      <rect x={x} y={y} width={width} height={height} fill={`url(#bot-avatar-fill-${uid})`} mask={`url(#bot-avatar-mask-${uid})`} />
    </g>
  </svg>
}

/** Group chats show the roster stack; Grok Bot falls back to member avatars for room icons. */
export function BotAvatarStack({ members, size = 'sm', className }: {
  members: ReadonlyArray<{ id: string; name?: string; avatarShape?: string; avatarColor?: string; avatarImage?: string }>
  size?: BotAvatarSize
  className?: string
}) {
  const shown = members.slice(0, 3)
  return <span className={`${css.stack} ${className ?? ''}`} data-bot-avatar-stack="">
    {shown.map(member => <BotAvatar key={member.id} id={member.id} name={member.name} animated={false}
      shape={member.avatarShape} color={member.avatarColor} image={member.avatarImage} size={size} />)}
  </span>
}
