import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssistantMessage, Message, ToolCall, Usage } from '@earendil-works/pi-ai'
import {
  MEMORY_EXTRACTION_MAX_TURNS,
  MEMORY_EXTRACTION_POLICY_MESSAGE,
  createExtractionScheduler,
  executeExtractionTool,
  extractionPrompt,
  memoryExtractionTools,
  memorySkipReason,
  runExtractionLoop,
  scanMemoryManifest,
} from '../src/server/memory/extraction.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'

/** 临时目录清理队列，用例结束后逆序删除。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 构造提取测试夹具：临时 dataDir/workspace，并解析对应的记忆根目录。
 * @returns 夹具对象（root/dataDir/workspace/memoryRoot）
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-extraction-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const memoryRoot = resolveMemoryRoot({ dataDir, workspacePath: workspace })
  return { root, dataDir, workspace, memoryRoot }
}

/** 构造一个最小 Usage 记录（token 数非零、成本为零）。 */
function usage(): Usage {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

/**
 * 构造一条 assistant 消息。
 * @param content 消息内容（文本块或工具调用数组）
 * @param stopReason 结束原因，默认 stop（toolUse 表示还有工具调用要执行）
 * @returns AssistantMessage
 */
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, api: 'faux', provider: 'test', model: 'demo', usage: usage(), stopReason, timestamp: Date.now() }
}

/**
 * 构造一个工具调用块。
 * @param name 工具名
 * @param args 调用参数
 * @param id 调用 id，默认 call-1
 * @returns ToolCall
 */
function toolCall(name: string, args: Record<string, unknown>, id = 'call-1'): ToolCall {
  return { type: 'toolCall', id, name, arguments: args as never }
}

/**
 * 提取运行决策测试（memorySkipReason）。
 *
 * 关键契约：
 * - 主运行的 assistant 已经在记忆根内写/编（含相对路径、非 .md 文件）→ direct-memory-write，跳过后台提取；
 * - 根外写入或对记忆根的读取不算直写，不跳过；
 * - 用户 prose 不足三个词（纯中文短句、含图少文、只有 toolResult 文本）→ no-user-prose，跳过。
 */
describe('extraction run decision', () => {
  /** 测试用的工作目录与假记忆根。 */
  const cwd = '/workspace/demo'
  const root = '/data/memories/projects/demo-0123456789abcdef/memory'
  /** 一条表达「记住这个偏好」的用户消息。 */
  const prose: Message = { role: 'user', content: 'please remember this preference for later', timestamp: 1 }

  // 三种直写形态都判 direct-memory-write：根内 write、相对路径 edit、根内非 Markdown 写入。
  it('skips a run whose assistant already wrote or edited inside the memory root', () => {
    const messages: Message[] = [
      prose,
      assistant([toolCall('write', { path: join(root, 'fact.md') })], 'toolUse'),
    ]
    expect(memorySkipReason(messages, root, cwd)).toBe('direct-memory-write')

    const relative: Message[] = [
      prose,
      assistant([toolCall('edit', { path: '../../data/memories/projects/demo-0123456789abcdef/memory/fact.md' })], 'toolUse'),
    ]
    expect(memorySkipReason(relative, root, cwd)).toBe('direct-memory-write')

    const nonMarkdown: Message[] = [
      prose,
      assistant([toolCall('write', { path: join(root, 'notes.txt') })], 'toolUse'),
    ]
    expect(memorySkipReason(nonMarkdown, root, cwd)).toBe('direct-memory-write')
  })

  // 根外写（cwd/notes.txt）与对根内文件的 read 都不构成直写，返回 undefined（不跳过）。
  it('does not treat a write outside the root, or a read, as a direct memory write', () => {
    const messages: Message[] = [
      prose,
      assistant([
        toolCall('write', { path: join(cwd, 'notes.txt') }),
        toolCall('read', { path: join(root, 'fact.md') }, 'call-2'),
      ], 'toolUse'),
    ]
    expect(memorySkipReason(messages, root, cwd)).toBeUndefined()
  })

  // 用户 prose 少于三个词的形态（中文两句、一词文本+图片、只有工具结果文本）都判 no-user-prose。
  it('skips a run without at least three words of user prose', () => {
    expect(memorySkipReason([{ role: 'user', content: '说中文', timestamp: 1 }], root, cwd)).toBe('no-user-prose')
    expect(memorySkipReason([{
      role: 'user',
      content: [{ type: 'text', text: 'short' }, { type: 'image', data: 'x', mimeType: 'image/png' }],
      timestamp: 1,
    }], root, cwd)).toBe('no-user-prose')
    expect(memorySkipReason([{
      role: 'toolResult',
      toolCallId: '1',
      toolName: 'read',
      content: [{ type: 'text', text: 'one two three four' }],
      isError: false,
      timestamp: 1,
    }], root, cwd)).toBe('no-user-prose')
  })
})

