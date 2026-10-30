import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { isMap, parseDocument } from 'yaml'
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  Models,
  Tool,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import type { Conversation, ConversationId, EntryId, Harness, ModelRef, Submission } from '@earendil-works/pi-durable'
import type { AccessMode, ThinkingLevel } from '../../shared/types.ts'
import { estimateMessagesTokens } from '../conversation/compaction.ts'
import { memoryInstructions } from './policy.ts'
import {
  argumentPath,
  ensureMemoryDirectory,
  isContainedMemoryPath,
  readMemoryFile,
  resolveMemoryRoot,
  resolveSafeMemoryPath,
  stampOriginSessionId,
} from './store.ts'

const CTX: Context = BACKGROUND_CONTEXT
const MEMORY_DEBUG = process.env.PI_WEB_MEMORY_DEBUG === '1'
/** Opt-in diagnostics for a background task that is otherwise silent by design. */
function debugLog(...values: unknown[]): void {
  if (MEMORY_DEBUG) console.info('[memory]', ...values)
}
export const MEMORY_EXTRACTION_MAX_TURNS = 5
export const MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS = 5_000
export const MEMORY_EXTRACTION_TIMEOUT_MS = 120_000
export const MEMORY_EXTRACTION_DRAIN_MS = 60_000
export const MEMORY_MANIFEST_LIMIT = 200
const MANIFEST_PREVIEW_LINES = 30
const MAX_READ_BYTES = 256 * 1024
const MAX_LIST_ENTRIES = 2_000
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_SEARCH_MATCHES = 200
const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', '.data'])

/* ------------------------------------------------------------------ */
/* Run decision                                                        */
/* ------------------------------------------------------------------ */

export type MemorySkipReason = 'direct-memory-write' | 'no-user-prose'

function textOfContent(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

/** The two skips ZCode applies before spending a model call. */
export function memorySkipReason(messages: readonly Message[], root: string, cwd: string): MemorySkipReason | undefined {
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue
      if (block.name !== 'write' && block.name !== 'edit') continue
      const raw = argumentPath(block.arguments)
      if (raw === undefined) continue
      const target = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
      if (isContainedMemoryPath(target, root)) return 'direct-memory-write'
    }
  }
  const hasProse = messages.some(message => {
    if (message.role !== 'user') return false
    return textOfContent(message.content).split(/\s+/u).filter(Boolean).length >= 3
  })
  return hasProse ? undefined : 'no-user-prose'
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

export type ExtractionOutcome = 'success' | 'skip' | 'error' | 'aborted'

export interface ExtractionRunResult {
  outcome: ExtractionOutcome
  /** Cursor to store after a success or a skip; an error or abort keeps the previous one. */
  cursor?: EntryId
}

/**
 * One running slot plus one latest-pending slot per conversation. `schedule()` is synchronous:
 * the running flag is set in the same turn, so two schedules cannot start two runners.
 */
export function createExtractionScheduler(
  run: (cursor: EntryId | undefined, signal: AbortSignal) => Promise<ExtractionRunResult>,
): {
  schedule(): void
  shutdown(): void
  drain(): Promise<void>
  cursor(): EntryId | undefined
} {
  let running = false
  let pending = false
  let stopped = false
  let cursor: EntryId | undefined
  let controller: AbortController | undefined
  const idle = new Set<() => void>()

  const loop = async (): Promise<void> => {
    running = true
    try {
      while (pending && !stopped) {
        pending = false
        const current = new AbortController()
        controller = current
        let result: ExtractionRunResult
        try {
          result = await run(cursor, current.signal)
        } catch {
          result = { outcome: current.signal.aborted ? 'aborted' : 'error' }
        }
        if (result.outcome === 'success' || result.outcome === 'skip') {
          if (result.cursor !== undefined) cursor = result.cursor
        }
        controller = undefined
      }
    } finally {
      running = false
      for (const resolveIdle of idle) resolveIdle()
      idle.clear()
    }
  }

  return {
    schedule() {
      if (stopped) return
      pending = true
      if (!running) void loop()
    },
    shutdown() {
      stopped = true
      pending = false
      controller?.abort()
    },
    async drain() {
      if (!running) return
      await new Promise<void>(resolveIdle => idle.add(resolveIdle))
    },
    cursor() {
      return cursor
    },
  }
}

