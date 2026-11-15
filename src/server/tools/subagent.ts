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

/** Model-facing tool name; also the read-only whitelist entry and the tool row's label. */
export const SUBAGENT_TOOL = 'subagent'

/**
 * Built-in delegation profiles (ZCode parity: `general-purpose` and `Explore`). `general-purpose`
 * inherits the parent's working tools under the child policy; `Explore` narrows them to read-only search.
 */
export { Subagents } from '../conversation/subagent-policy.ts'
export type { SubagentProfile, SubagentIdentity, SubagentDelegation } from '../conversation/subagent-policy.ts'

export const MAX_SUBAGENT_TASK_CHARS = 20_000
export const MAX_SUBAGENT_LABEL_CHARS = 60

/** How many model picks the delegation section lists before it truncates to 「等 N 个」. */
export const SUBAGENT_MODEL_LIST_LIMIT = 12

/**
 * Details the UI reads off the tool call, so a subagent row can attach to its child conversation
 * while the call is still running (DSH returns an activation the same way).
 */
export type SubagentToolDetails = {
  conversationId: string
  status: 'running' | 'completed' | 'failed'
  label: string
  /** Set while a background delegation is still running; its result arrives as a settlement message. */
  background?: boolean
}

/** One delegation's terminal state, as `subagent()` reports it back to the model. */
type DelegationOutcome =
  | { kind: 'answered'; text: string }
  | { kind: 'failed'; reason: string }

function normalizeTask(value: unknown): string {
  const task = typeof value === 'string' ? value.trim() : ''
  if (task === '') throw new Error('The subagent task must be a non-empty string.')
  if (task.length > MAX_SUBAGENT_TASK_CHARS) {
    throw new Error(`The subagent task is limited to ${MAX_SUBAGENT_TASK_CHARS} characters.`)
  }
  return task
}

/** DSH requires a short display description; here it is optional and falls back to the task's first line. */
function normalizeLabel(value: unknown, task: string): string {
  const explicit = typeof value === 'string' ? value.trim() : ''
  const label = explicit === '' ? (task.split('\n').find(line => line.trim() !== '') ?? task).trim() : explicit
  return label.length > MAX_SUBAGENT_LABEL_CHARS ? `${label.slice(0, MAX_SUBAGENT_LABEL_CHARS - 1)}…` : label
}

/** The child's final assistant text: its last non-empty assistant message, as DSH's `SubagentResult.output`. */
export function answerText(messages: readonly Message[] | undefined): string {
  for (const message of [...messages ?? []].reverse()) {
    if (message.role !== 'assistant') continue
    const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim()
    if (text !== '') return text
  }
  return ''
}

/** Why one settled submission carried no answer: the harness reason plus any recorded detail. */
export function unansweredReason(settled: SettledSubmissionRecord): string {
  const detail = settled.status === 'unanswered' && settled.detail !== undefined ? ` (${JSON.stringify(settled.detail)})` : ''
  return settled.status === 'unanswered' ? `${settled.reason}${detail}` : 'the run left no answer entry'
}

/**
 * Everything the runtime's settlement channel needs to report one background delegation. The
 * settlement escapes this tool call's lifetime (the call already returned its activation), so it
 * runs on the runtime's background context and never touches this call's `api.*` again — handles
 * derived from `api` stay bound to the invocation and die with it, so the settlement re-resolves
 * everything from the runtime by id.
 */
export type SubagentSettlementInput = {
  /** The conversation that delegated the work and receives the settlement message. */
  parent: ConversationId
  /** The child conversation whose answer settles. */
  child: ConversationId
  label: string
  /** The request id the settlement message is injected under (`subagent-settle:<toolTaskId>`). */
  settleRequestId: string
}

/**
 * The delegation section's model line: up to `SUBAGENT_MODEL_LIST_LIMIT` picks plus the total the
 * allowlist and configured credentials actually cover, so a long list can end with 「等 N 个」.
 */
export type ChildModelList = { models: ChildModelRef[]; total: number }

