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
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  ChatMessage,
  CompactionView,
  ContentBlock,
  ConversationDetail,
  ConversationSummary,
  FileArtifact,
  InteractionRequest,
  MessageUsage,
  PlanView,
  SubagentSummary,
  TeamMemberView,
  TeamTaskView,
  TeamView,
  ThinkingLevel,
  TodoItem,
  GoalPhase,
  GoalView,
} from '../../shared/types.ts'
import { foldInteractions, type QuestionCall, type QuestionReply } from './interactions.ts'
import { planReviewOf } from '../tools/plan.ts'
import type { ConversationMetadata } from '../runtime/helpers.ts'

/** 合法的思考级别常量序列，thinkingLevel() 回落判断用。 */
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[]

/**
 * projectConversation 的附加投影来源：Pi 视图本身只挂自己的文档，
 * pi-web 文档（todos/goal/plan/interactions）与运行时计算（subagents/team）经此注入。
 */
type ProjectOptions = {
  /** 支撑该会话的工作区路径；工作区尚未绑定时缺省。 */
  workspace?: string
  defaultModel?: PiModelRef
  queuedAt?: Record<string, number>
  /** `pi-web.todos` 文档原文；视图只带 Pi 自己挂载的文档。 */
  todos?: unknown
  /** `pi-web.goal` 文档原文，读取方式同上。 */
  goal?: unknown
  /** `pi-web.plan` 文档原文，读取方式同上。 */
  plan?: unknown
  /** `pi-web.interactions` 文档原文，按工具调用 id 键控。 */
  interactions?: unknown
  /** 运行时计算出的直接子会话列表；仅会话自身的 detail 携带。 */
  subagents?: unknown
  /** 运行时计算出的团队投影；仅会话自身的 detail 携带。 */
  team?: unknown
  kind?: 'defectAnalysis'
}

/** 安全地把未知值收窄为普通对象；非对象（含数组/null）返回 undefined。 */
function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

/** 收窄为有限数字。 */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 收窄为字符串。 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 校验未知值为 UserInput：字符串或"text/image 块形状正确"的数组。 */
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

/**
 * 严格校验未知值为 AssistantMessage（字段逐一核对：角色、api/provider/model、
 * timestamp、usage 与 cost 全数字、stopReason 在枚举内、content 块逐个验证形状）。
 * 外部写入者留下的畸形数据一律拒绝，投影时丢弃。
 */
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

/** 校验未知值为 ToolSlot（live 工具槽）：callId/name/status 必备，diagnostics/entry/输出等可选字段逐个验形状。 */
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

/** 校验未知值为 NestedToolSlot（codemode 嵌套工具槽）：父调用归属与参数/摘要形状逐项核对。 */
function isNestedToolSlot(value: unknown): value is NestedToolSlot {
  const slot = jsonRecord(value)
  const summary = slot?.summary === undefined ? undefined : jsonRecord(slot.summary)
  return !!slot && isString(slot.callId) && isString(slot.name) && isString(slot.parentCallId) &&
    isNumber(slot.parentTaskId) && isNumber(slot.taskId) && ['pending', 'running', 'done'].includes(String(slot.status)) &&
    jsonRecord(slot.arguments) !== undefined && (slot.output === undefined || isString(slot.output)) &&
    (slot.summary === undefined || (!!summary && typeof summary.isError === 'boolean' && (summary.error === undefined || isString(summary.error))))
}

/**
 * 校验未知值为 LiveState（运行态文档）：run/generation/工具槽/压缩状态逐段验证；
 * 任一段畸形即整体拒绝（投影时按空 LiveState 处理），保证浏览器 DTO 不被外部写坏。
 */
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
  if (live.compactions !== undefined) {
    if (!Array.isArray(live.compactions)) return false
    for (const value of live.compactions) {
      const status = jsonRecord(value)
      if (!status || !isNumber(status.taskId) || !isString(status.reason)
        || typeof status.blocking !== 'boolean' || !isNumber(status.attempt)) return false
    }
  }
  if (live.compactionFailure !== undefined) {
    const failure = jsonRecord(live.compactionFailure)
    if (!failure || !isString(failure.error)) return false
  }
  return true
}

/** 校验未知值为 InboxItem：write 模式须带 entry，steer/followUp 模式须带合法用户输入。 */
function isInboxItem(value: unknown): value is InboxItem {
  const item = jsonRecord(value)
  if (!item || !isNumber(item.id)) return false
  if (item.mode === 'write') return jsonRecord(item.entry) !== undefined
  return (item.mode === 'steer' || item.mode === 'followUp') && isUserInput(item.content)
}

/** 校验未知值为 InboxState：items 数组且每项通过 isInboxItem。 */
function isInboxState(value: unknown): value is InboxState {
  const inbox = jsonRecord(value)
  return !!inbox && Array.isArray(inbox.items) && inbox.items.every(isInboxItem)
}

