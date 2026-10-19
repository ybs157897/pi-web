import type { ChatMessage, ContentBlock, FileArtifact, MessageUsage } from '../shared/types.ts'

export interface ToolItem {
  readonly key: string
  readonly message: ChatMessage
  readonly call?: Extract<ContentBlock, { type: 'toolCall' }>
  readonly result?: ChatMessage
  readonly parentToolCallId?: string
  readonly children: readonly ToolItem[]
  readonly order: number
}

export type ProcessPart =
  | { readonly kind: 'user'; readonly key: string; readonly message: ChatMessage; readonly order: number }
  | { readonly kind: 'reasoning'; readonly key: string; readonly message: ChatMessage; readonly text: string; readonly redacted: boolean; readonly order: number }
  | { readonly kind: 'content'; readonly key: string; readonly message: ChatMessage; readonly block: ContentBlock; readonly order: number }
  | { readonly kind: 'tool'; readonly key: string; readonly item: ToolItem; readonly order: number }

export interface ResponsePart {
  readonly key: string
  readonly message: ChatMessage
  readonly blocks: readonly ContentBlock[]
}

/** DSH's tool categories, ranked and joined into one process-group title. */
export type ToolActivity = 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/** DSH's tool-name to category map; the row's own title stays separate. */
export function toolActivity(name: string): ToolActivity {
  const id = name.toLocaleLowerCase()
  if (id === 'read') return 'read'
  if (id === 'read_image') return 'readImage'
  if (id === 'grep' || id === 'glob' || id.endsWith('_inspect')) return 'search'
  if (id === 'write') return 'write'
  if (id === 'edit' || id === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(id) || id.startsWith('terminal_')) return 'commands'
  if (id === 'run_code') return 'code'
  if (id === 'web_search') return 'webSearch'
  if (id === 'web_fetch') return 'webFetch'
  if (id === 'subagent' || id.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode'].includes(id)) return 'plan'
  if (id === 'ask_user_question' || id === 'request_user_input') return 'questions'
  return 'tools'
}

export interface ActivityCount {
  readonly kind: ToolActivity
  readonly count: number
}

export interface RenderRun {
  readonly key: string
  readonly runId?: string
  readonly users: readonly ChatMessage[]
  readonly messages: readonly ChatMessage[]
  readonly process: readonly ProcessPart[]
  readonly responses: readonly ResponsePart[]
  readonly artifacts: readonly FileArtifact[]
  /** Tool categories ranked by distinct call count, ties broken by first appearance (DSH's rule). */
  readonly activityCounts: readonly ActivityCount[]
  readonly status: 'running' | 'completed' | 'error' | 'cancelled'
  readonly durationMs?: number
  readonly usage?: MessageUsage
}

export interface RenderModel {
  readonly runs: readonly RenderRun[]
  readonly systemMessages: readonly ChatMessage[]
}

interface MutableRun {
  key: string
  runId?: string
  users: ChatMessage[]
  messages: ChatMessage[]
  firstIndex: number
}

interface MutableToolItem {
  key: string
  message: ChatMessage
  call?: Extract<ContentBlock, { type: 'toolCall' }>
  result?: ChatMessage
  parentToolCallId?: string
  children: MutableToolItem[]
  order: number
  messageIndex: number
}

/** Group durable messages into user runs while preserving their recorded order. */
export function buildRenderModel(messages: readonly ChatMessage[]): RenderModel {
  const mutableRuns: MutableRun[] = []
  const byRunId = new Map<string, MutableRun>()
  const systemMessages: ChatMessage[] = []
  let active: MutableRun | undefined

  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      systemMessages.push(message)
      continue
    }
    if (message.role === 'user') {
      const existing = message.runId === undefined ? undefined : byRunId.get(message.runId)
      if (existing !== undefined) {
        existing.users.push(message)
        existing.messages.push(message)
        active = existing
      } else {
        const run: MutableRun = {
          key: stableRunKey(message),
          ...(message.runId === undefined ? {} : { runId: message.runId }),
          users: [message],
          messages: [message],
          firstIndex: index,
        }
        mutableRuns.push(run)
        if (message.runId !== undefined) byRunId.set(message.runId, run)
        active = run
      }
      continue
    }

    let run = message.runId === undefined ? undefined : byRunId.get(message.runId)
    if (run === undefined && active !== undefined
      && (message.runId === undefined || active.runId === undefined || active.runId === message.runId)) {
      run = active
      if (message.runId !== undefined) {
        run.runId = message.runId
        byRunId.set(message.runId, run)
      }
    }
    if (run === undefined) {
      run = {
        key: message.runId === undefined ? `orphan:${message.id}` : `run:${message.runId}`,
        ...(message.runId === undefined ? {} : { runId: message.runId }),
        users: [],
        messages: [],
        firstIndex: index,
      }
      mutableRuns.push(run)
      if (message.runId !== undefined) byRunId.set(message.runId, run)
    }
    run.messages.push(message)
    active = run
  }

  const runs = mutableRuns
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(createRenderRun)
  return { runs, systemMessages }
}

