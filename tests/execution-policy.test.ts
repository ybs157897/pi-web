import { describe, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createExecutionPolicyExtension } from '../src/server/conversation/execution-policy.ts'

/**
 * 执行策略在可执行工具边界上的测试。
 *
 * 关键契约：
 * - 未知的外部工具（如 mcp__ 前缀）在执行时实时检查当前 Plan 状态：Plan 激活则拒绝、底层 execute 不执行；
 *   Plan 关闭后放行；durable 回放（直接调 execute、不走 beforeTool）同样被覆盖；
 * - Plan 模式下 write 工具写 memory 形态路径（/data/memory/...）被拦截——Plan 中的记忆写入归 extraction 负责。
 */
describe('execution policy at the executable tool boundary', () => {
  // 外部工具执行时读取实时 Plan 状态：激活即拒绝且 execute 不执行；关闭后放行一次；再次激活连回放也拒绝（计数不变）。
  it('checks current Plan state for unknown external tools, including an execution replay', async () => {
    let active = true
    const execute = vi.fn(async () => ({ output: [{ type: 'text' as const, text: 'side effect' }] }))
    const tool = defineTool({ name: 'mcp__example__mutate', description: 'External mutation', parameters: Type.Object({}), replay: 'safe', execute })
    const policy = createExecutionPolicyExtension([defineExtension({ name: 'external', tools: [tool] })])
    const wrap = policy.wraps?.find(item => 'tool' in item && item.tool === tool.name)
    if (!wrap || !('tool' in wrap)) throw new Error('Missing executable guard')
    const guarded = wrap.wrap(tool)
    const api = { conversationId: 1, snapshot: async () => ({ active, updatedAt: 0 }) } as unknown as ToolExecutionApi
    // 直接调用 execute，模拟 durable 在意图记录之后的回放路径，不经过 beforeTool。
    await expect(guarded.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('Plan mode blocks')
    expect(execute).not.toHaveBeenCalled()
    active = false
    await guarded.execute({}, api, BACKGROUND_CONTEXT)
    expect(execute).toHaveBeenCalledOnce()
    active = true
    await expect(guarded.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('Plan mode blocks')
    expect(execute).toHaveBeenCalledOnce()
  })

  // Plan 模式下 write 到 memory 形态路径（/data/memory/prefs.md）也被拦截：记忆写入由 extraction 专责，工具必须让路。
  it('blocks a memory-shaped write in Plan mode; extraction owns memory writes there', async () => {
    const execute = vi.fn(async () => ({ output: [{ type: 'text' as const, text: 'side effect' }] }))
    const tool = defineTool({ name: 'write', description: 'Write a file', parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute })
    const policy = createExecutionPolicyExtension([defineExtension({ name: 'coding', tools: [tool] })])
    const wrap = policy.wraps?.find(item => 'tool' in item && item.tool === 'write')
    if (!wrap || !('tool' in wrap)) throw new Error('Missing executable guard')
    const guarded = wrap.wrap(tool)
    const api = {
      conversationId: 1,
      env: { cwd: '/workspace/demo' },
      snapshot: async () => ({ active: true, updatedAt: 0 }),
    } as unknown as ToolExecutionApi

    await expect(guarded.execute({ path: '/data/memory/prefs.md', content: 'x' }, api, BACKGROUND_CONTEXT)).rejects.toThrow('Plan mode blocks')
    expect(execute).not.toHaveBeenCalled()
  })
})
