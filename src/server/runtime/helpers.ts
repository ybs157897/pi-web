/**
 * 各运行时 feature 共享的基础构件。
 *
 * 这里只有纯函数与模块级常量：不捕获任何运行时状态，任何 feature 模块都可以
 * 引入而不依赖组合根。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { AgentDoc, defineDoc, type ConversationRecord, type ConversationView, type ConversationId, type EntryId, type SubmissionId, type TaskId, type Tx, type UserInput } from '@earendil-works/pi-durable'
import type { Usage } from '@earendil-works/pi-ai'
import type { JsonValue } from '@earendil-works/chord'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import type { AccessMode, SubmitInput, ThinkingLevel } from '../../shared/types.ts'
import type { AttachmentReference } from '../workspace/files.ts'
import { inheritPlanConstraint, EXECUTION_POLICY_EXTENSION_NAME } from '../conversation/execution-policy.ts'
import { WORK_POLICY_EXTENSION_NAME } from '../conversation/work-policy.ts'
import { COMPACTION_EXTENSION_NAME } from '../conversation/compaction.ts'
import { MEMORY_EXTENSION_NAME } from '../memory/policy.ts'
import { PLUGIN_REFERENCE_EXTENSION_NAME } from '../plugins/reference.ts'
import { SUBAGENT_TOOL } from '../tools/subagent.ts'
import { TEAM_TOOL_NAMES } from '../tools/team.ts'
import { SKILL_READ_TOOLS } from '../tools/skill.ts'
import { GOAL_TOOL_NAMES } from '../tools/goal.ts'
import { RuntimeError } from '../runtime-errors.ts'

/** 每个会话的持久元数据文档（META doc）的类型：标题、归档/置顶、未读基准、排队记录、请求回执、工作区绑定与排队编辑状态机。 */
export type ConversationMetadata = {
  [key: string]: JsonValue
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  pinned: boolean
  /** 客户端最近一次查看该会话的时间；侧栏未读标记用它与 updatedAt 比较。 */
  seenAt: number
  titleSource: 'auto' | 'user'
  queueCreatedAt: Record<string, number>
  requestReceipts: Record<string, { fingerprint: string; submissionId: number | null; status: 'pending' | 'accepted' }>
  workspaceId: string | null
  accessMode: AccessMode
  feedback: Record<string, 'up' | 'down' | null>
  queueEdits: Record<string, {
    fingerprint: string
    sourceSubmissionId: number
    input: { text: string; whenBusy: 'steer' | 'followUp'; images: Array<{ data: string; mimeType: string }>; files: AttachmentReference[] }
    status: 'pending' | 'aborting' | 'aborted' | 'complete' | 'conflict'
    submissionId: number | null
  }>
}

/** 会话元数据文档定义：按会话作用域、只保留最新版本、fork 时取初始值。 */
export const META = defineDoc<ConversationMetadata>({
  kind: 'pi-durable-web.conversation',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({
    title: 'New conversation',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
    pinned: false,
    seenAt: Date.now(),
    titleSource: 'auto',
    queueCreatedAt: {},
    requestReceipts: {},
    workspaceId: null,
    accessMode: 'fullAccess',
    feedback: {},
    queueEdits: {},
  }),
})

/** 会话类型文档：目前只区分「缺陷分析」会话（决定标题钉住、跳过自动命名等）。 */
export const CONVERSATION_KIND = defineDoc<{ kind?: 'defectAnalysis' }>({
  kind: 'pi-durable-web.conversation-kind', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', checkpointWhen: () => false, initial: () => ({}),
})

/** 后台运行上下文：所有运行时操作都挂在这条不随请求终止的上下文上。 */
export const CTX: Context = BACKGROUND_CONTEXT
/** 新会话的占位标题；首条消息到达后被自动命名或用户命名替换。 */
export const DEFAULT_TITLE = 'New conversation'
/** 运行时接受的思考等级全集。 */
export const SUPPORTED_THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
/** Pi code mode 扩展在注册表中的名称（`createCodemodeExtension`）。 */
export const CODEMODE_EXTENSION_NAME = 'codemode'
/** 只读会话保留的工具：读类工具加上不触碰工作区状态的交互类工具。 */
export const READ_ONLY_TOOLS = new Set(['read', 'list_files', 'search_files', 'glob', 'grep', 'todo_write', 'ask_user_question', 'exit_plan_mode', CODEMODE_TOOL_NAME, SUBAGENT_TOOL, ...TEAM_TOOL_NAMES, ...SKILL_READ_TOOLS, ...GOAL_TOOL_NAMES])
/**
 * 与 execution-policy.ts 的 `PLAN_TOOLS` 保持一致。来自插件页面的工具调用是第二执行
 * 入口，因此同样适用计划模式的工具白名单。
 */
