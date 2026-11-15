import { defineDoc, defineExtension, defineTool, section, type ConversationId, type Extension, type Tx } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { AccessMode, AskUserQuestionAnswerItem } from '../../shared/types.ts'
import { Interactions } from './interaction.ts'
import { Goals } from './goal.ts'
import { resolveToolRoute, toolRouteInstruction } from '../conversation/tool-routing.ts'
import { Subagents } from '../conversation/subagent-policy.ts'

/**
 * 会话文档中的计划模式状态。Pi 在每次请求前重渲染所有 section，因此一次切换若发生在
 * 运行中途，会在下一次请求生效——这就是 DSH 的"pending"计划模式语义，无需额外状态。
 */
export type PlanState = { active: boolean; updatedAt: number }

/** 会话作用域的计划模式文档：active 标记与更新时间。 */
export const Plans = defineDoc<PlanState>({
  kind: 'pi-web.plan',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ active: false, updatedAt: 0 }),
})

/** 批准计划的按钮文案；审阅卡把它渲染为主操作。 */
export const PLAN_APPROVE_LABEL = '同意执行'
/** 只读访问模式下的批准按钮文案（语义是"确认方案"而非授权实施）。 */
export const READ_ONLY_PLAN_APPROVE_LABEL = '确认方案'
/** 计划审阅卡提交的答复 id；路由只检查所选 label。 */
export const PLAN_REVIEW_ANSWER_ID = 'plan-review'

/** 存放在 `pi-web.interactions` 里、与提问调用并列的计划审阅记录。 */
export type StoredPlanReview = {
  kind: 'plan-review'
  /** 模型提交的计划 markdown；后续修订不会改动它。 */
  detail: string
  approveLabel: string
  askedAt: number
  /** `superseded` 表示用户决定之前有更新的提交替换了本次审阅。 */
  status: 'pending' | 'answered' | 'superseded' | 'cancelled'
  /** 仅在答复后设置：true 批准计划，false 要求修改。 */
  approved?: boolean
  /** 用户想改什么，会在回复消息里回传给模型。 */
  feedback?: string
  answers?: AskUserQuestionAnswerItem[]
  answeredAt?: number
  cancelledAt?: number
}

/** 计划首行的一级标题前缀。 */
const HEADING_PREFIX = '# '

/**
 * 功能：校验模型提交的计划：非空 Markdown 且首行是一级标题。
 * 内部逻辑：为空、缺一级标题、标题内容为空分别抛出带修复指引的错误——让模型拿到
 * 可行动的工具错误，而不是拿到一张无法使用的审阅卡。
 * @param value 计划文本（预期为字符串）。
 * @returns trim 后的合法计划 markdown。
 */
export function cleanPlan(value: unknown): string {
  const plan = typeof value === 'string' ? value.trim() : ''
  if (plan === '') {
    throw new Error('计划为空。请将计划写成 Markdown 文本，并通过 plan 参数传入。')
  }
  if (!plan.startsWith(HEADING_PREFIX)) {
    throw new Error('计划必须是以一级标题开头的 Markdown：首行写作 "# <标题>"，再调用 exit_plan_mode。')
  }
  if (plan.split('\n', 1)[0]?.slice(HEADING_PREFIX.length).trim() === '') {
    throw new Error('计划标题为空：在 "# " 后写一个简短标题（例如 "# 迁移计划"）。')
  }
  return plan
}

/**
 * 功能：提取计划的第一个一级标题文本，作为会话记录里工具调用的标题。
 * @param plan 计划 markdown。
 * @returns 标题文本；没有一级标题时 undefined。
 */
export function planTitle(plan: string): string | undefined {
  const heading = plan.split('\n').map(line => line.trim()).find(line => line.startsWith(HEADING_PREFIX))
  const title = heading?.slice(HEADING_PREFIX.length).trim()
  return title ? title : undefined
}

