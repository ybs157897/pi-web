/**
 * 规划工具（plan/goal/todo/interaction）的提示词策略与写入守卫测试（纯 mock，无 IO）。
 *
 * 关键契约：
 * - 提示词策略只点名当前请求实际可用的工具：直连工具用直接调用措辞、codemode 可用时用
 *   `await tools.xxx(...)` 嵌套措辞、工具不可用时给出最终回复兜底且不提工具名；
 *   委派子会话不提交计划也不向用户提问；运行时授权回调（canCreate/canContinue）否决的路由不出现；
 * - 工具描述（模型可见文案）包含安全边界：宿主强制只读、等待答复不等于许可、
 *   完成以验证证据为准而非轮次阈值、update_goal 只暴露模型侧动作；
 * - 写入守卫：计划模式开启时 todo_write/create_goal 拒绝且不开事务；canCreate 拒绝时
 *   fail-closed（连 snapshot 都不做）；目标自动续跑在计划模式/授权否决/事务内复检计划时全部不继续。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/chord/context'
import type { Extension } from '@earendil-works/pi-durable'
import { Goals, createGoalExtension } from '../src/server/tools/goal.ts'
import { InteractionTools } from '../src/server/tools/interaction.ts'
import { PlanExtension, Plans } from '../src/server/tools/plan.ts'
import { Subagents } from '../src/server/conversation/subagent-policy.ts'
import { TodoTools, Todos } from '../src/server/tools/todo.ts'

/** section.render 的最小输入形态（agent 工具面 + 文档快照读取器）。 */
type PromptInput = {
  conversationId: string
  agent: { tools: { name: string }[]; callable: { name: string }[] }
  env: undefined
  shown: Record<string, string>
  read: { snapshot: (document: unknown, id: string, context: unknown) => Promise<unknown> }
}

/** mock api 的形态：snapshot/commit/agent 均为 vi.fn。 */
type MockApi = {
  conversationId: string
  snapshot: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  agent: ReturnType<typeof vi.fn>
}

/** 空执行上下文占位（工具逻辑不消费它）。 */
const context = {} as Context

/**
 * 从扩展中按名称取出工具定义并收敛为可调用形态。
 * @param extension 目标扩展
 * @param name 工具名
 * @returns {description, parameters, execute}
 */
function tool(extension: Extension, name: string) {
  const found = extension.tools?.find(candidate => candidate.name === name)
  if (!found) throw new Error(`Missing ${name} tool`)
  return found as unknown as {
    description: string
    parameters: unknown
    execute(args: never, api: never, context: never): Promise<unknown>
  }
}

/**
 * 构造 mock 工具执行 api：Plans/Goals/Todos 文档快照可配置、commit 内事务读取可配置、
 * agent 返回可配置的工具面（offered=直接提供，callable=codemode 内可调用）。
 * @param options 计划状态/目标文档/事务内计划状态/工具面覆盖
 * @returns MockApi
 */
function mockApi(options: {
  planActive?: boolean
  goal?: unknown
  transactionPlanActive?: boolean
  offered?: string[]
  callable?: string[]
} = {}): MockApi {
  const snapshot = vi.fn(async (document: unknown) => {
    if (document === Plans) return { active: options.planActive === true, updatedAt: 1 }
    if (document === Goals) return options.goal ?? { goal: null }
    if (document === Todos) return { items: null, updatedAt: 0 }
    return undefined
  })
  const commit = vi.fn(async (change: (tx: unknown) => unknown) => {
    const tx = {
      doc: async (document: unknown) => {
        if (document === Plans) return { active: options.transactionPlanActive === true, updatedAt: 1 }
        if (document === Goals) return options.goal ?? { goal: null }
        if (document === Todos) return { items: null, updatedAt: 0 }
        throw new Error('Unexpected document')
      },
    }
    return change(tx)
  })
  const agent = vi.fn(async () => ({ tools: (options.offered ?? []).map(name => ({ name })), callable: (options.callable ?? []).map(name => ({ name })) }))
  return { conversationId: 'conversation-1', snapshot, commit, agent }
}

/**
 * 渲染 goal-policy section 文本。
 * @param options 目标文档/计划状态/工具面/授权回调覆盖
 * @returns 渲染后的策略文本（无输出时为空串）
 */
