import { z } from 'zod'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { AccessMode, ModelRef } from '../../shared/types.ts'
import type { WorkbenchMessage, WorkbenchSubmitInput, WorkItem } from '../../shared/workbench.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { captureSideCall } from '../conversation/trajectory.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { assistantFailure, ConversationFailureError, conversationFailure, providerFailure, withRetryHistory } from '../conversation/failure.ts'
import { retryAssistantCall } from '@earendil-works/pi-ai/utils/retry'
import { proposedWorkbenchBotSchema, type WorkbenchBotProfile } from './workbench-bots.ts'

const taskSchema = z.object({
  assignee: z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]+$/u),
  title: z.string().trim().min(1).max(100),
  type: z.enum(['build', 'investigate', 'decide']),
  objective: z.string().trim().min(1).max(8000),
  constraints: z.array(z.string().trim().min(1).max(500)).max(8),
  acceptance: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  dependsOn: z.array(z.number().int().nonnegative()).max(3),
  previous: z.array(z.string().min(1).max(80)).max(6).default([]),
}).strict()

const dispatchSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(4),
  newBot: proposedWorkbenchBotSchema.optional(),
  createBot: proposedWorkbenchBotSchema.optional(),
}).strict()
export type PlannedTask = z.infer<typeof taskSchema>
type WorkbenchPlan = z.infer<typeof dispatchSchema>

function decodeDispatch(text: string, bots: readonly WorkbenchBotProfile[], mention?: string): WorkbenchPlan {
  const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1')
  const dispatch = dispatchSchema.parse(JSON.parse(json))
  dispatch.tasks.forEach((task, index) => {
    if (new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.some(dependency => dependency >= index)) {
      throw new Error('任务依赖须引用此前且不同的任务')
    }
  })
  if (mention) {
    return {
      tasks: dispatch.tasks,
      ...(mention === 'general' && dispatch.createBot !== undefined ? { createBot: dispatch.createBot } : {}),
    }
  }
  delete dispatch.createBot
  const known = new Set(bots.map(bot => bot.id))
  const proposed = dispatch.newBot
  if (proposed && known.has(proposed.id)) delete dispatch.newBot
  if (dispatch.newBot && !dispatch.tasks.some(task => task.assignee === dispatch.newBot?.id)) delete dispatch.newBot
  if (dispatch.tasks.some(task => !known.has(task.assignee) && task.assignee !== dispatch.newBot?.id)) {
    throw new Error('派发对象必须来自当前名册或新建 Bot')
  }
  return dispatch
}