/* ------------------------------------------------------------------ */
/* Manifest and prompt                                                 */
/* ------------------------------------------------------------------ */

export interface MemoryManifestEntry {
  /** Path relative to the memory root, with forward slashes. */
  file: string
  type?: string
  description?: string
  modifiedAt: number
}

function frontmatterFields(content: string): { type?: string; description?: string } {
  const match = /^(\uFEFF?)---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content)
  if (match === null) return {}
  const document = parseDocument(match[2] ?? '')
  if (document.errors.length > 0) return {}
  const result: { type?: string; description?: string } = {}
  const description = document.get('description')
  if (typeof description === 'string' && description.trim() !== '') result.description = description.trim()
  const metadata = document.get('metadata')
  if (isMap(metadata)) {
    const type = metadata.get('type')
    if (typeof type === 'string' && type.trim() !== '') result.type = type.trim()
  }
  return result
}

/** Scan the memory root for fact files, newest first, reading only each file's frontmatter. */
export async function scanMemoryManifest(root: string, limit = MEMORY_MANIFEST_LIMIT): Promise<MemoryManifestEntry[]> {
  const entries: MemoryManifestEntry[] = []
  const walk = async (directory: string): Promise<void> => {
    if (entries.length >= limit) return
    let items
    try {
      items = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (entries.length >= limit) return
      if (item.isSymbolicLink() || item.name === 'node_modules') continue
      const path = join(directory, item.name)
      if (item.isDirectory()) {
        if (OMITTED_DIRECTORIES.has(item.name)) continue
        await walk(path)
        continue
      }
      if (!item.isFile() || !item.name.endsWith('.md') || item.name === 'MEMORY.md') continue
      let modifiedAt = 0
      try {
        modifiedAt = (await lstat(path)).mtimeMs
      } catch {
        continue
      }
      const record = await readMemoryFile(path)
      if (record.status !== 'loaded') continue
      const preview = record.content.split(/\r?\n/u).slice(0, MANIFEST_PREVIEW_LINES).join('\n')
      const fields = frontmatterFields(preview)
      entries.push({
        file: relative(root, path).split(sep).join('/'),
        modifiedAt,
        ...fields,
      })
    }
  }
  await walk(root)
  return entries.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

function formatManifest(entries: readonly MemoryManifestEntry[]): string {
  return entries.map((entry) => {
    const type = entry.type ?? 'unknown'
    const description = entry.description ?? ''
    return `- [${type}] ${entry.file} (${new Date(entry.modifiedAt).toISOString()}): ${description}`
  }).join('\n')
}

/** The extraction prompt. `Nothing to save.` stays verbatim: it is a contract marker, not prose. */
export function extractionPrompt(root: string, messageCount: number, manifest: readonly MemoryManifestEntry[]): string {
  const lines = [
    '# 记忆提取',
    '',
    `你现在是记忆提取子代理。分析上面最近约 ${messageCount} 条消息，并用它们更新你的持久记忆系统。`,
    '',
    `可用工具：read、list_files、search_files（只读），以及仅限记忆目录 \`${root}/\` 内 .md 路径的 write/edit/delete（不能删除 MEMORY.md）。其余工具一律会被拒绝。`,
    '',
    '你的轮次预算有限（5 轮）。edit 的 oldText 必须与文件当前内容完全一致，所以高效策略是：第 1 轮——并行发出所有可能要更新的文件的 read；第 2 轮——并行发出所有 write/edit。不要把读和写交错到多轮。',
    '',
    `你必须只使用最近约 ${messageCount} 条消息的内容来更新持久记忆。不要浪费任何轮次去调查或验证这些内容——不要 grep 源码、不要读代码确认某个模式存在、不要执行 git 命令。`,
  ]
  if (manifest.length > 0) {
    lines.push(
      '',
      '## 已有记忆文件',
      '',
      formatManifest(manifest),
      '',
      '写入前先查这份清单——更新已有文件，而不是新建重复。',
    )
  }
  lines.push(
    '',
    '如果没有值得保存的内容，只输出「Nothing to save.」，不要解释原因。',
    '',
    '如果用户明确要求记住某件事，立即按最合适的类型保存。如果用户要求忘掉某件事，找到并删除相关条目。',
    '',
    '记忆类型、不该保存的判据与 frontmatter 格式，以系统提示中的记忆节为准——它已在你的上下文里。',
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* Extraction tool catalog                                             */
/* ------------------------------------------------------------------ */

export const MEMORY_EXTRACTION_TOOL_NAMES = ['read', 'list_files', 'search_files', 'write', 'edit', 'delete'] as const
const EXTRACTION_TOOL_NAMES = new Set<string>(MEMORY_EXTRACTION_TOOL_NAMES)

export function memoryExtractionTools(): Tool[] {
  return [
    {
      name: 'read',
      description: 'Read a text file. Paths may be inside the conversation workspace or the memory directory.',
      parameters: Type.Object({ path: Type.String({ description: 'Absolute path, or a path relative to the workspace.' }) }),
    },
    {
      name: 'list_files',
      description: 'List files under a directory (recursive). Paths may be inside the workspace or the memory directory.',
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: 'Directory to list; defaults to the workspace root.' })) }),
    },
    {
      name: 'search_files',
      description: 'Search file contents for a case-insensitive literal phrase.',
      parameters: Type.Object({
        pattern: Type.String({ description: 'Literal text to search for.' }),
        path: Type.Optional(Type.String({ description: 'Directory to search; defaults to the workspace root.' })),
      }),
    },
    {
      name: 'write',
      description: 'Write a memory file. Only .md paths inside the memory directory are allowed.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    },
    {
      name: 'edit',
      description: 'Replace text in a memory file. Only .md paths inside the memory directory are allowed.',
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      }),
    },
    {
      name: 'delete',
      description: 'Delete a memory file. Only .md paths inside the memory directory are allowed; MEMORY.md cannot be deleted.',
      parameters: Type.Object({ path: Type.String() }),
    },
  ]
}

