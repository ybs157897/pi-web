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

/** 执行政策扩展的注册名，供装配与测试引用。 */
export const EXECUTION_POLICY_EXTENSION_NAME = 'execution-policy'

// 未知工具（含外部 MCP 工具）不能凭名字确立只读行为，因此计划模式白名单按名字枚举。
const PLAN_TOOLS = new Set([
  'read', 'list_files', 'search_files', 'glob', 'grep', 'skill_list', 'skill_load', 'skill_validate',
  'ask_user_question', 'exit_plan_mode', 'get_goal', 'codemode',
  'subagent', 'spawn_teammate', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_list', 'team_task_get',
])

/**
 * 功能：把父会话的计划模式约束继承到被复用的持久子会话上。
 * @param tx 事务上下文，用于读写两个会话的 Plans 文档。
 * @param childId 子会话 id。
 * @param parentId 父会话 id。
 * @returns 无返回值（副作用：子会话 Plans 文档的 active/updatedAt）。
 * 内部逻辑：父会话计划未激活时不做任何事；复用的子会话不得保留比恢复它的任务更宽的模式，故直接置 active。
 */
export async function inheritPlanConstraint(tx: Tx, childId: ConversationId, parentId: ConversationId): Promise<void> {
  const parent = await tx.doc(Plans, parentId)
  if (!parent.active) return
  const child = await tx.doc(Plans, childId)
  child.active = true
  child.updatedAt = Date.now()
}

/**
 * 功能：构造按计划模式与子会话身份收窄工具面的 agent 视图。
 * @param agent 原始 agent 状态（工具集、可调用集、延迟工具）。
 * @param planActive 计划模式是否激活。
 * @param identity 子会话身份快照（可为空）。
 * @returns 收窄后的 agent；同时过滤 tools / callable / deferred 三个集合。
 * 内部逻辑：过滤器为合取——计划激活时仅放行 PLAN_TOOLS，且任何情况下都要过 subagentToolAllowed。
 */
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
 * 功能：装配 execution-policy 扩展——它本身不贡献新工具/section，而是包装所有已安装扩展的工具与 section。
 * 贡献：无新增 section/工具；对每个已安装工具包执行期闸门（子会话禁用 + 计划模式白名单），
 * 对每个 section 包渲染期收窄（constrainedAgent），并为 GenerationTask 挂 beforeRequest 钩子移除失效工具声明。
 * @param installed 已安装的全部扩展，用于收集需要包装的工具名与 section key。
 * @returns defineExtension 产物。
 * 内部逻辑：持久保存的 agent 选择不动（退出计划模式即恢复工具）；提示词渲染收窄广告路由，
 * 执行期再以当前状态复核（含 replay）。包装器并行读 Plans/Subagents 快照后放行或抛错；
 * codemode 通过 api.agent() 发现嵌套工具，故传改写后的 agent。钩子在工具面变化时追加
 * toolsRemoved 的 system 消息，保证下一次请求不再声明被禁工具。
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
            // codemode 通过 api.agent() 发现嵌套工具，而非 provider 工具列表。
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
