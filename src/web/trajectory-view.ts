/**
 * Client-side shaping for the trajectory export NDJSON
 * (GET /api/conversations/:id/trajectory, assembled by
 * src/server/conversation/trajectory.ts — the authoritative source for every
 * line shape). Each export line is a JSON object tagged with a `type`; only
 * lines carrying model IO become call cards:
 *
 * - `request`  — one outbound generation call: `ts`, `task`, `request` (its
 *                number within the task), `model` (`{provider, modelId}`),
 *                `thinkingLevel`, `messageCount`, `messages` (pi-ai Message[]).
 * - `response` — the terminal assistant message of that call: `ts`, `task`,
 *                `request`, `message` (pi-ai AssistantMessage: `content`
 *                blocks, `usage.input`/`usage.output`, `model`, `errorMessage`,
 *                `durationMs`).
 * - `sidecall` — one model call outside the generation task (session title,
 *                compaction summary, commit message…): `ts`, `purpose`,
 *                `model`, `startedAt`, `durationMs`, `input`, and either
 *                `answer` (AssistantMessage) or `error` (string).
 *
 * `conversation`/`entry`/`task` lines are the durable transcript, `catalog`
 * lists the offered tools and `tools` carries entry ids only — none of them
 * have model IO, so `parseTrajectory` drops them.
 */

export interface TrajectoryModelRef {
  provider?: string
  modelId?: string
}

/** A `request` capture line: the exact outbound payload of one generation call. */
export interface TrajectoryRequestLine {
  type: 'request'
  ts?: number
  task?: string
  request?: number
  model?: TrajectoryModelRef
  messages?: unknown[]
}

/** A `response` capture line: the terminal assistant message of one generation call. */
export interface TrajectoryResponseLine {
  type: 'response'
  ts?: number
  task?: string
  request?: number
  message?: unknown
}

/** A `sidecall` capture line: one model call outside the generation task. */
export interface TrajectorySidecallLine {
  type: 'sidecall'
  ts?: number
  purpose?: string
  model?: TrajectoryModelRef
  startedAt?: number
  durationMs?: number
  input?: unknown
  answer?: unknown
  error?: string
}

export type TrajectoryLine = TrajectoryRequestLine | TrajectoryResponseLine | TrajectorySidecallLine

export type TrajectoryRole = 'system' | 'user' | 'assistant' | 'tool'

/** One summarized input message: tool calls and tool results become their own lines. */
export interface TrajectoryInputLine {
  role: TrajectoryRole
  /** Tool name on tool-call and tool-result lines. */
  toolName?: string
  text: string
}

export interface TrajectoryToolCall {
  name: string
  arguments: string
}

/** One model call shaped for the timeline card. */
export interface TrajectoryCall {
  /** 1-based chronological order. */
  index: number
  /** True for side calls (title, compaction, commit message…), false for the main conversation. */
  side: boolean
  /** Side-call purpose label, when the capture recorded one. */
  purpose?: string
  modelId: string
  inputTokens: number
  outputTokens: number
  durationMs: number | null
  /** Clock time (ms since epoch) the call started. */
  timestamp: number | null
  input: TrajectoryInputLine[]
  outputText: string
  toolCalls: TrajectoryToolCall[]
  error: string | null
}

export interface TrajectorySummary {
  count: number
  inputTokens: number
  outputTokens: number
}

const IO_TYPES = new Set(['request', 'response', 'sidecall'])

/** Parses the NDJSON export, skipping corrupt lines and dropping non-IO types. */
export function parseTrajectory(text: string): TrajectoryLine[] {
  const lines: TrajectoryLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue // A torn last line must not poison the rest of the export.
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const type = (parsed as { type?: unknown }).type
    if (typeof type !== 'string' || !IO_TYPES.has(type)) continue
    lines.push(parsed as TrajectoryLine)
  }
  return lines
}

interface CallDraft {
  side: boolean
  purpose?: string
  modelId: string
  timestamp: number | null
  durationMs: number | null
  input: TrajectoryInputLine[]
  outputText: string
  toolCalls: TrajectoryToolCall[]
  error: string | null
  inputTokens: number
  outputTokens: number
  /** `${task}:${request}` while the call has not seen its response yet. */
  pendingKey: string | null
}

