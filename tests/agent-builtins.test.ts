import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/chord/context'
import { AgentDoc, type ConversationId } from '@earendil-works/pi-durable'
import { Compile } from 'typebox/compile'
import type { ThinkingLevel } from '../src/shared/types.ts'
import {
  BUILTIN_PROFILES,
  createChildModelResolver,
  profileByName,
  type ChildModelRef,
} from '../src/server/agents/builtins.ts'
import {
  createSubagentTools,
  Subagents,
  SUBAGENT_TOOL,
  SUBAGENT_MODEL_LIST_LIMIT,
  type ChildModelList,
  type SubagentIdentity,
  type SubagentSettlementInput,
  type SubagentToolOptions,
} from '../src/server/tools/subagent.ts'
import { Plans } from '../src/server/tools/plan.ts'

const PARENT_ID = 1 as ConversationId
const CHILD_ID = 2 as ConversationId

function registeredTool(options: SubagentToolOptions): { execute(args: unknown, api: unknown, context: unknown): Promise<unknown> } {
  const found = createSubagentTools(options).tools?.find(candidate => candidate.name === SUBAGENT_TOOL)
  if (!found) throw new Error(`Missing ${SUBAGENT_TOOL} tool`)
  return found as unknown as { execute(args: unknown, api: unknown, context: unknown): Promise<unknown> }
}

const READ_ONLY_TOOL_NAMES = ['read', 'glob', 'grep', 'list_files', 'search_files']

/**
 * The tool-execution seam team.test.ts also stubs: one parent conversation, one child it creates,
 * and the document/entry reads the delegation performs. `existing` simulates a replay finding its
 * child; `parentTools` and `thinkingLevel` feed the agent change. The `pi.agent` document the real
 * `configure()` writes lands in `agentStates`.
 */
function stubRun(options: {
  parentTools?: string[]
  parentCallable?: string[]
  parentDeferred?: string[]
  thinkingLevel?: string
  existing?: boolean
  resolveChildModel?: SubagentToolOptions['resolveChildModel']
} = {}) {
  const parentAgent = {
    tools: (options.parentTools ?? [...READ_ONLY_TOOL_NAMES, 'bash', 'write']).map(name => ({ name })),
    callable: (options.parentCallable ?? options.parentTools ?? [...READ_ONLY_TOOL_NAMES, 'bash', 'write']).map(name => ({ name })),
    deferred: (options.parentDeferred ?? []).map(name => ({ name })),
    thinkingLevel: options.thinkingLevel ?? 'medium',
  }
  const creations: unknown[] = []
  // One stable identity holder: repeated reads of the child's doc see the same record, so the
  // background branch's second-commit delegation write lands on the record the creation wrote.
  const identity: { record: SubagentIdentity | null } = { record: null }
  const identities: Array<{ record: SubagentIdentity | null }> = []
  const agentStates: Array<Record<string, unknown>> = []
  const child = { submit: vi.fn(async (..._args: unknown[]) => ({ wait: async () => ({ status: 'done', answer: 42 }) })) }
  const tx = {
    scanConversations: async () => ({ items: options.existing === true ? [{ id: CHILD_ID }] : [] }),
    createConversation: async (request: unknown) => { creations.push(request); return { id: CHILD_ID } },
    doc: async (document: unknown, _id: ConversationId) => {
      if (document === Subagents) { identities.push(identity); return identity }
      if (document === AgentDoc) { const value: Record<string, unknown> = {}; agentStates.push(value); return value }
      if (document === Plans) return { active: false, updatedAt: 0 }
      throw new Error('Unexpected document')
    },
    entry: async () => ({ model: [{ role: 'assistant', content: [{ type: 'text', text: 'child answer' }], stopReason: 'stop' }] }),
  }
  const api = {
    conversationId: PARENT_ID,
    taskId: 9,
    callId: 'call-1',
    ...(options.existing === true ? {} : { agent: vi.fn(async () => parentAgent) }),
    commit: vi.fn(async (change: (tx: unknown) => unknown) => change(tx)),
    details: vi.fn(async () => undefined),
    diagnostic: vi.fn(),
    conversation: vi.fn(async () => child),
  }
  return { api, child, creations, identities, agentStates, parentAgent }
}

