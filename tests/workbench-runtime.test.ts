import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai'
import { getCurrentSystemMessage, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime/index.ts'
import { createExecutionEnv, workbenchFileEnv, workbenchProject } from '../src/server/conversation/execution-env.ts'
import { CTX } from '../src/server/runtime/helpers.ts'
import { resolveWorkdir } from '../src/server/tools/shell/common.ts'
import type { AccessMode } from '../src/shared/types.ts'
import type { WorkbenchView } from '../src/shared/workbench.ts'

const model = { provider: 'workbench-test', modelId: 'worker' }
const secondaryModel = { provider: model.provider, modelId: 'worker-secondary' }
const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
const chartTaskPrefix = '每周图表可读性检查'
const explicitCreationRequest = '请创建一个名叫目录核对员的 Bot，仅建档'
type BeforePlan = (request: string, accessMode: AccessMode) => void | Promise<void>

function fixtureModel(worker: FauxResponseFactory, type: 'investigate' | 'build' | 'decide', beforePlan?: BeforePlan) {
  const models = createModels()
  const faux = fauxProvider({
    provider: model.provider, models: [
      { id: model.modelId, name: 'Workbench Test', input: ['text'] },
      { id: secondaryModel.modelId, name: 'Workbench Secondary', input: ['text'] },
    ],
  })
  const planResponse: FauxResponseFactory = async (context, ...rest) => {
    const system = getCurrentSystemMessage(normalizeContext(context).messages)
    const prompt = typeof system?.content === 'string' ? system.content : ''
    if (!prompt.includes('pi-web Agent 工作台的主 Agent')) return worker(context, ...rest)
    const request = context.messages.findLast(message => message.role === 'user')
    const raw = request?.content
    if (typeof raw !== 'string') throw new Error('Missing workbench dispatch input')
    const input = JSON.parse(raw) as { request: string; mention?: string; accessMode: AccessMode; existingItems: Array<{ id: string }> }
    await beforePlan?.(input.request, input.accessMode)
    const task = {
      title: input.request,
      objective: input.request,
      constraints: [],
      acceptance: ['生成可核验结果'],
      type,
      assignee: 'time',
      dependsOn: [],
      previous: input.request === '等待上一单交付' ? [input.existingItems[0]?.id] : [],
    }
    const newBot = input.request.startsWith(chartTaskPrefix) ? {
      id: 'chart-readability', name: '图表审阅', role: '图表可读性', description: '核对图例、单位与坐标轴。',
      instructions: 'BOT_CHART_MARKER', icon: 'chart',
    } : undefined
    const work = newBot === undefined ? task : { ...task, assignee: newBot.id }
    const tasks = input.mention ? [work, { ...work, title: '额外派发', dependsOn: [0] }] : [work]
    const createBot = input.mention === 'general' && input.request === explicitCreationRequest ? {
      id: 'catalog-check', name: '目录核对员', role: '目录核对', description: '核对目录条目。',
      instructions: '确认目录顺序与事实来源。', icon: 'book',
    } : undefined
    return fauxAssistantMessage(fauxText(JSON.stringify({ tasks, newBot, createBot })))
  }
  faux.setResponses(Array.from({ length: 40 }, () => planResponse))
  models.setProvider(faux.provider)
  return models
}

async function fixture(run: (context: {
  runtime: Awaited<ReturnType<typeof createRuntime>>; workspace: string; workspaceId: string;
  reopen(): Promise<Awaited<ReturnType<typeof createRuntime>>>;
}) => Promise<void>, response: FauxResponseFactory, type: 'investigate' | 'build' | 'decide' = 'investigate', beforePlan?: BeforePlan) {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-workbench-'))
  const workspace = join(root, 'project')
  const dataDir = join(root, 'data')
  await mkdir(workspace)
  const options = { workspace, dataDir, piDir: join(root, 'pi'), demo: true, models: fixtureModel(response, type, beforePlan) }
  let runtime = await createRuntime(options)
  try {
    await run({
      runtime, workspace, workspaceId: runtime.workspaces()[0]!.id,
      async reopen() {
        await runtime.close()
        runtime = await createRuntime(options)
        return runtime
      },
    })
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function observe(runtime: Awaited<ReturnType<typeof createRuntime>>, workspaceId: string, check: (view: WorkbenchView) => boolean) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const view = await runtime.workbench(workspaceId)
    if (view.messages.some(message => message.error)) throw new Error(JSON.stringify(view.messages))
    if (check(view)) return view
    await delay(60)
  }
  throw new Error(JSON.stringify(await runtime.workbench(workspaceId)))
}

describe('Agent 工作台的运行时契约', () => {
  it('AI 孵化可复用的工作区 Bot，重复派发不新建，用户可编辑运行配置', async () => {
    await fixture(async ({ runtime, workspace, workspaceId, reopen }) => {
      await runtime.updateSettings({ codemodeMode: 'off' })
      const skillFolder = join(workspace, '.agents', 'skills', 'chart-review')
      await mkdir(skillFolder, { recursive: true })
      await writeFile(join(skillFolder, 'SKILL.md'), '---\nname: chart-review\ndescription: Check labels and units in chart legends.\n---\nSKILL_CHART_MARKER\n')
      const submit = (number: number, mention?: string, requestSuffix = 'ABC') => runtime.submitWorkbench(workspaceId, {
        requestId: `chart-${number}`, text: `${chartTaskPrefix} ${requestSuffix}`, model, accessMode: 'fullAccess',
        ...(mention === undefined ? {} : { mention }),
      })
      await submit(1)
      const first = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      const createdId = first.messages[0]?.createdBotId
      expect(createdId).toBeTruthy()
      expect(first.items[0]?.assignee).toBe(createdId)
      expect(first.agents.find(bot => bot.id === createdId)).toMatchObject({
        name: '图表审阅',
        config: { origin: 'agent', instructions: 'BOT_CHART_MARKER', icon: 'chart', skillIds: null },
      })
      // The test planner deliberately returns the same proposal even after it sees the roster.
      await Promise.all([submit(2), submit(3, 'log')])
      const reused = await observe(runtime, workspaceId, view => view.items.length === 3 && view.items.every(item => item.status === 'pending_review'))
      expect(reused.agents.filter(bot => bot.config?.origin === 'agent')).toHaveLength(1)
      expect(reused.items.find(item => item.requestId === 'chart-2')?.assignee).toBe(createdId)
      expect(reused.items[0]?.id).toBe(first.items[0]?.id)
      expect(reused.items.find(item => item.requestId === 'chart-2')?.dependencies).toEqual([])
      expect(reused.items.find(item => item.requestId === 'chart-3')?.assignee).toBe('log')
      expect(reused.messages.filter(message => message.createdBotId)).toHaveLength(1)

      const manual = await runtime.createWorkbenchBot(workspaceId, { name: '手工创建的 Bot', skillIds: ['agents:chart-review'] })
      expect(manual.config).toMatchObject({ origin: 'user', skillIds: ['agents:chart-review'] })
      await expect(runtime.createWorkbenchBot(workspaceId, { name: ' 图表审阅 ' })).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(runtime.updateWorkbenchBot(workspaceId, createdId!, { skillIds: ['agents:missing'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      const patched = await runtime.updateWorkbenchBot(workspaceId, createdId!, {
        name: '图表审阅员', role: '图表规范', instructions: 'BOT_EDITED_MARKER', model: secondaryModel,
        accessMode: 'readOnly', skillIds: ['agents:chart-review'], icon: 'book',
      })
      expect(patched).toMatchObject({
        name: '图表审阅员', model: secondaryModel, accessMode: 'readOnly', skills: ['chart-review'],
        config: { origin: 'agent', skillIds: ['agents:chart-review'], icon: 'book' },
      })
      await submit(4, createdId, '检查配置和工具')
      const active = await observe(runtime, workspaceId, view => view.items.find(item => item.requestId === 'chart-4')?.status === 'pending_review')
      const configured = active.items.find(item => item.requestId === 'chart-4')!
      const detail = await runtime.detail(configured.childId!)
      expect(detail.conversation.model).toEqual(secondaryModel)
      expect(detail.conversation.accessMode).toBe('readOnly')
      await expect(runtime.update(configured.childId!, { accessMode: 'fullAccess' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(detail.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'allowed-skill', isError: false }),
        expect.objectContaining({ toolCallId: 'blocked-skill', isError: true }),
      ]))
      expect(detail.messages.find(message => message.toolCallId === 'allowed-skill')?.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('SKILL_CHART_MARKER') }),
      ]))

      await runtime.replyWorkbench(workspaceId, configured.id, { requestId: 'chart-reply', text: '继续审阅', model })
      await observe(runtime, workspaceId, view => view.items.find(item => item.id === configured.id)?.status === 'pending_review')
      expect((await runtime.detail(configured.childId!)).conversation.model).toEqual(model)
      await runtime.replyWorkbench(workspaceId, configured.id, { requestId: 'chart-reply-2', text: '补充证据' })
      await observe(runtime, workspaceId, view => view.items.find(item => item.id === configured.id)?.status === 'pending_review')
      expect((await runtime.detail(configured.childId!)).conversation.model).toEqual(secondaryModel)

      const other = await runtime.createNamedWorkspace('隔离工作区', randomUUID())
      expect((await runtime.workbench(other.id)).agents.find(bot => bot.id === createdId)).toBeUndefined()
      const reopened = await reopen()
      expect((await reopened.workbench(workspaceId)).agents.find(bot => bot.id === createdId)?.config).toEqual(patched.config)
    }, context => {
      const user = context.messages.findLast(message => message.role === 'user')
      if (typeof user?.content !== 'string' || !user.content.includes('检查配置和工具')) {
        return fauxAssistantMessage(fauxText('已检查'))
      }
      const system = getCurrentSystemMessage(normalizeContext(context).messages)
      expect(system?.sections?.instructions).toContain('BOT_EDITED_MARKER')
      expect(system?.sections?.['skills-policy']).toContain('agents:chart-review')
      expect(system?.sections?.['skills-policy']).not.toContain('\n- builtin:skill-creator')
      if (context.messages.some(message => message.role === 'toolResult')) return fauxAssistantMessage(fauxText('已用所选技能检查'))
      return fauxAssistantMessage([
        fauxToolCall('skill_load', { skill: 'chart-review' }, { id: 'allowed-skill' }),
        fauxToolCall('skill_load', { skill: 'builtin:skill-creator' }, { id: 'blocked-skill' }),
      ], { stopReason: 'toolUse' })
    }, 'build')
  }, 30_000)

  it('人工并发建档与使用旧名册的孵化计划只产生一个 Bot，每个请求只物化一次', async () => {
    const title = chartTaskPrefix + ' 竞争任务'
    let markPlanningStarted!: () => void
    const planningStarted = new Promise<void>(resolve => { markPlanningStarted = resolve })
    let releasePlanning!: () => void
    const planningGate = new Promise<void>(resolve => { releasePlanning = resolve })
    await fixture(async ({ runtime, workspaceId, reopen }) => {
      const race = { requestId: 'dedupe-race', text: title, model, accessMode: 'readOnly' as const }
      try {
        await Promise.all([runtime.submitWorkbench(workspaceId, race), runtime.submitWorkbench(workspaceId, race)])
        await planningStarted
        const after = await Promise.allSettled([
          runtime.createWorkbenchBot(workspaceId, { name: ' 图表审阅 ', instructions: '保留人工配置 A' }),
          runtime.createWorkbenchBot(workspaceId, { name: '图表审阅', instructions: '保留人工配置 B' }),
        ])
        const winner = after.find(entry => entry.status === 'fulfilled')?.value
        expect(after.filter(entry => entry.status === 'fulfilled')).toHaveLength(1)
        expect(after.find(entry => entry.status === 'rejected')?.reason).toMatchObject({ code: 'CONFLICT' })
        const before = await runtime.workbench(workspaceId)
        expect(before.items).toHaveLength(0)
        expect(before.messages).toHaveLength(1)
        releasePlanning()
        const dispatched = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
        const bot = dispatched.agents.find(agent => agent.id === winner?.id)
        expect(bot).toMatchObject({ name: '图表审阅', config: winner?.config })
        expect(dispatched.agents.filter(agent => agent.name === '图表审阅')).toHaveLength(1)
        expect(dispatched.messages[0]?.createdBotId).toBeUndefined()
        expect(dispatched.items).toHaveLength(1)
        expect(dispatched.items[0]).toMatchObject({ requestId: race.requestId, assignee: winner?.id })
        const restarted = await reopen()
        await restarted.submitWorkbench(workspaceId, race)
        const persisted = await restarted.workbench(workspaceId)
        expect(persisted.agents.filter(agent => agent.name === '图表审阅')).toHaveLength(1)
        expect(persisted.items.map(item => item.id)).toEqual(dispatched.items.map(item => item.id))
      } finally {
        releasePlanning()
      }
    }, () => fauxAssistantMessage(fauxText('核对图表并交付')), 'investigate', async request => {
      if (request === title) {
        markPlanningStarted()
        await planningGate
      }
    })
  }, 15_000)

  it('仅预定的 @通用建档会话能创建 Bot，重复工具调用复用建档回执', async () => {
    await fixture(async ({ runtime, workspaceId }) => {
      await runtime.updateSettings({ codemodeMode: 'off' })
      await runtime.updateWorkbenchBot(workspaceId, 'general', { accessMode: 'fullAccess' })
      const submit = (requestId: string, text: string) => runtime.submitWorkbench(workspaceId, {
        requestId, text, mention: 'general', accessMode: 'readOnly', model,
      })
      await submit('explicit-bot', explicitCreationRequest)
      const created = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      expect(created.items).toHaveLength(1)
      const bot = created.agents.find(agent => agent.name === '目录核对员')
      expect(created.messages[0]?.createdBotId).toBe(bot?.id)
      expect(bot?.config?.origin).toBe('agent')
      expect(created.items[0]?.assignee).toBe('general')
      expect(created.items[0]).toMatchObject({ accessMode: 'readOnly', replyAccessMode: 'readOnly' })
      const child = await runtime.detail(created.items[0]!.childId!)
      const calls = child.messages.filter(message => message.role === 'tool' && message.toolName === 'create_workbench_bot')
      expect(calls).toHaveLength(2)
      for (const call of calls) expect(call.details).toEqual({ id: bot?.id, name: bot?.name, created: true })

      await submit('general-task', chartTaskPrefix + ' 常规工作')
      const continued = await observe(runtime, workspaceId, view => view.items[1]?.status === 'pending_review')
      expect(continued.agents.map(agent => agent.id)).toEqual(created.agents.map(agent => agent.id))
      expect(continued.items.every(item => item.assignee === 'general')).toBe(true)
      expect(continued.messages[1]?.createdBotId).toBeUndefined()
    }, context => {
      const user = context.messages.findLast(message => message.role === 'user')
      const tools = getCurrentTools(normalizeContext(context).messages).map(tool => tool.name)
      if (typeof user?.content === 'string' && user.content.includes(explicitCreationRequest)) {
        expect(tools).toEqual(['create_workbench_bot'])
        if (!context.messages.some(message => message.role === 'toolResult')) {
          return fauxAssistantMessage([
            fauxToolCall('create_workbench_bot', {}, { id: 'create-profile-first' }),
            fauxToolCall('create_workbench_bot', {}, { id: 'create-profile-second' }),
          ], { stopReason: 'toolUse' })
        }
        return fauxAssistantMessage(fauxText('目录核对员已建档'))
      }
      expect(tools).not.toContain('create_workbench_bot')
      return fauxAssistantMessage(fauxText('已交付常规检查'))
    })
  }, 15_000)

  it('同一主线持久保存任务，指名派发，等待上游验收，保证跨轮请求幂等', async () => {
    await fixture(async ({ runtime, workspaceId, reopen }) => {
      await runtime.updateSettings({ codemodeMode: 'off' })
      const [first, second] = await Promise.all([runtime.workbench(workspaceId), runtime.workbench(workspaceId)])
      expect(first.main.conversation.id).toBe(second.main.conversation.id)
      expect(await runtime.list()).toHaveLength(0)

      const request = { requestId: 'workbench-primary', text: '读取第一个结果', model, accessMode: 'readOnly' as const, mention: 'log' }
      await Promise.all([runtime.submitWorkbench(workspaceId, request), runtime.submitWorkbench(workspaceId, request)])
      const need = await observe(runtime, workspaceId, view => view.items[0]?.status === 'needs_human' && !view.items[0].error)
      const task = need.items[0]!
      expect(need.messages).toHaveLength(1)
      expect(need.items).toHaveLength(1)
      expect(task.assignee).toBe('log')
      expect(task.childId).toBeDefined()
      expect(task.waitingOn.kind).toBe('human')
      const child = await runtime.detail(task.childId!)
      expect(child.conversation.parentId).toBe(first.main.conversation.id)
      expect(child.interactions?.filter(interaction => interaction.status === 'pending').map(interaction => interaction.id)).toEqual(['workbench-question'])
      expect(child.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'missing-workbench-escalation', isError: true, details: { status: 'missing_escalation' } }),
      ]))

      await runtime.submitWorkbench(workspaceId, { requestId: 'workbench-next', text: '等待上一单交付', model })
      const waiting = await observe(runtime, workspaceId, view => view.items.length === 2)
      expect(waiting.items[1]).toMatchObject({ status: 'ready', waitingOn: { kind: 'dependencies' }, dependencies: [task.id] })

      const inbox = await runtime.decisionInbox.list(workspaceId)
      const question = inbox.mails.find(mail => mail.kind === 'choice')
      expect(question?.link.workItemId).toBe(task.id)
      await runtime.answerInteraction(task.childId!, question!.link.interactionId!, [{ id: 'format', selected: ['UTC'] }])
      await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      const result = (await runtime.decisionInbox.list(workspaceId)).mails.find(mail => mail.kind === 'result' && mail.link.workItemId === task.id)
      expect(result).toBeDefined()
      await runtime.decisionInbox.verdict(workspaceId, result!.id, { action: 'accept' })

      const delegated = await observe(runtime, workspaceId, view => view.items[1]?.status === 'pending_review')
      expect(delegated.items[1].assignee).toBe('time')
      expect(delegated.items[1].outcome?.summary).toContain('accepted upstream handoff')
      expect(delegated.items[0].status).toBe('ended')

      const target = delegated.items[1]
      const replyOne = { requestId: 'reply-one', text: '请追加说明一' }
      const replyTwo = { requestId: 'reply-two', text: '请追加说明二' }
      await runtime.replyWorkbench(workspaceId, target.id, replyOne)
      await observe(runtime, workspaceId, view => view.items[1]?.attempt === 2 && view.items[1].status === 'pending_review')
      await runtime.replyWorkbench(workspaceId, target.id, replyTwo)
      const final = await observe(runtime, workspaceId, view => view.items[1]?.attempt === 3 && view.items[1].status === 'pending_review')
      await runtime.replyWorkbench(workspaceId, target.id, replyOne)
      await expect(runtime.replyWorkbench(workspaceId, target.id, { ...replyOne, text: '不同内容' })).rejects.toMatchObject({ code: 'CONFLICT' })
      const reopened = await reopen()
      expect((await reopened.workbench(workspaceId)).items[1]).toMatchObject({ id: target.id, childId: target.childId, attempt: 3 })
      expect(final.items[1].outcome?.summary).toContain('请追加说明二')
    }, context => {
      const user = context.messages.findLast(message => message.role === 'user')
      const input = typeof user?.content === 'string' ? user.content : ''
      if (input.includes('工作项：读取第一个结果')) {
        const questions = [{ id: 'format', question: '用哪种格式？', options: [{ label: 'UTC' }, { label: '北京时间' }] }]
        const calls = context.messages.flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : [])
        if (calls.length === 0) return fauxAssistantMessage(fauxToolCall('ask_user_question', { questions }, {
          id: 'missing-workbench-escalation',
        }), { stopReason: 'toolUse' })
        if (!calls.includes('workbench-question')) {
          return fauxAssistantMessage(fauxToolCall('ask_user_question', {
            questions,
            escalation: { reason: 'requirement_ambiguity', why: '两种格式都有效，但需要遵循用户报告约定。' },
          }, { id: 'workbench-question' }), { stopReason: 'toolUse' })
        }
      }
      if (input.includes('answer_to_pending_question')) return fauxAssistantMessage(fauxText('UTC 固定格式'))
      if (input.includes('等待上一单交付') && input.includes('UTC 固定格式')) return fauxAssistantMessage(fauxText('accepted upstream handoff'))
      return fauxAssistantMessage(fauxText(input || '等待人工选择'))
    })
  }, 30_000)

  it('前台子会话答复和验收后，即使退出前台并重启也没有归档副本', async () => {
    let releaseQuestion!: () => void
    const waitForView = new Promise<void>(resolve => { releaseQuestion = resolve })
    await fixture(async ({ runtime, workspaceId, reopen }) => {
      try {
        await runtime.updateSettings({ codemodeMode: 'off' })
        await runtime.submitWorkbench(workspaceId, {
          requestId: 'foreground-test', text: '为交付确认格式', model, mention: 'log', accessMode: 'readOnly',
        })
        const started = await observe(runtime, workspaceId, view => !!view.items[0]?.childId)
        const item = started.items[0]!
        const childId = item.childId!
        const viewId = randomUUID()
        await runtime.decisionInbox.presence(workspaceId, childId, { viewId, sequence: 1, active: true, observed: [] })
        await delay(5)
        releaseQuestion()
        await observe(runtime, workspaceId, view => view.items[0]?.status === 'needs_human')
        expect((await runtime.decisionInbox.list(workspaceId)).mails).toEqual([])
        await runtime.answerInteraction(childId, 'foreground-question', [{ id: 'format', selected: ['CSV'] }])
        await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
        expect((await runtime.decisionInbox.list(workspaceId)).mails).toEqual([])
        await runtime.decisionInbox.verdictWorkItem(workspaceId, item.id, { action: 'accept', attempt: item.attempt })
        await runtime.decisionInbox.presence(workspaceId, childId, { viewId, sequence: 2, active: false, observed: [] })
        expect((await runtime.decisionInbox.list(workspaceId)).mails).toEqual([])
        const reopened = await reopen()
        await reopened.decisionInbox.verdictWorkItem(workspaceId, item.id, { action: 'accept', attempt: item.attempt })
        expect((await reopened.workbench(workspaceId)).items[0]).toMatchObject({ status: 'ended', outcome: { decision: 'accepted' } })
        expect((await reopened.decisionInbox.list(workspaceId)).mails).toEqual([])
      } finally {
        releaseQuestion()
      }
    }, async context => {
      if (!context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'foreground-question')) {
        await waitForView
        return fauxAssistantMessage(fauxToolCall('ask_user_question', {
          questions: [{ id: 'format', question: '交付格式选哪种？', options: [{ label: 'CSV' }, { label: 'JSON' }] }],
          escalation: { reason: 'requirement_ambiguity', why: '需按用户指定的格式交付。' },
        }, { id: 'foreground-question' }), { stopReason: 'toolUse' })
      }
      return fauxAssistantMessage(fauxText('已按会话答复交付 CSV'))
    })
  }, 20_000)

  it.each(['off', 'only'] as const)('在独立 cwd 工作，从原项目执行真实校验并读写相对路径（codemode %s）', async (codemodeMode) => {
    let project: string
    let scratch: string
    let releaseWorker!: () => void
    const readyForTools = new Promise<void>(resolve => { releaseWorker = resolve })
    await fixture(async ({ runtime, workspace, workspaceId }) => {
      try {
        project = await realpath(workspace)
        await writeFile(join(project, 'proof.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4)\n")
        await writeFile(join(project, 'draft.txt'), 'retained untracked working file\n')
        await writeFile(join(project, 'editable.txt'), 'original project content\n')
        await writeFile(join(project, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS_WORKBENCH_MARKER\n')
        await runtime.updateSettings({ codemodeMode })
        await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'fullAccess' })
        await runtime.submitWorkbench(workspaceId, { requestId: 'proof', text: '校验项目', model, accessMode: 'fullAccess' })
        const started = await observe(runtime, workspaceId, view => !!view.items[0]?.childId)
        const detail = await runtime.detail(started.items[0]!.childId!)
        scratch = await realpath(detail.conversation.cwd!)
        await writeFile(join(scratch, 'draft.txt'), 'private scratch note\n')
        await writeFile(join(scratch, 'editable.txt'), 'private scratch content\n')
      } finally {
        releaseWorker()
      }
      const review = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      const task = review.items[0]!
      const detail = await runtime.detail(task.childId!)
      expect(scratch).toContain(join('workbench-runs', workspaceId, task.id))
      const resultId = codemodeMode === 'only' ? 'check-nested' : 'read-project'
      expect(detail.messages.find(message => message.toolCallId === resultId)).toMatchObject({
        isError: false,
        blocks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('retained untracked working file') })]),
      })
      const scratchResultId = codemodeMode === 'only' ? 'check-nested' : 'read-scratch'
      expect(detail.messages.find(message => message.toolCallId === scratchResultId)).toMatchObject({
        isError: false,
        blocks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('private scratch note') })]),
      })
      if (codemodeMode === 'off') {
        expect(detail.messages.find(message => message.toolCallId === 'read-project')?.details).toMatchObject({ resolvedPath: join(project, 'draft.txt') })
        expect(detail.messages.find(message => message.toolCallId === 'write-project')?.details).toMatchObject({ resolvedPath: join(project, 'delivery.txt') })
        expect(detail.messages.find(message => message.toolCallId === 'edit-project')?.details).toMatchObject({
          resolvedPath: join(project, 'editable.txt'), patch: expect.stringContaining('+edited project content'),
        })
      }
      const artifacts = detail.messages.flatMap(message => message.artifacts ?? [])
      expect(artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'read', path: join(project, 'draft.txt') }),
        expect.objectContaining({ kind: 'read', path: join(scratch, 'draft.txt') }),
        expect.objectContaining({ kind: 'edit', path: join(project, 'editable.txt') }),
      ]))
      expect(task.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'artifact', path: join(project, 'delivery.txt') }),
        expect.objectContaining({ kind: 'artifact', path: join(project, 'editable.txt') }),
        expect.objectContaining({ kind: 'artifact', path: join(scratch, 'notes.txt') }),
      ]))
      expect(await readFile(join(project, 'delivery.txt'), 'utf8')).toBe('project delivery')
      expect(await readFile(join(project, 'editable.txt'), 'utf8')).toBe('edited project content\n')
      expect(await readFile(join(scratch, 'editable.txt'), 'utf8')).toBe('private scratch content\n')
      expect(await readFile(join(scratch, 'notes.txt'), 'utf8')).toBe('scratch delivery')
      await expect(readFile(join(scratch, 'delivery.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(task.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'validation', status: 'passed', label: 'node --test proof.test.mjs' }),
      ]))
      expect(task.evidence.some(pointer => pointer.label.includes('echo'))).toBe(false)
      expect(task.verification).toBe('recorded')
    }, async context => {
      const system = getCurrentSystemMessage(normalizeContext(context).messages)
      expect(system?.sections?.['project-instructions']).toContain('PROJECT_INSTRUCTIONS_WORKBENCH_MARKER')
      const hadTools = context.messages.some(message => message.role === 'toolResult')
      if (hadTools) return fauxAssistantMessage(fauxText('真实校验已结束'))
      await readyForTools
      const run = { command: 'node --test proof.test.mjs', workdir: project }
      const fake = { command: 'echo "test passed"', workdir: project }
      const read = { path: 'draft.txt' }
      const readScratch = { path: join(scratch, 'draft.txt') }
      const write = { path: 'delivery.txt', content: 'project delivery' }
      const writeScratch = { path: join(scratch, 'notes.txt'), content: 'scratch delivery' }
      const edit = { path: 'editable.txt', edits: [{ oldText: 'original project content', newText: 'edited project content' }] }
      if (codemodeMode === 'only') {
        const code = [
          `const file = await tools.read(${JSON.stringify(read)});`,
          `const scratch = await tools.read(${JSON.stringify(readScratch)});`,
          `await tools.write(${JSON.stringify(write)});`,
          `await tools.write(${JSON.stringify(writeScratch)});`,
          `await tools.edit(${JSON.stringify(edit)});`,
          `await tools.${shellTool}(${JSON.stringify(fake)});`,
          `const check = await tools.${shellTool}(${JSON.stringify(run)});`,
          'return { file, scratch, check };',
        ].join('\n')
        return fauxAssistantMessage(fauxToolCall('codemode', { code }, { id: 'check-nested' }), { stopReason: 'toolUse' })
      }
      return fauxAssistantMessage([
        fauxToolCall('read', read, { id: 'read-project' }),
        fauxToolCall('read', readScratch, { id: 'read-scratch' }),
        fauxToolCall('write', write, { id: 'write-project' }),
        fauxToolCall('write', writeScratch, { id: 'write-scratch' }),
        fauxToolCall('edit', edit, { id: 'edit-project' }),
        fauxToolCall(shellTool, fake, { id: 'not-evidence' }),
        fauxToolCall(shellTool, run, { id: 'check-direct' }),
      ], { stopReason: 'toolUse' })
    }, 'build')
  }, 15_000)

  it('codemode 失败后保留成功的文件操作，交付证据按路径取最新的八个文件', async () => {
    const names = Array.from({ length: 9 }, (_, index) => `file-${index}.txt`)
    const writes = [...names, names[1]!, names[1]!, names[1]!]
    await fixture(async ({ runtime, workspace, workspaceId, reopen }) => {
      await runtime.updateSettings({ codemodeMode: 'only' })
      await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'fullAccess' })
      await runtime.submitWorkbench(workspaceId, { requestId: 'partial-files', text: '写入交付文件', model, accessMode: 'fullAccess' })
      const review = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      const project = await realpath(workspace)
      const delivered = [...names.slice(2), names[1]!].map(path => join(project, path))
      const task = review.items[0]!
      const resumed = await reopen()
      const detail = await resumed.detail(task.childId!)
      const tool = detail.messages.find(message => message.toolCallId === 'partial-codemode')
      expect(tool).toMatchObject({ isError: true, artifacts: writes.map(path => ({ kind: 'write', path: join(project, path) })) })
      const saved = (await resumed.workbench(workspaceId)).items[0]!
      expect(saved.evidence.filter(pointer => pointer.kind === 'artifact')).toEqual(delivered.map(path => ({
        kind: 'artifact', label: path, path, status: 'recorded', entryId: tool?.entryId,
      })))
      expect(await readFile(join(project, names[1]!), 'utf8')).toBe(String(writes.length - 1))
      await expect(readFile(join(project, 'skipped.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }, context => {
      if (context.messages.some(message => message.role === 'toolResult')) return fauxAssistantMessage(fauxText('交付文件已写入，随后编辑缺失文件失败'))
      return fauxAssistantMessage(fauxToolCall('codemode', { code: `
        for (const [index, path] of ${JSON.stringify(writes)}.entries()) {
          await tools.write({ path, content: String(index) });
        }
        await tools.edit({ path: 'missing.txt', edits: [{ oldText: 'old', newText: 'new' }] });
        await tools.write({ path: 'skipped.txt', content: 'unreachable' });
      ` }, { id: 'partial-codemode' }), { stopReason: 'toolUse' })
    }, 'build')
  }, 15_000)

  it('只读工作项可从项目读取相对路径，不能通过 codemode 写入', async () => {
    await fixture(async ({ runtime, workspace, workspaceId }) => {
      await writeFile(join(workspace, 'source.txt'), 'readable project source')
      await runtime.updateSettings({ codemodeMode: 'only' })
      await runtime.submitWorkbench(workspaceId, { requestId: 'read-only-files', text: '读取项目', model, accessMode: 'readOnly' })
      const ready = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      const detail = await runtime.detail(ready.items[0]!.childId!)
      expect(detail.conversation.accessMode).toBe('readOnly')
      expect(detail.messages.find(message => message.toolCallId === 'read-only-tools')).toMatchObject({
        isError: false,
        blocks: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('readable project source') })]),
      })
      expect(await readFile(join(workspace, 'source.txt'), 'utf8')).toBe('readable project source')
    }, context => {
      if (context.messages.some(message => message.role === 'toolResult')) return fauxAssistantMessage(fauxText('已读取项目'))
      return fauxAssistantMessage(fauxToolCall('codemode', { code: `
        const source = await tools.read({ path: 'source.txt' });
        try {
          await tools.write({ path: 'source.txt', content: 'must not be written' });
        } catch {
          return source;
        }
        throw new Error('read-only write unexpectedly succeeded');
      ` }, { id: 'read-only-tools' }), { stopReason: 'toolUse' })
    })
  }, 15_000)

  it('派发按 Bot 当前配置取权，显式只读派发重试保留上限，直接续聊重新采用 Bot 配置', async () => {
    const planned = new Map<string, AccessMode>()
    await fixture(async ({ runtime, workspaceId }) => {
      await runtime.updateSettings({ defaultAccessMode: 'readOnly', codemodeMode: 'off' })
      await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'fullAccess' })
      await runtime.submitWorkbench(workspaceId, { requestId: 'auto-permission', text: '自动派发', model })
      const automatic = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      const previous = automatic.items[0]!
      // 任务类型不再收窄权限：自动派发同样采用 Bot 已配置的权限。规划阶段还不知道
      // 最终执行者，因此给规划模型的提示仍是派发权限；生效权限在启动工作项时决定。
      expect(previous).toMatchObject({ type: 'build', accessMode: 'fullAccess' })
      expect(planned.get('自动派发')).toBe('readOnly')
      expect((await runtime.detail(previous.childId!)).conversation.accessMode).toBe('fullAccess')

      await runtime.submitWorkbench(workspaceId, {
        requestId: 'explicit-cap', text: '只读排查失败', mention: 'time', model, accessMode: 'readOnly',
      })
      const failed = await observe(runtime, workspaceId, view => view.items[1]?.failure?.code === 'MODEL_AUTH_FAILED')
      const item = failed.items[1]!
      expect(item.accessMode).toBe('readOnly')
      expect(planned.get('只读排查失败')).toBe('readOnly')
      await runtime.retryWorkbench(workspaceId, { itemId: item.id, attempt: 1 })
      const recovered = await observe(runtime, workspaceId, view => view.items[1]?.attempt === 2 && view.items[1]?.status === 'pending_review')
      expect(recovered.items[1]).toMatchObject({ childId: item.childId, attempt: 2, accessMode: 'readOnly' })
      expect((await runtime.detail(item.childId!)).conversation.accessMode).toBe('readOnly')

      await runtime.replyWorkbench(workspaceId, previous.id, { requestId: 'reply-old-auto', text: '进入独立的直接对话' })
      const continued = await observe(runtime, workspaceId, view => view.items[0]?.attempt === 2 && view.items[0]?.status === 'pending_review')
      expect(continued.items[0]).toMatchObject({ childId: previous.childId, attempt: 2, accessMode: 'fullAccess' })
      expect((await runtime.detail(previous.childId!)).conversation.accessMode).toBe('fullAccess')
    }, context => {
      const transcript = normalizeContext(context).messages
      const worker = getCurrentSystemMessage(transcript)?.sections?.instructions?.includes('你在自己的子会话')
      const request = context.messages.findLast(message => message.role === 'user')?.content
      if (worker && typeof request === 'string' && request.includes('只读排查失败')) {
        return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 Unauthorized' })
      }
      return fauxAssistantMessage('已检查')
    }, 'build', (request, accessMode) => { planned.set(request, accessMode) })
  }, 20_000)

  it('改完 Bot 权限后新派发立即生效，且不受任务类型影响', async () => {
    const planned = new Map<string, AccessMode>()
    await fixture(async ({ runtime, workspaceId }) => {
      await runtime.updateSettings({ defaultAccessMode: 'readOnly', codemodeMode: 'off' })
      await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'readOnly' })
      await runtime.submitWorkbench(workspaceId, { requestId: 'before-permission', text: '改权限前', model })
      const before = await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
      expect(before.items[0]).toMatchObject({ type: 'decide', accessMode: 'readOnly' })

      // 配置完成即可直接使用：无需先跑完一轮或续聊刷新。
      await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'fullAccess' })
      await runtime.submitWorkbench(workspaceId, { requestId: 'after-permission', text: '改权限后', model })
      const after = await observe(runtime, workspaceId, view => view.items[1]?.status === 'pending_review')
      expect(after.items[1]).toMatchObject({ type: 'decide', accessMode: 'fullAccess' })
      // 规划阶段还不知道执行者，提示值是派发权限；生效权限才是 Bot 配置。
      expect(planned.get('改权限后')).toBe('readOnly')
      expect((await runtime.detail(after.items[1]!.childId!)).conversation.accessMode).toBe('fullAccess')
    }, () => fauxAssistantMessage('已检查'), 'decide', (request, accessMode) => { planned.set(request, accessMode) })
  }, 20_000)

  it.runIf(process.platform === 'darwin')('同一 Bot 子会话续聊刷新写沙盒、完全访问和只读工具', async () => {
    let outside: string
    let allowSandboxTools!: () => void
    const sandboxGate = new Promise<void>(resolve => { allowSandboxTools = resolve })
    const planned = new Map<string, AccessMode>()
    await fixture(async ({ runtime, workspace, workspaceId }) => {
      try {
        outside = dirname(await realpath(workspace))
        await runtime.updateSettings({ defaultAccessMode: 'readOnly', codemodeMode: 'off' })
        await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'workspaceWrite' })
        await runtime.submitWorkbench(workspaceId, { requestId: 'sandbox-permission', text: '使用项目写沙盒', mention: 'time', model })
        const started = await observe(runtime, workspaceId, view => view.items[0]?.status === 'running')
        const first = started.items[0]!
        expect(first).toMatchObject({ type: 'investigate', accessMode: 'workspaceWrite' })
        expect(planned.get('使用项目写沙盒')).toBe('workspaceWrite')
        const configured = await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'fullAccess' })
        expect(configured.accessMode).toBe('fullAccess')
        expect((await runtime.workbench(workspaceId)).items[0]?.accessMode).toBe('workspaceWrite')
        allowSandboxTools()

        await observe(runtime, workspaceId, view => view.items[0]?.status === 'pending_review')
        const childId = first.childId!
        const sandbox = await runtime.detail(childId)
        expect(sandbox.conversation.accessMode).toBe('workspaceWrite')
        expect(sandbox.messages.find(message => message.toolCallId === 'sandbox-outside')?.isError).toBe(true)
        expect(await readFile(join(workspace, 'sandbox-inside.txt'), 'utf8')).toBe('sandbox')
        await expect(readFile(join(outside, 'sandbox-outside.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

        await runtime.replyWorkbench(workspaceId, first.id, { requestId: 'direct-fully-authorized', text: '测试已配置的完全访问' })
        const full = await observe(runtime, workspaceId, view => view.items[0]?.attempt === 2 && view.items[0]?.status === 'pending_review')
        expect(full.items[0]).toMatchObject({ childId, accessMode: 'fullAccess' })
        expect((await runtime.detail(childId)).conversation.accessMode).toBe('fullAccess')
        expect(await readFile(join(outside, 'full-outside.txt'), 'utf8')).toBe('full')

        await runtime.updateWorkbenchBot(workspaceId, 'time', { accessMode: 'readOnly' })
        await runtime.replyWorkbench(workspaceId, first.id, { requestId: 'direct-read-only', text: '测试已收窄的只读' })
        const readOnly = await observe(runtime, workspaceId, view => view.items[0]?.attempt === 3 && view.items[0]?.status === 'pending_review')
        expect(readOnly.items[0]).toMatchObject({ childId, accessMode: 'readOnly' })
        expect((await runtime.detail(childId)).conversation.accessMode).toBe('readOnly')
        await expect(readFile(join(workspace, 'readonly-inside.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        allowSandboxTools()
      }
    }, async context => {
      const transcript = normalizeContext(context).messages
      if (!getCurrentSystemMessage(transcript)?.sections?.instructions?.includes('你在自己的子会话')) {
        return fauxAssistantMessage('权限验证')
      }
      const request = context.messages.findLast(message => message.role === 'user')?.content
      if (typeof request !== 'string') throw new Error('Missing worker request')
      const hasResult = (id: string) => context.messages.some(message => message.role === 'toolResult' && message.toolCallId === id)
      if (request.includes('测试已收窄的只读')) {
        expect(getCurrentTools(transcript).map(tool => tool.name)).not.toContain('write')
        if (hasResult('readonly-inside')) return fauxAssistantMessage('只读写入已拒绝')
        return fauxAssistantMessage(fauxToolCall('write', { path: 'readonly-inside.txt', content: 'denied' }, { id: 'readonly-inside' }), { stopReason: 'toolUse' })
      }
      if (request.includes('测试已配置的完全访问')) {
        if (hasResult('full-outside')) return fauxAssistantMessage('完全访问已验证')
        return fauxAssistantMessage(fauxToolCall('write', { path: join(outside, 'full-outside.txt'), content: 'full' }, { id: 'full-outside' }), { stopReason: 'toolUse' })
      }
      if (hasResult('sandbox-outside')) return fauxAssistantMessage('写沙盒已验证')
      await sandboxGate
      return fauxAssistantMessage([
        fauxToolCall('write', { path: 'sandbox-inside.txt', content: 'sandbox' }, { id: 'sandbox-inside' }),
        fauxToolCall('write', { path: join(outside, 'sandbox-outside.txt'), content: 'denied' }, { id: 'sandbox-outside' }),
      ], { stopReason: 'toolUse' })
    }, 'investigate', (request, accessMode) => { planned.set(request, accessMode) })
  }, 20_000)

  it.runIf(process.platform === 'darwin')('macOS 写沙盒允许原项目交付和工作项目录，拒绝其他位置', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'pi-web-workbench-sandbox-'))
    try {
      const root = await realpath(temporary)
      const scratch = join(root, 'scratch')
      const project = join(root, 'project')
      await Promise.all([mkdir(scratch), mkdir(project)])
      const env = await createExecutionEnv(scratch, 'workspaceWrite', [], project)
      expect(env.cwd).toBe(scratch)
      expect(await resolveWorkdir(scratch, project, workbenchProject(env))).toBe(project)
      await expect(resolveWorkdir(scratch, root, workbenchProject(env))).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect((await env.writeFile(join(project, 'delivery.txt'), 'native delivery', CTX)).ok).toBe(true)
      expect((await env.writeFile(join(scratch, 'notes.txt'), 'private notes', CTX)).ok).toBe(true)
      expect((await env.writeFile(join(root, 'outside.txt'), 'blocked', CTX)).ok).toBe(false)
      const fileEnv = workbenchFileEnv(env)!
      expect(fileEnv.cwd).toBe(project)
      expect((await fileEnv.writeFile('delivery.txt', 'relative project delivery', CTX)).ok).toBe(true)
      expect((await fileEnv.writeFile(join(scratch, 'notes.txt'), 'absolute scratch note', CTX)).ok).toBe(true)
      expect((await fileEnv.writeFile('../outside.txt', 'blocked', CTX)).ok).toBe(false)
      await symlink(root, join(project, 'escaped'))
      expect((await fileEnv.writeFile(join('escaped', 'outside.txt'), 'blocked', CTX)).ok).toBe(false)
      await env.exec(['/bin/sh', '-c', 'printf "shell delivery" > "$1"', 'workbench', join(project, 'shell.txt')], undefined, CTX)
      expect(await readFile(join(project, 'shell.txt'), 'utf8')).toBe('shell delivery')
      expect(await readFile(join(project, 'delivery.txt'), 'utf8')).toBe('relative project delivery')
      expect(await readFile(join(scratch, 'notes.txt'), 'utf8')).toBe('absolute scratch note')
      await expect(readFile(join(root, 'outside.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