/**
 * Shapes the parsed lines into chronological call cards. A `response` is paired
 * with its `request` by the captured `task`/`request` numbers; a response whose
 * pair cannot be found merges into the most recent call so its IO is not lost
 * (or opens its own card when there is nothing to merge into).
 */
export function buildCallCards(lines: readonly TrajectoryLine[]): TrajectoryCall[] {
  const drafts: CallDraft[] = []
  for (const line of lines) {
    if (line.type === 'request') {
      drafts.push({
        side: false,
        modelId: modelIdOf(line.model),
        timestamp: typeof line.ts === 'number' ? line.ts : null,
        durationMs: null,
        input: shapeMessages(line.messages),
        outputText: '',
        toolCalls: [],
        error: null,
        inputTokens: 0,
        outputTokens: 0,
        pendingKey: pairKey(line.task, line.request),
      })
      continue
    }
    if (line.type === 'response') {
      // Pair by the captured task/request numbers; an unpairable response joins
      // the previous card so its IO is not lost (or opens its own card when
      // there is nothing to join).
      const draft = takePending(drafts, pairKey(line.task, line.request))
        ?? (drafts.length > 0 ? drafts[drafts.length - 1] : undefined)
      if (draft === undefined) {
        drafts.push(responseDraft(line))
        continue
      }
      applyResponse(draft, line)
      continue
    }
    drafts.push(sidecallDraft(line))
  }
  return drafts.map((draft, position) => ({
    index: position + 1,
    side: draft.side,
    ...(draft.purpose === undefined ? {} : { purpose: draft.purpose }),
    modelId: draft.modelId,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    durationMs: draft.durationMs,
    timestamp: draft.timestamp,
    input: draft.input,
    outputText: draft.outputText,
    toolCalls: draft.toolCalls,
    error: draft.error,
  }))
}

/** Totals the cards for the header summary line. */
export function summarizeCalls(cards: readonly TrajectoryCall[]): TrajectorySummary {
  let inputTokens = 0
  let outputTokens = 0
  for (const card of cards) {
    inputTokens += card.inputTokens
    outputTokens += card.outputTokens
  }
  return { count: cards.length, inputTokens, outputTokens }
}

/* ------------------------------------------------------------------ */
/* Pairing and shaping                                                 */
/* ------------------------------------------------------------------ */

function pairKey(task: string | undefined, request: number | undefined): string | null {
  return typeof task === 'string' && typeof request === 'number' ? `${task}:${request}` : null
}

function takePending(drafts: CallDraft[], key: string | null): CallDraft | undefined {
  if (key !== null) {
    const exact = drafts.find(draft => draft.pendingKey === key)
    if (exact !== undefined) return exact
  }
  // No exact pair: the newest still-open request, else the caller merges into
  // the previous card.
  for (let position = drafts.length - 1; position >= 0; position -= 1) {
    if (drafts[position]!.pendingKey !== null) return drafts[position]
  }
  return undefined
}

function modelIdOf(model: TrajectoryModelRef | undefined): string {
  return typeof model?.modelId === 'string' ? model.modelId : ''
}

function applyResponse(draft: CallDraft, line: TrajectoryResponseLine): void {
  draft.pendingKey = null
  const message = asRecord(line.message)
  if (message === undefined) return
  draft.outputText = textParts(message.content)
  draft.toolCalls = toolCallsOf(message.content)
  const usage = asRecord(message.usage)
  if (usage !== undefined) {
    if (typeof usage.input === 'number') draft.inputTokens = usage.input
    if (typeof usage.output === 'number') draft.outputTokens = usage.output
  }
  if (typeof message.errorMessage === 'string' && message.errorMessage !== '') draft.error = message.errorMessage
  if (typeof message.durationMs === 'number') draft.durationMs = message.durationMs
  else if (draft.durationMs === null && typeof line.ts === 'number' && draft.timestamp !== null) {
    draft.durationMs = Math.max(0, line.ts - draft.timestamp)
  }
}

