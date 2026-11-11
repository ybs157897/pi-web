import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { createRuntime } = await import('../src/server/runtime/index.ts')
const { TRAJECTORY_CAPTURE_DIR } = await import('../src/server/conversation/trajectory.ts')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  delete process.env.PI_WEB_TRAJECTORY
  delete process.env.PI_WEB_TRAJECTORY_FULL_REQUEST
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A scripted OpenAI-compatible provider: the first turn calls `read` on notes.md,
 * the next one answers DONE. Requests are recorded so the test can compare what
 * the model received against what the trajectory exported.
 */
async function scriptedProvider(): Promise<{ origin: string; requests: () => string[]; close: () => Promise<void> }> {
  const requests: string[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push(body)
      const assistantTurns = ((JSON.parse(body) as { messages?: Array<{ role: string }> }).messages ?? [])
        .filter(message => message.role === 'assistant').length
      const event = (choice: Record<string, unknown>) => `data: ${JSON.stringify({
        id: 'chat_traj', object: 'chat.completion.chunk', created: 1, model: 'repro-model', choices: [choice],
      })}\n\n`
      const chunks: string[] = []
      if (assistantTurns === 0) {
        chunks.push(event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }))
        chunks.push(event({
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_read_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'notes.md' }) } }] },
          finish_reason: null,
        }))
        chunks.push(event({ index: 0, delta: {}, finish_reason: 'tool_calls' }))
      } else {
        chunks.push(event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }))
        chunks.push(event({ index: 0, delta: { content: 'DONE' }, finish_reason: null }))
        chunks.push(event({ index: 0, delta: {}, finish_reason: 'stop' }))
      }
      chunks.push('data: [DONE]\n\n')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(chunks.join(''))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind a TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

async function fixture(provider: { origin: string }) {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-trajectory-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(workspace, 'notes.md'), 'alpha trajectory notes\n')
  await writeFile(join(piDir, 'settings.json'), JSON.stringify({}))
  await writeFile(join(piDir, 'models.json'), JSON.stringify({
    providers: {
      'repro': {
        name: 'Repro provider', baseUrl: `${provider.origin}/v1`, api: 'openai-completions', apiKey: 'test-key',
        models: [{ id: 'repro-model', name: 'Repro model', contextWindow: 200_000 }],
      },
    },
  }))
  const runtime = await createRuntime({ dataDir, workspace, piDir })
  cleanups.push(async () => { await runtime.close() })
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  return { runtime, dataDir }
}

async function waitForMessage(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  conversationId: string,
  predicate: (detail: Awaited<ReturnType<typeof runtime.detail>>) => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = await runtime.detail(conversationId)
    if (predicate(detail)) return detail
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return await runtime.detail(conversationId)
}

interface TrajectoryLine {
  type: string
  ts: number | null
  [key: string]: unknown
}

function parseTrajectory(text: string): TrajectoryLine[] {
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as TrajectoryLine)
}

