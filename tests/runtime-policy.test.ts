/**
 * 运行时策略在真实 provider 边界的端到端测试（真实 runtime + demo 模型请求捕获）。
 *
 * 关键契约：
 * - 默认策略：runtime-core 恰好一份、work-policy 含工作区路径与 todo_write、不含 /plan、
 *   计划/目标工具在册、workspace 保持为空；
 * - 项目指令只加载绑定工作区根的 AGENTS.md 且每轮刷新（外部目录不进提示词）；
 * - codemode only：provider 只见 codemode 一个工具，work/goal 措辞切换为脚本路由；
 * - 计划模式：研究优先提示词、只读工具集、既有目标续跑挂起（等用户答复后恢复）；
 *   write/edit/shell 尝试被拒且退出计划后同一工具恢复可用；codemode 脚本嵌套调用 shell
 *   也被拦截；委派子会话继承计划且守卫跨重启保留；既有子代理随父进入计划；
 * - 目标轮：等待 question 答复期间不启动轮次，答复后自动恢复；只读会话可用目标工具；
 * - 子会话与 fork 会话同样携带核心策略；排队编辑恢复（低层 Harness 提交）在调度器启动前
 *   装好执行守卫（计划内写工具全拒）；
 * - 记忆：memory/memory-index section 仅在开关开启时注入且跨重启保留；只读会话省略保存规则。
 */
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { AgentDoc, Harness, createRegistry, defineDoc, type ConversationId } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { getCurrentSystemMessage, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { SystemMessage } from '@earendil-works/pi-ai'
import { createRuntime, type ConversationMetadata } from '../src/server/runtime/index.ts'
import { createDemoModelRuntime, observeDemoRequests } from '../src/server/model/demo.ts'
import { RUNTIME_CORE_PROMPT } from '../src/server/conversation/work-policy.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'
import type { Runtime } from '../src/server/contracts.ts'

/** 平台对应的 shell 工具名。 */
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

/** 捕获的请求证据：用户文本、system 消息（深拷贝）与工具名列表。 */
type RequestEvidence = { user: string; system: SystemMessage | undefined; tools: string[] }
/** 清理函数队列（删临时目录/关 runtime/退订观察器），afterEach 逆序执行。 */
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/**
 * 搭建带请求观察器的 runtime fixture：临时目录 + demo runtime，
 * 捕获每次发往 provider 的 user 文本、system sections 与工具名。
 * @returns root/options/requests、runtime（getter 支持 restart）与 restart()
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-policy-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { dataDir: join(root, 'data'), workspace: join(root, 'workspace'), piDir: join(root, 'pi'), demo: true }
  await mkdir(options.piDir)
  await writeFile(join(options.piDir, 'settings.json'), '{}')
  let runtime = await createRuntime(options)
  cleanup.push(() => runtime.close())
  const requests: RequestEvidence[] = []
  const unobserve = observeDemoRequests(request => {
    const messages = normalizeContext(request).messages
    const user = [...messages].reverse().find(message => message.role === 'user')
    requests.push({
      user: user?.role === 'user' ? typeof user.content === 'string' ? user.content : user.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : '',
      system: structuredClone(getCurrentSystemMessage(messages)),
      tools: getCurrentTools(messages).map(tool => tool.name),
    })
  })
  cleanup.push(async () => unobserve())
  return {
    root, options, requests,
    get runtime() { return runtime },
    async restart() { await runtime.close(); runtime = await createRuntime(options) },
  }
}

/**
 * 提交一条消息并轮询等待回合落定（不出错且出现非流式 assistant 消息）。
 * @param runtime 目标运行时
 * @param id 会话 id
 * @param text 提交文本（通常带探针标记）
 * @returns 落定后的会话详情
 */
async function send(runtime: Runtime, id: string, text: string) {
  const count = (await runtime.detail(id)).messages.length
  await runtime.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return detail
    await delay(20)
  }
  throw new Error('Policy acceptance turn did not settle')
}

