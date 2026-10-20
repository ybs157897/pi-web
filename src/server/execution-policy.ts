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
import { Plans } from './plan-tools.ts'

export const EXECUTION_POLICY_EXTENSION_NAME = 'execution-policy'

// Unknown tools, including external MCP tools, cannot establish read-only behavior by name.
const PLAN_TOOLS = new Set([
  'read', 'list_files', 'search_files', 'skill_list', 'skill_load', 'skill_validate',
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

function planAgent(agent: Agent): Agent {
  const allowed = (tool: { name: string }) => PLAN_TOOLS.has(tool.name)
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
            const plan = await api.snapshot(Plans, api.conversationId, context)
            if (plan?.active !== true) return tool.execute(args, api, context)
            if (!PLAN_TOOLS.has(tool.name)) {
              throw new Error(`Plan mode blocks ${tool.name}. Finish planning and wait for the user to leave Plan mode before implementation.`)
            }
            // Code mode discovers its nested tools through api.agent(), not the provider tool list.
            return tool.execute(args, {
              ...api,
              agent: async childContext => planAgent(await api.agent(childContext)),
            }, context)
          },
        }),
      })),
      ...sections.map(key => ({
        section: key,
        wrap: (item: NonNullable<Extension['sections']>[number]) => ({
          ...item,
          render: async (input: PromptInput, context: Parameters<typeof item.render>[1]) => {
            const plan = await input.read.snapshot(Plans, input.conversationId, context)
            return item.render(plan?.active === true ? { ...input, agent: planAgent(input.agent) } : input, context)
          },
        }),
      })),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          const plan = await api.snapshot(Plans, api.conversationId, context)
          if (plan?.active !== true) return undefined
          const removed = getCurrentTools(request.messages).filter(tool => !PLAN_TOOLS.has(tool.name))
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