/** 计划模式未开启时的报错文案：无可提交计划，并告诉模型如何恢复。 */
export const PLAN_INACTIVE_ERROR = [
  '本会话未开启计划模式，因此没有可提交的计划。',
  '仅使用当前请求提供的计划工具；没有可用工具时，在答复中直接给出计划。',
  '若请求已经批准，仅在当前访问权限范围内继续。',
].join(' ')

/**
 * 功能：把一条已存储的 interaction 读为计划审阅记录。
 * 内部逻辑：校验 kind、detail、approveLabel、askedAt 与状态合法性；返回的是原对象引用，
 * 让 runtime 能在文档事务内就地结算；不是审阅记录（如提问调用）时返回 undefined。
 * @param value interaction 表中的一个条目。
 * @returns 合法的 StoredPlanReview，或 undefined。
 */
export function planReviewOf(value: unknown): StoredPlanReview | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== 'plan-review' || typeof record.detail !== 'string' || typeof record.approveLabel !== 'string') return undefined
  if (typeof record.askedAt !== 'number' || !REVIEW_STATUSES.has(record.status as StoredPlanReview['status'])) return undefined
  return record as StoredPlanReview
}

/** 计划审阅记录允许的状态集合（planReviewOf 校验用）。 */
const REVIEW_STATUSES = new Set<StoredPlanReview['status']>(['pending', 'answered', 'superseded', 'cancelled'])

/**
 * 功能：把 interaction 表放宽为普通键值表。提问切片声明的表类型是"提问记录表"，计划
 * 审阅是同一张表的第二种记录形状；这里是唯一拓宽类型的位置，使后续写入保持普通文档
 * 变更操作。
 * @param table interaction 文档的原始值。
 * @returns 放宽后的键值表。
 */
export function interactionTable(table: unknown): Record<string, unknown> {
  return table as Record<string, unknown>
}

/** 认可批准的同义 label 集合，供不使用卡片按钮原文的调用方答复时识别。 */
const APPROVAL_WORDS = new Set(['同意', '同意执行', '批准', '通过', 'approve', 'approved', 'yes', 'ok', 'okay'])

/**
 * 功能：判断一个 label 是否表示批准。
 * @param value 用户选择的 label 或自定义文本。
 * @param approveLabel 审阅卡上的批准按钮原文。
 * @returns 与按钮原文一致或命中同义词集合时 true。
 */
function isApproval(value: string, approveLabel: string): boolean {
  const label = value.trim()
  return label !== '' && (label === approveLabel || APPROVAL_WORDS.has(label.toLocaleLowerCase()))
}

/** 计划审阅的决策结果：是否批准与回传给模型的反馈。 */
export type PlanReviewDecision = {
  approved: boolean
  /** 非批准的所选 label 与自定义文本，拼接后回传给模型。 */
  feedback?: string
}

/**
 * 功能：按 DSH 语义裁决计划审阅：批准按钮（或等价的"同意/yes"）即批准计划；其余任何
 * 选择都视为要求修改并保持计划模式开启。
 * 内部逻辑：任一答复选中批准语义即 approved；其余 label 与自定义文本拼接为 feedback。
 * @param review 待结算的审阅记录。
 * @param answers 用户的答复项。
 * @returns 批准布尔值与可选反馈。
 */
export function decidePlanReview(review: StoredPlanReview, answers: readonly AskUserQuestionAnswerItem[]): PlanReviewDecision {
  const approved = answers.some(answer => answer.selected.some(label => isApproval(label, review.approveLabel)))
  const notes = answers.flatMap(answer => [
    ...answer.selected.filter(label => !isApproval(label, review.approveLabel)),
    ...((answer.custom ?? '').trim() === '' ? [] : [(answer.custom ?? '').trim()]),
  ])
  return { approved, ...(notes.length ? { feedback: notes.join('; ') } : {}) }
}

