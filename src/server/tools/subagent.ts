import { configure, defineExtension, defineTool, section, type AgentChange, type Extension } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  SettledSubmissionRecord,
  ToolExecutionApi,
  ToolExecutionResult,
  Tx,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { Type, type Message } from '@earendil-works/pi-ai'
import { inheritPlanConstraint } from '../conversation/execution-policy.ts'
import { Subagents } from '../conversation/subagent-policy.ts'
import { resolveToolRoute, toolRouteInstruction } from '../conversation/tool-routing.ts'
import {
  profileByName,
  type ChildModelRef,
  type ChildModelResolver,
} from '../agents/builtins.ts'

/** 面向模型的工具名；同时也是只读白名单条目与工具行展示的 label。 */
export const SUBAGENT_TOOL = 'subagent'

/**
 * 内置委派档案（与 ZCode 对齐：`general-purpose` 与 `Explore`）。`general-purpose`
 * 在子代理策略下继承父会话的工作工具；`Explore` 收窄为只读检索。
 */
export { Subagents } from '../conversation/subagent-policy.ts'
export type { SubagentProfile, SubagentIdentity, SubagentDelegation } from '../conversation/subagent-policy.ts'

/** subagent task 的最大字符数。 */
export const MAX_SUBAGENT_TASK_CHARS = 20_000
/** subagent label 的最大字符数。 */
export const MAX_SUBAGENT_LABEL_CHARS = 60

/** 委派 section 在截断为「等 N 个」之前列出的模型选取数。 */
export const SUBAGENT_MODEL_LIST_LIMIT = 12

/**
 * UI 从工具调用读取的详情：调用仍在运行时子代理行就能挂到子会话上（DSH 同样返回
 * 一个 activation）。
 */
export type SubagentToolDetails = {
  conversationId: string
  status: 'running' | 'completed' | 'failed'
  label: string
  /** 后台委派仍在运行时设置；其结果以结算消息送达。 */
  background?: boolean
}

/** 一次委派的终态，即 `subagent()` 向模型回报的两种结果。 */
type DelegationOutcome =
  | { kind: 'answered'; text: string }
  | { kind: 'failed'; reason: string }

/** 校验 task：非空且不超过 MAX_SUBAGENT_TASK_CHARS，返回 trim 后文本。 */
function normalizeTask(value: unknown): string {
  const task = typeof value === 'string' ? value.trim() : ''
  if (task === '') throw new Error('The subagent task must be a non-empty string.')
  if (task.length > MAX_SUBAGENT_TASK_CHARS) {
    throw new Error(`The subagent task is limited to ${MAX_SUBAGENT_TASK_CHARS} characters.`)
  }
  return task
}

/** 清洗展示 label：DSH 要求简短展示描述，这里可省略并回落为任务首行；超长截断加省略号。 */
function normalizeLabel(value: unknown, task: string): string {
  const explicit = typeof value === 'string' ? value.trim() : ''
  const label = explicit === '' ? (task.split('\n').find(line => line.trim() !== '') ?? task).trim() : explicit
  return label.length > MAX_SUBAGENT_LABEL_CHARS ? `${label.slice(0, MAX_SUBAGENT_LABEL_CHARS - 1)}…` : label
}

/**
 * 功能：提取子会话的最终答复文本——最后一条非空 assistant 消息，对应 DSH 的
 * `SubagentResult.output`。
 * @param messages 子会话的消息序列。
 * @returns 答复文本；没有任何 assistant 文本时返回空串。
 */
