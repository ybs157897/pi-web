import { defineDoc, defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable'
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

/** Model-facing tool name; also the read-only whitelist entry and the tool row's label. */
export const SUBAGENT_TOOL = 'subagent'

export const MAX_SUBAGENT_TASK_CHARS = 20_000
export const MAX_SUBAGENT_LABEL_CHARS = 60

/** One delegation as the parent recorded it on the child conversation. */
export type SubagentIdentity = { label: string; createdAt: number }

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
function answerText(messages: readonly Message[] | undefined): string {
  for (const message of [...messages ?? []].reverse()) {
    if (message.role !== 'assistant') continue
    const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim()
    if (text !== '') return text
  }
  return ''
}

/** Why one settled submission carried no answer: the harness reason plus any recorded detail. */
function unansweredReason(settled: SettledSubmissionRecord): string {
  const detail = settled.status === 'unanswered' && settled.detail !== undefined ? ` (${JSON.stringify(settled.detail)})` : ''
  return settled.status === 'unanswered' ? `${settled.reason}${detail}` : 'the run left no answer entry'
}

/**
 * Register DSH's `subagent` tool as a foreground delegation. One call creates one task-owned child
 * conversation, waits for its answer, and returns that answer on the `output` channel; a failure
 * travels on the diagnostic channel so the answer body stays clean (DSH keeps `output` and
 * `diagnostic` separate in `SubagentResult` for the same reason).
 *
 * `prepareChild` lets the runtime stamp the child's conversation metadata (title, workspace, access
 * mode) inside the creation commit, where only document access is available.
 */
export function createSubagentTools(options: {
  prepareChild: (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string) => Promise<void>
}): Extension {
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
          'This call waits for the subagent to finish and returns its final answer as the tool result;',
          'use it to offload focused, independent work so it does not consume this conversation\'s context.',
        ].join(' '),
        parameters: Type.Object({
          task: Type.String(),
          label: Type.Optional(Type.String()),
        }),
        // A rerun after a crash must reuse the child it already created instead of delegating twice.
        replay: 'safe',
        execute: async (args, api, context): Promise<ToolExecutionResult<SubagentToolDetails>> => {
          const task = normalizeTask(args.task)
          const label = normalizeLabel(args.label, task)
          const parentId = api.conversationId
          // The scan and the creation are separate commits: a table read inside the creating commit
          // throws ReadAfterWrite (docs/families.md A6).
          const existing = await api.commit(async (tx) => {
            const page = await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
            return page.items[0]?.id
          }, context)
          const childId = existing ?? await api.commit(async (tx) => {
            const record = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })
            await options.prepareChild(tx, record.id, parentId, label)
            const doc = await tx.doc(Subagents, record.id)
            doc.record = { label, createdAt: Date.now() }
            return record.id
          }, context)
          await api.details({ conversationId: String(childId), status: 'running', label }, context)

          const child = await api.conversation(childId, context)
          if (child === undefined) {
            return fail(api, context, `child conversation ${String(childId)} is no longer available`, { conversationId: String(childId), status: 'failed', label })
          }
          await api.commit(tx => inheritPlanConstraint(tx, childId, parentId), context)
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