/** 校验未知值为单份用量记录：input/output/cost.total 为数字。 */
function isUsage(value: unknown): boolean {
  const usage = jsonRecord(value)
  const cost = usage ? jsonRecord(usage.cost) : undefined
  return !!usage && !!cost && isNumber(usage.input) && isNumber(usage.output) && isNumber(cost.total)
}

/** 校验未知值为 UsageState：models 与 tools 两个桶的每份用量都通过 isUsage。 */
function isUsageState(value: unknown): value is UsageState {
  const state = jsonRecord(value)
  const models = state ? jsonRecord(state.models) : undefined
  const tools = state ? jsonRecord(state.tools) : undefined
  return !!models && !!tools && Object.values(models).every(isUsage) && Object.values(tools).every(isUsage)
}

/** 校验未知值为 AgentState：model 引用形状正确且 thinkingLevel/cwd（如存在）为字符串。 */
function isAgentState(value: unknown): value is AgentState {
  const agent = jsonRecord(value)
  if (!agent) return false
  if (agent.model !== undefined) {
    const model = jsonRecord(agent.model)
    if (!model || !isString(model.provider) || !isString(model.modelId)) return false
  }
  return (agent.thinkingLevel === undefined || isString(agent.thinkingLevel)) && (agent.cwd === undefined || isString(agent.cwd))
}

/**
 * 功能：把 Pi 的消息内容（字符串或文本/图片块数组）投影为浏览器 ContentBlock 数组。
 * @param content 消息内容。
 * @returns 空串映射为空数组；图片块转为 data URL 形态（`data:<mime>;base64,<data>`）。
 */
function textBlocks(content: string | readonly (ImageContent | { type: 'text'; text: string })[]): ContentBlock[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  return content.flatMap<ContentBlock>(part => {
    if (part.type === 'text') return part.text.length > 0 ? [{ type: 'text' as const, text: part.text }] : []
    return [{ type: 'image' as const, url: `data:${part.mimeType};base64,${part.data}`, mimeType: part.mimeType }]
  })
}

/**
 * 功能：把模型的内容数组投影为浏览器块。Pi 只对该数组追加，因此每个块保留它被推入时的
 * 槽位：槽位是后面块被填充后依然存活的身份。模型尚未写入的块同样保留——丢掉它们会移动
 * 后续块的槽位。
 */
function assistantBlocks(message: AssistantMessage): ContentBlock[] {
  return message.content.map<ContentBlock>((part, slot) => {
    if (part.type === 'text') return { type: 'text', text: part.text, slot }
    if (part.type === 'thinking') {
      if (part.redacted) return { type: 'thinking', text: '', redacted: true, slot }
      return { type: 'thinking', text: part.thinking, slot }
    }
    return { type: 'toolCall', id: part.id, name: part.name, arguments: { ...part.arguments }, slot }
  })
}

/**
 * 助手消息的身份键：流式 partial 与它最终成为的 entry 共用。Pi Durable 给生成任务写入的每个
 * entry 盖上该任务的 id（`EntryRecord.byTaskId`），live 运行携带同一 id，因此"任务 + 请求
 * 时间戳"在两个阶段命名同一条消息。时间戳还区分了重试任务写入的两个 entry，任务则区分
 * 同一毫秒内开始的两次请求。
 */
function assistantMessageId(byTaskId: number | undefined, timestamp: number): string {
  return `assistant:${byTaskId ?? 'unknown'}:${timestamp}`
}

/**
 * 功能：把一条 Pi 消息投影为浏览器 ChatMessage；system 消息返回 undefined（转录不显示）。
 * 内部逻辑：user → textBlocks（附 requestId）；assistant → assistantBlocks 投影、错误消息
 * 兜底为文本块、id 用 assistantMessageId（无任务作用域的 entry 保留 entry id）、附 usage/
 * details 与 requestDurationMs（总时长减 TTFT，即纯解码时间）；toolResult 委托 messageFromToolResult。
 */
function messageFromPi(message: Message, entryId: string, index: number, requestId?: string, byTaskId?: number): ChatMessage | undefined {
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
      // 无任务作用域的 entry（调度器的故障路径）保留 entry id：它没有需要保持同一的流式对应物。
      id: byTaskId === undefined ? id : assistantMessageId(byTaskId, message.timestamp),
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
      // 供输入框 tok/s 使用的纯解码时间（DSH 的 `completedTime - firstTokenTime` 折叠）：pi-ai
      // 计量整个请求，我们的流观察器打点 TTFT（未类型化，trajectory.ts），相减即去掉首 token
      // 延迟，工具时间永不进入分母。
      ...(message.durationMs !== undefined
        ? { requestDurationMs: Math.max(0, message.durationMs - Math.max(0, (message as AssistantMessage & { ttftMs?: number }).ttftMs ?? 0)) }
        : {}),
    }
  }
  return messageFromToolResult(message, entryId, index, requestId)
}

/** 错误文本脱敏：抹掉 authorization/bearer、各类密钥形 token、URL 内嵌凭据，压平空白并限 500 字符。 */
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

/** 功能：把一条工具结果消息投影为 `role: 'tool'` 的 ChatMessage（错误状态、可选 details 与 requestId）。 */
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