/**
 * 按用户文本标记定位最近一次匹配的 provider 请求。
 * @param requests 捕获列表
 * @param marker 用户文本中的标记
 * @returns 匹配的请求证据
 */
function currentRequest(requests: RequestEvidence[], marker: string) {
  const value = requests.findLast(request => request.user.includes(marker))
  if (!value) throw new Error(`No provider request for ${marker}`)
  return value
}
/**
 * 断言请求携带 runtime-core section 且恰好一份（RUNTIME_CORE_PROMPT 原文在内）。
 * @param request 捕获的请求证据
 */
function expectCore(request: RequestEvidence) {
  expect(request.system?.sections?.['runtime-core']).toContain(RUNTIME_CORE_PROMPT)
  expect(Object.keys(request.system?.sections ?? {}).filter(key => key === 'runtime-core')).toHaveLength(1)
}

/** 默认策略在 provider 边界的端到端测试。 */
describe('default policy at the actual Pi provider boundary', () => {
  // 验证默认请求形状：runtime-core 唯一、work-policy 含工作区路径/todo_write/无 /plan、
  // enter_plan_mode/todo_write/create_goal 工具在册、无既有目标、workspace 空。
  it('includes the core, workspace, planning route and goal guidance without an existing goal', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Default policy' })
    const detail = await send(f.runtime, conversation.conversation.id, '[prompt-probe] default')
    const request = currentRequest(f.requests, '[prompt-probe] default')
    expectCore(request)
    expect(request.system?.sections?.['work-policy']).toContain(conversation.conversation.cwd)
    expect(request.system?.sections?.['work-policy']).toContain('todo_write')
    expect(request.system?.sections?.['work-policy']).not.toContain('/plan')
    expect(request.tools).toContain('enter_plan_mode')
    expect(request.system?.sections?.['goal-policy']).toContain('create_goal')
    expect(request.tools).toContain('todo_write')
    expect(request.tools).toContain('create_goal')
    expect(detail.goal ?? null).toBeNull()
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  // 验证项目指令边界：只加载绑定工作区根的 AGENTS.md（外部目录的内容不进提示词），
  // 且每轮重读——改写后新一轮请求出现新内容、旧内容消失。
  it('loads and refreshes only the bound workspace root instructions at the provider boundary', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'AGENTS.md'), 'OUTSIDE_SCOPE_541')
    await writeFile(join(f.options.workspace, 'AGENTS.md'), 'ROOT_RULE_REVISION_ONE_541')
    const conversation = await f.runtime.create({ title: 'Root instructions' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] root-one')
    const first = currentRequest(f.requests, '[prompt-probe] root-one')
    expect(first.system?.sections?.['project-instructions']).toContain('ROOT_RULE_REVISION_ONE_541')
    expect(first.system?.sections?.['project-instructions']).not.toContain('OUTSIDE_SCOPE_541')
    await writeFile(join(f.options.workspace, 'AGENTS.md'), 'ROOT_RULE_REVISION_TWO_541')
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] root-two')
    const second = currentRequest(f.requests, '[prompt-probe] root-two')
    expect(second.system?.sections?.['project-instructions']).toContain('ROOT_RULE_REVISION_TWO_541')
    expect(second.system?.sections?.['project-instructions']).not.toContain('ROOT_RULE_REVISION_ONE_541')
  })

  // 验证 codemode only 路由：provider 只见 codemode 一个工具；work/goal 措辞切到脚本形态
  // （tools.todo_write / codemode）；codemode section 含"只提供 codemode/仍可输出普通文本/
  // describeTool 发现"，且不含直连工具措辞。
  it('gives script-only routing while the provider sees only codemode', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ codemodeMode: 'only' })
    const conversation = await f.runtime.create({ title: 'Script route' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] script')
    const request = currentRequest(f.requests, '[prompt-probe] script')
    expectCore(request)
    expect(request.tools).toEqual(['codemode'])
    expect(request.system?.sections?.['work-policy']).toContain('tools.todo_write')
    expect(request.system?.sections?.['goal-policy']).toContain('codemode')
    expect(request.system?.sections?.codemode).toContain('本请求只直接提供 codemode 工具')
    expect(request.system?.sections?.codemode).toContain('仍可输出普通助手文本')
    expect(request.system?.sections?.codemode).toContain('用 describeTool(name)')
    expect(request.system?.sections?.codemode).not.toContain('单项操作使用直接工具')
  })

  // 验证计划模式提示词与工具面：plan-policy 全要点（先探索/命令式语言/不结束计划/决策完整/
  // 唯一工具调用/不当普通回复/ask_user_question/工作顺序/定稿前未决）；work-policy 去掉
  // tools.todo_write；工具集为只读（read/glob/grep 有、write/edit/shell/send_message 无）；
  // 既有目标挂起（roundsStarted=0、无 [goal 请求）；workspace 保持空。
  it('keeps plan mode research-only and suspends an existing goal continuation', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Planning' })
    await f.runtime.goal(conversation.conversation.id, { action: 'create', objective: 'Research the change', maxGoalRounds: 3 })
    await f.runtime.setPlan(conversation.conversation.id, true)
    const detail = await send(f.runtime, conversation.conversation.id, '[prompt-probe] planning')
    const request = currentRequest(f.requests, '[prompt-probe] planning')
    expectCore(request)
    const planPolicy = request.system?.sections?.['plan-policy'] ?? ''
    expect(planPolicy).toContain('先探索')
    expect(planPolicy).toContain('命令式语言要求实施时')
    expect(planPolicy).toContain('不结束计划模式')
    expect(planPolicy).toContain('计划要决策完整')
    expect(planPolicy).toContain('唯一且最后一个工具调用')
    expect(planPolicy).toContain('不要把计划当普通回复粘贴')
    expect(planPolicy).toContain('ask_user_question')
    expect(planPolicy).toContain('工作顺序：先探索仓库')
    expect(planPolicy).toContain('定稿前如仍有重大未决')
    expect(request.system?.sections?.['work-policy']).not.toContain('tools.todo_write')
    expect(request.tools).toEqual(expect.arrayContaining(['read', 'glob', 'grep']))
    expect(request.tools).not.toEqual(expect.arrayContaining(['write', 'edit', SHELL_TOOL]))
    expect(request.tools).not.toContain('send_message')
    expect(request.system?.sections?.codemode).not.toContain(`tools.${SHELL_TOOL}(`)
    expect(detail.goal?.roundsStarted).toBe(0)
    expect(f.requests.filter(item => item.user.startsWith('[goal '))).toHaveLength(0)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  // 验证计划内执行拦截与恢复：fullAccess 会话在计划中尝试 write/edit/shell 全部失败
  // （workspace 未写入）且计划保持 active；退出计划后同一 write 成功、文件落盘。
  it('rejects attempted writes and shell execution in Plan, then restores the same tools on exit', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ codemodeMode: 'off' })
    const conversation = await f.runtime.create({ title: 'Plan enforcement', accessMode: 'fullAccess' })
    const id = conversation.conversation.id
    await f.runtime.setPlan(id, true)
    const planned = await send(f.runtime, id, '[render-fixture]')
    const writes = planned.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(writes.map(message => message.toolName)).toEqual(['write', 'edit', SHELL_TOOL])
    expect(writes.every(message => message.isError === true)).toBe(true)
    expect(planned.plan?.active).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])

    await f.runtime.setPlan(id, false)
    const resumed = await send(f.runtime, id, '[render-fixture]')
    const latestWrite = resumed.messages.findLast(message => message.role === 'tool' && message.toolName === 'write')
    expect(latestWrite?.isError ?? false).toBe(false)
    expect(await readFile(join(f.options.workspace, 'render-fixture.md'), 'utf8')).toContain('# After')
  })

  // 验证嵌套拦截：codemode only + 计划模式下，脚本内调用 shell 工具会让 codemode 调用本身
  // 失败，shell 工具没有成功执行的记录，workspace 保持空。
  it('blocks a code-mode script from reaching shell tools while Plan is active', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ codemodeMode: 'only' })
    const conversation = await f.runtime.create({ title: 'Plan nested enforcement' })
    await f.runtime.setPlan(conversation.conversation.id, true)
    const result = await send(f.runtime, conversation.conversation.id, '[codemode]')
    expect(result.messages.some(message => message.role === 'tool' && message.toolName === 'codemode' && message.isError)).toBe(true)
    expect(result.messages.some(message => message.role === 'tool' && message.toolName === SHELL_TOOL && !message.isError)).toBe(false)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  // 验证计划内委派：计划中的父会话委派子代理，子会话继承 plan active；
  // runtime 重启后子会话的写工具尝试仍全部被拒；从父会话 entry fork 出的分支同样 plan active。
  it('keeps delegated child calls in Plan and preserves the guard after restart', async () => {
    const f = await fixture()
    const parent = await f.runtime.create({ title: 'Plan delegation' })
    await f.runtime.setPlan(parent.conversation.id, true)
    const parentDetail = await send(f.runtime, parent.conversation.id, '[subagent]')
    const child = (await f.runtime.children(parent.conversation.id))[0]!
    expect((await f.runtime.detail(child.id)).plan?.active).toBe(true)
    await f.restart()
    const result = await send(f.runtime, child.id, '[render-fixture]')
    const denied = result.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(denied).toHaveLength(3)
    expect(denied.every(message => message.isError)).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])
    const entry = parentDetail.messages.findLast(message => message.role === 'assistant' && message.entryId)!.entryId!
    const fork = await f.runtime.fork(parent.conversation.id, entry)
    expect(fork.plan?.active).toBe(true)
  })

  // 验证既有子代理被约束：父在子创建后才进入计划，子会话的 plan 随之 active（无需重启）；
  // 重启后在子会话里的写工具尝试全部失败、workspace 保持空。
  it('constrains an existing child when its owner enters Plan, including restart and reuse', async () => {
    const f = await fixture()
    const parent = await f.runtime.create({ title: 'Existing writer' })
    await send(f.runtime, parent.conversation.id, '[subagent]')
    const child = (await f.runtime.children(parent.conversation.id))[0]!
    expect((await f.runtime.detail(child.id)).plan?.active).toBe(false)
    await f.runtime.setPlan(parent.conversation.id, true)
    expect((await f.runtime.detail(child.id)).plan?.active).toBe(true)
    await f.restart()
    const result = await send(f.runtime, child.id, '[render-fixture]')
    const denied = result.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(denied).toHaveLength(3)
    expect(denied.every(message => message.isError)).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  // 验证 codemode section 精简：工具目录保留 read/write/shell/codememode；
  // 脚本说明含 describeTool 发现路由、总长 <2,000 字符、不含逐工具 declare function 声明。
  it('deduplicates code-mode declarations without hiding their discovery route', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Compact tool context' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] compact-tools')
    const request = currentRequest(f.requests, '[prompt-probe] compact-tools')
    expect(request.tools).toEqual(expect.arrayContaining(['read', 'write', SHELL_TOOL, 'codemode']))
    const code = request.system?.sections?.codemode ?? ''
    expect(code).toContain('describeTool')
    expect(code.length).toBeLessThan(2_000)
    expect(code).not.toContain('declare function')
  })

  // 验证目标轮与提问互斥：ask_user_question pending 期间不启动目标轮（roundsStarted=0、
  // 无 [goal 请求）、goal-policy 说明"自动续跑会等待答复"；答复后轮次自动恢复（roundsStarted>0）。
  it('holds automatic goal rounds while a question waits for the user, then resumes after the answer', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Goal with a question' })
    const id = conversation.conversation.id
    await f.runtime.goal(id, { action: 'create', objective: 'Ship the demo', maxGoalRounds: 3 })
    const asked = await send(f.runtime, id, '[ask] goal question')
    const pending = asked.interactions?.find(interaction => interaction.status === 'pending')
    expect(pending?.kind).toBe('question')
    expect(asked.goal?.roundsStarted).toBe(0)
    expect(f.requests.filter(item => item.user.startsWith('[goal '))).toHaveLength(0)
    expect(currentRequest(f.requests, '[ask] goal question').system?.sections?.['goal-policy']).toContain('自动续跑会等待答复')

    await f.runtime.answerInteraction(id, pending!.id, [
      { id: 'scope', selected: ['前端交互 (Recommended)'] },
      { id: 'notes', selected: [] },
    ])
    const deadline = Date.now() + 15_000
    let resumed = await f.runtime.detail(id)
    while ((resumed.conversation.busy || (resumed.goal?.roundsStarted ?? 0) === 0) && Date.now() < deadline) {
      await delay(20)
      resumed = await f.runtime.detail(id)
    }
    expect(resumed.goal?.roundsStarted).toBeGreaterThan(0)
  })

  // 验证只读会话的目标追踪：目标三件套（create/get/update_goal）在册、write/shell 不在册、
  // 3 轮目标轮全部完成且无工具错误、workspace 保持空。
  it('allows goal tracking in a read-only conversation without filesystem write tools', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Read-only objective', accessMode: 'readOnly' })
    const detail = await send(f.runtime, conversation.conversation.id, '[goal]')
    const request = currentRequest(f.requests, '[goal]')
    expectCore(request)
    expect(request.tools).toEqual(expect.arrayContaining(['create_goal', 'get_goal', 'update_goal']))
    expect(request.tools).not.toContain('write')
    expect(request.tools).not.toContain(SHELL_TOOL)
    expect(detail.goal?.roundsStarted).toBe(3)
    expect(detail.messages.filter(item => item.role === 'tool').some(item => item.isError)).toBe(false)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  // 验证策略传递：子会话与从父 entry fork 出的分支请求都携带唯一的 runtime-core。
  it('includes the policy in child and forked conversations', async () => {
    const f = await fixture()
    const parent = await f.runtime.create({ title: 'Parent' })
    const detail = await send(f.runtime, parent.conversation.id, '[subagent]')
    const child = (await f.runtime.children(parent.conversation.id))[0]!
    await send(f.runtime, child.id, '[prompt-probe] child')
    expectCore(currentRequest(f.requests, '[prompt-probe] child'))
    const entry = detail.messages.findLast(message => message.role === 'assistant' && message.entryId)!.entryId!
    const fork = await f.runtime.fork(parent.conversation.id, entry)
    await send(f.runtime, fork.conversation.id, '[prompt-probe] fork')
    expectCore(currentRequest(f.requests, '[prompt-probe] fork'))
  })

  // 验证恢复顺序防线：关闭 runtime 后用低层 Harness 直写一条 aborted 的排队编辑（计划仍 active），
  // 重启后调度器恢复该编辑时守卫已就位——请求不含 write 工具、write/edit/shell 尝试全部失败、
  // workspace 保持空。
  it('installs execution guards before recovering a queued edit that starts the scheduler', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Recovered plan', accessMode: 'fullAccess' })
    const id = Number(conversation.conversation.id) as ConversationId
    await f.runtime.setPlan(String(id), true)
    await f.runtime.close()
    const registry = createRegistry()
    registry.install(CodingTools)
    const harness = await Harness.open(await openNodeSqliteStorage(join(f.options.dataDir, 'pi-durable.sqlite')), {
      models: createDemoModelRuntime().models, registry,
    }, BACKGROUND_CONTEXT)
    const metadata = defineDoc<ConversationMetadata>({
      kind: 'pi-durable-web.conversation', version: 1, scope: 'conversation',
      history: 'latest', fork: 'initial', checkpointWhen: () => false,
      initial: () => { throw new Error('The fixture must already have conversation metadata') },
    })
    try {
      await harness.commit(async tx => {
        const source = await tx.createSubmission({ type: 'input', conversationId: id, status: 'unanswered', reason: 'aborted' })
        const agent = await tx.doc(AgentDoc, id)
        agent.extensions = ['coding-tools']
        const doc = await tx.doc(metadata, id)
        doc.queueEdits['recovered-plan-edit'] = {
          fingerprint: 'recovery-fixture', sourceSubmissionId: Number(source.id),
          status: 'aborted', submissionId: null,
          input: { text: '[render-fixture] recovered-plan', whenBusy: 'followUp', images: [], files: [] },
        }
      }, BACKGROUND_CONTEXT)
    } finally { await harness.close(BACKGROUND_CONTEXT) }
    await f.restart()
    const deadline = Date.now() + 15_000
    let result = await f.runtime.detail(String(id))
    while ((result.conversation.busy || !result.messages.some(message => message.role === 'tool')) && Date.now() < deadline) {
      await delay(20)
      result = await f.runtime.detail(String(id))
    }
    expect(result.conversation.busy).toBe(false)
    const request = currentRequest(f.requests, 'recovered-plan')
    expectCore(request)
    expect(request.tools).not.toContain('write')
    const writes = result.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(writes).toHaveLength(3)
    expect(writes.every(message => message.isError)).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])
  })
})