/** A response with no request to join: kept as its own card so its IO survives. */
function responseDraft(line: TrajectoryResponseLine): CallDraft {
  const message = asRecord(line.message)
  return {
    side: false,
    modelId: message !== undefined && typeof message.model === 'string' ? message.model : '',
    timestamp: typeof line.ts === 'number' ? line.ts : null,
    durationMs: null,
    input: [],
    outputText: message === undefined ? '' : textParts(message.content),
    toolCalls: message === undefined ? [] : toolCallsOf(message.content),
    error: message !== undefined && typeof message.errorMessage === 'string' && message.errorMessage !== ''
      ? message.errorMessage
      : null,
    inputTokens: usageNumber(message, 'input'),
    outputTokens: usageNumber(message, 'output'),
    pendingKey: null,
  }
}

function sidecallDraft(line: TrajectorySidecallLine): CallDraft {
  const answer = asRecord(line.answer)
  return {
    side: true,
    purpose: typeof line.purpose === 'string' && line.purpose !== '' ? line.purpose : undefined,
    modelId: modelIdOf(line.model) || (answer !== undefined && typeof answer.model === 'string' ? answer.model : ''),
    timestamp: typeof line.startedAt === 'number' ? line.startedAt : typeof line.ts === 'number' ? line.ts : null,
    durationMs: typeof line.durationMs === 'number' ? line.durationMs : null,
    input: shapeSidecallInput(line.input),
    outputText: answer === undefined ? '' : textParts(answer.content),
    toolCalls: answer === undefined ? [] : toolCallsOf(answer.content),
    error: typeof line.error === 'string' && line.error !== ''
      ? line.error
      : answer !== undefined && typeof answer.errorMessage === 'string' && answer.errorMessage !== ''
        ? answer.errorMessage
        : null,
    inputTokens: usageNumber(answer, 'input'),
    outputTokens: usageNumber(answer, 'output'),
    pendingKey: null,
  }
}

function usageNumber(message: Record<string, unknown> | undefined, field: 'input' | 'output'): number {
  const usage = message === undefined ? undefined : asRecord(message.usage)
  return usage !== undefined && typeof usage[field] === 'number' ? usage[field] as number : 0
}

/* ------------------------------------------------------------------ */
/* Message shaping                                                     */
/* ------------------------------------------------------------------ */

/** Shapes an outbound `messages` array into display lines. */
function shapeMessages(messages: unknown): TrajectoryInputLine[] {
  if (!Array.isArray(messages)) return []
  const lines: TrajectoryInputLine[] = []
  for (const message of messages) lines.push(...shapeMessage(message))
  return lines
}

function shapeMessage(message: unknown): TrajectoryInputLine[] {
  const record = asRecord(message)
  const role = record === undefined || typeof record.role !== 'string' ? undefined : record.role
  if (record === undefined) return []
  if (role === 'system' || role === 'user') return [{ role, text: contentText(record.content) }]
  if (role === 'toolResult') {
    return [{
      role: 'tool',
      ...(typeof record.toolName === 'string' && record.toolName !== '' ? { toolName: record.toolName } : {}),
      text: contentText(record.content),
    }]
  }
  if (role === 'assistant') {
    const lines: TrajectoryInputLine[] = []
    const text = textParts(record.content)
    if (text !== '') lines.push({ role: 'assistant', text })
    for (const call of toolCallsOf(record.content)) {
      lines.push({ role: 'assistant', toolName: call.name, text: call.arguments })
    }
    return lines
  }
  return []
}

/** Side-call input arrives raw (prompt string, message array, or any payload). */
function shapeSidecallInput(input: unknown): TrajectoryInputLine[] {
  if (typeof input === 'string') return input === '' ? [] : [{ role: 'user', text: input }]
  if (Array.isArray(input) && input.some(message => asRecord(message)?.role !== undefined)) {
    return shapeMessages(input)
  }
  if (input === undefined || input === null) return []
  const text = stringify(input)
  return text === '' || text === '{}' || text === '[]' ? [] : [{ role: 'user', text }]
}

/** Flattens message content to text; images become a placeholder. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (record.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record !== undefined && record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function toolCallsOf(content: unknown): TrajectoryToolCall[] {
  if (!Array.isArray(content)) return []
  const calls: TrajectoryToolCall[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined || record.type !== 'toolCall') continue
    calls.push({
      name: typeof record.name === 'string' && record.name !== '' ? record.name : 'unknown',
      arguments: stringify(record.arguments),
    })
  }
  return calls
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
