import type {
  AgentState,
  ConversationView,
  InboxItem,
  InboxState,
  LiveState,
  ModelRef as PiModelRef,
  NestedToolSlot,
  ToolSlot,
  UserInput,
  UsageState,
} from '@earendil-works/pi-durable'
import type { AssistantMessage, ImageContent, Message, ToolResultMessage } from '@earendil-works/pi-ai'
import type { ChatMessage, ContentBlock, ConversationDetail, ConversationSummary, FileArtifact, MessageUsage, ThinkingLevel } from '../shared/types.ts'
import type { ConversationMetadata } from './runtime.ts'

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[]

type ProjectOptions = {
  workspace: string
  defaultModel?: PiModelRef
  queuedAt?: Record<string, number>
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isUserInput(value: unknown): value is UserInput {
  if (typeof value === 'string') return true
  if (!Array.isArray(value)) return false
  return value.every(item => {
    const content = jsonRecord(item)
    if (!content) return false
    if (content.type === 'text') return isString(content.text)
    return content.type === 'image' && isString(content.data) && isString(content.mimeType)
  })
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  const message = jsonRecord(value)
  const usage = message ? jsonRecord(message.usage) : undefined
  const cost = usage ? jsonRecord(usage.cost) : undefined
  const stopReasons = ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']
  if (!message || !usage || !cost || message.role !== 'assistant' || !isString(message.api) || !isString(message.provider) || !isString(message.model)) return false
  if (!isNumber(message.timestamp) || !isNumber(usage.input) || !isNumber(usage.output) || !isNumber(usage.cacheRead) || !isNumber(usage.cacheWrite) || !isNumber(usage.totalTokens)) return false
  if (!isNumber(cost.input) || !isNumber(cost.output) || !isNumber(cost.cacheRead) || !isNumber(cost.cacheWrite) || !isNumber(cost.total)) return false
  if (!isString(message.stopReason) || !stopReasons.includes(message.stopReason) || !Array.isArray(message.content)) return false
  if (message.errorMessage !== undefined && !isString(message.errorMessage)) return false
  return message.content.every(part => {
    const block = jsonRecord(part)
    if (!block) return false
    if (block.type === 'text') return isString(block.text)
    if (block.type === 'thinking') return isString(block.thinking) && (block.redacted === undefined || typeof block.redacted === 'boolean')
    if (block.type === 'toolCall') return isString(block.id) && isString(block.name) && jsonRecord(block.arguments) !== undefined
    return false
  })
}

function isToolSlot(value: unknown): value is ToolSlot {
  const slot = jsonRecord(value)
  const diagnostics = slot?.diagnostics
  const validDiagnostics = diagnostics === undefined || (Array.isArray(diagnostics) && diagnostics.every(value => {
    const diagnostic = jsonRecord(value)
    return !!diagnostic && ['info', 'warn', 'error'].includes(String(diagnostic.severity)) && isString(diagnostic.message)
  }))
  return !!slot && isString(slot.callId) && isString(slot.name) && ['pending', 'running', 'done'].includes(String(slot.status)) &&
    (slot.taskId === undefined || isNumber(slot.taskId)) && (slot.entry === undefined || isNumber(slot.entry)) &&
    (slot.output === undefined || isString(slot.output)) && (slot.droppedBytes === undefined || isNumber(slot.droppedBytes)) &&
    (slot.droppedLines === undefined || isNumber(slot.droppedLines)) && validDiagnostics
}

function isNestedToolSlot(value: unknown): value is NestedToolSlot {
  const slot = jsonRecord(value)
  const summary = slot?.summary === undefined ? undefined : jsonRecord(slot.summary)
  return !!slot && isString(slot.callId) && isString(slot.name) && isString(slot.parentCallId) &&
    isNumber(slot.parentTaskId) && isNumber(slot.taskId) && ['pending', 'running', 'done'].includes(String(slot.status)) &&
    jsonRecord(slot.arguments) !== undefined && (slot.output === undefined || isString(slot.output)) &&
    (slot.summary === undefined || (!!summary && typeof summary.isError === 'boolean' && (summary.error === undefined || isString(summary.error))))
}

function isLiveState(value: unknown): value is LiveState {
  const live = jsonRecord(value)
  if (!live) return false
  if (live.run !== undefined) {
    const run = jsonRecord(live.run)
    if (!run || !isNumber(run.taskId) || !Array.isArray(run.inputs) || !run.inputs.every(isNumber)) return false
  }
  if (live.generation !== undefined) {
    const generation = jsonRecord(live.generation)
    if (!generation || !isNumber(generation.attempt)) return false
    if (generation.message !== undefined && !isAssistantMessage(generation.message)) return false
    if (generation.retry !== undefined) {
      const retry = jsonRecord(generation.retry)
      if (!retry || !isNumber(retry.at) || !isString(retry.error)) return false
    }
  }
  if (live.tools !== undefined && (!Array.isArray(live.tools) || !live.tools.every(isToolSlot))) return false
  if (live.nestedTools !== undefined && (!Array.isArray(live.nestedTools) || !live.nestedTools.every(isNestedToolSlot))) return false
  if (live.compactionFailure !== undefined) {
    const failure = jsonRecord(live.compactionFailure)
    if (!failure || !isString(failure.error)) return false
  }
  return true
}

function isInboxItem(value: unknown): value is InboxItem {
  const item = jsonRecord(value)
  if (!item || !isNumber(item.id)) return false
  if (item.mode === 'write') return jsonRecord(item.entry) !== undefined
  return (item.mode === 'steer' || item.mode === 'followUp') && isUserInput(item.content)
}

function isInboxState(value: unknown): value is InboxState {
  const inbox = jsonRecord(value)
  return !!inbox && Array.isArray(inbox.items) && inbox.items.every(isInboxItem)
}

function isUsage(value: unknown): boolean {
  const usage = jsonRecord(value)
  const cost = usage ? jsonRecord(usage.cost) : undefined
  return !!usage && !!cost && isNumber(usage.input) && isNumber(usage.output) && isNumber(cost.total)
}

function isUsageState(value: unknown): value is UsageState {
  const state = jsonRecord(value)
  const models = state ? jsonRecord(state.models) : undefined
  const tools = state ? jsonRecord(state.tools) : undefined
  return !!models && !!tools && Object.values(models).every(isUsage) && Object.values(tools).every(isUsage)
}

function isAgentState(value: unknown): value is AgentState {
  const agent = jsonRecord(value)
  if (!agent) return false
  if (agent.model !== undefined) {
    const model = jsonRecord(agent.model)
    if (!model || !isString(model.provider) || !isString(model.modelId)) return false
  }
  return (agent.thinkingLevel === undefined || isString(agent.thinkingLevel)) && (agent.cwd === undefined || isString(agent.cwd))
}

function textBlocks(content: string | readonly (ImageContent | { type: 'text'; text: string })[]): ContentBlock[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  return content.flatMap<ContentBlock>(part => {
    if (part.type === 'text') return part.text.length > 0 ? [{ type: 'text' as const, text: part.text }] : []
    return [{ type: 'image' as const, url: `data:${part.mimeType};base64,${part.data}`, mimeType: part.mimeType }]
  })
}

function assistantBlocks(message: AssistantMessage): ContentBlock[] {
  return message.content.flatMap<ContentBlock>(part => {
    if (part.type === 'text') return part.text.length > 0 ? [{ type: 'text' as const, text: part.text }] : []
    if (part.type === 'thinking') {
      if (part.redacted) return [{ type: 'thinking' as const, text: '', redacted: true }]
      if (part.thinking.length === 0) return []
      return [{ type: 'thinking' as const, text: part.thinking }]
    }
    return [{ type: 'toolCall' as const, id: part.id, name: part.name, arguments: { ...part.arguments } }]
  })
}

function messageFromPi(message: Message, entryId: string, index: number, requestId?: string): ChatMessage | undefined {
  const id = `entry:${entryId}:${index}`
  if (message.role === 'system') return undefined
  if (message.role === 'user') {
    return {
      id,
      entryId,
      role: 'user',
      blocks: textBlocks(message.content),
      timestamp: message.timestamp,
      ...(requestId ? { requestId } : {}),
    }
  }
  if (message.role === 'assistant') {
    const blocks = assistantBlocks(message)
    const errorMessage = message.errorMessage ? safeError(message.errorMessage) : undefined
    if (errorMessage && !blocks.some(block => block.type === 'text' && block.text === errorMessage)) {
      blocks.push({ type: 'text', text: errorMessage })
    }
    return {
      id,
      entryId,
      role: 'assistant',
      blocks,
      timestamp: message.timestamp,
      isError: message.stopReason === 'error',
      status: message.stopReason === 'error' ? 'error' : message.stopReason === 'aborted' ? 'cancelled' : message.stopReason === 'pending' ? 'running' : 'completed',
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        totalTokens: message.usage.totalTokens,
        cost: {
          input: message.usage.cost.input,
          output: message.usage.cost.output,
          cacheRead: message.usage.cost.cacheRead,
          cacheWrite: message.usage.cost.cacheWrite,
          total: message.usage.cost.total,
        },
      },
      details: {
        stopReason: message.stopReason,
        ...(errorMessage ? { error: errorMessage } : {}),
        provider: message.provider,
        model: message.model,
        usage: message.usage,
      },
      ...(requestId ? { requestId } : {}),
    }
  }
  return messageFromToolResult(message, entryId, index, requestId)
}