export const MEMORY_EXTRACTION_POLICY_MESSAGE = (root: string): string =>
  `此上下文只允许 read、list_files、search_files，以及 ${root} 内 .md 的 write/edit/delete`

interface ExtractionExecutorOptions {
  root: string
  cwd: string
  conversationId: ConversationId
  signal: AbortSignal
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function resolveAllowed(raw: string, base: string, root: string): string | undefined {
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  return within(base, candidate) || within(root, candidate) ? candidate : undefined
}

async function writeMemoryText(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.tmp-memory-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Host-side tool executor for extraction: it never touches the conversation's env or transcript. */
export async function executeExtractionTool(call: ToolCall, options: ExtractionExecutorOptions): Promise<{ content: string; isError: boolean }> {
  options.signal.throwIfAborted()
  const args = (typeof call.arguments === 'object' && call.arguments !== null ? call.arguments : {}) as Record<string, unknown>

  if (call.name === 'read') {
    const raw = typeof args.path === 'string' ? args.path : undefined
    if (raw === undefined) return { content: 'read requires a path.', isError: true }
    const path = resolveAllowed(raw, options.cwd, options.root)
    if (path === undefined) return { content: MEMORY_EXTRACTION_POLICY_MESSAGE(options.root), isError: true }
    const record = await readMemoryFile(path, MAX_READ_BYTES)
    if (record.status === 'loaded') return { content: record.content, isError: false }
    if (record.status === 'missing') return { content: `File not found: ${raw}`, isError: true }
    return { content: `Could not read ${raw}: ${record.reason}`, isError: true }
  }

  if (call.name === 'list_files') {
    const raw = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : options.cwd
    const base = resolveAllowed(raw, options.cwd, options.root)
    if (base === undefined) return { content: MEMORY_EXTRACTION_POLICY_MESSAGE(options.root), isError: true }
    const listed: string[] = []
    const walk = async (directory: string): Promise<void> => {
      if (listed.length >= MAX_LIST_ENTRIES) return
      let items
      try {
        items = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (listed.length >= MAX_LIST_ENTRIES) return
        if (item.isSymbolicLink()) continue
        if (item.isDirectory() && OMITTED_DIRECTORIES.has(item.name)) continue
        const path = join(directory, item.name)
        if (item.isDirectory()) {
          await walk(path)
          continue
        }
        if (item.isFile()) listed.push(relative(base, path).split(sep).join('/'))
      }
    }
    await walk(base)
    return { content: listed.length === 0 ? '(empty)' : listed.join('\n'), isError: false }
  }

  if (call.name === 'search_files') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (pattern === '') return { content: 'search_files requires a pattern.', isError: true }
    const raw = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : options.cwd
    const base = resolveAllowed(raw, options.cwd, options.root)
    if (base === undefined) return { content: MEMORY_EXTRACTION_POLICY_MESSAGE(options.root), isError: true }
    const needle = pattern.toLowerCase()
    const matches: string[] = []
    const searchFile = async (path: string): Promise<void> => {
      if (matches.length >= MAX_SEARCH_MATCHES) return
      const record = await readMemoryFile(path, MAX_SEARCH_FILE_BYTES)
      if (record.status !== 'loaded') return
      const lines = record.content.split(/\r?\n/u)
      for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES; index += 1) {
        if (!lines[index]!.toLowerCase().includes(needle)) continue
        matches.push(`${relative(base, path).split(sep).join('/')}:${index + 1}: ${lines[index]!.trim().slice(0, 200)}`)
      }
    }
    const walk = async (directory: string): Promise<void> => {
      if (matches.length >= MAX_SEARCH_MATCHES) return
      let items
      try {
        items = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (matches.length >= MAX_SEARCH_MATCHES) return
        if (item.isSymbolicLink()) continue
        if (item.isDirectory() && OMITTED_DIRECTORIES.has(item.name)) continue
        const path = join(directory, item.name)
        if (item.isDirectory()) await walk(path)
        else if (item.isFile()) await searchFile(path)
      }
    }
    await walk(base)
    return { content: matches.length === 0 ? '(no matches)' : matches.join('\n'), isError: false }
  }

