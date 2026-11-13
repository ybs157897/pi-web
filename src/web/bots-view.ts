import type { BotKnowledgeHealth, BotRoomFrame, BotStatus, BotCompliance } from '../shared/types.ts'
import { MENTION_PATTERN } from '../shared/mentions.ts'

const FRAME_HEADER = /^\[(USER(?:·owner)?|BOT:([^\]]+?)(?:·member)?|SYSTEM)\][ \t]?(?:\r?\n)?/

/**
 * Split one room log entry into its sender frame and body text. Entries without a frame
 * header are not part of the bot-room protocol, so the caller skips them. Both the plain
 * headers and the trust-envelope headers (`[USER·owner]`, `[BOT:name·member]`) parse.
 */
export function parseBotRoomFrame(text: string): BotRoomFrame | null {
  const match = FRAME_HEADER.exec(text)
  if (match === null) return null
  const header = match[1] ?? ''
  const sender = header.startsWith('USER') ? { kind: 'user' as const }
    : header === 'SYSTEM' ? { kind: 'system' as const }
      : { kind: 'bot' as const, name: match[2] ?? '' }
  return { sender, text: text.slice(match[0].length) }
}

const HEALTH_TONES: Record<BotKnowledgeHealth, { label: string; color: string }> = {
  fresh: { label: '知识新鲜', color: 'green' },
  stale: { label: '知识过期', color: 'orange' },
  drift: { label: '知识漂移', color: 'red' },
  'over-limit': { label: '超出限额', color: 'purple' },
  unknown: { label: '状态未知', color: 'default' },
}

const COMPLIANCE_TONES: Record<BotCompliance, { label: string; color: string }> = {
  complied: { label: '已回写 ✓', color: 'green' },
  stalled: { label: '回写停滞 ⚠', color: 'gold' },
  pending: { label: '待回写', color: 'default' },
}

const STATUS_TONES: Record<BotStatus, { label: string; color: string }> = {
  idle: { label: '空闲', color: 'var(--dsw-alias-label-tertiary, #999)' },
  busy: { label: '忙碌', color: 'rgb(65, 118, 230)' },
  error: { label: '出错', color: 'rgb(212, 80, 76)' },
}

export function knowledgeHealthTone(health: BotKnowledgeHealth): { label: string; color: string } {
  return HEALTH_TONES[health]
}

export function complianceTone(compliance: BotCompliance): { label: string; color: string } {
  return COMPLIANCE_TONES[compliance]
}

export function statusTone(status: BotStatus): { label: string; color: string } {
  return STATUS_TONES[status]
}

/** Compact glob summary for a roster card, e.g. `src/server/**, +2`. */
export function globsSummary(globs: readonly string[], max = 2): string {
  if (globs.length === 0) return '—'
  const shown = globs.slice(0, max).join(', ')
  return globs.length > max ? `${shown} +${globs.length - max}` : shown
}

/** Short relative time for lastActiveAt; an absent value reads as never active. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (iso === undefined) return '从未活动'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export type MentionSegment = { kind: 'text' | 'mention'; value: string }

/**
 * Split body text into plain segments and @mention chips. A token only counts as a
 * mention when it matches a name on the current roster (case-insensitive) or is `@all`.
 */
export function splitMentions(text: string, roster: ReadonlySet<string>): MentionSegment[] {
  const segments: MentionSegment[] = []
  const byLower = new Map([...roster].map(name => [name.toLowerCase(), name]))
  let cursor = 0
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const token = match[1] ?? ''
    const canonical = token.toLowerCase() === 'all' ? 'all' : byLower.get(token.toLowerCase())
    if (canonical === undefined) continue
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', value: text.slice(cursor, start) })
    segments.push({ kind: 'mention', value: canonical })
    cursor = start + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) })
  return segments
}
