import { defineDoc, defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption } from '../shared/types.ts'

export const MAX_QUESTIONS = 8
export const MAX_OPTIONS = 12

/** One answered (or still pending) question call, persisted so compaction cannot lose it. */
export type StoredInteraction = {
  questions: AskUserQuestionItem[]
  askedAt: number
  /** `cancelled` = the user dismissed the whole set without answering (DSH's ASK_CANCELLED). */
  status: 'pending' | 'answered' | 'cancelled'
  answers?: AskUserQuestionAnswerItem[]
  answeredAt?: number
  cancelledAt?: number
}

/** Conversation-scoped request table keyed by the tool call id, which is also the answer idempotency key. */
export type InteractionsState = { [callId: string]: StoredInteraction }

/**
 * Answers outlive the assistant entries that asked (compaction removes those from the active view),
 * so the request and its settlement live in a conversation document instead of tool-call arguments.
 */
export const Interactions = defineDoc<InteractionsState>({
  kind: 'pi-web.interactions',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

const QUESTION_KEYS = new Set(['id', 'header', 'question', 'options', 'multiSelect'])
const OPTION_KEYS = new Set(['label', 'description'])

function assertKnownKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has an unknown field: ${key}`)
  }
}

function nonEmpty(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters.`)
  }
  return value.trim()
}

/** Validate the model's arguments the way a strict schema would, then return a detached question list. */
export function normalizeQuestions(value: readonly AskUserQuestionInput[]): AskUserQuestionItem[] {
  if (value.length < 1 || value.length > MAX_QUESTIONS) {
    throw new Error(`A question request holds between 1 and ${MAX_QUESTIONS} questions.`)
  }
  const ids = new Set<string>()
  return value.map((input) => {
    assertKnownKeys(input, QUESTION_KEYS, 'Question')
    const id = nonEmpty(input.id, 'Question id', 160)
    if (ids.has(id)) throw new Error(`Duplicate question id: ${id}`)
    ids.add(id)
    const question = nonEmpty(input.question, `Question "${id}"`, 2_000)
    const header = input.header === undefined ? undefined : nonEmpty(input.header, `Question "${id}" header`, 200)
    let options: AskUserQuestionOption[] | undefined
    if (input.options !== undefined) {
      if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > MAX_OPTIONS) {
        throw new Error(`Question "${id}" options must hold between 1 and ${MAX_OPTIONS} entries.`)
      }
      const labels = new Set<string>()
      options = input.options.map((option) => {
        assertKnownKeys(option, OPTION_KEYS, `Question "${id}" option`)
        const label = nonEmpty(option.label, `Option label for question "${id}"`, 200)
        if (labels.has(label)) throw new Error(`Duplicate option "${label}" for question "${id}"`)
        labels.add(label)
        const description = option.description === undefined ? undefined : nonEmpty(option.description, `Option "${label}" description`, 1_000)
        return { label, ...(description ? { description } : {}) }
      })
    }
    if (input.multiSelect !== undefined && typeof input.multiSelect !== 'boolean') {
      throw new Error(`Question "${id}" multiSelect must be a boolean.`)
    }
    return { id, question, ...(header ? { header } : {}), ...(options ? { options } : {}), ...(input.multiSelect ? { multiSelect: true } : {}) }
  })
}

type AskUserQuestionInput = {
  id: string
  header?: string
  question: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

const QUESTION_PARAMETER = Type.Object({
  id: Type.String(),
  header: Type.Optional(Type.String()),
  question: Type.String(),
  options: Type.Optional(Type.Array(Type.Object({
    label: Type.String(),
    description: Type.Optional(Type.String()),
  }))),
  multiSelect: Type.Optional(Type.Boolean()),
})

/**
 * DSH's ask_user_question, in its timed/pending form: the call settles immediately with a notice,
 * the question lives in `pi-web.interactions`, and the answer arrives later as a steer user message.
 * Blocking inside the tool would make abort join the wait, so this slice never blocks.
 */
export const InteractionTools: Extension = defineExtension({
  name: 'interactions',
  tools: [
    defineTool({
      name: 'ask_user_question',
      description: [
        'Ask the user up to eight questions (usually one to three) and end this turn without waiting for the answer.',
        'Use this when a user-owned choice, missing external reference, or material ambiguity blocks progress; do not use it for facts you can inspect in the workspace.',
        'Ask brief, direct, self-contained questions in user-facing terms; assume the user does not know background work or internal names.',
        'Each question has a stable id, the question text, optional options (label plus optional description), and multiSelect.',
        'If you recommend one option, put it first and append "(Recommended)" to its label.',
        'The answers arrive as a follow-up user message on a later turn; continue with independent work or wrap up now.',
        'Pending is not permission: do not perform the action a pending question depends on; a timeout or unanswered question is not consent.',
        'Do not repeat the same questions while they are pending.',
      ].join(' '),
      parameters: Type.Object({
        questions: Type.Array(QUESTION_PARAMETER, { minItems: 1, maxItems: MAX_QUESTIONS }),
      }),
      execute: async (args, api, context) => {
        const questions = normalizeQuestions(args.questions)
        await api.commit(async (tx) => {
          const doc = await tx.doc(Interactions, api.conversationId)
          doc[api.callId] = { questions, askedAt: Date.now(), status: 'pending' }
        }, context)
        return {
          output: [{
            type: 'text' as const,
            text: 'The questions are now pending with the user. Their answers will arrive as a follow-up user message. Do not wait for them in this turn: continue with work that does not depend on the answers, or end your turn now.',
          }],
          details: { requestKey: api.callId, questions, status: 'pending' as const },
        }
      },
    }),
  ],
})