/**
 * 提取调度器测试（createExtractionScheduler）。
 *
 * 关键契约：
 * - 连续 schedule 合并为「一个运行槽 + 一个最新待办槽」：突发 3 次只跑 2 次，并发恒为 1，cursor 前进；
 * - cursor 只在 success/skip 时前进，error/aborted 保持旧值（下次重试同一 cursor）；
 * - shutdown 中断运行中的任务（AbortSignal 触发）且拒绝新调度。
 */
describe('extraction scheduler', () => {
  // 突发 3 次 schedule：第一次立即跑，第二次合并为待办在第一次完成后跑；最大并发 1，最终 cursor=2。
  it('coalesces a burst into one running slot plus one latest-pending slot', async () => {
    let runs = 0
    let active = 0
    let maxActive = 0
    /** 每次运行挂起的 gate，测试手动放行。 */
    const gates: Array<() => void> = []
    const scheduler = createExtractionScheduler(async () => {
      runs += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolveGate => gates.push(resolveGate))
      active -= 1
      return { outcome: 'success', cursor: runs as never }
    })

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()
    expect(runs).toBe(1)
    gates.shift()?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    gates.shift()?.()
    await scheduler.drain()

    expect(runs).toBe(2)
    expect(maxActive).toBe(1)
    expect(scheduler.cursor()).toBe(2)
  })

  // cursor 推进规则：success('a')→前进、error→保持 'a'、aborted→保持 'a'、skip('b')→前进到 'b'。
  it('advances the cursor on success and skip but not on error or abort', async () => {
    const seen: Array<unknown> = []
    let step = 0
    const scheduler = createExtractionScheduler(async (cursor) => {
      seen.push(cursor)
      step += 1
      if (step === 1) return { outcome: 'success', cursor: 'a' as never }
      if (step === 2) return { outcome: 'error' }
      if (step === 3) return { outcome: 'aborted' }
      return { outcome: 'skip', cursor: 'b' as never }
    })

    scheduler.schedule()
    await scheduler.drain()
    scheduler.schedule()
    await scheduler.drain()
    scheduler.schedule()
    await scheduler.drain()
    scheduler.schedule()
    await scheduler.drain()

    expect(seen).toEqual([undefined, 'a', 'a', 'a'])
    expect(scheduler.cursor()).toBe('b')
  })

  // shutdown 后：运行中任务收到 abort 信号（aborted=true），随后的 schedule 被拒绝（runs 仍为 1）。
  it('aborts the running task and refuses new schedules after shutdown', async () => {
    let runs = 0
    let aborted = false
    const scheduler = createExtractionScheduler(async (_cursor, signal) => {
      runs += 1
      await new Promise<void>(resolveAbort => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolveAbort()
        }, { once: true })
      })
      return { outcome: 'aborted' }
    })

    scheduler.schedule()
    await Promise.resolve()
    scheduler.shutdown()
    scheduler.schedule()
    await scheduler.drain()

    expect(runs).toBe(1)
    expect(aborted).toBe(true)
  })
})

