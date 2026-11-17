import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CompactionTask, GenerationTask, ToolTask, type HookApi, type ToolExecutionResult, type ToolHookCall } from '@earendil-works/pi-durable'
import { createHooksExtension, HooksState, STOP_CONTINUATION_PREFIX, type WorkspaceRef } from '../src/server/hooks/extension.ts'
import { HooksStore } from '../src/server/hooks/store.ts'
import type { HookRunRecord } from '../src/server/hooks/schema.ts'
import { Interactions } from '../src/server/tools/interaction.ts'

/**
 * hooks 适配扩展契约测试（直调内核钩子 handlers，api stub 提供 snapshot/memo）。
 *
 * 关键契约：
 * - PreToolUse block/updatedInput；嵌套调用默认不拦，includeNested:true 才拦；
 * - 项目级 trust 门：pending 跳过、trust store 损坏 fail-closed 全拒；
 * - PostToolUse additionalContext 追加到结果 output；changedFiles 聚合（含嵌套）；
 * - Stop：changed_files 送达脚本、续跑 3 次硬上限、awaitingUser 不续跑、真实输入重置计数；
 * - 任何 handler 异常收敛为放行，不拖垮会话。
 */

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-hooks-ext-'))
  tempDirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** node -e 内联脚本 hook（跨平台）。 */
function nodeHook(script: string, extra: Record<string, unknown> = {}) {
  return { type: 'process' as const, command: process.execPath, args: ['-e', script], ...extra }
}

/** api stub：snapshot 按文档读共享状态，commit 提供 tx.doc 读写（HooksState 会话 doc 语义）。 */
function makeApi(docs: Map<unknown, unknown> = new Map()) {
  const api = {
    conversationId: 1,
    taskId: 1,
    snapshot: async (doc: unknown) => docs.get(doc),
    commit: async (change: (tx: { doc: (doc: unknown) => Promise<Record<string, unknown>> }) => Promise<void> | void) => {
      const tx = {
        doc: async (doc: unknown) => {
          if (!docs.has(doc)) docs.set(doc, {})
          return docs.get(doc) as Record<string, unknown>
        },
      }
      await change(tx)
    },
    memo: async () => undefined,
  }
  return { api: api as unknown as HookApi, docs }
}

/** 读取 HooksState 文档（测试断言用）。 */
function hooksState(docs: Map<unknown, unknown>): Record<string, unknown> {
  return (docs.get(HooksState) ?? {}) as Record<string, unknown>
}

/** 从扩展取指定 task 的 handlers（hook() 按 task.definition.name 匹配）。 */
function handlersOf(extension: ReturnType<typeof createHooksExtension>, task: { definition: { name: string } }) {
  const registration = extension.hooks?.find(item => item.task === task.definition.name)
  if (registration === undefined) throw new Error(`缺少 ${task.definition.name} 钩子注册`)
  return registration.handlers as Record<string, (...args: unknown[]) => Promise<unknown>>
}

const call = (name: string, args: Record<string, unknown> = {}, parent?: { taskId: number; callId: string }): ToolHookCall =>
  ({ id: 'call-1', name, arguments: args, ...(parent === undefined ? {} : { parent }) }) as unknown as ToolHookCall

async function setup(workspace: WorkspaceRef | undefined = { id: 'ws1', path: '' }) {
  const dir = await tempDir()
  const store = new HooksStore(join(dir, 'home'), dir)
  const workspacePath = join(dir, 'repo')
  // spawn 的 cwd 必须真实存在，否则子进程 ENOENT。
  await mkdir(workspacePath, { recursive: true })
  const ref = workspace === undefined ? undefined : { ...workspace, path: workspacePath }
  const records: HookRunRecord[] = []
  const extension = createHooksExtension({
    store,
    resolveWorkspace: async () => ref,
    capture: record => records.push(record),
  })
  return { dir, store, workspacePath, extension, records }
}

