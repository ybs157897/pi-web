/**
 * The module-bot tool extension: member tools (`post_to_room` / `bot_message` / `read_room`),
 * orchestrator tools (`bot_create` / `bot_update` / `finish_init`), the bot policy section and
 * the write/edit wrap that pins a bot to its own knowledge document.
 *
 * Scope discipline: the extension is installed in the registry but excluded from
 * `buildAgentChange` (`AGENT_EXCLUDED_EXTENSIONS`), so ordinary conversations never see its
 * tools or sections — a bot conversation opts in through an explicit `extensions add`.
 * Authorization inside each tool re-checks the caller's identity document, the same way the
 * team extension asserts the Lead role.
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import {
  defineExtension,
  defineTool,
  section,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { BotRecord, CreateBotInput, UpdateBotInput } from '../../shared/types.ts'
import { CONVERSATION_KIND } from '../runtime/helpers.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { KNOWLEDGE_BODY_CHAR_LIMIT } from './docs.ts'
import { BotIdentity } from './identity.ts'
import { argumentPath } from '../memory/store.ts'

export const BOTS_EXTENSION_NAME = 'pi-web-bots'

export const BOT_MEMBER_TOOLS = ['post_to_room', 'bot_message', 'read_room'] as const
export const BOT_ORCHESTRATOR_TOOLS = ['bot_create', 'bot_update', 'finish_init'] as const
export const BOT_TOOL_NAMES = [...BOT_MEMBER_TOOLS, ...BOT_ORCHESTRATOR_TOOLS] as const

/** What the extension needs from the runtime feature; every callback is the service's. */
export interface BotsExtensionOptions {
  roster(): { bots: readonly BotRecord[] }
  /** Read one bot's knowledge body (frontmatter stripped) for the policy section. */
  knowledgeBody(bot: Pick<BotRecord, 'knowledgePath'>): Promise<string | undefined>
  postAsBot(bot: BotRecord, roomId: string, text: string): Promise<{ silent: boolean; mentioned: string[]; depthLimited: boolean }>
  directMessage(from: BotRecord, toBotName: string, text: string): Promise<{ to: string; depthLimited: boolean }>
  readRoom(roomId: string, limit?: number): Promise<string>
  createBot(input: CreateBotInput): Promise<BotRecord>
  updateBot(botId: string, input: UpdateBotInput): Promise<BotRecord>
  finishInit(summary: string): Promise<{ ok: true }>
}

/** Resolve the calling conversation's bot identity; `undefined` for any other conversation. */
async function resolveBotIdentity(api: ToolExecutionApi, context: Context): Promise<{ botId: string; name: string | null } | undefined> {
  const identity = await api.snapshot(BotIdentity, api.conversationId, context)
  if (identity?.botId === undefined || identity.botId === null || identity.botId === '') return undefined
  return { botId: identity.botId, name: identity.name }
}

function requireCallerBot(options: BotsExtensionOptions, identity: { botId: string } | undefined): BotRecord {
  if (identity === undefined) throw new RuntimeError('FORBIDDEN', '只有模块 bot 会话可以调用该工具')
  const bot = options.roster().bots.find(candidate => candidate.id === identity.botId)
  if (bot === undefined) throw new RuntimeError('NOT_FOUND', '当前会话的 bot 身份不在名册中')
  return bot
}

async function requireOrchestratorConversation(api: ToolExecutionApi, context: Context): Promise<void> {
  const kind = await api.snapshot(CONVERSATION_KIND, api.conversationId, context)
  if (kind?.kind !== 'botInit') {
    throw new RuntimeError('FORBIDDEN', '该工具只能在 bot 团队初始化会话中调用')
  }
}

