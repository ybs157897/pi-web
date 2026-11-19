import { randomUUID } from 'node:crypto'
import { defineDoc } from '@earendil-works/pi-durable'
import { z } from 'zod'
import { WORKBENCH_BOT_ICONS, type CreateWorkbenchBotInput, type UpdateWorkbenchBotInput, type WorkbenchBotConfig } from '../../shared/workbench.ts'
import type { AccessMode } from '../../shared/types.ts'
import { RuntimeError } from '../runtime-errors.ts'

export const WORKBENCH_CREATE_BOT_TOOL = 'create_workbench_bot'

export type WorkbenchBotProfile = Omit<WorkbenchBotConfig, 'accessMode' | 'model'> & {
  id: string
  name: string
  role: string
  description: string
  accessMode?: AccessMode
  model?: { provider: string; modelId: string }
  specialty?: string
}

export const WorkbenchBotRoster = defineDoc<{ bots: WorkbenchBotProfile[] }>({
  kind: 'pi-web.workbench-bots', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ bots: [] }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
})

const builtins: readonly WorkbenchBotProfile[] = [
  {
    id: 'log', name: '日志智能体', role: '日志排查', icon: 'activity', origin: 'builtin', skillIds: null,
    description: '结合日志、代码和运行证据定位问题，交付结论和验证方法。',
    instructions: '先核对日志来源、时间窗和关联标识，沿实际入口追踪错误链。用文件、行号和事件顺序区分观察到的证据与推断，明确下一步验证。涉及访问令牌或用户数据时，交付中保留定位所需信息并隐去敏感内容。',
  },
  {
    id: 'import', name: '导入智能体', role: '导入与校验', icon: 'database', origin: 'builtin', skillIds: null,
    description: '处理文件与数据导入、解析、兼容性、输入边界和校验。',
    instructions: '核对输入契约、样例及异常行，检查空字段、重复导入和半途失败的行为。围绕真实输入和可复现的校验结果交付，并指出可能影响已有数据的变更。',
  },
  {
    id: 'time', name: '时间智能体', role: '时间与排序', icon: 'clock', origin: 'builtin', skillIds: null,
    description: '处理时间、时区、排序、计划与时间线。',
    instructions: '确认发生时间、记录时间和显示时区。存在相同时间时核对稳定排序规则，跨日与夏令时边界使用具体日期或样例说明。',
  },
  {
    id: 'general', name: '通用智能体', role: '分析与实现', icon: 'sparkles', origin: 'builtin', skillIds: null,
    description: '承接临时或跨领域任务，执行工作区调研、需求梳理和开发。',
    instructions: '根据用户目标选择最直接的做法。先查清和任务直接相关的工程事实，再实施范围内的改动并验证。遇到持续需要专长的工作时，可在结果中说明所需领域，供工作台主 Agent 下次派发。',
  },
]

export function botRoster(stored: readonly WorkbenchBotProfile[]): WorkbenchBotProfile[] {
  const configured = new Map(stored.map(bot => [bot.id, bot]))
  const builtinIds = new Set(builtins.map(bot => bot.id))
  return [...builtins.map(bot => configured.get(bot.id) ?? bot), ...stored.filter(bot => !builtinIds.has(bot.id))]
}

export function findBot(roster: readonly WorkbenchBotProfile[], botId: string): WorkbenchBotProfile {
  const bot = roster.find(candidate => candidate.id === botId)
  if (!bot) throw new RuntimeError('NOT_FOUND', '工作区中没有找到指定的 Bot')
  return bot
}

const name = z.string().trim().min(1).max(60).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u)
const role = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u)
const description = z.string().trim().max(500)
const instructions = z.string().trim().max(4_000)
const icon = z.enum(WORKBENCH_BOT_ICONS)
export const createWorkbenchBotSchema = z.object({
  name,
  role: role.optional(),
  description: description.optional(),
  instructions: instructions.optional(),
  model: z.object({ provider: z.string().min(1).max(100), modelId: z.string().min(1).max(256) }).strict().nullable().optional(),
  accessMode: z.enum(['readOnly', 'workspaceWrite', 'fullAccess']).optional(),
  skillIds: z.array(z.string().trim().min(1).max(256)).max(256).nullable().optional(),
  icon: icon.optional(),
}).strict()
export const updateWorkbenchBotSchema = createWorkbenchBotSchema.partial().refine(value => Object.keys(value).length > 0)

export const proposedWorkbenchBotSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u).max(48),
  name,
  role,
  description: description.min(1),
  instructions: instructions.min(1),
  icon: icon.optional(),
}).strict()
export type ProposedWorkbenchBot = z.infer<typeof proposedWorkbenchBotSchema>

function nameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

function configFromInput(input: UpdateWorkbenchBotInput): Omit<UpdateWorkbenchBotInput, 'model'> {
  const { model: _model, ...config } = input
  return {
    ...config,
    ...(config.skillIds == null ? {} : { skillIds: [...new Set(config.skillIds)] }),
  }
}

function assertUniqueBotName(roster: readonly WorkbenchBotProfile[], name: string, id?: string): void {
  const normalized = nameKey(name)
  if (['agent', '主 agent', '主agent'].includes(normalized)
    || roster.some(bot => bot.id !== id && nameKey(bot.name) === normalized)) {
    throw new RuntimeError('CONFLICT', '工作区已存在同名智能体')
  }
}

export function createUserBot(roster: readonly WorkbenchBotProfile[], input: CreateWorkbenchBotInput): WorkbenchBotProfile {
  assertUniqueBotName(roster, input.name)
  return {
    id: `bot-${randomUUID()}`, origin: 'user', name: input.name, role: '工作区协作',
    description: '', instructions: '', skillIds: null, icon: 'bot',
    ...configFromInput(input),
    ...(input.model == null ? {} : { model: input.model }),
  }
}

export function updateBotProfile(roster: readonly WorkbenchBotProfile[], id: string, input: UpdateWorkbenchBotInput): WorkbenchBotProfile {
  const bot = findBot(roster, id)
  if (input.name !== undefined) assertUniqueBotName(roster, input.name, id)
  const result: WorkbenchBotProfile = { ...bot, ...configFromInput(input) }
  if (input.model === null) delete result.model
  else if (input.model !== undefined) result.model = input.model
  return result
}

export function incubateBot(roster: readonly WorkbenchBotProfile[], proposal: ProposedWorkbenchBot): { bot: WorkbenchBotProfile; created: boolean } {
  const normalized = nameKey(proposal.name)
  const existing = roster.find(bot => bot.specialty === proposal.id || nameKey(bot.name) === normalized || bot.id === proposal.id)
  if (existing) return { bot: existing, created: false }
  assertUniqueBotName(roster, proposal.name)
  return {
    bot: {
      id: `bot-${randomUUID()}`, name: proposal.name, specialty: proposal.id,
      role: proposal.role, description: proposal.description, instructions: proposal.instructions,
      origin: 'agent', skillIds: null, icon: proposal.icon ?? 'bot',
    },
    created: true,
  }
}

const accessOrder: readonly AccessMode[] = ['readOnly', 'workspaceWrite', 'fullAccess']
export function boundedBotAccess(requested: AccessMode, configured: AccessMode): AccessMode {
  return accessOrder[Math.min(accessOrder.indexOf(requested), accessOrder.indexOf(configured))]!
}
