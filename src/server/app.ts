import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { basename, relative } from 'node:path'
import { userInfo } from 'node:os'
import { z } from 'zod'
import packageJson from '../../package.json' with { type: 'json' }
import type { ConversationDetail, CreateConversationInput, ProviderInput, SubmitInput, UpdateConversationInput } from '../shared/types.ts'
import { COLLAPSE_TIMINGS, PERFORMANCE_USAGE_MODES, TRANSCRIPT_VIEW_MODES } from '../shared/types.ts'
import type { Runtime } from './contracts.ts'
import { RuntimeError } from './runtime-errors.ts'

const packageVersion: string = packageJson.version

const JSON_BODY_LIMIT = 16 * 1024 * 1024
const IMAGE_LIMIT = 4 * 1024 * 1024
const TOTAL_IMAGE_LIMIT = 8 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const accessModes = ['readOnly', 'workspaceWrite', 'fullAccess'] as const

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._~-]+$/)
const modelRef = z.object({
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(256),
}).strict()

const createSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  model: modelRef.optional(),
  thinkingLevel: z.enum(thinkingLevels).optional(),
  workspaceId: identifier.optional(),
  presetId: identifier.optional(),
  accessMode: z.enum(accessModes).optional(),
}).strict()

const updateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  model: modelRef.optional(),
  thinkingLevel: z.enum(thinkingLevels).optional(),
  workspaceId: identifier.optional(),
  presetId: identifier.nullable().optional(),
  accessMode: z.enum(accessModes).optional(),
}).strict().refine(value => Object.keys(value).length > 0)

