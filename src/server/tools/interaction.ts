import { defineDoc, defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption } from '../../shared/types.ts'
import { escalationReasons, type DecisionEscalation } from '../../shared/decision-inbox.ts'

/** 单次提问调用允许的最大问题数。 */
export const MAX_QUESTIONS = 8
/** 单个问题允许的最大选项数。 */
export const MAX_OPTIONS = 12

/** 一次提问调用（已答复或仍待答）的持久化记录，压缩（compaction）不会丢失。 */
export type StoredInteraction = {
  questions: AskUserQuestionItem[]
  askedAt: number
  /** `cancelled` 表示用户整体放弃作答（对应 DSH 的 ASK_CANCELLED）。 */
  status: 'pending' | 'answered' | 'cancelled'
  answers?: AskUserQuestionAnswerItem[]
  answeredAt?: number
  cancelledAt?: number
  escalation?: DecisionEscalation
}

/** 会话作用域的提问表，键为工具调用 id——它同时也是答复的幂等键。 */
export type InteractionsState = { [callId: string]: StoredInteraction }

/**
 * 功能：会话作用域的提问/答复文档。
 * 内部逻辑：答复的生命周期长于发出提问的 assistant 条目（压缩会把后者移出活跃视图），
 * 因此请求与其结算结果存在会话文档里，而不是依赖工具调用参数。history 取 latest，
 * 不做 fork 与 checkpoint。
 */
export const Interactions = defineDoc<InteractionsState>({
  kind: 'pi-web.interactions',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({}),
})

/** 问题对象允许的字段白名单，多余字段一律拒绝。 */
const QUESTION_KEYS = new Set(['id', 'header', 'question', 'options', 'multiSelect'])
/** 选项对象允许的字段白名单。 */
const OPTION_KEYS = new Set(['label', 'description'])

/**
 * 功能：校验对象的所有键都在白名单内，出现未知字段即抛错。
 * @param value 待校验对象。
 * @param allowed 允许的字段名集合。
 * @param label 报错时用于定位的名称前缀。
 */
function assertKnownKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has an unknown field: ${key}`)
  }
}

/**
 * 功能：校验字符串非空且不超过上限，返回去首尾空白后的值。
 * @param value 待校验值（必须为字符串）。
 * @param label 报错时用于定位的名称。
 * @param max 允许的最大字符数。
 * @returns trim 后的字符串。
 */
function nonEmpty(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters.`)
  }
  return value.trim()
}

/**
 * 功能：像严格 schema 一样校验模型传入的提问参数，返回脱附（新建）的问题列表。
 * 输入校验：问题数 1–MAX_QUESTIONS；未知字段拒绝；id/问题文本/header 非空且限长；
 * id 不重复；options 数 1–MAX_OPTIONS、label 唯一、description 限长；multiSelect 须为布尔。
 * @param value 模型传入的原始问题数组。
 * @returns 校验并规范化后的问题列表（可选字段仅在合法时保留）。
 */
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

/** normalizeQuestions 的输入形状（宽松类型，字段合法性由其运行时校验）。 */
type AskUserQuestionInput = {
  id: string
  header?: string
  question: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/** 单个问题的 JSON schema：id、问题文本必填，header/options/multiSelect 可选。 */
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

const ESCALATION_PARAMETER = Type.Object({
  reason: Type.Union([
    Type.Literal('requirement_ambiguity'),
    Type.Literal('high_impact'),
    Type.Literal('scope_conflict'),
    Type.Literal('cannot_verify'),
  ]),
  why: Type.String({ minLength: 1, maxLength: 2_000 }),
  evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 12 })),
}, { additionalProperties: false })

function normalizeEscalation(input: DecisionEscalation): DecisionEscalation {
  if (!escalationReasons.includes(input.reason)) throw new Error('Invalid escalation reason.')
  const why = nonEmpty(input.why, 'Escalation reason', 2_000)
  const evidence = input.evidence?.map(value => nonEmpty(value, 'Evidence', 400))
  return { reason: input.reason, why, ...(evidence?.length ? { evidence } : {}) }
}

/**
 * 功能：interactions 工具扩展——DSH 的 ask_user_question 以"计时/待答"形式落地：调用立即
 * 结算并返回提示，问题存入 `pi-web.interactions`，答复稍后以 steer 用户消息送达。
 * 内部逻辑：工具内绝不阻塞等待——一旦阻塞，中止（abort）也会被卷入等待；本扩展只贡献
 * `ask_user_question` 一个工具，不贡献 section。
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
        '工作台裁决请提供 escalation，说明为什么不能安全地沿用默认值，以及已经检查的证据。',
      ].join(' '),
      parameters: Type.Object({
        questions: Type.Array(QUESTION_PARAMETER, { minItems: 1, maxItems: MAX_QUESTIONS }),
        escalation: Type.Optional(ESCALATION_PARAMETER),
      }),
      /**
       * 功能：提交问题集合并立即结束调用（不等待答复）。
       * 输入校验：经 normalizeQuestions 做严格字段/长度/去重校验。
       * 内部逻辑：以 api.callId 为键把 pending 记录写入 Interactions 会话文档；输出提示
       * 模型不要在本轮等待，继续不依赖答复的工作或结束本轮。
       */
      execute: async (args, api, context) => {
        const questions = normalizeQuestions(args.questions)
        const escalation = args.escalation ? normalizeEscalation(args.escalation) : undefined
        await api.commit(async (tx) => {
          const doc = await tx.doc(Interactions, api.conversationId)
          if (doc[api.callId] === undefined) {
            doc[api.callId] = { questions, askedAt: Date.now(), status: 'pending', ...(escalation ? { escalation } : {}) }
          }
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
