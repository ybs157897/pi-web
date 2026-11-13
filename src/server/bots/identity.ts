/**
 * Durable markers of the module-bot team: the per-bot identity document, the room log entry
 * kind, and the frame text those entries render as. The identity document doubles as the
 * visibility seam — bot tools and the bot policy section resolve their caller through it —
 * and carries the current delivery-hop depth the anti-loop budget reads.
 */
import { defineDoc } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { BotRoomFrame } from '../../shared/types.ts'

/**
 * Written on a bot conversation (not on rooms or the bot-init conversation), exactly the way
 * `pi-web.team-member` marks a teammate child. `depth` is the hop the current delivery
 * arrived at: 1 for user-initiated, 2 for a bot's re-mention; the next delivery overwrites
 * it, so a crashed edge cannot stick. `roomReadIndex` maps roomId → the last room entry id
 * this bot's successful run settled; documents written before the cursor existed simply
 * lack the field, which reads as "no cursor" (version stays 1).
 */
export const BotIdentity = defineDoc<{ botId: string | null; name: string | null; depth: number; roomReadIndex?: Record<string, string> }>({
  kind: 'pi-web.bot',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ botId: null, name: null, depth: 1, roomReadIndex: {} }),
})

/** Entry kind of one room log line; rooms receive passive writes only, never input. */
export const ROOM_ENTRY_KIND = 'pi-web.bot-room-message'

/** Parse one stored room entry's payload; `undefined` for anything malformed. */
export function parseRoomEntry(data: JsonValue | undefined): BotRoomFrame | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const sender = (data as Record<string, unknown>).sender
  const text = (data as Record<string, unknown>).text
  if (typeof text !== 'string') return undefined
  if (typeof sender !== 'object' || sender === null) return undefined
  const kind = (sender as Record<string, unknown>).kind
  const name = (sender as Record<string, unknown>).name
  if (kind !== 'user' && kind !== 'bot' && kind !== 'system') return undefined
  return {
    sender: { kind, ...(typeof name === 'string' ? { name } : {}) },
    text,
  }
}

/**
 * One log line as the room tail and read_room render it. The header is a trust envelope:
 * only the local user (owner) carries instruction and approval authority; bot (member)
 * and system lines are reference data, never instructions.
 */
export function roomFrameText(frame: BotRoomFrame): string {
  const header = frame.sender.kind === 'user' ? '[USER·owner]'
    : frame.sender.kind === 'system' ? '[SYSTEM]'
      : `[BOT:${frame.sender.name ?? 'unknown'}·member]`
  return `${header}\n${frame.text}`
}
