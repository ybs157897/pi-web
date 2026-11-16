import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { compileRule, systemTimeZone } from '../src/shared/automation-timing.ts'

/**
 * Pi Durable runtime 的端到端契约测试：会话创建/提交/投影、去重与队列控制、
 * 未读标记、交互问答（ask/dismiss）、计划模式全流程、目标（goal）、
 * 元数据持久化与 fork、自定义 provider 与凭据卫生、workspace 生命周期与自动化、
 * 团队/子智能体委派、code mode 三态切换、MCP 只读导入与容错，
 * 以及直连 harness 的后台委派结算链路。
 */

/** 以当前时刻为锚点的分钟间隔规则，供重启恢复用例使用。 */
const everyMinutes = (minutes: number): string => compileRule({
  frequency: 'minutes', interval: String(minutes), weekdays: [1], monthDay: 1,
  date: '', time: '00:00', timeZone: systemTimeZone(),
}, Date.now()) as string
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { Harness, createRegistry, defineTask, type Conversation, type ConversationId, type TaskId } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createRuntime } from '../src/server/runtime/index.ts'
import { CTX, META } from '../src/server/runtime/helpers.ts'
import { SUBAGENT_SETTLEMENT_MARKER, createSubagentSettlement } from '../src/server/runtime/subagent-settle.ts'
import { holdNextDemoResponse, observeDemoRequests, createDemoModelRuntime } from '../src/server/model/demo.ts'
import { CodingTools } from '../src/server/tools/shell/tools.ts'
import { createSubagentTools, Subagents, SUBAGENT_TOOL } from '../src/server/tools/subagent.ts'
import { createExecutionEnv } from '../src/server/conversation/execution-env.ts'
import { getCurrentSystemMessage, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { ConversationDetail } from '../src/shared/types.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

const fixtures: Array<{ root: string; closers: Array<() => Promise<void>> }> = []

/**
 * 构造完整 runtime fixture：临时数据目录 + workspace + pi 目录（demo 模式）。
 * @param demo 是否启用 demo 模型（false 时需要手动配 provider）
 * @param appState 预写的 app-state.json 内容（如旧版设置/插件开关）
 * @param mcpConfig 预写的 mcp.json 内容
 * @returns 各目录路径与 runtime；cleanup 已登记进 fixtures 供 afterEach 清理
 */
async function fixture(demo = true, appState?: unknown, mcpConfig?: unknown): Promise<{ root: string; dataDir: string; workspace: string; piDir: string; runtime: Awaited<ReturnType<typeof createRuntime>>; cleanup: { root: string; closers: Array<() => Promise<void>> } }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-web-runtime-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}\n')
  if (appState !== undefined) await writeFile(join(dataDir, 'app-state.json'), JSON.stringify(appState))
  // Demo runtime 读取数据目录下自己的 MCP 文件，测试永远不会碰到 ~/.pi-web。
  if (mcpConfig !== undefined) await writeFile(join(dataDir, 'mcp.json'), JSON.stringify(mcpConfig))
  const runtime = await createRuntime({ dataDir, workspace, piDir, demo })
  const cleanup = { root, closers: [() => runtime.close()] }
  fixtures.push(cleanup)
  return { root, dataDir, workspace, piDir, runtime, cleanup }
}

afterEach(async () => {
  // 关闭全部 runtime 并删除临时目录，回收所有 fixture。
  const pending = fixtures.splice(0)
  await Promise.all(pending.map(async ({ closers, root }) => {
    await Promise.all(closers.map(close => close()))
    await rm(root, { recursive: true, force: true })
  }))
})

/**
 * 等待会话完成一轮运行：watch 流上出现非 streaming 的助手文本且会话不再 busy。
 * @param timeoutMs 超时上限（默认 20 秒），超时抛错
 */
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

/**
 * 轮询会话详情直到自定义谓词成立。
 * @param predicate 判定详情是否达到期望状态
 * @param timeoutMs 超时上限（默认 20 秒），超时抛错
 */
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

/**
 * 取一条投影消息的可见文本，回复载荷的断言都基于它。
 */
