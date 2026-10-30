import { describe, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createExecutionPolicyExtension } from '../src/server/conversation/execution-policy.ts'

describe('execution policy at the executable tool boundary', () => {
  it('checks current Plan state for unknown external tools, including an execution replay', async () => {
    let active = true
    const execute = vi.fn(async () => ({ output: [{ type: 'text' as const, text: 'side effect' }] }))
    const tool = defineTool({ name: 'mcp__example__mutate', description: 'External mutation', parameters: Type.Object({}), replay: 'safe', execute })
    const policy = createExecutionPolicyExtension([defineExtension({ name: 'external', tools: [tool] })])
    const wrap = policy.wraps?.find(item => 'tool' in item && item.tool === tool.name)
    if (!wrap || !('tool' in wrap)) throw new Error('Missing executable guard')
    const guarded = wrap.wrap(tool)
    const api = { conversationId: 1, snapshot: async () => ({ active, updatedAt: 0 }) } as unknown as ToolExecutionApi
    // Call execute directly, as a durable replay does after intent, without relying on beforeTool.
    await expect(guarded.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('Plan mode blocks')
    expect(execute).not.toHaveBeenCalled()
    active = false
    await guarded.execute({}, api, BACKGROUND_CONTEXT)
    expect(execute).toHaveBeenCalledOnce()
    active = true
    await expect(guarded.execute({}, api, BACKGROUND_CONTEXT)).rejects.toThrow('Plan mode blocks')
    expect(execute).toHaveBeenCalledOnce()
  })

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