describe('hooks PreToolUse 适配', () => {
  // exit 2 阻断模型直发调用。
  it('blocks a direct model call on exit 2', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { PreToolUse: [{ matcher: 'Bash', hooks: [nodeHook('process.exit(2)')] }] } })
    const { api } = makeApi()
    const result = await handlersOf(extension, ToolTask).beforeTool(call('Bash', { command: 'rm -rf /' }), api, BACKGROUND_CONTEXT)
    expect(result).toMatchObject({ block: expect.any(String) })
  })

  // updatedInput 替换调用参数。
  it('replaces arguments with updatedInput', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { PreToolUse: [{ hooks: [nodeHook(`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{command:'safe'}}}))`)] }] } })
    const { api } = makeApi()
    const result = await handlersOf(extension, ToolTask).beforeTool(call('Bash', { command: 'danger' }), api, BACKGROUND_CONTEXT)
    expect(result).toEqual({ arguments: { command: 'safe' } })
  })

  // 嵌套调用默认不拦；includeNested:true 才拦。
  it('skips nested calls unless includeNested is set', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { PreToolUse: [{ hooks: [nodeHook('process.exit(2)')] }] } })
    const { api } = makeApi()
    const nested = call('Bash', {}, { taskId: 9, callId: 'parent' })
    expect(await handlersOf(extension, ToolTask).beforeTool(nested, api, BACKGROUND_CONTEXT)).toBeUndefined()
    await store.saveUser({ events: { PreToolUse: [{ hooks: [nodeHook('process.exit(2)', { includeNested: true })] }] } })
    expect(await handlersOf(extension, ToolTask).beforeTool(nested, api, BACKGROUND_CONTEXT)).toMatchObject({ block: expect.any(String) })
  })

  // matcher 不匹配的工具不执行。
  it('does not run hooks for unmatched tools', async () => {
    const { store, extension, records } = await setup()
    await store.saveUser({ events: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [nodeHook('process.exit(2)')] }] } })
    const { api } = makeApi()
    expect(await handlersOf(extension, ToolTask).beforeTool(call('Bash'), api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(records.filter(record => record.outcome === 'blocked')).toHaveLength(0)
  })
})

