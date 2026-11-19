import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai'
import { getCurrentSystemMessage, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { expect, it, vi } from 'vitest'
import { createRuntime } from '../src/server/runtime/index.ts'
import type { WorkItem } from '../src/shared/workbench.ts'

const model = { provider: 'workbench-deadline', modelId: 'worker' }
const questionId = 'deadline-question'
const question = fauxAssistantMessage([fauxToolCall('ask_user_question', {
  questions: [{ id: 'scope', question: '本次包含配套报告吗？', options: [{ label: '包含' }, { label: '只核对清单' }] }],
  escalation: { reason: 'requirement_ambiguity', why: '请求没有说明配套报告是否在验收范围。' },
}, { id: questionId })], { stopReason: 'toolUse' })
const answers = [{ id: 'scope', selected: ['只核对清单'] }]
const deadlineFailure = { code: 'WORKBENCH_TIMEOUT', action: 'retry', retryable: true }

type TestRuntime = Awaited<ReturnType<typeof createRuntime>>

async function fixture(
  worker: FauxResponseFactory,
  verify: (fixture: {
    runtime: TestRuntime
    workspaceId: string
    advanceMinutes(minutes: number): void
    reopen(): Promise<TestRuntime>
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-workbench-deadline-'))
  const workspace = join(root, 'project')
  const models = createModels()
  const faux = fauxProvider({ provider: model.provider, models: [{ id: model.modelId, name: 'Deadline test', input: ['text'] }] })
  const response: FauxResponseFactory = (context, ...rest) => {
    const system = getCurrentSystemMessage(normalizeContext(context).messages)
    const prompt = typeof system?.content === 'string' ? system.content : ''
    if (prompt.includes('根据提供的人类消息，为 AI 编程助手会话生成简短标题')) return fauxAssistantMessage('清单核对')
    if (!prompt.includes('pi-web Agent 工作台的主 Agent')) return worker(context, ...rest)
    return fauxAssistantMessage(fauxText(JSON.stringify({ tasks: [{
      title: '核对清单', objective: '核对清单内容', constraints: [], acceptance: ['提交结果'],
      type: 'investigate', assignee: 'general', dependsOn: [], previous: [],
    }] })))
  }
  faux.setResponses(Array.from({ length: 14 }, () => response))
  models.setProvider(faux.provider)

  const actualNow = Date.now
  let elapsed = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + elapsed)
  let runtime: TestRuntime | undefined
  try {
    await mkdir(workspace)
    const options = { workspace, dataDir: join(root, 'data'), piDir: join(root, 'pi'), demo: true, models }
    runtime = await createRuntime(options)
    await runtime.updateSettings({ codemodeMode: 'off' })
    const workspaceId = runtime.workspaces()[0]!.id
    await runtime.submitWorkbench(workspaceId, { requestId: 'deadline-test', text: '核对清单', model, accessMode: 'readOnly' })
    await verify({
      runtime, workspaceId,
      advanceMinutes: minutes => { elapsed += minutes * 60_000 },
      async reopen() {
        await runtime!.close()
        runtime = await createRuntime(options)
        return runtime
      },
    })
  } finally {
    clock.mockRestore()
    await runtime?.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function waitForItem(
  runtime: TestRuntime, workspaceId: string, matches: (item: WorkItem) => boolean,
): Promise<WorkItem> {
  return vi.waitFor(async () => {
    const view = await runtime.workbench(workspaceId)
    const item = view.items[0]
    if (!item || !matches(item)) throw new Error(JSON.stringify({ item, error: view.messages[0]?.error }))
    return item
  }, { timeout: 8_000, interval: 60 })
}

async function untilAbort(signal: AbortSignal | undefined) {
  if (!signal) throw new Error('The model must receive an abort signal')
  if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  return fauxAssistantMessage('', { stopReason: 'aborted' })
}

it('ends an over-budget worker and gives an explicit retry a new execution budget', async () => {
  let calls = 0
  await fixture((_context, options) => {
    calls += 1
    return calls === 1 ? untilAbort(options?.signal) : fauxAssistantMessage('重新核对完成')
  }, async ({ runtime, workspaceId, advanceMinutes }) => {
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 8_000 })
    const item = await waitForItem(runtime, workspaceId, candidate => candidate.status === 'running')
    advanceMinutes(14)
    await delay(1_250)
    expect((await runtime.detail(item.childId!)).conversation.busy).toBe(true)
    advanceMinutes(1)
    const expired = await waitForItem(runtime, workspaceId, candidate => candidate.failure !== undefined)
    expect(expired).toMatchObject({ status: 'needs_human', attempt: 1, failure: deadlineFailure })
    expect((await runtime.detail(item.childId!)).conversation.busy).toBe(false)
    expect((await runtime.decisionInbox.list(workspaceId)).mails).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'exception', actionable: true, link: expect.objectContaining({ workItemId: item.id }) }),
    ]))
    await runtime.retryWorkbench(workspaceId, { itemId: item.id, attempt: 1 })
    const reviewed = await waitForItem(runtime, workspaceId, candidate => candidate.status === 'pending_review')
    expect(reviewed).toMatchObject({ id: item.id, childId: item.childId, attempt: 2 })
    expect(reviewed.failure).toBeUndefined()
  })
}, 16_000)