export const PLUGIN_UI_PLAN_TOOLS = new Set([
  'read', 'list_files', 'search_files', 'glob', 'grep', 'skill_list', 'skill_load', 'skill_validate',
  'ask_user_question', 'exit_plan_mode', 'get_goal', 'codemode',
  'subagent', 'spawn_teammate', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_list', 'team_task_get',
])

/**
 * 功能：把宿主的「无工具」政策扩展注入会话 agent，不改动会话的工具集与自定义指令。
 * @param tx 当前事务
 * @param record 会话记录
 * @returns 无返回
 * 内部逻辑：把五个必需扩展名按序补到 agent.extensions（数组形态 unshift、对象形态
 * 合并 add 并从 remove 中剔除）；有属主的会话再继承属主的计划模式约束。
 */
export async function ensureRuntimePolicy(tx: Tx, record: ConversationRecord): Promise<void> {
  const conversationId = record.id
  const agent = await tx.doc(AgentDoc, conversationId)
  const extensions = agent.extensions
  const required = [WORK_POLICY_EXTENSION_NAME, COMPACTION_EXTENSION_NAME, MEMORY_EXTENSION_NAME, PLUGIN_REFERENCE_EXTENSION_NAME, EXECUTION_POLICY_EXTENSION_NAME]
  if (Array.isArray(extensions)) {
    for (const name of required) if (!extensions.includes(name)) extensions.unshift(name)
  } else if (extensions !== undefined) {
    agent.extensions = {
      ...extensions,
      add: [...new Set([...required, ...extensions.add ?? []])],
      ...(extensions.remove === undefined ? {} : { remove: extensions.remove.filter(name => !required.includes(name)) }),
    }
  }
  if (record.owner) await inheritPlanConstraint(tx, conversationId, record.owner.conversationId)
}

/** 解析正整数 ID；非安全整数或非正数抛 INVALID_INPUT，label 用于错误文案。 */
export function parseNumericId(value: string, label: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new RuntimeError('INVALID_INPUT', `${label} 无效`)
  return id
}

/** 把字符串解析为会话 ID；无效即抛 INVALID_INPUT。 */
export function parseConversationId(value: string): ConversationId {
  return parseNumericId(value, '会话 ID') as ConversationId
}

/** 把字符串解析为消息条目 ID；无效即抛 INVALID_INPUT。 */
export function parseEntryId(value: string): EntryId {
  return parseNumericId(value, '消息 ID') as EntryId
}

/** 把字符串解析为提交 ID；无效即抛 INVALID_INPUT。 */
export function parseSubmissionId(value: string): SubmissionId {
  return parseNumericId(value, '提交 ID') as SubmissionId
}

/** 把 unknown 收敛为普通对象（剔除 null 与数组），失败返回 undefined。 */
export function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

/** 从会话视图中读取正在执行的运行任务 ID；空闲时返回 undefined。 */
export function liveRunTaskId(view: ConversationView): TaskId | undefined {
  const live = objectValue(view.docs['pi.live'])
  const run = live ? objectValue(live.run) : undefined
  const id = run?.taskId
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id as TaskId : undefined
}

/** 从 unknown 中提取附件引用数组；字段缺失或类型不符的条目直接丢弃。 */
export function attachmentReferences(value: unknown): AttachmentReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const file = objectValue(item)
    if (!file || typeof file.name !== 'string' || typeof file.mimeType !== 'string' || typeof file.path !== 'string' || typeof file.size !== 'number') return []
    return [{ name: file.name, mimeType: file.mimeType, path: file.path, size: file.size }]
  })
}

/** 一条排队消息的内容形状：文本 + 图片 + 附件引用。 */
export type QueueContent = { text: string; images: Array<{ data: string; mimeType: string }>; files: AttachmentReference[] }

/**
 * 功能：从排队条目的 content 与 entry 数据中重建消息内容。
 * @param value 排队条目的 content（字符串或多模态分块数组）
 * @param entryValue 条目的 entry 数据，附件从 `data.files` 读取
 * @returns 文本按出现顺序以换行拼接，图片与附件按结构化引用收集
 */
