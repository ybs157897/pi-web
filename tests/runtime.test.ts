import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime.ts'
import { holdNextDemoResponse } from '../src/server/demo-model.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

const fixtures: Array<{ root: string; closers: Array<() => Promise<void>> }> = []

async function fixture(demo = true): Promise<{ root: string; dataDir: string; workspace: string; piDir: string; runtime: Awaited<ReturnType<typeof createRuntime>>; cleanup: { root: string; closers: Array<() => Promise<void>> } }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-web-runtime-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}\n')
  const runtime = await createRuntime({ dataDir, workspace, piDir, demo })
  const cleanup = { root, closers: [() => runtime.close()] }
  fixtures.push(cleanup)
  return { root, dataDir, workspace, piDir, runtime, cleanup }
}

afterEach(async () => {
  const pending = fixtures.splice(0)
  await Promise.all(pending.map(async ({ closers, root }) => {
    await Promise.all(closers.map(close => close()))
    await rm(root, { recursive: true, force: true })
  }))
})

async function waitForCompletedRun(runtime: Awaited<ReturnType<typeof createRuntime>>, id: string, timeoutMs = 20_000): Promise<ConversationDetail> {
  let unsubscribe: (() => Promise<void>) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const result = new Promise<ConversationDetail>((resolve, reject) => {
    timeout = setTimeout(() => {
      if (!settled) reject(new Error(`Conversation ${id} did not finish within ${timeoutMs} ms`))
    }, timeoutMs)
    void runtime.watch(id, (detail) => {
      const hasAnswer = detail.messages.some(message => message.role === 'assistant' && !message.streaming && message.blocks.some(block => block.type === 'text'))
      if (!settled && hasAnswer && !detail.conversation.busy) {
        settled = true
        if (timeout) clearTimeout(timeout)
        resolve(detail)
        void unsubscribe?.()
      }
    }).then(stop => {
      unsubscribe = stop
      if (settled) void stop()
    }, reject)
  })
  try {
    return await result
  } finally {
    if (timeout) clearTimeout(timeout)
    await unsubscribe?.()
  }
}