/** plan-policy section：计划模式开启时模型必须遵守的工作规则；未开启时不注入任何内容。 */
const planSection = section('plan-policy', async (input, context) => {
  const [doc, identity] = await Promise.all([
    input.read.snapshot(Plans, input.conversationId, context),
    input.read.snapshot(Subagents, input.conversationId, context),
  ])
  if (doc?.active !== true) return undefined
  if (identity?.record != null) return [
    '计划模式已开启：本子会话只读调研，不实施改动。',
    '完成委派范围内的研究后，将结论、证据和未决事项交给委派方；不要向用户提问、提交计划或等待用户确认。',
  ].join('\n')
  const route = resolveToolRoute(input.agent, 'exit_plan_mode')
  const submission = toolRouteInstruction('exit_plan_mode', route, '{ plan: "<plan markdown>" }', 'zh')
  const questions = toolRouteInstruction('ask_user_question', resolveToolRoute(input.agent, 'ask_user_question'), undefined, 'zh')
  const readTools = ['read', 'glob', 'grep', 'list_files', 'search_files']
    .filter(name => resolveToolRoute(input.agent, name) !== 'unavailable')
    .map(name => `\`${name}\``)
  return [
    '计划模式已开启：本阶段只产出计划，不实施改动。',
    '命令式语言要求实施时，意思是把实施写进计划，不是执行。',
    submission === undefined
      ? '对话中的同意或对某个问题的确认不结束计划模式；本请求没有计划提交工具，把计划放在最终回复里并结束本轮，等待用户明确决定。'
      : '对话中的同意或对某个问题的确认不结束计划模式；必须通过 `exit_plan_mode` 提交计划并由用户批准。',
    '工作顺序：先探索仓库、理解现有模式与约定，再设计方案；有分歧先问，最后成稿提交。',
    `先探索：用当前可用的只读工具（${readTools.length > 0 ? readTools.join('、') : '读取与检索工具'}、静态分析和检查）把计划落在真实仓库上。不要写文件、改配置、运行会改写文件的格式化或代码生成、提交，也不要执行计划。优先复用现有函数和模式，不要为新机制而新机制。`,
    '宿主会拒绝写入、shell 和外部 MCP 调用；当前请求可能只列出只读工具。这些计划模式规则优先于后续任何建议使用写入工具的说明。',
    submission === undefined
      ? '不要用 `todo_write` 跟踪计划阶段：它跟踪批准后的实施；计划直接在最终回复里给出。'
      : '不要用 `todo_write` 跟踪计划阶段：它跟踪批准后的实施，计划本身属于 `exit_plan_mode`。',
    questions === undefined
      ? '能通过检查确定的事实自己去查。用户才有权决定的重大分歧无法自行解决时，在回复中说明并询问，不要编造决定或提交未决计划。'
      : `能通过检查确定的事实自己去查。只有用户拥有的选择或检查无法回答的重大歧义才${questions}；不要问代码在哪、当前行为是什么。`,
    '计划定稿前如仍有重大未决的需求或方案分歧，先问清再成稿；提交计划本身就是请求批准，不要用提问征求"计划可以吗"。',
    '计划要决策完整：写明目标与验收标准；按子系统分组改动；列出公共 API、schema 和数据流变化；覆盖边界情况、失败模式、测试、验收标准和显式假设。简洁到可审阅，详细到另一位工程师不用再做设计决策。',
    `把计划写成 Markdown，第一行是一级标题（"${HEADING_PREFIX}<标题>"），后面是步骤和要执行的验证。`,
    ...(submission === undefined
      ? ['本请求没有可调用的计划提交工具。把计划放在最终回复里并结束本轮；不要声称已提交，也不要等待工具结果。']
      : [
          `准备好后${submission}，并让该调用成为这次回复唯一且最后一个工具调用；不要把计划当普通回复粘贴，也不要用提问代替提交。`,
          '计划待审期间不要执行；结束本轮。',
          '用户要求修改时，吸收反馈并重新提交；用户批准后计划模式关闭，在当前权限内按后续消息处理已批准的方案。',
        ]),
  ].join('\n')
})