/** 从 entry 数据中读取 requestId（字符串才采信），供 run 归组使用。 */
function entryRequestId(entry: ConversationView['entries'][number]): string | undefined {
  const data = jsonRecord(entry.data)
  return data && isString(data.requestId) ? data.requestId : undefined
}

/**
 * 后台子智能体结算 entry 的状态行文案；其余 kind（以及外来写入者未带 label 的 entry）返回 undefined。
 * entry 的用户输入携带完整结算文本，但转录把它渲染为这行安静的系统行，而不是用户气泡。
 */
function settlementStatusText(entry: ConversationView['entries'][number]): string | undefined {
  if (entry.kind !== 'pi-web.subagent-settlement') return undefined
  const data = jsonRecord(entry.data)
  if (!data || !isString(data.label)) return undefined
  return data.status === 'failed' ? `后台子智能体「${data.label}」失败` : `后台子智能体「${data.label}」已完成`
}

/** 从 entry 数据中提取附件文件清单（name/path/mimeType/size 齐全才收），畸形条目丢弃。 */
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

/** 功能：把附件清单转换为 `type: 'file'` 的内容块（用户消息气泡下方的文件条）。 */
function fileBlocks(files: readonly { name: string; path: string; mimeType: string; size: number }[]): ContentBlock[] {
  return files.map(file => ({ type: 'file', name: file.name, path: file.path, mimeType: file.mimeType, size: file.size }))
}

/**
 * 功能：从读/写/编辑类工具调用的参数与结果中提取文件产物（FileArtifact）。
 * @param name 工具名（read/write/edit/nativeEdit/native_edit 之外返回空）。
 * @param args 工具调用参数（须含 path）。
 * @param details 工具结果 details（edit 可带 diff 与 firstChangedLine）。
 * @returns 产物列表；read 记行起点，write 记写入后内容，edit 记 before/after/diff。
 */
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

/** 功能：把用户输入（字符串或块）摊平为纯文本；纯图片输入返回"[图片]"，全空返回空串。 */
function inputText(content: UserInput): string {
  if (typeof content === 'string') return content
  const text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  return text || (content.some(part => part.type === 'image') ? '[图片]' : '')
}

/**
 * 功能：从 inbox 文档投影排队中的消息（steer/followUp）。
 * @returns 排队项数组（id、文本、模式、createdAt、图片与附件）。
 * 内部逻辑：write 模式（已写入 entry 的）不进队列；后台子智能体结算项是运行时通知而非用户草稿，
 * 露出来会让人误以为可编辑/撤回一条用户从未写的消息，队列永远不显示它；createdAt 依次取
 * options.queuedAt、metadata.queueCreatedAt、metadata.createdAt。
 */
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
    // 后台结算项在父会话忙碌期间待在 inbox，但它是运行时通知而非用户草稿：露出它会提供
    // 编辑/撤回一条用户从未写过的消息的机会，因此队列永不显示。
    if (entry?.kind === 'pi-web.subagent-settlement') return []
    const data = entry ? jsonRecord(entry.data) : undefined
    const files = Array.isArray(data?.files) ? data.files.flatMap(value => {
      const file = jsonRecord(value)
      if (!file || !isString(file.name) || !isString(file.path) || !isString(file.mimeType) || !isNumber(file.size)) return []
      return [{ name: file.name, path: file.path, mimeType: file.mimeType, size: file.size }]
    }) : []
    return [{ id, text, mode: item.mode, createdAt, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }]
  })
}

/** 功能：汇总 `pi.usage` 的两桶用量为 input/output/totalCost 合计；结构非法返回 undefined。 */
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

/**
 * 一个会话累计消耗的 token：对 `pi.usage` 两桶求和。DSH 的 `tokenTotal` 对四个互斥的
 * provider 桶求和（`SubagentHeaderLineage.tsx:67-75`）；Pi 的 `Usage.totalTokens` 恰为
 * input + output + cacheRead + cacheWrite，因此求和口径一致且不重复计数。
 */
export function usageTokens(value: unknown): number | undefined {
  if (!isUsageState(value)) return undefined
  let tokens = 0
  for (const usage of [...Object.values(value.models), ...Object.values(value.tools)]) tokens += usage.totalTokens
  return tokens
}

/**
 * 会话的总活跃时间：每个已结束 run 的时长加上 live run 已流逝的部分。run 的时长投影在它的
 * 最终助手回答（或 live partial）上，因此 `role: 'tool'` 行上的工具调用时长从不计入。
 * run 之间的空闲间隔被排除，与 DSH 的 `settledMs` + `active` 区间一致
 * （`SubagentHeaderLineage.tsx:77-90`）。
 */
export function activeDurationMs(messages: readonly ChatMessage[]): number | undefined {
  const perRun = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== 'assistant' || message.runId === undefined || message.durationMs === undefined) continue
    perRun.set(message.runId, Math.max(perRun.get(message.runId) ?? 0, message.durationMs))
  }
  if (perRun.size === 0) return undefined
  let total = 0
  for (const value of perRun.values()) total += value
  return total
}