  if (call.name === 'write') {
    const raw = typeof args.path === 'string' ? args.path : undefined
    const content = typeof args.content === 'string' ? args.content : undefined
    if (raw === undefined || content === undefined) return { content: 'write requires path and content.', isError: true }
    const path = resolveSafeMemoryPath(isAbsolute(raw) ? raw : resolve(options.cwd, raw), options.root)
    if (path === undefined) return { content: MEMORY_EXTRACTION_POLICY_MESSAGE(options.root), isError: true }
    await ensureMemoryDirectory(options.root)
    const stamped = stampOriginSessionId(content, path, options.root, String(options.conversationId))
    await writeMemoryText(path, stamped)
    return { content: `Successfully wrote to ${raw}`, isError: false }
  }

  if (call.name === 'edit') {
    const raw = typeof args.path === 'string' ? args.path : undefined
    if (raw === undefined) return { content: 'edit requires a path.', isError: true }
    const path = resolveSafeMemoryPath(isAbsolute(raw) ? raw : resolve(options.cwd, raw), options.root)
    if (path === undefined) return { content: MEMORY_EXTRACTION_POLICY_MESSAGE(options.root), isError: true }
    const incoming = Array.isArray(args.edits) ? args.edits : []
    if (incoming.length === 0) return { content: 'edit requires at least one replacement.', isError: true }
    const record = await readMemoryFile(path)
    if (record.status === 'missing') return { content: `File not found: ${raw}`, isError: true }
    if (record.status !== 'loaded') return { content: `Could not edit ${raw}: ${record.reason}`, isError: true }
    let content = record.content
    for (const value of incoming) {
      if (typeof value !== 'object' || value === null) return { content: 'Each edit requires oldText and newText.', isError: true }
      const edit = value as Record<string, unknown>
      if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string' || edit.oldText === '') {
        return { content: 'Each edit requires a non-empty oldText and a string newText.', isError: true }
      }
      const first = content.indexOf(edit.oldText)
      if (first < 0) return { content: `oldText was not found in ${raw}.`, isError: true }
      if (content.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
        return { content: `oldText is not unique in ${raw}.`, isError: true }
      }
      content = content.slice(0, first) + edit.newText + content.slice(first + edit.oldText.length)
    }
    const stamped = stampOriginSessionId(content, path, options.root, String(options.conversationId))
    await writeMemoryText(path, stamped)
    return { content: `Successfully edited ${raw}`, isError: false }
  }

  if (call.name === 'delete') {
    const raw = typeof args.path === 'string' ? args.path : undefined
    if (raw === undefined) return { content: 'delete requires a path.', isError: true }
    const path = resolveSafeMemoryPath(isAbsolute(raw) ? raw : resolve(options.cwd, raw), options.root)
    if (path === undefined || basename(path) === 'MEMORY.md') {
      return { content: MEMORY_EXTRACTION_POLICY_MESSAGE(options.root), isError: true }
    }
    const record = await readMemoryFile(path)
    if (record.status === 'missing') return { content: `File not found: ${raw}`, isError: true }
    await rm(path)
    return { content: `Successfully deleted ${raw}`, isError: false }
  }

  return { content: `Error: No such tool available: ${call.name}`, isError: true }
}