function jsonText(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function createBotsExtension(options: BotsExtensionOptions): Extension {
  /** The knowledge-document pin: a bot conversation may only write its own document. */
  const knowledgeWraps: NonNullable<Extension['wraps']> = (['write', 'edit'] as const).map(toolName => ({
    tool: toolName,
    wrap: (tool: ToolRegistration): ToolRegistration => ({
      ...tool,
      execute: async (args: never, api: ToolExecutionApi, context: Context) => {
        const identity = await resolveBotIdentity(api, context)
        if (identity === undefined) return tool.execute(args, api, context)
        const bot = options.roster().bots.find(candidate => candidate.id === identity.botId)
        if (bot === undefined) return tool.execute(args, api, context)
        const cwd = api.env?.cwd ?? process.cwd()
        const allowed = resolve(cwd, bot.knowledgePath)
        const target = argumentPath(args)
        if (target === undefined) return tool.execute(args, api, context)
        const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
        if (absoluteTarget === allowed) return tool.execute(args, api, context)
        throw new RuntimeError(
          'ACCESS_DENIED',
          `模块 bot「${bot.name}」的 write/edit 只允许修改自己的知识文档 ${bot.knowledgePath}；${target} 已被身份限制拒绝`,
        )
      },
    }),
  }))

  const postToRoomTool = defineTool({
    name: 'post_to_room',
    description: [
      '把一条消息发到模块 bot 群聊：正文进入群聊日志，正文里的 @提及（@<botName>，或 @all 全体）会投递给其他成员。',
      '没有实质补充时发送正文 [PASS]：调用会被静默处理，不写群聊也不投递任何人。',
      '只有模块 bot 会话可以调用。直接文本回复不会被投递——需要让其他成员看到的内容必须通过本工具发出。',
    ].join(' '),
    parameters: Type.Object({
      roomId: Type.String({ description: '目标群聊的 id 或名称：群聊帧头 [ROOM:<名>] 里的名称可直接作为本参数' }),
      text: Type.String({ description: '消息正文；静默回复写 [PASS]' }),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ posted: boolean; mentioned: string[] }>> => {
      const identity = await resolveBotIdentity(api, context)
      const bot = requireCallerBot(options, identity)
      const result = await options.postAsBot(bot, args.roomId, args.text)
      const text = result.silent
        ? '已静默（pass）：未写入群聊，也不会投递给其他成员。'
        : result.depthLimited
          ? `已写入群聊「${args.roomId}」。已达投递深度上限（bot 之间的转提及最多一跳），本次提及不再投递。`
          : `已写入群聊「${args.roomId}」${result.mentioned.length > 0 ? `；已投递给：${result.mentioned.join('、')}` : '；正文没有 @提及，未投递给其他成员'}。`
      return { output: [{ type: 'text' as const, text }], details: { posted: !result.silent, mentioned: result.mentioned } }
    },
  })

  const botMessageTool = defineTool({
    name: 'bot_message',
    description: '把一条定向消息投递给另一个模块 bot 的会话（帧头 [DIRECT FROM:<发送者>])。只有模块 bot 会话可以调用。',
    parameters: Type.Object({
      toBotName: Type.String({ description: '目标 bot 名称' }),
      text: Type.String(),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ to: string }>> => {
      const identity = await resolveBotIdentity(api, context)
      const bot = requireCallerBot(options, identity)
      const result = await options.directMessage(bot, args.toBotName, args.text)
      const text = result.depthLimited
        ? `已达投递深度上限（bot 之间的转提及最多一跳），消息没有投递给「${result.to}」。`
        : `已定向投递给「${result.to}」。`
      return { output: [{ type: 'text' as const, text }], details: { to: result.to } }
    },
  })

  const readRoomTool = defineTool({
    name: 'read_room',
    description: '读取模块 bot 群聊的最近消息（每条一行发送者帧头 + 正文）。只有模块 bot 会话可以调用。',
    parameters: Type.Object({
      roomId: Type.String({ description: '群聊的 id 或名称：群聊帧头 [ROOM:<名>] 里的名称可直接作为本参数' }),
      limit: Type.Optional(Type.Number({ description: '最多返回的条数，默认 50' })),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ text: string }>> => {
      const identity = await resolveBotIdentity(api, context)
      requireCallerBot(options, identity)
      const text = await options.readRoom(args.roomId, args.limit)
      return { output: [{ type: 'text' as const, text }], details: { text } }
    },
  })

  const botCreateTool = defineTool({
    name: 'bot_create',
    description: '创建一个模块 bot：名称（lower-kebab）、模块、globs 关注路径、一句话描述。会建立持久会话并写入知识文档骨架。只能在 bot 团队初始化会话中调用。',
    parameters: Type.Object({
      name: Type.String(),
      module: Type.String(),
      globs: Type.Array(Type.String(), { minItems: 1 }),
      description: Type.String(),
      model: Type.Optional(Type.String()),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<BotRecord>> => {
      await requireOrchestratorConversation(api, context)
      const bot = await options.createBot({
        name: args.name,
        module: args.module,
        globs: args.globs,
        description: args.description,
        ...(args.model === undefined ? {} : { model: args.model }),
      })
      return { output: jsonText({ bot }), details: bot }
    },
  })

  const botUpdateTool = defineTool({
    name: 'bot_update',
    description: '更新一个已存在模块 bot 的模块、globs、描述或模型（名称不可改）；知识文档 frontmatter 会同步重写。只能在 bot 团队初始化会话中调用。',
    parameters: Type.Object({
      botId: Type.String(),
      module: Type.Optional(Type.String()),
      globs: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
      description: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<BotRecord>> => {
      await requireOrchestratorConversation(api, context)
      const patch: UpdateBotInput = {
        ...(args.module === undefined ? {} : { module: args.module }),
        ...(args.globs === undefined ? {} : { globs: args.globs }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.model === undefined ? {} : { model: args.model }),
      }
      const bot = await options.updateBot(args.botId, patch)
      return { output: jsonText({ bot }), details: bot }
    },
  })

  const finishInitTool = defineTool({
    name: 'finish_init',
    description: '提交 bot 团队初始化总结（团队构成与各 bot 职责），结束本次初始化编排。只能在 bot 团队初始化会话中调用。',
    parameters: Type.Object({ summary: Type.String({ description: '初始化总结' }) }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ ok: true }>> => {
      await requireOrchestratorConversation(api, context)
      const result = await options.finishInit(args.summary)
      return {
        output: [{ type: 'text' as const, text: '初始化总结已记录。编排结束，本轮完成后初始化流程即结束。' }],
        details: result,
      }
    },
  })

  /** Bot conversations: identity, knowledge document, group-chat protocol and the team router. */
  const botPolicySection = section('bot-policy', async (input, context) => {
    const identity = await input.read.snapshot(BotIdentity, input.conversationId, context)
    if (identity?.botId === undefined || identity.botId === null || identity.botId === '') return undefined
    const bot = options.roster().bots.find(candidate => candidate.id === identity.botId)
    if (bot === undefined) return undefined
    const cwd = input.env?.cwd
    const body = cwd === undefined ? undefined : await options.knowledgeBody(bot)
    const roster = options.roster().bots
    const lines = [
      `# 你的知识文档（${bot.knowledgePath}）`,
      '',
    ]
    if (body === undefined) {
      lines.push('（知识文档当前缺失或不可读；参与协作后请用 write 重建它——只允许写这一个文件。）')
    } else if (body.length > KNOWLEDGE_BODY_CHAR_LIMIT) {
      lines.push(
        `${body.slice(0, KNOWLEDGE_BODY_CHAR_LIMIT)}`,
        '',
        `（正文超过 ${KNOWLEDGE_BODY_CHAR_LIMIT} 字符，已截断；完整内容以文件为准，请考虑精简正文。）`,
      )
    } else {
      lines.push(body)
    }
    lines.push(
      '',
      '# 团队路由表（@提及与定向沟通用）',
      '',
      ...roster.map(member => `- ${member.name}：模块 ${member.module} —— ${member.description}`),
    )
    return lines.join('\n')
  })

  /** The orchestrator conversation's own policy: what the init tools expect. */
  const botInitPolicySection = section('bot-init-policy', async (input, context) => {
    const kind = await input.read.snapshot(CONVERSATION_KIND, input.conversationId, context)
    if (kind?.kind !== 'botInit') return undefined
    return [
      '# bot 团队初始化工具约定',
      '',
      '- bot_create / bot_update 只操作名册与知识文档骨架；知识文档初版内容由你用 write 写到 docs/bots/<botId>.md（每个 bot 一次 write，frontmatter 与骨架结构保留）。',
      '- finish_init 的总结是本次初始化的交付物：列出每个 bot 的名称、模块与职责一句话。',
      '- 名册已存在的名称不能重复创建；创建失败时调整切分或换名重试。',
    ].join('\n')
  })

  return defineExtension({
    name: BOTS_EXTENSION_NAME,
    tools: [postToRoomTool, botMessageTool, readRoomTool, botCreateTool, botUpdateTool, finishInitTool],
    sections: [botPolicySection, botInitPolicySection],
    wraps: knowledgeWraps,
  })
}