function stableRunKey(message: ChatMessage): string {
  return `run:${message.requestId ?? message.id}`
}

function createRenderRun(run: MutableRun): RenderRun {
  const callItems = new Map<string, MutableToolItem>()
  const toolResults = new Map<string, ChatMessage>()

  for (const [messageIndex, message] of run.messages.entries()) {
    if (message.role === 'tool' && message.toolCallId !== undefined) toolResults.set(message.toolCallId, message)
    if (message.role !== 'assistant') continue
    for (const [blockIndex, block] of message.blocks.entries()) {
      if (block.type !== 'toolCall' || callItems.has(block.id)) continue
      const item: MutableToolItem = {
        key: `tool:${block.id}`,
        message,
        call: block,
        children: [],
        order: messageIndex + blockIndex / 1000,
        messageIndex,
        ...(message.parentToolCallId === undefined ? {} : { parentToolCallId: message.parentToolCallId }),
      }
      callItems.set(block.id, item)
    }
  }

  for (const [callId, item] of callItems) {
    const result = toolResults.get(callId)
    if (result !== undefined) item.result = result
  }

  const allTools: MutableToolItem[] = [...callItems.values()]
  for (const [messageIndex, message] of run.messages.entries()) {
    if (message.role !== 'tool' || message.toolCallId !== undefined && callItems.has(message.toolCallId)) continue
    allTools.push({
      key: `tool-result:${message.id}`,
      message,
      result: message,
      children: [],
      order: messageIndex,
      messageIndex,
      ...(message.parentToolCallId === undefined ? {} : { parentToolCallId: message.parentToolCallId }),
    })
  }

  const toolsById = new Map<string, MutableToolItem>()
  for (const [id, item] of callItems) toolsById.set(id, item)
  const roots: MutableToolItem[] = []
  for (const item of allTools) {
    const parent = item.parentToolCallId === undefined ? undefined : toolsById.get(item.parentToolCallId)
    if (parent === undefined || parent === item) roots.push(item)
    else parent.children.push(item)
  }
  const reachable = new Set<MutableToolItem>()
  const markReachable = (item: MutableToolItem): void => {
    if (reachable.has(item)) return
    reachable.add(item)
    for (const child of item.children) markReachable(child)
  }
  for (const root of roots) markReachable(root)
  // Malformed parent links can form a closed cycle; promote the first recorded
  // member so every durable tool result remains visible.
  for (const item of allTools) {
    if (reachable.has(item)) continue
    roots.push(item)
    markReachable(item)
  }

  const toolRootAt = new Map<number, MutableToolItem[]>()
  for (const item of roots) {
    const bucket = toolRootAt.get(item.messageIndex) ?? []
    bucket.push(item)
    toolRootAt.set(item.messageIndex, bucket)
  }

  const process: ProcessPart[] = []
  const responses: ResponsePart[] = []
  const finalResponse = [...run.messages].reverse().find(message => message.role === 'assistant'
    && message.parentToolCallId === undefined
    && !message.blocks.some(block => block.type === 'toolCall')
    && message.blocks.some(block => block.type === 'text' && block.text !== '' || block.type === 'image' || block.type === 'file'))
  for (const [messageIndex, message] of run.messages.entries()) {
    if (message.role === 'user' && message.id !== run.users[0]?.id) {
      process.push({ kind: 'user', key: `${message.id}:interleaved`, message, order: messageIndex })
    }
    for (const [blockIndex, block] of message.blocks.entries()) {
      if (message.role === 'assistant' && block.type === 'thinking' && (block.text.trim() !== '' || block.redacted === true)) {
        process.push({ kind: 'reasoning', key: `${message.id}:reasoning:${blockIndex}`, message, text: block.text,
          redacted: block.redacted === true, order: messageIndex + blockIndex / 1000 })
      }
      if (message.role === 'assistant' && message.id !== finalResponse?.id
        && (block.type === 'text' || block.type === 'image' || block.type === 'file')) {
        process.push({ kind: 'content', key: `${message.id}:process:${blockIndex}`, message, block,
          order: messageIndex + blockIndex / 1000 })
      }
    }
    if (message.role === 'assistant' && message.id === finalResponse?.id) {
      const blocks = message.blocks.filter(block => block.type === 'text' || block.type === 'image' || block.type === 'file')
      if (blocks.length > 0) responses.push({ key: `${message.id}:response`, message, blocks })
    }
    if (message.role === 'tool' && message.toolCallId === undefined) {
      // A result without a durable call id remains visible as its own process row.
      for (const item of toolRootAt.get(messageIndex) ?? []) {
        process.push({ kind: 'tool', key: item.key, item: freezeToolItem(item, new Set()), order: item.order })
      }
    }
    for (const item of toolRootAt.get(messageIndex) ?? []) {
      if (item.call !== undefined) process.push({ kind: 'tool', key: item.key, item: freezeToolItem(item, new Set()), order: item.order })
      else if (item.message.role !== 'tool' || item.message.toolCallId !== undefined) {
        process.push({ kind: 'tool', key: item.key, item: freezeToolItem(item, new Set()), order: item.order })
      }
    }
  }
  process.sort((left, right) => left.order - right.order)

  const status = runStatus(run.messages)
  const durationMs = run.messages.reduce<number | undefined>((latest, message) => (
    message.durationMs === undefined ? latest : Math.max(latest ?? 0, message.durationMs)
  ), undefined)
  const usage = sumUsage(run.messages)
  const artifacts = uniqueArtifacts(run.messages.flatMap(message => message.artifacts ?? []))
  return {
    key: run.key,
    ...(run.runId === undefined ? {} : { runId: run.runId }),
    users: run.users,
    messages: run.messages,
    process,
    responses,
    artifacts,
    activityCounts: rankActivities(roots),
    status,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/** Rank this run's tool categories the way DSH titles a settled process group. */
function rankActivities(roots: readonly MutableToolItem[]): ActivityCount[] {
  const counts = new Map<ToolActivity, number>()
  const visit = (item: MutableToolItem): void => {
    const name = item.call?.name ?? item.result?.toolName
    if (name !== undefined) {
      const kind = toolActivity(name)
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    for (const child of item.children) visit(child)
  }
  for (const root of roots) visit(root)
  // Map preserves first-appearance order, and a stable sort keeps it for tied counts.
  return [...counts].map(([kind, count]) => ({ kind, count })).sort((left, right) => right.count - left.count)
}

function freezeToolItem(item: MutableToolItem, ancestors: Set<string>): ToolItem {
  const visited = new Set(ancestors)
  if (visited.has(item.key)) return { ...item, children: [] }
  visited.add(item.key)
  return {
    key: item.key,
    message: item.message,
    ...(item.call === undefined ? {} : { call: item.call }),
    ...(item.result === undefined ? {} : { result: item.result }),
    ...(item.parentToolCallId === undefined ? {} : { parentToolCallId: item.parentToolCallId }),
    children: [...item.children].sort((left, right) => left.order - right.order)
      .map(child => freezeToolItem(child, visited)),
    order: item.order,
  }
}

function runStatus(messages: readonly ChatMessage[]): RenderRun['status'] {
  if (messages.some(message => message.streaming === true || message.status === 'running')) return 'running'
  const lastAssistant = messages.findLast(message => message.role === 'assistant')
  if (lastAssistant?.status === 'error' || lastAssistant?.isError === true) return 'error'
  if (lastAssistant?.status === 'cancelled') return 'cancelled'
  if (lastAssistant?.status === 'completed') return 'completed'
  if (lastAssistant?.blocks.some(block => block.type === 'text' && block.text.trim() !== '' || block.type === 'image' || block.type === 'file') === true) return 'completed'
  if (messages.some(message => message.status === 'error' || message.isError === true)) return 'error'
  if (messages.some(message => message.status === 'cancelled')) return 'cancelled'
  return messages.some(message => message.role === 'assistant') ? 'completed' : 'running'
}

function sumUsage(messages: readonly ChatMessage[]): MessageUsage | undefined {
  const usage = messages.flatMap(message => message.usage === undefined ? [] : [message.usage])
  if (usage.length === 0) return undefined
  const zero: MessageUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  return usage.reduce((total, current) => ({
    input: total.input + current.input,
    output: total.output + current.output,
    cacheRead: total.cacheRead + current.cacheRead,
    cacheWrite: total.cacheWrite + current.cacheWrite,
    totalTokens: total.totalTokens + current.totalTokens,
    cost: {
      input: total.cost.input + current.cost.input,
      output: total.cost.output + current.cost.output,
      cacheRead: total.cost.cacheRead + current.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + current.cost.cacheWrite,
      total: total.cost.total + current.cost.total,
    },
  }), zero)
}

function uniqueArtifacts(artifacts: readonly FileArtifact[]): FileArtifact[] {
  const seen = new Set<string>()
  return artifacts.filter(artifact => {
    const key = JSON.stringify({ kind: artifact.kind, path: artifact.path, before: artifact.before ?? null,
      after: artifact.after ?? null, diff: artifact.diff ?? null })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Turn a message key into the stable DOM target used by chat and trajectory navigation. */
export function transcriptMessageDomId(messageId: string): string {
  return `chat-message-${encodeURIComponent(messageId)}`
}

/** Provide a display-safe summary and body for a reasoning block. */
export function reasoningDisplay(text: string, redacted: boolean, hiddenLabel: string): { summary: string; text: string } {
  if (redacted) return { summary: hiddenLabel, text: '' }
  return { summary: text.split(/\r?\n/u).find(line => line.trim() !== '')?.trim() ?? '', text }
}

/** Plain text used by copy controls and compact trajectory summaries. */
export function messageText(message: ChatMessage): string {
  return message.blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'thinking') return block.redacted === true ? [] : [block.text]
    if (block.type === 'toolCall') return [JSON.stringify({ tool: block.name, arguments: block.arguments })]
    return []
  }).join('\n')
}

/** Read a possibly malformed detail value as a record without trusting its fields. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Safely summarize unknown tool details for a trajectory row. */
export function formatUnknownDetails(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) }
  catch (error) { return `无法读取工具详情：${error instanceof Error ? error.message : String(error)}` }
}

/** Keep output extraction safe for future non-text content blocks. */
export function messageOutput(message: ChatMessage | undefined): string {
  if (message === undefined) return ''
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

export interface ConversationStats {
  readonly runCount: number
  readonly stepCount: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly contextTokens: number
}

/** Fold the durable message log into the numbers shown by the composer status pills. */
export function conversationStats(messages: readonly ChatMessage[]): ConversationStats {
  const { runs } = buildRenderModel(messages)
  let stepCount = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalTokens = 0
  let contextTokens = 0
  for (const message of messages) {
    if (message.role === 'assistant' || message.role === 'tool') stepCount += 1
    const usage = message.usage
    if (usage === undefined) continue
    input += usage.input
    output += usage.output
    cacheRead += usage.cacheRead
    cacheWrite += usage.cacheWrite
    totalTokens += usage.totalTokens
    // The most recent turn prices the window the next request will carry.
    contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
  }
  return {
    runCount: runs.filter(run => run.users.length > 0).length,
    stepCount,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    contextTokens,
  }
}