const GOAL_PHASES = new Set<GoalPhase>(['active', 'paused', 'blocked', 'complete'])

/** 把 goal 文档读成线上形态：无 goal 键返回 undefined，goal 显式为 null 投影为 null，畸形记录亦为 undefined。 */
function goalView(value: unknown): GoalView | null | undefined {
  const record = jsonRecord(value)
  if (record === undefined || !('goal' in record)) return undefined
  const goal = jsonRecord(record.goal)
  if (goal === null) return null
  if (goal === undefined) return undefined
  const phase = goal.phase
  if (typeof goal.id !== 'string' || typeof goal.objective !== 'string'
    || typeof goal.revision !== 'number' || typeof goal.maxGoalRounds !== 'number'
    || typeof goal.roundsStarted !== 'number' || typeof goal.createdAt !== 'number'
    || typeof goal.updatedAt !== 'number' || typeof phase !== 'string' || !GOAL_PHASES.has(phase as GoalPhase)) return undefined
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: phase as GoalPhase,
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: goal.roundsStarted,
    ...(typeof goal.blockedReason === 'string' ? { blockedReason: goal.blockedReason } : {}),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  }
}

const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed'])

/** 把 plan 文档读成线上形态：没有显式 `active: true` 一律视为关闭。 */
function planView(value: unknown): PlanView {
  const record = jsonRecord(value)
  return { active: record?.active === true }
}

/** 把运行时的直接子会话列表读成线上形态，丢弃外来写入者留下的畸形行。 */
function subagentSummaries(value: unknown): SubagentSummary[] | undefined {
  if (value === undefined || !Array.isArray(value)) return undefined
  return value.flatMap<SubagentSummary>(raw => {
    const row = jsonRecord(raw)
    const id = row && isString(row.id) ? row.id : undefined
    if (row === undefined || id === undefined || !isNumber(row.createdAt) || !isNumber(row.updatedAt)) return []
    const status = row.status === 'running' ? 'running' as const : 'inactive' as const
    return [{
      id,
      label: isString(row.label) ? row.label : id,
      title: isString(row.title) ? row.title : id,
      status,
      answer: isString(row.answer) ? row.answer : '',
      ...(isNumber(row.tokens) ? { tokens: row.tokens } : {}),
      ...(isNumber(row.durationMs) ? { durationMs: row.durationMs } : {}),
      ...(isNumber(row.metricsAt) ? { metricsAt: row.metricsAt } : {}),
      ...(isString(row.model) ? { model: row.model } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }]
  })
}

const TEAM_MEMBER_PHASES = new Set<TeamMemberView['phase']>(['provisioning', 'active', 'failed'])
const TEAM_MEMBER_STATUSES = new Set<TeamMemberView['status']>(['running', 'inactive', 'provisioning', 'failed'])
const TEAM_TASK_STATUSES = new Set<TeamTaskView['status']>(['pending', 'in_progress', 'completed', 'deleted'])

/** 把运行时的团队投影读成线上形态（成员与任务两表），丢弃外来写入者留下的畸形行。 */
function teamRecords(value: unknown): TeamView | undefined {
  const record = jsonRecord(value)
  if (!record || !Array.isArray(record.members) || !Array.isArray(record.tasks)) return undefined
  const members = record.members.flatMap<TeamMemberView>(raw => {
    const row = jsonRecord(raw)
    if (!row || !isString(row.name) || (row.role !== 'lead' && row.role !== 'teammate')) return []
    if (typeof row.phase !== 'string' || !TEAM_MEMBER_PHASES.has(row.phase as TeamMemberView['phase'])) return []
    if (typeof row.status !== 'string' || !TEAM_MEMBER_STATUSES.has(row.status as TeamMemberView['status'])) return []
    return [{
      name: row.name,
      role: row.role,
      phase: row.phase as TeamMemberView['phase'],
      status: row.status as TeamMemberView['status'],
      ...(isString(row.conversationId) ? { conversationId: row.conversationId } : {}),
      ...(isString(row.label) ? { label: row.label } : {}),
      ...(isString(row.model) ? { model: row.model } : {}),
      ...(isString(row.error) ? { error: row.error } : {}),
    }]
  })
  const tasks = record.tasks.flatMap<TeamTaskView>(raw => {
    const row = jsonRecord(raw)
    if (!row || !isString(row.id) || typeof row.status !== 'string' || !TEAM_TASK_STATUSES.has(row.status as TeamTaskView['status'])) return []
    if (!isNumber(row.revision) || !isString(row.subject) || !isString(row.description)) return []
    if (!isNumber(row.createdAt) || !isNumber(row.updatedAt)) return []
    const strings = (input: unknown): string[] => Array.isArray(input) ? input.filter(isString) : []
    return [{
      id: row.id,
      revision: row.revision,
      subject: row.subject,
      description: row.description,
      status: row.status as TeamTaskView['status'],
      ...(isString(row.ownerName) ? { ownerName: row.ownerName } : {}),
      blockedBy: strings(row.blockedBy),
      writeScopes: strings(row.writeScopes),
      ready: row.ready === true,
      blocked: row.blocked === true,
      writeScopeWarnings: strings(row.writeScopeWarnings),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }]
  })
  return { members, tasks }
}

/** 把 todo 文档读成线上形态：items 显式为 null 返回 null（清空态），畸形条目丢弃。 */
function todoItems(value: unknown): TodoItem[] | null | undefined {
  const record = jsonRecord(value)
  if (record === undefined || !('items' in record)) return undefined
  const items = record.items
  if (items === null) return null
  if (!Array.isArray(items)) return undefined
  return items.flatMap(item => {
    const entry = jsonRecord(item)
    const content = typeof entry?.content === 'string' ? entry.content : undefined
    const status = entry?.status
    if (content === undefined || typeof status !== 'string' || !TODO_STATUSES.has(status as TodoItem['status'])) return []
    return [{ content, status: status as TodoItem['status'] }]
  })
}

const QUESTION_TOOL = 'ask_user_question'
const PLAN_REVIEW_TOOL = 'exit_plan_mode'

/** 从工具参数或 `pi-web.interactions` 文档解析问题列表；畸形条目丢弃，空集返回 undefined。 */
function askQuestionList(value: unknown): AskUserQuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const questions = value.flatMap<AskUserQuestionItem>(raw => {
    const item = jsonRecord(raw)
    if (!item || !isString(item.id) || !isString(item.question)) return []
    const options = Array.isArray(item.options)
      ? item.options.flatMap(rawOption => {
        const option = jsonRecord(rawOption)
        if (!option || !isString(option.label)) return []
        return [{ label: option.label, ...(isString(option.description) ? { description: option.description } : {}) }]
      })
      : undefined
    return [{
      id: item.id,
      question: item.question,
      ...(isString(item.header) ? { header: item.header } : {}),
      ...(options ? { options } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    }]
  })
  return questions.length ? questions : undefined
}

/** 解析一组用户答复（id + selected 必备、custom 可选）；畸形条目丢弃，空集返回 undefined。 */
function askQuestionAnswers(value: unknown): AskUserQuestionAnswerItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const answers = value.flatMap<AskUserQuestionAnswerItem>(raw => {
    const answer = jsonRecord(raw)
    if (!answer || !isString(answer.id) || !Array.isArray(answer.selected)) return []
    const selected = answer.selected.filter(isString)
    return [{ id: answer.id, selected, ...(isString(answer.custom) ? { custom: answer.custom } : {}) }]
  })
  return answers.length ? answers : undefined
}