async function renderGoalPolicy(options: {
  goal?: unknown
  planActive?: boolean
  offered?: string[]
  callable?: string[]
  canCreate?: () => Promise<boolean>
  canContinue?: () => Promise<boolean>
} = {}): Promise<string> {
  const extension = createGoalExtension({
    ...(options.canCreate === undefined ? {} : { canCreate: options.canCreate }),
    ...(options.canContinue === undefined ? {} : { canContinue: options.canContinue }),
  })
  const policy = extension.sections?.find(candidate => candidate.key === 'goal-policy')
  if (!policy) throw new Error('Missing goal policy section')
  const input: PromptInput = {
    conversationId: 'conversation-1',
    agent: {
      tools: (options.offered ?? []).map(name => ({ name })),
      callable: (options.callable ?? []).map(name => ({ name })),
    },
    env: undefined,
    shown: {},
    read: {
      snapshot: async (document) => {
        if (document === Plans) return { active: options.planActive === true, updatedAt: 1 }
        if (document === Goals) return options.goal ?? { goal: null }
        return undefined
      },
    },
  }
  const render = policy.render as unknown as (input: unknown, context: unknown) => Promise<string | undefined>
  return (await render(input, context)) ?? ''
}

/**
 * 渲染 plan-policy section 文本（计划文档恒为 active）。
 * @param options 工具面与"是否委派子会话"覆盖
 * @returns 渲染后的策略文本
 */
async function renderPlanPolicy(options: { offered?: string[]; callable?: string[]; child?: boolean } = {}): Promise<string> {
  const policy = PlanExtension.sections?.find(candidate => candidate.key === 'plan-policy')
  if (!policy) throw new Error('Missing plan policy section')
  const input: PromptInput = {
    conversationId: 'conversation-1',
    agent: {
      tools: (options.offered ?? []).map(name => ({ name })),
      callable: (options.callable ?? []).map(name => ({ name })),
    },
    env: undefined,
    shown: {},
    read: { snapshot: async document => document === Plans ? { active: true, updatedAt: 1 } : document === Subagents && options.child ? { record: { profile: 'general-purpose' } } : undefined },
  }
  const render = policy.render as unknown as (input: unknown, context: unknown) => Promise<string | undefined>
  return (await render(input, context)) ?? ''
}

/**
 * 从扩展 hooks 中取出目标自动续跑的 onYield 处理器。
 * @param extension 目标扩展
 * @returns onYield 处理函数
 */
function onYield(extension: Extension) {
  const registration = extension.hooks?.find(candidate => typeof candidate.handlers === 'object' && candidate.handlers !== null && 'onYield' in candidate.handlers)
  if (!registration) throw new Error('Missing goal continuation hook')
  const handler = registration.handlers as { onYield: (answer: unknown, api: never, context: never) => Promise<unknown> }
  return handler.onYield
}