/* ------------------------------------------------------------------ */
/* Restricted loop                                                     */
/* ------------------------------------------------------------------ */

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function addUsage(total: Usage, usage: Usage): void {
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

export interface ExtractionLoopOptions {
  systemPrompt: string
  messages: Message[]
  tools: Tool[]
  signal: AbortSignal
  maxTokens: number
  sessionId: string
  timeoutMs: number
  reasoning?: ThinkingLevel
  maxTurns?: number
}

export interface ExtractionLoopDeps {
  complete: (context: { systemPrompt: string; messages: Message[]; tools: Tool[] }, options: {
    maxTokens: number
    signal: AbortSignal
    sessionId: string
    timeoutMs: number
    reasoning?: ThinkingLevel
  }) => Promise<AssistantMessage>
  execute: (call: ToolCall, signal: AbortSignal) => Promise<{ content: string; isError: boolean }>
  root: string
  cwd: string
}

export interface ExtractionLoopResult {
  turns: number
  usage: Usage
  messages: Message[]
}

function summarizeExtractionAnswer(messages: readonly Message[]): string {
  const last = messages.at(-1)
  if (last === undefined) return 'none'
  if (last.role === 'assistant') {
    return JSON.stringify({
      stopReason: last.stopReason,
      usage: last.usage.totalTokens,
      content: last.content.map(part => part.type === 'text'
        ? { type: 'text', text: part.text.slice(0, 500) }
        : part.type === 'toolCall'
          ? { type: 'toolCall', name: part.name, args: JSON.stringify(part.arguments).slice(0, 500) }
          : { type: part.type }),
    }).slice(0, 1_500)
  }
  if (last.role === 'toolResult') {
    return JSON.stringify({ role: 'toolResult', tool: last.toolName, isError: last.isError, text: last.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('').slice(0, 500) }).slice(0, 1_500)
  }
  return last.role
}

/**
 * The extraction agent loop. Tool calls run as issued; a rejected call becomes an `isError` tool
 * result without reaching the executor. The last permitted round still executes its calls, but no
 * sixth request is sent.
 */
export async function runExtractionLoop(
  options: ExtractionLoopOptions,
  deps: ExtractionLoopDeps,
): Promise<ExtractionLoopResult> {
  const maxTurns = options.maxTurns ?? MEMORY_EXTRACTION_MAX_TURNS
  const messages = [...options.messages]
  const usage = emptyUsage()
  let turns = 0

  while (true) {
    options.signal.throwIfAborted()
    turns += 1
    const answer = await deps.complete(
      { systemPrompt: options.systemPrompt, messages, tools: options.tools },
      {
        maxTokens: options.maxTokens,
        signal: options.signal,
        sessionId: options.sessionId,
        timeoutMs: options.timeoutMs,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      },
    )
    addUsage(usage, answer.usage)
    if (MEMORY_DEBUG) debugLog('turn', turns, summarizeExtractionAnswer([answer]))
    // A provider-level failure must leave the cursor unchanged so the next run retries the range.
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
      throw new Error(answer.errorMessage ?? `extraction request stopped with ${answer.stopReason}`)
    }
    messages.push(answer)

    const calls = answer.content.filter((block): block is ToolCall => block.type === 'toolCall')
    if (calls.length === 0) break

    const results = await Promise.all(calls.map(async (call): Promise<Message> => {
      const allowed = EXTRACTION_TOOL_NAMES.has(call.name)
      const memoryWrite = call.name === 'write' || call.name === 'edit' || call.name === 'delete'
      const path = memoryWrite ? argumentPath(call.arguments) : undefined
      const safe = memoryWrite && path !== undefined
        ? resolveSafeMemoryPath(isAbsolute(path) ? path : resolve(deps.cwd, path), deps.root) !== undefined
        : true
      const result = !allowed
        ? { content: `Error: No such tool available: ${call.name}`, isError: true }
        : memoryWrite && !safe
          ? { content: MEMORY_EXTRACTION_POLICY_MESSAGE(deps.root), isError: true }
          : await deps.execute(call, options.signal).catch((error: unknown) => ({
              content: error instanceof Error ? error.message : String(error),
              isError: true,
            }))
      return {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: result.content }],
        isError: result.isError,
        timestamp: Date.now(),
      }
    }))
    messages.push(...results)
    if (turns >= maxTurns) break
  }

  return { turns, usage, messages }
}