/** 工作区记忆 section 在 provider 边界的注入测试。 */
describe('workspace memory sections at the provider boundary', () => {
  // 验证记忆开关：开启时 memory（规则 + 根路径）与 memory-index（索引内容 + MEMORY.md 绝对路径）
  // 注入；关闭后两个 section 消失；重启后重新开启仍注入（持久化设置）。
  it('injects the rules and the index only while the setting is on, and keeps them across a restart', async () => {
    const f = await fixture()
    const root = resolveMemoryRoot({ dataDir: f.options.dataDir, workspacePath: await realpath(f.options.workspace) })
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'MEMORY.md'), '- [Pref](prefs.md) — prefers Chinese\n', 'utf8')
    await f.runtime.updateSettings({ memoryEnabled: true })

    const conversation = await f.runtime.create({ title: 'Memory on' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] memory-on')
    const on = currentRequest(f.requests, '[prompt-probe] memory-on')
    expect(on.system?.sections?.memory).toContain(`\`${root}/\``)
    expect(on.system?.sections?.['memory-index']).toContain('- [Pref](prefs.md) — prefers Chinese')
    expect(on.system?.sections?.['memory-index']).toContain(join(root, 'MEMORY.md'))

    await f.runtime.updateSettings({ memoryEnabled: false })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] memory-off')
    const off = currentRequest(f.requests, '[prompt-probe] memory-off')
    expect(off.system?.sections?.memory).toBeUndefined()
    expect(off.system?.sections?.['memory-index']).toBeUndefined()

    await f.runtime.updateSettings({ memoryEnabled: true })
    await f.restart()
    const restarted = await f.runtime.create({ title: 'Memory restarted' })
    await send(f.runtime, restarted.conversation.id, '[prompt-probe] memory-restart')
    const after = currentRequest(f.requests, '[prompt-probe] memory-restart')
    expect(after.system?.sections?.memory).toContain(`\`${root}/\``)
    expect(after.system?.sections?.['memory-index']).toContain('- [Pref](prefs.md) — prefers Chinese')
  }, 30_000)

  // 验证只读会话的记忆策略：省略保存规则（memory section），但已有索引仍注入（memory-index）。
  it('omits the save rules for a read-only session but still offers an existing index', async () => {
    const f = await fixture()
    const root = resolveMemoryRoot({ dataDir: f.options.dataDir, workspacePath: await realpath(f.options.workspace) })
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'MEMORY.md'), '- [Pref](prefs.md) — prefers Chinese\n', 'utf8')
    await f.runtime.updateSettings({ memoryEnabled: true })

    const conversation = await f.runtime.create({ title: 'Read-only memory', accessMode: 'readOnly' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] memory-readonly')
    const request = currentRequest(f.requests, '[prompt-probe] memory-readonly')
    expect(request.system?.sections?.memory).toBeUndefined()
    expect(request.system?.sections?.['memory-index']).toContain('- [Pref](prefs.md) — prefers Chinese')
  }, 20_000)
})