/** 交互文档中一条提问调用的独立记录形态：问题集、提问时间与状态（含已保存的答复）。 */
type StoredInteractionView = {
  callId: string
  questions: AskUserQuestionItem[]
  askedAt: number
  status: 'pending' | 'answered' | 'cancelled'
  answers?: AskUserQuestionAnswerItem[]
  answeredAt?: number
}

/** 把会话交互文档读成独立请求记录，丢弃外来写入者弄畸形的一切条目。 */
function storedInteractions(value: unknown): StoredInteractionView[] {
  const record = jsonRecord(value)
  if (!record) return []
  return Object.entries(record).flatMap(([callId, raw]) => {
    const entry = jsonRecord(raw)
    if (!entry || !isNumber(entry.askedAt)
      || (entry.status !== 'pending' && entry.status !== 'answered' && entry.status !== 'cancelled')) return []
    const questions = askQuestionList(entry.questions)
    if (!questions) return []
    const answers = askQuestionAnswers(entry.answers)
    return [{
      callId,
      questions,
      askedAt: entry.askedAt,
      status: entry.status,
      ...(answers ? { answers } : {}),
      ...(isNumber(entry.answeredAt) ? { answeredAt: entry.answeredAt } : {}),
    }]
  })
}

/**
 * 从交互文档中读出计划审阅记录。它们与提问调用共用文档但记录形态不同；文档比压缩更长寿，
 * 因此工具调用离开活跃视图后审阅卡片依然可用。
 */
function storedPlanReviews(value: unknown): InteractionRequest[] {
  const record = jsonRecord(value)
  if (!record) return []
  return Object.entries(record).flatMap(([callId, raw]) => {
    const review = planReviewOf(raw)
    if (!review) return []
    const answers = askQuestionAnswers(review.answers)
    return [{
      id: callId,
      kind: 'plan-review' as const,
      // 被"继续"取代的审阅不再等待任何人：`continued` 就是它的线上状态。
      status: review.status === 'superseded' ? 'continued' as const : review.status,
      detail: review.detail,
      approveLabel: review.approveLabel,
      ...(review.approved === undefined ? {} : { approved: review.approved }),
      ...(review.feedback === undefined ? {} : { feedback: review.feedback }),
      ...(answers ? { answer: { answers } } : {}),
      createdAt: review.askedAt,
      ...(review.answeredAt === undefined ? {} : { answeredAt: review.answeredAt }),
    }]
  })
}

