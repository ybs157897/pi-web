/**
 * pi-web 的完整轨迹采集与导出。
 *
 * Pi Durable 的 sqlite 已持久化转录（entries）与每次调用的计时（tasks）；无法事后重构的是
 * 发出的确切请求——经过压缩裁剪、影子消息与代码模式包装之后。本扩展把每个出站请求与每次
 * 终态 provider 尝试追加到每会话一个 JSONL 文件，`assembleTrajectory()` 再把采集内容与持久
 * entries/tasks 合并成单一时间线文件，供模型离线分析（先采集后分析的循环）。
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  GenerationTask,
  defineExtension,
  hook,
  type EntryId,
  type Extension,
  type Harness,
  type HookApi,
  type ModelRef,
} from '@earendil-works/pi-durable'
import type { AssistantMessage, AssistantMessageEventStream, Message } from '@earendil-works/pi-ai'
import type { Context } from '@earendil-works/chord/context'
import type { HookRunRecord } from '../hooks/schema.ts'
import { assistantFailure, providerFailure } from './failure.ts'

/** 轨迹扩展注册名，供装配与测试引用。 */
export const TRAJECTORY_EXTENSION_NAME = 'pi-web-trajectory'

declare module '@earendil-works/pi-ai' {
  interface AssistantMessage {
    /** 从流开始到首个可见内容的毫秒数；由 pi-web 的轨迹采集打点。 */
    ttftMs?: number
  }
}

/** 数据目录下存放 `<conversationId>.jsonl` 采集文件的子目录名。 */
export const TRAJECTORY_CAPTURE_DIR = 'trajectories'

/** 轨迹扩展的装配选项：目录、开关、请求形态与惰性 harness 引用。 */
export interface TrajectoryExtensionOptions {
  dir: string
  /** 每次 runtime 创建时读取，测试可在不重导入模块的情况下切换。 */
  enabled: boolean
  /**
   * 逐字采集出站负载而非逐条消息轮廓（`PI_WEB_TRAJECTORY_FULL_REQUEST=1`）。
   * 完整负载每轮都会重录全部历史——实测一个长智能体会话的请求行达 614MB 而响应仅 0.7MB——
   * 因此默认记录轮廓。
   */
  fullRequest: boolean
  /** 惰性解析：扩展在 `Harness.open` 返回之前就已安装。 */
  harness: () => Harness | undefined
}

/** 边路调用助手（`captureSideCall`）的写入位置；由扩展工厂按 runtime 设置。 */
let captureContext: { dir: string; enabled: boolean } | undefined

/** 写入为 fire-and-forget：采集失败绝不能打断一次模型运行。 */
let captureTail: Promise<void> = Promise.resolve()
const warnedFiles = new Set<string>()
const disabledFiles = new Set<string>()

/**
 * 功能：把一行采集记录排队追加到 JSONL 文件（fire-and-forget，串行于 captureTail 链）。
 * @param file 目标 JSONL 文件路径。
 * @param payload 任意可 JSON 序列化的记录对象。
 * 内部逻辑：已禁用的文件直接跳过；写前确保目录存在；失败时禁用该文件并只警告一次，
 * 之后该会话停止记录，保证采集故障不影响模型运行。
 */
function enqueueCaptureLine(file: string, payload: unknown): void {
  if (disabledFiles.has(file)) return
  captureTail = captureTail
    .then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8')
    })
    .catch((error: unknown) => {
      disabledFiles.add(file)
      if (!warnedFiles.has(file)) {
        warnedFiles.add(file)
        console.warn(`[pi-web-trajectory] 采集写入失败，本会话停止记录：${String(error)}`)
      }
    })
}

/** 等待所有挂起的采集写入落盘，导出读取前必须先调用。 */
export function drainTrajectoryCapture(): Promise<void> {
  return captureTail
}

/* ------------------------------------------------------------------ */
/* Request outlining                                                   */
/* ------------------------------------------------------------------ */

/** 尾部消息轮廓的预览长度上限；最新一轮的内容就在这里。 */
const OUTLINE_PREVIEW_CHARS = 1_500
/** 保留内容预览的尾部消息条数（更早的仅记轮廓）。 */
const OUTLINE_TAIL_MESSAGES = 3
/** 尾部消息内 toolCall 参数的预览长度上限。 */
const OUTLINE_ARGS_CHARS = 300