/**
 * 受限提取循环测试（runExtractionLoop）。
 *
 * 关键契约：
 * - 未知工具与根外记忆写入在循环内直接拒答（带策略文案），不触达 executor；
 * - 允许的调用正常执行，到 MEMORY_EXTRACTION_MAX_TURNS 轮上限即停（第 5 轮执行完就收尾）；
 * - signal 已 abort 时在第一次请求前就抛错（completions=0）；
 * - stopReason=error 视为运行失败抛错，不当作完成。
 */
describe('restricted extraction loop', () => {
  /** 循环公共选项：最小消息、完整提取工具集、非中止 signal、低 token/短超时。 */
  const baseOptions = {
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'remember this preference', timestamp: 1 }] as Message[],
    tools: memoryExtractionTools(),
    signal: new AbortController().signal,
    maxTokens: 100,
    sessionId: 'memory-1',
    timeoutMs: 1_000,
  }

  // bash 不在白名单、/etc/x.md 在根外：两者都直接产出带错误文案的 toolResult（isError），executor 从未被调用。
  it('rejects an unknown tool and a memory write outside the root without calling the executor', async () => {
    const root = '/data/memories/projects/demo/memory'
    const calls: ToolCall[] = []
    const executed: string[] = []
    const answers = [
      assistant([toolCall('bash', { command: 'ls' }, 'c1'), toolCall('write', { path: '/etc/x.md', content: 'x' }, 'c2')], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }]),
    ]
    let index = 0
    const result = await runExtractionLoop(baseOptions, {
      complete: async () => answers[index++]!,
      execute: async (call) => {
        executed.push(call.name)
        calls.push(call)
        return { content: 'ok', isError: false }
      },
      root,
      cwd: '/workspace/demo',
    })

    expect(executed).toEqual([])
    const toolResults = result.messages.filter((message): message is Extract<Message, { role: 'toolResult' }> => message.role === 'toolResult')
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]?.content[0]).toEqual({ type: 'text', text: 'Error: No such tool available: bash' })
    expect(toolResults[1]?.content[0]).toEqual({ type: 'text', text: MEMORY_EXTRACTION_POLICY_MESSAGE(root) })
    expect(toolResults.every(message => message.isError)).toBe(true)
  })

  // 模型连续要求 read：第 5 轮（上限）执行完后循环收尾，completions/executions/turns 都是 MAX_TURNS，usage 累计非零。
  it('executes allowed calls and stops at the turn cap after executing the fifth round', async () => {
    const root = '/data/memories/projects/demo/memory'
    let completions = 0
    let executions = 0
    const result = await runExtractionLoop(baseOptions, {
      complete: async () => {
        completions += 1
        return assistant([toolCall('read', { path: join(root, 'fact.md') }, `call-${completions}`)], 'toolUse')
      },
      execute: async () => {
        executions += 1
        return { content: 'file body', isError: false }
      },
      root,
      cwd: '/workspace/demo',
    })

    expect(completions).toBe(MEMORY_EXTRACTION_MAX_TURNS)
    expect(executions).toBe(MEMORY_EXTRACTION_MAX_TURNS)
    expect(result.turns).toBe(MEMORY_EXTRACTION_MAX_TURNS)
    expect(result.usage.totalTokens).toBeGreaterThan(0)
  })

  // 已中止的 signal：发起第一次请求前就抛错，complete 回调一次都没被调。
  it('throws before the first request when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let completions = 0
    await expect(runExtractionLoop({ ...baseOptions, signal: controller.signal }, {
      complete: async () => {
        completions += 1
        return assistant([])
      },
      execute: async () => ({ content: '', isError: false }),
      root: '/data/memories/projects/demo/memory',
      cwd: '/workspace/demo',
    })).rejects.toThrow()
    expect(completions).toBe(0)
  })

  // 模型请求以 error 结束：循环抛「extraction request stopped with error」而不是正常完成。
  it('treats an error stop reason as a failed run instead of completing', async () => {
    await expect(runExtractionLoop(baseOptions, {
      complete: async () => assistant([], 'error'),
      execute: async () => ({ content: '', isError: false }),
      root: '/data/memories/projects/demo/memory',
      cwd: '/workspace/demo',
    })).rejects.toThrow('extraction request stopped with error')
  })
})