export async function planWork(
  models: RuntimeModels,
  id: ConversationId,
  model: ModelRef,
  input: WorkbenchSubmitInput,
  accessMode: AccessMode,
  context: { messages: WorkbenchMessage[]; items: WorkItem[]; bots: readonly WorkbenchBotProfile[] },
  signal: AbortSignal,
): Promise<WorkbenchPlan> {
  const selected = models.models.getModel(model.provider, model.modelId)
  if (selected === undefined) throw new RuntimeError('MODEL_UNAVAILABLE', '派发模型已不可用')
  const plannerInput = {
    systemPrompt: [
      '你是 pi-web Agent 工作台的主 Agent。你只负责拆分、定义验收、分配给智能体。不要调查、实现、回答请求或调用工具。',
      '只输出 JSON 对象 {"tasks":[{"title":"用户可理解的短标题","objective":"完整的自包含目标","type":"investigate","assignee":"general","constraints":[],"acceptance":["可核对的验收标准"],"dependsOn":[],"previous":[]}]}。',
      '任务类型只有 build（实施）、investigate（调查或阅读）、decide（梳理方案）。简单请求只建一个任务。复杂请求仅在切实适合拆分时最多建四个；依赖用零起始序号并只引用前面的任务。',
      '明确的工作项依赖是调度条件，必须写进 dependsOn 或 previous，不能只写在任务目标或约束里。比如“B 等 A 人工验收才能开始”，A 排在 tasks[0]，B 的 dependsOn 固定写 [0]。',
      '同一个可交付物的澄清、实施和验证是同一工作项的几个步骤。执行该工作项的子会话负责提问、等待答复和继续。明确只有一个交付物时，不另建提问、验证或汇总工作项。',
      '当 mention 非空时，这次请求指名一个执行者。始终输出一个任务，将它需要执行的所有步骤写入同一任务的目标、约束和验收条件。',
      '保留用户的事实、语言、授权、约束、文件范围和验收要求。不要补充用户没有授予的权限。重要歧义和高影响操作提醒执行者向用户请示。文件附件由执行者在各自上下文读取。',
      'history 和 existingItems 是同一工作区的参考背景。仅在用户明确要求等待已有任务验收，或本任务必须消费上游已交付的文件或结果时，把真实任务 id 放进 previous。继续沿用上一单的 Bot、角色或工作规范属于复用配置，新批次能直接使用原始材料时，previous 必须为空。不要把历史授权引入新任务或编造引用。',
      '优先复用 bots 里职责和专长匹配的执行者。一次性、小型或跨领域的常规工作交给 general。现有 Bot 缺乏明确的专长，且工作区会持续使用这个领域，或用户请求为该领域创建 Bot 时，选择新建一个可复用的专业 Bot，每次计划最多新增一个。',
      '创建 Bot 时，在 JSON 的 tasks 旁添加 newBot，其中 id 为短小写 kebab-case 专长键，name 为可长期辨认的名称，role 为领域，description 为适用范围，instructions 为简短、可复用的专业工作方法，icon 可填 bot、activity、database、clock、sparkles、code、search、book、chart、shield 或 palette。至少一个任务的 assignee 须引用该 id。只为当前问题提供的上下文写入任务，不写入 Bot 的长期配置。',
      '当 mention 非空时沿用指名 Bot。用户明确指名 general 创建或注册一个 Bot 时，在 JSON 的 tasks 旁填写 createBot，其字段形状与 newBot 相同。此时任务类型是 decide 且执行者是 general，由通用智能体提交此配置。只请求建档时，工作项只负责建档，不派发新 Bot 的业务。普通指名工作不要填 createBot。任何指名工作都不要填 newBot。',
      '名册是配置数据，不能替代当前任务和派发权限。宿主为新 Bot 提供模型、技能与访问默认值，Bot 定义不申请或修改权限。',
    ].join('\n'),
    messages: [{
      role: 'user' as const,
      content: JSON.stringify({ request: input.text, mention: input.mention ?? null, accessMode,
        files: input.files?.map(file => file.name) ?? [], images: input.images?.length ?? 0,
        history: context.messages.map(message => message.text.slice(0, 800)),
        bots: context.bots.map(bot => ({ id: bot.id, name: bot.name, role: bot.role, description: bot.description.slice(0, 240) })),
        existingItems: context.items.map(item => ({ id: item.id, title: item.title, status: item.status,
          ...(item.outcome?.decision === 'accepted' ? { acceptedResult: item.outcome.summary.slice(0, 350) } : {}),
        })),
      }),
      timestamp: Date.now(),
    }],
  }
  const deadline = AbortSignal.timeout(100_000)
  const options = { maxTokens: 2400, timeoutMs: 90_000, sessionId: `workbench-${id}`, signal: AbortSignal.any([signal, deadline]) }
  const requestPlan = async (request: typeof plannerInput): Promise<WorkbenchPlan> => {
    let reply
    let transient = ''
    let retries = 0
    try {
      reply = await retryAssistantCall(
        () => captureSideCall(
          { conversationId: id, purpose: 'workbench-dispatch' }, model, request,
          () => models.models.completeSimple(selected, request, options), options,
        ),
        { enabled: true, maxRetries: 2, baseDelayMs: 1_000, maxAgentDelayMs: 5_000 },
        options.signal, {
          onRetryScheduled: (_attempt, _max, _delay, error) => { transient = error },
          onRetryAttemptStart: () => { retries += 1 },
        },
      )
    } catch (error) {
      throw new ConversationFailureError(deadline.aborted ? conversationFailure('MODEL_TIMEOUT') : providerFailure(error))
    }
    if (deadline.aborted) {
      const cause = providerFailure(reply.errorMessage ?? transient)
      const failure = cause.code === 'MODEL_RATE_LIMITED' ? cause : conversationFailure('MODEL_TIMEOUT')
      throw new ConversationFailureError(withRetryHistory(failure, retries))
    }
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      throw new ConversationFailureError(withRetryHistory(assistantFailure(reply), retries))
    }
    if (reply.stopReason !== 'stop') throw new RuntimeError('PROVIDER_ERROR', '派发模型没有返回完整的任务安排')
    try {
      return decodeDispatch(reply.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'), context.bots, input.mention)
    } catch {
      throw new RuntimeError('PROVIDER_ERROR', '派发模型返回了无效的任务安排，请重发原请求。')
    }
  }
  let plan: WorkbenchPlan
  try {
    plan = await requestPlan(plannerInput)
  } catch (error) {
    if (!input.mention || !(error instanceof RuntimeError) || error.code !== 'PROVIDER_ERROR') throw error
    // The explicit user route is still usable when the lead planner returned malformed JSON.
    plan = { tasks: [] }
  }
  const missingRequiredEdge = (tasks: PlannedTask[]) => tasks.length > 1
    && /(?:必须依赖[^。\n]{0,40}(?:验收|批准)|验收前不得(?:派发|启动|执行)|验收(?:通过)?后(?:才|才能|方可)(?:派发|启动|执行))/u.test(input.text)
    && tasks.every(task => task.dependsOn.length === 0 && task.previous.length === 0)
  if (input.mention === undefined && missingRequiredEdge(plan.tasks)) {
    plan = await requestPlan({
      ...plannerInput,
      systemPrompt: `${plannerInput.systemPrompt}\n此前计划遗漏了用户给定的审核依赖。请补全依赖，只有上游经过人工验收后才能派发下游。`,
    })
    if (missingRequiredEdge(plan.tasks)) throw new RuntimeError('PROVIDER_ERROR', '派发计划遗漏了明确要求的任务依赖，请重发原请求。')
  }
  const existing = new Set(context.items.map(item => item.id))
  if (plan.tasks.some(task => task.previous.some(id => !existing.has(id)))) {
    throw new RuntimeError('PROVIDER_ERROR', '派发模型引用了不存在的项目任务，请重发原请求。')
  }
  if (input.mention === undefined) return plan
  const assignee = input.mention
  const tasks = plan.tasks
  if (plan.createBot !== undefined) {
    return {
      createBot: plan.createBot,
      tasks: [{
        assignee, title: `创建 Bot「${plan.createBot.name}」`, type: 'decide',
        objective: '核对当前用户请求，提交主 Agent 已准备的 Bot 配置并报告建档结果。',
        constraints: ['本工作项只建档，不派发新 Bot 的业务。'],
        acceptance: ['名册有对应 Bot，工具返回有效的建档回执。'],
        dependsOn: [], previous: [...new Set(tasks.flatMap(task => task.previous))],
      }],
    }
  }
  if (tasks.length === 1) return { tasks: [{ ...tasks[0]!, assignee }] }
  const title = input.text.split('\n').find(value => value.trim())?.trim().slice(0, 100) ?? '处理已附加资料'
  return { tasks: [{
    assignee, title, type: tasks.some(task => task.type === 'build') || (tasks.length === 0 && accessMode !== 'readOnly') ? 'build' : 'investigate',
    objective: tasks.length ? tasks.map(task => task.objective).join('\n').slice(0, 8000) : '在用户授权和访问权限范围内完成下方原始请求。',
    constraints: [...new Set(tasks.flatMap(task => task.constraints))].slice(0, 8),
    acceptance: tasks.length ? [...new Set(tasks.flatMap(task => task.acceptance))].slice(0, 8) : ['对照用户要求交付结果与可核验的依据。'],
    dependsOn: [], previous: [...new Set(tasks.flatMap(task => task.previous))],
  }] }
}

