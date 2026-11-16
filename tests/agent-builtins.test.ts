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

/**
 * 从 createSubagentTools 的注册结果中取出 subagent 工具的 execute 入口。
 * @param options 工具选项（prepareChild/resolveChildModel 等）
 * @returns subagent 工具的 execute 函数；工具缺失时抛错
 */
function registeredTool(options: SubagentToolOptions): { execute(args: unknown, api: unknown, context: unknown): Promise<unknown> } {
  const found = createSubagentTools(options).tools?.find(candidate => candidate.name === SUBAGENT_TOOL)
  if (!found) throw new Error(`Missing ${SUBAGENT_TOOL} tool`)
  return found as unknown as { execute(args: unknown, api: unknown, context: unknown): Promise<unknown> }
}

/** Explore 只读档的五个白名单工具名。 */
const READ_ONLY_TOOL_NAMES = ['read', 'glob', 'grep', 'list_files', 'search_files']

/**
 * stubRun —— 工具执行接缝的桩（team.test.ts 也 stub 同一处）：一个父会话、一个它创建的子会话，
 * 以及委派过程要读的文档/条目。`existing` 模拟回放命中已有子代理；`parentTools`/`thinkingLevel`
 * 喂给 agent 变更。真实 configure() 写入的 pi.agent 文档落在 agentStates。
 * @param options parentTools/parentCallable/parentDeferred=父工具面；thinkingLevel=父思考档；
 *                existing=true 表示子代理已存在（回放）；resolveChildModel=模型解析器
 * @returns api 桩、child 桩、创建请求列表、身份列表、agent 状态列表与父 agent 对象
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
  // 单一身份持有者：重复读子代理 doc 看到同一记录，后台分支的二次提交委派写入就能落在创建时写入的那条记录上。
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

/**
 * stubResolverDeps —— 模型解析器工厂的依赖桩：在目录/白名单边界 stub。
 * @param overrides catalog=目录中的模型（provider/model）；allowlist=白名单；levels=模型支持的思考档
 * @returns getModel/allowlist/supportedThinkingLevels 三个依赖
 */
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

/**
 * 内置委派档位测试（BUILTIN_PROFILES / profileByName）。
 *
 * 关键契约：
 * - 恰好两个与 ZCode 对齐的档位：general-purpose（不收窄工具）与 Explore（收窄到只读交集）；
 * - 未知/缺省 agent_type 回落到 general-purpose；两个提示词都带 pi-web 标识与非空描述；
 *   Explore 提示词含只读红线与 thorough 广度契约。
 */