describe('hooks 项目级信任门', () => {
  // 未批准的项目级声明跳过（pending_trust），不阻断。
  it('skips untrusted project hooks', async () => {
    const { store, workspacePath, extension, records } = await setup()
    await store.saveProject(workspacePath, { events: { PreToolUse: [{ hooks: [nodeHook('process.exit(2)')] }] } })
    const { api } = makeApi()
    expect(await handlersOf(extension, ToolTask).beforeTool(call('Bash'), api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(records.some(record => record.outcome === 'pending_trust' && record.source === 'project')).toBe(true)
  })

  // 批准后执行。
  it('runs project hooks after admission', async () => {
    const { store, workspacePath, extension } = await setup()
    const entry = nodeHook('process.exit(2)')
    await store.saveProject(workspacePath, { events: { PreToolUse: [{ hooks: [entry] }] } })
    const { hookDigest } = await import('../src/server/hooks/store.ts')
    const { configDefaults } = await import('../src/server/hooks/schema.ts')
    await store.admit('ws1', hookDigest('PreToolUse', undefined, entry, configDefaults({})))
    const { api } = makeApi()
    expect(await handlersOf(extension, ToolTask).beforeTool(call('Bash'), api, BACKGROUND_CONTEXT)).toMatchObject({ block: expect.any(String) })
  })

  // trust store 损坏 → fail-closed 全拒项目级。
  it('fails closed on corrupt trust store', async () => {
    const { store, workspacePath, extension, records } = await setup()
    await store.saveProject(workspacePath, { events: { PreToolUse: [{ hooks: [nodeHook('process.exit(2)')] }] } })
    await writeFile(store.trustPath(), '{ broken', 'utf8')
    const { api } = makeApi()
    expect(await handlersOf(extension, ToolTask).beforeTool(call('Bash'), api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(records.some(record => record.outcome === 'skipped' && record.source === 'project')).toBe(true)
  })
})

describe('hooks PostToolUse 与 changedFiles', () => {
  // additionalContext 追加到工具结果 output 末尾。
  it('appends additionalContext to the tool result', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { PostToolUse: [{ hooks: [nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'注意检查'}))`)] }] } })
    const { api } = makeApi()
    const result: ToolExecutionResult = { output: [{ type: 'text', text: '原始结果' }] }
    const next = await handlersOf(extension, ToolTask).afterTool(call('Bash'), result, api, BACKGROUND_CONTEXT) as ToolExecutionResult
    expect(next.output?.map(block => block.type === 'text' ? block.text : '').join('')).toContain('注意检查')
  })

  // 失败结果走 PostToolUseFailure（stdin.error），不聚合 changedFiles。
  it('routes failed results to PostToolUseFailure', async () => {
    const { store, extension, records } = await setup()
    await store.saveUser({ events: { PostToolUseFailure: [{ hooks: [nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'恢复建议'}))`)] }] } })
    const { api } = makeApi()
    const failed: ToolExecutionResult = { output: [], isError: true, diagnostics: [{ severity: 'error', message: '命令失败' }] }
    const next = await handlersOf(extension, ToolTask).afterTool(call('Bash'), failed, api, BACKGROUND_CONTEXT) as ToolExecutionResult
    expect(next.output?.map(block => block.type === 'text' ? block.text : '').join('')).toContain('恢复建议')
    expect(records.some(record => record.event === 'PostToolUseFailure')).toBe(true)
  })

  // write/edit 成功调用聚合 changedFiles（含嵌套），Stop 消费后清空。
  it('aggregates changed files including nested calls and clears after Stop', async () => {
    const { store, extension } = await setup()
    // Stop 脚本把 changed_files 回显为 additionalContext 并请求续跑。
    await store.saveUser({ events: { Stop: [{ hooks: [nodeHook(`let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify({decision:'block',reason:JSON.stringify(j.changed_files)}))})`)] }] } })
    const { api, docs } = makeApi()
    const ok: ToolExecutionResult = { output: [{ type: 'text', text: 'ok' }] }
    await handlersOf(extension, ToolTask).afterTool(call('write', { path: 'a.ts' }), ok, api, BACKGROUND_CONTEXT)
    await handlersOf(extension, ToolTask).afterTool(call('edit', { file_path: 'b.ts' }, { taskId: 9, callId: 'p' }), ok, api, BACKGROUND_CONTEXT)
    await handlersOf(extension, ToolTask).afterTool(call('write', { path: 'a.ts' }), ok, api, BACKGROUND_CONTEXT)
    expect(hooksState(docs).changedFiles).toEqual(['a.ts', 'b.ts'])
    const answer = { content: [{ type: 'text', text: '完成' }] } as never
    const continued = await handlersOf(extension, GenerationTask).onYield(answer, api, BACKGROUND_CONTEXT) as { continue: string }
    expect(continued.continue).toContain('a.ts')
    expect(continued.continue).toContain('b.ts')
    expect(continued.continue.startsWith(STOP_CONTINUATION_PREFIX)).toBe(true)
    expect(hooksState(docs).changedFiles).toEqual([])
  })
})

