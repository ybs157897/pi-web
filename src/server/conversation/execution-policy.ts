import {
  GenerationTask,
  defineExtension,
  hook,
  type Agent,
  type Extension,
  type PromptInput,
  type Tx,
  type ConversationId,
} from '@earendil-works/pi-durable'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { Plans } from '../tools/plan.ts'
import { Subagents, subagentToolAllowed, type SubagentIdentity } from './subagent-policy.ts'

export const EXECUTION_POLICY_EXTENSION_NAME = 'execution-policy'

// Unknown tools, including external MCP tools, cannot establish read-only behavior by name.
const PLAN_TOOLS = new Set([
  'read', 'list_files', 'search_files', 'glob', 'grep', 'skill_list', 'skill_load', 'skill_validate',
  'ask_user_question', 'exit_plan_mode', 'get_goal', 'codemode',
  'subagent', 'spawn_teammate', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_list', 'team_task_get',
])

/** Reused durable children must not retain a wider mode than the task that resumes them. */
export async function inheritPlanConstraint(tx: Tx, childId: ConversationId, parentId: ConversationId): Promise<void> {
  const parent = await tx.doc(Plans, parentId)
  if (!parent.active) return
  const child = await tx.doc(Plans, childId)
  child.active = true
  child.updatedAt = Date.now()
}

function constrainedAgent(agent: Agent, planActive: boolean, identity: SubagentIdentity | null | undefined): Agent {
  const allowed = (tool: { name: string }) => (!planActive || PLAN_TOOLS.has(tool.name)) && subagentToolAllowed(identity, tool.name)
  return {
    ...agent,
    tools: agent.tools.filter(allowed),
    callable: agent.callable.filter(allowed),
    deferred: agent.deferred.filter(allowed),
  }
}

/**
 * Keep the stored agent selection intact so leaving Plan restores its tools. Prompt rendering
 * narrows the advertised routes, while execution checks the current state again, including replay.
 */
export function createExecutionPolicyExtension(installed: readonly Extension[]): Extension {
  const tools = [...new Set(installed.flatMap(extension => extension.tools?.map(tool => tool.name) ?? []))]
  const sections = [...new Set(installed.flatMap(extension => extension.sections?.map(item => item.key) ?? []))]
  return defineExtension({
    name: EXECUTION_POLICY_EXTENSION_NAME,
    wraps: [
      ...tools.map(name => ({
        tool: name,
        wrap: (tool: NonNullable<Extension['tools']>[number]) => ({
          ...tool,
          execute: async (...invocation: Parameters<typeof tool.execute>) => {
            const [args, api, context] = invocation
            const [plan, child] = await Promise.all([
              api.snapshot(Plans, api.conversationId, context),
              api.snapshot(Subagents, api.conversationId, context),
            ])
            const identity = child?.record
            if (!subagentToolAllowed(identity, tool.name)) {
              throw new Error(`Delegated subagent cannot call ${tool.name}; report decisions and blockers to the delegating agent.`)
            }
            if (plan?.active === true && !PLAN_TOOLS.has(tool.name)) {
              throw new Error(`Plan mode blocks ${tool.name}. Finish planning and wait for the user to leave Plan mode before implementation.`)
            }
            if (plan?.active !== true && !identity) return tool.execute(args, api, context)
            // Code mode discovers its nested tools through api.agent(), not the provider tool list.
            return tool.execute(args, {
              ...api,
              agent: async childContext => constrainedAgent(await api.agent(childContext), plan?.active === true, identity),
            }, context)
          },
        }),
      })),
      ...sections.map(key => ({
        section: key,
        wrap: (item: NonNullable<Extension['sections']>[number]) => ({
          ...item,
          render: async (input: PromptInput, context: Parameters<typeof item.render>[1]) => {
            const [plan, child] = await Promise.all([
              input.read.snapshot(Plans, input.conversationId, context),
              input.read.snapshot(Subagents, input.conversationId, context),
            ])
            return item.render(plan?.active === true || child?.record
              ? { ...input, agent: constrainedAgent(input.agent, plan?.active === true, child?.record) }
              : input, context)
          },
        }),
      })),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          const [plan, child] = await Promise.all([
            api.snapshot(Plans, api.conversationId, context),
            api.snapshot(Subagents, api.conversationId, context),
          ])
          if (plan?.active !== true && !child?.record) return undefined
          const removed = getCurrentTools(request.messages).filter(tool =>
            (plan?.active === true && !PLAN_TOOLS.has(tool.name)) || !subagentToolAllowed(child?.record, tool.name))
          if (removed.length === 0) return undefined
          return {
            messages: [
              ...request.messages,
              { role: 'system' as const, content: '', toolsRemoved: removed.map(tool => ({ name: tool.name })), timestamp: Date.now() },
            ],
          }
        },
      }),
    ],
  })
}