describe('built-in delegation profiles', () => {
  // 档位清单恰为 general-purpose + Explore；general 不带 readonlyTools、Explore 恰为五个只读工具；
  // 缺省与未知 agent_type 都回落 general-purpose；每个提示词含 pi-web、描述非空；Explore 含只读红线与 very thorough。
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
    // Explore 的提示词带只读红线与广度契约。
    expect(explore.systemPrompt).toContain('只读红线')
    expect(explore.systemPrompt).toContain('very thorough')
  })

  // Explore 子代理工具面收窄到只读交集（不含父的 bash/write），instructions 用 Explore 提示词，
  // 不指定模型；身份记录带 profile=Explore 与任务文本作 label。
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

  // 父会话没有 read 工具时拒绝 Explore 委派（错误含提示），不创建会话、不写身份记录。
  it('refuses an Explore delegation whose parent has no read tool', async () => {
    const run = stubRun({ parentTools: ['glob', 'grep'] })
    await expect(registeredTool({ prepareChild: async () => undefined }).execute(
      { task: 'research', agent_type: 'Explore' }, run.api, {} as Context,
    )).rejects.toThrow(/Explore subagent needs the read tool/)
    expect(run.creations).toEqual([])
    expect(run.identities).toEqual([])
  })

  // 父只有 codemode（callable 含 read/grep/write/subagent）时，Explore 收窄保留 codemode 与嵌套只读工具（codemode/read/grep），丢弃 write。
  it('preserves codemode and nested read-only tools when Explore is delegated from codemode-only', async () => {
    const run = stubRun({ parentTools: ['codemode'], parentCallable: ['read', 'grep', 'write', 'subagent'] })
    await registeredTool({ prepareChild: async () => undefined }).execute(
      { task: 'research', agent_type: 'Explore' }, run.api, {} as Context,
    )
    expect(run.agentStates[0]?.tools).toEqual(['codemode', 'read', 'grep'])
  })

  // general-purpose 保留父的完整工具面（agent 变更不含 tools 键），只替换 instructions；身份记录 profile=general-purpose。
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

  // 新建子代理才应用解析出的模型与被钳制的思考档（medium → 模型支持的 low）；解析回调收到请求的模型引用与父思考档。
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

  // 回放复用已有子代理时不重放 agent 变更：不调 resolveChildModel、不创建新会话，只 submit 一次拿到原答案。
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

  // 后台委派立即返回激活回执（含 label、子会话 id、跟进消息指引，不含答案）而不等待；
  // submit 用 whenBusy=followUp；运行时收到完整 settlement 输入（无句柄随行）；
  // 行记录保持 running 且标 background；委派标记写入子代理记录供重启后 reconcile。
  it('launches run_in_background without waiting and hands the settlement to the runtime', async () => {
    const run = stubRun()
    const settlements: SubagentSettlementInput[] = []
    const result = await registeredTool({
      prepareChild: async () => undefined,
      settleWhenAnswered: (input) => { settlements.push(input) },
    }).execute(
      { task: 'research the tree', label: '调研', run_in_background: true }, run.api, {} as Context,
    )
    // 调用返回的是激活回执而不是子代理答案，并且不等待它。
    const output = (result as { output: Array<{ type: string; text: string }> }).output
    expect(output[0]?.type).toBe('text')
    expect(output[0]?.text).toContain('调研')
    expect(output[0]?.text).toContain(String(CHILD_ID))
    expect(output[0]?.text).toContain('跟进消息')
    expect(output[0]?.text).not.toContain('child answer')
    expect(run.child.submit).toHaveBeenCalledOnce()
    expect(run.child.submit.mock.calls[0]?.[0]).toMatchObject({
      content: 'research the tree',
      requestId: 'subagent:9:bg',
      whenBusy: 'followUp',
    })
    // 运行时收到 settlement 稍后注入结果所需的一切；不带任何句柄：从调用 api 派生的东西随调用消亡。
    expect(settlements).toHaveLength(1)
    expect(settlements[0]).toMatchObject({
      parent: PARENT_ID,
      child: CHILD_ID,
      label: '调研',
      settleRequestId: 'subagent-settle:9',
    })
    // 该行记录为 UI 保持 running 状态，并带上 background 标记。
    expect(run.api.details).toHaveBeenCalledWith(
      { conversationId: String(CHILD_ID), status: 'running', label: '调研', background: true },
      {},
    )
    // 委派标记写在子代理的记录上，重启后的 reconcile 才能找到它。
    expect(run.identities.at(-1)?.record).toMatchObject({
      label: '调研',
      delegation: { background: true, parent: PARENT_ID, requestId: 'subagent-settle:9' },
    })
  })

  // 未设 run_in_background 时前台路径等待答案（requestId=subagent:9）、不注册 settlement、身份记录不带 delegation 标记。
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

/**
 * 子代理模型解析测试（createChildModelResolver）。
 *
 * 关键契约：
 * - 目录内 + 白名单内的选择放行，思考档钳制到子模型支持的档位（缺支持信息时保留父档）；
 * - 目录缺失或不在白名单（含 p/* 前缀模式）抛 MODEL_UNAVAILABLE 并带对应中文提示；
 * - 解析失败在委派边界成为委派失败，不创建子会话。
 */
describe('child model resolution', () => {
  // 模型支持 off/low 时父档 medium 被钳到 low；支持 medium 时保持；无支持信息时保留父档 high。
  it('passes a catalogued, allowlisted pick and clamps the parent level to its support', () => {
    const resolve = createChildModelResolver(stubResolverDeps({ levels: ['off', 'low'] }))
    expect(resolve({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }))
      .toEqual({ model: { provider: 'p', modelId: 'fast' }, thinkingLevel: 'low' })
    // 模型支持的档位保持不变；缺少支持信息时保留父档。
    const exact = createChildModelResolver(stubResolverDeps({ levels: ['off', 'medium', 'high'] }))
    expect(exact({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }).thinkingLevel).toBe('medium')
    const unaware = createChildModelResolver(stubResolverDeps())
    expect(unaware({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'high' }).thinkingLevel).toBe('high')
  })

  // 目录外模型报「未出现在 Pi 模型目录中」；白名单（p/big）外报「不在模型白名单内」，白名单内放行；p/* 前缀覆盖整个 provider。
  it('rejects a model missing from the catalog or outside the allowlist', () => {
    const resolve = createChildModelResolver(stubResolverDeps())
    expect(() => resolve({ provider: 'missing', modelId: 'model' }, { thinkingLevel: 'medium' }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('未出现在 Pi 模型目录中') }))
    const restricted = createChildModelResolver(stubResolverDeps({ allowlist: ['p/big'] }))
    expect(() => restricted({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }))
      .toThrowError(expect.objectContaining({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('不在模型白名单内') }))
    expect(restricted({ provider: 'p', modelId: 'big' }, { thinkingLevel: 'medium' }).model).toEqual({ provider: 'p', modelId: 'big' })
    // 前缀模式覆盖整个 provider，与设置里的白名单语义一致。
    const pattern = createChildModelResolver(stubResolverDeps({ allowlist: ['p/*'] }))
    expect(pattern({ provider: 'p', modelId: 'fast' }, { thinkingLevel: 'medium' }).model).toEqual({ provider: 'p', modelId: 'fast' })
  })

  // 委派请求携带不可用模型时在委派边界抛 MODEL_UNAVAILABLE，且不创建任何子会话。
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

/**
 * subagent 工具参数 schema 测试。
 *
 * 关键契约：内置 agent_type 与完整的模型选择可通过校验；provider/modelId 缺一不可的模型选择、
 * 未知 agent_type（如小写 explore）都拒绝。
 */
describe('subagent tool schema', () => {
  // 合法形态（裸 task、两种 agent_type、完整 model、run_in_background 布尔）通过；缺 provider 或 modelId 的 model、小写 explore 拒绝。
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
    // 模型选择必须完整到达：provider 与 modelId 都必填。
    expect(check.Check({ task: 'work', model: { modelId: 'fast' } })).toBe(false)
    expect(check.Check({ task: 'work', model: { provider: 'p' } })).toBe(false)
    expect(check.Check({ task: 'work', agent_type: 'explore' })).toBe(false)
  })
})