/** 序列化一个内容块并返回其字符长度；不可序列化返回 0。 */
function blockChars(block: unknown): number {
  try {
    return JSON.stringify(block).length
  } catch {
    return 0
  }
}

/** 把文本裁到预览上限；超长时截断并附加"TRUNCATED <总长> chars"标记。 */
function clip(text: string): string {
  return text.length <= OUTLINE_PREVIEW_CHARS ? text : `${text.slice(0, OUTLINE_PREVIEW_CHARS)}…[TRUNCATED ${text.length} chars]`
}

/** 生成值的裁剪预览；不可字符串化（undefined 等）返回 undefined。 */
function previewOf(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return typeof text === 'string' ? clip(text) : undefined
}

/** Provider error bodies belong to the runtime's control flow. Trajectories carry the public code and message. */
function traceMessage(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const message = value as Record<string, unknown>
  if (message.role !== 'assistant' || message.failure !== undefined
    || (message.stopReason !== 'error' && typeof message.errorMessage !== 'string')) return value
  const failure = assistantFailure({
    stopReason: message.stopReason === 'aborted' ? 'aborted' : 'error',
    errorMessage: typeof message.errorMessage === 'string' ? message.errorMessage : undefined,
    diagnostics: Array.isArray(message.diagnostics) ? message.diagnostics : undefined,
  })
  const { diagnostics, rawStopReason, errorMessage, ...rest } = message
  return { ...rest, errorMessage: failure.message, failure }
}

function traceEntry(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const entry = value as Record<string, unknown>
  return Array.isArray(entry.model) ? { ...entry, model: entry.model.map(traceMessage) } : value
}

function traceTask(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const task = value as { state?: { outcome?: { error?: { message?: unknown; detail?: { reason?: unknown } } } } }
  const outcome = task.state?.outcome
  const error = outcome?.error
  if (error?.detail?.reason !== 'model_error') return value
  const failure = providerFailure(error.message)
  return { ...task, state: { ...task.state, outcome: { ...outcome, error: { message: failure.message, failure } } } }
}

function traceCapture(line: Record<string, unknown>): Record<string, unknown> {
  if (line.type === 'request' && Array.isArray(line.messages)) return { ...line, messages: line.messages.map(traceMessage) }
  if (line.type === 'response') return { ...line, message: traceMessage(line.message) }
  if (line.type !== 'sidecall') return line
  if (line.answer !== undefined) return { ...line, answer: traceMessage(line.answer) }
  if (typeof line.error !== 'string' || line.failure !== undefined) return line
  const failure = providerFailure(line.error)
  return { ...line, error: failure.message, failure }
}

/**
 * 功能：生成一条消息内容的轮廓：形态与大小；仅当 preview 为 true 时附带预览。
 * @param content 消息内容（字符串 / 块数组 / 其他）。
 * @param preview 是否附带文本与参数预览。
 * @returns 轮廓对象：text 形态记 chars（+preview）；blocks 形态逐块记 type/chars，
 * 尾部预览模式下 toolCall 附 argsPreview、text 块附 preview。
 */
function outlineContent(content: unknown, preview: boolean): Record<string, unknown> {
  if (typeof content === 'string') {
    return { kind: 'text', chars: content.length, ...(preview ? { preview: clip(content) } : {}) }
  }
  if (Array.isArray(content)) {
    return {
      kind: 'blocks',
      blocks: content.map(block => {
        const record = block as { type?: string; name?: string; text?: unknown; arguments?: unknown }
        const outline: Record<string, unknown> = { type: record.type ?? 'unknown', chars: blockChars(block) }
        if (typeof record.name === 'string') outline.name = record.name
        if (preview && record.type === 'toolCall' && record.arguments !== undefined) outline.argsPreview = previewOf(record.arguments)
        if (preview && record.type === 'text') outline.preview = previewOf(record.text)
        return outline
      }),
    }
  }
  return { kind: 'other', chars: blockChars(content), ...(preview ? { preview: previewOf(content) } : {}) }
}

/**
 * 功能：生成一次出站请求的逐条消息轮廓：每条消息一项（与负载同序同数），携带 role、
 * system section 键与内容轮廓。
 * @param messages 出站请求的消息序列。
 * @returns 轮廓数组；尾部 OUTLINE_TAIL_MESSAGES 条保留截断预览——最新的用户文本与工具
 * 结果都在那里；更早的历史已持久化在 entries 中，逐字记录只会膨胀采集文件。
 */
