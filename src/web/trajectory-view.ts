/**
 * 轨迹导出 NDJSON 的客户端整形
 * （GET /api/conversations/:id/trajectory，由
 * src/server/conversation/trajectory.ts 组装——每一行形状的权威来源）。导出每行是
 * 带 `type` 标签的 JSON 对象；只有携带模型 IO 的行会成为调用卡片：
 *
 * - `request`  — 一次出站生成调用：`ts`、`task`、`request`（任务内序号）、
 *                `model`（`{provider, modelId}`）、`thinkingLevel`、`messageCount`、
 *                `messages`（pi-ai Message[]）。
 * - `response` — 该调用的末条助手消息：`ts`、`task`、`request`、`message`
 *                （pi-ai AssistantMessage：`content` 块、`usage.input`/`usage.output`、
 *                `model`、`errorMessage`、`durationMs`）。
 * - `sidecall` — 生成任务之外的模型调用（会话标题、压缩摘要、提交信息…）：`ts`、
 *                `purpose`、`model`、`startedAt`、`durationMs`、`input`，以及
 *                `answer`（AssistantMessage）或 `error`（字符串）二者之一。
 *
 * `conversation`/`entry`/`task` 行是持久转录，`catalog` 列出提供的工具，`tools`
 * 只带 entry id——它们都没有模型 IO，因此 `parseTrajectory` 丢弃。
 */

export interface TrajectoryModelRef {
  provider?: string
  modelId?: string
}

/** 一条 `request` 捕获行：一次生成调用的完整出站载荷。 */
export interface TrajectoryRequestLine {
  type: 'request'
  ts?: number
  task?: string
  request?: number
  model?: TrajectoryModelRef
  messages?: unknown[]
}

/** 一条 `response` 捕获行：一次生成调用的末条助手消息。 */
export interface TrajectoryResponseLine {
  type: 'response'
  ts?: number
  task?: string
  request?: number
  message?: unknown
}

/** 一条 `sidecall` 捕获行：生成任务之外的一次模型调用。 */
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

/** 三种带模型 IO 的导出行。 */
export type TrajectoryLine = TrajectoryRequestLine | TrajectoryResponseLine | TrajectorySidecallLine

/** 摘要行的角色（pi-ai role 的展示映射：toolResult → tool）。 */
export type TrajectoryRole = 'system' | 'user' | 'assistant' | 'tool'

/** 一条摘要后的输入消息：工具调用与工具结果各占一行。 */
export interface TrajectoryInputLine {
  role: TrajectoryRole
  /** tool-call 与 tool-result 行上的工具名。 */
  toolName?: string
  text: string
}

/** 卡片上的一条工具调用（名称 + 序列化参数）。 */
export interface TrajectoryToolCall {
  name: string
  arguments: string
}

/** 整形为时间线卡片的一次模型调用。 */
export interface TrajectoryCall {
  /** 按时间序的 1 起始序号。 */
  index: number
  /** 侧调用（标题/压缩/提交信息…）为 true，主会话为 false。 */
  side: boolean
  /** 侧调用的用途标签（捕获记录了才有）。 */
  purpose?: string
  modelId: string
  inputTokens: number
  outputTokens: number
  durationMs: number | null
  /** 调用开始的墙钟时间（epoch 毫秒）。 */
  timestamp: number | null
  input: TrajectoryInputLine[]
  outputText: string
  toolCalls: TrajectoryToolCall[]
  error: string | null
}

/** 头部汇总行：卡片数与 token 总量。 */
export interface TrajectorySummary {
  count: number
  inputTokens: number
  outputTokens: number
}

const IO_TYPES = new Set(['request', 'response', 'sidecall'])

/**
 * 功能：解析 NDJSON 导出文本：跳过损坏行、丢弃非 IO 类型。
 * @param text 轨迹导出全文
 * @returns TrajectoryLine 数组
 */
export function parseTrajectory(text: string): TrajectoryLine[] {
  const lines: TrajectoryLine[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue // 最后一行被截断不能污染其余导出。
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const type = (parsed as { type?: unknown }).type
    if (typeof type !== 'string' || !IO_TYPES.has(type)) continue
    lines.push(parsed as TrajectoryLine)
  }
  return lines
}

