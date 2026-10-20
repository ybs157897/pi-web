import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@earendil-works/chord/context'
import type { Extension } from '@earendil-works/pi-durable'
import { Goals, createGoalExtension } from '../src/server/goal-tools.ts'
import { PlanExtension, Plans } from '../src/server/plan-tools.ts'
import { TodoTools, Todos } from '../src/server/todo-tools.ts'

type PromptInput = {
  conversationId: string
  agent: { tools: { name: string }[]; callable: { name: string }[] }
  env: undefined
  shown: Record<string, string>
  read: { snapshot: (document: unknown, id: string, context: unknown) => Promise<unknown> }
}

type MockApi = {
  conversationId: string
  snapshot: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
}

const context = {} as Context

function tool(extension: Extension, name: string) {
  const found = extension.tools?.find(candidate => candidate.name === name)
  if (!found) throw new Error(`Missing ${name} tool`)
  return found as unknown as {
    description: string
    parameters: unknown
    execute(args: never, api: never, context: never): Promise<unknown>
  }
}

function mockApi(options: {
  planActive?: boolean
  goal?: unknown
  transactionPlanActive?: boolean
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
  return { conversationId: 'conversation-1', snapshot, commit }
}

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

async function renderPlanPolicy(options: { offered?: string[]; callable?: string[] } = {}): Promise<string> {
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
    read: { snapshot: async document => document === Plans ? { active: true, updatedAt: 1 } : undefined },
  }
  const render = policy.render as unknown as (input: unknown, context: unknown) => Promise<string | undefined>
  return (await render(input, context)) ?? ''
}

function onYield(extension: Extension) {
  const registration = extension.hooks?.find(candidate => typeof candidate.handlers === 'object' && candidate.handlers !== null && 'onYield' in candidate.handlers)
  if (!registration) throw new Error('Missing goal continuation hook')
  const handler = registration.handlers as { onYield: (answer: unknown, api: never, context: never) => Promise<unknown> }
  return handler.onYield
}

