import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime/index.ts'
import { observeDemoRequests } from '../src/server/model/demo.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { Message } from '@earendil-works/pi-ai'

/** 临时目录清理队列：用例结束后逆序执行（先停止观察器/关闭 runtime，再删目录）。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 构造真实 runtime 夹具：临时 dataDir/workspace/piDir、demo 模型，并观察所有 demo 请求
 * （记录 system 分段、工具名、消息快照），提供记忆根路径与提取请求过滤入口。
 * @returns 夹具对象（runtime、requests、memoryRoot、extractionRequests 等）
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-runtime-'))
  const options = { dataDir: join(root, 'data'), workspace: join(root, 'workspace'), piDir: join(root, 'pi'), demo: true }
  await mkdir(options.workspace, { recursive: true })
  await mkdir(options.piDir, { recursive: true })
  await writeFile(join(options.piDir, 'settings.json'), '{}')
  const runtime = await createRuntime(options)
  /** 每条 demo 请求的观察快照：system 分段拼接、工具名列表与消息深拷贝。 */
  const requests: Array<{ system: string; tools: string[]; messages: readonly Message[] }> = []
  const unobserve = observeDemoRequests((request) => {
    const messages = normalizeContext(request).messages
    requests.push({
      system: messages
        .filter(message => message.role === 'system')
        .flatMap((message) => {
          const sections = (message as { sections?: Record<string, string> }).sections
          return [
            typeof message.content === 'string' ? message.content : '',
            ...Object.values(sections ?? {}),
          ]
        })
        .join('\n'),
      tools: getCurrentTools(messages).map(tool => tool.name),
      messages: structuredClone(messages),
    })
  })
  cleanups.push(async () => { unobserve(); await runtime.close(); await rm(root, { recursive: true, force: true }) })
  return {
    root,
    options,
    runtime,
    requests,
    /** 解析真实（经 realpath）workspace 对应的记忆根目录。 */
    async memoryRoot(): Promise<string> {
      return resolveMemoryRoot({ dataDir: options.dataDir, workspacePath: await realpath(options.workspace) })
    },
    /** 过滤出与「记忆提取子代理」相关的请求（system 或用户消息含该标记）。 */
    extractionRequests: () => requests.filter(request =>
      request.system.includes('记忆提取子代理')
      || request.messages.some(message => message.role === 'user'
        && (typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')).includes('记忆提取子代理'))),
  }
}

/**
 * 提交一条用户消息并等待本轮 assistant 回复落定（非 streaming）。
 * @param runtime 运行时实例
 * @param id 会话 id
 * @param text 用户消息文本
 */
async function sendAndWait(runtime: Runtime, id: string, text: string): Promise<void> {
  const count = (await runtime.detail(id)).messages.length
  await runtime.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return
    await delay(20)
  }
  throw new Error('run did not settle')
}

/**
 * 轮询等待一个异步谓词成立。
 * @param predicate 每 20ms 轮询一次的判定函数
 * @param label 超时错误信息中的标签
 * @param timeoutMs 超时毫秒数，默认 15s
 */
async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * 读取文件内容，文件不存在（或读取失败）时返回 undefined 而非抛错。
 * @param path 文件绝对路径
 * @returns 文本内容或 undefined
 */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 运行时工作区记忆集成测试（真实 runtime + demo 模型）。
 *
 * 关键契约：
 * - 成功运行的对话触发后台记忆提取：写出带 node_type/originSessionId 戳记的事实文件并更新
 *   MEMORY.md 索引；提取请求使用受限只读+写入工具集，system 含记忆根路径；
 * - 提取后注入的索引在同会话的下一个请求里可见；
 * - 记忆关闭时不触发提取；主运行已直接写过记忆（memory-write）时跳过提取；
 * - 只读会话（readOnly）不触发提取；workspaceWrite 会话允许直接写记忆（含预创建的嵌套目录）。
 */
describe('workspace memory at runtime', () => {
  // demo 回答后提取子代理运行：事实文件带 node_type 与 originSessionId，MEMORY.md 索引收录；
  // 提取请求工具集恰为 6 个，system 含根路径，最后一条用户消息含提取指令；下一条请求的 system 可见注入的索引。
  it('extracts a fact after a successful run and writes stamped files plus the index', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Memory extraction' })
    const root = await f.memoryRoot()

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-demo] I prefer Chinese replies for every answer.')
    await waitFor(async () => (await readIfPresent(join(root, 'MEMORY.md'))) !== undefined, 'MEMORY.md')
    await waitFor(() => Promise.resolve(f.extractionRequests().length >= 3), 'three extraction requests')

    const fact = await readIfPresent(join(root, 'user-prefers-zh.md'))
    expect(fact).toBeDefined()
    expect(fact).toContain('node_type: memory')
    expect(fact).toContain(`originSessionId: "${conversation.conversation.id}"`)
    expect(await readIfPresent(join(root, 'MEMORY.md'))).toContain('user-prefers-zh.md')

    const extraction = f.extractionRequests()[0]
    expect(extraction?.tools).toEqual(['read', 'list_files', 'search_files', 'write', 'edit', 'delete'])
    expect(extraction?.system).toContain(root)
    const lastUser = [...(extraction?.messages ?? [])].reverse().find(message => message.role === 'user')
    const lastUserText = lastUser?.role === 'user'
      ? typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      : ''
    expect(lastUserText).toContain('记忆提取子代理')

    // 注入的索引在同会话的下一个请求里可见。
    await sendAndWait(f.runtime, conversation.conversation.id, '[prompt-probe] index-after-extraction')
    const injection = f.requests.findLast(request => !request.system.includes('记忆提取子代理') && request.messages.some(message => message.role === 'user'
      && (typeof message.content === 'string' ? message.content : '').includes('[prompt-probe] index-after-extraction')))
    expect(injection?.system).toContain('user-prefers-zh.md')
  }, 30_000)

  // 记忆保持默认关闭：同一 demo 提示不产生任何提取请求。
  it('does not extract when memory is disabled', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Memory off' })

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-demo] I prefer Chinese replies for every answer.')
    await delay(100)
    await f.runtime.close()

    expect(f.extractionRequests()).toHaveLength(0)
  }, 20_000)

  // 主运行直接写了记忆（memory-write 触发直写 nested/direct-write.md 且带戳）时，后台提取不再启动。
  it('skips extraction when the main run already wrote memory', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Direct memory write' })
    const root = await f.memoryRoot()

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-write] remember this preference for later.')
    const direct = join(root, 'nested', 'direct-write.md')
    await waitFor(async () => (await readIfPresent(direct)) !== undefined, 'direct memory write')
    expect(await readIfPresent(direct)).toContain('originSessionId:')
    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-write] remember this preference again.')
    await delay(100)
    await f.runtime.close()

    expect(f.extractionRequests()).toHaveLength(0)
  }, 30_000)

  // 只读会话（accessMode=readOnly）即使记忆开启也不触发提取。
  it('skips extraction for a read-only conversation', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Read only', accessMode: 'readOnly' })

    await sendAndWait(f.runtime, conversation.conversation.id, 'I prefer Chinese replies for every answer.')
    await delay(100)
    await f.runtime.close()

    expect(f.extractionRequests()).toHaveLength(0)
  }, 20_000)

  // workspaceWrite 会话允许直写记忆：预创建嵌套目录以覆盖 canonical root 检查，写入最终落盘。
  it('allows the session to write memory under workspaceWrite', async () => {
    const f = await fixture()
    if (!f.runtime.capabilities().accessModes.includes('workspaceWrite')) return
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Workspace write', accessMode: 'workspaceWrite' })
    const root = await f.memoryRoot()
    // 写入前先让嵌套目录存在，以便覆盖 canonical root 检查。
    await mkdir(join(root, 'nested'), { recursive: true })

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-write] remember this preference for later.')
    await waitFor(async () => (await readIfPresent(join(root, 'nested', 'direct-write.md'))) !== undefined, 'memory write under workspaceWrite')
  }, 30_000)
})