function safeError(value: string): string {
  return value
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|rk|pk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, '[redacted]@')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500)
}

function messageFromToolResult(message: ToolResultMessage, entryId: string, index: number, requestId?: string): ChatMessage {
  return {
    id: `entry:${entryId}:${index}`,
    entryId,
    role: 'tool',
    blocks: textBlocks(message.content),
    timestamp: message.timestamp,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    status: message.isError ? 'error' : 'completed',
    ...(message.details === undefined ? {} : { details: message.details }),
    ...(requestId ? { requestId } : {}),
  }
}

function entryRequestId(entry: ConversationView['entries'][number]): string | undefined {
  const data = jsonRecord(entry.data)
  return data && isString(data.requestId) ? data.requestId : undefined
}

function entryFiles(entry: ConversationView['entries'][number]): Array<{ name: string; path: string; mimeType: string; size: number }> {
  const data = jsonRecord(entry.data)
  const files = data?.files
  if (!Array.isArray(files)) return []
  return files.flatMap(value => {
    const file = jsonRecord(value)
    if (!file || !isString(file.name) || !isString(file.path) || !isString(file.mimeType) || !isNumber(file.size)) return []
    return [{ name: file.name, path: file.path, mimeType: file.mimeType, size: file.size }]
  })
}

function fileBlocks(files: readonly { name: string; path: string; mimeType: string; size: number }[]): ContentBlock[] {
  return files.map(file => ({ type: 'file', name: file.name, path: file.path, mimeType: file.mimeType, size: file.size }))
}