export function queueContent(value: unknown, entryValue: unknown): QueueContent {
  const images: QueueContent['images'] = []
  const texts: string[] = []
  if (typeof value === 'string') texts.push(value)
  else if (Array.isArray(value)) {
    for (const partValue of value) {
      const part = objectValue(partValue)
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      if (part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
        images.push({ data: part.data, mimeType: part.mimeType })
      }
    }
  }
  const entry = objectValue(entryValue)
  const data = entry ? objectValue(entry.data) : undefined
  const files = attachmentReferences(data?.files)
  return { text: texts.join('\n'), images, files }
}

/** 校验并归一化标题：undefined 透传；空串或超 200 字符抛 INVALID_INPUT。 */
export function safeTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const title = value.trim()
  if (!title || title.length > 200) throw new RuntimeError('INVALID_INPUT', '标题长度必须在 1 到 200 个字符之间')
  return title
}

/** 把一次后台生成的用量累加进存量总数（含 1h 缓存写与推理 token 的可选字段）。 */
export function accumulateUsage(total: Usage, usage: Usage): void {
  total.input += usage.input
  total.output += usage.output
  total.cacheRead += usage.cacheRead
  total.cacheWrite += usage.cacheWrite
  total.totalTokens += usage.totalTokens
  if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning
  total.cost.input += usage.cost.input
  total.cost.output += usage.cost.output
  total.cost.cacheRead += usage.cost.cacheRead
  total.cost.cacheWrite += usage.cost.cacheWrite
  total.cost.total += usage.cost.total
}

/**
 * 功能：把任意失败值转成可安全展示的错误文本。
 * @param value 任意抛出的值（通常是 Error）
 * @returns 脱敏后的单行文本，最长 500 字符
 * 内部逻辑：非 Error 一律以「操作失败」兜底；随后依次抹掉 Authorization 头、
 * Bearer token、各类 key/token/secret 赋值形与密钥样式 token，并压平换行。
 */
export function safeFailure(value: unknown): string {
  const text = value instanceof Error ? value.message : '操作失败'
  return text
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|rk|pk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500)
}

/** 打开本地文件的系统命令超时上限。 */
const OPEN_CONFIG_TIMEOUT_MS = 15_000
/** 每个父会话列出的子智能体数量上限，对齐 DSH 的目录页；行内答案摘要的长度界在下面。 */
export const SUBAGENT_LIMIT = 50
/** 子智能体目录行中最新答案的截断长度。 */
export const SUBAGENT_ANSWER_CHARS = 200
/** 发给子智能体的消息文本长度上限。 */
export const SUBAGENT_MESSAGE_CHARS = 20_000

/**
 * 功能：用系统默认程序在操作者桌面上打开一个本地文件。
 * @param path 文件绝对路径
 * @returns 打开成功即 resolve
 * 内部逻辑：按 directory-picker.ts 相同的平台划分选命令（macOS open / Windows
 * cmd start / Linux xdg-open）；启动器只交接不驻留，永不退出的命令在超时处被
 * 杀掉，不会挂住请求。
 */
export function openLocalFile(path: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : process.platform === 'linux' ? 'xdg-open' : undefined
  if (command === undefined) throw new RuntimeError('UNSUPPORTED', '当前系统没有可用的文件打开方式')
  // `start` 是 cmd 内建命令，第一个带引号的参数是窗口标题，因此留空。
  const args = command === 'cmd' ? ['/c', 'start', '', path] : [path]
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: OPEN_CONFIG_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const failure = error as NodeJS.ErrnoException & { killed?: boolean }
      if (failure.code === 'ENOENT') {
        reject(new RuntimeError('UNSUPPORTED', `当前系统缺少打开文件的命令：${command}`))
        return
      }
      if (failure.killed) {
        reject(new RuntimeError('PROVIDER_ERROR', '打开配置文件超时，系统命令未退出'))
        return
      }
      reject(new RuntimeError('PROVIDER_ERROR', `无法打开配置文件：${safeFailure(stderr.trim() ? new Error(stderr.trim()) : error)}`))
    })
  })
}

/** 剥离 data URL 前缀，返回纯 Base64 部分；已是纯 Base64 则原样返回。 */
function imageData(value: string): string {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(value)
  return match?.[1] ?? value
}

/** 把一次提交归一化为 canonical JSON：图片/附件取关键字段，whenBusy 补默认值。作为指纹与幂等比较的稳定形状。 */
export function canonicalSubmit(input: SubmitInput): string {
  return JSON.stringify({
    text: input.text,
    images: (input.images ?? []).map((image) => ({ mimeType: image.mimeType, data: image.data })),
    files: (input.files ?? []).map((file) => ({ name: file.name, mimeType: file.mimeType, data: file.data })),
    whenBusy: input.whenBusy ?? 'followUp',
  })
}

