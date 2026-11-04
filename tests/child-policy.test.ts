import { describe, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension, defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { createExecutionPolicyExtension } from '../src/server/conversation/execution-policy.ts'
import { Subagents } from '../src/server/conversation/subagent-policy.ts'
import { createGoalExtension, Goals } from '../src/server/tools/goal.ts'
import { Plans } from '../src/server/tools/plan.ts'

const forbidden = [
  'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'get_goal', 'create_goal', 'update_goal',
  'subagent', 'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
]
const names = (items: readonly { name: string }[]) => items.map(item => item.name)

describe('one-shot child policy', () => {
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

describe('goal policy without goal tools', () => {
  async function render(goal: unknown) {
    const section = createGoalExtension().sections?.find(item => item.key === 'goal-policy')
    if (!section) throw new Error('Missing goal policy')
    return section.render({
      conversationId: 1,
      agent: { tools: [], callable: [] },
      read: { snapshot: async (document: unknown) => document === Goals ? { goal } : document === Plans ? { active: false } : undefined },
    } as never, BACKGROUND_CONTEXT)
  }

  it('omits an empty policy but retains a paused goal and its no-progress constraint', async () => {
    expect(await render(null)).toBeUndefined()
    const policy = await render({ id: 'g1', revision: 2, objective: 'finish work', phase: 'paused', roundsStarted: 1, maxGoalRounds: 3 })
    expect(policy).toContain('finish work')
    expect(policy).toContain('Do not start new work toward this goal')
    expect(policy).not.toContain('Call `update_goal`')
  })
})