describe('planning tool prompt policy', () => {
  it('routes plan submission only through tools available in the current request', async () => {
    const direct = await renderPlanPolicy({ offered: ['exit_plan_mode'] })
    expect(direct).toContain('Call `exit_plan_mode({ plan: "<plan markdown>" })` directly.')
    expect(direct).not.toContain('codemode')

    const codemode = await renderPlanPolicy({ offered: ['codemode'], callable: ['exit_plan_mode'] })
    expect(codemode).toContain('Through `codemode`, call `await tools.exit_plan_mode({ plan: "<plan markdown>" })` inside the script.')

    const unavailable = await renderPlanPolicy()
    expect(unavailable).toContain('Put the plan in your final response')
    expect(unavailable).not.toContain('exit_plan_mode')
    expect(unavailable).not.toContain('pending')
  })

  it('states the host-enforced read-only Plan boundary and plan format', async () => {
    const prompt = await renderPlanPolicy({ offered: ['exit_plan_mode'] })
    expect(prompt).toContain('workspace mutation, bash, and external MCP calls are unavailable')
    expect(prompt).toContain('first line is a level-1 heading')
  })

  it('describes concrete multi-step todo use, timely status updates, and real parallel work', () => {
    const description = tool(TodoTools, 'todo_write').description
    expect(description).toContain('multi-step')
    expect(description).toContain('skip trivial')
    expect(description).toContain('relevant verification')
    expect(description).toContain('Update statuses promptly')
    expect(description).toContain('actually running in parallel')
    expect(description).toContain('Replace the entire list')
    expect(description).toContain('Do not use the list for planning-mode notes')
  })

  it('renders a policy before any goal exists and names only directly callable tools', async () => {
    const prompt = await renderGoalPolicy({ offered: ['get_goal', 'create_goal', 'update_goal'] })
    expect(prompt).toContain('No goal is currently set')
    expect(prompt).toContain('Call `create_goal` directly.')
    expect(prompt).toContain('Call `get_goal` directly.')
    expect(prompt).not.toContain('codemode')
  })

  it('uses nested codemode calls only when codemode and the goal tool are both callable', async () => {
    const createPrompt = await renderGoalPolicy({
      offered: ['codemode'],
      callable: ['create_goal', 'get_goal', 'update_goal'],
    })
    expect(createPrompt).toContain('Through `codemode`, call `await tools.create_goal({ ... })` inside the script.')
    expect(createPrompt).toContain('Through `codemode`, call `await tools.get_goal({ ... })` inside the script.')

    const activePrompt = await renderGoalPolicy({
      offered: ['codemode'],
      callable: ['create_goal', 'get_goal', 'update_goal'],
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
    })
    expect(activePrompt).toContain('Through `codemode`, call `await tools.get_goal({ ... })` inside the script.')
    expect(activePrompt).toContain('Through `codemode`, call `await tools.update_goal({ ... })` inside the script.')
    expect(activePrompt).not.toContain('`create_goal`')
  })

  it('does not expose unavailable goal tools in policy, including on an existing active goal', async () => {
    const prompt = await renderGoalPolicy({
      goal: { goal: { id: 'g1', revision: 1, objective: 'continue work', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, createdAt: 1, updatedAt: 1 } },
    })
    expect(prompt).toContain('Current goal: goal_id "g1", revision 1')
    expect(prompt).not.toContain('`get_goal`')
    expect(prompt).not.toContain('`create_goal`')
    expect(prompt).not.toContain('`update_goal`')
  })

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

  it('reports an unset goal without suggesting an unavailable slash command', async () => {
    const result = await tool(createGoalExtension(), 'get_goal').execute({} as never, mockApi() as never, context as never)
    const output = result as { output: { text?: string }[] }
    expect(output.output[0]?.text).toContain('available goal policy')
    expect(output.output[0]?.text).not.toContain('/goal')
  })

  it('does not instruct goal creation or implementation progress in plan mode', async () => {
    const prompt = await renderGoalPolicy({ offered: ['create_goal'], planActive: true })
    expect(prompt).toContain('Plan mode is active: do planning work only.')
    expect(prompt).not.toContain('`create_goal`')
    expect(prompt).not.toContain('create a goal with')
  })

  it('keeps an active goal visible in plan mode without directing goal updates', async () => {
    const prompt = await renderGoalPolicy({
      goal: { goal: { id: 'g1', revision: 3, objective: 'continue work', phase: 'active', roundsStarted: 1, maxGoalRounds: 3, createdAt: 1, updatedAt: 3 } },
      offered: ['create_goal', 'update_goal'],
      planActive: true,
    })
    expect(prompt).toContain('Current goal: goal_id "g1", revision 3')
    expect(prompt).toContain('This goal remains active')
    expect(prompt).not.toContain('`create_goal`')
    expect(prompt).not.toContain('`update_goal`')
  })

  it('uses completion evidence and concrete blocking conditions without a round threshold', async () => {
    const prompt = await renderGoalPolicy({
      offered: ['update_goal'],
      callable: [],
      goal: { goal: { id: 'g1', revision: 2, objective: 'ship and verify', phase: 'active', roundsStarted: 1, maxGoalRounds: 4, createdAt: 1, updatedAt: 2 } },
    })
    expect(prompt).toContain('requested verification has passed, with concrete evidence')
    expect(prompt).toContain('a concrete condition makes further progress impossible')
    expect(prompt).not.toContain('consecutive rounds')
  })

  it('exposes only model-owned goal actions while retaining exact goal identifiers in policy', async () => {
    const activeGoal = { goal: { id: 'goal-42', revision: 7, objective: 'ship and verify', phase: 'active', roundsStarted: 1, maxGoalRounds: 4, createdAt: 1, updatedAt: 2 } }
    const prompt = await renderGoalPolicy({ offered: ['update_goal'], goal: activeGoal })
    expect(prompt).toContain('goal_id "goal-42", revision 7')

    const parameters = JSON.stringify(tool(createGoalExtension(), 'update_goal').parameters)
    expect(parameters).toContain('"complete"')
    expect(parameters).toContain('"blocked"')
    for (const userControl of ['edit', 'pause', 'resume', 'objective', 'max_goal_rounds']) {
      expect(parameters).not.toContain(`"${userControl}"`)
    }
  })
})

describe('planning mode write guards', () => {
  it('rejects todo progress updates without opening a commit while plan mode is active', async () => {
    const api = mockApi({ planActive: true })
    await expect(tool(TodoTools, 'todo_write').execute(
      { todos: [{ content: 'implementation', status: 'in_progress' }] } as never,
      api as never,
      context as never,
    )).rejects.toThrow(/plan mode is active/)
    expect(api.commit).not.toHaveBeenCalled()
  })

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

describe('goal automatic continuation gates', () => {
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
