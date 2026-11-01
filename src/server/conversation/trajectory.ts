/**
 * Complete trajectory capture and export for pi-web.
 *
 * Pi Durable's sqlite already persists the transcript (entries) and per-call
 * timing (tasks); what cannot be reconstructed later is the exact outbound
 * request — after compaction pruning, shadowing and code-mode wrapping. This
 * extension appends every outbound request and every terminal provider attempt
 * to one JSONL file per conversation, and `assembleTrajectory()` merges that
 * capture with the durable entries and tasks into a single chronological file
 * a model can be fed for offline analysis (the collect-then-analyze loop).
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

export const TRAJECTORY_EXTENSION_NAME = 'pi-web-trajectory'

declare module '@earendil-works/pi-ai' {
  interface AssistantMessage {
    /** Milliseconds from stream start to first visible content; stamped by pi-web's trajectory capture. */
    ttftMs?: number
  }
}

/** Subdirectory of the data dir receiving `<conversationId>.jsonl` capture files. */
export const TRAJECTORY_CAPTURE_DIR = 'trajectories'

export interface TrajectoryExtensionOptions {
  dir: string
  /** Read per runtime creation so tests can flip it without re-importing the module. */
  enabled: boolean
  /** Resolved lazily: the extension is installed before `Harness.open` returns. */
  harness: () => Harness | undefined
}

/** Where side-call helpers (`captureSideCall`) write; set by the extension factory, per runtime. */
let captureContext: { dir: string; enabled: boolean } | undefined

/** Writes are fire-and-forget: a capture failure must never break a model run. */
let captureTail: Promise<void> = Promise.resolve()
const warnedFiles = new Set<string>()
const disabledFiles = new Set<string>()

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

/** Resolve once pending capture writes have hit disk, before an export reads them. */
export function drainTrajectoryCapture(): Promise<void> {
  return captureTail
}

/** One outbound provider request: numbered within its generation task. */
interface RequestSequence {
  task: string
  request: number
}

export function createTrajectoryExtension(options: TrajectoryExtensionOptions): Extension {
  captureContext = { dir: options.dir, enabled: options.enabled }
  const captureFile = (api: HookApi): string => join(options.dir, `${String(api.conversationId)}.jsonl`)
  const sequences = new Map<string, RequestSequence>()
  const catalogs = new Map<string, string>()

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

  /** What the conversation's agent would send this request: model, level, and the offered tools. */
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
      // Agent state is best-effort context; it must never block capturing the request itself.
      return {}
    }
  }

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
      messages: request.messages,
    })
    // The tool catalog changes rarely; hash-gate it so only real changes become lines.
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
      message,
    })
  }

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
 * Pass-through observer for one provider stream: times start → first visible
 * content and stamps the final message with `ttftMs` (absent when nothing
 * streamed, e.g. an immediate error). pi-durable reads the final message from
 * `result()`, so that is the critical path; the done/error events are stamped
 * as well for any consumer that iterates.
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
  // The generation task only iterates and calls `result()`; a plain object with
  // that surface keeps the pass-through exact without reimplementing the class.
  return {
    [Symbol.asyncIterator]: iterate,
    result: () => inner.result().then(stamp),
  } as unknown as AssistantMessageEventStream
}

/**
 * Wrap the models catalog handed to `Harness.open` so every provider stream —
 * generation tasks and direct calls alike — gets `ttftMs` on its final
 * message, which then flows into the durable entry and the trajectory export
 * unchanged. Everything else on the catalog passes through untouched.
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

export interface SideCallContext {
  /** Owner conversation; `undefined` skips capture (no file to attach to). */
  conversationId: string | number | undefined
  purpose: string
}

/**
 * Record one model call outside the generation task — session title, compaction
 * summary, commit message, memory extraction — into the conversation's capture
 * file as a `sidecall` line. Errors are recorded and rethrown unchanged; with
 * capture disabled or no owning conversation this is a plain `run()`.
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
    record({ answer })
    return answer
  } catch (error) {
    record({ error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface TrajectoryExportOptions {
  dbPath: string
  captureDir: string
  conversationId: string
}

interface EntryRow {
  id: number
  head: number | null
  commit_seq: number
  record: string
}

interface TaskRow {
  id: number
  kind: string
  status: string
  record: string
}

function recordTimestamp(record: unknown): number | undefined {
  const messages = (record as { model?: ReadonlyArray<{ timestamp?: unknown }> } | null)?.model
  const last = messages?.[messages.length - 1]
  return typeof last?.timestamp === 'number' ? last.timestamp : undefined
}

function taskTimestamp(record: unknown, field: 'startedAt' | 'endedAt'): number | undefined {
  const value = (record as Record<string, unknown> | null)?.[field]
  return typeof value === 'number' ? value : undefined
}

/** Pi Durable stores task kinds JSON-encoded (`"pi.generation"`); strip the wrapper for export. */
function normalizeTaskKind(kind: string): string {
  return kind.replace(/^"([\s\S]*)"$/, '$1')
}

interface TrajectoryItem {
  ts: number
  line: Record<string, unknown>
}

/**
 * Build the full trajectory of one conversation as chronological JSONL: the
 * conversation record first, then entries, tasks and the captured outbound
 * requests/responses ordered by timestamp (stable for equal stamps).
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
          record,
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
          record,
        },
      })
    }
    const capturePath = join(options.captureDir, `${options.conversationId}.jsonl`)
    let captureText: string | undefined
    try {
      captureText = await readFile(capturePath, 'utf8')
    } catch {
      // Sessions recorded before the capture extension have no file; entries and tasks suffice.
    }
    if (captureText !== undefined) {
      for (const line of captureText.split('\n')) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line) as { ts?: unknown }
          items.push({ ts: typeof parsed.ts === 'number' ? parsed.ts : 0, line: parsed as Record<string, unknown> })
        } catch {
          // A torn last line (crash mid-append) must not poison the whole export.
        }
      }
    }

    // Stable sort (V8): equal timestamps keep entries-before-tasks-before-capture order.
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