function binarySchema(limit: number) {
  return z.string().min(4).max(Math.ceil(limit / 3) * 4 + 4).refine(value => {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
    const bytes = Buffer.from(value, 'base64')
    return bytes.length <= limit && bytes.toString('base64') === value
  })
}
const imageSchema = z.object({ data: binarySchema(IMAGE_LIMIT), mimeType: z.enum(IMAGE_TYPES) }).strict()
const fileSchema = z.object({
  name: z.string().min(1).max(255).refine(value => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0')),
  data: binarySchema(TOTAL_IMAGE_LIMIT),
  mimeType: z.string().max(160).regex(/^[A-Za-z0-9.+_-]+\/[A-Za-z0-9.+_-]+$/),
}).strict()
const submitObject = z.object({
  text: z.string().max(200_000), requestId: z.string().min(1).max(160),
  whenBusy: z.enum(['steer', 'followUp', 'reject']).optional(),
  images: z.array(imageSchema).max(4).optional(), files: z.array(fileSchema).max(8).optional(),
}).strict()
function withinAttachmentBudget(input: { images?: Array<{ data: string }>; files?: Array<{ data: string }> }): boolean {
  return [...input.images ?? [], ...input.files ?? []].reduce((sum, item) => sum + Buffer.byteLength(item.data, 'base64'), 0) <= TOTAL_IMAGE_LIMIT
}
const goalSchema = z.object({
  action: z.enum(['create', 'edit', 'pause', 'resume', 'complete', 'clear']),
  objective: z.string().trim().min(1).max(2000).optional(),
  maxGoalRounds: z.number().int().min(1).max(50).optional(),
  blockedReason: z.string().trim().min(1).max(500).optional(),
}).strict().refine(value => value.action !== 'create' || value.objective !== undefined, { message: 'create needs an objective' })
const planSchema = z.object({ active: z.boolean() }).strict()
const childMessageSchema = z.object({
  text: z.string().min(1).max(20_000), requestId: z.string().min(1).max(160),
}).strict()

const submitSchema = submitObject.refine(withinAttachmentBudget).refine(input => input.text.trim().length > 0 || !!input.images?.length || !!input.files?.length)
const editQueueSchema = submitObject.extend({ whenBusy: z.enum(['steer', 'followUp']) }).refine(withinAttachmentBudget).refine(input => input.text.trim().length > 0 || !!input.images?.length || !!input.files?.length)
const jsonObject = z.record(z.string(), z.unknown())
const headersSchema = z.record(z.string().min(1).max(160).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/), z.string().max(8192).refine(value => !/[\r\n]/.test(value)))
const providerSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().max(2048).refine(value => {
    if (value === '') return true
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }).optional(),
  apiKey: z.string().max(4096).optional(), api: z.string().min(1).max(100).optional(),
  headers: headersSchema.optional(), compat: jsonObject.optional(),
  models: z.array(z.object({
    id: z.string().min(1).max(256), name: z.string().trim().min(1).max(160),
    reasoning: z.boolean().optional(), contextWindow: z.number().int().positive().max(10_000_000).optional(),
    api: z.string().max(100).optional(), baseUrl: z.string().url().optional(),
    input: z.array(z.enum(['text', 'image'])).optional(), maxTokens: z.number().int().positive().optional(),
    headers: headersSchema.optional(), compat: jsonObject.optional(), cost: jsonObject.optional(),
    inputLimits: jsonObject.optional(), thinkingLevelMap: jsonObject.optional(), promptCache: jsonObject.optional(),
    samplingParams: jsonObject.optional(), samplingParamsByThinkingLevel: jsonObject.optional(),
  }).passthrough()).min(1).max(2000),
}).strict()
const shortcutsSchema = z.object(Object.fromEntries(['newConversation', 'search', 'settings', 'toggleSidebar', 'send', 'newline', 'alternateSend'].map(name => [name, z.string().min(1).max(80).optional()]))).strict()
const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(), locale: z.enum(['zh', 'en']).optional(),
  fontSize: z.number().int().min(12).max(20).optional(), codeFontSize: z.number().int().min(10).max(16).optional(), terminalFontSize: z.number().int().min(10).max(20).optional(),
  transcriptView: z.enum(TRANSCRIPT_VIEW_MODES).optional(), collapseTiming: z.enum(COLLAPSE_TIMINGS).optional(),
  performanceUsage: z.enum(PERFORMANCE_USAGE_MODES).optional(),
  codingViews: z.boolean().optional(), busySendMode: z.enum(['followUp', 'steer']).optional(), defaultModel: modelRef.nullable().optional(),
  modelAllowlist: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  defaultThinkingLevel: z.enum(thinkingLevels).optional(), defaultAccessMode: z.enum(accessModes).optional(),
  defaultPresetId: identifier.nullable().optional(), defaultWorkspaceId: identifier.nullable().optional(), shortcuts: shortcutsSchema.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0)
const workspaceSchema = z.object({ path: z.string().min(1).max(4096).refine(value => !value.includes('\0')), name: z.string().trim().min(1).max(120).optional() }).strict()
const presetSchema = z.object({
  id: identifier.optional(), name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional(),
  instructions: z.string().max(32_000), extensions: z.array(z.string().min(1).max(160)).max(100),
  tools: z.array(z.string().min(1).max(160)).max(500), model: modelRef.optional(), thinkingLevel: z.enum(thinkingLevels).optional(), accessMode: z.enum(accessModes),
}).strict()
const automationSchema = z.object({
  name: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(100_000), enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional(),
  model: modelRef.optional(), workspaceId: identifier.optional(), presetId: identifier.optional(),
}).strict()
const automationPatchSchema = automationSchema.partial().extend({ intervalMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).nullable().optional() }).refine(value => Object.keys(value).length > 0)
const interactionAnswerSchema = z.object({
  answers: z.array(z.object({
    id: z.string().min(1).max(160),
    selected: z.array(z.string().min(1).max(200)).max(64),
    custom: z.string().max(4_000).optional(),
  }).strict()).min(1).max(8),
}).strict()

class ApiFault extends Error {
  constructor(readonly status: 400 | 403 | 413 | 415, readonly code: string, message: string) {
    super(message)
    this.name = 'ApiFault'
  }
}

