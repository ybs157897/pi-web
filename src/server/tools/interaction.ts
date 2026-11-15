import { defineDoc, defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption } from '../../shared/types.ts'

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
  fork: 'initial', checkpointWhen: () => false,
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
        '向用户提出最多八个问题（通常一到三个），结束本轮，不等待答复。',
        '当必须由用户决定的选择、缺失的外部引用或重要歧义阻碍推进时使用；不要用来询问可自行检查工作区确认的事实。',
        '问题要简短、直接、自包含，使用用户能理解的表达；不要假设用户了解后台工作或内部名称。',
        '每个问题包含稳定的 id、问题文本、可选的 options（label 和可选的 description）以及 multiSelect。',
        '若推荐某个选项，将其放在首位，并在 label 后加“（推荐）”。',
        '答复会在后续回合作为用户跟进消息送达；当前可继续独立工作，或结束本轮。',
        '等待答复不代表已获许可：不得执行依赖待答问题的操作；超时或未答复不构成同意。',
        '问题待答期间，不要重复提问。',
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
            text: '问题已提交给用户，正在等待答复。答复会作为用户跟进消息送达。不要在本轮等待：继续不依赖答复的工作，或结束本轮。',
          }],
          details: { requestKey: api.callId, questions, status: 'pending' as const },
        }
      },
    }),
  ],
})