/** The resolver factory's dependencies, stubbed at the catalog/allowlist boundary. */
function stubResolverDeps(overrides: {
  catalog?: string[]
  allowlist?: string[]
  levels?: ThinkingLevel[]
} = {}) {
  const catalog = new Set(overrides.catalog ?? ['p/fast', 'p/big'])
  return {
    models: { getModel: (provider: string, modelId: string) => (catalog.has(`${provider}/${modelId}`) ? {} : undefined) },
    allowlist: () => overrides.allowlist,
    supportedThinkingLevels: (_provider: string, _modelId: string) => overrides.levels,
  }
}

describe('built-in delegation profiles', () => {
  it('catalogs exactly the two ZCode-parity profiles with read-only narrowing only for Explore', () => {
    expect(BUILTIN_PROFILES.map(profile => profile.name)).toEqual(['general-purpose', 'Explore'])
    const explore = profileByName('Explore')
    const general = profileByName('general-purpose')
    expect(general.readonlyTools).toBeUndefined()
    expect(explore.readonlyTools).toEqual(READ_ONLY_TOOL_NAMES)
    expect(profileByName(undefined).name).toBe('general-purpose')
    expect(profileByName('nonsense').name).toBe('general-purpose')
    for (const profile of BUILTIN_PROFILES) {
      expect(profile.systemPrompt).toContain('pi-web')
      expect(profile.description.length).toBeGreaterThan(0)
    }
    // The Explore prompt carries the read-only red line and the breadth contract.
    expect(explore.systemPrompt).toContain('只读红线')
    expect(explore.systemPrompt).toContain('very thorough')
  })

  it('narrows an Explore child to the read-only intersection and stamps its record', async () => {
    const run = stubRun()
    const result = await registeredTool({ prepareChild: async () => undefined }).execute(
      { task: 'scan the tree for the label renderer', agent_type: 'Explore' }, run.api, {} as Context,
    )
    expect(result).toMatchObject({ output: [{ type: 'text', text: 'child answer' }] })
    const change = run.agentStates[0]
    expect(change?.tools).toEqual(READ_ONLY_TOOL_NAMES)
    expect(change?.instructions).toBe(profileByName('Explore').systemPrompt)
    expect(change?.model).toBeUndefined()
    expect(run.identities[0]?.record).toMatchObject({ profile: 'Explore', label: 'scan the tree for the label renderer' })
  })

  it('refuses an Explore delegation whose parent has no read tool', async () => {
    const run = stubRun({ parentTools: ['glob', 'grep'] })
    await expect(registeredTool({ prepareChild: async () => undefined }).execute(
      { task: 'research', agent_type: 'Explore' }, run.api, {} as Context,
    )).rejects.toThrow(/Explore subagent needs the read tool/)
    expect(run.creations).toEqual([])
    expect(run.identities).toEqual([])
  })

  it('preserves codemode and nested read-only tools when Explore is delegated from codemode-only', async () => {
    const run = stubRun({ parentTools: ['codemode'], parentCallable: ['read', 'grep', 'write', 'subagent'] })
    await registeredTool({ prepareChild: async () => undefined }).execute(
      { task: 'research', agent_type: 'Explore' }, run.api, {} as Context,
    )
    expect(run.agentStates[0]?.tools).toEqual(['codemode', 'read', 'grep'])
  })

  it('keeps the parent tool set for general-purpose while replacing its instructions', async () => {
    const run = stubRun()
    await registeredTool({ prepareChild: async () => undefined }).execute(
      { task: 'do the work' }, run.api, {} as Context,
    )
    const change = run.agentStates[0]
    expect('tools' in (change ?? {})).toBe(false)
    expect(change?.instructions).toBe(profileByName('general-purpose').systemPrompt)
    expect(run.identities[0]?.record).toMatchObject({ profile: 'general-purpose' })
  })

  it('applies the resolved model and clamped thinking level on a new child only', async () => {
    const run = stubRun({ thinkingLevel: 'medium' })
    const seen: ChildModelRef[] = []
    const parentLevels: string[] = []
    await registeredTool({
      prepareChild: async () => undefined,
      resolveChildModel: (ref, parent) => {
        seen.push(ref)
        parentLevels.push(parent.thinkingLevel)
        return { model: { provider: 'p', modelId: 'fast' }, thinkingLevel: 'low' }
      },
    }).execute({ task: 'quick scan', model: { provider: 'p', modelId: 'fast' } }, run.api, {} as Context)
    const change = run.agentStates[0]
    expect(change?.model).toEqual({ provider: 'p', modelId: 'fast' })
    expect(change?.thinkingLevel).toBe('low')
    expect(seen).toEqual([{ provider: 'p', modelId: 'fast' }])
    expect(parentLevels).toEqual(['medium'])
  })

  it('does not reapply an agent change when a replay reuses its child', async () => {
    const run = stubRun({ existing: true })
    const result = await registeredTool({
      prepareChild: async () => undefined,
      resolveChildModel: () => { throw new Error('must not resolve on replay') },
    }).execute(
      { task: 'continue', agent_type: 'Explore', model: { provider: 'p', modelId: 'fast' } }, run.api, {} as Context,
    )
    expect(result).toMatchObject({ output: [{ type: 'text', text: 'child answer' }] })
    expect(run.creations).toEqual([])
    expect(run.child.submit).toHaveBeenCalledOnce()
  })

  it('launches run_in_background without waiting and hands the settlement to the runtime', async () => {
    const run = stubRun()
    const settlements: SubagentSettlementInput[] = []
    const result = await registeredTool({
      prepareChild: async () => undefined,
      settleWhenAnswered: (input) => { settlements.push(input) },
    }).execute(
      { task: 'research the tree', label: '调研', run_in_background: true }, run.api, {} as Context,
    )
    // The call returns an activation, not the child's answer, and does not wait for it.
    const output = (result as { output: Array<{ type: string; text: string }> }).output
    expect(output[0]?.type).toBe('text')
    expect(output[0]?.text).toContain('调研')
    expect(output[0]?.text).toContain(String(CHILD_ID))
    expect(output[0]?.text).toContain('follow-up')
    expect(output[0]?.text).not.toContain('child answer')
    expect(run.child.submit).toHaveBeenCalledOnce()
    expect(run.child.submit.mock.calls[0]?.[0]).toMatchObject({
      content: 'research the tree',
      requestId: 'subagent:9:bg',
      whenBusy: 'followUp',
    })
    // The runtime receives everything the settlement needs to inject the result later. No handle
    // rides along: anything derived from the call's api dies with the invocation.
    expect(settlements).toHaveLength(1)
    expect(settlements[0]).toMatchObject({
      parent: PARENT_ID,
      child: CHILD_ID,
      label: '调研',
      settleRequestId: 'subagent-settle:9',
    })
    // The row keeps its running state for the UI, now flagged background.
    expect(run.api.details).toHaveBeenCalledWith(
      { conversationId: String(CHILD_ID), status: 'running', label: '调研', background: true },
      {},
    )
    // The delegation marker is on the child's record, so a restart's reconcile can find it.
    expect(run.identities.at(-1)?.record).toMatchObject({
      label: '调研',
      delegation: { background: true, parent: PARENT_ID, requestId: 'subagent-settle:9' },
    })
  })

  it('keeps the foreground path waiting when run_in_background is not set', async () => {
    const run = stubRun()
    const settlements: SubagentSettlementInput[] = []
    const result = await registeredTool({
      prepareChild: async () => undefined,
      settleWhenAnswered: (input) => { settlements.push(input) },
    }).execute({ task: 'do the work' }, run.api, {} as Context)
    expect(result).toMatchObject({ output: [{ type: 'text', text: 'child answer' }] })
    expect(run.child.submit.mock.calls[0]?.[0]).toMatchObject({ requestId: 'subagent:9' })
    expect(settlements).toEqual([])
    expect(run.identities.at(-1)?.record?.delegation).toBeUndefined()
  })
})