type RuntimeFailure = { code?: unknown; message?: unknown }
type PublicFailure = { status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 502; code: string; message: string }

function isLocalAuthority(authority: string): { normalized: string; hostname: string } | undefined {
  const value = authority.trim().toLowerCase()
  if (value.length === 0 || value.includes(',')) return undefined
  try {
    const url = new URL(`http://${value}`)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') return undefined
    return { normalized: url.host, hostname }
  } catch {
    return undefined
  }
}

function publicFailure(error: unknown): PublicFailure {
  if (error instanceof ApiFault) {
    return { status: error.status, code: error.code, message: error.message }
  }

  if (error instanceof RuntimeError) {
    const statuses = { NOT_FOUND: 404, CONFLICT: 409, MODEL_UNAVAILABLE: 422, INVALID_INPUT: 400, FORBIDDEN: 403, UNSUPPORTED: 422, PROVIDER_ERROR: 502 } as const
    const message = error.message.replace(/[\r\n\t]+/g, ' ').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]').trim().slice(0, 240)
    return { status: statuses[error.code], code: error.code, message: message || 'The operation could not be completed' }
  }

  const code = typeof error === 'object' && error !== null ? (error as RuntimeFailure).code : undefined
  switch (code) {
    case 'NOT_FOUND':
      return { status: 404, code, message: 'Conversation not found' }
    case 'CONFLICT':
      return { status: 409, code, message: 'The operation conflicts with the current state' }
    case 'MODEL_UNAVAILABLE': {
      const source = typeof (error as RuntimeFailure).message === 'string' ? (error as RuntimeFailure).message as string : 'The selected model is unavailable'
      const message = source.replace(/[\r\n\t]+/g, ' ').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]').trim().slice(0, 240)
      return { status: 422, code, message: message || 'The selected model is unavailable' }
    }
    case 'INVALID_INPUT':
      return { status: 400, code, message: 'The request is invalid' }
    case 'FORBIDDEN':
      return { status: 403, code, message: 'This operation is not allowed by the current access mode' }
    default:
      return { status: 500, code: 'internal_error', message: 'Internal server error' }
  }
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw new ApiFault(415, 'unsupported_media_type', 'Content-Type must be application/json')

  const contentLength = request.headers.get('content-length')
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new ApiFault(400, 'invalid_content_length', 'Invalid Content-Length')
    if (Number(contentLength) > JSON_BODY_LIMIT) throw new ApiFault(413, 'body_too_large', 'Request body is too large')
  }

  if (!request.body) throw new ApiFault(400, 'invalid_json', 'A JSON request body is required')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > JSON_BODY_LIMIT) {
        await reader.cancel()
        throw new ApiFault(413, 'body_too_large', 'Request body is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  let parsed: unknown
  try {
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length)
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ApiFault(400, 'invalid_json', 'Request body must be valid UTF-8 JSON')
  }
  const result = schema.safeParse(parsed)
  if (!result.success) throw new ApiFault(400, 'invalid_body', 'Request body is invalid')
  return result.data
}

function pathId(value: string): string {
  const result = identifier.safeParse(value)
  if (!result.success) throw new ApiFault(400, 'invalid_id', 'Resource id is invalid')
  return result.data
}
function filePath(value: string | undefined): string {
  const path = value ?? ''
  if (path.length > 4096 || path.includes('\0')) throw new ApiFault(400, 'invalid_path', 'File path is invalid')
  return path
}

