import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Harness, createRegistry, type ConversationId, type Cursor } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createRuntime } from '../src/server/runtime/index.ts'
import { createDemoModelRuntime } from '../src/server/model/demo.ts'
import { taskStatusOf } from '../src/server/runtime/tasks.ts'
import { CONVERSATION_KIND, CTX, parseConversationId, TASK, TASK_INBOX } from '../src/server/runtime/helpers.ts'
import type { ConversationDetail, ConversationSummary, InteractionRequest, MessageStatus, QueueItem } from '../src/shared/types.ts'

const fixtures: Array<{ root: string; close: () => Promise<void> }> = []

async function fixture(options: { workspace?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-web-tasks-'))
  const dataDir = join(root, 'data')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}\n')
  const workspace = options.workspace === false ? undefined : join(root, 'workspace')
  if (workspace !== undefined) await mkdir(workspace, { recursive: true })
  const runtimeOptions = { dataDir, piDir, demo: true, ...(workspace === undefined ? {} : { workspace }) }
  let runtime = await createRuntime(runtimeOptions)
  fixtures.push({ root, close: () => runtime.close() })
  return {
    get runtime() { return runtime },
    workspace,
    options: runtimeOptions,
    async restart() { await runtime.close(); runtime = await createRuntime(runtimeOptions) },
  }
}

/** runtime 关闭后单独开一个 harness 读写同一份存储：检查/植入 TASK 与收件箱文档。 */
async function withStorage<T>(dataDir: string, fn: (harness: Harness) => Promise<T>): Promise<T> {
  const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, 'pi-durable.sqlite')), {
    models: createDemoModelRuntime().models,
    registry: createRegistry(),
  }, CTX)
  try {
    return await fn(harness)
  } finally {
    await harness.close(CTX)
  }
}

/** 扫描 ownerless 会话找出 main 座位，收件箱挂在它上面。 */
async function findMain(harness: Harness): Promise<ConversationId> {
  let cursor: Cursor | undefined
  do {
    const page = await harness.commit(tx => tx.scanConversations({ order: 'descending' }, 250, cursor), CTX)
    for (const record of page.items) {
      if (record.owner !== undefined) continue
      if ((await harness.snapshot(CONVERSATION_KIND, record.id, CTX))?.kind === 'main') return record.id
    }
    cursor = page.next
  } while (cursor)
  throw new Error('main seat not found')
}