describe('child model resolution', () => {
  it('passes a catalogued, allowlisted pick and clamps the parent level to its support', () => {
    const resolve = createChildModelResolver(stubResolverDeps({ levels: ['off', 'low'] }))
    expect(resolve({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }))
      .toEqual({ model: { provider: 'p', modelId: 'fast' }, thinkingLevel: 'low' })
    // A level the model supports stays; missing support info keeps the parent's level.
    const exact = createChildModelResolver(stubResolverDeps({ levels: ['off', 'medium', 'high'] }))
    expect(exact({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }).thinkingLevel).toBe('medium')
    const unaware = createChildModelResolver(stubResolverDeps())
    expect(unaware({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'high' }).thinkingLevel).toBe('high')
  })

  it('rejects a model missing from the catalog or outside the allowlist', () => {
    const resolve = createChildModelResolver(stubResolverDeps())
    expect(() => resolve({ provider: 'missing', modelId: 'model' }, { thinkingLevel: 'medium' }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('未出现在 Pi 模型目录中') }))
    const restricted = createChildModelResolver(stubResolverDeps({ allowlist: ['p/big'] }))
    expect(() => restricted({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('不在模型白名单内') }))
    expect(restricted({ provider: 'p', modelId: 'big' }, { thinkingLevel: 'medium' }).model).toEqual({ provider: 'p', modelId: 'big' })
    // A prefix pattern covers the whole provider, exactly like the settings allowlist.
    const pattern = createChildModelResolver(stubResolverDeps({ allowlist: ['p/*'] }))
    expect(pattern({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }).model).toEqual({ provider: 'p', modelId: 'fast' })
  })

  it('surfaces a rejected model pick as the delegation failure', async () => {
    const run = stubRun()
    await expect(registeredTool({
      prepareChild: async () => undefined,
      resolveChildModel: createChildModelResolver(stubResolverDeps()),
    }).execute(
      { task: 'work', model: { provider: 'missing', modelId: 'model' } }, run.api, {} as Context,
    )).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(run.creations).toEqual([])
  })
})