it('expires a worker that still runs with a pending question and disables the old answer', async () => {
  let calls = 0
  await fixture((_context, options) => {
    calls += 1
    return calls === 1 ? question : untilAbort(options?.signal)
  }, async ({ runtime, workspaceId, advanceMinutes }) => {
    const item = await waitForItem(runtime, workspaceId, candidate => candidate.status === 'needs_human')
    expect(item.waitingOn).toEqual({ kind: 'human', detail: questionId })
    expect((await runtime.detail(item.childId!)).conversation.busy).toBe(true)
    advanceMinutes(16)
    const expired = await waitForItem(runtime, workspaceId, candidate => candidate.failure !== undefined)
    expect(expired.failure).toMatchObject(deadlineFailure)
    const child = await runtime.detail(item.childId!)
    expect(child.conversation.busy).toBe(false)
    expect(child.interactions).toMatchObject([{ id: questionId, status: 'cancelled' }])
    await expect(runtime.answerInteraction(item.childId!, questionId, answers)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(calls).toBe(2)
  })
}, 16_000)

it('persists the paused execution budget over restart and uses the remaining minutes after an answer', async () => {
  let finishInitialWork!: () => void
  const initialWork = new Promise<void>(resolve => { finishInitialWork = resolve })
  let calls = 0
  await fixture(async (_context, options) => {
    calls += 1
    if (calls === 1) {
      await initialWork
      return question
    }
    if (calls === 2) return fauxAssistantMessage('等待核对范围')
    return untilAbort(options?.signal)
  }, async ({ runtime, workspaceId, advanceMinutes, reopen }) => {
    try {
      await vi.waitFor(() => expect(calls).toBe(1), { timeout: 8_000 })
      advanceMinutes(13)
    } finally {
      finishInitialWork()
    }
    const item = await waitForItem(runtime, workspaceId, candidate => candidate.status === 'needs_human')
    await vi.waitFor(async () => {
      expect((await runtime.detail(item.childId!)).conversation.busy).toBe(false)
    })
    // Let the real one-second scheduler observe that there is no active turn.
    await delay(1_250)
    advanceMinutes(60)
    const restarted = await reopen()
    const waiting = await waitForItem(restarted, workspaceId, candidate => candidate.status === 'needs_human')
    expect(waiting.failure).toBeUndefined()
    await restarted.answerInteraction(item.childId!, questionId, answers)
    await waitForItem(restarted, workspaceId, candidate => candidate.status === 'running')
    advanceMinutes(3)
    const expired = await waitForItem(restarted, workspaceId, candidate => candidate.failure !== undefined)
    expect(expired).toMatchObject({ attempt: 1, failure: deadlineFailure })
  })
}, 16_000)
