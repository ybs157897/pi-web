import { isInteractionPayloadText } from './interaction-payload.ts'
import type { ChatMessage, ContentBlock, FileArtifact, InteractionRequest, MessageUsage } from '../shared/types.ts'
import { groupProcessParts, type ProcessToolGroupKind } from './process-grouping.ts'

/** 一条工具调用渲染项：调用块、配对结果、父子嵌套与排序。 */
export interface ToolItem {
  readonly key: string
  readonly message: ChatMessage
  readonly call?: Extract<ContentBlock, { type: 'toolCall' }>
  readonly result?: ChatMessage
  readonly parentToolCallId?: string
  readonly children: readonly ToolItem[]
  readonly order: number
}

/** 过程区的部件：交错用户行、思考、正文、工具行与工具分组（toolGroup 由 process-grouping 合成）。 */
export type ProcessPart =
  | { readonly kind: 'user'; readonly key: string; readonly message: ChatMessage; readonly order: number }
  | { readonly kind: 'reasoning'; readonly key: string; readonly message: ChatMessage; readonly text: string; readonly redacted: boolean; readonly streaming: boolean; readonly order: number }
  | { readonly kind: 'content'; readonly key: string; readonly message: ChatMessage; readonly block: ContentBlock; readonly streaming: boolean; readonly order: number }
  | { readonly kind: 'tool'; readonly key: string; readonly item: ToolItem; readonly order: number }
  | {
      readonly kind: 'toolGroup'
      readonly key: string
      readonly group: ProcessToolGroupKind
      readonly items: readonly ToolItem[]
      readonly order: number
    }

/** 答案区的一段响应：一条助手消息的全部内容块。 */
export interface ResponsePart {
  readonly key: string
  readonly message: ChatMessage
  readonly blocks: readonly ContentBlock[]
}