/* ------------------------------------------------------------------ */
/* Runtime integration                                                 */
/* ------------------------------------------------------------------ */

export interface MemoryExtractionDeps {
  harness: () => Harness
  models: () => Models
  dataDir: string
  memoryEnabled: () => boolean
  defaultModel: () => ModelRef | undefined
  accessMode: (conversationId: ConversationId) => Promise<AccessMode | undefined>
  thinkingLevels: (provider: string, modelId: string) => ThinkingLevel[] | undefined
  recordUsage: (conversationId: ConversationId, model: ModelRef, usage: Usage) => Promise<void>
}

export interface MemoryExtraction {
  scheduleAfterSubmission(conversation: Conversation, submission: Submission): void
  shutdown(): void
  drain(timeoutMs: number): Promise<void>
}

interface ExtractionInput {
  conversationId: ConversationId
  cwd: string
  root: string
  model: Model<Api>
  modelRef: ModelRef
  messages: Message[]
  cursor: EntryId | undefined
}

export function createMemoryExtraction(deps: MemoryExtractionDeps): MemoryExtraction {
  const schedulers = new Map<string, ReturnType<typeof createExtractionScheduler>>()
  let shuttingDown = false

  const schedulerFor = (conversationId: ConversationId) => {
    const key = String(conversationId)
    let scheduler = schedulers.get(key)
    if (scheduler === undefined) {
      scheduler = createExtractionScheduler((cursor, signal) => runExtraction(conversationId, cursor, signal))
      schedulers.set(key, scheduler)
    }
    return scheduler
  }

  const buildInput = async (conversationId: ConversationId, cursor: EntryId | undefined): Promise<ExtractionInput | undefined> => {
    const harness = deps.harness()
    const conversation = await harness.conversation(conversationId, CTX)
    if (conversation === undefined) return undefined
    const [view, agent] = await Promise.all([conversation.context(CTX), conversation.agent(CTX)])
    const cwd = agent.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
    const route = agent.model ?? deps.defaultModel()
    if (route === undefined) return undefined
    const model = deps.models().getModel(route.provider, route.modelId)
    if (model === undefined) return undefined

    const index = cursor === undefined ? -1 : view.entries.findIndex(entry => entry.id === cursor)
    const start = index < 0 ? 0 : index + 1
    const messages: Message[] = []
    for (let position = start; position < view.entries.length; position += 1) {
      // The transcript's system message carries the main session's sections and tool list.
      // Extraction supplies its own prompt and its five-tool catalog, so it must not be replayed.
      for (const message of view.contributions[position] ?? []) {
        if (message.role !== 'system') messages.push(message)
      }
    }

    // Bound the snapshot to half the context window, then drop orphaned tool results so the
    // extraction request never starts with a result whose call was trimmed away.
    const budget = Math.max(1, Math.floor(model.contextWindow / 2))
    let trimmed = messages
    while (trimmed.length > 0 && estimateMessagesTokens(trimmed) > budget) trimmed = trimmed.slice(1)
    while (trimmed.length > 0 && trimmed[0]!.role === 'toolResult') trimmed = trimmed.slice(1)

    return {
      conversationId,
      cwd,
      root: resolveMemoryRoot({ dataDir: deps.dataDir, workspacePath: cwd }),
      model,
      modelRef: { provider: route.provider, modelId: route.modelId },
      messages: trimmed,
      cursor: view.entries.at(-1)?.id,
    }
  }

  const runExtraction = async (conversationId: ConversationId, cursor: EntryId | undefined, signal: AbortSignal): Promise<ExtractionRunResult> => {
    const input = await buildInput(conversationId, cursor)
    if (input === undefined) return { outcome: 'skip' }
    const skip = memorySkipReason(input.messages, input.root, input.cwd)
    debugLog('snapshot', { conversationId: String(conversationId), messages: input.messages.length, skip })
    if (skip !== undefined) return { outcome: 'skip', cursor: input.cursor }

    try {
      await ensureMemoryDirectory(input.root)
      const manifest = await scanMemoryManifest(input.root)
      // The instruction must be the last user turn. With it only in the system prompt, a model
      // that sees an assistant answer as the final message treats the conversation as complete
      // and returns empty text instead of calling the memory tools.
      const systemPrompt = memoryInstructions(input.root)
      const instruction = extractionPrompt(input.root, input.messages.length, manifest)
      const messages: Message[] = [
        ...input.messages,
        { role: 'user', content: [{ type: 'text', text: instruction }], timestamp: Date.now() },
      ]
      const levels = deps.thinkingLevels(input.modelRef.provider, input.modelRef.modelId)
      const reasoning = levels?.length ? levels[0] : undefined
      const result = await runExtractionLoop(
        {
          systemPrompt,
          messages,
          tools: memoryExtractionTools(),
          signal,
          maxTokens: Math.min(MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS, input.model.maxTokens ?? MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS),
          sessionId: `memory-${String(conversationId)}`,
          timeoutMs: MEMORY_EXTRACTION_TIMEOUT_MS,
          ...(reasoning === undefined || reasoning === 'off' ? {} : { reasoning }),
        },
        {
          complete: (context, options) => deps.models().complete(input.model, context, options),
          execute: async (call, toolSignal) => {
            const outcome = await executeExtractionTool(call, {
              root: input.root,
              cwd: input.cwd,
              conversationId,
              signal: toolSignal,
            })
            debugLog('tool', call.name, outcome.isError ? 'error' : 'ok', outcome.content.slice(0, 160))
            return outcome
          },
          root: input.root,
          cwd: input.cwd,
        },
      )
      await deps.recordUsage(conversationId, input.modelRef, result.usage).catch(() => undefined)
      debugLog('done', { conversationId: String(conversationId), turns: result.turns, last: summarizeExtractionAnswer(result.messages) })
      return { outcome: 'success', cursor: input.cursor }
    } catch (error) {
      debugLog('failed', { conversationId: String(conversationId), aborted: signal.aborted, error: error instanceof Error ? error.message : String(error) })
      return { outcome: signal.aborted ? 'aborted' : 'error' }
    }
  }

  return {
    scheduleAfterSubmission(conversation, submission) {
      void submission.wait(CTX).then(async (settled) => {
        if (shuttingDown) return
        if (settled.status !== 'done') { debugLog('schedule', { conversationId: String(conversation.id), settled: settled.status }); return }
        if (!deps.memoryEnabled()) { debugLog('schedule', { conversationId: String(conversation.id), enabled: false }); return }
        const mode = await deps.accessMode(conversation.id)
        if (mode === 'readOnly') { debugLog('schedule', { conversationId: String(conversation.id), mode }); return }
        if (shuttingDown) return
        debugLog('schedule', { conversationId: String(conversation.id), mode })
        schedulerFor(conversation.id).schedule()
      }).catch(() => undefined)
    },
    shutdown() {
      shuttingDown = true
      for (const scheduler of schedulers.values()) scheduler.shutdown()
    },
    async drain(timeoutMs) {
      const pending = [...schedulers.values()].map(scheduler => scheduler.drain())
      if (pending.length === 0) return
      await Promise.race([
        Promise.all(pending),
        new Promise<void>(resolveTimer => {
          const timer = setTimeout(resolveTimer, timeoutMs)
          timer.unref?.()
        }),
      ])
    },
  }
}