/** 把 Pi 模型引用复制为 wire 形态（缺省返回 undefined）。 */
function modelCopy(model: PiModelRef | undefined): ConversationSummary['model'] {
  return model ? { provider: model.provider, modelId: model.modelId } : undefined
}

/** 把字符串思考级别收敛为合法枚举；未知/缺省回落 medium。 */
function thinkingLevel(value: string | undefined): ThinkingLevel {
  return thinkingLevels.find(level => level === value) ?? 'medium'
}

/** 续起交互暂停轮次的回复 entry 类型：答复、关闭、计划审阅回复与计划审阅关闭。 */
const INTERACTION_REPLY_ENTRY_KINDS = new Set(['pi-web.user-question-reply', 'pi-web.user-question-dismissed', 'pi-web.plan-review-reply', 'pi-web.plan-review-dismissed'])

/** 四类回复请求的 requestId 前缀，与 INTERACTION_REPLY_ENTRY_KINDS 一一对应。 */
const INTERACTION_REPLY_PREFIXES = ['question-reply:', 'question-dismiss:', 'plan-review-reply:', 'plan-review-dismiss:']

/** 解析回复请求命中的调用 id；其他请求 id 返回 undefined。 */
function interactionReplyCallId(request: string): string | undefined {
  const prefix = INTERACTION_REPLY_PREFIXES.find(candidate => request.startsWith(candidate))
  return prefix === undefined ? undefined : request.slice(prefix.length)
}

/** 回复 entry 归属的运行：提出该问题或提交该计划的工具调用所在的那次运行。 */
function interactionReplyRunId(entry: ConversationView['entries'][number], interactionRuns: ReadonlyMap<string, string>): string | undefined {
  if (!INTERACTION_REPLY_ENTRY_KINDS.has(entry.kind)) return undefined
  const data = jsonRecord(entry.data)
  const callId = data && isString(data.callId) ? data.callId : undefined
  return callId === undefined ? undefined : interactionRuns.get(callId)
}

/**
 * 确定当前 live 运行归属的 run id。
 * @param live 运行态文档。
 * @param metadata 会话元数据（requestReceipts 把 submissionId 映射到 requestId）。
 * @param fallback 无运行输入时的回落值。
 * @param interactionRuns callId → runId 的映射。
 * @returns run id；找不到时返回 fallback。
 * 内部逻辑：由 run 的输入 submissionId 反查请求 id；交互回复的 live 尾巴并入"它所回答的调用"
 * 所属的运行（与其已结算 entry 一致），回答问题不会在屏幕上把一轮切成两半；queue-edit 前缀
 * 剥离后作为 run 名。
 */
function runIdForLive(live: LiveState, metadata: ConversationMetadata, fallback: string | undefined, interactionRuns: ReadonlyMap<string, string>): string | undefined {
  const inputIds = live.run?.inputs
  if (!inputIds?.length) return fallback
  const request = Object.entries(metadata.requestReceipts).find(([, receipt]) => receipt.submissionId !== null && inputIds.some(id => id === receipt.submissionId))?.[0]
  if (request === undefined) return fallback
  // 交互回复的 live 尾巴并入它所回答的调用所在的那次运行——与已结算 entry 相同，回答问题
  // 永不在屏幕上把一轮劈成两半。
  const callId = interactionReplyCallId(request)
  if (callId !== undefined) return interactionRuns.get(callId) ?? fallback
  return `run:${request.startsWith('queue-edit:') ? request.slice('queue-edit:'.length) : request}`
}

/** 把未知值读成 MessageUsage（token 五字段与成本五字段齐全才收），否则 undefined。 */
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

/** 判断两条助手消息是否同一（时间戳/provider/model/内容序列化一致），用于防止 partial 与 entry 重复。 */
function sameAssistant(left: AssistantMessage, right: AssistantMessage): boolean {
  return left.timestamp === right.timestamp && left.provider === right.provider && left.model === right.model &&
    JSON.stringify(left.content) === JSON.stringify(right.content)
}

/**
 * 功能：把 live 运行态中尚未结算的工具槽投影为 `role: 'tool'` 消息。
 * @param settledToolCallIds 已在 entry 中结算的工具调用 id（跳过，避免重复）。
 * @param entryIds 已见 entry 编号（槽位带 entry 时同样跳过）。
 * @param timestamp 消息时间戳（进度时间）。
 * @param runId 归属的 run。
 * @returns 直接工具与嵌套工具两条队列投影出的消息列表（streaming 标记为 true）。
 * 内部逻辑：直接槽 diagnostics 含 error 则 isError；嵌套槽以 summary.isError 判定并附 durationMs。
 */
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

/** 浏览器可见的压缩状态：进行中的任务与最近一次失败；两者皆无时返回 undefined。 */
function compactionViewOf(live: LiveState): CompactionView | undefined {
  const running = live.compactions?.[0]
  const failure = live.compactionFailure
  if (running === undefined && failure === undefined) return undefined
  return {
    running: running !== undefined,
    ...(running === undefined ? {} : { reason: running.reason, blocking: running.blocking, attempt: running.attempt }),
    ...(failure === undefined ? {} : { failure: safeError(failure.error) }),
  }
}