/** DSH 的工具分类，按调用数排序后拼成过程分组标题。 */
export type ToolActivity = 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/** 团队家族工具归入 subagent 活动类：同属多智能体工作，行展示更友好。 */
const TEAM_TOOL_NAMES = new Set(['spawn_teammate', 'wait_agent', 'send_message', 'list_agents', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'])

/**
 * 功能：工具名 → DSH 分类映射（行自身的标题另出）。
 * @param name 工具名（大小写不敏感）
 * @returns ToolActivity 之一；未收录归 'tools'
 */
export function toolActivity(name: string): ToolActivity {
  const id = name.toLocaleLowerCase()
  if (['read', 'read_file', 'readfile', 'read_text_file', 'cat'].includes(id)) return 'read'
  if (id === 'read_image') return 'readImage'
  if (['grep', 'ripgrep', 'glob', 'search', 'search_files', 'list_files', 'find', 'find_files'].includes(id) || id.endsWith('_inspect')) return 'search'
  if (['write', 'write_file', 'writefile', 'create_file'].includes(id)) return 'write'
  if (['edit', 'edit_file', 'nativeedit', 'native_edit', 'apply_patch', 'patch'].includes(id)) return 'edit'
  if (['bash', 'pwsh', 'shell', 'shell_session', 'exec', 'exec_command', 'run_command', 'terminal', 'write_stdin'].includes(id) || id.startsWith('terminal_')) return 'commands'
  if (id === 'run_code' || id === 'codemode') return 'code'
  if (['web_search', 'search_web', 'browser_search'].includes(id)) return 'webSearch'
  if (['web_fetch', 'fetch_url', 'fetch'].includes(id)) return 'webFetch'
  if (id === 'subagent' || id.startsWith('subagent_') || TEAM_TOOL_NAMES.has(id)) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode', 'enter_plan_mode'].includes(id)) return 'plan'
  if (id === 'ask_user_question' || id === 'request_user_input') return 'questions'
  return 'tools'
}

/** 某类活动的调用计数。 */
export interface ActivityCount {
  readonly kind: ToolActivity
  readonly count: number
}

/** 不属于任何 run 的系统行；转录区把它渲染在所分隔的 run 之间。 */
export interface RenderSystemRow {
  readonly key: string
  readonly message: ChatMessage
}

/** 记录在 run 内部的系统行；转录区把它渲染在该 run 里。 */
export interface RenderRunSystemRow extends RenderSystemRow {
  /** run 的答案在这行之后，所以该行归属答案上方。 */
  readonly beforeAnswer: boolean
}

/** 转录时间线的一个条目：一个 run，或一条无主系统行。 */
export type RenderTimelineEntry =
  | { readonly kind: 'run'; readonly run: RenderRun }
  | { readonly kind: 'system'; readonly row: RenderSystemRow }

/** 一个回合（run）的完整渲染模型：用户行、过程、答案、系统行、产物与状态。 */
export interface RenderRun {
  readonly key: string
  readonly runId?: string
  readonly users: readonly ChatMessage[]
  readonly messages: readonly ChatMessage[]
  readonly process: readonly ProcessPart[]
  readonly responses: readonly ResponsePart[]
  /** 记录在本 run 内的系统行，按日志记录顺序。 */
  readonly systemRows: readonly RenderRunSystemRow[]
  readonly artifacts: readonly FileArtifact[]
  /** 工具分类按去重调用数排序，平手按首次出现（DSH 规则）。 */
  readonly activityCounts: readonly ActivityCount[]
  readonly failedTools: number
  readonly stoppedTools: number
  readonly status: 'running' | 'completed' | 'error' | 'cancelled'
  readonly durationMs?: number
  readonly usage?: MessageUsage
}

/** 整个会话的渲染模型：run 列表 + 转录时间线。 */
export interface RenderModel {
  readonly runs: readonly RenderRun[]
  /** run 与无主系统行，按转录顺序。 */
  readonly timeline: readonly RenderTimelineEntry[]
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

/** 一条已记录的系统消息及其在持久日志中的位置。 */
interface SystemEntry {
  readonly message: ChatMessage
  readonly index: number
}

/** 一条无主系统行，及其在消息流中跟随的 run。 */
interface LooseSystemRow {
  readonly row: RenderSystemRow
  /** 所跟随 run 的位置；先于所有 run 时为 -1。 */
  readonly anchor: number
}

/**
 * 功能：把持久消息日志按用户输入切分成 run 并保持记录顺序，构建整个转录的渲染模型。
 * @param messages 会话消息（用户/助手/工具/系统混合）
 * @param interactions 交互投影记录（pending 的提问/计划评审会暂停 run）
 * @returns RenderModel：runs + timeline
 * 内部逻辑：用户消息按 runId 归并或新开 run（requestId 兜底）；answer/dismissal 机器载荷开 run 但不产生气泡；无 runId 的助手消息并入当前 active run；系统行带 runId 的挂在 run 内（答案前/后），无 runId 的作为 loose 行锚定到「已开始的最后一个 run」之后。
 */
export function buildRenderModel(messages: readonly ChatMessage[], interactions?: readonly InteractionRequest[]): RenderModel {
  const pendingInteractionCalls = new Set((interactions ?? [])
    .filter(interaction => interaction.status === 'pending').map(interaction => interaction.id))
  const mutableRuns: MutableRun[] = []
  const byRunId = new Map<string, MutableRun>()
  const systemEntries: SystemEntry[] = []
  const logIndex = new Map<string, number>()
  let active: MutableRun | undefined

  for (const [index, message] of messages.entries()) {
    logIndex.set(message.id, index)
    if (message.role === 'system') {
      systemEntries.push({ message, index })
      continue
    }
    if (message.role === 'user') {
      // 应答/关闭类机器载荷会开启 run 但没有气泡：内容归属 ask_user_question 行，
      // 因此不能变成用户行或交错部件。
      const hidden = isInteractionPayloadText(messageText(message))
      const existing = message.runId === undefined ? undefined : byRunId.get(message.runId)
      if (existing !== undefined) {
        if (!hidden) existing.users.push(message)
        existing.messages.push(message)
        active = existing
      } else {
        const run: MutableRun = {
          key: stableRunKey(message),
          ...(message.runId === undefined ? {} : { runId: message.runId }),
          users: hidden ? [] : [message],
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

  const orderedRuns = mutableRuns.sort((left, right) => left.firstIndex - right.firstIndex)
  const runPositions = new Map<string, number>()
  orderedRuns.forEach((run, position) => { if (run.runId !== undefined) runPositions.set(run.runId, position) })

  const rowsByRun = new Map<number, RenderRunSystemRow[]>()
  const looseRows: LooseSystemRow[] = []
  for (const entry of systemEntries) {
    const row: RenderSystemRow = { key: `system:${entry.message.id}`, message: entry.message }
    const position = entry.message.runId === undefined ? undefined : runPositions.get(entry.message.runId)
    if (position === undefined) {
      // 无 run 的行保持在消息流中的位置：跟随「已开始的最后一个 run」，
      // 替换更早历史的行于是留在替换它的内容上方。
      let anchor = -1
      for (const [runPosition, run] of orderedRuns.entries()) {
        if (run.firstIndex < entry.index) anchor = runPosition
      }
      looseRows.push({ row, anchor })
      continue
    }
    const answer = finalResponseOf(orderedRuns[position].messages)
    const answerIndex = answer === undefined ? undefined : logIndex.get(answer.id)
    const rows = rowsByRun.get(position) ?? []
    rows.push({ ...row, beforeAnswer: answerIndex !== undefined && entry.index < answerIndex })
    rowsByRun.set(position, rows)
  }

  const runs = orderedRuns.map((run, position) => createRenderRun(run, rowsByRun.get(position) ?? [], pendingInteractionCalls))
  return { runs, timeline: buildTimeline(runs, looseRows) }
}

/**
 * 功能：把 run 序列与无主系统行交织成转录时间线。
 * @param runs 渲染 run（按日志顺序）
 * @param looseRows 无主系统行（带锚点）
 * @returns 时间线条目序列
 * 内部逻辑：行按 anchor 分桶，anchor=-1 的在最前，其余排在自己跟随的 run 之后。
 */
function buildTimeline(runs: readonly RenderRun[], looseRows: readonly LooseSystemRow[]): RenderTimelineEntry[] {
  const anchors = new Map<number, RenderSystemRow[]>()
  for (const loose of looseRows) {
    const bucket = anchors.get(loose.anchor) ?? []
    bucket.push(loose.row)
    anchors.set(loose.anchor, bucket)
  }
  const timeline: RenderTimelineEntry[] = []
  const pushRows = (anchor: number): void => {
    for (const row of anchors.get(anchor) ?? []) timeline.push({ kind: 'system', row })
  }
  pushRows(-1)
  for (const [position, run] of runs.entries()) {
    timeline.push({ kind: 'run', run })
    pushRows(position)
  }
  return timeline
}

/** run 的稳定 key：requestId 优先，无则用消息 id。 */
function stableRunKey(message: ChatMessage): string {
  return `run:${message.requestId ?? message.id}`
}

/**
 * 功能：把一个可变 run 骨架展开成完整 RenderRun：配对工具调用与结果、建工具树、
 * 划分过程/答案、推导状态与指标。
 * @param run 可变 run 骨架（users/messages/firstIndex）
 * @param systemRows 归属该 run 的系统行
 * @param pendingInteractionCalls 仍 pending 的交互调用 id 集合
 * 内部逻辑：工具树由 parentToolCallId 挂接（环状的父链会把首条成员提升为根，保证所有持久工具结果可见）；「活」的工具结果行（调用块尚未持久化）按已携带的 callId 命名 key，落定配对时 DOM 不重挂；pending 交互或其后 reply 之前的正文归过程区，最后一个流式中的助手回合独占答案区。
 */
function createRenderRun(run: MutableRun, systemRows: readonly RenderRunSystemRow[], pendingInteractionCalls: ReadonlySet<string>): RenderRun {
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
  const claimedCallIds = new Set<string>()
  for (const [messageIndex, message] of run.messages.entries()) {
    if (message.role !== 'tool' || message.toolCallId !== undefined && callItems.has(message.toolCallId)) continue
    // 「活」的工具结果行先于其持久调用块出现。用已携带的 callId 命名 key，落定的
    // 调用块配到该 id 时行保持 DOM 不变；若用消息 id，恰好在那个边界上 key 会变、
    // 行被重挂。
    const key = message.toolCallId !== undefined && !claimedCallIds.has(message.toolCallId)
      ? `tool:${message.toolCallId}`
      : `tool-result:${message.id}`
    if (message.toolCallId !== undefined) claimedCallIds.add(message.toolCallId)
    allTools.push({
      key,
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
  // 畸形的父链可能形成闭环；把第一个记录的成员提升为根，保证每个持久工具结果都可见。
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
  // 仍在等用户的交互会把 run 停在回合中段，因此模型围绕 pending 调用写的正文是中间
  // 工作而绝非答案：把它提升成答案会让读者停在那段话上，回复一恢复 run 它就得跳进
  // 工作分组。持久工具结果在写入时冻结了 `details.status`，所以 pending 从交互记录读取。
  const interactionPending = hasPendingInteractionCall(run.messages, pendingInteractionCalls)
  // 交互解决后，reply 载荷是日志内的分界：其后写入的内容属于被暂停的回合、留在工作
  // 分组里，「已应答」到续写首 token 之间的空帧就不会复活旧正文。
  const answerBarrier = interactionPending ? run.messages.length : lastInteractionReplyIndex(run.messages) + 1
  const candidates = run.messages.slice(answerBarrier)
  const finalResponse = interactionPending ? undefined : finalResponseOf(candidates)
  // 仍在流式的生成会顶替已落定的答案：它写出自己的文本之前，上一个答案降级为过程内容，
  // 时间线保持时序——直播思考行必须排在其正文之后（ZCode 的严格顺序），
  // 而不是飘在一段已完成段落上方。
  const liveAnswer = candidates.findLast(message => isLiveAnswer(message))
  for (const [messageIndex, message] of run.messages.entries()) {
    if (message.role === 'user' && message.id !== run.users[0]?.id && !isInteractionPayloadText(messageText(message))) {
      process.push({ kind: 'user', key: `${message.id}:interleaved`, message, order: messageIndex })
    }
    // 仍在流式的回合独占答案区：尚未落定，块在两区之间移动会造成画面跳动。
    const answer = message.role === 'assistant'
      && (liveAnswer !== undefined
        ? message.id === liveAnswer.id
        : message.id === finalResponse?.id)
    // 模型最后写消息的尾部，所以只有那个块还在流式。
    const tail = liveTailIndex(message.blocks)
    for (const [blockIndex, block] of message.blocks.entries()) {
      const slot = block.slot ?? blockIndex
      const streaming = message.streaming === true && blockIndex === tail
      if (message.role === 'assistant' && block.type === 'thinking' && (block.text.trim() !== '' || block.redacted === true)) {
        process.push({ kind: 'reasoning', key: `${message.id}:reasoning:${slot}`, message, text: block.text,
          redacted: block.redacted === true, streaming, order: messageIndex + blockIndex / 1000 })
      }
      if (message.role === 'assistant' && !answer && isContentBlock(block) && blockCarriesContent(block)) {
        process.push({ kind: 'content', key: `${message.id}:process:${slot}`, message, block,
          streaming, order: messageIndex + blockIndex / 1000 })
      }
    }
    if (answer) {
      const blocks = message.blocks.filter(block => isContentBlock(block) && blockCarriesContent(block))
      if (blocks.length > 0) responses.push({ key: `${message.id}:response`, message, blocks })
    }
    if (message.role === 'tool' && message.toolCallId === undefined) {
      // 没有持久调用 id 的结果仍作为独立过程行显示。
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
  const groupedProcess = groupProcessParts(process)

  const status = runStatus(run.messages)
  // 毫秒级工具与刚开跑的 partial 都会带 durationMs: 0；run 级时长要么为正、
  // 要么视为未知（undefined），否则折叠头会渲染出「已工作 0 秒」。
  const durationMs = run.messages.reduce<number | undefined>((latest, message) => (
    message.durationMs === undefined || message.durationMs <= 0 ? latest : Math.max(latest ?? 0, message.durationMs)
  ), undefined)
  const usage = sumUsage(run.messages)
  const artifacts = uniqueArtifacts(run.messages.flatMap(message => message.artifacts ?? []))
  return {
    key: run.key,
    ...(run.runId === undefined ? {} : { runId: run.runId }),
    users: run.users,
    messages: run.messages,
    process: groupedProcess,
    responses,
    systemRows,
    artifacts,
    ...summarizeToolActivities(roots),
    status,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * 功能：找 run 的已落定答案：最后一个带内容且不含工具调用的顶层助手回合。
 * @returns 该消息；没有返回 undefined
 */
function finalResponseOf(messages: readonly ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find(message => message.role === 'assistant'
    && message.parentToolCallId === undefined
    && !message.blocks.some(block => block.type === 'toolCall')
    && message.blocks.some(block => block.type === 'text' && block.text !== '' || block.type === 'image' || block.type === 'file'))
}

/**
 * 功能：判断 run 是否仍在等待交互调用（用户未回答的提问或计划评审）。
 * 投影的交互记录是唯一活来源：持久工具结果永远保留写入时的 `pending` 状态——
 * 因为答复以独立 reply 条目落盘，不改写它。
 */
function hasPendingInteractionCall(messages: readonly ChatMessage[], pendingInteractionCalls: ReadonlySet<string>): boolean {
  if (pendingInteractionCalls.size === 0) return false
  return messages.some(message => message.role === 'assistant'
    && message.blocks.some(block => block.type === 'toolCall' && pendingInteractionCalls.has(block.id)))
}

/** run 内最新的交互 reply 载荷位置；它之前的内容属于被暂停的回合。 */
function lastInteractionReplyIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && isInteractionPayloadText(messageText(message))) return index
  }
  return -1
}

/**
 * 功能：判断一条流式中的助手回合是否是 run 的「直播答案」：它独占答案区直到落定，
 * 保证模型还在写时文本块不会在过程区与答案区之间来回跳。
 */
function isLiveAnswer(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.streaming === true && message.parentToolCallId === undefined
}

/** 回答用户的块类型：文本、图片与文件。 */
function isContentBlock(block: ContentBlock): boolean {
  return block.type === 'text' || block.type === 'image' || block.type === 'file'
}

/**
 * 功能：判断一个块是否显示了东西。投影会保留模型尚未写出的块，所以空块在渲染层丢弃。
 */
function blockCarriesContent(block: ContentBlock): boolean {
  if (block.type === 'text') return block.text !== ''
  if (block.type === 'thinking') return block.text.trim() !== '' || block.redacted === true
  return true
}

/**
 * 功能：找出模型仍在写的块：消息中最后一个携带内容的块。DSH 把同一条尾部标为
 * running（`AssistantMarkdown.tsx:103`），因此答案一接上，思考块就停止闪烁。
 */
function liveTailIndex(blocks: readonly ContentBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block !== undefined && blockCarriesContent(block)) return index
  }
  return -1
}

/** 从调用树计数，显示分组不增加调用数。已有子调用的 codemode 只贡献内部活动。 */
function summarizeToolActivities(roots: readonly MutableToolItem[]): Pick<RenderRun, 'activityCounts' | 'failedTools' | 'stoppedTools'> {
  const counts = new Map<ToolActivity, number>()
  const visited = new Set<MutableToolItem>()
  const counted = new Set<string>()
  let failedTools = 0
  let stoppedTools = 0
  const record = (id: string, name: string | undefined, status: string | undefined): void => {
    if (counted.has(id)) return
    counted.add(id)
    if (name !== undefined) {
      const kind = toolActivity(name)
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    if (status === 'error') failedTools += 1
    else if (status === 'cancelled') stoppedTools += 1
  }
  const toolStatus = (item: MutableToolItem) => item.result?.isError ? 'error' : item.result?.status ?? item.message.status
  const visit = (item: MutableToolItem): void => {
    if (visited.has(item)) return
    visited.add(item)
    const id = item.call?.id ?? item.result?.toolCallId ?? item.key
    const name = item.call?.name ?? item.result?.toolName
    const status = toolStatus(item)
    const codemode = name?.toLowerCase() === 'codemode'
    const details = item.result?.details
    const recorded = codemode ? asRecord(details) ?? (typeof details === 'string' ? parseJsonRecord(details) : undefined) : undefined
    const calls = parseRecordedCodemodeCalls(recorded?.calls)
    const wrapsCalls = codemode && (calls.length > 0 || item.children.length > 0)
    if (name !== undefined && !wrapsCalls) {
      record(id, name, status)
    } else if (wrapsCalls && (status === 'error' || status === 'cancelled')
      && !calls.some(call => call.status === status) && !item.children.some(child => toolStatus(child) === status)) {
      record(id, undefined, status)
    }
    // Durable codemode results keep the VM call number; live child rows use the qualified ID.
    for (const call of calls) record(`${id}/c${call.id}`, call.name, call.status)
    for (const child of item.children) visit(child)
  }
  for (const root of roots) visit(root)
  // Map 保留首次出现顺序，稳定排序让平手计数也保持该顺序。
  const activityCounts = [...counts].map(([kind, count]) => ({ kind, count })).sort((left, right) => right.count - left.count)
  return { activityCounts, failedTools, stoppedTools }
}

export type RecordedCodemodeStatus = 'running' | 'ok' | 'error' | 'cancelled'

export interface RecordedCodemodeCall {
  readonly id: string
  readonly name: string
  readonly args: unknown
  readonly status: RecordedCodemodeStatus
  readonly durationMs?: number
  readonly error?: string
}

const recordedCodemodeStatuses = new Set<string>(['running', 'ok', 'error', 'cancelled'])

/** Decode the durable codemode call list shared by the tool row and the work summary. */
export function parseRecordedCodemodeCalls(value: unknown): RecordedCodemodeCall[] {
  if (!Array.isArray(value)) return []
  const calls: RecordedCodemodeCall[] = []
  for (const entry of value) {
    const call = asRecord(entry)
    if (call === undefined || typeof call.name !== 'string' || call.name === '') continue
    if (typeof call.status !== 'string' || !recordedCodemodeStatuses.has(call.status)) continue
    const id = typeof call.id === 'string' ? call.id
      : typeof call.id === 'number' && Number.isFinite(call.id) ? String(call.id)
        : String(calls.length)
    calls.push({
      id,
      name: call.name,
      args: call.args,
      status: call.status as RecordedCodemodeStatus,
      ...(typeof call.durationMs === 'number' && Number.isFinite(call.durationMs) ? { durationMs: call.durationMs } : {}),
      ...(typeof call.error === 'string' && call.error !== '' ? { error: call.error } : {}),
    })
  }
  return calls
}

/**
 * 功能：把可变工具树冻结成不可变 ToolItem，子项按 order 排序；环路上遇到已访问
 * 的节点直接截断 children，防无限递归。
 */
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

/**
 * 功能：由 run 的消息推导状态：任一消息流式/running 即 running；否则按最后一条
 * 助手消息的 status（error/cancelled/completed），再退到带内容的末条助手与全局
 * 状态兜底；有助手消息视为 completed，否则 running。
 */
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

/** 逐项累加各消息的 usage；无任何 usage 返回 undefined。 */
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

/** 按产物内容（kind/path/before/after/diff）去重。 */
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

/**
 * 功能：把消息 id 转成稳定的 DOM 目标 id，供会话内跳转与轨迹导航共用。
 */
export function transcriptMessageDomId(messageId: string): string {
  return `chat-message-${encodeURIComponent(messageId)}`
}

/**
 * 功能：给思考块提供展示安全的摘要与正文。
 * @param text 思考全文
 * @param redacted 是否被模型隐藏
 * @param hiddenLabel 隐藏时的占位文案
 * @returns summary 为第一个非空行（或占位文案），text 原样（隐藏时为空串）
 */
export function reasoningDisplay(text: string, redacted: boolean, hiddenLabel: string): { summary: string; text: string } {
  if (redacted) return { summary: hiddenLabel, text: '' }
  return { summary: text.split(/\r?\n/u).find(line => line.trim() !== '')?.trim() ?? '', text }
}

/**
 * 功能：取消息的纯文本（复制控件与紧凑轨迹摘要用）：text/thinking 原文（redacted 除外），
 * 工具调用序列化为 `{ tool, arguments }` JSON。
 * @returns 换行拼接的文本
 */
export function messageText(message: ChatMessage): string {
  return message.blocks.flatMap(block => {
    if (block.type === 'text') return block.text === '' ? [] : [block.text]
    if (block.type === 'thinking') return block.redacted === true ? [] : [block.text]
    if (block.type === 'toolCall') return [JSON.stringify({ tool: block.name, arguments: block.arguments })]
    return []
  }).join('\n')
}

/**
 * 功能：把可能畸形的 details 值窄化为 record，不信任其内部字段。
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 解析工具 JSON record；忽略无效或超过展示预算的载荷。 */
export function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (value.length > 1_000_000) return undefined
  try { return asRecord(JSON.parse(value)) }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return undefined
  }
}

/**
 * 功能：把未知结构的工具详情安全摘要成字符串（轨迹行兜底展示）。
 * @returns 字符串原样、JSON 美化输出；序列化失败给出中文错误说明
 */
export function formatUnknownDetails(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) }
  catch (error) { return `无法读取工具详情：${error instanceof Error ? error.message : String(error)}` }
}

/**
 * 功能：取消息输出文本（只收 text 块），对未来可能出现的非文本内容块保持安全。
 */
export function messageOutput(message: ChatMessage | undefined): string {
  if (message === undefined) return ''
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** 会话级统计：run 数、步数、token 明细与上下文窗口占用。 */
export interface ConversationStats {
  readonly runCount: number
  readonly stepCount: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
  readonly contextTokens: number
  /** 会话级输出速率：输出 token 除以活跃 run 时间；没有任何 run 记录时长时 undefined。 */
  readonly tokensPerSecond?: number
}

/**
 * 功能：把持久消息日志折叠成输入框状态胶囊展示的数字。
 * @param messages 全部会话消息
 * @returns ConversationStats
 * 内部逻辑：stepCount 计 assistant+tool 消息；contextTokens 取最近一轮的窗口占用；tokensPerSecond 是 DSH 的解码速度折法（StatsPills.tsx:172-176）——输出 token 与每请求模型时间配对累计，工具时间与无时长 run 不稀释速率。
 */
export function conversationStats(messages: readonly ChatMessage[]): ConversationStats {
  const { runs } = buildRenderModel(messages)
  let stepCount = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let totalTokens = 0
  let contextTokens = 0
  // DSH 的解码速度折法（StatsPills.tsx:172-176）：输出 token 与每请求模型时间一起累计，
  // 工具时间与无时长记录的 run 永远不稀释速率。
  let rateTokens = 0
  let rateMs = 0
  for (const message of messages) {
    if (message.role === 'assistant' || message.role === 'tool') stepCount += 1
    const usage = message.usage
    if (usage === undefined) continue
    input += usage.input
    output += usage.output
    cacheRead += usage.cacheRead
    cacheWrite += usage.cacheWrite
    totalTokens += usage.totalTokens
    // 最近一轮决定下一次请求要携带的窗口价格。
    contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
    if (message.role === 'assistant' && message.requestDurationMs !== undefined) {
      rateTokens += usage.output
      rateMs += message.requestDurationMs
    }
  }
  const tokensPerSecond = rateMs > 0 ? rateTokens / (rateMs / 1000) : undefined
  return {
    runCount: runs.filter(run => run.users.length > 0).length,
    stepCount,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    contextTokens,
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  }
}


/**
 * 功能：新一轮压缩进行中时隐藏旧的「压缩完成」系统标记，只显示进行中的那份。
 * @param messages 全部消息
 * @param compactionRunning 是否有压缩在跑
 * @returns 可见的消息列表（不压缩时原样返回）
 */
export function visibleTranscriptMessages(messages: readonly ChatMessage[], compactionRunning: boolean): readonly ChatMessage[] {
  return compactionRunning
    ? messages.filter(message => !(message.role === 'system' && message.systemKind === 'compaction'))
    : messages
}

/** 尾部加载 spinner 的三个输入事实。 */
export interface TurnChatLoadingState {
  /** 会话存在进行中的 run。 */
  readonly isRunning: boolean
  /** 权限确认或提问卡片正在等用户。 */
  readonly blockedByInteraction: boolean
  /** 上下文压缩（或其他维护任务）在跑。 */
  readonly blockedByActiveWork: boolean
}

/**
 * 功能：ZCode 的 `shouldShowTurnChatLoading`（`packages/ui/src/v4/chatLoadingVisibility.ts`）：
 * 尾部 spinner 只属于直播回合；回合在等用户或维护任务时让位——此时提示框就是唯一的
 * 进度信号。running 是权威事实，因此不做防抖：多一段静默期会在每次投影更新时重启
 * 可见性并滞后真实状态。
 *
 * running 事实来自会话而不是最后一个 run 的状态：run 状态从其记录的消息推导，
 * 两次工具轮之间会短暂回落为 `completed`，spinner 会在从未停止的回合里闪烁。
 * ZCode 出于同样的原因读取同样的会话级事实。
 */
export function turnChatLoadingVisible(state: TurnChatLoadingState): boolean {
  if (!state.isRunning) return false
  return !state.blockedByActiveWork && !state.blockedByInteraction
}

/**
 * 功能：pending 的交互会停住回合直到用户应答，尾部 spinner 只会在提示框旁边添乱。
 * 所有 pending 类型都阻塞——`approval`（权限）、`question`（提问）与 `plan-review`
 * 都需要用户放行；已结算的交互（`continued`、`answered` 等）不阻塞，模型已经继续了。
 */
export function interactionBlocksTurnLoading(interactions: readonly InteractionRequest[] | undefined): boolean {
  return (interactions ?? []).some(interaction => interaction.status === 'pending')
}