export function answerText(messages: readonly Message[] | undefined): string {
  for (const message of [...messages ?? []].reverse()) {
    if (message.role !== 'assistant') continue
    const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * 功能：说明一次已结算的提交为何没有答复——骨架（harness）原因加上已记录的详情。
 * @param settled 已结算的提交记录。
 * @returns 人类可读的原因描述。
 */
export function unansweredReason(settled: SettledSubmissionRecord): string {
  const detail = settled.status === 'unanswered' && settled.detail !== undefined ? ` (${JSON.stringify(settled.detail)})` : ''
  return settled.status === 'unanswered' ? `${settled.reason}${detail}` : 'the run left no answer entry'
}

/**
 * runtime 结算通道上报一次后台委派所需的全部信息。结算逃出本次工具调用的生命周期
 * （调用已返回 activation），因此它在 runtime 的后台上下文运行，绝不再碰本次调用的
 * `api.*`——由 `api` 派生的句柄绑定在本次调用上随调用消亡，结算只能按 id 从 runtime
 * 重新解析一切。
 */
export type SubagentSettlementInput = {
  /** 委派工作并接收结算消息的父会话。 */
  parent: ConversationId
  /** 答复待结算的子会话。 */
  child: ConversationId
  label: string
  /** 结算消息注入所用的请求 id（`subagent-settle:<toolTaskId>`）。 */
  settleRequestId: string
}

/**
 * 委派 section 的模型行数据：最多 `SUBAGENT_MODEL_LIST_LIMIT` 个选取，加上允许列表与
 * 已配置凭据实际覆盖的总数，长列表以「等 N 个」收尾。
 */
export type ChildModelList = { models: ChildModelRef[]; total: number }

/**
 * 把 DSH 的 `subagent` 工具注册为前台委派：一次调用创建一个任务归属的子会话，等待其
 * 答复并把答复经 `output` 通道返回；失败走 diagnostic 通道，保持答复正文干净（DSH 在
 * `SubagentResult` 中把 output 与 diagnostic 分开也是同样的理由）。
 *
 * `prepareChild` 让 runtime 在创建事务内写入子会话元数据（标题、工作区、访问模式），
 * 那里只有文档访问可用。`resolveChildModel` 校验显式模型选取；`availableChildModels`
 * 供给委派 section 的模型行。`settleWhenAnswered` 是 runtime 的后台结算通道：后台委派
 * 把子提交交给它而不是原地等待。
 */
export type SubagentToolOptions = {
  prepareChild: (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string) => Promise<void>
  /** 对显式选取的子模型按目录与允许列表校验并夹取。 */
  resolveChildModel?: ChildModelResolver
  /** 允许列表中 provider 带凭据的目录模型，供委派 section 的模型行使用。 */
  availableChildModels?: () => ChildModelList | Promise<ChildModelList>
  /** 子提交结算后，把一次后台委派的结果送达父会话。 */
  settleWhenAnswered?: (input: SubagentSettlementInput) => void
}

/**
 * 功能：计算新建子会话在复制父组合之上追加的 agent 变更：总是包含档案的系统提示词，
 * `Explore` 加只读工具交集，显式选取的模型经校验后带上。
 * 内部逻辑：读取父 agent 以解析工具路由；codemode-only 下直接提供的工具不含嵌套启用
 * 的工具，故交集里额外保留 `codemode`；Explore 缺 read 工具时抛错。重放的调用复用其
 * 子会话，不会重建或重放该变更。
 */
async function childAgentChange(
  profileName: string | undefined,
  model: ChildModelRef | undefined,
  options: SubagentToolOptions,
  api: ToolExecutionApi<SubagentToolDetails>,
  context: Context,
): Promise<AgentChange> {
  const profile = profileByName(profileName)
  const readonlyTools = profile.readonlyTools
  const resolve = model !== undefined && options.resolveChildModel !== undefined ? options.resolveChildModel : undefined
  const parent = readonlyTools !== undefined || resolve !== undefined ? await api.agent(context) : undefined
  const readRoute = parent === undefined ? 'unavailable' : resolveToolRoute(parent, 'read')
  // codemode-only 下直接提供的工具不含嵌套启用的工具。
  const tools = readonlyTools !== undefined && parent !== undefined
    ? [...new Map([...parent.tools, ...parent.callable, ...parent.deferred]
      .filter(tool => readonlyTools.includes(tool.name) || (readRoute === 'codemode' && tool.name === 'codemode'))
      .map(tool => [tool.name, tool])).values()]
    : undefined
  if (readonlyTools !== undefined && readRoute === 'unavailable') {
    throw new Error('The Explore subagent needs the read tool; this conversation cannot delegate read-only research.')
  }
  const resolved = model !== undefined && resolve !== undefined && parent !== undefined
    ? resolve(model, { thinkingLevel: parent.thinkingLevel })
    : undefined
  return {
    instructions: profile.systemPrompt,
    ...(tools === undefined ? {} : { tools }),
    ...(resolved === undefined ? {} : {
      model: resolved.model,
      ...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
    }),
  }
}

/**
 * 功能：装配 subagent 工具扩展，贡献 1 个工具（`subagent`）与 1 个 section
 * （delegation-policy 委派指南：何时委派、选哪种内置档案、选哪个模型）。
 * 内部逻辑：section 按当前 agent 的工具路由动态生成（subagent/spawn_teammate 均不可用
 * 时不注入）；可选注入可用模型行与委派示例。
 * @param options runtime 注入的子会话创建/模型/结算依赖。
 * @returns 名为 `subagent` 的扩展。
 */
export function createSubagentTools(options: SubagentToolOptions): Extension {
  /** ZCode 的委派指南：何时委派、选哪种内置类型、选哪个模型。 */
  const delegationSection = section('delegation-policy', async (input) => {
    const routes = {
      subagent: resolveToolRoute(input.agent, SUBAGENT_TOOL),
      teammate: resolveToolRoute(input.agent, 'spawn_teammate'),
    }
    if (routes.subagent === 'unavailable' && routes.teammate === 'unavailable') return undefined
    if (routes.subagent === 'unavailable') {
      const teammate = toolRouteInstruction('spawn_teammate', routes.teammate, '{ name: "worker", prompt: "..." }', 'zh')
      return [
        '需要共享任务板或成员间持续通信时，可委派队友。为任务写清目标、授权、范围、验收和证据；写入范围重叠或共用产物的工作应协调并串行处理。',
        '计划模式开启期间只委派只读调研。队友结果需通过任务板或消息收集。',
        teammate ? `委派示例：${teammate}。` : '',
      ].filter(Boolean).join('\n')
    }
    const lines = [
      '内置子智能体类型（subagent 的 agent_type）：',
      `- general-purpose：${profileByName('general-purpose').summary}`,
      `- Explore：${profileByName('Explore').summary}`,
      '何时委派：调研、检索、盘点类子任务默认委派——预计要读超过三个文件、或范围不确定时，先派 Explore 再综合它的结论，不要自己逐个翻文件。委派的收益是你只保留结论：文件倾倒和大段阅读都留在子会话里，不消耗主会话上下文。只有已知路径/符号的单点事实才直接查。',
      '多项目任务可并行委派互相独立的项给 general-purpose：为每项写全目标、授权、范围、验收和证据，明确只读还是允许写入，必要时说明返回格式，并指定不重叠的写入范围；存在强依赖、写入范围重叠或共用构建、测试、锁文件、快照等产物时协调并串行处理。',
      '委派了检索就不要自己再跑同一搜索，等结果；子智能体只回结论，需要你转述给用户。',
      '代码修改的委派结果以实际改动和验证记录为准；证据缺失、结论冲突或关键风险未覆盖时补充检查，不机械重跑已通过的同一检查。',
      `独立并行的子任务可用 \`subagent\` 在同一条回复里并行发起：每个子智能体在独立会话里求解，结论直接随工具结果回传。${routes.teammate === 'unavailable' ? '' : '\`spawn_teammate\` 只用于真正需要共享任务板与成员消息往来的长时协作（仅 Lead），队友结论需通过任务板或消息收集。'}`,
      '计划模式开启期间只委派只读调研，并在任务里明确只读约束。',
    ]
    const catalog = options.availableChildModels === undefined ? undefined : await options.availableChildModels()
    if (catalog !== undefined && catalog.total >= 2) {
      const listed = catalog.models.map(model => `\`${model.provider}/${model.modelId}\``)
      const summary = catalog.total > catalog.models.length
        ? `${listed.join('、')} 等 ${catalog.total} 个`
        : listed.join('、')
      lines.push(`可选模型：${summary}。轻量任务（检索、清单、简单分析）可给 ${routes.teammate === 'unavailable' ? 'subagent' : 'subagent/spawn_teammate'} 指定更快的模型，provider 与 modelId 必须成对；缺省继承当前会话模型。`)
    }
    const call = toolRouteInstruction(SUBAGENT_TOOL, routes.subagent, '{ task: "...", agent_type: "Explore", label: "..." }', 'zh')
    if (call) lines.push(`委派示例：${call}。`)
    return lines.join('\n')
  })

  return defineExtension({
    name: 'subagent',
    tools: [
      defineTool({
        name: SUBAGENT_TOOL,
        description: [
          '把自包含的任务委派给子智能体；它是一个在独立会话中工作的 Agent，',
          '返回任务结果，不返回中间过程。',
          '它继承本会话的 Agent 配置（工具、模型和工作目录），但不继承消息，',
          '因此任务说明必须自包含：写明任务、范围、适用的约束与授权、',
          '验收标准、是否只读或允许写入，以及应返回的结果证据。',
          '对返回格式有要求时明确写出。子智能体共享工作目录；分配',
          '互不重叠的写入路径，并要求保留其分配范围外的改动。',
          'agent_type 选择内置档案：general-purpose（默认，继承本会话的工作工具，',
          '但不含计划、用户提问、目标或委派工具）或',
          'Explore（只读检索，适合只需结论的大范围代码库搜索；在任务中写明',
          '检索广度 "medium" 或 "very thorough"）。',
          'model 可按 {provider, modelId} 指定子智能体模型，并接受目录和',
          '允许列表校验；省略时继承本会话模型。',
          '适用于需要阅读大量文件才能回答的问题（你保留结论，无须保留文件转储），或',
          '值得独立执行的工作。已知文件或符号的单一事实查询不要委派，',
          '直接搜索即可。搜索一经委派，不要自己重复执行，等待其结果。',
          '本调用会等待子智能体完成，并将最终答复作为工具结果返回；',
          '把相关结果转述给用户。',
          '将 run_in_background 设为 true 可后台启动：调用立即返回，你继续工作，',
          '子智能体结果稍后以跟进消息（结算通知）送达；不要为此等待，也不要',
          '仅为等待它而结束当前回合。',
        ].join(' '),
        parameters: Type.Object({
          task: Type.String(),
          label: Type.Optional(Type.String()),
          agent_type: Type.Optional(Type.Union([Type.Literal('general-purpose'), Type.Literal('Explore')])),
          model: Type.Optional(Type.Object({
            provider: Type.String(),
            modelId: Type.String(),
          })),
          run_in_background: Type.Optional(Type.Boolean()),
        }),
        // 崩溃后的重跑必须复用已创建的子会话，而不是重复委派。
        replay: 'safe',
        /**
         * 功能：执行子代理委派（前台等待或后台启动）。
         * 输入校验：task/label 经 normalize；子会话按 taskId 查找已存在者以幂等复用。
         * 内部逻辑：扫描与创建分两次 commit（创建事务内读表会抛 ReadAfterWrite）；
         * agent 变更在创建 commit 之前构建（需要读父 agent）；创建时经 configure 应用
         * 变更并写入 Subagents 记录；随后继承计划模式约束。后台模式提交后即返回 activation，
         * 结算交由 runtime 后台通道；前台模式以稳定 request id 提交（崩溃后重提幂等）并
         * 等待结算，答复文本为空或无答复时走 fail（错误进 diagnostic 通道）。
         */
        execute: async (args, api, context): Promise<ToolExecutionResult<SubagentToolDetails>> => {
          const task = normalizeTask(args.task)
          const label = normalizeLabel(args.label, task)
          const parentId = api.conversationId
          const background = args.run_in_background === true
          // 扫描与创建是分开的两个 commit：创建 commit 内读表会抛 ReadAfterWrite
          // （docs/history/families.md A6）。
          const existing = await api.commit(async (tx) => {
            const page = await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
            return page.items[0]?.id
          }, context)
          // 在创建 commit 之前构建：agent 变更要读父 agent 的解析结果，commit 无法承载
          // 这种表读取。重放时原样复用其子会话。
          const agent = existing === undefined
            ? await childAgentChange(args.agent_type, args.model, options, api, context)
            : undefined
          const childId = existing ?? await api.commit(async (tx) => {
            const record = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
            // `tx.createConversation` 不接受 agent 选项；`configure` 在本 commit 内对复制的
            // `pi.agent` 文档应用同一个 `AgentChange`。
            if (agent !== undefined) await configure(tx, record.id, agent)
            await options.prepareChild(tx, record.id, parentId, label)
            const doc = await tx.doc(Subagents, record.id)
            doc.record = { label, createdAt: Date.now(), profile: profileByName(args.agent_type).name }
            return record.id
          }, context)
          await api.details({
            conversationId: String(childId),
            status: 'running',
            label,
            ...(background ? { background: true } : {}),
          }, context)

          const child = await api.conversation(childId, context)
          if (child === undefined) {
            return fail(api, context, `child conversation ${String(childId)} is no longer available`, { conversationId: String(childId), status: 'failed', label })
          }
          // 稳定的结算请求 id 让崩溃或重启后的结算注入保持幂等。
          const settleRequestId = `subagent-settle:${String(api.taskId)}`
          await api.commit(async (tx) => {
            await inheritPlanConstraint(tx, childId, parentId)
            if (background) {
              const doc = await tx.doc(Subagents, childId)
              if (doc.record) doc.record.delegation = { background: true, parent: parentId, requestId: settleRequestId }
            }
          }, context)
          if (background) {
            try {
              // 与前台请求 id 区分开：另一种模式下重放的调用不能搭乘对方的提交。返回的
              // 句柄绑定本次调用并随调用消亡，因此结算改由 runtime 在后台观察子会话。
              await child.submit({
                type: 'input',
                content: task,
                requestId: `${SUBAGENT_TOOL}:${String(api.taskId)}:bg`,
                whenBusy: 'followUp',
              }, context)
            } catch (error) {
              // 已取消的父调用以 cancelled 结束，而不是以"启动失败"结束。
              if (context.abortSignal?.aborted === true) throw error
              return fail(api, context, `the subagent run could not be started: ${describe(error)}`, { conversationId: String(childId), status: 'failed', label })
            }
            // 调用到此结束：结算活在 runtime 的后台上下文里并以跟进消息回报，因此绝不
            // 能再碰本次调用的 `api.*`。
            options.settleWhenAnswered?.({ parent: parentId, child: childId, label, settleRequestId })
            return {
              output: [{
                type: 'text',
                text: [
                  `子智能体“${label}”已在后台运行（会话 ${String(childId)}）。`,
                  '完成后，结果会作为跟进消息送达；期间继续其他有用的工作，',
                  '不要等待，也不要仅为等待它而结束当前回合。',
                ].join(' '),
              }],
            }
          }
          let settled: SettledSubmissionRecord
          try {
            // 稳定的请求 ID 让崩溃后的重提保持幂等。
            const submission = await child.submit({
              type: 'input',
              content: task,
              requestId: `${SUBAGENT_TOOL}:${String(api.taskId)}`,
              whenBusy: 'followUp',
            }, context)
            settled = await submission.wait(context)
          } catch (error) {
            // 已取消的父调用以 cancelled 结束，而不是以"已答复的委派"结束。
            if (context.abortSignal?.aborted === true) throw error
            return fail(api, context, `the subagent run could not be followed: ${describe(error)}`, { conversationId: String(childId), status: 'failed', label })
          }
          const answerId = settled.status === 'done' ? settled.answer : undefined
          if (answerId === undefined) {
            return fail(api, context, `the subagent stopped without an answer: ${unansweredReason(settled)}`, { conversationId: String(childId), status: 'failed', label })
          }
          const entry = await api.commit(async (tx) => tx.entry(answerId), context)
          const text = answerText(entry?.model)
          if (text === '') {
            return fail(api, context, 'the subagent finished without any assistant text', { conversationId: String(childId), status: 'failed', label })
          }
          return {
            output: [{ type: 'text', text }],
            details: { conversationId: String(childId), status: 'completed', label },
          }
        },
      }),
    ],
    sections: [delegationSection],
  })
}

/**
 * 功能：上报一次委派失败。模型仍需要一个可行动的工具结果，而失败原因应走 diagnostic
 * 通道：DSH 把 `SubagentResult.output` 与 `diagnostic` 分开，正是为了让展示永远不把
 * 子会话的答复与"为什么没有答复"混在一起。
 * 内部逻辑：先写 error 级诊断，再更新 details（status: failed），最后返回 isError 的
 * 结果（output 为固定提示文本）。
 */
async function fail(
  api: ToolExecutionApi<SubagentToolDetails>,
  context: Context,
  reason: string,
  details: SubagentToolDetails,
): Promise<ToolExecutionResult<SubagentToolDetails>> {
  api.diagnostic({ severity: 'error', message: `Subagent delegation failed: ${reason}` })
  await api.details(details, context)
  return { output: [{ type: 'text', text: 'The subagent did not return an answer.' }], isError: true, details }
}

/** 把任意错误压成一行描述：取 message、折叠空白、截断 300 字符；空则报 unknown error。 */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
}