export function outlineRequestMessages(messages: readonly Message[]): Array<Record<string, unknown>> {
  return messages.map((message, index) => {
    const preview = index >= messages.length - OUTLINE_TAIL_MESSAGES
    const record = message as { role?: string; content?: unknown; sections?: unknown }
    return {
      role: record.role ?? 'unknown',
      ...(record.sections !== null && typeof record.sections === 'object'
        ? { sections: Object.keys(record.sections as Record<string, unknown>) }
        : {}),
      content: outlineContent(record.content, preview),
    }
  })
}

/** 一次出站 provider 请求的序号：在其所属生成任务内递增编号。 */
interface RequestSequence {
  task: string
  request: number
}

/**
 * 功能：装配轨迹采集扩展（pi-web-trajectory）。
 * 贡献：无 section/工具；为 GenerationTask 挂 beforeRequest / afterResponse / afterTools 三个钩子，
 * 把出站请求、终态响应与工具批次写入采集文件，并设置边路调用（captureSideCall）的写入上下文。
 * @param options.dir 采集目录；enabled 总开关；fullRequest 决定逐字或轮廓；harness 惰性引用。
 * @returns defineExtension 产物。
 * 内部逻辑：请求按任务编号（任务变化即重置为 1）；beforeRequest 先写 request 行，再对
 * 工具目录做 sha1 哈希门控——仅目录真实变化时写 catalog 行；afterResponse 记录终态消息；
 * afterTools 记录 assistant 与结果 entry id。采集失败不影响生成（见 enqueueCaptureLine）。
 */
export function createTrajectoryExtension(options: TrajectoryExtensionOptions): Extension {
  captureContext = { dir: options.dir, enabled: options.enabled }
  const captureFile = (api: HookApi): string => join(options.dir, `${String(api.conversationId)}.jsonl`)
  const sequences = new Map<string, RequestSequence>()
  const catalogs = new Map<string, string>()

  /**
   * 功能：取（或新建）当前会话的请求序号；任务变化即从 1 重新编号。
   * @returns RequestSequence 引用（同任务内原地递增 request）。
   */
  const sequenceFor = (api: HookApi): RequestSequence => {
    const key = String(api.conversationId)
    const task = String(api.taskId)
    const current = sequences.get(key)
    if (current === undefined || current.task !== task) {
      const fresh = { task, request: 1 }
      sequences.set(key, fresh)
      return fresh
    }
    current.request += 1
    return current
  }

  /** 会话 agent 本请求将发送的内容：模型、思考级别与提供的工具。 */
  const agentFacts = async (api: HookApi, context: Context): Promise<{
    model?: ModelRef
    thinkingLevel?: string
    tools?: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>
  }> => {
    const harness = options.harness()
    const conversation = harness === undefined ? undefined : await harness.conversation(api.conversationId, context)
    if (conversation === undefined) return {}
    try {
      const agent = await conversation.agent(context)
      return {
        ...(agent.model === undefined ? {} : { model: agent.model }),
        thinkingLevel: agent.thinkingLevel,
        tools: agent.tools,
      }
    } catch {
      // agent 状态属于尽力而为的上下文；绝不能阻塞请求本身的采集。
      return {}
    }
  }

  /** beforeRequest 钩子：记录请求行（逐字或轮廓），并按哈希门控记录工具目录变化。 */
  const beforeRequest = async (request: { messages: readonly Message[] }, api: HookApi, context: Context) => {
    if (!options.enabled) return undefined
    const sequence = sequenceFor(api)
    const key = String(api.conversationId)
    const facts = await agentFacts(api, context)
    enqueueCaptureLine(captureFile(api), {
      type: 'request',
      ts: Date.now(),
      conversationId: key,
      task: sequence.task,
      request: sequence.request,
      ...(facts.model === undefined ? {} : { model: facts.model }),
      ...(facts.thinkingLevel === undefined ? {} : { thinkingLevel: facts.thinkingLevel }),
      messageCount: request.messages.length,
      ...(options.fullRequest
        ? { messages: request.messages.map(traceMessage) }
        : { messages: outlineRequestMessages(request.messages) }),
    })
    // 工具目录很少变化；用哈希门控，只有真实变化才落一行。
    if (facts.tools !== undefined) {
      const tools = facts.tools.map(tool => {
        const { name, description, parameters } = tool
        return {
          name,
          ...(description === undefined ? {} : { description }),
          ...(parameters === undefined ? {} : { parameters }),
        }
      })
      const hash = createHash('sha1')
        .update(JSON.stringify([facts.model, facts.thinkingLevel, tools]))
        .digest('hex')
        .slice(0, 12)
      if (catalogs.get(key) !== hash) {
        catalogs.set(key, hash)
        enqueueCaptureLine(captureFile(api), {
          type: 'catalog',
          ts: Date.now(),
          conversationId: key,
          task: sequence.task,
          request: sequence.request,
          ...(facts.model === undefined ? {} : { model: facts.model }),
          ...(facts.thinkingLevel === undefined ? {} : { thinkingLevel: facts.thinkingLevel }),
          hash,
          tools,
        })
      }
    }
    return undefined
  }

  /** afterResponse 钩子：把终态助手消息写入采集文件（response 行）。 */
  const afterResponse = (message: AssistantMessage, api: HookApi, _context: Context): void => {
    if (!options.enabled) return
    const key = String(api.conversationId)
    const sequence = sequences.get(key)
    enqueueCaptureLine(captureFile(api), {
      type: 'response',
      ts: Date.now(),
      conversationId: key,
      task: sequence?.task ?? String(api.taskId),
      request: sequence?.request ?? 0,
      message: traceMessage(message),
    })
  }

  /** afterTools 钩子：记录一次工具执行批次（tools 行：assistant entry 与结果 entry 列表）。 */
  const afterTools = (assistant: EntryId, results: readonly EntryId[], api: HookApi, _context: Context): void => {
    if (!options.enabled) return
    enqueueCaptureLine(captureFile(api), {
      type: 'tools',
      ts: Date.now(),
      conversationId: String(api.conversationId),
      assistant,
      results: [...results],
    })
  }

  return defineExtension({
    name: TRAJECTORY_EXTENSION_NAME,
    hooks: [hook(GenerationTask, { beforeRequest, afterResponse, afterTools })],
  })
}