describe('Pi Durable runtime', () => {
  it('projects the initial watch snapshot, deduplicates submissions, and runs real CodingTools', async () => {
    const { runtime, workspace } = await fixture()
    const created = await runtime.create({ title: 'Tool transcript' })
    expect(created.conversation.model).toEqual({ provider: 'pi-web-demo', modelId: 'demo-model' })
    expect((await runtime.catalog()).providers.find(provider => provider.id === 'pi-web-demo')?.name).toContain('不调用真实模型')

    let initial: ConversationDetail | undefined
    const stopWatching = await runtime.watch(created.conversation.id, detail => { initial ??= detail })
    expect(initial?.conversation.id).toBe(created.conversation.id)
    expect(initial?.messages).toEqual([])
    await stopWatching()

    const input = { text: '请写入 hello.txt，再读取，最后用 Markdown 总结。', requestId: randomUUID() }
    const [first, replay] = await Promise.all([
      runtime.submit(created.conversation.id, input),
      runtime.submit(created.conversation.id, input),
    ])
    expect(replay).toEqual(first)
    await expect(runtime.submit(created.conversation.id, { ...input, text: '不同内容' }))
      .rejects.toMatchObject({ code: 'CONFLICT' })

    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    const user = completed.messages.find(message => message.role === 'user')
    expect(user?.requestId).toBe(input.requestId)
    const toolResults = completed.messages.filter(message => message.role === 'tool')
    expect(toolResults.map(message => message.toolName)).toEqual(expect.arrayContaining(['write', 'read', 'bash']))
    expect(completed.messages.some(message => message.role === 'assistant' && message.blocks.some(block => block.type === 'thinking'))).toBe(true)
    expect(completed.messages.some(message => message.role === 'assistant' && message.blocks.some(block => block.type === 'text' && block.text.includes('| 检查方式 |')))).toBe(true)
    expect(await readFile(join(workspace, 'hello.txt'), 'utf8')).toBe('Hello from Pi Durable Web.\n')
  })

  it('removes a queued submission and stop uses Pi abort to clear remaining queued inputs', async () => {
    const gate = holdNextDemoResponse()
    const { runtime } = await fixture()
    try {
      const created = await runtime.create({})
      await runtime.submit(created.conversation.id, { text: '开始一个可取消的演示任务', requestId: 'run-before-stop' })
      await gate.started
      const removable = await runtime.submit(created.conversation.id, {
        text: '撤回这一条', requestId: 'remove-me', whenBusy: 'followUp',
      })
      const retained = await runtime.submit(created.conversation.id, {
        text: '停止时一起撤回这一条', requestId: 'stop-clears-me', whenBusy: 'steer',
      })
      expect((await runtime.detail(created.conversation.id)).queue.map(item => item.id)).toEqual([removable.submissionId, retained.submissionId])

      await runtime.removeQueued(created.conversation.id, removable.submissionId)
      expect((await runtime.detail(created.conversation.id)).queue.map(item => item.id)).toEqual([retained.submissionId])
      await runtime.stop(created.conversation.id)
      const stopped = await runtime.detail(created.conversation.id)
      expect(stopped.conversation.busy).toBe(false)
      expect(stopped.queue).toEqual([])
    } finally {
      gate.release()
    }
  })

  it('persists metadata and fork history across close and reopen', async () => {
    const { dataDir, workspace, piDir, runtime, cleanup } = await fixture()
    const created = await runtime.create({ title: 'Reference conversation' })
    const updated = await runtime.update(created.conversation.id, { title: 'Pinned reference', pinned: true, archived: true, thinkingLevel: 'high' })
    expect(updated.conversation).toMatchObject({ title: 'Pinned reference', pinned: true, archived: true, thinkingLevel: 'high' })
    await runtime.submit(created.conversation.id, { text: '请写入 hello.txt，再读取，最后用 Markdown 总结。', requestId: 'persist-run' })
    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    const userEntry = completed.messages.find(message => message.role === 'user')?.entryId
    expect(userEntry).toBeDefined()
    await runtime.close()

    const reopened = await createRuntime({ dataDir, workspace, piDir, demo: true })
    cleanup.closers.push(() => reopened.close())
    const restored = await reopened.detail(created.conversation.id)
    expect(restored.conversation).toMatchObject({ title: 'Pinned reference', pinned: true, archived: true })
    expect(restored.messages).toEqual(completed.messages)

    const child = await reopened.fork(created.conversation.id, userEntry!)
    expect(child.conversation.id).not.toBe(created.conversation.id)
    expect(child.conversation.title).toBe('Pinned reference (fork)')
    expect(child.conversation.pinned).toBe(false)
    expect(child.conversation.archived).toBe(false)
    expect(child.messages.some(message => message.role === 'user' && message.requestId === 'persist-run')).toBe(true)
    const listing = await reopened.list()
    expect(listing.some(summary => summary.id === child.conversation.id)).toBe(true)
  })

  it('saves custom providers immediately and restores multiple protected credentials without catalog disclosure', async () => {
    const { runtime, dataDir, cleanup } = await fixture(false)
    const providers = [
      { id: 'runtime-provider-one', name: 'Provider One', baseUrl: 'https://one.example/v1', apiKey: 'secret-one', models: [{ id: 'one-model', name: 'One Model' }] },
      { id: 'runtime-provider-two', name: 'Provider Two', baseUrl: 'https://two.example/v1', apiKey: 'secret-two', models: [{ id: 'two-model', name: 'Two Model' }] },
    ]
    await Promise.all(providers.map(provider => runtime.saveProvider(provider)))
    const catalog = await runtime.catalog()
    expect(catalog.models.map(model => model.modelId)).toEqual(expect.arrayContaining(['one-model', 'two-model']))
    expect(catalog.providers.filter(provider => provider.id.startsWith('runtime-provider-')).every(provider => provider.configured)).toBe(true)
    expect(JSON.stringify(catalog)).not.toContain('secret-one')
    expect(JSON.stringify(catalog)).not.toContain('secret-two')
    const providerFile = await stat(join(dataDir, 'providers.json'))
    const dataDirectory = await stat(dataDir)
    expect(providerFile.mode & 0o777).toBe(0o600)
    expect(dataDirectory.mode & 0o777).toBe(0o700)

    await runtime.close()
    const reopened = await createRuntime({ dataDir, workspace: join(dataDir, '..', 'workspace'), piDir: join(dataDir, '..', 'pi') })
    cleanup.closers.push(() => reopened.close())
    const reloaded = await reopened.catalog()
    expect(reloaded.models.map(model => model.modelId)).toEqual(expect.arrayContaining(['one-model', 'two-model']))
    expect(reloaded.providers.filter(provider => provider.id.startsWith('runtime-provider-')).every(provider => provider.configured)).toBe(true)
    expect(JSON.stringify(reloaded)).not.toContain('secret-one')
    expect(JSON.stringify(reloaded)).not.toContain('secret-two')
  })
})