/** 计算一次提交的 SHA-256 内容指纹，用于 requestId 的幂等冲突检测。 */
export function fingerprintSubmit(input: SubmitInput): string {
  return createHash('sha256').update(canonicalSubmit(input)).digest('hex')
}

/**
 * 功能：把提交输入转成会话内核的用户消息内容。
 * @param input 提交输入（文本、图片、忙碌策略）
 * @param files 已保存到工作区的附件引用
 * @returns 纯文本时返回字符串；含图片时返回文本分块 + 图片分块的数组
 * 内部逻辑：附件以 `[File attachment: ...]` 引用行追加到文本尾部（正文已含该引用
 * 则不重复）；图片先剥 data URL 前缀。
 */
export function submissionContent(input: SubmitInput, files: readonly AttachmentReference[] = []): UserInput {
  const images = input.images ?? []
  const references = files.map(file => `[File attachment: ${file.name} (${file.path})]`).filter(reference => !input.text.includes(reference))
  const text = [input.text, ...references].filter(Boolean).join('\n\n')
  if (!images.length) return text
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...images.map((image) => ({ type: 'image' as const, data: imageData(image.data), mimeType: image.mimeType })),
  ]
}

/**
 * 功能：校验一次提交输入的边界（requestId、文本、图片、附件与总量）。
 * @param input 待校验的提交输入
 * @returns 通过即无返回，否则抛 INVALID_INPUT
 * 内部逻辑：requestId 1-256 字符、文本 ≤1M、whenBusy 限枚举、图片 ≤16 张且
 * 类型/大小受限、附件 ≤8 个且逐个验证 Base64 合法性与 8 MiB 上限、附件总量
 * ≤16 MiB；纯空白且无图片附件的消息为空消息，拒绝。
 */
export function assertSubmit(input: SubmitInput): void {
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0 || input.requestId.length > 256) {
    throw new RuntimeError('INVALID_INPUT', 'requestId 必须是 1 到 256 个字符')
  }
  if (typeof input.text !== 'string' || input.text.length > 1_000_000) throw new RuntimeError('INVALID_INPUT', '消息文本无效或过长')
  if (input.whenBusy !== undefined && !['steer', 'followUp', 'reject'].includes(input.whenBusy)) {
    throw new RuntimeError('INVALID_INPUT', '忙碌时的提交方式无效')
  }
  if (input.images && input.images.length > 16) throw new RuntimeError('INVALID_INPUT', '单条消息最多包含 16 张图片')
  for (const image of input.images ?? []) {
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(image.mimeType) || image.data.length > 12_000_000) {
      throw new RuntimeError('INVALID_INPUT', '图片类型或大小无效')
    }
  }
  if (input.files && input.files.length > 8) throw new RuntimeError('INVALID_INPUT', '单条消息最多附加 8 个文件')
  let totalAttachmentBytes = 0
  for (const file of input.files ?? []) {
    if (!file.name.trim() || file.name.length > 240 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
      throw new RuntimeError('INVALID_INPUT', '附件名称、类型或 Base64 内容无效')
    }
    const bytes = Buffer.from(file.data, 'base64')
    if (bytes.toString('base64') !== file.data || bytes.length > 8 * 1024 * 1024) throw new RuntimeError('INVALID_INPUT', '附件内容无效或过大')
    totalAttachmentBytes += bytes.length
  }
  if (totalAttachmentBytes > 16 * 1024 * 1024) throw new RuntimeError('INVALID_INPUT', '附件总大小不能超过 16 MiB')
  if (!input.text.trim() && !(input.images?.length) && !(input.files?.length)) throw new RuntimeError('INVALID_INPUT', '消息不能为空')
}

/** 深拷贝会话元数据的可变副本（嵌套记录 structuredClone，浅层字段展开复制）。 */
export function cloneMetadata(value: Readonly<ConversationMetadata>): ConversationMetadata {
  return {
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archived: value.archived,
    pinned: value.pinned,
    // 未读标记出现之前写入的文档按其最后更新时间视为已读，
    // 升级时不会让所有历史会话同时亮起未读点。
    seenAt: value.seenAt ?? value.updatedAt,
    titleSource: value.titleSource,
    queueCreatedAt: { ...value.queueCreatedAt },
    requestReceipts: structuredClone(value.requestReceipts),
    workspaceId: value.workspaceId,
    accessMode: value.accessMode,
    feedback: { ...value.feedback },
    queueEdits: structuredClone(value.queueEdits),
  }
}