/* ------------------------------------------------------------------ */
/* TTFT observation                                                    */
/* ------------------------------------------------------------------ */

/**
 * 单个 provider 流的透传观察器：计时"开始 → 首个可见内容"，并把最终消息打上 `ttftMs`
 * （没有任何内容流出（如立即出错）时不打）。pi-durable 从 `result()` 读最终消息，那是关键
 * 路径；done/error 事件同样打点，供任何迭代消费者使用。
 * @param inner 被观察的原始事件流。
 * @returns 行为等价的流对象：迭代时记录首个内容时间戳并在 done/error 时加盖 ttftMs。
 */
function observeModelStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
  const startedAt = performance.now()
  let firstContentAt: number | undefined
  const stamp = (message: AssistantMessage): AssistantMessage =>
    firstContentAt === undefined ? message : { ...message, ttftMs: Math.round(firstContentAt - startedAt) }
  const iterate = async function* () {
    for await (const event of inner) {
      const partial = (event as { partial?: AssistantMessage }).partial
      if (firstContentAt === undefined && partial !== undefined && partial.content.length > 0) {
        firstContentAt = performance.now()
      }
      if (event.type === 'done') yield { ...event, message: stamp(event.message) }
      else if (event.type === 'error') yield { ...event, error: stamp(event.error) }
      else yield event
    }
  }
  // 生成任务只会迭代并调用 `result()`；一个带该表面的普通对象即可保持精确透传，无需重写整个类。
  return {
    [Symbol.asyncIterator]: iterate,
    result: () => inner.result().then(stamp),
  } as unknown as AssistantMessageEventStream
}

/**
 * 功能：包装交给 `Harness.open` 的模型目录，使每个 provider 流——生成任务与直接调用一样——
 * 的最终消息带上 `ttftMs`，随后原样流入持久 entry 与轨迹导出。
 * @param models 原始模型目录对象。
 * @returns Proxy 包装：仅拦 `streamSimple` 加观察器，其余成员原样透传（函数绑定 this）。
 */
