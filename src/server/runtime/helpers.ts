/**
 * Shared primitives for the runtime features.
 *
 * Everything here is either a pure function or module-level constant: no runtime
 * state is captured, so any feature module can import it without a dependency on
 * the composition root.
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

export type ConversationMetadata = {
  [key: string]: JsonValue
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  pinned: boolean
  /** Last time the client viewed the conversation; the sidebar's unread marker compares against it. */
  seenAt: number
  titleSource: 'auto' | 'user'
  queueCreatedAt: Record<string, number>
  requestReceipts: Record<string, { fingerprint: string; submissionId: number | null; status: 'pending' | 'accepted' }>
  workspaceId: string | null
  presetId: string | null
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

export const META = defineDoc<ConversationMetadata>({
  kind: 'pi-durable-web.conversation',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
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
    presetId: null,
    accessMode: 'fullAccess',
    feedback: {},
    queueEdits: {},
  }),
})

export const CTX: Context = BACKGROUND_CONTEXT
export const DEFAULT_TITLE = 'New conversation'
export const SUPPORTED_THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
/** The Pi code mode extension's registry name (`createCodemodeExtension`). */
export const CODEMODE_EXTENSION_NAME = 'codemode'
/** Tools a read-only conversation keeps: reads plus interaction tools that touch no workspace state. */
export const READ_ONLY_TOOLS = new Set(['read', 'list_files', 'search_files', 'glob', 'grep', 'todo_write', 'ask_user_question', 'exit_plan_mode', CODEMODE_TOOL_NAME, SUBAGENT_TOOL, ...TEAM_TOOL_NAMES, ...SKILL_READ_TOOLS, ...GOAL_TOOL_NAMES])
/**
 * Mirrors `PLAN_TOOLS` in execution-policy.ts. Page-originated plugin tool calls are a second
 * execution entry point, so they apply the same Plan-mode allowlist.
 */
export const PLUGIN_UI_PLAN_TOOLS = new Set([
  'read', 'list_files', 'search_files', 'glob', 'grep', 'skill_list', 'skill_load', 'skill_validate',
  'ask_user_question', 'exit_plan_mode', 'get_goal', 'codemode',
  'subagent', 'spawn_teammate', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_list', 'team_task_get',
])

/** Add the host's tool-free policy without changing a conversation's tools or custom instructions. */
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

export function parseNumericId(value: string, label: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new RuntimeError('INVALID_INPUT', `${label} 无效`)
  return id
}

export function parseConversationId(value: string): ConversationId {
  return parseNumericId(value, '会话 ID') as ConversationId
}

export function parseEntryId(value: string): EntryId {
  return parseNumericId(value, '消息 ID') as EntryId
}

export function parseSubmissionId(value: string): SubmissionId {
  return parseNumericId(value, '提交 ID') as SubmissionId
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

export function liveRunTaskId(view: ConversationView): TaskId | undefined {
  const live = objectValue(view.docs['pi.live'])
  const run = live ? objectValue(live.run) : undefined
  const id = run?.taskId
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id as TaskId : undefined
}

export function attachmentReferences(value: unknown): AttachmentReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const file = objectValue(item)
    if (!file || typeof file.name !== 'string' || typeof file.mimeType !== 'string' || typeof file.path !== 'string' || typeof file.size !== 'number') return []
    return [{ name: file.name, mimeType: file.mimeType, path: file.path, size: file.size }]
  })
}

export type QueueContent = { text: string; images: Array<{ data: string; mimeType: string }>; files: AttachmentReference[] }

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

export function safeTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const title = value.trim()
  if (!title || title.length > 200) throw new RuntimeError('INVALID_INPUT', '标题长度必须在 1 到 200 个字符之间')
  return title
}

/** Sum one background generation's usage into a stored total. */
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

const OPEN_CONFIG_TIMEOUT_MS = 15_000
/** Children listed per parent, mirroring DSH's catalog page, and the row-level answer summary bound. */
export const SUBAGENT_LIMIT = 50
export const SUBAGENT_ANSWER_CHARS = 200
export const SUBAGENT_MESSAGE_CHARS = 20_000

/**
 * Open one local file on the operator's desktop, following the same platform
 * split directory-picker.ts uses for its native surface. The launcher hands
 * off and exits, so a command that never returns is killed at the timeout
 * instead of holding the request open.
 */
export function openLocalFile(path: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : process.platform === 'linux' ? 'xdg-open' : undefined
  if (command === undefined) throw new RuntimeError('UNSUPPORTED', '当前系统没有可用的文件打开方式')
  // `start` is a cmd builtin, and its first quoted argument is the window title.
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

function imageData(value: string): string {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(value)
  return match?.[1] ?? value
}

export function canonicalSubmit(input: SubmitInput): string {
  return JSON.stringify({
    text: input.text,
    images: (input.images ?? []).map((image) => ({ mimeType: image.mimeType, data: image.data })),
    files: (input.files ?? []).map((file) => ({ name: file.name, mimeType: file.mimeType, data: file.data })),
    whenBusy: input.whenBusy ?? 'followUp',
  })
}

export function fingerprintSubmit(input: SubmitInput): string {
  return createHash('sha256').update(canonicalSubmit(input)).digest('hex')
}

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

export function cloneMetadata(value: Readonly<ConversationMetadata>): ConversationMetadata {
  return {
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archived: value.archived,
    pinned: value.pinned,
    // Documents written before the unread marker existed read as seen at their last update,
    // so upgrading does not light up every historical conversation at once.
    seenAt: value.seenAt ?? value.updatedAt,
    titleSource: value.titleSource,
    queueCreatedAt: { ...value.queueCreatedAt },
    requestReceipts: structuredClone(value.requestReceipts),
    workspaceId: value.workspaceId,
    presetId: value.presetId,
    accessMode: value.accessMode,
    feedback: { ...value.feedback },
    queueEdits: structuredClone(value.queueEdits),
  }
}