function artifactFromTool(name: string, args: Record<string, unknown> | undefined, details: unknown): FileArtifact[] {
  if (!args || !isString(args.path)) return []
  const result = jsonRecord(details)
  if (name === 'read') {
    return [{ kind: 'read', path: args.path, ...(isNumber(args.offset) ? { lineStart: args.offset + 1 } : {}) }]
  }
  if (name === 'write') {
    return isString(args.content) ? [{ kind: 'write', path: args.path, after: args.content }] : [{ kind: 'write', path: args.path }]
  }
  if (name === 'edit' || name === 'nativeEdit' || name === 'native_edit') {
    const edits = Array.isArray(args.edits) ? args.edits.map(jsonRecord).filter((edit): edit is Record<string, unknown> => edit !== undefined) : []
    const before = edits.flatMap(edit => isString(edit.oldText) ? [edit.oldText] : []).join('\n')
    const after = edits.flatMap(edit => isString(edit.newText) ? [edit.newText] : []).join('\n')
    const kind = name === 'edit' ? 'edit' : 'nativeEdit'
    return [{
      kind,
      path: args.path,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(isString(result?.diff) ? { diff: result.diff } : {}),
      ...(isNumber(result?.firstChangedLine) ? { lineStart: result.firstChangedLine } : {}),
    }]
  }
  return []
}

function inputText(content: UserInput): string {
  if (typeof content === 'string') return content
  const text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  return text || (content.some(part => part.type === 'image') ? '[图片]' : '')
}

function queueItems(view: ConversationView, metadata: ConversationMetadata, options: ProjectOptions): ConversationDetail['queue'] {
  const inboxValue = view.docs['pi.inbox']
  if (!isInboxState(inboxValue)) return []
  return inboxValue.items.flatMap(item => {
    if (item.mode === 'write') return []
    const id = String(item.id)
    const createdAt = options.queuedAt?.[id] ?? metadata.queueCreatedAt[id] ?? metadata.createdAt
    if (!isUserInput(item.content)) return []
    const text = inputText(item.content)
    const images = typeof item.content === 'string' ? [] : item.content.flatMap(part => part.type === 'image' ? [{ data: part.data, mimeType: part.mimeType }] : [])
    const entry = jsonRecord(item.entry)
    const data = entry ? jsonRecord(entry.data) : undefined
    const files = Array.isArray(data?.files) ? data.files.flatMap(value => {
      const file = jsonRecord(value)
      if (!file || !isString(file.name) || !isString(file.path) || !isString(file.mimeType) || !isNumber(file.size)) return []
      return [{ name: file.name, path: file.path, mimeType: file.mimeType, size: file.size }]
    }) : []
    return [{ id, text, mode: item.mode, createdAt, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }]
  })
}