export function wrapModelsWithTrajectory<M>(models: M): M {
  return new Proxy(models as object, {
    get(target, property) {
      if (property === 'streamSimple') {
        const streamSimple = Reflect.get(target, property, target) as (...args: unknown[]) => AssistantMessageEventStream
        return (...args: unknown[]) => observeModelStream(streamSimple.apply(target, args))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as M
}

/* ------------------------------------------------------------------ */
/* Side-channel model calls                                            */
/* ------------------------------------------------------------------ */

/** 边路模型调用的记录上下文：归属会话与调用目的。 */
export interface SideCallContext {
  /** 归属会话；`undefined` 表示跳过采集（没有可挂靠的文件）。 */
  conversationId: string | number | undefined
  purpose: string
}

/**
 * 功能：把生成任务之外的模型调用——会话标题、压缩摘要、提交信息、记忆抽取——以 `sidecall`
 * 行记录进会话采集文件。
 * @param context 归属会话与目的；conversationId 未定义或采集关闭时退化为普通 run()。
 * @param model 调用所用模型引用（可缺省）。
 * @param input 发给模型的输入（原样记录）。
 * @param run 实际执行调用的闭包。
 * @param options 可选调用选项（原样记录）。
 * @returns run 的结果；出错时记录错误后原样重抛。
 * 内部逻辑：计时起止写入 durationMs；成功记 answer、失败记 error message；两条路径都返回原值/抛原错。
 */
export async function captureSideCall<T extends AssistantMessage>(
  context: SideCallContext,
  model: ModelRef | undefined,
  input: unknown,
  run: () => Promise<T>,
  options?: unknown,
): Promise<T> {
  if (!captureContext?.enabled || context.conversationId === undefined) return await run()
  const file = join(captureContext.dir, `${String(context.conversationId)}.jsonl`)
  const startedAt = Date.now()
  const record = (fields: Record<string, unknown>): void => {
    enqueueCaptureLine(file, {
      type: 'sidecall',
      ts: Date.now(),
      conversationId: String(context.conversationId),
      purpose: context.purpose,
      ...(model === undefined ? {} : { model }),
      startedAt,
      durationMs: Date.now() - startedAt,
      input,
      ...(options === undefined ? {} : { options }),
      ...fields,
    })
  }
  try {
    const answer = await run()
    record({ answer: traceMessage(answer) })
    return answer
  } catch (error) {
    const failure = providerFailure(error)
    record({ error: failure.message, failure })
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * 功能：创建 hooks 执行记录采集器——与轨迹同一 JSONL 通道（`<conversationId>.jsonl`），
 * 写 `type:'hook'` 行；assembleTrajectory 的通用 capture 合并按 ts 排序天然纳入。
 * @param dir 采集目录（与轨迹扩展同目录）。
 * @returns fire-and-forget 的记录函数；写入失败静默停写，绝不影响会话运行。
 * 内部逻辑：enabled 在创建时读 PI_WEB_TRAJECTORY（与轨迹扩展同款开关语义）；
 * 复用 enqueueCaptureLine 的串行链与故障禁用机制。
 */
export function createHookCapture(dir: string): (record: HookRunRecord) => void {
  const enabled = process.env.PI_WEB_TRAJECTORY !== '0'
  return (record: HookRunRecord): void => {
    if (!enabled) return
    enqueueCaptureLine(join(dir, `${record.conversationId}.jsonl`), { type: 'hook', ...record })
  }
}

/** 轨迹导出选项：sqlite 库路径、采集目录与会话 id。 */
export interface TrajectoryExportOptions {
  dbPath: string
  captureDir: string
  conversationId: string
}

/** entries 表的行结构（record 为 JSON 字符串）。 */
interface EntryRow {
  id: number
  head: number | null
  commit_seq: number
  record: string
}

/** tasks 表的行结构（record 为 JSON 字符串）。 */
interface TaskRow {
  id: number
  kind: string
  status: string
  record: string
}

/**
 * 功能：从 entry 记录中提取时间戳：取其 model 消息数组最后一条的 timestamp。
 * @param record 已解析的 entry 记录对象。
 * @returns 时间戳；结构不符或缺失时返回 undefined。
 */
function recordTimestamp(record: unknown): number | undefined {
  const messages = (record as { model?: ReadonlyArray<{ timestamp?: unknown }> } | null)?.model
  const last = messages?.[messages.length - 1]
  return typeof last?.timestamp === 'number' ? last.timestamp : undefined
}

/** 从 task 记录中取 startedAt/endedAt 数值字段；缺失或非数字返回 undefined。 */
function taskTimestamp(record: unknown, field: 'startedAt' | 'endedAt'): number | undefined {
  const value = (record as Record<string, unknown> | null)?.[field]
  return typeof value === 'number' ? value : undefined
}

/** Pi Durable 以 JSON 编码存储任务类别（`"pi.generation"`）；导出时剥掉这层引号。 */
function normalizeTaskKind(kind: string): string {
  return kind.replace(/^"([\s\S]*)"$/, '$1')
}

/** 待排序的轨迹项：排序键时间戳 + 原始行内容。 */
interface TrajectoryItem {
  ts: number
  line: Record<string, unknown>
}

/**
 * 功能：把一个会话的完整轨迹构建为按时间排序的 JSONL：先是会话记录，然后是 entries、
 * tasks 与采集到的出站请求/响应，按时间戳排序（同刻稳定排序）。
 * @param options dbPath（Pi Durable sqlite）、captureDir（采集目录）与 conversationId。
 * @returns JSONL 文本（末尾换行）；会话不存在时抛错。
 * 内部逻辑：先 drain 等待采集写完；分别读 entries/tasks 表构建行；采集文件缺失（早于扩展的
 * 会话）或末行撕裂（追加中途崩溃）都安全跳过；V8 排序稳定，同刻保持 entry→task→capture 顺序。
 */
export async function assembleTrajectory(options: TrajectoryExportOptions): Promise<string> {
  await drainTrajectoryCapture()
  const db = new DatabaseSync(options.dbPath)
  try {
    const conversationRow = db.prepare('SELECT record FROM conversations WHERE id = ?')
      .get(Number(options.conversationId)) as { record: string } | undefined
    if (conversationRow === undefined) throw new Error('会话不存在')

    const items: TrajectoryItem[] = []
    const entryRows = db.prepare('SELECT id, head, commit_seq, record FROM entries WHERE conversation_id = ? ORDER BY id')
      .all(Number(options.conversationId)) as unknown as EntryRow[]
    for (const row of entryRows) {
      const record = JSON.parse(row.record) as unknown
      items.push({
        ts: recordTimestamp(record) ?? 0,
        line: {
          type: 'entry',
          id: row.id,
          seq: row.commit_seq,
          head: row.head !== null,
          ts: recordTimestamp(record) ?? null,
          record: traceEntry(record),
        },
      })
    }
    const taskRows = db.prepare('SELECT id, kind, status, record FROM tasks WHERE conversation_id = ? ORDER BY id')
      .all(Number(options.conversationId)) as unknown as TaskRow[]
    for (const row of taskRows) {
      const record = JSON.parse(row.record) as unknown
      const startedAt = taskTimestamp(record, 'startedAt')
      const endedAt = taskTimestamp(record, 'endedAt')
      items.push({
        ts: startedAt ?? endedAt ?? 0,
        line: {
          type: 'task',
          id: row.id,
          kind: normalizeTaskKind(row.kind),
          status: row.status,
          ts: startedAt ?? endedAt ?? null,
          ...(startedAt === undefined ? {} : { startedAt }),
          ...(endedAt === undefined ? {} : { endedAt }),
          record: traceTask(record),
        },
      })
    }
    const capturePath = join(options.captureDir, `${options.conversationId}.jsonl`)
    let captureText: string | undefined
    try {
      captureText = await readFile(capturePath, 'utf8')
    } catch {
      // 早于采集扩展记录的会话没有文件；entries 与 tasks 已足够。
    }
    if (captureText !== undefined) {
      for (const line of captureText.split('\n')) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line) as { ts?: unknown }
          items.push({ ts: typeof parsed.ts === 'number' ? parsed.ts : 0, line: traceCapture(parsed as Record<string, unknown>) })
        } catch {
          // 追加中途崩溃导致的撕裂末行不能污染整个导出。
        }
      }
    }

    // 稳定排序（V8）：相同时间戳保持 entries 在前、tasks 次之、capture 在后的顺序。
    items.sort((left, right) => left.ts - right.ts)

    const lines: string[] = [JSON.stringify({
      type: 'conversation',
      id: options.conversationId,
      record: JSON.parse(conversationRow.record) as unknown,
    })]
    for (const item of items) lines.push(JSON.stringify(item.line))
    return `${lines.join('\n')}\n`
  } finally {
    db.close()
  }
}
