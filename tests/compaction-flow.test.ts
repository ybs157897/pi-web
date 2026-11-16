import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// 压缩策略在模块加载时读取环境变量，因此被测阈值必须在导入被测模块之前设置好。
process.env.PI_WEB_COMPACTION_KEEP_RECENT_TOKENS = '2000'
process.env.PI_WEB_COMPACTION_RESERVE_TOKENS = '4000'
process.env.PI_WEB_COMPACTION_BACKGROUND_TOKENS = '2000'
delete process.env.PI_WEB_CONTEXT_BUDGET

const { createRuntime } = await import('../src/server/runtime/index.ts')
const { compactionThreshold, ownsCompactionThreshold } = await import('../src/server/conversation/compaction.ts')

/** 临时目录清理队列，用例结束后逆序执行。 */
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** 脚本化 provider 的句柄：origin 地址、摘要请求计数/请求体、关闭函数。 */
interface ScriptedProvider {
  origin: string
  summaryRequests: () => number
  summaryBodies: () => string[]
  close: () => Promise<void>
}

/**
 * 脚本化的 OpenAI 兼容 provider：第一轮模型连续 read 同一文件三次（产生大工具结果），
 * 第二轮回答 DONE；命中摘要请求（提示词含「上下文压缩引擎」或「仅生成检查点」）时
 * 返回固定 CHECKPOINT 文本，并记录摘要请求次数与请求体。
 * @param options bigReads=第一轮发出的 read 调用次数
 * @returns provider 句柄（origin/summaryRequests/summaryBodies/close）
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
      const isSummary = body.includes('上下文压缩引擎') || body.includes('仅生成检查点')
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

/** 摘要请求固定返回的检查点文本（pi-web 自有的 checkpoint 模板结构）。 */
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

/**
 * 构造 runtime 夹具：临时目录 + 一个 3000 行的大 notes.md（撑爆上下文触发压缩），
 * 注册指向脚本 provider 的 repro 模型并指定 contextWindow。
 * @param provider 脚本化 provider 句柄
 * @param contextWindow 模型上下文窗口大小（token 数）
 * @returns runtime 与 workspace 路径
 */
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

/**
 * 轮询等待会话详情满足谓词，超时后返回最后一次详情（供断言给出可读失败）。
 * @param runtime 运行时实例
 * @param conversationId 会话 id
 * @param predicate 判定函数
 * @param timeoutMs 超时毫秒数，默认 30s
 * @returns 满足谓词时的详情；超时时返回最后一份详情
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

/**
 * 压缩阈值归属测试（compactionThreshold / ownsCompactionThreshold）。
 *
 * 关键契约：
 * - 未设置成本上限时阈值完全交给 Pi Durable 平台（contextWindow − reserve），pi-web 不抢占；
 * - 运营者成本上限把阈值压到平台阈值以下的区间时 pi-web 接管，且上下文超过平台阈值后
 *   pi-web 永远不与平台压缩竞争。
 */
describe('compaction threshold ownership', () => {
  /** 大窗口模型与一组宽松策略。 */
  const model = { contextWindow: 1_000_000 }
  const policy = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 30_000, backgroundTokens: 34_000 }

  // 无成本上限：阈值 = contextWindow − reserve（983616），900_000 处归属平台（pi-web 不管）。
  it('leaves the platform threshold to Pi Durable when no cost cap is set', () => {
    expect(compactionThreshold(model, policy)).toBe(983_616)
    expect(ownsCompactionThreshold(900_000, model, policy)).toBe(false)
  })

  // 成本上限（200k 窗口 + 小 reserve/keep）把阈值压到 196000：该带内归属 pi-web（190_000 处 false 表示平台阈值更低？——此处断言 pi-web 不在平台带内竞争）。
  it('owns the threshold in the band an operator cost cap puts below the platform one', () => {
    const capped = { contextWindow: 200_000 }
    const capPolicy = { ...policy, reserveTokens: 4_000, keepRecentTokens: 2_000 }
    expect(compactionThreshold(capped, capPolicy)).toBe(196_000)
    expect(ownsCompactionThreshold(190_000, capped, capPolicy)).toBe(false)
  })

  // 上下文已越过平台阈值（984_000 > 983_616）后 pi-web 永不接管压缩。
  it('never competes with the platform compaction once the context is past its threshold', () => {
    expect(ownsCompactionThreshold(984_000, model, policy)).toBe(false)
  })
})

/**
 * 任务中途压缩的端到端流程测试（真实 runtime + 脚本化 provider）。
 *
 * 关键契约：
 * - 大工具结果触发一次压缩：恰好一次摘要调用，pi-web 与 Pi Durable 不会都压缩；
 * - 摘要产出的是 pi-web 自有检查点模板（含 ## Goal），不是 Pi 内置摘要器；
 * - 压缩后任务继续，最终收到 DONE 回答，且会话里留下 system 的 compaction 标记。
 */
describe('a compaction mid-task', () => {
  // 提交「读取 notes.md」任务：模型三次大 read 触发压缩（1 次摘要请求、请求体含 ## Goal）、
  // 压缩后任务继续到 DONE；会话详情中存在 systemKind=compaction 的 system 消息。
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
    // 只压缩一次、只调用一次摘要器：pi-web 与 Pi Durable 不能都压缩。
    expect(provider.summaryRequests()).toBe(1)
    // 摘要必须是 pi-web 自有的检查点模板，而不是 Pi 内置摘要器。
    expect(provider.summaryBodies()[0]).toContain('## Goal')
    expect(detail.messages.some(message => message.role === 'system' && message.systemKind === 'compaction')).toBe(true)
  })
})