function usageSummary(value: unknown): ConversationDetail['usage'] {
  if (!isUsageState(value)) return undefined
  let input = 0
  let output = 0
  let totalCost = 0
  for (const usage of [...Object.values(value.models), ...Object.values(value.tools)]) {
    input += usage.input
    output += usage.output
    totalCost += usage.cost.total
  }
  return { input, output, totalCost }
}

function modelCopy(model: PiModelRef | undefined): ConversationSummary['model'] {
  return model ? { provider: model.provider, modelId: model.modelId } : undefined
}

function thinkingLevel(value: string | undefined): ThinkingLevel {
  return thinkingLevels.find(level => level === value) ?? 'medium'
}

function runIdForLive(live: LiveState, metadata: ConversationMetadata, fallback?: string): string | undefined {
  const inputIds = live.run?.inputs
  if (!inputIds?.length) return fallback
  const request = Object.entries(metadata.requestReceipts).find(([, receipt]) => receipt.submissionId !== null && inputIds.some(id => id === receipt.submissionId))?.[0]
  const requestId = request?.startsWith('queue-edit:') ? request.slice('queue-edit:'.length) : request
  return `run:${requestId ?? live.run?.taskId ?? inputIds[0]}`
}

function messageUsage(value: unknown): MessageUsage | undefined {
  const usage = jsonRecord(value)
  const cost = usage ? jsonRecord(usage.cost) : undefined
  if (!usage || !cost || !isNumber(usage.input) || !isNumber(usage.output) || !isNumber(usage.cacheRead) || !isNumber(usage.cacheWrite) || !isNumber(usage.totalTokens)) return undefined
  if (!isNumber(cost.input) || !isNumber(cost.output) || !isNumber(cost.cacheRead) || !isNumber(cost.cacheWrite) || !isNumber(cost.total)) return undefined
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, total: cost.total },
  }
}

function sameAssistant(left: AssistantMessage, right: AssistantMessage): boolean {
  return left.timestamp === right.timestamp && left.provider === right.provider && left.model === right.model &&
    JSON.stringify(left.content) === JSON.stringify(right.content)
}

function liveToolMessages(live: LiveState, settledToolCallIds: ReadonlySet<string>, entryIds: ReadonlySet<number>, timestamp: number, runId?: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const slot of live.tools ?? []) {
    if (settledToolCallIds.has(slot.callId) || (slot.entry !== undefined && entryIds.has(slot.entry))) continue
    const diagnostics = slot.diagnostics ?? []
    messages.push({
      id: `live-tool:${slot.callId}`,
      role: 'tool',
      blocks: slot.output ? [{ type: 'text', text: slot.output }] : [],
      timestamp,
      toolCallId: slot.callId,
      toolName: slot.name,
      isError: diagnostics.some(diagnostic => diagnostic.severity === 'error'),
      status: slot.status === 'done' ? (diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 'error' : 'completed') : 'running',
      streaming: true,
      ...(runId ? { runId } : {}),
      ...(messageUsage(jsonRecord(slot.details)?.usage) ? { usage: messageUsage(jsonRecord(slot.details)?.usage) } : {}),
      details: {
        status: slot.status,
        ...(slot.details === undefined ? {} : { result: slot.details }),
        ...(slot.droppedBytes === undefined ? {} : { droppedBytes: slot.droppedBytes }),
        ...(slot.droppedLines === undefined ? {} : { droppedLines: slot.droppedLines }),
        ...(diagnostics.length ? { diagnostics } : {}),
      },
    })
  }
  for (const slot of live.nestedTools ?? []) {
    const summary = slot.summary
    messages.push({
      id: `live-nested-tool:${slot.callId}`,
      role: 'tool',
      blocks: slot.output ? [{ type: 'text', text: slot.output }] : [],
      timestamp,
      toolCallId: slot.callId,
      parentToolCallId: slot.parentCallId,
      toolName: slot.name,
      isError: summary?.isError ?? false,
      status: slot.status === 'done' ? (summary?.isError ? 'error' : 'completed') : 'running',
      ...(summary?.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
      ...(messageUsage(summary?.usage) ? { usage: messageUsage(summary?.usage) } : {}),
      streaming: true,
      ...(runId ? { runId } : {}),
      details: {
        status: slot.status,
        parentCallId: slot.parentCallId,
        arguments: slot.arguments,
        ...(summary === undefined ? {} : { summary }),
      },
    })
  }
  return messages
}