/**
 * 提取工具执行器测试（executeExtractionTool）。
 *
 * 关键契约：
 * - write 只能写记忆根内的 .md，写前自动补 node_type/originSessionId 戳记；根外写入拒绝并返回策略文案；
 * - edit 要求 oldText 唯一：非唯一拒绝不落盘；成功编辑后补戳；
 * - delete 允许删根内事实文件，但 MEMORY.md 与根外路径受保护；删不存在文件报 File not found；
 * - read/list_files/search_files 可读工作区与记忆根，根外读取拒绝。
 */
describe('extraction tool executor', () => {
  // 根内 write 落盘带 node_type: memory 与 originSessionId: "9"；写到工作区根外的 outside.md 被拒并返回策略文案。
  it('writes a stamped fact file inside the memory root only', async () => {
    const f = await fixture()
    const result = await executeExtractionTool(toolCall('write', {
      path: join(f.memoryRoot, 'prefs.md'),
      content: '---\nname: prefs\ndescription: Chinese replies\n---\nBody\n',
    }), { root: f.memoryRoot, cwd: f.workspace, conversationId: 9 as never, signal: new AbortController().signal })

    expect(result.isError).toBe(false)
    const written = await readFile(join(f.memoryRoot, 'prefs.md'), 'utf8')
    expect(written).toContain('node_type: memory')
    expect(written).toContain('originSessionId: "9"')

    const rejected = await executeExtractionTool(toolCall('write', {
      path: join(f.workspace, 'outside.md'),
      content: 'x',
    }, 'call-2'), { root: f.memoryRoot, cwd: f.workspace, conversationId: 9 as never, signal: new AbortController().signal })
    expect(rejected.isError).toBe(true)
    expect(rejected.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))
  })

  // oldText「repeat」出现两次 → 非唯一拒绝且文件未改；oldText 唯一（repeat repeat）→ 应用成功并补 originSessionId: "3"。
  it('applies a unique edit and rejects a non-unique one without writing', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    const source = join(f.memoryRoot, 'fact.md')
    await writeFile(source, '---\nname: fact\n---\nrepeat repeat\n', 'utf8')

    const rejected = await executeExtractionTool(toolCall('edit', {
      path: source,
      edits: [{ oldText: 'repeat', newText: 'once' }],
    }), { root: f.memoryRoot, cwd: f.workspace, conversationId: 3 as never, signal: new AbortController().signal })
    expect(rejected.isError).toBe(true)
    expect(await readFile(source, 'utf8')).toContain('repeat repeat')

    const applied = await executeExtractionTool(toolCall('edit', {
      path: source,
      edits: [{ oldText: 'repeat repeat', newText: 'single value' }],
    }, 'call-2'), { root: f.memoryRoot, cwd: f.workspace, conversationId: 3 as never, signal: new AbortController().signal })
    expect(applied.isError).toBe(false)
    const edited = await readFile(source, 'utf8')
    expect(edited).toContain('single value')
    expect(edited).toContain('originSessionId: "3"')
  })

  // delete 保护：MEMORY.md 与根外 notes.md 拒绝（策略文案）；根内 stale.md 删除成功；重复删报 File not found。
  it('deletes a fact file inside the memory root but never MEMORY.md or outside paths', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    const source = join(f.memoryRoot, 'stale.md')
    const index = join(f.memoryRoot, 'MEMORY.md')
    await writeFile(source, '---\nname: stale\n---\noutdated\n', 'utf8')
    await writeFile(index, '- [Stale](stale.md) — index\n', 'utf8')
    const options = { root: f.memoryRoot, cwd: f.workspace, conversationId: 4 as never, signal: new AbortController().signal }

    const protectIndex = await executeExtractionTool(toolCall('delete', { path: index }), options)
    expect(protectIndex.isError).toBe(true)
    expect(protectIndex.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))

    const outside = await executeExtractionTool(toolCall('delete', { path: join(f.workspace, 'notes.md') }, 'call-2'), options)
    expect(outside.isError).toBe(true)
    expect(outside.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))

    const removed = await executeExtractionTool(toolCall('delete', { path: source }, 'call-3'), options)
    expect(removed.isError).toBe(false)
    await expect(readFile(source, 'utf8')).rejects.toThrow()

    const again = await executeExtractionTool(toolCall('delete', { path: source }, 'call-4'), options)
    expect(again.isError).toBe(true)
    expect(again.content).toContain('File not found')
  })

  // 只读三件套：read 读记忆根文件、list_files 列工作区（含 notes.txt）、search_files 大小写不敏感命中（notes.txt:1）；读根外 /etc/hosts 拒绝。
  it('reads, lists and searches the workspace and the memory root', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.workspace, 'notes.txt'), 'Workspace Note One\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'fact.md'), '- [Pref](prefs.md) — prefers Chinese\n', 'utf8')
    const options = { root: f.memoryRoot, cwd: f.workspace, conversationId: 1 as never, signal: new AbortController().signal }

    const read = await executeExtractionTool(toolCall('read', { path: join(f.memoryRoot, 'fact.md') }), options)
    expect(read.isError).toBe(false)
    expect(read.content).toContain('prefers Chinese')

    const listed = await executeExtractionTool(toolCall('list_files', {}), options)
    expect(listed.isError).toBe(false)
    expect(listed.content).toContain('notes.txt')

    const searched = await executeExtractionTool(toolCall('search_files', { pattern: 'note one' }), options)
    expect(searched.isError).toBe(false)
    expect(searched.content).toContain('notes.txt:1')

    const outside = await executeExtractionTool(toolCall('read', { path: '/etc/hosts' }), options)
    expect(outside.isError).toBe(true)
    expect(outside.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))
  })
})