function textOf(message: ConversationDetail['messages'][number] | undefined): string {
  return (message?.blocks ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * 轮询子会话状态直到达到期望值。
 * 父会话的 watch 流观察不到子会话自身的条目，必须轮询 children 列表。
 */
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
  // 基础链路：watch 立即给出初始快照（空消息）；同一 requestId 重放返回同一结果、
  // 同 id 不同内容报 CONFLICT；真实 CodingTools（write/read/bash|pwsh）跑通并落盘，
  // 助手消息带 thinking 块与 Markdown 表格总结。
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
    expect(toolResults.map(message => message.toolName)).toEqual(expect.arrayContaining(['write', 'read', SHELL_TOOL]))
    expect(completed.messages.some(message => message.role === 'assistant' && message.blocks.some(block => block.type === 'thinking'))).toBe(true)
    expect(completed.messages.some(message => message.role === 'assistant' && message.blocks.some(block => block.type === 'text' && block.text.includes('| 检查方式 |')))).toBe(true)
    expect(await readFile(join(workspace, 'hello.txt'), 'utf8')).toBe('Hello from Pi Durable Web.\n')
  })

  // 未读标记：新回答完成 → unread=true；读详情视为「已打开」，红点清除。
  // 创建会话本身算作查看，空会话行无红点。
  it('marks a finished reply unread until the conversation is viewed again', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({ title: 'Unread marker' })
    const unreadOf = async () => (await runtime.list()).find(item => item.id === created.conversation.id)?.unread
    // Creating a conversation counts as viewing it, so the empty row carries no dot.
    expect(await unreadOf()).toBeUndefined()

    await runtime.submit(created.conversation.id, { text: '给出一个简短回答', requestId: randomUUID() })
    await waitForCompletedRun(runtime, created.conversation.id)
    expect(await unreadOf()).toBe(true)

    // Reading the detail is the client's "opened this conversation"; the dot stays cleared.
    await runtime.detail(created.conversation.id)
    expect(await unreadOf()).toBeUndefined()
  })

  // 队列控制：busy 时 followUp/steer 排队；removeQueued 只撤目标一条；
  // stop 结束当前运行但保留队列中剩余输入。
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

  // Todo 生命周期：模型写入的任务清单投影到 detail.todos 并持久；
  // 下一轮无 Todo 时清为 null（不残留上一轮清单）。
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
    // 旧 app-state 可能带按插件/工具的开关；产品已移除该面，
    // disabled 条目不得收窄工具清单（todo_write 仍可用）。
    const { runtime } = await fixture(true, {
      version: 1,
      settings: {
        theme: 'system', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 11,
        transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed',
        codingViews: true, busySendMode: 'followUp', defaultThinkingLevel: 'medium', defaultAccessMode: 'fullAccess',
      },
      workspaces: [],
      plugins: { todo: { enabled: false, tools: { todo_write: false } } },
      automations: [], feedback: {},
    })
    const created = await runtime.create({})
    await runtime.submit(created.conversation.id, { text: '[todo] 旧插件开关', requestId: 'legacy-plugin-run' })
    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    expect(completed.todos?.map(item => item.content)).toContain('Draft the migration plan')
  })

  // 字体列表归一化：多余空白折叠、无引号的族名加引号、纯空白清空；结果随设置落盘。
  it('normalizes user font lists and persists them with the settings', async () => {
    const { runtime, dataDir } = await fixture()
    const saved = await runtime.updateSettings({
      textFontFamily: ' Inter , system-ui , "SF Pro Text" ',
      codeFontFamily: 'JetBrains Mono',
      terminalFontFamily: '   ',
    })
    expect(saved.textFontFamily).toBe('"Inter", system-ui, "SF Pro Text"')
    expect(saved.codeFontFamily).toBe('"JetBrains Mono"')
    expect(saved.terminalFontFamily).toBe('')
    const onDisk = JSON.parse(await readFile(join(dataDir, 'app-state.json'), 'utf8')) as { settings: Record<string, unknown> }
    expect(onDisk.settings.textFontFamily).toBe('"Inter", system-ui, "SF Pro Text"')
  })

  // 问答链路：[ask] 触发 pending question 集合（scope/notes 两问、带推荐项）；
  // 未知 callId 报 NOT_FOUND、无效选项报 INVALID_INPUT；回答折叠为带
  // answer_to_pending_question 的用户消息恰好一次（重复回答幂等），模型据此收尾。
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

  // 放弃问题组：cancel 后投影为 cancelled、以 dismissed_pending_question steer 恰好一次；
  // 已结算的调用重复取消幂等，再回答报 CONFLICT。
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

  // 计划模式全流程：模型自行 enter_plan_mode（未开模式时 exit 拒绝并指路）→
  // 提交计划待审（plan-review 交互）→ 要求修改 → 修订版新审 → 忽略审阅后
  // 新提交把旧审置 continued（stale 审阅的回答是 no-op）→ 忽略（cancel）结算为
  // cancelled 且计划保持 → 第三次提交被模型自限（两轮后不再自动提交）→
  // 同意执行关闭计划模式并汇报执行；重复批准幂等。
  it('runs plan mode: the model enters plan mode itself, submits for review, revises, and stops on approval', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({})
    const id = created.conversation.id
    expect((await runtime.detail(id)).plan).toEqual({ active: false })

    // 与 ZCode 的 EnterPlanMode 对齐：没有开关时工具拒绝并指向 enter_plan_mode，
    // 由模型自行调用（无需用户操作），重交的计划以待审形式落地且计划模式开启。
    await runtime.submit(id, { text: '[plan] 计划模式未开启时提交', requestId: 'plan-off' })
    const recovered = await waitForDetail(runtime, id, detail =>
      !detail.conversation.busy && detail.interactions?.some(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending') === true)
    const refusal = recovered.messages.find(message => message.role === 'tool' && message.toolName === 'exit_plan_mode' && message.isError === true)
    expect(textOf(refusal)).toContain('未开启计划模式')
    expect(textOf(refusal)).toContain('enter_plan_mode')
    const entered = recovered.messages.find(message => message.role === 'tool' && message.toolName === 'enter_plan_mode')
    expect(entered?.isError).toBeFalsy()
    expect(textOf(entered)).toContain('计划模式已开启')
    expect(recovered.messages.filter(message => message.role === 'tool' && message.toolName === 'exit_plan_mode' && message.isError !== true)).toHaveLength(1)
    expect(recovered.plan).toEqual({ active: true })
    expect((await runtime.setPlan(id, true)).plan).toEqual({ active: true })
    await expect(runtime.setPlan('9999', true)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const first = recovered.interactions?.find(interaction => interaction.kind === 'plan-review')
    expect(first?.id).toBeTruthy()
    expect(first?.approveLabel).toBe('同意执行')
    expect(first?.detail?.startsWith('# ')).toBe(true)
    expect(first?.detail).toContain('演示计划')
    const planResults = recovered.messages.filter(message => message.role === 'tool' && message.toolName === 'exit_plan_mode' && message.isError !== true)
    expect(textOf(planResults.at(-1))).toContain('等待用户审阅')
    expect(textOf(recovered.messages.at(-1))).toContain('计划已提交待审')

    // 要求修改会结算本次审阅、计划保持开启，反馈交给模型，
    // 模型以修订版计划提交一次新审阅。
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
    // 第一轮被拒的调用仍在转录里，所以只统计成功的调用。
    expect(revised.messages.filter(message => message.role === 'tool' && message.toolName === 'exit_plan_mode' && message.isError !== true)).toHaveLength(2)
    const changeReply = revised.messages.find(message => message.role === 'user' && message.blocks.some(block => block.type === 'text' && block.text.includes('plan-review')))
    expect(textOf(changeReply)).toContain('补上回滚说明')
    expect(textOf(changeReply)).toContain('"approved":false')

    // UI 里搁置（不理会）的审阅保持未决，下一次提交把它结算为 continued（被取代），
    // 而不是让过期审阅重新生效。
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
    // 回答一个已被取代的审阅是 no-op：没有任何东西在等它。
    const stale = await runtime.answerInteraction(dismissedId, superseded!.id, [{ id: 'plan-review', selected: ['同意执行'] }])
    expect(stale.plan).toEqual({ active: true })
    expect(stale.interactions?.find(interaction => interaction.id === superseded!.id)).toMatchObject({ status: 'continued' })

    // 忽略（ZCode 的 decline）把审阅结算为 cancelled 且无决定：计划模式保持开启，
    // steer 回复告知模型未做任何决定；重复忽略幂等。
    const ignored = await runtime.create({})
    const ignoredId = ignored.conversation.id
    await runtime.setPlan(ignoredId, true)
    await runtime.submit(ignoredId, { text: '[plan] 先提交，然后忽略', requestId: 'plan-ignore-1' })
    const ignoreDraft = await waitForDetail(runtime, ignoredId, detail =>
      !detail.conversation.busy && detail.interactions?.some(interaction => interaction.kind === 'plan-review' && interaction.status === 'pending') === true)
    const ignoreReview = ignoreDraft.interactions?.find(interaction => interaction.kind === 'plan-review')
    const cancelled = await runtime.cancelInteraction(ignoredId, ignoreReview!.id)
    expect(cancelled.plan).toEqual({ active: true })
    expect(cancelled.interactions?.find(interaction => interaction.id === ignoreReview!.id))
      .toMatchObject({ status: 'cancelled' })
    const dismissReply = cancelled.messages.find(message => message.role === 'user' && textOf(message).includes('dismissed_plan_review'))
    expect(textOf(dismissReply)).toContain('不得实施')
    const againCancelled = await runtime.cancelInteraction(ignoredId, ignoreReview!.id)
    expect(againCancelled.interactions?.find(interaction => interaction.id === ignoreReview!.id))
      .toMatchObject({ status: 'cancelled' })

    // 第三次提交被 demo 模型自限拒绝：两轮之后不再自动重交。
    await runtime.submit(id, { text: '再补充风险一节', requestId: 'plan-run-3' })
    const capped = await waitForCompletedRun(runtime, id)
    expect(capped.plan).toEqual({ active: true })
    expect(capped.messages.filter(message => message.role === 'tool' && message.toolName === 'exit_plan_mode' && message.isError !== true)).toHaveLength(2)
    expect(textOf(capped.messages.at(-1))).toContain('不会再自动提交')

    // 批准在同一结算里关闭计划模式，模型随后汇报执行。
    const approved = await runtime.answerInteraction(id, second!.id, [{ id: 'plan-review', selected: ['同意执行'] }])
    expect(approved.plan).toEqual({ active: false })
    expect(approved.interactions?.find(interaction => interaction.id === second!.id))
      .toMatchObject({ status: 'answered', approved: true })

    const executed = await waitForDetail(runtime, id, detail => !detail.conversation.busy
      && detail.messages.some(message => message.role === 'assistant' && JSON.stringify(message.blocks).includes('演示执行完成')))
    expect(executed.plan).toEqual({ active: false })
    const approvalReplies = executed.messages.filter(message => message.role === 'user' && textOf(message).includes('"approved":true'))
    expect(approvalReplies).toHaveLength(1)

    // 重复回答幂等：转录里不出现第二条回复消息。
    const again = await runtime.answerInteraction(id, second!.id, [{ id: 'plan-review', selected: ['同意执行'] }])
    expect(again.messages.filter(message => message.role === 'user' && textOf(message).includes('"approved":true'))).toHaveLength(1)
    expect(again.plan).toEqual({ active: false })
  })

  // 目标机制：[goal] 触发工具创建（active、轮次预算 3），用户可暂停、可清除。
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

  // 持久化：标题/钉住/归档/思考等级跨关闭重开保留，消息逐条一致；
  // fork 从指定用户条目派生新会话（标题加 fork 后缀、不带钉住/归档、含原请求消息）。
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

  // 凭据卫生：自定义 provider 立即落盘、重开后凭据可用；目录（catalog）只报
  // configured 布尔值绝不泄漏 apiKey；models.json/auth.json 权限 0600、数据目录 0700。
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

  // workspace 生命周期：删除时其会话重绑到默认 workspace（不留悬挂绑定）；
  // 不存在的 id 报 NOT_FOUND；删除最后一个 workspace 允许，会话解绑等待新增。
  it('deletes a workspace, rebinding its sessions, and allows dropping the last one', async () => {
    const { runtime, root } = await fixture()
    const second = join(root, 'second-workspace')
    await mkdir(second, { recursive: true })
    const added = await runtime.addWorkspace({ path: second, name: 'Second' })
    const bound = await runtime.create({ title: 'Bound elsewhere', workspaceId: added.id })
    expect(bound.conversation.workspaceId).toBe(added.id)

    await runtime.deleteWorkspace(added.id)

    expect(runtime.workspaces().map(workspace => workspace.id)).not.toContain(added.id)
    // 会话不得保留悬挂绑定。
    const rebound = await runtime.detail(bound.conversation.id)
    expect(rebound.conversation.workspaceId).not.toBe(added.id)
    expect(runtime.workspaces().map(workspace => workspace.id)).toContain(rebound.conversation.workspaceId)

    await expect(runtime.deleteWorkspace('missing-workspace')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // 删除最后一个 workspace 是允许的；其会话保持解绑直到新增 workspace。
    const last = runtime.workspaces()[0]
    await runtime.deleteWorkspace(last.id)
    expect(runtime.workspaces()).toEqual([])
    expect(runtime.settings().defaultWorkspaceId).toBeUndefined()
    const unbound = await runtime.detail(bound.conversation.id)
    expect(unbound.conversation.workspaceId).toBeUndefined()
  })

  // 无默认目录启动：workspace 列表为空，创建会话被拒（「还没有工作区」）；
  // 后续添加 workspace 后创建即可绑定。
  it('starts with no workspaces when no default directory is given, until one is added', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-durable-web-runtime-'))
    const dataDir = join(root, 'data')
    const piDir = join(root, 'pi')
    await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(piDir, { recursive: true })])
    await writeFile(join(piDir, 'settings.json'), '{}\n')
    const runtime = await createRuntime({ dataDir, piDir, demo: true })
    const cleanup = { root, closers: [() => runtime.close()] }
    fixtures.push(cleanup)

    expect(runtime.workspaces()).toEqual([])
    expect(runtime.settings().defaultWorkspaceId).toBeUndefined()
    await expect(runtime.create({ title: 'No workspace' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('还没有工作区'),
    })

    const added = join(root, 'late-workspace')
    await mkdir(added, { recursive: true })
    const workspace = await runtime.addWorkspace({ path: added, name: 'Late' })
    const created = await runtime.create({ title: 'Bound later', workspaceId: workspace.id })
    expect(created.conversation.workspaceId).toBe(workspace.id)
  })

  // 自动化引用守门：被（即使已暂停的）自动化引用的 workspace 删除报 CONFLICT
  // （错误信息点名自动化）；改派到默认 workspace 后即可删除，会话重绑。
  it('blocks deleting a workspace referenced by a disabled automation, then allows removal after reassignment', async () => {
    const { runtime, root } = await fixture()
    const secondPath = join(root, 'automation-workspace')
    await mkdir(secondPath, { recursive: true })
    const workspace = await runtime.addWorkspace({ path: secondPath, name: 'Automation workspace' })
    const bound = await runtime.create({ title: 'Bound automation workspace', workspaceId: workspace.id })
    const automation = await runtime.createAutomation({
      name: 'Paused workspace task',
      prompt: 'Inspect this workspace',
      status: 'paused',
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

  // 并发序列化：删除与「引用该 workspace 的自动化创建」并发时，
  // 删除先行完成、创建随后报 NOT_FOUND，不产生孤儿自动化。
  it('serializes workspace removal against an automation being created concurrently', async () => {
    const { runtime, root } = await fixture()
    const secondPath = join(root, 'concurrent-automation-workspace')
    await mkdir(secondPath, { recursive: true })
    const workspace = await runtime.addWorkspace({ path: secondPath, name: 'Concurrent workspace' })

    const deleting = runtime.deleteWorkspace(workspace.id)
    const creating = runtime.createAutomation({
      name: 'Racing task',
      prompt: 'Inspect this workspace',
      status: 'paused',
      workspaceId: workspace.id,
    })
    await expect(deleting).resolves.toBeUndefined()
    await expect(creating).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(runtime.automations()).toHaveLength(0)
    expect(runtime.workspaces().some(item => item.id === workspace.id)).toBe(false)
  })

  // 重启恢复（逾期任务）：nextRunAt 已过去的自动化在 runtime 重启后被补跑并完成。
  it('recovers an overdue automation after the runtime restarts', async () => {
    const { runtime, dataDir, workspace, piDir, cleanup } = await fixture()
    const automation = await runtime.createAutomation({
      name: 'Restarted task', prompt: 'Verify startup recovery', status: 'active', rrule: everyMinutes(1),
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

  // 对照边界：远未到期的 30 天间隔任务重启后不立即执行，nextRunAt 保持在未来。
  it('does not run a 30-day automation immediately after restart', async () => {
    const { runtime, dataDir, workspace, piDir, cleanup } = await fixture()
    const automation = await runtime.createAutomation({
      name: 'Long interval task', prompt: 'Wait for its due time', status: 'active', rrule: everyMinutes(30 * 24 * 60),
    })
    await runtime.close()

    const reopened = await createRuntime({ dataDir, workspace, piDir, demo: true })
    cleanup.closers.push(() => reopened.close())
    await new Promise(resolve => setTimeout(resolve, 50))
    const recovered = reopened.automations().find(item => item.id === automation.id)
    expect(recovered?.lastRun).toBeUndefined()
    expect(recovered?.nextRunAt).toBeGreaterThan(Date.now())
  })

  // 团队投影：[team] 生成 lead + 两名成员名册与任务看板（依赖/写域齐全）；
  // 每个成员是真实子会话（origin=subagent、有 parentId）且不出现在侧栏列表；
  // spawn 工具行带子会话 id 供面板直达；显式 team() 路由同一数据，未知/非法 id 报错。
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

    // 每个成员都是真实子会话，且不进侧栏列表。
    const children = await runtime.children(parent.conversation.id)
    expect(children.map(row => row.label)).toEqual(['资料调研', '面板实现'])
    expect((await runtime.list()).map(item => item.id)).toEqual([parent.conversation.id])
    const childDetail = await runtime.detail(children[0]?.id ?? '')
    expect(childDetail.conversation.origin).toBe('subagent')
    expect(childDetail.conversation.parentId).toBe(parent.conversation.id)
    expect(textOf(childDetail.messages.find(message => message.role === 'user'))).toContain('[team-child]')

    // spawn 工具行携带子会话 id，面板可直接打开成员。
    const spawnRows = detail.messages.filter(message => message.toolName === 'spawn_teammate')
    expect(spawnRows.map(message => (message.details as { conversationId?: string } | undefined)?.conversationId))
      .toEqual(children.map(row => row.id))

    // 显式路由投影同样的行，并拒绝未知会话。
    expect((await runtime.team(parent.conversation.id)).members.map(member => member.name)).toEqual(['lead', 'researcher', 'writer'])
    await expect(runtime.team('9999')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.team('not-a-number')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  // 团队消息：send_message 立即投递不等回答（只读会话同样可行）；
  // 成员消息带发送者框架（「来自 lead 的团队消息：」，对齐 DSH index.ts:230-233）；
  // list_agents 报持久名册行（phase）与实况可用性。
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
    // DSH 以发送者框架包装成员间消息（index.ts:230-233）。
    expect(userTexts.some(text => text.includes('来自 lead 的团队消息：') && text.includes('[team-child-followup]'))).toBe(true)

    // list_agents 报持久名册行（phase）与实况可用性。
    const listed = detail.messages.find(message => message.toolName === 'list_agents')
    const rows = JSON.parse(textOf(listed)) as Array<{ name: string; role: string; phase: string }>
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'helper', role: 'teammate', phase: 'active' })]))
    expect(rows.map(row => row.name)).toEqual(['lead', 'helper'])
  })

  // wait_agent 两态：无活跃成员立即返回 no-active-peer（timedOut=false）；
  // 有运行中成员时等满时限报 timedOut=true（诊断带标记）。
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

    // 一名成员在跑：调用等满时限后报 timedOut。
    const gated = await runtime.create({ title: 'Team wait timeout' })
    await runtime.submit(gated.conversation.id, { text: '[team-wait-timeout] 演示', requestId: randomUUID() })
    const timeoutDetail = await waitForDetail(runtime, gated.conversation.id,
      value => !value.conversation.busy && value.messages.some(message => message.toolName === 'wait_agent'), 40_000)
    const waited = timeoutDetail.messages.filter(message => message.toolName === 'wait_agent').at(-1)
    expect(waited?.isError).not.toBe(true)
    expect(textOf(waited)).toContain('"timedOut": true')
    expect((waited?.details as { timedOut?: boolean } | undefined)?.timedOut).toBe(true)
  }, 60_000)

  // 任务看板贯通：claim（in_progress）→ 故意陈旧的 release 被拒（错误带当前修订）→
  // complete 收尾；看板投影最终 completed、revision 3、完成后不再 ready。
  it('drives a shared task through claim, a stale rejection, and complete', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Team tasks' })
    await runtime.submit(parent.conversation.id, { text: '[team-task] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)

    const updates = detail.messages.filter(message => message.toolName === 'team_task_update')
    expect(updates).toHaveLength(3)
    expect(updates[0]?.isError).not.toBe(true)
    expect(textOf(updates[0])).toContain('"status": "in_progress"')
    // 故意的陈旧 release 被拒，错误信息里带当前修订号。
    expect(updates[1]?.isError).toBe(true)
    expect(textOf(updates[1])).toContain('stale team task "task-1" revision 1; current revision is 2')
    expect(updates[2]?.isError).not.toBe(true)

    const tasks = detail.team?.tasks ?? []
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 'task-1', status: 'completed', ownerName: 'lead', revision: 3 })
    expect(tasks[0]?.ready).toBe(false)
  })

  // 前台子智能体委派：子答复经工具结果回到模型；subagents 行（标签/标题/答复/时间）
  // 投影正确；owner 边决定成员关系（子会话有独立转录、origin/parentId 明确）；
  // 子会话不进侧栏、子会话无子会话。
  it('delegates one foreground child conversation and projects its answer', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Subagent parent' })
    await runtime.submit(parent.conversation.id, { text: '[subagent] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)

    // 子答复经工具结果（而非父会话自己的文本）回到模型。
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

    // owner 边决定成员关系：子会话是拥有独立转录的真实会话。
    const childDetail = await runtime.detail(child?.id ?? '')
    expect(childDetail.conversation.title).toBe('机制归纳')
    expect(childDetail.conversation.origin).toBe('subagent')
    expect(childDetail.conversation.parentId).toBe(parent.conversation.id)
    expect(detail.conversation.origin).toBeUndefined()
    expect(textOf(childDetail.messages.find(message => message.role === 'user'))).toContain('[subagent-child]')
    expect(textOf(childDetail.messages.filter(message => message.role === 'assistant').at(-1))).toContain('子智能体一期机制小结')

    // 子会话不出现在侧栏，且子会话不再拥有自己的子会话。
    expect((await runtime.list()).map(item => item.id)).toEqual([parent.conversation.id])
    expect(await runtime.children(child?.id ?? '')).toEqual([])
    expect((await runtime.children(parent.conversation.id)).map(row => row.id)).toEqual([child?.id])
  })

  // 只读委派：只读会话也能委派子智能体（工具无 workspace 副作用），答复正常回传。
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

  // Explore 档案委派：子会话工具收窄为只读集合、系统段换成档案提示词
  // （「只读检索专家」）。provider 边界是观察子会话解析结果的唯一位置。
  it('delegates an Explore subagent with narrowed tools and the profile prompt', async () => {
    const { runtime } = await fixture()
    // provider 边界是唯一能观察子会话已解析 agent 的位置：
    // 请求携带可用工具与被档案指引替换后的系统段。
    const childRequests: Array<{ sections: string; tools: string[] }> = []
    const stopObserving = observeDemoRequests(request => {
      const messages = normalizeContext(request).messages
      const user = [...messages].reverse().find(message => message.role === 'user')
      const text = typeof user?.content === 'string' ? user.content
        : Array.isArray(user?.content) ? user.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
        : ''
      if (!text.includes('[subagent-child]')) return
      childRequests.push({
        sections: Object.values(getCurrentSystemMessage(messages)?.sections ?? {}).join('\n'),
        tools: getCurrentTools(messages).map(tool => tool.name),
      })
    })
    try {
      const parent = await runtime.create({ title: 'Explore delegation' })
      await runtime.submit(parent.conversation.id, { text: '[subagent-explore] 演示', requestId: randomUUID() })
      const detail = await waitForCompletedRun(runtime, parent.conversation.id)

      const toolResult = detail.messages.find(message => message.role === 'tool' && message.toolName === SUBAGENT_TOOL)
      expect(toolResult?.isError).not.toBe(true)
      expect(textOf(toolResult)).toContain('子智能体一期机制小结')
      expect(detail.subagents?.[0]?.label).toBe('机制归纳')

      expect(childRequests.length).toBeGreaterThan(0)
      const readOnly = new Set(['read', 'glob', 'grep', 'list_files', 'search_files'])
      for (const request of childRequests) {
        expect(request.tools.length, 'the Explore child keeps at least the read tool').toBeGreaterThan(0)
        for (const name of request.tools) expect(readOnly.has(name), name).toBe(true)
      }
      expect(childRequests.some(request => request.sections.includes('只读检索专家'))).toBe(true)
    } finally {
      stopObserving()
    }
  })

  // 模型覆盖：委派可指定子模型（children 行与会话详情都反映所选模型）；
  // 目录之外的模型在任何子会话创建之前被拒绝（工具报错、无子会话产生）。
  it('overrides the child model on delegation and refuses a model outside the catalog', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Model delegation' })
    await runtime.submit(parent.conversation.id, { text: '[subagent-model] 演示', requestId: randomUUID() })
    const detail = await waitForCompletedRun(runtime, parent.conversation.id)

    const toolResult = detail.messages.find(message => message.role === 'tool' && message.toolName === SUBAGENT_TOOL)
    expect(toolResult?.isError).not.toBe(true)
    expect(textOf(toolResult)).toContain('子智能体一期机制小结')
    // The children route answers with the runtime's own rows, which carry the selected model.
    const rows = await runtime.children(parent.conversation.id)
    expect(rows[0]?.model).toBe('pi-web-demo/demo-model')
    expect((await runtime.detail(rows[0]?.id ?? '')).conversation.model).toEqual({ provider: 'pi-web-demo', modelId: 'demo-model' })

    // 目录之外的选型在任何子会话存在之前就被拒绝。
    const other = await runtime.create({ title: 'Unavailable model delegation' })
    await runtime.submit(other.conversation.id, { text: '[subagent-bad-model] 演示', requestId: randomUUID() })
    const failed = await waitForCompletedRun(runtime, other.conversation.id)
    const refused = failed.messages.find(message => message.role === 'tool' && message.toolName === SUBAGENT_TOOL)
    expect(refused?.isError).toBe(true)
    expect(textOf(refused)).toContain('未出现在 Pi 模型目录中')
    expect(await runtime.children(other.conversation.id)).toEqual([])
  })

  // 子会话控制：follow-up 投递触发子会话新一轮运行、childStop 终止运行；
  // 边缘两侧的无关会话与未知 id 一律 NOT_FOUND（不能跨边控制）。
  it('delivers follow-ups to one child and stops a running child, refusing every other target', async () => {
    const { runtime } = await fixture()
    const parent = await runtime.create({ title: 'Subagent control' })
    await runtime.submit(parent.conversation.id, { text: '[subagent] 演示', requestId: randomUUID() })
    await waitForCompletedRun(runtime, parent.conversation.id)
    const childId = (await runtime.children(parent.conversation.id))[0]?.id ?? ''
    const other = await runtime.create({ title: 'Unrelated' })

    // 无关会话永远不是控制目标——无论它处在边缘的哪一侧。
    await expect(runtime.childMessage(parent.conversation.id, other.conversation.id, { text: '你好', requestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.childStop(parent.conversation.id, other.conversation.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.childStop(other.conversation.id, childId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.childStop(parent.conversation.id, '999999')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // follow-up 到达子会话并启动其下一轮运行。
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

  // code mode：模型写的脚本能调用会话工具（嵌套 bash）；脚本输出即模型所见，
  // 嵌套调用记录在 details 中。
  it('runs model-written code mode scripts against the conversation tools', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({ title: 'Code mode' })
    await runtime.submit(created.conversation.id, { text: '[codemode] 演示', requestId: randomUUID() })
    const completed = await waitForCompletedRun(runtime, created.conversation.id)
    const codemode = completed.messages.find(message => message.role === 'tool' && message.toolName === 'codemode')
    expect(codemode?.isError).toBeFalsy()
    // 脚本输出是模型所见的内容，嵌套 bash 调用记录在 details 里。
    expect(textOf(codemode)).toContain('codemode-ok')
    expect(JSON.stringify(codemode?.details)).toContain(SHELL_TOOL)
    expect(completed.messages.some(message => message.role === 'assistant' && textOf(message).includes('codemode-ok'))).toBe(true)
  })

  // code mode 三态切换（对既有会话）：on 提供原生工具；only 只给 codemode
  // （直接调用被拒）；off 后再 on 清掉残留的 script-only 过滤（codemode 与原生工具都恢复）。
  it('switches code mode between the native and script-only presentations for existing conversations', async () => {
    const { runtime } = await fixture()
    const created = await runtime.create({ title: 'Code mode switch' })

    // 默认 `on`：直接 bash 调用对模型可用并执行。
    await runtime.submit(created.conversation.id, { text: '[direct-tool] 第一次', requestId: randomUUID() })
    const on = await waitForCompletedRun(runtime, created.conversation.id)
    expect(on.messages.find(message => message.role === 'tool' && message.toolName === SHELL_TOOL)?.isError).toBeFalsy()

    // `only`：模型只见 codemode，同样的直接调用被拒。
    await runtime.updateSettings({ codemodeMode: 'only' })
    await runtime.submit(created.conversation.id, { text: '[direct-tool] 第二次', requestId: randomUUID() })
    const only = await waitForCompletedRun(runtime, created.conversation.id)
    const refused = [...only.messages].reverse().find(message => message.role === 'tool' && message.toolName === SHELL_TOOL)
    expect(refused?.isError).toBe(true)
    expect(runtime.settings().codemodeMode).toBe('only')

    // `off` 再回 `on`：持久化的 script-only 过滤被清除，codemode 恢复可用。
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

    // `on` 同时恢复原生工具：残留的 script-only 过滤本会拒绝它们。
    await runtime.submit(created.conversation.id, { text: '[direct-tool] 重新开启后', requestId: randomUUID() })
    const directBack = await waitForCompletedRun(runtime, created.conversation.id)
    expect([...directBack.messages].reverse().find(message => message.role === 'tool' && message.toolName === SHELL_TOOL)?.isError).toBeFalsy()
  })

  // MCP 只读导入：无配置文件时报 configExists=false；坏命令的服务标 error 状态，
  // 但绝不阻碍 runtime 继续创建会话。
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
    // 起不来的 MCP 服务绝不阻碍 runtime 创建会话。
    expect((await broken.runtime.create({ title: 'Still up' })).conversation.id).toBeTruthy()
  })
})

/**
 * 后台委派链路直连 harness 驱动（不经 demo 标记）：真实的 `subagent` 工具
 * （接真实结算通道）拉起子会话，调用立即返回激活回执，子会话完成后的答复
 * 以 `[subagent-settlement]` follow-up 消息落到父会话并触发新一轮运行。
 */
describe('background subagent delegation', () => {
  // 工具的子会话由任务所有（task-owned），owner 任务必须存在。
  // 用一个驻留的后台锚任务顶替真实调用会运行的 ToolTask（team.ts 先例）。
  const BgOwnerAnchor = defineTask<{ name: string }, { phase: 'anchor' }, null, object>({
    name: 'pi-web.bg-owner-anchor',
    version: 1,
    initial: () => ({ phase: 'anchor' }),
    phases: {
      anchor: async (_task, runtime, context) => {
        if (!runtime.signal.aborted) {
          await new Promise<void>((resolve) => {
            runtime.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        try {
          await runtime.commit(() => ({
            status: 'terminal' as const,
            outcome: { status: 'aborted' as const, reason: 'bg owner released' },
          }), context)
        } catch {
          // Harness 正在关闭：驻留边界已无可记录的内容。
        }
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({
        status: 'terminal' as const,
        outcome: { status: 'aborted' as const, reason: 'bg owner aborted' },
      }), context)
    },
  })

  /**
   * 从原始上下文视图直接读取某一角色的全部可见文本。
   * @returns { user, assistant } 两组按转录顺序排列的文本
   */
  async function textsOf(handle: Conversation): Promise<{ user: string[]; assistant: string[] }> {
    const view = await handle.context(CTX)
    const flat = view.contributions.flat()
    const of = (role: 'user' | 'assistant') => flat
      .filter(message => message.role === role)
      .map(message => typeof message.content === 'string'
        ? message.content
        : message.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n'))
    return { user: of('user'), assistant: of('assistant') }
  }

  // 主链路断言：调用立即返回激活回执（不是答案）且父会话暂无结算；
  // 子会话完成后答复以恰好一条带标记的 follow-up 落到父会话并启动新运行；
  // 持久标记齐全——父会话有 request receipt、子会话委派带 deliveredAt。
  it('returns an activation at once, then settles the answer into the parent as a follow-up run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-web-runtime-bg-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const demo = createDemoModelRuntime()
    const registry = createRegistry()
    registry.install(CodingTools)
    const storage = await openNodeSqliteStorage(join(root, 'state.sqlite'))
    const harness = await Harness.open(storage, {
      models: demo.models,
      registry,
      env: async () => await createExecutionEnv(workspace, 'fullAccess'),
    }, CTX)
    harness.resume()
    fixtures.push({ root, closers: [async () => { await harness.close(CTX) }] })
    const settlement = createSubagentSettlement({ harness: () => harness })

    const parentRecord = await harness.commit(async (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }), CTX)
    const parent = await harness.conversation(parentRecord.id, CTX)
    if (!parent) throw new Error('parent conversation is missing')
    await parent.configure({ model: { ...demo.defaultModel! } }, CTX)
    const parentId = parentRecord.id
    // 委派的子会话所隶属的驻留任务。
    const ownerTask = await harness.commit((tx) => tx.createTask(BgOwnerAnchor, { name: 'bg-owner' }, {
      ownership: { kind: 'conversation' },
      conversationId: parentId,
      background: true,
    }), CTX)
    const taskIdLabel = String(ownerTask as TaskId)

    // 接在本 harness 上的真实工具，带 runtime 的结算注入。
    const tool = createSubagentTools({
      prepareChild: async () => undefined,
      settleWhenAnswered: settlement.settleWhenAnswered,
    }).tools?.find(candidate => candidate.name === SUBAGENT_TOOL)
    if (!tool) throw new Error(`Missing ${SUBAGENT_TOOL} tool`)
    const details: Array<Record<string, unknown>> = []
    const api = {
      conversationId: parentId,
      taskId: ownerTask,
      commit: (change: unknown) => harness.commit(change as Parameters<typeof harness.commit>[0], CTX),
      details: async (value: Record<string, unknown>) => { details.push(value) },
      diagnostic: () => undefined,
      conversation: async (id: ConversationId) => await harness.conversation(id, CTX),
    }
    const execute = (tool as unknown as {
      execute(args: Record<string, unknown>, api: unknown, context: Context): Promise<{
        output?: Array<{ type: string; text: string }>
        isError?: boolean
      }>
    }).execute

    const result = await execute({ task: '[subagent-child] 归纳一期机制', label: '机制归纳', run_in_background: true }, api, CTX)

    // 调用返回激活回执而非答案，父会话此刻还没有任何结算。
    expect(result.isError).not.toBe(true)
    const activation = result.output?.[0]?.text ?? ''
    expect(activation).toContain('机制归纳')
    expect(activation).toContain('跟进消息')
    expect(details.at(-1)).toMatchObject({ status: 'running', label: '机制归纳', background: true })
    expect((await textsOf(parent)).user.filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(0)

    // 子会话完成后，答复以恰好一条带标记的 follow-up 消息到达。
    const deadline = Date.now() + 20_000
    let settledTexts: { user: string[]; assistant: string[] }
    for (;;) {
      settledTexts = await textsOf(parent)
      if (settledTexts.user.some(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))) break
      if (Date.now() > deadline) throw new Error('the settlement never reached the parent')
      await delay(25)
    }
    const childRecord = await harness.commit(async (tx) => tx.scanConversations({ ownerTaskId: ownerTask }, 1), CTX)
    const childId = childRecord.items[0]?.id
    expect(childId).toBeDefined()
    const childHandle = await harness.conversation(childId!, CTX)
    if (!childHandle) throw new Error('child conversation is missing')
    const childAnswer = (await textsOf(childHandle)).assistant.at(-1) ?? ''
    expect(childAnswer).toContain('子智能体一期机制小结')
    const delivered = settledTexts.user.filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('子智能体「机制归纳」已完成任务')
    expect(delivered[0]).toContain(childAnswer)

    // 注入的消息在父会话上启动新一轮运行：父会话作答后回到空闲。
    await parent.waitForIdle(CTX)
    const after = await textsOf(parent)
    expect(after.user.filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(1)
    expect(after.assistant.length).toBeGreaterThan(0)

    // 持久标记：父会话侧的回执、子会话侧已投递的委派记录。
    const metadata = await harness.snapshot(META, parentId, CTX)
    expect(typeof metadata?.requestReceipts[`subagent-settle:${taskIdLabel}`]?.submissionId).toBe('number')
    const identity = await harness.snapshot(Subagents, childId!, CTX)
    expect(identity?.record?.delegation).toMatchObject({ background: true, parent: parentId, requestId: `subagent-settle:${taskIdLabel}` })
    expect(typeof identity?.record?.delegation?.deliveredAt).toBe('number')
  }, 30_000)
})