/** 卡片构建中的可变草稿；pendingKey 表示尚未等到配对响应。 */
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
  /** 响应未到时为 `${task}:${request}`。 */
  pendingKey: string | null
}

/**
 * 功能：把解析出的行整形为按时间排列的调用卡片。
 * @param lines parseTrajectory 的输出
 * @returns TrajectoryCall 数组（index 为 1 起始序号）
 * 内部逻辑：`response` 用捕获的 `task`/`request` 序号与 `request` 配对；配不到的响应并入最近的调用以免丢失 IO（无对象可并时自成一张卡）；sidecall 各自成卡。
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
      // 按捕获的 task/request 序号配对；配不到的响应并入上一张卡避免丢 IO
      // （没有可并对象时自成一张卡）。
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

/**
 * 功能：汇总所有卡片，供头部摘要行展示。
 * @returns 调用次数与输入/输出 token 总量
 */
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
/* 配对与整形                                                           */
/* ------------------------------------------------------------------ */

/** 生成 `${task}:${request}` 配对键；任一缺失返回 null。 */
function pairKey(task: string | undefined, request: number | undefined): string | null {
  return typeof task === 'string' && typeof request === 'number' ? `${task}:${request}` : null
}

/**
 * 功能：为响应寻找配对的待响应草稿：先按 key 精确匹配；没有精确配对时取最新的
 * 仍未闭合的请求；都没有返回 undefined（调用方并入上一张卡）。
 */
function takePending(drafts: CallDraft[], key: string | null): CallDraft | undefined {
  if (key !== null) {
    const exact = drafts.find(draft => draft.pendingKey === key)
    if (exact !== undefined) return exact
  }
  // 无精确配对：取最新的未闭合请求，否则由调用方并入上一张卡。
  for (let position = drafts.length - 1; position >= 0; position -= 1) {
    if (drafts[position]!.pendingKey !== null) return drafts[position]
  }
  return undefined
}

/** 取 modelId；model 引用缺失或无 modelId 返回空串。 */
function modelIdOf(model: TrajectoryModelRef | undefined): string {
  return typeof model?.modelId === 'string' ? model.modelId : ''
}

/** 把响应落到草稿上：输出文本、工具调用、usage、错误与时长（缺失时用 ts 差兜底）。 */
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

/** 无请求可配的响应：自成一张卡，保住它的 IO。 */
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

/** sidecall 行 → 草稿：purpose、模型（answer 兜底）、开始时间与时长、输入输出与错误。 */
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

/** 读助手消息 usage 中的 input/output 字段；缺失按 0 计。 */
function usageNumber(message: Record<string, unknown> | undefined, field: 'input' | 'output'): number {
  const usage = message === undefined ? undefined : asRecord(message.usage)
  return usage !== undefined && typeof usage[field] === 'number' ? usage[field] as number : 0
}

/* ------------------------------------------------------------------ */
/* 消息整形                                                             */
/* ------------------------------------------------------------------ */

/** 把出站 `messages` 数组整形为展示行。 */
function shapeMessages(messages: unknown): TrajectoryInputLine[] {
  if (!Array.isArray(messages)) return []
  const lines: TrajectoryInputLine[] = []
  for (const message of messages) lines.push(...shapeMessage(message))
  return lines
}

/** 单条消息 → 展示行：system/user 整体一行；toolResult 一行；assistant 的文本与每个工具调用各一行。 */
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

/** 侧调用输入是原始形态（提示词字符串、消息数组或任意载荷），按形态整形。 */
function shapeSidecallInput(input: unknown): TrajectoryInputLine[] {
  if (typeof input === 'string') return input === '' ? [] : [{ role: 'user', text: input }]
  if (Array.isArray(input) && input.some(message => asRecord(message)?.role !== undefined)) {
    return shapeMessages(input)
  }
  if (input === undefined || input === null) return []
  const text = stringify(input)
  return text === '' || text === '{}' || text === '[]' ? [] : [{ role: 'user', text }]
}

/** 把消息 content 摊平成文本；图片换成 `[image]` 占位。 */
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

/** 只取 content 里的 text 块，换行拼接。 */
function textParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record !== undefined && record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/** 抽出 content 里的 toolCall 块（名称 + 序列化参数）。 */
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

/** JSON 序列化；循环引用等失败时退回 String(value)。 */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** 值是对象（含数组）时窄化为 record；其他返回 undefined。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