/** Projects one Pi Durable conversation view into the stable browser DTOs. */
export function projectConversation(
  view: ConversationView,
  metadata: ConversationMetadata,
  options: ProjectOptions,
): ConversationDetail {
  const agentValue = view.docs['pi.agent']
  const agent = isAgentState(agentValue) ? agentValue : undefined
  const liveValue = view.docs['pi.live']
  const live: LiveState = isLiveState(liveValue) ? liveValue : {}
  const messages: ChatMessage[] = []
  const settledAssistantMessages: AssistantMessage[] = []
  const settledToolCallIds = new Set<string>()
  const entryIds = new Set<number>()
  const callTimestamps = new Map<string, number>()
  const callArguments = new Map<string, { name: string; arguments: Record<string, unknown> }>()
  const runStartedAt = new Map<string, number>()
  const finalAssistantByRun = new Map<string, ChatMessage>()
  let currentRunId: string | undefined
  let previousAssistantTask: number | undefined
  let previousAssistantCallsTools = false
  let latestEntryTimestamp = metadata.createdAt
  let lastTimestamp = metadata.createdAt
  let latestAssistantError: string | undefined

  for (const entry of view.entries) {
    entryIds.add(entry.id)
    const id = String(entry.id)
    const requestId = entryRequestId(entry)
    const entryMessages = entry.model ?? []
    const statusText = entry.kind === 'pi.reset' ? '上下文已重置' : entry.kind === 'pi.compaction' ? '较早的上下文已压缩' : undefined
    for (const [index, message] of entryMessages.entries()) {
      lastTimestamp = message.timestamp
      latestEntryTimestamp = Math.max(latestEntryTimestamp, message.timestamp)
      if (message.role === 'system' || statusText !== undefined) continue
      if (message.role === 'user') {
        const placedDuringToolRound = entry.byTaskId !== undefined && entry.byTaskId === previousAssistantTask && previousAssistantCallsTools
        if (!placedDuringToolRound || !currentRunId) currentRunId = `run:${requestId ?? id}`
        if (!runStartedAt.has(currentRunId)) runStartedAt.set(currentRunId, message.timestamp)
      } else if (!currentRunId) {
        currentRunId = `run:${requestId ?? id}`
        runStartedAt.set(currentRunId, message.timestamp)
      }
      const projected = messageFromPi(message, id, index, requestId)
      if (projected) {
        projected.runId = currentRunId
        if (message.role === 'user') projected.blocks.push(...fileBlocks(entryFiles(entry)))
        if (metadata.feedback[id] !== undefined) projected.feedback = metadata.feedback[id]
        if (projected.role === 'assistant') finalAssistantByRun.set(currentRunId, projected)
        if (projected.role === 'tool' && projected.toolCallId) {
          const call = callArguments.get(projected.toolCallId)
          if (call) projected.artifacts = artifactFromTool(call.name, call.arguments, projected.details)
          const calledAt = callTimestamps.get(projected.toolCallId)
          const recordedDuration = jsonRecord(message)?.durationMs
          if (isNumber(recordedDuration)) projected.durationMs = Math.max(0, recordedDuration)
          else if (calledAt !== undefined) projected.durationMs = Math.max(0, projected.timestamp - calledAt)
        }
        messages.push(projected)
      }
      if (message.role === 'assistant') {
        settledAssistantMessages.push(message)
        previousAssistantTask = entry.byTaskId
        previousAssistantCallsTools = message.stopReason === 'toolUse'
        latestAssistantError = message.errorMessage ? safeError(message.errorMessage) : undefined
      }
      if (message.role === 'toolResult') settledToolCallIds.add(message.toolCallId)
      if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'toolCall') {
            callTimestamps.set(part.id, message.timestamp)
            callArguments.set(part.id, { name: part.name, arguments: { ...part.arguments } })
          }
        }
      }
    }

    if (statusText !== undefined) {
      messages.push({ id: `entry:${id}:status`, entryId: id, role: 'system', blocks: [{ type: 'text', text: statusText }], timestamp: lastTimestamp, ...(currentRunId ? { runId: currentRunId } : {}) })
    }
  }

  const partial = live.generation?.message
  const activeRunId = runIdForLive(live, metadata, currentRunId)
  if (partial) {
    latestEntryTimestamp = Math.max(latestEntryTimestamp, partial.timestamp)
    if (!settledAssistantMessages.some(message => sameAssistant(message, partial))) {
      const blocks = assistantBlocks(partial)
      const errorMessage = partial.errorMessage ? safeError(partial.errorMessage) : undefined
      if (errorMessage && !blocks.some(block => block.type === 'text' && block.text === errorMessage)) {
        blocks.push({ type: 'text', text: errorMessage })
      }
      messages.push({
        id: `live-assistant:${String(live.run?.taskId ?? view.conversation.id)}`,
        role: 'assistant',
        blocks,
        timestamp: partial.timestamp,
        streaming: true,
        isError: partial.stopReason === 'error',
        status: partial.stopReason === 'error' ? 'error' : partial.stopReason === 'aborted' ? 'cancelled' : 'running',
        ...(activeRunId ? { runId: activeRunId } : {}),
        ...(messageUsage(partial.usage) ? { usage: messageUsage(partial.usage) } : {}),
        ...(activeRunId && runStartedAt.has(activeRunId) ? { durationMs: Math.max(0, Date.now() - (runStartedAt.get(activeRunId) ?? partial.timestamp)) } : {}),
        details: {
          stopReason: partial.stopReason,
          provider: partial.provider,
          model: partial.model,
          usage: partial.usage,
          ...(errorMessage ? { error: errorMessage } : {}),
        },
      })
    }
  }

  const progressTimestamp = partial?.timestamp ?? lastTimestamp
  messages.push(...liveToolMessages(live, settledToolCallIds, entryIds, progressTimestamp, activeRunId))

  for (const [runId, message] of finalAssistantByRun) {
    const startedAt = runStartedAt.get(runId)
    if (startedAt !== undefined) message.durationMs = Math.max(0, message.timestamp - startedAt)
    message.status ??= message.isError ? 'error' : 'completed'
  }

  const latestError = live.generation?.retry?.error
    ? safeError(live.generation.retry.error)
    : live.compactionFailure?.error
      ? safeError(live.compactionFailure.error)
      : partial?.errorMessage
        ? safeError(partial.errorMessage)
        : latestAssistantError

  const agentModel = agent?.model
  const model = modelCopy(agentModel ?? options.defaultModel)
  const latestAssistant = [...messages].reverse().find(message => message.role === 'assistant')
  const summaryRunId = live.run ? activeRunId : latestAssistant?.runId ?? currentRunId
  const summaryRunStartedAt = summaryRunId ? runStartedAt.get(summaryRunId) : undefined
  const runStatus = live.run ? 'running' : latestError ? 'error' : latestAssistant?.status
  const summaryDuration = summaryRunStartedAt === undefined
    ? undefined
    : live.run
      ? Math.max(0, Date.now() - summaryRunStartedAt)
      : latestAssistant
        ? Math.max(0, latestAssistant.timestamp - summaryRunStartedAt)
        : undefined
  const conversation: ConversationSummary = {
    id: String(view.conversation.id),
    title: metadata.title,
    createdAt: metadata.createdAt,
    updatedAt: Math.max(metadata.updatedAt, latestEntryTimestamp),
    archived: metadata.archived,
    pinned: metadata.pinned,
    busy: live.run !== undefined,
    ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    ...(metadata.presetId ? { presetId: metadata.presetId } : {}),
    accessMode: metadata.accessMode,
    ...(summaryRunId ? { runId: summaryRunId } : {}),
    ...(summaryRunStartedAt !== undefined ? { runStartedAt: summaryRunStartedAt } : {}),
    ...(summaryDuration !== undefined ? { durationMs: summaryDuration } : {}),
    ...(runStatus ? { status: runStatus } : {}),
    ...(model ? { model } : {}),
    thinkingLevel: thinkingLevel(agent?.thinkingLevel),
    cwd: agent?.cwd ?? options.workspace,
  }

  const usage = usageSummary(view.docs['pi.usage'])
  return {
    conversation,
    messages,
    queue: queueItems(view, metadata, options),
    ...(latestError ? { error: latestError } : {}),
    ...(usage ? { usage } : {}),
  }
}