/** 规划工具的提示词策略测试（section 渲染 + 工具描述文案）。 */
describe('planning tool prompt policy', () => {
  // 验证提交路由按工具面分流：直连工具 → 直接调用措辞；codemode → 嵌套脚本措辞；
  // 都不可用 → "把计划放在最终回复里"，且不提 exit_plan_mode/pending。
  it('routes plan submission only through tools available in the current request', async () => {
    const direct = await renderPlanPolicy({ offered: ['exit_plan_mode'] })
    expect(direct).toContain('直接调用 `exit_plan_mode({ plan: "<plan markdown>" })`')
    expect(direct).not.toContain('codemode')

    const codemode = await renderPlanPolicy({ offered: ['codemode'], callable: ['exit_plan_mode'] })
    expect(codemode).toContain('在 `codemode` 脚本里调用 `await tools.exit_plan_mode({ plan: "<plan markdown>" })`')

    const unavailable = await renderPlanPolicy()
    expect(unavailable).toContain('把计划放在最终回复里')
    expect(unavailable).not.toContain('exit_plan_mode')
    expect(unavailable).not.toContain('pending')
  })

  // 验证委派子会话约束：不出现提交/提问工具名，改为"将结论、证据和未决事项交给委派方"。
  it('does not ask the user or submit a plan from a delegated session', async () => {
    const prompt = await renderPlanPolicy({ offered: ['exit_plan_mode'], child: true })
    expect(prompt).toContain('将结论、证据和未决事项交给委派方')
    expect(prompt).not.toContain('exit_plan_mode')
    expect(prompt).not.toContain('ask_user_question')
  })

  // 验证提问工具点名规则：ask_user_question 不在工具面时不被点名；codemode 内可调用时用嵌套措辞点名。
  it('does not name unavailable question tools in plan guidance', async () => {
    const noQuestions = await renderPlanPolicy({ offered: ['exit_plan_mode'] })
    expect(noQuestions).not.toContain('ask_user_question')
    const nested = await renderPlanPolicy({ offered: ['codemode'], callable: ['exit_plan_mode', 'ask_user_question'] })
    expect(nested).toContain('await tools.ask_user_question(')
  })

  // 验证进入计划的守卫：没有可用的计划提交工具时拒绝进入且不开事务；
  // codemode 嵌套可调用时允许进入。
  it('refuses plan entry when the plan cannot be submitted', async () => {
    const api = mockApi({ offered: ['enter_plan_mode'] })
    await expect(tool(PlanExtension, 'enter_plan_mode').execute({} as never, api as never, context as never))
      .rejects.toThrow('没有可调用的计划提交工具')
    expect(api.commit).not.toHaveBeenCalled()
    const nested = mockApi({ offered: ['codemode'], callable: ['exit_plan_mode'] })
    await expect(tool(PlanExtension, 'enter_plan_mode').execute({} as never, nested as never, context as never)).resolves.toBeDefined()
  })

  // 验证退出计划守卫：快照与事务两层检查中计划都未激活时拒绝（不虚构提交路径），防止模型在非计划态调用。
  it('reports inactive plan mode without inventing an entry route at either check', async () => {
    for (const api of [mockApi(), mockApi({ planActive: true })]) {
      await expect(tool(PlanExtension, 'exit_plan_mode').execute({ plan: '# Plan' } as never, api as never, context as never))
        .rejects.toThrow('仅使用当前请求提供的计划工具')
    }
  })

  // 验证 plan-policy 文案要点：宿主强制只读边界、计划格式（一级标题开头）、
  // 命令式语言、不结束计划、不当普通回复粘贴、先探索、定稿前未决、不以提问求批准。
  it('states the host-enforced read-only Plan boundary and plan format', async () => {
    const prompt = await renderPlanPolicy({ offered: ['exit_plan_mode'] })
    expect(prompt).toContain('宿主会拒绝写入、shell 和外部 MCP 调用')
    expect(prompt).toContain('第一行是一级标题')
    expect(prompt).toContain('命令式语言要求实施时')
    expect(prompt).toContain('不结束计划模式')
    expect(prompt).toContain('不要把计划当普通回复粘贴')
    expect(prompt).toContain('工作顺序：先探索仓库')
    expect(prompt).toContain('定稿前如仍有重大未决')
    expect(prompt).toContain('不要用提问征求"计划可以吗"')
  })

  // 验证 exit_plan_mode 描述的门控文案：调研任务不提交计划、重大未决先问、附批准请求示例。
  it('gates plan submission on code-writing work and upfront clarification', () => {
    const description = tool(PlanExtension, 'exit_plan_mode').description

    expect(description).toContain('调研任务')
    expect(description).toContain('不提交计划')
    expect(description).toContain('必须由用户决定的重要问题')
    expect(description).toContain('批准请求')
    expect(description).toContain('为 vim 实现 yank 模式')
  })

  // 验证 ask_user_question 描述：等待答复不等于许可、超时不构成同意、
  // 选项用用户能理解的措辞并标"（推荐）"。
  it('keeps pending questions unauthorized and asks in user-facing terms', () => {
    const description = tool(InteractionTools, 'ask_user_question').description

    expect(description).toContain('等待答复不代表已获许可')
    expect(description).toContain('超时或未答复不构成同意')
    expect(description).toContain('用户能理解的表达')
    expect(description).toContain('（推荐）')
  })

  // 验证 todo_write 描述：多步工作适用/单步跳过、含验证步骤、及时更新状态、真实并行、
  // 全量替换语义、不替代计划模式中的计划。
  it('describes concrete multi-step todo use, timely status updates, and real parallel work', () => {
    const description = tool(TodoTools, 'todo_write').description
    expect(description).toContain('多步工作')
    expect(description).toContain('简单的单步工作跳过')
    expect(description).toContain('相关验证')
    expect(description).toContain('及时更新状态')
    expect(description).toContain('实际并行执行')
    expect(description).toContain('替换整个列表')
    expect(description).toContain('不要用此列表代替计划模式中的计划')
  })

  // 验证无目标时的 goal-policy：说明尚未设目标、只点名直接可调用的 create/get_goal。
  it('renders a policy before any goal exists and names only directly callable tools', async () => {
    const prompt = await renderGoalPolicy({ offered: ['get_goal', 'create_goal', 'update_goal'] })
    expect(prompt).toContain('当前会话尚未设置目标')
    expect(prompt).toContain('直接调用 `create_goal`')
    expect(prompt).toContain('直接调用 `get_goal`')
    expect(prompt).not.toContain('codemode')
  })

  // 验证 codemode 嵌套措辞：codemode + 目标工具都在 callable 里才用 `await tools.xxx` 措辞；
  // 目标已 active 时点名 get/update_goal 而不再提 create_goal。
  it('uses nested codemode calls only when codemode and the goal tool are both callable', async () => {
    const createPrompt = await renderGoalPolicy({
      offered: ['codemode'],
      callable: ['create_goal', 'get_goal', 'update_goal'],
    })
    expect(createPrompt).toContain('在 `codemode` 脚本里调用 `await tools.create_goal({ ... })`')
    expect(createPrompt).toContain('在 `codemode` 脚本里调用 `await tools.get_goal({ ... })`')

    const activePrompt = await renderGoalPolicy({
      offered: ['codemode'],
      callable: ['create_goal', 'get_goal', 'update_goal'],
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
    })
    expect(activePrompt).toContain('在 `codemode` 脚本里调用 `await tools.get_goal({ ... })`')
    expect(activePrompt).toContain('在 `codemode` 脚本里调用 `await tools.update_goal({ ... })`')
    expect(activePrompt).not.toContain('`create_goal`')
  })

  // 验证工具面收敛：无工具面时不点名任何 goal 工具（含已有 active 目标时），只显示目标状态行。
  it('does not expose unavailable goal tools in policy, including on an existing active goal', async () => {
    const prompt = await renderGoalPolicy({
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
    })
    expect(prompt).toContain('当前目标：goal_id "g1"，revision 1')
    expect(prompt).not.toContain('`get_goal`')
    expect(prompt).not.toContain('`create_goal`')
    expect(prompt).not.toContain('`update_goal`')
  })

  // 验证授权回调否决：canCreate=false 时不点名 create_goal；canContinue=false 时不点名 update_goal。
  it('omits routes that fail their runtime authorization callbacks', async () => {
    const noCreate = await renderGoalPolicy({ offered: ['create_goal'], canCreate: async () => false })
    expect(noCreate).not.toContain('`create_goal`')
    const noUpdate = await renderGoalPolicy({
      offered: ['update_goal'],
      canContinue: async () => false,
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
    })
    expect(noUpdate).not.toContain('`update_goal`')
  })

  // 验证 get_goal 输出：无目标时提示"可用的目标规则"而不推荐不存在的 /goal 斜杠命令。
  it('reports an unset goal without suggesting an unavailable slash command', async () => {
    const result = await tool(createGoalExtension(), 'get_goal').execute({} as never, mockApi() as never, context as never)
    const output = result as { output: { text?: string }[] }
    expect(output.output[0]?.text).toContain('可用的目标规则')
    expect(output.output[0]?.text).not.toContain('/goal')
  })

  // 验证计划模式抑制：goal-policy 改为"只做规划"，不点名 create_goal、不引导创建目标。
  it('does not instruct goal creation or implementation progress in plan mode', async () => {
    const prompt = await renderGoalPolicy({ offered: ['create_goal'], planActive: true })
    expect(prompt).toContain('计划模式已开启：只做规划')
    expect(prompt).not.toContain('`create_goal`')
    expect(prompt).not.toContain('以用户直接提出的请求为范围创建目标')
  })

  // 验证计划模式下的既有目标：目标状态可见（id/revision/active 提示）但不点名更新/创建动作。
  it('keeps an active goal visible in plan mode without directing goal updates', async () => {
    const prompt = await renderGoalPolicy({
      goal: { goal: { id: 'g1', revision: 3, objective: 'continue work', phase: 'active', roundsStarted: 1, maxGoalRounds: 3, createdAt: 1, updatedAt: 3 } },
      offered: ['create_goal', 'update_goal'],
      planActive: true,
    })
    expect(prompt).toContain('当前目标：goal_id "g1"，revision 3')
    expect(prompt).toContain('该目标仍处于 active 状态')
    expect(prompt).not.toContain('`create_goal`')
    expect(prompt).not.toContain('`update_goal`')
  })

  // 验证完成判据措辞：以验证证据与具体阻塞条件为准，不用"连续轮次"阈值驱动。
  it('uses completion evidence and concrete blocking conditions without a round threshold', async () => {
    const prompt = await renderGoalPolicy({
      offered: ['update_goal'],
      callable: [],
      goal: { goal: { id: 'g1', revision: 2, objective: 'ship and verify', phase: 'active', roundsStarted: 1, maxGoalRounds: 4, createdAt: 1, updatedAt: 2 } },
    })
    expect(prompt).toContain('所要求的验证通过，并有具体证据')
    expect(prompt).toContain('具体条件使后续工作无法推进')
    expect(prompt).not.toContain('连续轮次')
  })

  // 验证目标动作归属：策略保留精确 goal_id/revision；update_goal 参数只含模型侧动作
  // （complete/blocked），用户侧控制（edit/pause/resume/objective/max_goal_rounds）不暴露。
  it('exposes only model-owned goal actions while retaining exact goal identifiers in policy', async () => {
    const activeGoal = { goal: { id: 'goal-42', revision: 7, objective: 'ship and verify', phase: 'active', roundsStarted: 1, maxGoalRounds: 4, createdAt: 1, updatedAt: 2 } }
    const prompt = await renderGoalPolicy({ offered: ['update_goal'], goal: activeGoal })
    expect(prompt).toContain('goal_id "goal-42"，revision 7')

    const parameters = JSON.stringify(tool(createGoalExtension(), 'update_goal').parameters)
    expect(parameters).toContain('"complete"')
    expect(parameters).toContain('"blocked"')
    for (const userControl of ['edit', 'pause', 'resume', 'objective', 'max_goal_rounds']) {
      expect(parameters).not.toContain(`"${userControl}"`)
    }
  })
})

