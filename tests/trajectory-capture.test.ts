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
 * 构造脚本化的 OpenAI 兼容 provider（本地 HTTP 服务）。
 * 第一轮返回对 notes.md 的 read 工具调用，第二轮返回 DONE。
 * 所有请求体被记录，供测试对照「模型实际收到什么」与「轨迹导出了什么」。
 * @returns origin 服务地址、requests 已收到的请求体列表、close 关闭服务
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

/**
 * 构造完整 runtime fixture：临时数据目录 + workspace + 指向脚手架 provider 的
 * models.json，预置 notes.md 与空 settings。
 * @param provider 提供 baseUrl 的脚本化 provider
 * @returns runtime 与数据目录；清理已登记进 cleanups
 */
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

/**
 * 轮询会话详情直到谓词成立。
 * @returns 满足谓词的详情；超时后返回最后一次详情（供断言失败信息）
 */
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

/** 轨迹 JSONL 的一行：type + 时间戳 + 各类型自有字段。 */
interface TrajectoryLine {
  type: string
  ts: number | null
  [key: string]: unknown
}

/**
 * 解析轨迹 JSONL 文本为行对象数组。
 * @param text 完整 JSONL 文本
 * @returns 非空行逐行 JSON.parse 的结果
 */
function parseTrajectory(text: string): TrajectoryLine[] {
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as TrajectoryLine)
}

describe('trajectory capture and export', () => {
  // 主链路：一次带工具轮的完整会话导出为单一时间序 JSONL，行类型覆盖
  // entry/task/request/response/tools/catalog；request 是每消息轮廓（默认模式），
  // capture 文件体积远小于 provider 原始字节；sidecall（会话标题）落同一文件。
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

    // 捕获的 request 行是逐消息轮廓（默认模式）：消息数一致，最新用户文本落在
    // 尾部 preview 窗口，system 段以 sections 命名。
    const requests = lines.filter(line => line.type === 'request')
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests.every(line => Array.isArray(line.messages) && line.messages.length === line.messageCount)).toBe(true)
    const firstRequest = requests[0] as unknown as {
      messages: Array<{ role: string; sections?: string[]; content: { kind: string; preview?: string } }>
      model?: unknown
    }
    expect(JSON.stringify(firstRequest.messages)).toContain(submitted)
    expect(firstRequest.model).toEqual({ provider: 'repro', modelId: 'repro-model' })
    expect(firstRequest.messages[0]).toMatchObject({ role: 'system' })
    expect(Array.isArray(firstRequest.messages[0]?.sections)).toBe(true)
    // 更早的消息只保留轮廓形状：尾部窗口之外不出现 preview 键。
    const headPreviews = firstRequest.messages.slice(0, -3).filter(message => 'preview' in message.content)
    expect(headPreviews).toHaveLength(0)
    // 工具轮的 request 轮廓里保留 toolResult 角色。
    const toolRound = requests[1] as unknown as { messages: Array<{ role: string; content: { kind: string; blocks?: Array<{ type: string }> } }> }
    expect(toolRound.messages.some(message => message.role === 'toolResult')).toBe(true)
    // 载荷大时轮廓也要小：capture 的 request 行体积必须远小于 provider 原始字节。
    const captureText = await readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${conversationId}.jsonl`), 'utf8')
    const outlineLine = parseTrajectory(captureText).filter(line => line.type === 'request').length
    expect(outlineLine).toBeGreaterThanOrEqual(2)
    expect(captureText.length).toBeLessThan(provider.requests().join('').length * 4)

    // catalog 很少变化：两次请求只落一行，列出当时可用的工具。
    const catalogs = lines.filter(line => line.type === 'catalog') as unknown as Array<{
      model: { provider: string; modelId: string }
      hash: string
      tools: Array<{ name: string }>
    }>
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.model).toEqual({ provider: 'repro', modelId: 'repro-model' })
    expect(catalogs[0]!.tools.map(tool => tool.name)).toContain('read')

    // afterResponse 对每次终止的 provider 尝试都触发（含工具调用轮），
    // 且每条最终消息都带测得的 TTFT（首 token 耗时）。
    const responses = lines.filter(line => line.type === 'response') as unknown as Array<{ message: { role: string; stopReason?: string; ttftMs?: number } }>
    expect(responses.length).toBe(requests.length)
    expect(responses.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop' })
    for (const response of responses) expect(typeof response.message.ttftMs).toBe('number')
    const tools = lines.find(line => line.type === 'tools') as unknown as { assistant: unknown; results: unknown[] }
    expect(Array.isArray(tools.results)).toBe(true)
    expect(tools.results.length).toBe(1)

    // 时间序：除首行外所有带时间戳的行单调不减。
    const stamps = lines.slice(1).map(line => line.ts ?? 0)
    expect(stamps).toEqual([...stamps].sort((left, right) => left - right))

    // 旁路模型调用（会话标题）结算后以 sidecall 行落进同一文件；
    // 脚本化 provider 对它们照常应答。
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

    // 原始 capture 文件位于数据库旁，每会话一份。
    const captureFile = await readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${conversationId}.jsonl`), 'utf8')
    expect(captureFile.split('\n').filter(line => line.trim() !== '').length).toBeGreaterThanOrEqual(requests.length + 2)
    // 旁路调用（会话标题、压缩摘要）不经过生成任务的钩子，
    // 因此 provider 收到的请求数可能多于 capture 记录数。
    expect(provider.requests().length).toBeGreaterThanOrEqual(requests.length)
  })

  // 开关关闭（PI_WEB_TRAJECTORY=0）：持久导出仍工作（entry/task 照常），
  // 但不产 request/response 行，也不创建 capture 文件。
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
    // 未创建 capture 文件。
    await expect(readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${created.conversation.id}.jsonl`), 'utf8')).rejects.toThrow()
  })

  // 全量模式（PI_WEB_TRAJECTORY_FULL_REQUEST=1）：request 行保留原样载荷
  // （字符串或数组 content），capture 里不再出现轮廓包装（"kind":"blocks"）。
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
    // 全量模式保留原样载荷：纯字符串 content，无轮廓包装。
    expect(JSON.stringify(firstRequest.messages)).toContain(submitted)
    expect(firstRequest.messages.some(message => typeof message.content === 'string' || Array.isArray(message.content))).toBe(true)
    const captureText = await readFile(join(dataDir, TRAJECTORY_CAPTURE_DIR, `${created.conversation.id}.jsonl`), 'utf8')
    expect(captureText).not.toContain('"kind":"blocks"')
  })
})