describe('hooks Stop 续跑契约', () => {
  const blockHook = nodeHook(`process.stdout.write(JSON.stringify({decision:'block',reason:'继续'}))`)
  const answer = { content: [{ type: 'text', text: '完成' }] } as never

  // 连续 3 次上限，第 4 次不再续跑。
  it('enforces the 3-continuation hard limit', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { Stop: [{ hooks: [blockHook] }] } })
    const { api } = makeApi()
    const onYield = handlersOf(extension, GenerationTask).onYield
    for (let i = 0; i < 3; i++) {
      expect(await onYield(answer, api, BACKGROUND_CONTEXT)).toMatchObject({ continue: expect.any(String) })
    }
    expect(await onYield(answer, api, BACKGROUND_CONTEXT)).toBeUndefined()
  })

  // 真实用户输入（beforeRequest 最后一条 user 消息无续跑前缀）重置计数。
  it('resets the continuation count on real user input', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { Stop: [{ hooks: [blockHook] }] } })
    const { api, docs } = makeApi()
    const generation = handlersOf(extension, GenerationTask)
    for (let i = 0; i < 3; i++) await generation.onYield(answer, api, BACKGROUND_CONTEXT)
    expect(hooksState(docs).stopContinuations).toBe(3)
    await generation.beforeRequest({ messages: [{ role: 'user', content: '新问题' }] }, api, BACKGROUND_CONTEXT)
    expect(hooksState(docs).stopContinuations).toBe(0)
    expect(await generation.onYield(answer, api, BACKGROUND_CONTEXT)).toMatchObject({ continue: expect.any(String) })
  })

  // 续跑消息（带前缀）不重置计数。
  it('does not reset on hook continuation messages', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { Stop: [{ hooks: [blockHook] }] } })
    const { api, docs } = makeApi()
    const generation = handlersOf(extension, GenerationTask)
    await generation.onYield(answer, api, BACKGROUND_CONTEXT)
    await generation.beforeRequest({ messages: [{ role: 'user', content: `${STOP_CONTINUATION_PREFIX} 继续` }] }, api, BACKGROUND_CONTEXT)
    expect(hooksState(docs).stopContinuations).toBe(1)
  })

  // 有 pending 提问时不续跑（不越过用户答复）。
  it('does not continue while a question is pending', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { Stop: [{ hooks: [blockHook] }] } })
    const docs = new Map<unknown, unknown>([[Interactions, { 'call-1': { status: 'pending', questions: [] } }]])
    const { api } = makeApi(docs)
    expect(await handlersOf(extension, GenerationTask).onYield(answer, api, BACKGROUND_CONTEXT)).toBeUndefined()
  })
})

describe('hooks PreCompact 与异常隔离', () => {
  // decision:block 拒绝压缩。
  it('declines compaction on block', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { PreCompact: [{ hooks: [nodeHook(`process.stdout.write(JSON.stringify({decision:'block'}))`)] }] } })
    const { api } = makeApi()
    expect(await handlersOf(extension, CompactionTask).beforeCompact({ reason: 'budget', messages: [] }, api, BACKGROUND_CONTEXT)).toEqual({ decline: true })
  })

  // hookSpecificOutput.summary 替代摘要。
  it('uses hook summary when provided', async () => {
    const { store, extension } = await setup()
    await store.saveUser({ events: { PreCompact: [{ hooks: [nodeHook(`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreCompact',summary:'保留要点'}}))`)] }] } })
    const { api } = makeApi()
    expect(await handlersOf(extension, CompactionTask).beforeCompact({ reason: 'budget', messages: [] }, api, BACKGROUND_CONTEXT)).toEqual({ summary: '保留要点' })
  })

  // 配置加载抛错时 handler 收敛为放行，不拖垮会话。
  it('converges subsystem errors to pass-through', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    const extension = createHooksExtension({
      store,
      resolveWorkspace: async () => { throw new Error('解析失败') },
    })
    const { api } = makeApi()
    expect(await handlersOf(extension, ToolTask).beforeTool(call('Bash'), api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(await handlersOf(extension, ToolTask).afterTool(call('Bash'), { output: [] }, api, BACKGROUND_CONTEXT)).toBeUndefined()
    expect(await handlersOf(extension, GenerationTask).onYield({ content: [] } as never, api, BACKGROUND_CONTEXT)).toBeUndefined()
  })
})