/**
 * 计划扩展的配置：readAccessMode 用于在事务内读取当前访问模式，只读会话的批准按钮
 * 换成"确认方案"。
 */
export type PlanExtensionOptions = {
  readAccessMode?: (tx: Tx, conversationId: ConversationId) => Promise<AccessMode | undefined>
}

/** 构造 `exit_plan_mode` 工具；按 options 决定只读模式下的批准按钮文案。 */
const exitPlanModeTool = (options: PlanExtensionOptions) => defineTool({
  name: 'exit_plan_mode',
  description: [
    '将你在计划模式下编写的计划提交给用户批准，然后结束本轮，不等待审阅。',
    '仅用于实施步骤需要规划的代码编写任务；调研任务（收集信息、搜索或读取文件、理解代码库）应直接回答，不提交计划。',
    '调用前，确保计划完整且无歧义：先解决需求或方案中必须由用户决定的重要问题，再提交。',
    '不要另外询问“这个计划可以吗”或“是否继续”；提交计划本身就是批准请求。',
    `这是该助手回复中唯一且最后一次工具调用。计划使用 Markdown，以一级标题（"${HEADING_PREFIX}<标题>"）开头，随后列出步骤及将执行的验证。`,
    '仅在计划模式已开启时调用。',
    '用户在对话中审阅计划；批准后关闭计划模式，确认内容以跟进消息送达。',
    '若用户要求修改，修订计划并再次调用 exit_plan_mode，不要开始实施。',
    '示例：“搜索并理解 vim 模式如何实现”→ 报告发现，不提交计划；“为 vim 实现 yank 模式”→ 提交实施计划；“添加认证，认证方式未定”→ 先询问认证方式，再提交。',
  ].join(' '),
  parameters: Type.Object({ plan: Type.String() }),
  /**
   * 功能：提交计划（DSH exit_plan_mode 的非阻塞形式）。
   * 输入校验：计划模式未开启抛 PLAN_INACTIVE_ERROR（附带进入计划模式的指引）；
   * cleanPlan 校验计划格式；事务内对提交文档二次确认，快照后发生的切换以已提交
   * 文档为准。
   * 内部逻辑：把 pending 计划审阅写入 Interactions（一次只保留一个待审计划——修订
   * 提交会把仍在 pending 的旧审阅标记为 superseded），用户决定稍后经 answer API
   * 送达，批准时关闭计划模式。绝不阻塞等待。
   */
  execute: async (args, api, context) => {
    const state = await api.snapshot(Plans, api.conversationId, context)
    if (state?.active !== true) {
      const route = resolveToolRoute(await api.agent(context), 'enter_plan_mode')
      const entry = toolRouteInstruction('enter_plan_mode', route, '{}')
      throw new Error(entry === undefined ? PLAN_INACTIVE_ERROR : `${PLAN_INACTIVE_ERROR} 需要进入计划模式进行审阅时：${entry}。`)
    }
    const plan = cleanPlan(args.plan)
    let approveLabel = PLAN_APPROVE_LABEL
    await api.commit(async (tx) => {
      if (options.readAccessMode !== undefined) {
        const accessMode = await options.readAccessMode(tx, api.conversationId)
        if (accessMode === 'readOnly' || accessMode === undefined) approveLabel = READ_ONLY_PLAN_APPROVE_LABEL
      }
      const doc = await tx.doc(Plans, api.conversationId)
      // 对照已提交文档再查一次：快照之后落下的切换以文档为准。
      if (!doc.active) throw new Error(PLAN_INACTIVE_ERROR)
      const table = interactionTable(await tx.doc(Interactions, api.conversationId))
      // 同一时间只有一个计划在审：修订提交会替换仍在 pending 的旧审阅，被关掉或遗忘
      // 的审阅不会作为当前决策重新浮出。
      for (const stored of Object.values(table)) {
        const review = planReviewOf(stored)
        if (review?.status === 'pending') review.status = 'superseded'
      }
      table[api.callId] = {
        kind: 'plan-review',
        detail: plan,
        approveLabel,
        askedAt: Date.now(),
        status: 'pending',
      } satisfies StoredPlanReview
    }, context)
    return {
      output: [{
        type: 'text' as const,
        text: '计划已在对话中等待用户审阅。不要开始执行，也不要在本轮等待：结束本轮，待用户的决定作为跟进消息送达后再继续。',
      }],
      details: {
        requestKey: api.callId,
        kind: 'plan-review',
        status: 'pending' as const,
        approveLabel,
        title: planTitle(plan) ?? null,
      },
    }
  },
})