/**
 * 功能：把一个 Pi Durable 会话视图投影为稳定的浏览器 DTO（ConversationDetail）。
 * @param view 持久视图：entries、docs（pi.agent/pi.live/pi.usage 等）与 conversation 元信息。
 * @param metadata 运行时维护的会话元数据（标题、反馈映射、请求回执、seenAt 等）。
 * @param options 附加投影来源（pi-web 文档与运行时计算的子会话/团队）。
 * @returns ConversationDetail：conversation 摘要 + messages + queue + todos/goal/plan/
 * interactions/subagents/team/compaction/error/usage。
 * 内部逻辑：主循环逐 entry 重建消息——run 归组（交互回复并入对应运行）、助手身份键、
 * 工具产物与耗时、提问调用收集；结算 entry 的系统行（重置/压缩/子智能体结算）；随后用
 * interactions 文档补齐 entry 已丢失的调用；live partial 以同一身份键挂载（防重复）；
 * 最后投影 live 工具消息、回填每轮 durationMs、汇总最新错误与用量。
 */
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
  const questionCalls = new Map<string, QuestionCall>()
  const questionReplies: QuestionReply[] = []
  const runStartedAt = new Map<string, number>()
  const finalAssistantByRun = new Map<string, ChatMessage>()
  /** 每次交互调用归属的运行，保证其回复与后续留在同一轮。 */
  const interactionRunByCallId = new Map<string, string>()
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
    const statusText = entry.kind === 'pi.reset' ? '上下文已重置' : entry.kind === 'pi.compaction' ? '已完成上下文压缩' : undefined
    const settlementText = settlementStatusText(entry)
    // 交互回复续起 ask/plan 工具暂停的那一轮，因此并入"提出调用的那次运行"，
    // 而不是以回复请求另开一轮（对齐 ZCode 的形态）。
    const replyRunId = interactionReplyRunId(entry, interactionRunByCallId)
    for (const [index, message] of entryMessages.entries()) {
      lastTimestamp = message.timestamp
      latestEntryTimestamp = Math.max(latestEntryTimestamp, message.timestamp)
      if (message.role === 'system' || statusText !== undefined) continue
      if (message.role === 'user') {
        const placedDuringToolRound = entry.byTaskId !== undefined && entry.byTaskId === previousAssistantTask && previousAssistantCallsTools
        if (replyRunId !== undefined) currentRunId = replyRunId
        else if (!placedDuringToolRound || !currentRunId) currentRunId = `run:${requestId ?? id}`
        if (!runStartedAt.has(currentRunId)) runStartedAt.set(currentRunId, message.timestamp)
        // 结算输入没有自己的气泡：下方的 entry 状态行承载它。上方的 run 记账仍然生效，
        // 行因此落在它所属的运行内——交互回复落在它所回答的调用的那轮里。
        if (settlementText !== undefined) continue
      } else if (!currentRunId) {
        currentRunId = `run:${requestId ?? id}`
        runStartedAt.set(currentRunId, message.timestamp)
      }
      const projected = messageFromPi(message, id, index, requestId, entry.byTaskId)
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
      if (message.role === 'toolResult') {
        settledToolCallIds.add(message.toolCallId)
        if (message.toolName === QUESTION_TOOL) {
          const call = questionCalls.get(message.toolCallId)
          if (call) {
            const details = jsonRecord(message.details)
            if (message.isError) call.result = 'errored'
            else if (details?.status === 'answered') call.result = 'answered'
            else if (details?.status === 'pending') call.result = 'pending'
          }
        }
      }
      if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type === 'toolCall') {
            callTimestamps.set(part.id, message.timestamp)
            callArguments.set(part.id, { name: part.name, arguments: { ...part.arguments } })
            if (part.name === QUESTION_TOOL) {
              const questions = askQuestionList(jsonRecord(part.arguments)?.questions)
              if (questions) questionCalls.set(part.id, { callId: part.id, questions, askedAt: message.timestamp })
            }
            if ((part.name === QUESTION_TOOL || part.name === PLAN_REVIEW_TOOL) && currentRunId !== undefined) {
              interactionRunByCallId.set(part.id, currentRunId)
            }
          }
        }
      }
    }

    if (entry.kind === 'pi-web.user-question-reply') {
      const data = jsonRecord(entry.data)
      const callId = data && isString(data.callId) ? data.callId : undefined
      const answers = data ? askQuestionAnswers(data.answers) : undefined
      if (callId && answers) {
        const repliedAt = entryMessages.find(message => message.role === 'user')?.timestamp ?? lastTimestamp
        questionReplies.push({ callId, answers, repliedAt })
      }
    }

    if (statusText !== undefined) {
      messages.push({
        id: `entry:${id}:status`,
        entryId: id,
        role: 'system',
        systemKind: entry.kind === 'pi.compaction' ? 'compaction' : 'reset',
        blocks: [{ type: 'text', text: statusText }],
        timestamp: lastTimestamp,
        ...(currentRunId ? { runId: currentRunId } : {}),
      })
    }
    if (settlementText !== undefined) {
      // 结算行保留无 host systemKind 的普通 system 形态：转录按文本渲染任意 system 行，
      // 共享类型中的 wire 联合类型也没有 settlement 成员。
      messages.push({
        id: `entry:${id}:status`,
        entryId: id,
        role: 'system',
        blocks: [{ type: 'text', text: settlementText }],
        timestamp: lastTimestamp,
        ...(currentRunId ? { runId: currentRunId } : {}),
      })
    }
  }

  // 该文档比压缩更长寿：它保存的调用与答复填上活跃 entry 已丢失的部分。
  for (const stored of storedInteractions(options.interactions)) {
    const call = questionCalls.get(stored.callId)
    const result = stored.status === 'answered' ? 'answered' as const
      : stored.status === 'cancelled' ? 'cancelled' as const
        : call?.result
    questionCalls.set(stored.callId, {
      callId: stored.callId,
      questions: stored.questions,
      askedAt: call?.askedAt ?? stored.askedAt,
      ...(result ? { result } : {}),
    })
    if (stored.status === 'answered' && stored.answers && !questionReplies.some(reply => reply.callId === stored.callId)) {
      questionReplies.push({ callId: stored.callId, answers: stored.answers, repliedAt: stored.answeredAt ?? stored.askedAt })
    }
  }
  const interactions = [
    ...foldInteractions([...questionCalls.values()], questionReplies),
    ...storedPlanReviews(options.interactions),
  ].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))

  const partial = live.generation?.message
  const activeRunId = runIdForLive(live, metadata, currentRunId, interactionRunByCallId)
  if (partial) {
    latestEntryTimestamp = Math.max(latestEntryTimestamp, partial.timestamp)
    if (!settledAssistantMessages.some(message => sameAssistant(message, partial))) {
      const blocks = assistantBlocks(partial)
      const errorMessage = partial.errorMessage ? safeError(partial.errorMessage) : undefined
      if (errorMessage && !blocks.some(block => block.type === 'text' && block.text === errorMessage)) {
        blocks.push({ type: 'text', text: errorMessage })
      }
      messages.push({
        // 与已结算 entry 相同的身份键：运行的 task 与请求时间戳。partial 变成替换它的 entry
        // 时，浏览器能把这条消息保持挂载。
        id: assistantMessageId(live.run?.taskId, partial.timestamp),
        role: 'assistant',
        blocks,
        timestamp: partial.timestamp,
        streaming: true,
        isError: partial.stopReason === 'error',
        status: partial.stopReason === 'error' ? 'error' : partial.stopReason === 'aborted' ? 'cancelled' : 'running',
        ...(activeRunId ? { runId: activeRunId } : {}),
        ...(messageUsage(partial.usage) ? { usage: messageUsage(partial.usage) } : {}),
        ...(activeRunId && runStartedAt.has(activeRunId) ? { durationMs: Math.max(0, Date.now() - (runStartedAt.get(activeRunId) ?? partial.timestamp)) } : {}),
        // 在途模型请求时间：partial 的时间戳即请求开始时刻。
        requestDurationMs: Math.max(0, Date.now() - partial.timestamp),
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
    // ZCode 的侧栏小圆点：读者尚未查看的助手回复。只有已结算的轮次算数，
    // 流式中的运行绝不当作"未读"。
    ...(live.run === undefined && latestAssistant !== undefined && latestAssistant.timestamp > (metadata.seenAt ?? 0)
      ? { unread: true }
      : {}),
    // owner 边把子智能体会话挡在侧栏与控制路由之外。
    ...(view.conversation.owner ? { origin: 'subagent' as const, parentId: String(view.conversation.owner.conversationId) } : {}),
    ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    accessMode: metadata.accessMode,
    ...(options.kind === 'defectAnalysis' ? { kind: options.kind } : {}),
    ...(summaryRunId ? { runId: summaryRunId } : {}),
    ...(summaryRunStartedAt !== undefined ? { runStartedAt: summaryRunStartedAt } : {}),
    ...(summaryDuration !== undefined ? { durationMs: summaryDuration } : {}),
    ...(runStatus ? { status: runStatus } : {}),
    ...(model ? { model } : {}),
    thinkingLevel: thinkingLevel(agent?.thinkingLevel),
    cwd: agent?.cwd ?? options.workspace ?? '',
  }

  const usage = usageSummary(view.docs['pi.usage'])
  const todos = todoItems(options.todos)
  const goal = goalView(options.goal)
  const subagents = subagentSummaries(options.subagents)
  const team = teamRecords(options.team)
  const compaction = compactionViewOf(live)
  return {
    conversation,
    messages,
    queue: queueItems(view, metadata, options),
    plan: planView(options.plan),
    ...(todos !== undefined ? { todos } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(interactions.length ? { interactions } : {}),
    ...(subagents?.length ? { subagents } : {}),
    ...(team ? { team } : {}),
    ...(compaction ? { compaction } : {}),
    ...(latestError ? { error: latestError } : {}),
    ...(usage ? { usage } : {}),
  }
}