function sseFrame(data: ConversationDetail): Uint8Array {
  return new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Creates the local JSON API and owns active SSE subscriptions. */
export function createApp(runtime: Runtime, options: { demo?: boolean; staticRoot?: string } = {}) {  const app = new Hono()
  const shutdown = new AbortController()
  const activeStreams = new Set<Promise<void>>()
  let shuttingDown = false

  app.use('*', async (c, next) => {
    const authority = c.req.header('host') ?? new URL(c.req.url).host
    const localHost = authority ? isLocalAuthority(authority) : undefined
    if (!localHost) return c.json({ error: 'Local requests only', code: 'local_host_required' }, 403)

    const origin = c.req.header('origin')
    if (origin !== undefined) {
      try {
        const parsed = new URL(origin)
        const originHost = isLocalAuthority(parsed.host)
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || !originHost || originHost.normalized !== localHost.normalized) {
          return c.json({ error: 'Cross-origin requests are not allowed', code: 'cross_origin' }, 403)
        }
      } catch {
        return c.json({ error: 'Cross-origin requests are not allowed', code: 'cross_origin' }, 403)
      }
    }
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ error: 'Cross-origin requests are not allowed', code: 'cross_origin' }, 403)
    }
    if (shuttingDown) return c.json({ error: 'Server is shutting down', code: 'server_shutdown' }, 503)

    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    await next()
  })

  app.get('/api/health', c => c.json({ ok: true, demo: options.demo === true, version: packageVersion, user: userInfo().username }))
  app.get('/api/conversations', async c => c.json({ conversations: await runtime.list() }))
  app.post('/api/conversations', async c => {
    const input = await readJson(c.req.raw, createSchema) as CreateConversationInput
    return c.json(await runtime.create(input), 201)
  })
  app.get('/api/conversations/:id/events', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)

    let dirty = false
    let wakeChange: (() => void) | undefined
    let wakeDemand: (() => void) | undefined
    let unwatch: (() => Promise<void>) | undefined
    try {
      unwatch = await runtime.watch(id.data, () => {
        dirty = true
        wakeChange?.()
      })
      const initial = await runtime.detail(id.data)
      let signalShutdown: (() => void) | undefined
      let signalRequestAbort: (() => void) | undefined
      const wakeAll = () => {
        wakeChange?.()
        wakeDemand?.()
      }
      const streamTask = (async (controller: ReadableStreamDefaultController<Uint8Array>, isCancelled: () => boolean): Promise<void> => {
        try {
          if (!isCancelled() && !shutdown.signal.aborted) controller.enqueue(sseFrame(initial))
          while (!isCancelled() && !shutdown.signal.aborted) {
            if (dirty) {
              while (controller.desiredSize !== null && controller.desiredSize <= 0 && !isCancelled() && !shutdown.signal.aborted) {
                await new Promise<void>(resolve => {
                  wakeDemand = resolve
                  if (controller.desiredSize === null || controller.desiredSize > 0 || shutdown.signal.aborted || isCancelled()) {
                    wakeDemand = undefined
                    resolve()
                  }
                })
                wakeDemand = undefined
              }
              if (isCancelled() || shutdown.signal.aborted) break
              dirty = false
              const detail = await runtime.detail(id.data)
              if (!isCancelled() && !shutdown.signal.aborted) controller.enqueue(sseFrame(detail))
              continue
            }
            await new Promise<void>(resolve => {
              wakeChange = resolve
              if (dirty || shutdown.signal.aborted || isCancelled()) {
                wakeChange = undefined
                resolve()
              }
            })
            wakeChange = undefined
          }
        } catch (streamError) {
          if (!isCancelled()) {
            const failure = publicFailure(streamError)
            try {
              controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error: failure.message, code: failure.code })}\n\n`))
            } catch {
              // The client has already closed the stream.
            }
          }
        } finally {
          if (signalShutdown) shutdown.signal.removeEventListener('abort', signalShutdown)
          if (signalRequestAbort) c.req.raw.signal.removeEventListener('abort', signalRequestAbort)
          try {
            await unwatch?.()
          } catch (cleanupError) {
            // The subscription is ending, so there is no live request to report this cleanup failure to.
            void cleanupError
          }
          if (!isCancelled()) {
            try {
              controller.close()
            } catch {
              // The client has already closed the stream.
            }
          }
        }
      })

      let cancelStream: (() => void) | undefined
      let task: Promise<void> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let cancelled = false
          cancelStream = () => {
            cancelled = true
            wakeAll()
          }
          signalShutdown = wakeAll
          signalRequestAbort = () => cancelStream?.()
          shutdown.signal.addEventListener('abort', signalShutdown, { once: true })
          c.req.raw.signal.addEventListener('abort', signalRequestAbort, { once: true })
          if (c.req.raw.signal.aborted) signalRequestAbort()
          task = streamTask(controller, () => cancelled)
          activeStreams.add(task)
          void task.finally(() => activeStreams.delete(task as Promise<void>))
        },
        async cancel() {
          cancelStream?.()
          await task
        },
        pull() {
          wakeDemand?.()
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    } catch (error) {
      try {
        await unwatch?.()
      } catch (cleanupError) {
        // The failed subscription is already being discarded.
        void cleanupError
      }
      throw error
    }
  })
  app.get('/api/conversations/:id', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    return c.json(await runtime.detail(id.data))
  })
  app.patch('/api/conversations/:id', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    const input = await readJson(c.req.raw, updateSchema) as UpdateConversationInput
    return c.json(await runtime.update(id.data, input))
  })
  app.post('/api/conversations/:id/messages', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    const input = await readJson(c.req.raw, submitSchema) as SubmitInput
    return c.json(await runtime.submit(id.data, input), 202)
  })
  app.post('/api/conversations/:id/stop', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    await runtime.stop(id.data)
    return c.json({ ok: true })
  })
  app.post('/api/conversations/:id/interactions/:callId/answer', async c => {
    const id = pathId(c.req.param('id'))
    const callId = pathId(c.req.param('callId'))
    const input = await readJson(c.req.raw, interactionAnswerSchema)
    return c.json(await runtime.answerInteraction(id, callId, input.answers))
  })
  app.post('/api/conversations/:id/interactions/:callId/cancel', async c => {
    const id = pathId(c.req.param('id'))
    const callId = pathId(c.req.param('callId'))
    return c.json(await runtime.cancelInteraction(id, callId))
  })
  app.post('/api/conversations/:id/goal', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    const input = await readJson(c.req.raw, goalSchema)
    return c.json(await runtime.goal(id.data, input))
  })
  app.post('/api/conversations/:id/plan', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    const input = await readJson(c.req.raw, planSchema)
    return c.json(await runtime.setPlan(id.data, input.active))
  })
  app.get('/api/conversations/:id/team', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    return c.json({ team: await runtime.team(id.data) })
  })
  app.get('/api/conversations/:id/children', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    return c.json({ subagents: await runtime.children(id.data) })
  })
  app.post('/api/conversations/:id/children/:childId/messages', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    const childId = identifier.safeParse(c.req.param('childId'))
    if (!id.success || !childId.success) return c.json({ error: 'Conversation or subagent id is invalid', code: 'invalid_id' }, 400)
    const input = await readJson(c.req.raw, childMessageSchema)
    return c.json({ subagents: await runtime.childMessage(id.data, childId.data, input) }, 202)
  })
  app.post('/api/conversations/:id/children/:childId/stop', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    const childId = identifier.safeParse(c.req.param('childId'))
    if (!id.success || !childId.success) return c.json({ error: 'Conversation or subagent id is invalid', code: 'invalid_id' }, 400)
    return c.json({ subagents: await runtime.childStop(id.data, childId.data) })
  })
  app.post('/api/conversations/:id/compact', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    await runtime.compact(id.data)
    return c.json({ ok: true }, 202)
  })
  app.delete('/api/conversations/:id/queue/:submissionId', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    const submissionId = identifier.safeParse(c.req.param('submissionId'))
    if (!id.success || !submissionId.success) return c.json({ error: 'Conversation or submission id is invalid', code: 'invalid_id' }, 400)
    await runtime.removeQueued(id.data, submissionId.data)
    return c.json({ ok: true })
  })
  app.post('/api/conversations/:id/fork', async c => {
    const id = identifier.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Conversation id is invalid', code: 'invalid_id' }, 400)
    const input = await readJson(c.req.raw, z.object({ entryId: identifier }).strict())
    return c.json(await runtime.fork(id.data, input.entryId), 201)
  })
  app.get('/api/models', async c => c.json(await runtime.catalog()))
  app.post('/api/providers', async c => {
    const input = await readJson(c.req.raw, providerSchema) as ProviderInput
    await runtime.saveProvider(input)
    return c.json({ ok: true })
  })

  app.get('/api/capabilities', c => c.json(runtime.capabilities()))
  app.get('/api/settings', c => c.json(runtime.settings()))
  app.patch('/api/settings', async c => c.json(await runtime.updateSettings(await readJson(c.req.raw, settingsSchema))))
  app.post('/api/settings/open-config', async c => {
    await runtime.openConfigFile()
    return c.json({ ok: true })
  })
  app.get('/api/workspaces', c => c.json({ workspaces: runtime.workspaces() }))
  app.post('/api/workspaces', async c => c.json({ workspace: await runtime.addWorkspace(await readJson(c.req.raw, workspaceSchema)) }, 201))
  app.patch('/api/workspaces/:id', async c => c.json({ workspace: await runtime.renameWorkspace(pathId(c.req.param('id')), await readJson(c.req.raw, z.object({ name: z.string().trim().min(1).max(120) }).strict())) }))
  app.delete('/api/workspaces/:id', async c => { await runtime.deleteWorkspace(pathId(c.req.param('id'))); return c.json({ ok: true }) })
  app.post('/api/workspaces/pick', async c => c.json({ path: await runtime.pickDirectory(c.req.raw.signal) }))
  app.get('/api/directories', async c => c.json(await runtime.listDirectories(c.req.query('path'))))
  app.post('/api/directories', async c => {
    const input = await readJson(c.req.raw, z.object({ path: z.string().min(1).max(4096), name: z.string().trim().min(1).max(255) }).strict())
    await runtime.createDirectory(input.path, input.name)
    return c.json({ ok: true }, 201)
  })
  app.get('/api/workspaces/:id/files', async c => {
    const path = filePath(c.req.query('path'))
    return c.json({ path, entries: await runtime.workspaceFiles(pathId(c.req.param('id')), path) })
  })
  app.get('/api/workspaces/:id/search', async c => {
    const query = c.req.query('q') ?? ''
    if (query.length > 256) throw new ApiFault(400, 'invalid_query', 'Search query is too long')
    return c.json({ entries: await runtime.searchWorkspace(pathId(c.req.param('id')), query) })
  })
  app.get('/api/workspaces/:id/file', async c => c.json(await runtime.workspaceFile(pathId(c.req.param('id')), filePath(c.req.query('path')))))
  app.get('/api/workspaces/:id/asset', async c => {
    const path = filePath(c.req.query('path'))
    const asset = await runtime.workspaceAsset(pathId(c.req.param('id')), path)
    c.header('Content-Type', asset.mimeType)
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    if (asset.mimeType === 'text/html' || asset.mimeType === 'image/svg+xml') {
      c.header('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; form-action 'none'; base-uri 'none'")
    }
    if (c.req.query('download') === '1' || !['text/html', 'text/plain', 'application/pdf'].includes(asset.mimeType) && !asset.mimeType.startsWith('image/')) {
      c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())}`)
    }
    return c.body(new Uint8Array(asset.data).buffer)
  })
  app.get('/api/presets', c => c.json({ presets: runtime.presets() }))
  app.post('/api/presets', async c => c.json({ preset: await runtime.createPreset(await readJson(c.req.raw, presetSchema)) }, 201))
  app.patch('/api/presets/:id', async c => c.json({ preset: await runtime.updatePreset(pathId(c.req.param('id')), await readJson(c.req.raw, presetSchema.omit({ id: true }).partial().refine(value => Object.keys(value).length > 0))) }))
  app.delete('/api/presets/:id', async c => { await runtime.deletePreset(pathId(c.req.param('id'))); return c.json({ ok: true }) })
  app.get('/api/providers/:id', async c => c.json({ provider: await runtime.provider(pathId(c.req.param('id'))) }))
  app.delete('/api/providers/:id', async c => { await runtime.deleteProvider(pathId(c.req.param('id'))); return c.json({ ok: true }) })
  app.post('/api/providers/:id/test', async c => {
    const modelId = c.req.query('modelId')
    if (modelId && modelId.length > 256) throw new ApiFault(400, 'invalid_model', 'Model id is invalid')
    return c.json(await runtime.testProvider(pathId(c.req.param('id')), modelId))
  })
  app.post('/api/providers/:id/discover', async c => c.json(await runtime.discoverProvider(pathId(c.req.param('id')))))
  app.patch('/api/conversations/:id/queue/:submissionId', async c => c.json(await runtime.editQueued(pathId(c.req.param('id')), pathId(c.req.param('submissionId')), await readJson(c.req.raw, editQueueSchema)), 202))
  app.post('/api/conversations/:id/feedback', async c => {
    const input = await readJson(c.req.raw, z.object({ entryId: identifier, rating: z.enum(['up', 'down']).nullable() }).strict())
    await runtime.feedback(pathId(c.req.param('id')), input.entryId, input.rating)
    return c.json({ ok: true })
  })
  app.post('/api/feedback', async c => {
    const input = await readJson(c.req.raw, z.object({ text: z.string().trim().min(1).max(2_000) }).strict())
    const userAgent = c.req.header('user-agent')
    await runtime.sendFeedback({ text: input.text, ...(userAgent ? { userAgent } : {}) })
    return c.json({ ok: true })
  })
  app.post('/api/conversations/:id/retry', async c => {
    const input = await readJson(c.req.raw, z.object({ entryId: identifier, requestId: z.string().min(1).max(160) }).strict())
    return c.json(await runtime.retry(pathId(c.req.param('id')), input.entryId, input.requestId), 202)
  })
  app.get('/api/automations', c => c.json({ automations: runtime.automations() }))
  app.post('/api/automations', async c => c.json({ automation: await runtime.createAutomation(await readJson(c.req.raw, automationSchema)) }, 201))
  app.patch('/api/automations/:id', async c => c.json({ automation: await runtime.updateAutomation(pathId(c.req.param('id')), await readJson(c.req.raw, automationPatchSchema)) }))
  app.delete('/api/automations/:id', async c => { await runtime.deleteAutomation(pathId(c.req.param('id'))); return c.json({ ok: true }) })
  app.post('/api/automations/:id/run-now', async c => c.json(await runtime.runAutomation(pathId(c.req.param('id'))), 202))

  app.onError((error, c) => {
    const failure = publicFailure(error)
    return c.json({ error: failure.message, code: failure.code }, failure.status)
  })

  if (options.staticRoot) {
    const staticRoot = relative(process.cwd(), options.staticRoot) || '.'
    app.get('/assets/*', serveStatic({ root: staticRoot }))
    app.get('*', async (c, next) => {
      if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.json({ error: 'Not found', code: 'not_found' }, 404)
      return serveStatic({ root: staticRoot, path: 'index.html' })(c, next)
    })
  }

  app.notFound(c => c.json({ error: 'Not found', code: 'not_found' }, 404))

  return Object.assign(app, {
    async shutdown(): Promise<void> {
      shuttingDown = true
      shutdown.abort()
      await Promise.allSettled([...activeStreams])
    },
  })
}
