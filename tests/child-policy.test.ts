import { describe, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension, defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { createExecutionPolicyExtension } from '../src/server/conversation/execution-policy.ts'
import { Subagents } from '../src/server/conversation/subagent-policy.ts'
import { createGoalExtension, Goals } from '../src/server/tools/goal.ts'
import { Plans } from '../src/server/tools/plan.ts'

/** 执行器侧对派生子代理禁止调用的工具全集：计划模式、用户提问、目标、子代理/队友与团队任务。 */
const forbidden = [
  'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'get_goal', 'create_goal', 'update_goal',
  'subagent', 'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
]
/** 提取工具名列表的便捷函数。 */
const names = (items: readonly { name: string }[]) => items.map(item => item.name)

/**
 * 一次性子代理（executor）策略测试。
 *
 * 关键契约：
 * - forbidden 工具在执行器边界被包装拦截：即使子代理记录是旧的、或请求是 replay，也会拒绝且底层 execute 不执行；
 * - 传给 codemode/search 类工具的代理工具目录会被过滤：模型可见、可调用、延迟三份目录都只剩白名单工具；
 * - Explore 子代理即使残留写工具也被拦截（只读保证）；
 * - 根会话不受限制，但子代理仍受 Plan 模式约束；
 * - 请求级 guard 在发送给 provider 前从 toolsAdded 里剔除禁止工具（toolsRemoved）。
 */
describe('one-shot child policy', () => {
  // 每个 forbidden 工具在执行器包装下都拒绝调用：旧子代理记录/回放请求都逃不过拦截，底层 execute 不被执行。
  it.each(forbidden)('rejects %s at the executor even for an old child or replay', async name => {
    const execute = vi.fn(async () => ({ output: [] }))
    const tool = defineTool({ name, description: name, parameters: Type.Object({}), replay: 'safe', execute })
    const policy = createExecutionPolicyExtension([defineExtension({ name: 'tools', tools: [tool] })])
    const wrap = policy.wraps?.find(item => 'tool' in item && item.tool === name)
    if (!wrap || !('tool' in wrap)) throw new Error('Missing tool guard')
    const guarded = wrap.wrap(tool)
    const api = {
      conversationId: 2,
      snapshot: async (document: unknown) => document === Subagents
        ? { record: { label: 'old child', createdAt: 1 } }
        : { active: false },
    } as unknown as ToolExecutionApi
    await expect(guarded.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('Delegated subagent cannot call')
    expect(execute).not.toHaveBeenCalled()
  })

  // codemode 收到的 agent 目录（tools/callable/deferred 三份）都只保留白名单工具（codemode/read/write），禁止工具被剔除。
  it('filters model, nested and deferred catalogs passed to the code and search tools', async () => {
    const tools = ['codemode', 'read', 'write', ...forbidden].map(name => ({ name }))
    const execute = vi.fn(async (_args, api: ToolExecutionApi, context) => {
      const agent = await api.agent(context)
      expect(names(agent.tools)).toEqual(['codemode', 'read', 'write'])
      expect(names(agent.callable)).toEqual(['codemode', 'read', 'write'])
      expect(names(agent.deferred)).toEqual(['codemode', 'read', 'write'])
      return { output: [] }
    })
    const tool = defineTool({ name: 'codemode', description: 'code', parameters: Type.Object({}), execute })
    const policy = createExecutionPolicyExtension([defineExtension({ name: 'code', tools: [tool] })])
    const wrap = policy.wraps?.find(item => 'tool' in item && item.tool === 'codemode')
    if (!wrap || !('tool' in wrap)) throw new Error('Missing code guard')
    const api = {
      conversationId: 2,
      snapshot: async (document: unknown) => document === Subagents
        ? { record: { label: 'child', createdAt: 1, profile: 'general-purpose' } }
        : { active: false },
      agent: async () => ({ tools, callable: tools, deferred: tools }),
    } as unknown as ToolExecutionApi
    await wrap.wrap(tool).execute({}, api, BACKGROUND_CONTEXT)
    expect(execute).toHaveBeenCalledOnce()
  })

  // Explore 子代理即使残留 write 工具也被拦截，保证只读身份不被旧记录破坏。
  it('keeps Explore read-only even if an older child retained a write tool', async () => {
    const execute = vi.fn(async () => ({ output: [] }))
    const tool = defineTool({ name: 'write', description: 'write', parameters: Type.Object({}), execute })
    const policy = createExecutionPolicyExtension([defineExtension({ name: 'tools', tools: [tool] })])
    const wrap = policy.wraps?.find(item => 'tool' in item && item.tool === 'write')
    if (!wrap || !('tool' in wrap)) throw new Error('Missing tool guard')
    const api = {
      conversationId: 2,
      snapshot: async (document: unknown) => document === Subagents
        ? { record: { label: 'old Explore', createdAt: 1, profile: 'Explore' } }
        : { active: false },
    } as unknown as ToolExecutionApi
    await expect(wrap.wrap(tool).execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('Delegated subagent cannot call')
    expect(execute).not.toHaveBeenCalled()
  })

  // 根会话（conversationId=1、无子代理记录）调用 write 放行；同一会话变成子代理且 Plan 激活后，write 被Plan mode blocks 拦截。
  it('does not restrict the root conversation and still enforces Plan for a child', async () => {
    const execute = vi.fn(async () => ({ output: [] }))
    const tool = defineTool({ name: 'write', description: 'write', parameters: Type.Object({}), execute })
    const policy = createExecutionPolicyExtension([defineExtension({ name: 'tools', tools: [tool] })])
    const wrap = policy.wraps?.find(item => 'tool' in item && item.tool === 'write')
    if (!wrap || !('tool' in wrap)) throw new Error('Missing tool guard')
    const guarded = wrap.wrap(tool)
    let identity: unknown = null
    let planActive = false
    const api = {
      conversationId: 1,
      snapshot: async (document: unknown) => document === Subagents ? { record: identity } : { active: planActive },
    } as unknown as ToolExecutionApi
    await guarded.execute({}, api, BACKGROUND_CONTEXT)
    expect(execute).toHaveBeenCalledOnce()
    identity = { label: 'research', createdAt: 1, profile: 'general-purpose' }
    planActive = true
    await expect(guarded.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('Plan mode blocks write')
    expect(execute).toHaveBeenCalledOnce()
  })

  // 请求级 beforeRequest guard：子代理的请求在到达 provider 前，toolsAdded 里的禁止工具被剔除并记录到 toolsRemoved。
  it('removes forbidden tools from a replayed request before the provider sees them', async () => {
    const policy = createExecutionPolicyExtension([])
    const registration = policy.hooks?.find(item => typeof item.handlers === 'object' && item.handlers !== null && 'beforeRequest' in item.handlers)
    if (!registration) throw new Error('Missing request guard')
    const handler = registration.handlers as { beforeRequest: (request: never, api: never, context: never) => Promise<{ messages: unknown[] } | undefined> }
    const request = { messages: [{ role: 'system', content: '', timestamp: 0, toolsAdded: [
      { name: 'read' }, { name: 'subagent' }, { name: 'ask_user_question' }, { name: 'team_task_get' },
    ] }] }
    const api = { conversationId: 2, snapshot: async (document: unknown) => document === Subagents
      ? { record: { label: 'existing', createdAt: 1 } }
      : { active: false } }
    const result = await handler.beforeRequest(request as never, api as never, BACKGROUND_CONTEXT as never)
    expect(result?.messages.at(-1)).toMatchObject({
      toolsRemoved: [{ name: 'subagent' }, { name: 'ask_user_question' }, { name: 'team_task_get' }],
    })
  })
})

/**
 * 目标策略 section 渲染测试（在工具目录中不存在 goal 工具时的降级行为）。
 *
 * 关键契约：
 * - 没有目标（null）时整个 section 不渲染；
 * - 暂停中的目标仍渲染目标文本与「不要为此目标开始新的工作」约束，
 *   但不含 Call `update_goal` 指令（工具不存在时不再要求调用）。
 */
describe('goal policy without goal tools', () => {
  /**
   * 渲染 goal-policy section。
   * @param goal 模拟的 Goals 快照内容（null 或目标对象）
   * @returns section 渲染文本；section 缺失时抛错
   */
  async function render(goal: unknown) {
    const section = createGoalExtension().sections?.find(item => item.key === 'goal-policy')
    if (!section) throw new Error('Missing goal policy')
    return section.render({
      conversationId: 1,
      agent: { tools: [], callable: [] },
      read: { snapshot: async (document: unknown) => document === Goals ? { goal } : document === Plans ? { active: false } : undefined },
    } as never, BACKGROUND_CONTEXT)
  }

  // goal=null 时 section 省略不渲染；paused 目标保留目标文本与禁止继续的约束，但去掉 update_goal 调用指令。
  it('omits an empty policy but retains a paused goal and its no-progress constraint', async () => {
    expect(await render(null)).toBeUndefined()
    const policy = await render({ id: 'g1', revision: 2, objective: 'finish work', phase: 'paused', roundsStarted: 1, maxGoalRounds: 3 })
    expect(policy).toContain('finish work')
    expect(policy).toContain('不要为此目标开始新的工作')
    expect(policy).not.toContain('Call `update_goal`')
  })
})