afterEach(async () => {
  const pending = fixtures.splice(0)
  await Promise.all(pending.map(async ({ root, close }) => {
    await close()
    // SQLite 关闭后 WAL/SHM 可能短暂残留，recursive rm 偶发 ENOTEMPTY；短重试消除竞态。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
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

function detailOf(
  summary: Partial<ConversationSummary> = {},
  extra: Partial<Pick<ConversationDetail, 'messages' | 'queue' | 'interactions'>> = {},
): ConversationDetail {
  return {
    conversation: {
      id: 'task-1',
      title: '任务',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      pinned: false,
      busy: false,
      thinkingLevel: 'medium',
      cwd: '/workspace',
      ...summary,
    },
    messages: [],
    queue: [],
    ...extra,
  }
}

const queuedItem: QueueItem = { id: '1', text: '排队的一条', mode: 'followUp', createdAt: 1 }
const pendingQuestion: InteractionRequest = { id: 'call-1', kind: 'question', status: 'pending', createdAt: 1 }

describe('taskStatusOf', () => {
  it('waiting 优先于运行态：有待回答问题就是 waiting', () => {
    expect(taskStatusOf(detailOf({ busy: true }, { interactions: [pendingQuestion] }))).toBe('waiting')
  })

  it('busy 投影为 running', () => {
    expect(taskStatusOf(detailOf({ busy: true }))).toBe('running')
  })

  it('未运行但队列非空投影为 queued', () => {
    expect(taskStatusOf(detailOf({}, { queue: [queuedItem] }))).toBe('queued')
  })

  it('queued 优先于终态：排队输入还在时不算失败', () => {
    expect(taskStatusOf(detailOf({ status: 'error' }, { queue: [queuedItem] }))).toBe('queued')
  })

  it.each<[MessageStatus, string]>([
    ['error', 'failed'],
    ['cancelled', 'cancelled'],
    ['completed', 'completed'],
  ])('终态 %s 投影为 %s', (status, expected) => {
    expect(taskStatusOf(detailOf({ status }))).toBe(expected)
  })

  it('没有回合、没有排队也没有终态时投影为 idle', () => {
    expect(taskStatusOf(detailOf())).toBe('idle')
  })
})

describe('tasks runtime', () => {
  it('creates a task, submits its first input and lists it with status and preview', async () => {
    const { runtime } = await fixture()
    const workspace = runtime.workspaces()[0]
    const created = await runtime.createTask({ title: '入口任务', text: '[doc-fixture] 任务入口', requestId: 'task-create' })

    expect(created.conversation.kind).toBe('task')
    expect(created.conversation.title).toBe('入口任务')
    expect(created.conversation.workspaceId).toBe(workspace?.id)
    const userText = created.messages.filter(message => message.role === 'user')
      .flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    expect(userText).toContain('任务入口')

    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    expect(completed.conversation.status).toBe('completed')

    const tasks = await runtime.tasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: created.conversation.id,
      title: '入口任务',
      status: 'completed',
      workspaceId: workspace?.id,
      busy: false,
      turns: 1,
    })
    expect(tasks[0]?.preview).toContain('核心美学原则')
    expect(tasks[0]?.preview).not.toContain('\n')
    expect((tasks[0]?.preview ?? '').length).toBeLessThanOrEqual(120)
    expect(tasks[0]?.unread).toBe(true)

    // 打开详情会清掉未读，row 不再带点。
    await runtime.detail(created.conversation.id)
    expect((await runtime.tasks())[0]?.unread).toBeUndefined()
  })

  it('keeps exactly one main seat across task creation', async () => {
    const { runtime } = await fixture()
    const mains = async () => (await runtime.list()).filter(item => item.kind === 'main')
    expect(await mains()).toHaveLength(1)

    await runtime.createTask({ text: '[doc-fixture] 第一件', requestId: 'task-a' })
    await runtime.createTask({ text: '[doc-fixture] 第二件', requestId: 'task-b' })

    expect(await mains()).toHaveLength(1)
    const tasks = await runtime.tasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]?.createdAt).toBeGreaterThanOrEqual(tasks[1]?.createdAt ?? 0)
  })

  it('creates the main seat with no workspace at all', async () => {
    const { runtime } = await fixture({ workspace: false })
    const mains = (await runtime.list()).filter(item => item.kind === 'main')
    expect(mains).toHaveLength(1)
    expect(mains[0]?.workspaceId).toBeUndefined()
  })
})

describe('task persistence', () => {
  it('createTask 同 commit 写入 TASK：attempt=1 且 originRequestId 正确', async () => {
    const f = await fixture()
    const created = await f.runtime.createTask({ title: '记录任务', text: '[doc-fixture] 任务记录', requestId: 'task-record' })
    const id = parseConversationId(created.conversation.id)
    await f.runtime.close()
    const task = await withStorage(f.options.dataDir, harness => harness.snapshot(TASK, id, CTX))
    expect(task?.attempt).toBe(1)
    expect(task?.originRequestId).toBe('task-record')
    // createTask 本身不结算，结算只发生在 list/reconcile。
    expect(task?.settledAt).toBeUndefined()
  })

  it('终态任务 list 后写入结算与收件箱，重复 list 幂等不追加', async () => {
    const f = await fixture()
    const created = await f.runtime.createTask({ title: '结算任务', text: '[doc-fixture] 任务结算', requestId: 'task-settle' })
    const id = parseConversationId(created.conversation.id)
    await waitForCompletedRun(f.runtime, created.conversation.id)
    await f.runtime.tasks()
    await f.runtime.tasks()
    await f.runtime.close()
    const { task, inbox } = await withStorage(f.options.dataDir, async harness => {
      const main = await findMain(harness)
      return { task: await harness.snapshot(TASK, id, CTX), inbox: await harness.snapshot(TASK_INBOX, main, CTX) }
    })
    expect(task?.settledAt).toBeTypeOf('number')
    expect(task?.settlement?.status).toBe('completed')
    expect(task?.settlement?.summary).toContain('核心美学原则')
    expect(task?.settlement?.at).toBe(task?.settledAt)
    expect(inbox?.items).toHaveLength(1)
    expect(inbox?.items[0]).toMatchObject({ taskId: String(id), title: '结算任务', status: 'completed' })
    expect(inbox?.items[0]?.summary).toContain('核心美学原则')
  })

  it('reconcile 把无 user 消息的孤儿任务标 failed 结算，且不删会话', async () => {
    const f = await fixture()
    await f.runtime.close()
    // 植入一个没有提交过首条消息的 task 会话，模拟 createTask 提交失败留下的孤儿。
    const orphanId = await withStorage(f.options.dataDir, async harness => {
      const main = await findMain(harness)
      const record = await harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), CTX)
      await harness.commit(async tx => {
        const kind = await tx.doc(CONVERSATION_KIND, record.id)
        kind.kind = 'task'
        kind.parentId = String(main)
        const task = await tx.doc(TASK, record.id)
        task.originRequestId = 'orphan-request'
        task.attempt = 1
      }, CTX)
      return record.id
    })
    await f.restart()
    await f.runtime.close()
    const { task, stillThere } = await withStorage(f.options.dataDir, async harness => ({
      task: await harness.snapshot(TASK, orphanId, CTX),
      stillThere: await harness.commit(tx => tx.conversation(orphanId), CTX) !== undefined,
    }))
    expect(stillThere).toBe(true)
    expect(task?.settledAt).toBeTypeOf('number')
    expect(task?.settlement?.status).toBe('failed')
    expect(task?.settlement?.summary).toBe('创建后未提交首条消息')
  })

  it('收件箱超过 50 条时截断，最新结算留在最前', async () => {
    const f = await fixture()
    const created = await f.runtime.createTask({ title: '截断任务', text: '[doc-fixture] 收件箱截断', requestId: 'task-truncate' })
    const id = parseConversationId(created.conversation.id)
    await waitForCompletedRun(f.runtime, created.conversation.id)
    await f.runtime.close()
    // 先植入 50 条历史结算；重启时 reconcile 结算这条已完成任务，unshift 成 51 条再截断。
    await withStorage(f.options.dataDir, async harness => {
      const main = await findMain(harness)
      await harness.commit(async tx => {
        const inbox = await tx.doc(TASK_INBOX, main)
        inbox.items = Array.from({ length: 50 }, (_, index) => ({
          taskId: `planted-${index}`, title: `历史 ${index}`, status: 'completed' as const, at: index + 1,
        }))
      }, CTX)
    })
    await f.restart()
    await f.runtime.close()
    const inbox = await withStorage(f.options.dataDir, async harness => harness.snapshot(TASK_INBOX, await findMain(harness), CTX))
    expect(inbox?.items).toHaveLength(50)
    expect(inbox?.items[0]?.taskId).toBe(String(id))
    expect(inbox?.items[1]?.taskId).toBe('planted-0')
    expect(inbox?.items.some(item => item.taskId === 'planted-49')).toBe(false)
  })
})