describe('trajectory capture and export', () => {
  it('exports entries, tasks and captured requests as one chronological JSONL', async () => {
    const provider = await scriptedProvider()
    cleanups.push(() => provider.close())
    const { runtime, dataDir } = await fixture(provider)
    const created = await runtime.create({ title: 'Traj', model: { provider: 'repro', modelId: 'repro-model' } })
    const conversationId = created.conversation.id
    const submitted = '请读取 notes.md 并给出要点。'
    await runtime.submit(conversationId, { text: submitted, requestId: 'traj-1' })
    await waitForMessage(runtime, conversationId, value => value.messages
      .some(message => message.role === 'assistant'
        && message.blocks.some(block => block.type === 'text' && block.text.includes('DONE'))))

    const text = await runtime.trajectory(conversationId)
    expect(text.endsWith('\n')).toBe(true)
    const lines = parseTrajectory(text)
    expect(lines[0]).toMatchObject({ type: 'conversation', id: conversationId })

    const types = new Set(lines.map(line => line.type))
    for (const expected of ['entry', 'task', 'request', 'response', 'tools']) {
      expect(types.has(expected), `missing ${expected} line`).toBe(true)
    }
    expect(lines.some(line => line.type === 'entry' && (line.record as { kind?: string })?.kind === 'pi.assistant')).toBe(true)
    expect(lines.some(line => line.type === 'task' && line.kind === 'pi.generation' && typeof line.startedAt === 'number')).toBe(true)

    // The captured request line is a per-message outline (default mode): same message count,
    // with the newest user text in the trailing preview and the system sections named.
    const requests = lines.filter(line => line.type === 'request')
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests.every(line => Array.isArray(line.messages) && line.messages.length === line.messageCount)).toBe(true)
    const firstRequest = requests[0] as unknown as {
      messages: Array<{ role: string; sections?: string[]; sectionChars?: Record<string, number>; systemChars?: number; content: { kind: string; preview?: string } }>
      model?: unknown
      request: number
      task: string
    }
    expect(JSON.stringify(firstRequest.messages)).toContain(submitted)
    expect(firstRequest.model).toEqual({ provider: 'repro', modelId: 'repro-model' })
    expect(firstRequest.messages[0]).toMatchObject({ role: 'system' })
    expect(Array.isArray(firstRequest.messages[0]?.sections)).toBe(true)
    // The system outline carries the real prompt size: per-section chars and a total,
    // even though the system message's own content is empty.
    const systemOutline = firstRequest.messages[0]!
    expect(typeof systemOutline.systemChars).toBe('number')
    expect(systemOutline.systemChars!).toBeGreaterThan(0)
    expect(systemOutline.sectionChars).toBeTypeOf('object')
    expect(Object.values(systemOutline.sectionChars!).reduce((sum, n) => sum + n, 0)).toBe(systemOutline.systemChars)
    // Older messages outline shape only: no preview key outside the trailing window.
    const headPreviews = firstRequest.messages.slice(0, -3).filter(message => 'preview' in message.content)
    expect(headPreviews).toHaveLength(0)
    // The tool round's request carries the tool result role in the outline.
    const toolRound = requests[1] as unknown as { messages: Array<{ role: string; content: { kind: string; blocks?: Array<{ type: string }> } }> }
    expect(toolRound.messages.some(message => message.role === 'toolResult')).toBe(true)
    // Request numbers increase monotonically within the conversation even though each
    // provider request is its own generation task (the old per-task reset kept them at 1).
    const numbered = requests as unknown as Array<{ request: number }>
    expect(numbered[0]!.request).toBe(1)
    expect(numbered[1]!.request).toBe(2)
    for (let index = 1; index < numbered.length; index += 1) {
      expect(numbered[index]!.request).toBe(numbered[index - 1]!.request + 1)
    }
    // The outline must stay small even when the payload is not: assert the capture keeps
    // request lines well under the verbatim provider body for this fixture.
    const captureText = await readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${conversationId}.jsonl`), 'utf8')
    const outlineLine = parseTrajectory(captureText).filter(line => line.type === 'request').length
    expect(outlineLine).toBeGreaterThanOrEqual(2)
    expect(captureText.length).toBeLessThan(provider.requests().join('').length * 4)

    // The catalog changes rarely: exactly one line despite two requests, naming the offered tools.
    const catalogs = lines.filter(line => line.type === 'catalog') as unknown as Array<{
      model: { provider: string; modelId: string }
      hash: string
      tools: Array<{ name: string }>
    }>
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.model).toEqual({ provider: 'repro', modelId: 'repro-model' })
    expect(catalogs[0]!.tools.map(tool => tool.name)).toContain('read')

    // afterResponse fires for every terminal provider attempt, including the tool-call one,
    // and each final message carries the measured time to first token.
    const responses = lines.filter(line => line.type === 'response') as unknown as Array<{ message: { role: string; stopReason?: string; ttftMs?: number } }>
    expect(responses.length).toBe(requests.length)
    expect(responses.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop' })
    for (const response of responses) expect(typeof response.message.ttftMs).toBe('number')
    const tools = lines.find(line => line.type === 'tools') as unknown as { assistant: unknown; results: unknown[] }
    expect(Array.isArray(tools.results)).toBe(true)
    expect(tools.results.length).toBe(1)

    // Chronological: every stamped line is non-decreasing in time.
    const stamps = lines.slice(1).map(line => line.ts ?? 0)
    expect(stamps).toEqual([...stamps].sort((left, right) => left - right))

    // Side-channel model calls (session title) land in the same file as `sidecall` lines
    // once they settle; the scripted provider answers them like any other request.
    const deadline = Date.now() + 15_000
    let sidecalls: TrajectoryLine[] = []
    while (Date.now() < deadline) {
      sidecalls = parseTrajectory(await runtime.trajectory(conversationId)).filter(line => line.type === 'sidecall')
      if (sidecalls.length > 0) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const sidecall = sidecalls[0] as unknown as { purpose: string; answer: { role: string } }
    expect(sidecall.purpose).toBe('session-title')
    expect(sidecall.answer.role).toBe('assistant')

    // The raw capture file sits next to the database, one per conversation.
    const captureFile = await readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${conversationId}.jsonl`), 'utf8')
    expect(captureFile.split('\n').filter(line => line.trim() !== '').length).toBeGreaterThanOrEqual(requests.length + 2)
    // Side-channel model calls (session title, compaction summary) bypass the generation
    // task's hooks, so the provider may have seen more requests than the capture did.
    expect(provider.requests().length).toBeGreaterThanOrEqual(requests.length)
  })

  it('keeps the durable export working when capture is disabled', async () => {
    process.env.PI_WEB_TRAJECTORY = '0'
    const provider = await scriptedProvider()
    cleanups.push(() => provider.close())
    const { runtime, dataDir } = await fixture(provider)
    const created = await runtime.create({ title: 'Traj off', model: { provider: 'repro', modelId: 'repro-model' } })
    await runtime.submit(created.conversation.id, { text: '请读取 notes.md 并给出要点。', requestId: 'traj-2' })
    await waitForMessage(runtime, created.conversation.id, value => value.messages
      .some(message => message.role === 'assistant'
        && message.blocks.some(block => block.type === 'text' && block.text.includes('DONE'))))

    const lines = parseTrajectory(await runtime.trajectory(created.conversation.id))
    const types = new Set(lines.map(line => line.type))
    expect(types.has('request')).toBe(false)
    expect(types.has('response')).toBe(false)
    expect(types.has('entry')).toBe(true)
    expect(types.has('task')).toBe(true)
    // No capture file was created.
    await expect(readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${created.conversation.id}.jsonl`), 'utf8')).rejects.toThrow()
  })

  it('records verbatim payloads when PI_WEB_TRAJECTORY_FULL_REQUEST=1', async () => {
    process.env.PI_WEB_TRAJECTORY_FULL_REQUEST = '1'
    const provider = await scriptedProvider()
    cleanups.push(() => provider.close())
    const { runtime, dataDir } = await fixture(provider)
    const created = await runtime.create({ title: 'Traj full', model: { provider: 'repro', modelId: 'repro-model' } })
    const submitted = '请读取 notes.md 并给出要点。'
    await runtime.submit(created.conversation.id, { text: submitted, requestId: 'traj-3' })
    await waitForMessage(runtime, created.conversation.id, value => value.messages
      .some(message => message.role === 'assistant'
        && message.blocks.some(block => block.type === 'text' && block.text.includes('DONE'))))

    const lines = parseTrajectory(await runtime.trajectory(created.conversation.id))
    const firstRequest = lines.find(line => line.type === 'request') as unknown as {
      messages: Array<{ role: string; content: unknown }>
    }
    // Full mode keeps the verbatim payload: plain string content, no outline wrapper.
    expect(JSON.stringify(firstRequest.messages)).toContain(submitted)
    expect(firstRequest.messages.some(message => typeof message.content === 'string' || Array.isArray(message.content))).toBe(true)
    const captureText = await readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${created.conversation.id}.jsonl`), 'utf8')
    expect(captureText).not.toContain('"kind":"blocks"')
  })
})