/** 计划模式的写入守卫测试。 */
describe('planning mode write guards', () => {
  // 验证 todo_write 守卫：计划激活时拒绝进度更新且不开 commit 事务。
  it('rejects todo progress updates without opening a commit while plan mode is active', async () => {
    const api = mockApi({ planActive: true })
    await expect(tool(TodoTools, 'todo_write').execute(
      { todos: [{ content: 'implementation', status: 'in_progress' }] } as never,
      api as never,
      context as never,
    )).rejects.toThrow(/计划模式开启/)
    expect(api.commit).not.toHaveBeenCalled()
  })

  // 验证 fail-closed：canCreate 拒绝时 create_goal 报错、回调收到正确参数、
  // commit 与 snapshot 都不发生（先授权后读取）。
  it('fails closed when canCreate denies goal creation and never writes', async () => {
    const canCreate = vi.fn(async () => false)
    const api = mockApi()
    await expect(tool(createGoalExtension({ canCreate }), 'create_goal').execute(
      { objective: 'multi-turn goal' } as never,
      api as never,
      context as never,
    )).rejects.toThrow(/unavailable for this conversation/)
    expect(canCreate).toHaveBeenCalledWith('conversation-1', context)
    expect(api.commit).not.toHaveBeenCalled()
    expect(api.snapshot).not.toHaveBeenCalled()
  })

  // 验证计划模式创建守卫：拒绝发生在 commit 之前（canCreate 已查、事务未开）。
  it('rejects goal creation before commit when plan mode is active', async () => {
    const canCreate = vi.fn(async () => true)
    const api = mockApi({ planActive: true })
    await expect(tool(createGoalExtension({ canCreate }), 'create_goal').execute(
      { objective: 'multi-turn goal' } as never,
      api as never,
      context as never,
    )).rejects.toThrow(/plan mode is active/)
    expect(canCreate).toHaveBeenCalledOnce()
    expect(api.commit).not.toHaveBeenCalled()
  })
})