describe('subagent tool schema', () => {
  it('accepts the built-in agent types and a complete model pick, rejecting partial ones', () => {
    const tool = createSubagentTools({ prepareChild: async () => undefined })
      .tools?.find(candidate => candidate.name === SUBAGENT_TOOL)
    if (!tool) throw new Error(`Missing ${SUBAGENT_TOOL} tool`)
    const check = Compile(tool.parameters)
    expect(check.Check({ task: 'work' })).toBe(true)
    expect(check.Check({ task: 'work', agent_type: 'Explore' })).toBe(true)
    expect(check.Check({ task: 'work', agent_type: 'general-purpose' })).toBe(true)
    expect(check.Check({ task: 'work', model: { provider: 'p', modelId: 'fast' } })).toBe(true)
    expect(check.Check({ task: 'work', run_in_background: true })).toBe(true)
    expect(check.Check({ task: 'work', run_in_background: false })).toBe(true)
    // The model pick must arrive complete: provider and modelId are both required.
    expect(check.Check({ task: 'work', model: { modelId: 'fast' } })).toBe(false)
    expect(check.Check({ task: 'work', model: { provider: 'p' } })).toBe(false)
    expect(check.Check({ task: 'work', agent_type: 'explore' })).toBe(false)
  })
})

describe('delegation policy section', () => {
  function renderDelegation(options: {
    offered?: string[]
    callable?: string[]
    models?: ChildModelList
  } = {}): Promise<string | undefined> {
    const section = createSubagentTools({
      prepareChild: async () => undefined,
      availableChildModels: async () => options.models ?? { models: [], total: 0 },
    }).sections?.find(candidate => candidate.key === 'delegation-policy')
    if (!section) throw new Error('Missing delegation policy section')
    const input = {
      conversationId: 'conversation-1',
      agent: {
        tools: (options.offered ?? []).map(name => ({ name })),
        callable: (options.callable ?? []).map(name => ({ name })),
      },
      env: undefined,
      shown: {},
      read: { snapshot: async () => undefined },
    }
    const render = section.render as unknown as (input: unknown, context: unknown) => Promise<string | undefined>
    return render(input, {} as Context)
  }

  it('stays absent when neither delegation tool is routable', async () => {
    expect(await renderDelegation({ offered: ['read'] })).toBeUndefined()
    expect(await renderDelegation()).toBeUndefined()
  })

  it('mentions only the available delegation route', async () => {
    const teammate = await renderDelegation({ offered: ['spawn_teammate'] })
    expect(teammate).toContain('直接调用 `spawn_teammate(')
    expect(teammate).not.toContain('subagent')
    const child = await renderDelegation({ offered: ['subagent'] })
    expect(child).not.toContain('spawn_teammate')
  })

  it('lists both built-in types, the delegation rules, and the direct call', async () => {
    const prompt = await renderDelegation({ offered: [SUBAGENT_TOOL] })
    expect(prompt).toContain('- general-purpose：')
    expect(prompt).toContain('- Explore：')
    expect(prompt).toContain('very thorough')
    expect(prompt).toContain('调研、检索、盘点类子任务默认委派')
    expect(prompt).toContain('先派 Explore 再综合它的结论')
    expect(prompt).toContain('只有已知路径/符号的单点事实才直接查')
    expect(prompt).toContain('你只保留结论')
    expect(prompt).toContain('多项目任务可并行委派互相独立的项')
    expect(prompt).toContain('写入范围重叠或共用构建、测试、锁文件、快照等产物时协调并串行处理')
    expect(prompt).toContain('委派了检索就不要自己再跑同一搜索')
    expect(prompt).toContain('计划模式开启期间只委派只读调研')
    expect(prompt).toContain('委派示例：直接调用 `subagent({ task: "...", agent_type: "Explore", label: "..." })`。')
    // One selectable model is no choice, so the model line waits for a second one.
    expect(prompt).not.toContain('可选模型')
  })

  it('lists the selectable models once at least two are available', async () => {
    const prompt = await renderDelegation({
      offered: [SUBAGENT_TOOL],
      models: { models: [{ provider: 'p', modelId: 'fast' }, { provider: 'q', modelId: 'big' }], total: 2 },
    })
    expect(prompt).toContain('可选模型：`p/fast`、`q/big`')
    expect(prompt).toContain('缺省继承当前会话模型')
  })

  it('truncates a long model list with a 「等 N 个」 tail', async () => {
    const all = Array.from({ length: SUBAGENT_MODEL_LIST_LIMIT + 1 }, (_, index) => ({ provider: 'p', modelId: `m${index}` }))
    const prompt = await renderDelegation({ offered: [SUBAGENT_TOOL], models: { models: all.slice(0, SUBAGENT_MODEL_LIST_LIMIT), total: all.length } })
    expect(prompt).toContain('`p/m0`')
    expect(prompt).toContain(`等 ${all.length} 个`)
    expect(prompt).not.toContain('`p/m12`')
  })

  it('routes the example through code mode when only codemode offers the tool', async () => {
    const prompt = await renderDelegation({ offered: ['codemode'], callable: [SUBAGENT_TOOL] })
    expect(prompt).toContain('委派示例：在 `codemode` 脚本里调用 `await tools.subagent({ task: "...", agent_type: "Explore", label: "..." })`。')
  })
})
