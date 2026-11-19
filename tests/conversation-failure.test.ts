import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import { providerFailure } from '../src/server/conversation/failure.ts'
import { createRuntime } from '../src/server/runtime/index.ts'
import type { ConversationDetail } from '../src/shared/types.ts'
import type { WorkbenchView } from '../src/shared/workbench.ts'
import type { DecisionMailSummary } from '../src/shared/decision-inbox.ts'

const provider = 'failure-fixture'
const modelRef = (modelId: string) => ({ provider, modelId })
const privateText = 'fixture-only-private-provider-data'

async function fixture<T>(run: (input: {
  app: ReturnType<typeof createApp>; workspaceId: string; modelCalls: Map<string, number>
}) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-conversation-failure-'))
  const modelCalls = new Map<string, number>()
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
      const { model, messages } = JSON.parse(body) as { model: string; messages: Array<{ content: string }> }
      modelCalls.set(model, (modelCalls.get(model) ?? 0) + 1)
      if (model === 'limited' || model === 'denied') {
        const status = model === 'limited' ? 429 : 403
        response.writeHead(status, { 'content-type': 'application/json', 'retry-after-ms': '5' })
        response.end(JSON.stringify({ error: {
          code: status === 429 ? 'rate_limit_exceeded' : 'permission_denied',
          message: `upstream private body: ${privateText}`,
        } }))
        return
      }
      const isPlanner = messages.some(message => message.content?.includes('pi-web Agent 工作台的主 Agent'))
      const answer = isPlanner ? JSON.stringify({ tasks: [{
        title: '核对项目说明', objective: '读取项目说明并在同一任务交付', constraints: [], acceptance: ['回复可核对的结果'],
        type: 'investigate', assignee: 'time', dependsOn: [], previous: [],
      }] }) : 'WORKBENCH_RECOVERED'
      const event = (choice: Record<string, unknown>) => `data: ${JSON.stringify({
        id: 'chat_failure_fixture', object: 'chat.completion.chunk', created: 1, model, choices: [choice],
      })}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        event({ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }),
        event({ index: 0, delta: {}, finish_reason: 'stop' }), 'data: [DONE]\n\n',
      ].join(''))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let app: ReturnType<typeof createApp> | undefined
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture did not bind an HTTP port')
    const piDir = join(root, 'pi')
    const workspace = join(root, 'workspace')
    await Promise.all([mkdir(piDir), mkdir(workspace)])
    await writeFile(join(piDir, 'settings.json'), '{}')
    await writeFile(join(piDir, 'models.json'), JSON.stringify({ providers: {
      [provider]: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'fixture-key',
        models: ['limited', 'denied', 'healthy'].map(id => ({ id, name: id, contextWindow: 200_000 })),
      },
    } }))
    runtime = await createRuntime({ dataDir: join(root, 'data'), workspace, piDir, mcpConfigPath: join(root, 'mcp.json') })
    await runtime.updateSettings({ defaultModel: modelRef('healthy') })
    app = createApp(runtime)
    return await run({ app, workspaceId: runtime.workspaces()[0]!.id, modelCalls })
  } finally {
    await app?.shutdown()
    await runtime?.close()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await rm(root, { recursive: true, force: true })
  }
}

const json = (method: 'POST' | 'PATCH', value: object): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
})

async function eventually<T>(fetch: () => Promise<T>, passes: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  let result = await fetch()
  while (!passes(result) && Date.now() < deadline) {
    await delay(50)
    result = await fetch()
  }
  expect(passes(result), JSON.stringify(result)).toBe(true)
  return result
}

describe('conversation failure mapping', () => {
  it.each([
    [{ status: 401, message: privateText }, 'MODEL_AUTH_FAILED', false],
    ['429: {"error":{"code":"insufficient_quota"}}', 'MODEL_QUOTA_EXCEEDED', false],
    ['HTTP 504: request failed', 'MODEL_TIMEOUT', true],
    [new Error('fetch failed', { cause: Object.assign(new Error(privateText), { code: 'ECONNREFUSED' }) }), 'MODEL_CONNECTION_FAILED', false],
    ['400: maximum context length exceeded', 'MODEL_CONTEXT_LIMIT', false],
    ['Provider is not configured: hidden-provider', 'MODEL_AUTH_FAILED', false],
    ['Unknown provider: hidden-provider', 'MODEL_UNAVAILABLE', false],
    ['unclassified upstream failure', 'MODEL_PROVIDER_FAILED', true],
  ] as const)('classifies a structured or legacy provider error without exposing its body', (input, code, retryable) => {
    expect(providerFailure(input)).toMatchObject({ code, retryable })
    expect(JSON.stringify(providerFailure(input))).not.toContain(privateText)
  })

  it('projects 429 backoff and terminal failure over SSE, then retries with the newly selected model', async () => {
    await fixture(async ({ app, modelCalls }) => {
      const created = await app.request('/api/conversations', json('POST', {
        title: 'Rate limit fixture', model: modelRef('limited'),
      }))
      expect(created.status).toBe(201)
      const { conversation: { id } } = await created.json() as ConversationDetail
      const url = `/api/conversations/${id}`
      const stop = new AbortController()
      const stream = await app.request(url + '/events', { signal: stop.signal })
      const reader = stream.body!.getReader()
      try {
        const submitted = await app.request(url + '/messages', json('POST', { text: '请核对测试说明。', requestId: 'rate-limit-input' }))
        expect(submitted.status).toBe(202)
        let retries = 0
        let terminal: ConversationDetail | undefined
        let buffer = ''
        const decoder = new TextDecoder()
        const timeout = setTimeout(() => stop.abort(), 27_000)
        try {
          while (!terminal) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            const frames = buffer.split('\n\n')
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              const line = frame.split('\n').find(value => value.startsWith('data: '))
              if (!line) continue
              const detail = JSON.parse(line.slice(6)) as ConversationDetail
              expect(JSON.stringify(detail)).not.toContain(privateText)
              if (detail.retry) {
                expect(detail.retry.failure.code).toBe('MODEL_RATE_LIMITED')
                expect(detail.conversation.busy).toBe(true)
                expect(detail.failure).toBeUndefined()
                retries += 1
              }
              if (detail.failure && !detail.conversation.busy) terminal = detail
            }
          }
        } finally { clearTimeout(timeout) }
        expect(retries).toBeGreaterThan(0)
        expect(modelCalls.get('limited')).toBeGreaterThanOrEqual(4)
        expect(terminal?.failure).toMatchObject({ code: 'MODEL_RATE_LIMITED', retryable: true, providerStatus: 429, retryAttempts: 3 })
        expect(terminal?.failure?.message).toContain('重试后仍被限流')
        const trajectory = await (await app.request(url + '/trajectory')).text()
        expect(trajectory).toContain('MODEL_RATE_LIMITED')
        expect(trajectory).not.toContain(privateText)
        const entryId = terminal?.messages.find(message => message.requestId === 'rate-limit-input')?.entryId
        expect(entryId).toBeDefined()
        expect((await app.request(url, json('PATCH', { model: modelRef('healthy') }))).status).toBe(200)
        const response = await app.request(url + '/retry', json('POST', { entryId, requestId: 'recover-conversation' }))
        expect(response.status).toBe(202)
        const { conversationId } = await response.json() as { conversationId: string }
        const restored = await eventually(async () => (await app.request(`/api/conversations/${conversationId}`)).json() as Promise<ConversationDetail>,
          detail => !detail.conversation.busy && JSON.stringify(detail.messages).includes('WORKBENCH_RECOVERED'))
        expect(restored.conversation.model).toEqual(modelRef('healthy'))
        expect(restored.failure).toBeUndefined()
      } finally {
        stop.abort()
        await reader.cancel()
      }
    })
  }, 36_000)

  it('keeps the lead request and worker seat while repairing a failed model, even with concurrent retry clicks', async () => {
    await fixture(async ({ app, workspaceId, modelCalls }) => {
      const base = `/api/workbench/${workspaceId}`
      const view = async () => (await app.request(base)).json() as Promise<WorkbenchView>
      const retry = (input: object) => app.request(base + '/retry', json('POST', input))
      expect((await app.request(base + '/bots/time', json('PATCH', { model: modelRef('denied') }))).status).toBe(200)
      const unknown = await app.request(base + '/messages', json('POST', {
        text: '确认模型。', requestId: 'unknown-model', model: modelRef('unknown'),
      }))
      expect(unknown.status).toBe(422)
      expect(await unknown.json()).toMatchObject({ code: 'MODEL_UNAVAILABLE', failure: { action: 'check_model', retryable: false } })
      const admission = await app.request(base + '/messages', json('POST', {
        text: '核对项目说明。', requestId: 'repair-dispatch', model: modelRef('limited'), mention: 'time',
      }))
      expect(admission.status).toBe(202)
      const failed = await eventually(view, snapshot => snapshot.messages[0]?.failure !== undefined)
      expect(failed.messages[0]?.failure).toMatchObject({ code: 'MODEL_RATE_LIMITED', providerStatus: 429, retryable: true, retryAttempts: 2 })
      expect(failed.items).toHaveLength(0)
      const trajectory = await (await app.request(`/api/conversations/${failed.main.conversation.id}/trajectory`)).text()
      expect(trajectory).toContain('MODEL_RATE_LIMITED')
      expect(trajectory).not.toContain(privateText)
      expect(modelCalls.get('limited')).toBeGreaterThanOrEqual(3)
      const dispatch = { requestId: 'repair-dispatch', attempt: 1, model: modelRef('healthy') }
      const dispatches = await Promise.all([retry(dispatch), retry(dispatch)])
      expect(dispatches.map(it => it.status).sort()).toEqual([202, 409])
      const worker = await eventually(view, snapshot => snapshot.items[0]?.failure !== undefined)
      expect(worker.messages).toHaveLength(1)
      expect(worker.messages[0]).not.toHaveProperty('failure')
      const item = worker.items[0]!
      expect(item.failure).toMatchObject({ code: 'MODEL_AUTH_FAILED', providerStatus: 403, retryable: false })
      expect(item.status).toBe('needs_human')
      const inbox = await (await app.request(base + '/inbox')).json() as { mails: DecisionMailSummary[] }
      const mail = await (await app.request(base + '/inbox/' + inbox.mails.find(row => row.kind === 'exception')!.id)).json()
      expect(mail).toMatchObject({ failure: { code: 'MODEL_AUTH_FAILED' } })
      expect(JSON.stringify(mail)).not.toContain(privateText)
      const input = { itemId: item.id, attempt: item.attempt, model: modelRef('healthy') }
      const deliveries = await Promise.all([retry(input), retry(input)])
      expect(deliveries.map(it => it.status).sort()).toEqual([202, 409])
      const recovered = await eventually(view, snapshot => snapshot.items[0]?.status === 'pending_review')
      expect(recovered.items).toHaveLength(1)
      expect(recovered.items[0]).toMatchObject({ childId: item.childId, attempt: item.attempt + 1 })
      expect(recovered.items[0]).not.toHaveProperty('failure')
      const child = await (await app.request(`/api/conversations/${item.childId}`)).json() as ConversationDetail
      expect(child.conversation.model).toEqual(modelRef('healthy'))
      expect(child.messages.filter(message => message.role === 'user')).toHaveLength(2)
      expect(JSON.stringify(child)).not.toContain(privateText)
    })
  }, 30_000)
})