/** 目标自动续跑的门槛测试（onYield 处理器）。 */
describe('goal automatic continuation gates', () => {
  // 验证计划模式门槛：计划激活时 onYield 不续跑、canContinue 不被调用、无 commit。
  it('does not continue while plan mode is active', async () => {
    const canContinue = vi.fn(async () => true)
    const api = mockApi({
      planActive: true,
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
    })
    const result = await onYield(createGoalExtension({ canContinue }))('answer', api as never, context as never)
    expect(result).toBeUndefined()
    expect(canContinue).not.toHaveBeenCalled()
    expect(api.commit).not.toHaveBeenCalled()
  })

  // 验证授权门槛：canContinue 否决时不续跑且无 commit（回调恰好调用一次）。
  it('does not continue when canContinue denies the current request', async () => {
    const canContinue = vi.fn(async () => false)
    const api = mockApi({
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
    })
    const result = await onYield(createGoalExtension({ canContinue }))('answer', api as never, context as never)
    expect(result).toBeUndefined()
    expect(canContinue).toHaveBeenCalledOnce()
    expect(api.commit).not.toHaveBeenCalled()
  })

  // 验证事务内复检：快照时计划未激活、但事务内读取发现已激活 → 放弃记录续跑（commit 开了但未落续跑）。
  it('rechecks plan mode in the round transaction before recording a continuation', async () => {
    const canContinue = vi.fn(async () => true)
    const api = mockApi({
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
      transactionPlanActive: true,
    })
    const result = await onYield(createGoalExtension({ canContinue }))('answer', api as never, context as never)
    expect(result).toBeUndefined()
    expect(api.commit).toHaveBeenCalledOnce()
  })
})