/**
 * 委派策略 section 渲染测试。
 *
 * 关键契约：
 * - 两个委派工具都不可路由时 section 整体缺席；
 * - 只提及当前可用的委派路线（spawn_teammate 或 subagent，互不混入）；
 * - 完整形态列出两个内置档位、委派规则集与直接调用示例；只有一个可选模型时不出「可选模型」行；
 * - ≥2 个模型列出清单与「缺省继承当前会话模型」；超过上限截断并加「等 N 个」尾巴；
 * - 只有 codemode 暴露工具时示例改为脚本内调用写法。
 */
describe('delegation policy section', () => {
  /**
   * 渲染 delegation-policy section。
   * @param options offered=宣告的工具；callable=可调用工具；models=可选子模型列表
   * @returns 渲染文本；section 缺失时抛错
   */
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

  // 没有 subagent 也没有 spawn_teammate 可路由时（只给 read / 什么都不给），section 不渲染。
  it('stays absent when neither delegation tool is routable', async () => {
    expect(await renderDelegation({ offered: ['read'] })).toBeUndefined()
    expect(await renderDelegation()).toBeUndefined()
  })

  // 只有 spawn_teammate 时只写它、不提 subagent；只有 subagent 时反之。
  it('mentions only the available delegation route', async () => {
    const teammate = await renderDelegation({ offered: ['spawn_teammate'] })
    expect(teammate).toContain('直接调用 `spawn_teammate(')
    expect(teammate).not.toContain('subagent')
    const child = await renderDelegation({ offered: ['subagent'] })
    expect(child).not.toContain('spawn_teammate')
  })

  // 完整渲染：两个档位、广度契约、委派规则五条、并行/串行协调、计划模式只读约束、直接调用示例；
  // 只有一个可选模型时不出「可选模型」行（一个选择等于没得选）。
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
    // 只有一个可选模型等于没得选，所以模型行要等第二个模型出现。
    expect(prompt).not.toContain('可选模型')
  })

  // 两个可选模型时列出「可选模型：p/fast、q/big」并提示缺省继承当前会话模型。
  it('lists the selectable models once at least two are available', async () => {
    const prompt = await renderDelegation({
      offered: [SUBAGENT_TOOL],
      models: { models: [{ provider: 'p', modelId: 'fast' }, { provider: 'q', modelId: 'big' }], total: 2 },
    })
    expect(prompt).toContain('可选模型：`p/fast`、`q/big`')
    expect(prompt).toContain('缺省继承当前会话模型')
  })

  // 模型数超过 SUBAGENT_MODEL_LIST_LIMIT 时截断展示并加「等 N 个」尾巴，超限的 p/m12 不出现。
  it('truncates a long model list with a 「等 N 个」 tail', async () => {
    const all = Array.from({ length: SUBAGENT_MODEL_LIST_LIMIT + 1 }, (_, index) => ({ provider: 'p', modelId: `m${index}` }))
    const prompt = await renderDelegation({ offered: [SUBAGENT_TOOL], models: { models: all.slice(0, SUBAGENT_MODEL_LIST_LIMIT), total: all.length } })
    expect(prompt).toContain('`p/m0`')
    expect(prompt).toContain(`等 ${all.length} 个`)
    expect(prompt).not.toContain('`p/m12`')
  })

  // 只有 codemode 暴露 subagent（在 callable 里）时，示例改为在 codemode 脚本里 await tools.subagent(...) 的写法。
  it('routes the example through code mode when only codemode offers the tool', async () => {
    const prompt = await renderDelegation({ offered: ['codemode'], callable: [SUBAGENT_TOOL] })
    expect(prompt).toContain('委派示例：在 `codemode` 脚本里调用 `await tools.subagent({ task: "...", agent_type: "Explore", label: "..." })`。')
  })
})
