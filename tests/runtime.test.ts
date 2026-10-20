import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime.ts'
import { holdNextDemoResponse } from '../src/server/demo-model.ts'
import { SUBAGENT_TOOL } from '../src/server/subagent-tools.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

const fixtures: Array<{ root: string; closers: Array<() => Promise<void>> }> = []

async function fixture(demo = true, appState?: unknown, mcpConfig?: unknown): Promise<{ root: string; dataDir: string; workspace: string; piDir: string; runtime: Awaited<ReturnType<typeof createRuntime>>; cleanup: { root: string; closers: Array<() => Promise<void>> } }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-web-runtime-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}\n')
  if (appState !== undefined) await writeFile(join(dataDir, 'app-state.json'), JSON.stringify(appState))
  // Demo runtimes read their own MCP file under the data directory, so tests never touch ~/.pi-web.
  if (mcpConfig !== undefined) await writeFile(join(dataDir, 'mcp.json'), JSON.stringify(mcpConfig))
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

async function waitForDetail(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  id: string,
  predicate: (detail: ConversationDetail) => boolean,
  timeoutMs = 20_000,
): Promise<ConversationDetail> {
  let unsubscribe: (() => Promise<void>) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const result = new Promise<ConversationDetail>((resolve, reject) => {
    timeout = setTimeout(() => {
      if (!settled) reject(new Error(`Conversation ${id} did not reach the expected state within ${timeoutMs} ms`))
    }, timeoutMs)
    void runtime.watch(id, (detail) => {
      if (!settled && predicate(detail)) {
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

/** The visible text of one projected message, which is how the reply payloads are asserted. */
function textOf(message: ConversationDetail['messages'][number] | undefined): string {
  return (message?.blocks ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Poll one child's status: the parent's stream cannot observe a child's own entries. */
async function waitForChildStatus(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  parentId: string,
  childId: string,
  status: string,
  timeoutMs = 20_000,
): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createRuntime>>['children']>>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await runtime.children(parentId)
    if (rows.find(item => item.id === childId)?.status === status) return rows
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Subagent ${childId} did not become ${status} within ${timeoutMs} ms`)
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

  it('removes a queued submission and stop preserves remaining queued inputs', async () => {
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
        text: '停止后保留这一条', requestId: 'stop-keeps-me', whenBusy: 'steer',
      })
      expect((await runtime.detail(created.conversation.id)).queue.map(item => item.id)).toEqual([removable.submissionId, retained.submissionId])

      await runtime.removeQueued(created.conversation.id, removable.submissionId)
      expect((await runtime.detail(created.conversation.id)).queue.map(item => item.id)).toEqual([retained.submissionId])
      await runtime.stop(created.conversation.id)
      const stopped = await runtime.detail(created.conversation.id)
      expect(stopped.conversation.busy).toBe(false)
      expect(stopped.queue.map(item => item.id)).toEqual([retained.submissionId])
      expect(stopped.queue[0]?.text).toBe('停止后保留这一条')
    } finally {
      gate.release()
    }
  })

  it('stores the task list the model writes and clears it for the next turn', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({})
    await runtime.submit(created.conversation.id, { text: '[todo] 演示任务清单', requestId: 'todo-run' })
    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    expect(completed.todos).toEqual([
      { content: 'Draft the migration plan', status: 'completed' },
      { content: 'Update the copied fixtures', status: 'completed' },
      { content: 'Run the verification pass', status: 'in_progress' },
      { content: 'Hand the list back', status: 'pending' },
    ])
    await runtime.submit(created.conversation.id, { text: '下一轮任务', requestId: 'todo-next' })
    const next = await waitForCompletedRun(runtime, created.conversation.id)
    expect(next.todos).toBeNull()
    expect(next.messages.length).toBeGreaterThan(completed.messages.length)
  })

  it('ignores legacy plugin switches and keeps every tool enabled', async () => {
    // Old app-state files may contain per-plugin/tool switches; product decision
    // removed that surface, so a disabled entry must not narrow the tool list.
    const { runtime } = await fixture(true, {
      version: 1,
      settings: {
        theme: 'system', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 11,
        transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed',
        codingViews: true, busySendMode: 'followUp', defaultThinkingLevel: 'medium', defaultAccessMode: 'fullAccess',
      },
      workspaces: [],
      plugins: { todo: { enabled: false, tools: { todo_write: false } } },
      presets: [], automations: [], feedback: {},
    })
    const created = await runtime.create({})
    await runtime.submit(created.conversation.id, { text: '[todo] 旧插件开关', requestId: 'legacy-plugin-run' })
    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    expect(completed.todos?.map(item => item.content)).toContain('Draft the migration plan')
  })

  it('asks a question, folds the answer back in, and injects the reply only once', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({})
    await runtime.submit(created.conversation.id, { text: '[ask] 演示问答链路', requestId: 'ask-run' })
    const asked = await waitForDetail(runtime, created.conversation.id, detail =>
      !detail.conversation.busy && detail.interactions?.some(interaction => interaction.status === 'pending') === true)
    const pending = asked.interactions?.find(interaction => interaction.status === 'pending')
    expect(pending?.kind).toBe('question')
    expect(pending?.questions?.map(question => question.id)).toEqual(['scope', 'notes'])
    expect(pending?.questions?.[0]?.options?.map(option => option.label)).toContain('前端交互 (Recommended)')
    const callId = pending?.id
    expect(callId).toBeTruthy()

    await expect(runtime.answerInteraction(created.conversation.id, 'missing-call', []))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.answerInteraction(created.conversation.id, callId!, [
      { id: 'scope', selected: ['不存在的选项'] },
      { id: 'notes', selected: [] },
    ])).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const answers = [
      { id: 'scope', selected: ['前端交互 (Recommended)'] },
      { id: 'notes', selected: [], custom: '保持简洁' },
    ]
    const answered = await runtime.answerInteraction(created.conversation.id, callId!, answers)
    expect(answered.interactions?.find(interaction => interaction.id === callId)?.status).toBe('answered')

    const replyPredicate = (detail: ConversationDetail): boolean =>
      !detail.conversation.busy && detail.messages.some(message => message.role === 'user' && JSON.stringify(message.blocks).includes('answer_to_pending_question'))
    const completed = await waitForDetail(runtime, created.conversation.id, replyPredicate)
    const replies = completed.messages.filter(message => message.role === 'user' && JSON.stringify(message.blocks).includes('answer_to_pending_question'))
    expect(replies).toHaveLength(1)
    expect(JSON.stringify(replies[0]?.blocks)).toContain('answer_to_pending_question')
    expect(JSON.stringify(replies[0]?.blocks)).toContain(callId)
    expect(JSON.stringify(replies[0]?.blocks)).toContain('保持简洁')
    expect(completed.messages.at(-1)?.role).toBe('assistant')
    expect(JSON.stringify(completed.messages.at(-1)?.blocks)).toContain('问答演示到此完成')
    expect(completed.interactions?.find(interaction => interaction.id === callId)?.answer?.answers).toEqual(answers)

    // A repeat answer is idempotent: no second reply message enters the transcript.
    const again = await runtime.answerInteraction(created.conversation.id, callId!, answers)
    const replyCount = again.messages.filter(message => message.role === 'user' && JSON.stringify(message.blocks).includes('answer_to_pending_question')).length
    expect(replyCount).toBe(1)
    expect(again.interactions?.find(interaction => interaction.id === callId)?.status).toBe('answered')
  })

  it('dismisses a pending question set: cancelled in the projection, steered once, and closed to answers', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({})
    const id = created.conversation.id
    await runtime.submit(id, { text: '[ask] 放弃整组问题演示', requestId: 'ask-cancel-run' })
    const asked = await waitForDetail(runtime, id, detail =>
      !detail.conversation.busy && detail.interactions?.some(interaction => interaction.status === 'pending') === true)
    const callId = asked.interactions?.find(interaction => interaction.status === 'pending')?.id
    expect(callId).toBeTruthy()

    await expect(runtime.cancelInteraction(id, 'missing-call')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const cancelled = await runtime.cancelInteraction(id, callId!)
    expect(cancelled.interactions?.find(interaction => interaction.id === callId)).toMatchObject({ status: 'cancelled' })

    const dismissedPredicate = (detail: ConversationDetail): boolean =>
      !detail.conversation.busy && detail.messages.some(message => message.role === 'user' && JSON.stringify(message.blocks).includes('dismissed_pending_question'))
    const steered = await waitForDetail(runtime, id, dismissedPredicate)
    expect(JSON.stringify(steered.messages.find(message => message.role === 'user' && JSON.stringify(message.blocks).includes('dismissed_pending_question'))?.blocks)).toContain(callId)
    // The demo model answers the dismissal, and the transcript never shows a raw payload twice.
    expect(steered.messages.filter(message => message.role === 'user' && JSON.stringify(message.blocks).includes('dismissed_pending_question'))).toHaveLength(1)

    // A settled call stays settled: cancelling again is idempotent, an answer is a conflict.
    const repeat = await runtime.cancelInteraction(id, callId!)
    expect(repeat.interactions?.find(interaction => interaction.id === callId)?.status).toBe('cancelled')
    const dismissedCount = repeat.messages.filter(message => message.role === 'user' && JSON.stringify(message.blocks).includes('dismissed_pending_question')).length
    expect(dismissedCount).toBe(1)
    await expect(runtime.answerInteraction(id, callId!, [
      { id: 'scope', selected: ['前端交互 (Recommended)'] },
      { id: 'notes', selected: [] },
    ])).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('runs plan mode: refuses without the switch, submits for review, revises, and stops on approval', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({})
    const id = created.conversation.id
    expect((await runtime.detail(id)).plan).toEqual({ active: false })

    // Without the switch the tool refuses, and both the tool error and the answer tell the model how to recover.
    await runtime.submit(id, { text: '[plan] 计划模式未开启时提交', requestId: 'plan-off' })
    const refused = await waitForCompletedRun(runtime, id)
    const refusal = refused.messages.find(message => message.role === 'tool' && message.toolName === 'exit_plan_mode')
    expect(refusal?.isError).toBe(true)
    expect(textOf(refusal)).toContain('Plan mode is not active')
    expect(textOf(refused.messages.at(-1))).toContain('计划模式当前没有开启')
    expect(refused.interactions ?? []).toEqual([])

    // The switch is idempotent and bound to an existing conversation.
    expect((await runtime.setPlan(id, true)).plan).toEqual({ active: true })
    expect((await runtime.setPlan(id, true)).plan).toEqual({ active: true })
    await expect(runtime.setPlan('9999', true)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Submitting a plan creates the pending review, settles the tool with a notice, and keeps plan mode on.
    await runtime.submit(id, { text: '[plan] 演示计划模式', requestId: 'plan-run-1' })
    const submitted = await waitForDetail(runtime, id, detail =>
      !detail.conversation.busy && detail.interactions?.some(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending') === true)
    const first = submitted.interactions?.find(interaction => interaction.kind === 'plan-review')
    expect(first?.id).toBeTruthy()
    expect(first?.approveLabel).toBe('同意执行')
    expect(first?.detail?.startsWith('# ')).toBe(true)
    expect(first?.detail).toContain('演示计划')
    expect(submitted.plan).toEqual({ active: true })
    const planResults = submitted.messages.filter(message => message.role === 'tool' && message.toolName === 'exit_plan_mode')
    const firstResult = planResults.at(-1)
    expect(firstResult?.isError).toBeFalsy()
    expect(textOf(firstResult)).toContain('pending')
    expect(textOf(submitted.messages.at(-1))).toContain('计划已提交待审')

    // A change request settles the review, keeps plan mode on, and hands the feedback to the model,
    // which answers with a revised plan submitted as a new review.
    const askedChanges = await runtime.answerInteraction(id, first!.id, [
      { id: 'plan-review', selected: ['要求修改'], custom: '补上回滚说明' },
    ])
    expect(askedChanges.plan).toEqual({ active: true })
    expect(askedChanges.interactions?.find(interaction => interaction.id === first!.id))
      .toMatchObject({ status: 'answered', approved: false, feedback: '要求修改; 补上回滚说明' })

    const revised = await waitForDetail(runtime, id, detail => !detail.conversation.busy
      && detail.interactions?.some(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending' && interaction.id !== first!.id) === true)
    const second = revised.interactions?.find(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending')
    expect(second?.detail).toContain('修订')
    expect(revised.plan).toEqual({ active: true })
    // The refused call from the first turn is still in the transcript, so only the successful ones count.
    expect(revised.messages.filter(message => message.role === 'tool' && message.toolName === 'exit_plan_mode' && message.isError !== true)).toHaveLength(2)
    const changeReply = revised.messages.find(message => message.role === 'user' && message.blocks.some(block => block.type === 'text' && block.text.includes('plan-review')))
    expect(textOf(changeReply)).toContain('补上回滚说明')
    expect(textOf(changeReply)).toContain('"approved":false')

    // Dismissing a review in the UI leaves it undecided, so the next submission settles it as
    // superseded instead of letting the stale review become the live one again.
    const dismissed = await runtime.create({})
    const dismissedId = dismissed.conversation.id
    await runtime.setPlan(dismissedId, true)
    await runtime.submit(dismissedId, { text: '[plan] 先提交一版，再用消息要求修改', requestId: 'plan-supersede-1' })
    const firstDraft = await waitForDetail(runtime, dismissedId, detail =>
      !detail.conversation.busy && detail.interactions?.some(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending') === true)
    const superseded = firstDraft.interactions?.find(interaction => interaction.kind === 'plan-review')
    await runtime.submit(dismissedId, { text: '再补充风险一节', requestId: 'plan-supersede-2' })
    const superseding = await waitForDetail(runtime, dismissedId, detail => !detail.conversation.busy
      && detail.interactions?.some(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending' && interaction.id !== superseded!.id) === true)
    expect(superseding.interactions?.find(interaction => interaction.id === superseded!.id)).toMatchObject({ status: 'continued' })
    expect(superseding.interactions?.filter(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending')).toHaveLength(1)
    expect(superseding.plan).toEqual({ active: true })
    // Answering a superseded review is a no-op: nothing is waiting on it.
    const stale = await runtime.answerInteraction(dismissedId, superseded!.id, [{ id: 'plan-review', selected: ['同意执行'] }])
    expect(stale.plan).toEqual({ active: true })
    expect(stale.interactions?.find(interaction => interaction.id === superseded!.id)).toMatchObject({ status: 'continued' })

    // A third submission is refused by the demo model itself, which stops resubmitting after two rounds.
    await runtime.submit(id, { text: '再补充风险一节', requestId: 'plan-run-3' })
    const capped = await waitForCompletedRun(runtime, id)
    expect(capped.plan).toEqual({ active: true })
    expect(capped.messages.filter(message => message.role === 'tool' && message.toolName === 'exit_plan_mode' && message.isError !== true)).toHaveLength(2)
    expect(textOf(capped.messages.at(-1))).toContain('不会再自动提交')

    // Approving turns plan mode off in the same settlement and the model reports the execution.
    const approved = await runtime.answerInteraction(id, second!.id, [{ id: 'plan-review', selected: ['同意执行'] }])
    expect(approved.plan).toEqual({ active: false })
    expect(approved.interactions?.find(interaction => interaction.id === second!.id))
      .toMatchObject({ status: 'answered', approved: true })

    const executed = await waitForDetail(runtime, id, detail => !detail.conversation.busy
      && detail.messages.some(message => message.role === 'assistant' && JSON.stringify(message.blocks).includes('演示执行完成')))
    expect(executed.plan).toEqual({ active: false })
    const approvalReplies = executed.messages.filter(message => message.role === 'user' && textOf(message).includes('"approved":true'))
    expect(approvalReplies).toHaveLength(1)

    // A repeat answer is idempotent: no second reply message enters the transcript.
    const again = await runtime.answerInteraction(id, second!.id, [{ id: 'plan-review', selected: ['同意执行'] }])
    expect(again.messages.filter(message => message.role === 'user' && textOf(message).includes('"approved":true'))).toHaveLength(1)
    expect(again.plan).toEqual({ active: false })
  })

  it('creates a goal through the tool and lets the user pause it', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({})
    await runtime.submit(created.conversation.id, { text: '[goal] 演示目标', requestId: 'goal-run' })
    const detail = await waitForCompletedRun(runtime, created.conversation.id)
    expect(detail.goal?.phase).toBe('active')
    expect(detail.goal?.maxGoalRounds).toBe(3)
    expect(detail.goal?.objective).toContain('完成演示迁移')
    const paused = await runtime.goal(created.conversation.id, { action: 'pause' })
    expect(paused.goal?.phase).toBe('paused')
    const cleared = await runtime.goal(created.conversation.id, { action: 'clear' })
    expect(cleared.goal ?? null).toBeNull()
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
    const { runtime, dataDir, piDir, cleanup } = await fixture(false)
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
    const modelFile = await stat(join(piDir, 'models.json'))
    const authFile = await stat(join(piDir, 'auth.json'))
    const dataDirectory = await stat(dataDir)
    expect(modelFile.mode & 0o777).toBe(0o600)
    expect(authFile.mode & 0o777).toBe(0o600)
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

  it('deletes a workspace, rebinding its sessions, and refuses to drop the last one', async () => {
    const { runtime, root } = await fixture()
    const second = join(root, 'second-workspace')
    await mkdir(second, { recursive: true })
    const added = await runtime.addWorkspace({ path: second, name: 'Second' })
    const bound = await runtime.create({ title: 'Bound elsewhere', workspaceId: added.id })
    expect(bound.conversation.workspaceId).toBe(added.id)

    await runtime.deleteWorkspace(added.id)

    expect(runtime.workspaces().map(workspace => workspace.id)).not.toContain(added.id)
    // The session must not keep a dangling binding.
    const rebound = await runtime.detail(bound.conversation.id)
    expect(rebound.conversation.workspaceId).not.toBe(added.id)
    expect(runtime.workspaces().map(workspace => workspace.id)).toContain(rebound.conversation.workspaceId)

    const last = runtime.workspaces()[0]
    await expect(runtime.deleteWorkspace(last?.id ?? '')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime.deleteWorkspace('missing-workspace')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('blocks deleting a workspace referenced by a disabled automation, then allows removal after reassignment', async () => {
    const { runtime, root } = await fixture()
    const secondPath = join(root, 'automation-workspace')
    await mkdir(secondPath, { recursive: true })
    const workspace = await runtime.addWorkspace({ path: secondPath, name: 'Automation workspace' })
    const bound = await runtime.create({ title: 'Bound automation workspace', workspaceId: workspace.id })
    const automation = await runtime.createAutomation({
      name: 'Paused workspace task',
      prompt: 'Inspect this workspace',
      enabled: false,
      workspaceId: workspace.id,
    })

    await expect(runtime.deleteWorkspace(workspace.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining(`${automation.name}（${automation.id}）`),
    })
    expect(runtime.workspaces().some(item => item.id === workspace.id)).toBe(true)
    expect((await runtime.detail(bound.conversation.id)).conversation.workspaceId).toBe(workspace.id)

    const fallbackId = runtime.settings().defaultWorkspaceId
    expect(fallbackId).toBeTruthy()
    await runtime.updateAutomation(automation.id, { workspaceId: fallbackId })
    await runtime.deleteWorkspace(workspace.id)
    expect(runtime.workspaces().some(item => item.id === workspace.id)).toBe(false)
    expect((await runtime.detail(bound.conversation.id)).conversation.workspaceId).toBe(fallbackId)
  })

  it('serializes workspace removal against an automation being created concurrently', async () => {
    const { runtime, root } = await fixture()
    const secondPath = join(root, 'concurrent-automation-workspace')
    await mkdir(secondPath, { recursive: true })
    const workspace = await runtime.addWorkspace({ path: secondPath, name: 'Concurrent workspace' })

    const deleting = runtime.deleteWorkspace(workspace.id)
    const creating = runtime.createAutomation({
      name: 'Racing task',
      prompt: 'Inspect this workspace',
      enabled: false,
      workspaceId: workspace.id,
    })
    await expect(deleting).resolves.toBeUndefined()
    await expect(creating).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(runtime.automations()).toHaveLength(0)
    expect(runtime.workspaces().some(item => item.id === workspace.id)).toBe(false)
  })

  it('blocks deleting a preset referenced by an automation until it is reassigned', async () => {
    const { runtime } = await fixture()
    const first = await runtime.createPreset({
      name: 'Scheduled preset', instructions: '', extensions: [], tools: [], accessMode: 'readOnly',
    })
    const second = await runtime.createPreset({
      name: 'Replacement preset', instructions: '', extensions: [], tools: [], accessMode: 'readOnly',
    })
    const automation = await runtime.createAutomation({
      name: 'Preset task', prompt: 'Run with the selected preset', enabled: false, presetId: first.id,
    })

    await expect(runtime.deletePreset(first.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining(`${automation.name}（${automation.id}）`),
    })
    expect(runtime.presets().some(item => item.id === first.id)).toBe(true)

    await runtime.updateAutomation(automation.id, { presetId: second.id })
    await runtime.deletePreset(first.id)
    expect(runtime.presets().some(item => item.id === first.id)).toBe(false)
  })

  it('recovers an overdue automation after the runtime restarts', async () => {
    const { runtime, dataDir, workspace, piDir, cleanup } = await fixture()
    const automation = await runtime.createAutomation({
      name: 'Restarted task', prompt: 'Verify startup recovery', enabled: true, intervalMs: 60_000,
    })
    await runtime.close()

    const statePath = join(dataDir, 'app-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { automations: Array<{ id: string; nextRunAt?: number }> }
    const saved = state.automations.find(item => item.id === automation.id)
    expect(saved).toBeDefined()
    saved!.nextRunAt = Date.now() - 1
    await writeFile(statePath, JSON.stringify(state))

    const reopened = await createRuntime({ dataDir, workspace, piDir, demo: true })
    cleanup.closers.push(() => reopened.close())
    const deadline = Date.now() + 20_000
    let recovered = reopened.automations().find(item => item.id === automation.id)
    while (Date.now() < deadline && recovered?.lastRun?.status !== 'completed') {
      await new Promise(resolve => setTimeout(resolve, 25))
      recovered = reopened.automations().find(item => item.id === automation.id)
    }
    expect(recovered?.lastRun?.status).toBe('completed')
    expect(recovered?.lastRun?.conversationId).toBeTruthy()
  })

  it('does not run a 30-day automation immediately after restart', async () => {
    const { runtime, dataDir, workspace, piDir, cleanup } = await fixture()
    const intervalMs = 30 * 24 * 60 * 60 * 1000
    const automation = await runtime.createAutomation({
      name: 'Long interval task', prompt: 'Wait for its due time', enabled: true, intervalMs,
    })
    await runtime.close()

    const reopened = await createRuntime({ dataDir, workspace, piDir, demo: true })
    cleanup.closers.push(() => reopened.close())
    await new Promise(resolve => setTimeout(resolve, 50))
    const recovered = reopened.automations().find(item => item.id === automation.id)
    expect(recovered?.lastRun).toBeUndefined()
    expect(recovered?.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('spawns teammates as background child conversations and projects the roster and the board', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Team parent' })
    expect((await runtime.detail(parent.conversation.id)).team).toBeUndefined()

    await runtime.submit(parent.conversation.id, { text: '[team] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)

    const team = detail.team
    expect(team?.members.map(member => [member.name, member.role, member.phase, member.status])).toEqual([
      ['lead', 'lead', 'active', 'inactive'],
      ['researcher', 'teammate', 'active', 'inactive'],
      ['writer', 'teammate', 'active', 'inactive'],
    ])
    expect(team?.members[1]?.label).toBe('资料调研')
    expect(team?.members[1]?.model).toBe('pi-web-demo/demo-model')
    expect(team?.tasks.map(item => [item.id, item.status, item.ready, item.blocked])).toEqual([
      ['task-1', 'pending', true, false],
      ['task-2', 'pending', false, true],
    ])
    expect(team?.tasks[1]?.blockedBy).toEqual(['task-1'])
    expect(team?.tasks[0]?.writeScopes).toEqual(['src/web'])

    // Every teammate is a real child conversation that stays out of the sidebar.
    const children = await runtime.children(parent.conversation.id)
    expect(children.map(row => row.label)).toEqual(['资料调研', '面板实现'])
    expect((await runtime.list()).map(item => item.id)).toEqual([parent.conversation.id])
    const childDetail = await runtime.detail(children[0]?.id ?? '')
    expect(childDetail.conversation.origin).toBe('subagent')
    expect(childDetail.conversation.parentId).toBe(parent.conversation.id)
    expect(textOf(childDetail.messages.find(message => message.role === 'user'))).toContain('[team-child]')

    // The spawn tool rows carry the child ids so the panel can open a member directly.
    const spawnRows = detail.messages.filter(message => message.toolName === 'spawn_teammate')
    expect(spawnRows.map(message => (message.details as { conversationId?: string } | undefined)?.conversationId))
      .toEqual(children.map(row => row.id))

    // The explicit route projects the same rows, and refuses an unknown conversation.
    expect((await runtime.team(parent.conversation.id)).members.map(member => member.name)).toEqual(['lead', 'researcher', 'writer'])
    await expect(runtime.team('9999')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.team('not-a-number')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('delivers a teammate message without waiting for its answer, even in a read-only conversation', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Team messages', accessMode: 'readOnly' })
    await runtime.submit(parent.conversation.id, { text: '[team-message] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)
    expect(detail.conversation.accessMode).toBe('readOnly')

    const childId = (await runtime.children(parent.conversation.id))[0]?.id ?? ''
    const child = await waitForDetail(runtime, childId, value =>
      value.messages.some(message => message.role === 'assistant' && textOf(message).includes('进度：资料已整理完')), 20_000)
    const userTexts = child.messages.filter(message => message.role === 'user').map(textOf)
    expect(userTexts.some(text => text.includes('[team-child] 先整理资料'))).toBe(true)
    // DSH frames a peer message with its sender (`index.ts:230-233`).
    expect(userTexts.some(text => text.includes('Team message from lead:') && text.includes('[team-child-followup]'))).toBe(true)

    // list_agents reports the durable row with its phase and live availability.
    const listed = detail.messages.find(message => message.toolName === 'list_agents')
    const rows = JSON.parse(textOf(listed)) as Array<{ name: string; role: string; phase: string }>
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'helper', role: 'teammate', phase: 'active' })]))
    expect(rows.map(row => row.name)).toEqual(['lead', 'helper'])
  })

  it('answers wait_agent with no-active-peer at once and times out while a member runs', async () => {
    const { runtime } = await fixture()
    const idle = await runtime.create({ title: 'Team wait' })
    await runtime.submit(idle.conversation.id, { text: '[team-wait] 演示', requestId: randomUUID() })
    const idleDetail = await waitForCompletedRun(runtime, idle.conversation.id)
    const immediate = idleDetail.messages.find(message => message.toolName === 'wait_agent')
    expect(immediate?.isError).not.toBe(true)
    expect(textOf(immediate)).toContain('"reason": "no-active-peer"')
    expect(textOf(immediate)).toContain('"timedOut": false')
    expect((immediate?.details as { noProgress?: { reason?: string } } | undefined)?.noProgress?.reason).toBe('no-active-peer')

    // One running member: the call waits its bound out and reports timedOut.
    const gated = await runtime.create({ title: 'Team wait timeout' })
    await runtime.submit(gated.conversation.id, { text: '[team-wait-timeout] 演示', requestId: randomUUID() })
    const timeoutDetail = await waitForDetail(runtime, gated.conversation.id,
      value => !value.conversation.busy && value.messages.some(message => message.toolName === 'wait_agent'), 40_000)
    const waited = timeoutDetail.messages.filter(message => message.toolName === 'wait_agent').at(-1)
    expect(waited?.isError).not.toBe(true)
    expect(textOf(waited)).toContain('"timedOut": true')
    expect((waited?.details as { timedOut?: boolean } | undefined)?.timedOut).toBe(true)
  }, 60_000)

  it('drives a shared task through claim, a stale rejection, and complete', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Team tasks' })
    await runtime.submit(parent.conversation.id, { text: '[team-task] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)

    const updates = detail.messages.filter(message => message.toolName === 'team_task_update')
    expect(updates).toHaveLength(3)
    expect(updates[0]?.isError).not.toBe(true)
    expect(textOf(updates[0])).toContain('"status": "in_progress"')
    // The deliberately stale release is rejected with the current revision in the message.
    expect(updates[1]?.isError).toBe(true)
    expect(textOf(updates[1])).toContain('stale team task "task-1" revision 1; current revision is 2')
    expect(updates[2]?.isError).not.toBe(true)

    const tasks = detail.team?.tasks ?? []
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 'task-1', status: 'completed', ownerName: 'lead', revision: 3 })
    expect(tasks[0]?.ready).toBe(false)
  })

  it('delegates one foreground child conversation and projects its answer', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Subagent parent' })
    await runtime.submit(parent.conversation.id, { text: '[subagent] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)

    // The child's answer reaches the model through the tool result, not the parent's own text.
    const toolResult = detail.messages.find(message => message.role === 'tool' && message.toolName === SUBAGENT_TOOL)
    expect(toolResult?.isError).not.toBe(true)
    expect(textOf(toolResult)).toContain('子智能体一期机制小结')

    const rows = detail.subagents ?? []
    expect(rows).toHaveLength(1)
    const child = rows[0]
    expect(child?.label).toBe('机制归纳')
    expect(child?.title).toBe('机制归纳')
    expect(child?.status).toBe('inactive')
    expect(child?.answer).toContain('子智能体一期机制小结')
    expect(child?.updatedAt).toBeGreaterThanOrEqual(child?.createdAt ?? 0)
    expect(child?.id).not.toBe(parent.conversation.id)

    // The owner edge decides membership: the child is a real conversation with its own transcript.
    const childDetail = await runtime.detail(child?.id ?? '')
    expect(childDetail.conversation.title).toBe('机制归纳')
    expect(childDetail.conversation.origin).toBe('subagent')
    expect(childDetail.conversation.parentId).toBe(parent.conversation.id)
    expect(detail.conversation.origin).toBeUndefined()
    expect(textOf(childDetail.messages.find(message => message.role === 'user'))).toContain('[subagent-child]')
    expect(textOf(childDetail.messages.filter(message => message.role === 'assistant').at(-1))).toContain('子智能体一期机制小结')

    // Children stay out of the sidebar list, and a child owns no children of its own.
    expect((await runtime.list()).map(item => item.id)).toEqual([parent.conversation.id])
    expect(await runtime.children(child?.id ?? '')).toEqual([])
    expect((await runtime.children(parent.conversation.id)).map(row => row.id)).toEqual([child?.id])
  })

  it('delegates from a read-only conversation, where the tool has no workspace side effect', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Read-only delegation', accessMode: 'readOnly' })
    await runtime.submit(parent.conversation.id, { text: '[subagent] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)

    expect(detail.conversation.accessMode).toBe('readOnly')
    const toolResult = detail.messages.find(message => message.role === 'tool' && message.toolName === SUBAGENT_TOOL)
    expect(toolResult?.isError).not.toBe(true)
    expect(detail.subagents?.[0]?.answer).toContain('子智能体一期机制小结')
  })

  it('delivers follow-ups to one child and stops a running child, refusing every other target', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Subagent control' })
    await runtime.submit(parent.conversation.id, { text: '[subagent] 演示', requestId: randomUUID() })
    await waitForCompletedRun(runtime, parent.conversation.id)
    const childId = (await runtime.children(parent.conversation.id))[0]?.id ?? ''
    const other = await runtime.create({ title: 'Unrelated' })

    // A foreign conversation is never a control target, whichever side of the edge it sits on.
    await expect(runtime.childMessage(parent.conversation.id, other.conversation.id, { text: '你好', requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.childStop(parent.conversation.id, other.conversation.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.childStop(other.conversation.id, childId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.childStop(parent.conversation.id, '999999')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // A follow-up reaches the child and starts its next run.
    const gate = holdNextDemoResponse()
    try {
      await runtime.childMessage(parent.conversation.id, childId, { text: '再补充一条结论', requestId: randomUUID() })
      const running = await waitForChildStatus(runtime, parent.conversation.id, childId, 'running')
      expect(running[0]?.id).toBe(childId)
      const stopped = await runtime.childStop(parent.conversation.id, childId)
      expect(stopped[0]?.status).toBe('inactive')
      const childDetail = await runtime.detail(childId)
      expect(textOf(childDetail.messages.find(message => message.role === 'user' && textOf(message).includes('再补充一条结论')))).toContain('再补充一条结论')
      expect(childDetail.conversation.busy).toBe(false)
    } finally {
      gate.release()
    }
  })

  it('runs model-written code mode scripts against the conversation tools', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({ title: 'Code mode' })
    await runtime.submit(created.conversation.id, { text: '[codemode] 演示', requestId: randomUUID() })
    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    const codemode = completed.messages.find(message => message.role === 'tool' && message.toolName === 'codemode')
    expect(codemode?.isError).toBeFalsy()
    // The script's output is what the model sees, and its nested bash call is in the details.
    expect(textOf(codemode)).toContain('codemode-ok')
    expect(JSON.stringify(codemode?.details)).toContain('bash')
    expect(completed.messages.some(message => message.role === 'assistant' && textOf(message).includes('codemode-ok'))).toBe(true)
  })

  it('switches code mode between the native and script-only presentations for existing conversations', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({ title: 'Code mode switch' })

    // Default `on`: a direct bash call is offered to the model and runs.
    await runtime.submit(created.conversation.id, { text: '[direct-tool] 第一次', requestId: randomUUID() })
    const on = await waitForCompletedRun(runtime, created.conversation.id)
    expect(on.messages.find(message => message.role === 'tool' && message.toolName === 'bash')?.isError).toBeFalsy()

    // `only`: the model sees just codemode, so the same direct call is refused.
    await runtime.updateSettings({ codemodeMode: 'only' })
    await runtime.submit(created.conversation.id, { text: '[direct-tool] 第二次', requestId: randomUUID() })
    const only = await waitForCompletedRun(runtime, created.conversation.id)
    const refused = [...only.messages].reverse().find(message => message.role === 'tool' && message.toolName === 'bash')
    expect(refused?.isError).toBe(true)
    expect(runtime.settings().codemodeMode).toBe('only')

    // `off` then back `on`: the stored script-only filter is cleared, so codemode works again.
    await runtime.updateSettings({ codemodeMode: 'off' })
    await runtime.submit(created.conversation.id, { text: '[codemode] 关闭后再试', requestId: randomUUID() })
    const off = await waitForCompletedRun(runtime, created.conversation.id)
    const absent = [...off.messages].reverse().find(message => message.role === 'tool' && message.toolName === 'codemode')
    expect(absent?.isError).toBe(true)

    await runtime.updateSettings({ codemodeMode: 'on' })
    await runtime.submit(created.conversation.id, { text: '[codemode] 重新开启', requestId: randomUUID() })
    const back = await waitForCompletedRun(runtime, created.conversation.id)
    const restored = [...back.messages].reverse().find(message => message.role === 'tool' && message.toolName === 'codemode')
    expect(restored?.isError).toBeFalsy()
    expect(textOf(restored)).toContain('codemode-ok')

    // `on` restores the native tools too: a stale script-only filter would refuse them.
    await runtime.submit(created.conversation.id, { text: '[direct-tool] 重新开启后', requestId: randomUUID() })
    const directBack = await waitForCompletedRun(runtime, created.conversation.id)
    expect([...directBack.messages].reverse().find(message => message.role === 'tool' && message.toolName === 'bash')?.isError).toBeFalsy()
  })

  it('imports the Pi MCP file read-only and keeps serving when a server cannot start', async () => {
    const empty = await fixture()
    expect(empty.runtime.mcp().configExists).toBe(false)
    expect(empty.runtime.mcp().servers).toEqual([])
    expect(empty.runtime.mcp().configPath).toBe(join(empty.dataDir, 'mcp.json'))

    const broken = await fixture(true, undefined, {
      mcpServers: { broken: { command: 'definitely-not-a-pi-web-command' } },
    })
    const view = broken.runtime.mcp()
    expect(view.configExists).toBe(true)
    expect(view.servers).toHaveLength(1)
    expect(view.servers[0]?.status).toBe('error')
    expect(view.servers[0]?.error).toBeTruthy()
    // A failing MCP server never keeps the runtime from creating conversations.
    expect((await broken.runtime.create({ title: 'Still up' })).conversation.id).toBeTruthy()
  })
})
