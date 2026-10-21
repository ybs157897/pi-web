import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The compaction policy is read from the environment when the module loads, so the
// thresholds under test are set before it is imported.
process.env.PI_WEB_COMPACTION_KEEP_RECENT_TOKENS = '2000'
process.env.PI_WEB_COMPACTION_RESERVE_TOKENS = '4000'
process.env.PI_WEB_COMPACTION_BACKGROUND_TOKENS = '2000'
delete process.env.PI_WEB_CONTEXT_BUDGET

const { createRuntime } = await import('../src/server/runtime.ts')
const { compactionThreshold, ownsCompactionThreshold } = await import('../src/server/compaction.ts')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface ScriptedProvider {
  origin: string
  summaryRequests: () => number
  summaryBodies: () => string[]
  close: () => Promise<void>
}

/**
 * A scripted OpenAI-compatible provider: the first turn reads a file three times
 * (a big tool result), the second turn reports what the model can still see.
 */
async function scriptedProvider(options: { bigReads?: number } = {}): Promise<ScriptedProvider> {
  const bigReads = options.bigReads ?? 3
  let summaries = 0
  const bodies: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages?: Array<{ role: string }> }
      const messages = payload.messages ?? []
      const assistantTurns = messages.filter(message => message.role === 'assistant').length
      const isSummary = body.includes('context compaction engine') || body.includes('Produce a checkpoint')
      const chunks: string[] = []
      const event = (choice: Record<string, unknown>) => `data: ${JSON.stringify({
        id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'repro-model', choices: [choice],
      })}\n\n`
      if (isSummary) {
        summaries += 1
        bodies.push(body)
        chunks.push(event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }))
        chunks.push(event({ index: 0, delta: { content: CHECKPOINT }, finish_reason: null }))
        chunks.push(event({ index: 0, delta: {}, finish_reason: 'stop' }))
      } else if (assistantTurns === 0) {
        chunks.push(event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }))
        for (let read = 0; read < bigReads; read++) {
          chunks.push(event({
            index: 0,
            delta: { tool_calls: [{ index: read, id: `call_read_${read}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'notes.md' }) } }] },
            finish_reason: null,
          }))
        }
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
    summaryRequests: () => summaries,
    summaryBodies: () => bodies,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

const CHECKPOINT = `## Goal
Read the notes file and report its key points.

## Constraints & Preferences
- Answer in Chinese.

## Progress
### Done
- [x] Listed the workspace files

### In Progress
- [ ] Reading the notes file

### Blocked
- (none)

## Key Decisions
- **Read the file first**: the checkpoint carries the file forward

## Next Steps
1. Report the key points of notes.md

## Critical Context
- The file is notes.md`

async function fixture(provider: ScriptedProvider, contextWindow: number) {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-compaction-flow-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(workspace, 'notes.md'), Array.from({ length: 3000 }, (_, index) => `${index}: ${'care 安保 设计计划 协议 接口 文档 服务 网关 队列 对接 '.repeat(4)}`).join('\n'))
  await writeFile(join(piDir, 'settings.json'), JSON.stringify({}))
  await writeFile(join(piDir, 'models.json'), JSON.stringify({
    providers: {
      'repro': {
        name: 'Repro provider', baseUrl: `${provider.origin}/v1`, api: 'openai-completions', apiKey: 'test-key',
        models: [{ id: 'repro-model', name: 'Repro model', contextWindow }],
      },
    },
  }))
  const runtime = await createRuntime({ dataDir, workspace, piDir })
  cleanups.push(async () => { await runtime.close() })
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  return { runtime, workspace }
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

describe('compaction threshold ownership', () => {
  const model = { contextWindow: 1_000_000 }
  const policy = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 30_000, backgroundTokens: 34_000 }

  it('leaves the platform threshold to Pi Durable when no cost cap is set', () => {
    expect(compactionThreshold(model, policy)).toBe(983_616)
    expect(ownsCompactionThreshold(900_000, model, policy)).toBe(false)
  })

  it('owns the threshold in the band an operator cost cap puts below the platform one', () => {
    const capped = { contextWindow: 200_000 }
    const capPolicy = { ...policy, reserveTokens: 4_000, keepRecentTokens: 2_000 }
    expect(compactionThreshold(capped, capPolicy)).toBe(196_000)
    expect(ownsCompactionThreshold(190_000, capped, capPolicy)).toBe(false)
  })

  it('never competes with the platform compaction once the context is past its threshold', () => {
    expect(ownsCompactionThreshold(984_000, model, policy)).toBe(false)
  })
})

describe('a compaction mid-task', () => {
  it('summarizes once, keeps pi-web\'s checkpoint, and lets the task continue', async () => {
    const provider = await scriptedProvider()
    cleanups.push(() => provider.close())
    const { runtime } = await fixture(provider, 20_000)
    const created = await runtime.create({ title: 'Flow', model: { provider: 'repro', modelId: 'repro-model' } })
    await runtime.submit(created.conversation.id, { text: '请读取 notes.md 并给出要点。', requestId: 'flow-1' })

    const detail = await waitForMessage(runtime, created.conversation.id, value => value.messages
      .some(message => message.role === 'assistant'
        && message.blocks.some(block => block.type === 'text' && block.text.includes('DONE'))))
    const finished = detail.messages.some(message => message.role === 'assistant'
      && message.blocks.some(block => block.type === 'text' && block.text.includes('DONE')))
    expect(finished).toBe(true)
    // One compaction, one summarizer call: pi-web and Pi Durable must not both compact.
    expect(provider.summaryRequests()).toBe(1)
    // The summary is pi-web's own checkpoint template, not Pi's built-in summarizer.
    expect(provider.summaryBodies()[0]).toContain('## Goal')
    expect(detail.messages.some(message => message.role === 'system' && message.systemKind === 'compaction')).toBe(true)
  })
})