/**
 * 记忆清单（manifest）与提取提示词测试。
 *
 * 关键契约：
 * - scanMemoryManifest 列出带 frontmatter 的 .md 事实文件，按修改时间倒序，排除 MEMORY.md 与非 .md；
 * - extractionPrompt 注入消息数、已有记忆清单（类型/文件/时间/描述）与「Nothing to save.」退出契约；
 *   清单为空时不出现清单标题。
 */
describe('memory manifest', () => {
  // new.md（mtime 2000）排在 old.md（mtime 1000）前；frontmatter 的 type/description 进入条目；MEMORY.md 与 notes.txt 不出现。
  it('lists frontmatter facts newest first and excludes MEMORY.md', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '- [Old](old.md) — index\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'old.md'), '---\nname: old\ndescription: older fact\nmetadata:\n  type: project\n---\nBody\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'new.md'), '---\nname: new\ndescription: newer fact\nmetadata:\n  type: user\n---\nBody\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'notes.txt'), '---\nname: notes\n---\n', 'utf8')
    await utimes(join(f.memoryRoot, 'old.md'), new Date(1_000), new Date(1_000))
    await utimes(join(f.memoryRoot, 'new.md'), new Date(2_000), new Date(2_000))

    const manifest = await scanMemoryManifest(f.memoryRoot)

    expect(manifest.map(entry => entry.file)).toEqual(['new.md', 'old.md'])
    expect(manifest[0]).toMatchObject({ type: 'user', description: 'newer fact' })
    expect(manifest[1]).toMatchObject({ type: 'project', description: 'older fact' })
  })

  // 有清单的提示词含消息数（约 12 条）、清单标题与条目行、退出契约「Nothing to save.」与根路径；空清单时不含清单标题。
  it('writes the manifest and the Nothing-to-save contract into the prompt', async () => {
    const withManifest = extractionPrompt('/data/root', 12, [{ file: 'a.md', type: 'user', description: 'prefers Chinese', modifiedAt: 0 }])
    expect(withManifest).toContain('最近约 12 条消息')
    expect(withManifest).toContain('## 已有记忆文件')
    expect(withManifest).toContain('- [user] a.md (1970-01-01T00:00:00.000Z): prefers Chinese')
    expect(withManifest).toContain('「Nothing to save.」')
    expect(withManifest).toContain('/data/root')

    const withoutManifest = extractionPrompt('/data/root', 3, [])
    expect(withoutManifest).not.toContain('## 已有记忆文件')
  })
})
