import { configure, defineDoc, defineExtension, defineTool, section, type AgentChange, type Extension } from '@earendil-works/pi-durable'
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
 * keeps the parent's tool set; `Explore` narrows it to read-only search. Defined in agents/builtins.ts.
 */
export type SubagentProfile = 'general-purpose' | 'Explore'

export const MAX_SUBAGENT_TASK_CHARS = 20_000
export const MAX_SUBAGENT_LABEL_CHARS = 60

/** How many model picks the delegation section lists before it truncates to 「等 N 个」. */
export const SUBAGENT_MODEL_LIST_LIMIT = 12

/**
 * How a background delegation reports back to its parent: the runtime's settlement channel injects
 * the child's result as a follow-up message under `requestId`, and `deliveredAt` marks that
 * injection so a restart's reconciliation does not resend it. Optional on the record, so children
 * written before background delegation existed read unchanged and the document version stays put.
 */
export type SubagentDelegation = {
  background: true
  parent: ConversationId
  requestId: string
  deliveredAt?: number
}

/** One delegation as the parent recorded on the child conversation. */
export type SubagentIdentity = {
  label: string
  createdAt: number
  profile?: SubagentProfile
  delegation?: SubagentDelegation
}

/**
 * DSH stamps every child session with a `subagent/descriptor` event carrying the delegation label.
 * Pi's equivalent is a conversation document on the child: it survives compaction, and it stays
 * readable after the parent's tool call leaves the active view.
 */
export const Subagents = defineDoc<{ record: SubagentIdentity | null }>({
  kind: 'pi-web.subagent',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ record: null }),
})

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
  const tools = readonlyTools !== undefined && parent !== undefined
    ? parent.tools.filter(tool => readonlyTools.includes(tool.name))
    : undefined
  if (readonlyTools !== undefined && !(tools ?? []).some(tool => tool.name === 'read')) {
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
    const lines = [
      '内置子智能体类型（subagent 的 agent_type）：',
      `- general-purpose：${profileByName('general-purpose').summary}`,
      `- Explore：${profileByName('Explore').summary}`,
      '何时委派：调研、检索、盘点类子任务默认委派——预计要读超过三个文件、或范围不确定时，先派 Explore 再综合它的结论，不要自己逐个翻文件；互不依赖的工作值得并行委派。只有已知路径/符号的单点事实才直接查。',
      '委派了检索就不要自己再跑同一搜索，等结果；子智能体只回结论，需要你转述给用户。',
      '效率：互不依赖的委派放在同一条回复里一起发起；短平快的独立任务用 `subagent`，需要长时间后台运行或多成员协调用 `spawn_teammate` 开团队（仅 Lead）。',
      '计划模式开启期间只委派只读调研，并在任务里明确只读约束。',
    ]
    const catalog = options.availableChildModels === undefined ? undefined : await options.availableChildModels()
    if (catalog !== undefined && catalog.total >= 2) {
      const listed = catalog.models.map(model => `\`${model.provider}/${model.modelId}\``)
      const summary = catalog.total > catalog.models.length
        ? `${listed.join('、')} 等 ${catalog.total} 个`
        : listed.join('、')
      lines.push(`可选模型：${summary}。轻量任务（检索、清单、简单分析）可给 subagent/spawn_teammate 指定更快的模型，provider 与 modelId 必须成对；缺省继承当前会话模型。`)
    }
    const call = toolRouteInstruction(SUBAGENT_TOOL, routes.subagent, '{ task: "...", agent_type: "Explore", label: "..." }')
    if (call) lines.push(`委达示例：${call}`)
    return lines.join('\n')
  })

  return defineExtension({
    name: 'subagent',
    tools: [
      defineTool({
        name: SUBAGENT_TOOL,
        description: [
          'Delegate a self-contained task to a subagent: a separate agent that works in its own conversation',
          'and returns its result, not its intermediate steps.',
          'It inherits this conversation\'s agent configuration — tools, model, working directory — but not its',
          'messages, so make the task self-contained: state the task, scope, applicable constraints and authorization,',
          'acceptance criteria, and the result evidence to return. The child shares the working directory; assign',
          'disjoint write paths and require it to preserve changes outside its assigned scope.',
          'agent_type picks a built-in profile — general-purpose (default, inherits this conversation\'s tools) or',
          'Explore (read-only search: broad codebase sweeps where you only need the conclusion; state the search',
          'breadth "medium" or "very thorough" in the task).',
          'model optionally selects the child\'s model as {provider, modelId}, validated against the catalog and',
          'allowlist; omit to inherit this conversation\'s model.',
          'Use when: answering means reading across many files (you keep the conclusion, not the file dumps), or',
          'independent work worth running separately. Do NOT delegate single-fact lookups where you already know',
          'the file/symbol — search directly. Once you delegate a search, do not also run it yourself; wait for the result.',
          'This call waits for the subagent to finish and returns its final answer as the tool result;',
          'relay what matters to the user.',
          'Set run_in_background to true to launch without waiting: the call returns immediately, you keep working, and',
          'the subagent\'s result arrives later as a follow-up message (a settlement notice); do not wait for it or end',
          'your turn just to wait.',
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
          // throws ReadAfterWrite (docs/families.md A6).
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
                  `Subagent "${label}" is now running in the background (conversation ${String(childId)}).`,
                  'Its result will arrive as a follow-up message when it finishes; continue with other useful work in',
                  'the meantime — do not wait for it, and do not end your turn just to wait for it.',
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