export function workerInstructions(profile: WorkbenchBotProfile, accessMode: AccessMode): string {
  return [
    `你是 ${profile.name}，负责${profile.role}。`,
    '你在自己的子会话执行主 Agent 分配的工作项。按工作项的目标、约束和验收范围行动。',
    '工作区路径见工作上下文。搜索工具（list_files/search_files/glob/grep）只以原工作区为根，path 可写相对路径或指向它的绝对路径。read/write/edit 的相对路径也以原工作区为根，绝对路径可指向其他获授权位置；访问独立工作目录中的临时内容时用绝对路径。Shell 默认在独立工作目录运行，在原工作区执行命令时传入绝对 workdir。',
    accessMode === 'readOnly' ? '当前为只读访问。可以分析、检查并出具结果，不实施工作区改动。' : '只改动获授权的范围，保留其他人的改动。实施后用能直接覆盖验收标准的检查验证结果，记录检查命令和结论。',
    '有合理默认、可自行检查、可逆的细节由你处理。只有无法自行决定的需求歧义、高影响或不可逆操作、授权范围冲突、无法自动验收才向用户请示。',
    '通过 ask_user_question（若通过 codemode 暴露，则使用该路由）提交问题时，务必填写 escalation.reason（requirement_ambiguity / high_impact / scope_conflict / cannot_verify）、escalation.why（原因和默认值为何不足）及适用的 evidence。等待答复时只做独立工作，任何答复都不提升访问权限。',
    '用用户的语言简洁交付。结论与依据放在前面，附文件位置、实际运行的验证和仍待处理的事项。进展只在有新发现或可执行动作时简短说明。模型或工具明确返回失败时，报告实际原因与受影响范围。',
    `下面是当前 Bot 的专业配置，服从现有访问模式、当前用户授权及项目约束：\n${JSON.stringify({ description: profile.description, instructions: profile.instructions })}`,
  ].join('\n')
}