/**
 * Register DSH's `subagent` tool as a foreground delegation. One call creates one task-owned child
 * conversation, waits for its answer, and returns that answer on the `output` channel; a failure
 * travels on the diagnostic channel so the answer body stays clean (DSH keeps `output` and
 * `diagnostic` separate in `SubagentResult` for the same reason).
 *
 * `prepareChild` lets the runtime stamp the child's conversation metadata (title, workspace, access
 * mode) inside the creation commit, where only document access is available. `resolveChildModel`
 * validates an explicit model pick; `availableChildModels` feeds the delegation section's model line.
 * `settleWhenAnswered` is the runtime's background settlement channel: a background delegation hands
 * its child submission to it instead of waiting.
 */
export type SubagentToolOptions = {
  prepareChild: (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string) => Promise<void>
  /** Validate and clamp an explicit child model pick against the catalog and the allowlist. */
  resolveChildModel?: ChildModelResolver
  /** Allowlisted catalog models whose provider holds credentials, for the delegation section's model line. */
  availableChildModels?: () => ChildModelList | Promise<ChildModelList>
  /** Deliver one background delegation's result to its parent once the child's submission settles. */
  settleWhenAnswered?: (input: SubagentSettlementInput) => void
}

/**
 * The agent change one new child applies on top of the copied parent composition: the profile's
 * instructions always, the read-only tool intersection for `Explore`, and the validated model pick.
 * A replayed call reuses its child, so it never rebuilds or reapplies this change.
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
  // In codemode-only the directly offered tools do not include the enabled nested tools.
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

export function createSubagentTools(options: SubagentToolOptions): Extension {
  /** ZCode's delegation guidance: when to delegate, which built-in type, and which model. */
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
        // A rerun after a crash must reuse the child it already created instead of delegating twice.
        replay: 'safe',
        execute: async (args, api, context): Promise<ToolExecutionResult<SubagentToolDetails>> => {
          const task = normalizeTask(args.task)
          const label = normalizeLabel(args.label, task)
          const parentId = api.conversationId
          const background = args.run_in_background === true
          // The scan and the creation are separate commits: a table read inside the creating commit
          // throws ReadAfterWrite (docs/history/families.md A6).
          const existing = await api.commit(async (tx) => {
            const page = await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
            return page.items[0]?.id
          }, context)
          // Built before the creating commit: the agent change reads the parent's resolved agent,
          // which is a table read the commit cannot host. A replay reuses its child unchanged.
          const agent = existing === undefined
            ? await childAgentChange(args.agent_type, args.model, options, api, context)
            : undefined
          const childId = existing ?? await api.commit(async (tx) => {
            const record = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
            // `tx.createConversation` takes no agent options; `configure` applies the same
            // `AgentChange` to the copied `pi.agent` document inside this commit.
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
          // The stable settle request id makes the settlement injection after a crash or restart idempotent.
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
              // Distinct from the foreground request id: a call replayed under the other mode must
              // not ride on the other mode's submission. The returned handle is invocation-bound and
              // dies with this call, so the settlement watches the child from the runtime instead.
              await child.submit({
                type: 'input',
                content: task,
                requestId: `${SUBAGENT_TOOL}:${String(api.taskId)}:bg`,
                whenBusy: 'followUp',
              }, context)
            } catch (error) {
              // A cancelled parent ends this call as cancelled, not as a failed launch.
              if (context.abortSignal?.aborted === true) throw error
              return fail(api, context, `the subagent run could not be started: ${describe(error)}`, { conversationId: String(childId), status: 'failed', label })
            }
            // The call ends here: the settlement lives on the runtime's background context and reports
            // back as a follow-up message, so it must not touch this call's `api.*` again.
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
            // The stable request ID makes the resubmission after a crash idempotent.
            const submission = await child.submit({
              type: 'input',
              content: task,
              requestId: `${SUBAGENT_TOOL}:${String(api.taskId)}`,
              whenBusy: 'followUp',
            }, context)
            settled = await submission.wait(context)
          } catch (error) {
            // A cancelled parent ends this call as cancelled, not as an answered delegation.
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
 * Report a delegation failure. The model still needs a tool result it can act on, while the reason
 * belongs on the diagnostic channel: DSH keeps `SubagentResult.output` and `diagnostic` apart so a
 * presentation never mixes the child's answer with the account of why it has none.
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

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error'
}