/**
 * ZCode EnterPlanMode 的自由形态：模型自行进入计划模式，无需权限弹窗
 * （`plan-mode-policy` 无条件允许）也不询问用户。描述里携带 ZCode"实施任务优先进入
 * 计划模式"的指令，让"请求计划"直接可用——模型进入计划模式，而不是让用户去拨开关。
 */
const enterPlanModeTool = defineTool({
  name: 'enter_plan_mode',
  description: [
    '自行将本会话切换为计划模式，无须询问用户或等待确认。',
    '非简单的实施任务优先进入计划模式，例如新功能、有多种可行方案的工作、多文件重构、架构决策或验收标准不明确的任务。',
    '简单查询、单行修复、明显的缺陷修复、直接回答，以及用户已给出明确详细指令的任务，无须进入计划模式。',
    '计划模式开启时，仅研究仓库和设计计划，不做改动；最后用 exit_plan_mode 提交计划，等待用户批准。',
    '计划模式已经开启时，无须重复调用。',
  ].join(' '),
  parameters: Type.Object({}),
  /**
   * 功能：把当前会话切换为计划模式。
   * 输入校验：目标（goal）处于活动状态时拒绝（计划与目标不能同时活动）；已开启时
   * 返回提示不重复切换；本请求没有 exit_plan_mode 工具时拒绝进入。
   * 内部逻辑：事务内置 active=true 并刷新 updatedAt，计划策略 section 会在下一个
   * 请求生效。
   */
  execute: async (_args, api, context) => {
    const goal = await api.snapshot(Goals, api.conversationId, context)
    if (goal?.goal?.phase === 'active') {
      throw new Error('计划和目标不能同时处于活动状态：进入计划模式前，先暂停或完成目标。')
    }
    const state = await api.snapshot(Plans, api.conversationId, context)
    if (state?.active === true) {
      return {
        output: [{
          type: 'text' as const,
          text: '计划模式已经开启。先调研，再用 exit_plan_mode 提交计划。',
        }],
      }
    }
    if (resolveToolRoute(await api.agent(context), 'exit_plan_mode') === 'unavailable') {
      throw new Error('本请求没有可调用的计划提交工具，无法进入计划模式。请先调研，再直接在答复中给出计划。')
    }
    await api.commit(async (tx) => {
      const doc = await tx.doc(Plans, api.conversationId)
      doc.active = true
      doc.updatedAt = Date.now()
    }, context)
    return {
      output: [{
        type: 'text' as const,
        text: '计划模式已开启。先调研、设计计划，再用 exit_plan_mode 提交；用户批准前不得实施。',
      }],
      details: { kind: 'plan-mode' as const, status: 'active' as const },
    }
  },
})

/**
 * 功能：装配 plan 工具扩展（DSH 计划模式）：贡献 2 个工具（enter_plan_mode /
 * exit_plan_mode）与 1 个 section（plan-policy 计划模式工作规则）；由 runtime 注册。
 * @param options 可选配置，用于读取访问模式以决定批准按钮文案。
 * @returns 名为 `plan` 的扩展。
 */
export function createPlanExtension(options: PlanExtensionOptions = {}): Extension {
  return defineExtension({
    name: 'plan',
    tools: [enterPlanModeTool, exitPlanModeTool(options)],
    sections: [planSection],
  })
}

/** 按默认配置预装配好的 plan 扩展实例。 */
export const PlanExtension: Extension = createPlanExtension()
