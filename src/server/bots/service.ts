/**
 * The module-bot team service: roster state, bot/room conversations, group-chat delivery,
 * knowledge compliance, the watchdog and the two initialization modes.
 *
 * State ownership mirrors the rest of the runtime: the roster lives in `app-state.json`
 * (`bots` block), each bot is an ownerless durable conversation stamped with a `pi-web.bot`
 * identity document and the `bot` conversation kind, and a room is an ownerless conversation
 * that only ever receives passive entry writes — the host never submits input to it, so a
 * room never runs a model. Bot state transitions (busy/idle, compliance) ride the same
 * conversation watch seam the team feature uses for member status.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { JsonValue } from '@earendil-works/chord'
import type { AgentChange, Extension, Harness } from '@earendil-works/pi-durable'
import type {
  AccessMode, BotInitInput, BotRecord, BotRoomFrame, BotRoomPostInput, BotRoomRecord, BotTeamOverview,
  BotWatchdogEntry, BotWatchdogReport, CreateBotInput, CreateBotRoomInput, UpdateBotInput,
} from '../../shared/types.ts'
import { AutomationScheduler } from '../automation/scheduler.ts'
import { workspaceWriteSupported } from '../conversation/execution-env.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { CONVERSATION_KIND, CTX, META, liveRunTaskId, parseConversationId } from '../runtime/helpers.ts'
import type { AppStateStore } from '../state/app-state.ts'
import { BotIdentity, ROOM_ENTRY_KIND, parseRoomEntry, roomFrameText } from './identity.ts'
import {
  BOTS_DOC_DIR, KNOWLEDGE_BODY_CHAR_LIMIT, knowledgeAbsolutePath, knowledgeHash, knowledgeRelativePath,
  knowledgeSkeleton, parseFrontmatter, hasFrontmatterBlock, readKnowledgeFile, renderFrontmatter,
  stripFrontmatter, writeKnowledgeFile,
} from './docs.ts'

const execFileAsync = promisify(execFile)

/** Uploaded avatars live beside the state file, one PNG per bot id. */
const BOT_AVATAR_DIR = 'bot-avatars'
const BOT_AVATAR_MAX_BYTES = 512 * 1024

/** Mentions a post text carries: `@<botName>` for one member, `@all` for everyone. */
const MENTION_PATTERN = /@([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/gu
/** The room tail a delivery frame embeds: at most this many entries and this many characters. */
const ROOM_TAIL_ENTRIES = 12
const ROOM_TAIL_CHARS = 4_000
/** Delivery-hop budget: a user post is hop 1, a bot's re-mention is hop 2, then it stops. */
const MAX_DELIVERY_DEPTH = 2
/** The directory under the data dir holding the latest watchdog report file. */
const WATCHDOG_REPORT_DIR = 'bot-watchdog'

export interface BotsServiceDeps {
  appState: AppStateStore
  harness: () => Harness
  /** Late-bound so the factory can be built before the harness is opened. */
  assertOpen(): void
  dataDir: string
  buildAgentChange(workspaceId: string, accessMode: AccessMode, overrides?: {
    model?: { provider: string; modelId: string }
    thinkingLevel?: string
  }): Promise<AgentChange>
  selectedWorkspace(id: string | undefined): { id: string; name: string; path: string }
  /** Late-bound (conversations service is assembled later): the conversation's error, if any. */
  conversationError(conversationId: string): Promise<string | undefined>
}

/**
 * Bot names are Grok-Bot style short names: a letter followed by letters, digits or hyphens
 * (`Atlas`, `Kepler`, `Growth-1`). The name doubles as the id, the mention token and the
 * knowledge file stem, so spaces and punctuation stay out.
 */
const BOT_NAME = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/u

function requireBotName(value: string): string {
  const name = value.trim()
  if (!BOT_NAME.test(name) || name.length > 64) {
    throw new RuntimeError('INVALID_INPUT', 'bot 名称必须以字母开头，只含字母、数字和连字符，最长 64 个字符')
  }
  return name
}

function requireText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text === '') throw new RuntimeError('INVALID_INPUT', `${field} 不能为空`)
  if (text.length > maxLength) throw new RuntimeError('INVALID_INPUT', `${field} 超过 ${maxLength} 个字符`)
  return text
}

/** Normalize one workspace-relative glob; rejects absolute, traversal and empty values. */
function normalizeGlob(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (normalized === '' || normalized.length > 200 || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || normalized.split('/').some(segment => segment === '..')) {
    throw new RuntimeError('INVALID_INPUT', `glob 无效：${JSON.stringify(value)}`)
  }
  return normalized
}

/** Parse `@name` mentions against the roster; `@all` collapses to every bot. */
export function parseMentions(text: string, names: readonly string[]): string[] {
  const known = new Set(names)
  const hits = [...text.matchAll(MENTION_PATTERN)].map(match => match[1] ?? '').filter(name => known.has(name))
  if (hits.length === 0) return []
  if (hits.includes('all')) return [...names]
  return [...new Set(hits)]
}

/** Whether the text is a silent pass reply (bracketed, fullwidth-bracketed, or bare `pass.`). */
export function isPassReply(text: string): boolean {
  return /^\s*[\[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/iu.test(text)
}

/** The room log tail as one bounded text block for a delivery frame. */
function renderRoomTail(frames: readonly BotRoomFrame[]): string {
  const lines: string[] = []
  let total = 0
  for (const frame of frames.slice(-ROOM_TAIL_ENTRIES).reverse()) {
    const text = roomFrameText(frame)
    if (total + text.length > ROOM_TAIL_CHARS) break
    lines.unshift(text)
    total += text.length
  }
  return lines.join('\n')
}

/** The instruction block every delivery frame ends with. */
export function deliveryFooter(): string {
  return [
    '以上是群聊最近消息，你被提及。',
    '优先用你的知识文档里已有的信息回答；文档不够时读至多 3 个相关文件，读完立即回应，不要继续探索其他文件或配置。',
    '回答控制在几句话内。无实质补充就回复 [PASS]；回应必须通过 post_to_room 发出，直接文本回复不会被投递。',
  ].join('')
}

export function roomDeliveryFrame(roomName: string, from: string, tail: string): string {
  return [`[ROOM:${roomName} FROM:${from}]`, '---', tail, '---', deliveryFooter()].join('\n')
}

/** The persistent identity prompt a bot conversation carries (replaces the copied instructions). */
export function botSystemPrompt(bot: Pick<BotRecord, 'name' | 'module' | 'globs' | 'description' | 'knowledgePath'>): string {
  return [
    `你是模块 bot「${bot.name}」，常设负责模块「${bot.module}」（关注路径：${bot.globs.join('、')}）。`,
    `模块职责：${bot.description}`,
    '',
    '知识文档硬规则：',
    `- 你的唯一持久知识文档是 \`${bot.knowledgePath}\`（工作区相对路径）。每次参与协作后，把对团队有用的模块知识（关键文件、已知坑、接口约定、变更影响）增量写回对应章节。`,
    '- 本会话的 write/edit 只允许修改这一个文件；对其他任何路径的写请求都会被拒绝。',
    '- 更新时保留 frontmatter（botId/module/globs/updatedStamp）与既有章节结构，按增量追加，不要整篇重写历史内容。',
    '- 本次参与没有产生新知识（例如只是回答了介绍类问题）也要在 changelog 追加一行 `- <日期> <参与摘要>，无文档变更`，保证每次参与都留下回写痕迹。',
    '',
    '群聊协议：',
    '- 你被 @ 提及或收到群聊帧（[ROOM:...]）时才需要回应；先结合知识文档判断是否需要读模块代码，再回应。',
    '- 没有实质补充时，调用 post_to_room 发送正文 [PASS]（会静默：不进群聊，也不投递他人）。',
    '- 有实质补充时用 post_to_room 发到群聊；需要定向沟通某个成员时用 bot_message。',
    '- 在 post_to_room 正文里用 @<botName> 提及其他成员触发投递；@all 提及全体。直接文本回复不会被投递。',
    '- 投递链最多两跳：你被另一 bot 的消息唤醒后，再提及他人将不再投递。',
  ].join('\n')
}

/** The orchestrator identity prompt for the temporary bot-init conversation. */
export function botInitSystemPrompt(): string {
  return [
    '你是 bot 团队初始化编排者，负责把当前代码库切成 3-6 个模块 bot 的常设团队。',
    '',
    '按以下步骤执行：',
    '1. 只读侦察：列目录（顶层与 src 主要子目录），结合 `git log --oneline -30` 近期提交归纳变更聚类。',
    '2. 提出模块切分：每个模块一个 lower-kebab 名称、一句话描述、workspace 相对 globs 关注路径数组。',
    '3. 逐模块调用 bot_create 创建 bot；创建成功后立即用 write 把该 bot 的知识文档初版写到 docs/bots/<botId>.md（frontmatter：botId/module/globs/updatedStamp；正文：职责/关键文件/已知坑/changelog，内容须来自你刚才的侦察证据）。',
    '4. 全部完成后调用 finish_init 提交团队构成与各 bot 职责的一段总结。',
    '',
    '限制：不要修改 docs/bots/ 之外的任何文件；不要运行改变 git 状态的命令。',
  ].join('\n')
}

/** The watchdog refresh instruction submitted to one stale bot's own conversation. */
export function watchdogRefreshPrompt(bot: BotRecord, gitSummary: string, documentText: string): string {
  return [
    `[watchdog-refresh:${bot.id}]`,
    `watchdog 判定你的知识文档 ${bot.knowledgePath} 已过期（${gitSummary}）。`,
    '请用 git log / git diff 对照下面引用的现文档做增量刷新：修正过时描述、补上新变更涉及的关键文件与已知坑，并更新 changelog。只允许修改你自己的知识文档，保留 frontmatter 与章节结构。',
    '',
    '当前文档全文如下：',
    '---',
    documentText,
    '---',
  ].join('\n')
}

export function createBotsService(deps: BotsServiceDeps) {
  const { appState, assertOpen, selectedWorkspace } = deps
  const harness = (): Harness => deps.harness()
  /** Attached by the composition root once the extension object exists; bot agents need it. */
  let botsExtension: Extension | undefined
  /** Per-bot conversation watches; one entry per rostered bot, re-armed on reconcile. */
  const watches = new Map<string, { stop: () => Promise<void>; running: boolean }>()
  /** Background orchestrator-init tasks; drained at runtime close. */
  const tasks = new Set<Promise<void>>()
  /** The in-flight watchdog run, so concurrent triggers share one report. */
  let watchdogRun: Promise<BotWatchdogReport> | undefined
  const scheduler = new AutomationScheduler()

  const state = () => appState.snapshot().bots
  const roster = (): { bots: BotRecord[]; rooms: BotRoomRecord[] } => ({ bots: state().bots, rooms: state().rooms })

  const updateBotRecord = async (botId: string, change: (bot: BotRecord) => void): Promise<BotRecord> => {
    return await appState.update(draft => {
      const bot = draft.bots.bots.find(candidate => candidate.id === botId)
      if (bot === undefined) throw new RuntimeError('NOT_FOUND', `bot「${botId}」不存在`)
      change(bot)
      return structuredClone(bot)
    })
  }

  const requireBot = (botId: string): BotRecord => {
    const bot = state().bots.find(candidate => candidate.id === botId)
    if (bot === undefined) throw new RuntimeError('NOT_FOUND', `bot「${botId}」不存在`)
    return bot
  }

  const requireRoom = (roomId: string): BotRoomRecord => {
    const state_ = state()
    // Bots only ever see the room *name* (delivery frames carry no id), so the
    // id-or-name resolution here is what makes post_to_room usable at all.
    const room = state_.rooms.find(candidate => candidate.id === roomId)
      ?? state_.rooms.find(candidate => candidate.name === roomId)
    if (room === undefined) throw new RuntimeError('NOT_FOUND', `群聊「${roomId}」不存在`)
    return room
  }

  const defaultWorkspacePath = (): string => selectedWorkspace(undefined).path

  // ── knowledge document helpers ──

  const knowledgeBody = async (bot: Pick<BotRecord, 'knowledgePath'>): Promise<string | undefined> => {
    const content = await readKnowledgeFile(knowledgeAbsolutePath(defaultWorkspacePath(), bot))
    if (content === undefined) return undefined
    return stripFrontmatter(content)
  }

  // ── bot lifecycle ──

  /**
   * One bot's conversation: the standard agent composition plus the opt-in bots extension and
   * the identity instructions. Keeping the extension out of `buildAgentChange` is what keeps
   * ordinary conversations (and the prompt snapshots) untouched.
   */
  const createBotConversationAgent = async (
    workspaceId: string,
    accessMode: AccessMode,
    instructions: string,
  ): Promise<AgentChange> => {
    const base = await deps.buildAgentChange(workspaceId, accessMode)
    if (botsExtension === undefined) throw new RuntimeError('CONFLICT', 'bots 扩展尚未装配')
    // `buildAgentChange` always stores the array forms; the union narrow is what the wire type needs.
    const baseExtensions = Array.isArray(base.extensions) ? [...base.extensions] : []
    const baseTools = Array.isArray(base.tools) ? [...base.tools] : []
    return {
      ...base,
      extensions: [...baseExtensions, botsExtension],
      tools: [...baseTools, ...(botsExtension.tools ?? [])],
      instructions,
    }
  }

  const createBot = async (input: CreateBotInput): Promise<BotRecord> => {
    assertOpen()
    const name = requireBotName(input.name)
    const module = requireText(input.module, 'module', 120)
    const description = requireText(input.description, 'description', 500)
    const avatarShape = input.avatarShape === undefined || input.avatarShape.trim() === ''
      ? undefined
      : requireText(input.avatarShape, 'avatarShape', 40)
    const avatarColor = input.avatarColor === undefined || input.avatarColor.trim() === ''
      ? undefined
      : requireText(input.avatarColor, 'avatarColor', 40)
    const globs = [...new Set((input.globs ?? []).map(normalizeGlob))]
    if (globs.length === 0) throw new RuntimeError('INVALID_INPUT', 'globs 不能为空')
    if (state().bots.some(candidate => candidate.id === name)) {
      throw new RuntimeError('CONFLICT', `bot「${name}」已存在`)
    }
    if (botsExtension === undefined) throw new RuntimeError('CONFLICT', 'bots 扩展尚未装配')
    const workspace = selectedWorkspace(undefined)
    const accessMode: AccessMode = await workspaceWriteSupported(workspace.path) ? 'workspaceWrite' : 'fullAccess'
    const now = new Date().toISOString()
    const record: BotRecord = {
      id: name,
      name,
      module,
      globs,
      description,
      knowledgePath: knowledgeRelativePath(name),
      ...(input.model === undefined || input.model.trim() === '' ? {} : { model: input.model.trim() }),
      ...(avatarShape === undefined ? {} : { avatarShape }),
      ...(avatarColor === undefined ? {} : { avatarColor }),
      conversationId: '',
      createdAt: now,
      status: 'idle',
      knowledgeHealth: 'unknown',
      compliance: 'pending',
    }
    const content = `${renderFrontmatter({ botId: record.id, module: record.module, globs: record.globs, updatedStamp: now })}${knowledgeSkeleton(record, now)}`
    const absolutePath = knowledgeAbsolutePath(workspace.path, record)
    const hash = knowledgeHash(content)
    try {
      await mkdir(join(workspace.path, ...BOTS_DOC_DIR), { recursive: true })
      await writeFile(absolutePath, content, { encoding: 'utf8' })
    } catch (error) {
      throw new RuntimeError('INVALID_INPUT', `无法写入知识文档：${error instanceof Error ? error.message : String(error)}`)
    }
    const agent = await createBotConversationAgent(workspace.id, accessMode, botSystemPrompt(record))
    const conversation = await harness().createConversation({ ownership: { kind: 'ownerless' }, agent }, CTX)
    const conversationId = String(conversation.id)
    await harness().commit(async tx => {
      const metadata = await tx.doc(META, conversation.id)
      metadata.title = `bot:${name}`
      metadata.titleSource = 'user'
      metadata.workspaceId = workspace.id
      metadata.accessMode = accessMode
      const kind = await tx.doc(CONVERSATION_KIND, conversation.id)
      kind.kind = 'bot'
      const identity = await tx.doc(BotIdentity, conversation.id)
      identity.botId = record.id
      identity.name = record.name
      identity.depth = 1
    }, CTX)
    const stored = await appState.update(draft => {
      if (draft.bots.bots.some(candidate => candidate.id === record.id)) {
        throw new RuntimeError('CONFLICT', `bot「${name}」已存在`)
      }
      // The first bot of an empty team becomes the lead by default; a user can move the pin.
      const rest = draft.bots.bots.some(candidate => candidate.lead === true)
        ? { ...record, conversationId, knowledgeHash: hash }
        : { ...record, conversationId, knowledgeHash: hash, lead: true }
      draft.bots.bots.push(rest)
      return structuredClone(draft.bots.bots.at(-1)!)
    })
    await armWatch(stored)
    return stored
  }

  const updateBot = async (botId: string, input: UpdateBotInput): Promise<BotRecord> => {
    assertOpen()
    const bot = requireBot(botId)
    const module = input.module === undefined ? bot.module : requireText(input.module, 'module', 120)
    const description = input.description === undefined ? bot.description : requireText(input.description, 'description', 500)
    const globs = input.globs === undefined ? bot.globs : [...new Set(input.globs.map(normalizeGlob))]
    if (globs.length === 0) throw new RuntimeError('INVALID_INPUT', 'globs 不能为空')
    const model = input.model === undefined ? bot.model : input.model.trim() === '' ? undefined : input.model.trim()
    const avatarShape = input.avatarShape === undefined
      ? bot.avatarShape
      : input.avatarShape.trim() === '' ? undefined : requireText(input.avatarShape, 'avatarShape', 40)
    const avatarColor = input.avatarColor === undefined
      ? bot.avatarColor
      : input.avatarColor.trim() === '' ? undefined : requireText(input.avatarColor, 'avatarColor', 40)
    const now = new Date().toISOString()
    const content = await readKnowledgeFile(knowledgeAbsolutePath(defaultWorkspacePath(), bot))
    let hash = bot.knowledgeHash
    if (content !== undefined) {
      // Keep the authored body, re-render the frontmatter over the new identity fields.
      hash = await writeKnowledgeFile(knowledgeAbsolutePath(defaultWorkspacePath(), bot), { ...bot, module, globs }, stripFrontmatter(content), now)
    }
    await updateBotRecord(botId, current => {
      current.module = module
      current.globs = globs
      current.description = description
      if (model === undefined) delete current.model
      else current.model = model
      if (avatarShape === undefined) delete current.avatarShape
      else current.avatarShape = avatarShape
      if (avatarColor === undefined) delete current.avatarColor
      else current.avatarColor = avatarColor
      if (hash !== undefined) current.knowledgeHash = hash
    })
    if (input.lead !== undefined) await setBotLead(botId, input.lead)
    const refreshed = requireBot(botId)
    const conversation = await harness().conversation(parseConversationId(refreshed.conversationId), CTX)
    if (conversation !== undefined) await conversation.configure({ instructions: botSystemPrompt(refreshed) }, CTX)
    return refreshed
  }

  /** Promote/demote the team lead; only one bot carries the pin at a time. */
  const setBotLead = async (botId: string, lead: boolean): Promise<void> => {
    assertOpen()
    requireBot(botId)
    await appState.update(draft => {
      for (const candidate of draft.bots.bots) {
        if (candidate.id === botId) {
          if (lead) candidate.lead = true
          else delete candidate.lead
        } else if (lead) {
          delete candidate.lead
        }
      }
    })
  }

  /** The bot's knowledge document body, for the detail pane's library tab. */
  const botKnowledge = async (botId: string): Promise<string | undefined> => {
    assertOpen()
    return await knowledgeBody(requireBot(botId))
  }

  // ── avatar photo ──

  /** Store a cropped 256×256 PNG (data URL) and repoint the record at the versioned file URL. */
  const setBotAvatarImage = async (botId: string, dataUrl: string): Promise<BotRecord> => {
    assertOpen()
    const bot = requireBot(botId)
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl.trim())
    if (match === null) throw new RuntimeError('INVALID_INPUT', '头像必须是 PNG data URL')
    const bytes = Buffer.from(match[1]!, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > BOT_AVATAR_MAX_BYTES) {
      throw new RuntimeError('INVALID_INPUT', '头像大小必须在 1 字节到 512KB 之间')
    }
    const dir = join(deps.dataDir, BOT_AVATAR_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${bot.id}.png`), bytes)
    return updateBotRecord(botId, current => {
      current.avatarImage = `/api/bots/${encodeURIComponent(bot.id)}/avatar?v=${Date.now()}`
    })
  }

  /** Drop the uploaded photo; the procedural silhouette takes over again. */
  const clearBotAvatarImage = async (botId: string): Promise<BotRecord> => {
    assertOpen()
    const bot = requireBot(botId)
    await rm(join(deps.dataDir, BOT_AVATAR_DIR, `${bot.id}.png`), { force: true })
    return updateBotRecord(botId, current => {
      delete current.avatarImage
    })
  }

  /** Raw avatar bytes for GET /api/bots/:id/avatar; undefined when the bot never uploaded one. */
  const botAvatarImageBytes = async (botId: string): Promise<Buffer | undefined> => {
    assertOpen()
    const bot = requireBot(botId)
    try {
      return await readFile(join(deps.dataDir, BOT_AVATAR_DIR, `${bot.id}.png`))
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  // ── bot state: busy/idle edges and compliance ──

  /** Settle one finished participation: a changed document complies, an unchanged one stalled. */
  const settleCompliance = async (bot: BotRecord): Promise<void> => {
    const content = await readKnowledgeFile(knowledgeAbsolutePath(defaultWorkspacePath(), bot))
    if (content === undefined) {
      await updateBotRecord(bot.id, current => { current.compliance = 'stalled' })
      return
    }
    const hash = knowledgeHash(content)
    await updateBotRecord(bot.id, current => {
      if (current.knowledgeHash !== undefined && current.knowledgeHash !== hash) {
        current.compliance = 'complied'
        current.knowledgeHash = hash
      } else if (current.knowledgeHash === undefined) {
        // No baseline recorded (a hand-created roster row): treat the current file as the new one.
        current.compliance = 'complied'
        current.knowledgeHash = hash
      } else {
        current.compliance = 'stalled'
      }
    })
  }

  const onRunStart = async (botId: string): Promise<void> => {
    await updateBotRecord(botId, current => {
      current.status = 'busy'
      current.lastActiveAt = new Date().toISOString()
      current.compliance = 'pending'
    }).catch(() => undefined)
  }

  const onRunEnd = async (botId: string): Promise<void> => {
    const bot = requireBot(botId)
    await updateBotRecord(botId, current => { current.status = 'idle' }).catch(() => undefined)
    await settleCompliance({ ...bot, status: 'idle' }).catch(() => undefined)
  }

  const armWatch = async (bot: BotRecord): Promise<void> => {
    await disarmWatch(bot.id)
    const conversation = await harness().conversation(parseConversationId(bot.conversationId), CTX)
    if (conversation === undefined) return
    const watch = await conversation.watch(CTX)
    let running = liveRunTaskId(watch.value) !== undefined
    watch.start(async view => {
      const next = liveRunTaskId(view) !== undefined
      if (next === running) return
      running = next
      if (next) await onRunStart(bot.id)
      else await onRunEnd(bot.id)
    })
    watches.set(bot.id, { stop: async () => { await watch.stop() }, running })
  }

  const disarmWatch = async (botId: string): Promise<void> => {
    const watch = watches.get(botId)
    if (watch === undefined) return
    watches.delete(botId)
    await watch.stop().catch(() => undefined)
  }

  // ── rooms and delivery ──

  const createRoom = async (input: CreateBotRoomInput): Promise<BotRoomRecord> => {
    assertOpen()
    const name = requireText(input.name, 'name', 120)
    const memberIds = [...new Set((input.memberIds ?? []).map(id => requireBotName(id)))]
    if (memberIds.length === 0) throw new RuntimeError('INVALID_INPUT', '群聊成员不能为空')
    const known = new Set(state().bots.map(bot => bot.id))
    const missing = memberIds.filter(id => !known.has(id))
    if (missing.length > 0) throw new RuntimeError('INVALID_INPUT', `群聊成员不存在：${missing.join('、')}`)
    const id = randomUUID()
    const agent = await deps.buildAgentChange(selectedWorkspace(undefined).id, 'fullAccess')
    const conversation = await harness().createConversation({ ownership: { kind: 'ownerless' }, agent }, CTX)
    const conversationId = String(conversation.id)
    await harness().commit(async tx => {
      const metadata = await tx.doc(META, conversation.id)
      metadata.title = `room:${name}`
      metadata.titleSource = 'user'
      metadata.workspaceId = selectedWorkspace(undefined).id
      metadata.accessMode = 'fullAccess'
      const kind = await tx.doc(CONVERSATION_KIND, conversation.id)
      kind.kind = 'botRoom'
    }, CTX)
    const room: BotRoomRecord = { id, name, conversationId, memberIds, createdAt: new Date().toISOString() }
    await appState.update(draft => { draft.bots.rooms.push(room) })
    return room
  }

  /** The room's recent log entries as parsed frames, newest last. */
  const roomFrames = async (room: BotRoomRecord, limit: number): Promise<BotRoomFrame[]> => {
    const conversation = await harness().conversation(parseConversationId(room.conversationId), CTX)
    if (conversation === undefined) return []
    const page = await conversation.entries({ order: 'descending' }, 200, undefined, CTX)
    const frames: BotRoomFrame[] = []
    for (const entry of page.items) {
      if (entry.kind !== ROOM_ENTRY_KIND) continue
      const frame = parseRoomEntry(entry.data)
      if (frame !== undefined) frames.unshift(frame)
      if (frames.length >= limit) break
    }
    return frames
  }

  /** Append one passive log entry to the room; never submits input, so no model runs. */
  const appendRoomEntry = async (room: BotRoomRecord, frame: BotRoomFrame): Promise<string | undefined> => {
    const conversation = await harness().conversation(parseConversationId(room.conversationId), CTX)
    if (conversation === undefined) return undefined
    const submission = await conversation.submit({
      type: 'write',
      entry: { kind: ROOM_ENTRY_KIND, data: frame as unknown as JsonValue },
    }, CTX)
    const status = await submission.status(CTX)
    return status.type === 'write' ? String(status.entry) : undefined
  }

  /**
   * Deliver one framed message to a bot conversation. The hop depth travels on the bot's
   * identity document: a user-initiated delivery writes 1, a bot's re-mention writes 2, and a
   * bot already at depth 2 relays no further — the edge state survives crashes because the
   * next delivery overwrites it.
   */
  const deliverToBot = async (bot: BotRecord, content: string, requestId: string, depth: number): Promise<void> => {
    const conversation = await harness().conversation(parseConversationId(bot.conversationId), CTX)
    if (conversation === undefined) throw new RuntimeError('NOT_FOUND', `bot「${bot.name}」的会话不存在`)
    await harness().commit(async tx => {
      const identity = await tx.doc(BotIdentity, conversation.id)
      identity.botId = bot.id
      identity.name = bot.name
      identity.depth = depth
    }, CTX)
    await conversation.submit({ type: 'input', content, requestId, whenBusy: 'followUp' }, CTX)
  }

  /** A user post: log `[USER]`, resolve mentions, and deliver one framed message per target. */
  const postToRoom = async (roomId: string, input: BotRoomPostInput): Promise<{ mentioned: string[] }> => {
    assertOpen()
    const room = requireRoom(roomId)
    const text = requireText(input.text, 'text', 20_000)
    const entryId = await appendRoomEntry(room, { sender: { kind: 'user' }, text })
    const { bots } = roster()
    const members = room.memberIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is BotRecord => bot !== undefined)
    const mentioned = parseMentions(text, members.map(bot => bot.name))
    const targets = mentioned.length === 0 ? members : members.filter(bot => mentioned.includes(bot.name))
    const tail = renderRoomTail(await roomFrames(room, ROOM_TAIL_ENTRIES))
    for (const bot of targets) {
      await deliverToBot(
        bot,
        roomDeliveryFrame(room.name, 'user', tail),
        `bot-room:${room.id}:${entryId ?? randomUUID()}:${bot.id}`,
        1,
      )
    }
    return { mentioned: targets.map(bot => bot.name) }
  }

  /** A bot's post_to_room: PASS stays silent, otherwise log `[BOT:name]` and relay mentions. */
  const postAsBot = async (
    bot: BotRecord,
    roomId: string,
    text: string,
  ): Promise<{ silent: boolean; mentioned: string[]; depthLimited: boolean }> => {
    const body = requireText(text, 'text', 20_000)
    // A pass reply stays silent before anything else is validated: it neither logs nor relays.
    if (isPassReply(body)) return { silent: true, mentioned: [], depthLimited: false }
    const room = requireRoom(roomId)
    await appendRoomEntry(room, { sender: { kind: 'bot', name: bot.name }, text: body })
    const conversation = await harness().conversation(parseConversationId(bot.conversationId), CTX)
    const identity = conversation === undefined ? undefined : await harness().snapshot(BotIdentity, conversation.id, CTX)
    const depth = identity?.depth ?? 1
    if (depth >= MAX_DELIVERY_DEPTH) {
      return { silent: false, mentioned: [], depthLimited: true }
    }
    const { bots } = roster()
    const mentioned = parseMentions(body, bots.map(candidate => candidate.name))
    const targets = bots.filter(candidate => candidate.id !== bot.id && mentioned.includes(candidate.name))
    const tail = renderRoomTail(await roomFrames(room, ROOM_TAIL_ENTRIES))
    for (const target of targets) {
      await deliverToBot(
        target,
        roomDeliveryFrame(room.name, bot.name, tail),
        `bot-room:${room.id}:${bot.id}:${randomUUID()}:${target.id}`,
        depth + 1,
      )
    }
    return { silent: false, mentioned: targets.map(candidate => candidate.name), depthLimited: false }
  }

  /** A bot's bot_message: one direct framed delivery with the same hop budget. */
  const directMessage = async (from: BotRecord, toBotName: string, text: string): Promise<{ to: string; depthLimited: boolean }> => {
    const toName = requireBotName(toBotName)
    if (toName === from.id) throw new RuntimeError('INVALID_INPUT', '不能给自己投递消息')
    const target = state().bots.find(candidate => candidate.id === toName)
    if (target === undefined) throw new RuntimeError('NOT_FOUND', `bot「${toName}」不存在`)
    const body = requireText(text, 'text', 20_000)
    const conversation = await harness().conversation(parseConversationId(from.conversationId), CTX)
    const identity = conversation === undefined ? undefined : await harness().snapshot(BotIdentity, conversation.id, CTX)
    const depth = identity?.depth ?? 1
    if (depth >= MAX_DELIVERY_DEPTH) return { to: target.name, depthLimited: true }
    await deliverToBot(
      target,
      [`[DIRECT FROM:${from.name}]`, body].join('\n'),
      `bot-direct:${from.id}:${randomUUID()}:${target.id}`,
      depth + 1,
    )
    return { to: target.name, depthLimited: false }
  }

  /** The room log a `read_room` call returns, one `sender: text` line per entry. */
  const readRoom = async (roomId: string, limit = 50): Promise<string> => {
    const room = requireRoom(roomId)
    const frames = await roomFrames(room, Math.max(1, Math.min(200, Math.floor(limit))))
    if (frames.length === 0) return '（群聊暂无消息）'
    return frames.map(frame => roomFrameText(frame)).join('\n')
  }

  /** The parsed room log frames; the host-side view of the passive entries (never model context). */
  const roomLog = async (roomId: string, limit = 100): Promise<BotRoomFrame[]> => {
    const room = requireRoom(roomId)
    return await roomFrames(room, Math.max(1, Math.min(200, Math.floor(limit))))
  }

  // ── watchdog ──

  const gitCommitsSince = async (workspacePath: string, since: string, globs: readonly string[]): Promise<{ count: number; latest: string } | undefined> => {
    try {
      // `:(glob)` magic is what makes a `src/**` pattern an actual git pathspec.
      const pathspecs = globs.map(glob => `:(glob)${glob}`)
      const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'log', `--since=${since}`, '--oneline', '--', ...pathspecs], { timeout: 10_000, maxBuffer: 1 << 20 })
      const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
      return { count: lines.length, latest: lines[0] ?? '' }
    } catch {
      return undefined
    }
  }

  const checkBot = async (bot: BotRecord, workspacePath: string): Promise<BotWatchdogEntry> => {
    const entry = (health: BotWatchdogEntry['health'], detail: string, suggestion?: string): BotWatchdogEntry => ({
      botId: bot.id, botName: bot.name, knowledgePath: bot.knowledgePath, health, detail,
      ...(suggestion === undefined ? {} : { suggestion }),
    })
    const content = await readKnowledgeFile(knowledgeAbsolutePath(workspacePath, bot))
    if (content === undefined) {
      return entry('unknown', `知识文档缺失：${bot.knowledgePath}`, '重新初始化该 bot，或手动补写知识文档骨架')
    }
    if (!hasFrontmatterBlock(content)) {
      return entry('unknown', '文档缺少 frontmatter（botId/module/globs/updatedStamp）', '按骨架格式补回 frontmatter')
    }
    const frontmatter = parseFrontmatter(content)
    if (frontmatter === undefined) {
      return entry('drift', 'frontmatter 结构损坏：缺少 botId/module 必需字段', '按骨架格式修复 frontmatter')
    }
    const body = stripFrontmatter(content)
    if (body.length > KNOWLEDGE_BODY_CHAR_LIMIT) {
      return entry('over-limit', `正文超过 ${KNOWLEDGE_BODY_CHAR_LIMIT} 字符（当前 ${body.length}）`, '把细节拆到代码注释或其他文档，正文只保留结论与索引')
    }
    if (frontmatter.updatedStamp === undefined) {
      return entry('fresh', '缺少 updatedStamp，跳过 git 新鲜度检查；结构检查通过', '在 frontmatter 补上 updatedStamp 以启用 git 检查')
    }
    const commits = await gitCommitsSince(workspacePath, frontmatter.updatedStamp, bot.globs)
    if (commits === undefined) {
      return entry('fresh', '工作区不是 git 仓库或 git 不可用；结构检查通过')
    }
    if (commits.count >= 1) {
      return entry(
        'stale',
        `自 ${frontmatter.updatedStamp} 以来关注路径有 ${commits.count} 条新提交；最近一条：${commits.latest}`,
        '用 git log/diff 增量刷新本文档',
      )
    }
    return entry('fresh', `自 ${frontmatter.updatedStamp} 以来关注路径无新提交`)
  }

  const writeWatchdogReportFile = async (report: BotWatchdogReport): Promise<void> => {
    const dir = join(deps.dataDir, WATCHDOG_REPORT_DIR)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), { encoding: 'utf8' })
  }

  const runWatchdog = async (options: { refreshStale?: boolean } = {}): Promise<BotWatchdogReport> => {
    assertOpen()
    if (watchdogRun !== undefined) return await watchdogRun
    const run = (async (): Promise<BotWatchdogReport> => {
      const workspacePath = defaultWorkspacePath()
      const bots = state().bots
      const entries: BotWatchdogEntry[] = []
      for (const bot of bots) {
        try {
          entries.push(await checkBot(bot, workspacePath))
        } catch (error) {
          entries.push({
            botId: bot.id, botName: bot.name, knowledgePath: bot.knowledgePath, health: 'unknown',
            detail: `检查失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
          })
        }
      }
      const report: BotWatchdogReport = { runAt: new Date().toISOString(), entries }
      await appState.update(draft => {
        draft.bots.watchdog = { lastRunAt: report.runAt, report }
        for (const item of entries) {
          const bot = draft.bots.bots.find(candidate => candidate.id === item.botId)
          if (bot !== undefined) bot.knowledgeHealth = item.health
        }
      })
      await writeWatchdogReportFile(report).catch(() => undefined)
      if (options.refreshStale === true) await refreshStaleBots(bots, report)
      return report
    })()
    watchdogRun = run
    try {
      return await run
    } finally {
      watchdogRun = undefined
    }
  }

  /** Submit one refresh instruction per stale bot; request ids are keyed by report run time. */
  const refreshStaleBots = async (bots: readonly BotRecord[], report: BotWatchdogReport): Promise<void> => {
    for (const item of report.entries) {
      if (item.health !== 'stale') continue
      const bot = bots.find(candidate => candidate.id === item.botId)
      if (bot === undefined) continue
      const documentText = await readKnowledgeFile(knowledgeAbsolutePath(defaultWorkspacePath(), bot))
      if (documentText === undefined) continue
      try {
        await deliverToBot(
          bot,
          watchdogRefreshPrompt(bot, item.detail, documentText),
          `bot-watchdog:${bot.id}:${report.runAt}`,
          1,
        )
      } catch {
        // One failed refresh must not stop the remaining stale bots from being refreshed.
      }
    }
  }

  const lastWatchdogRun = (): { lastRunAt?: string; report?: BotWatchdogReport } => {
    const { lastRunAt, report } = state().watchdog
    return { ...(lastRunAt === undefined ? {} : { lastRunAt }), ...(report === undefined ? {} : { report }) }
  }

  const watchdogIntervalMs = (): number => state().config.watchdogIntervalMs

  /** (Re)arm the in-process watchdog timer; interval 0 clears it. */
  const scheduleWatchdog = (): void => {
    scheduler.cancel('bots-watchdog')
    const interval = watchdogIntervalMs()
    if (interval <= 0) return
    scheduler.schedule('bots-watchdog', Date.now() + interval, () => {
      void runWatchdog({ refreshStale: false })
        .catch(() => undefined)
        .finally(() => {
          if (!closed && watchdogIntervalMs() > 0) scheduleWatchdog()
        })
    })
  }

  const updateConfig = async (input: { watchdogIntervalMs: number }): Promise<{ config: { watchdogIntervalMs: number } }> => {
    assertOpen()
    const interval = input.watchdogIntervalMs
    if (!Number.isSafeInteger(interval) || interval < 0) throw new RuntimeError('INVALID_INPUT', 'watchdogIntervalMs 必须是非负整数')
    await appState.update(draft => { draft.bots.config.watchdogIntervalMs = interval })
    scheduleWatchdog()
    return { config: { watchdogIntervalMs: interval } }
  }

  // ── initialization ──

  const overview = (): BotTeamOverview => {
    const current = state()
    return {
      bots: current.bots,
      rooms: current.rooms,
      watchdog: lastWatchdogRun(),
      init: {
        running: current.init.running,
        ...(current.init.conversationId === undefined ? {} : { conversationId: current.init.conversationId }),
        ...(current.init.error === undefined ? {} : { error: current.init.error }),
      },
      config: { watchdogIntervalMs: current.config.watchdogIntervalMs },
    }
  }

  const initBots = async (input: BotInitInput): Promise<{ ok: true }> => {
    assertOpen()
    const mode = input.mode ?? 'orchestrator'
    if (state().init.running) throw new RuntimeError('CONFLICT', 'bot 团队初始化正在进行中')
    if (state().bots.length > 0) return { ok: true }
    if (mode === 'preset') {
      await initPreset()
      return { ok: true }
    }
    await initOrchestrator()
    return { ok: true }
  }

  const initPreset = async (): Promise<void> => {
    const presets: Array<CreateBotInput> = [
      { name: 'Atlas', module: 'server', globs: ['src/server/**'], description: '负责 src/server 服务端（runtime、工具、HTTP、自动化）的模块知识与协作。' },
      { name: 'Aurora', module: 'web', globs: ['src/web/**'], description: '负责 src/web 前端界面与交互的模块知识与协作。' },
      { name: 'Kepler', module: 'shared', globs: ['src/shared/**'], description: '负责 src/shared 前后端共享类型与协议契约的模块知识与协作。' },
    ]
    const created: string[] = []
    for (const preset of presets) {
      const bot = await createBot(preset)
      created.push(bot.id)
    }
    await createRoom({ name: '全队', memberIds: created })
  }

  const initOrchestrator = async (): Promise<void> => {
    if (botsExtension === undefined) throw new RuntimeError('CONFLICT', 'bots 扩展尚未装配')
    const workspace = selectedWorkspace(undefined)
    const accessMode: AccessMode = await workspaceWriteSupported(workspace.path) ? 'workspaceWrite' : 'fullAccess'
    await appState.update(draft => {
      draft.bots.init = { running: true }
    })
    const startedAt = Date.now()
    const task = (async (): Promise<void> => {
      let conversationId: string | undefined
      try {
        const agent = await createBotConversationAgent(workspace.id, accessMode, botInitSystemPrompt())
        const conversation = await harness().createConversation({ ownership: { kind: 'ownerless' }, agent }, CTX)
        conversationId = String(conversation.id)
        const created = conversation.id
        await harness().commit(async tx => {
          const metadata = await tx.doc(META, created)
          metadata.title = 'Bot 团队初始化'
          metadata.titleSource = 'user'
          metadata.workspaceId = workspace.id
          metadata.accessMode = accessMode
          const kind = await tx.doc(CONVERSATION_KIND, created)
          kind.kind = 'botInit'
        }, CTX)
        await appState.update(draft => { draft.bots.init.conversationId = conversationId })
        await conversation.submit({
          type: 'input',
          content: botInitSubmission(),
          requestId: `bot-init:${startedAt}`,
          whenBusy: 'followUp',
        }, CTX)
        await conversation.waitForIdle(CTX)
        // A finished run is not a successful init: a model failure (e.g. a provider
        // 429) ends the run without creating anything, which must surface as init.error.
        const failure = state().bots.length === 0
          ? (await deps.conversationError(conversationId)) ?? 'orchestrator 会话结束但未创建任何 bot'
          : undefined
        await appState.update(draft => {
          draft.bots.init = failure === undefined
            ? { running: false, conversationId }
            : { running: false, conversationId, error: failure.slice(0, 500) }
        })
      } catch (error) {
        await appState.update(draft => {
          draft.bots.init = {
            running: false,
            ...(conversationId === undefined ? {} : { conversationId }),
            error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          }
        }).catch(() => undefined)
      }
    })()
    tasks.add(task)
    void task.finally(() => { tasks.delete(task) }).catch(() => undefined)
  }

  /** Called by the orchestrator's finish_init tool; the run-end edge clears `running`. */
  const finishInitFromOrchestrator = async (summary: string): Promise<{ ok: true }> => {
    requireText(summary, 'summary', 4_000)
    return { ok: true }
  }

  // ── startup reconciliation and close ──

  /**
   * Startup recovery: settle every bot whose `busy` edge survived a crash, re-arm watches,
   * clear an init that lost its process, and re-arm the watchdog timer. A bot that is idle
   * stays as it was — the compliance edge only fires for a run that actually started.
   */
  const reconcile = async (): Promise<void> => {
    for (const bot of state().bots) {
      try {
        const conversation = await harness().conversation(parseConversationId(bot.conversationId), CTX)
        if (conversation === undefined) continue
        const watch = await conversation.watch(CTX)
        const running = liveRunTaskId(watch.value) !== undefined
        await watch.stop().catch(() => undefined)
        if (!running && bot.status === 'busy') await onRunEnd(bot.id)
        await armWatch(bot)
      } catch {
        // One broken bot must not stop the remaining rosters from being reconciled.
      }
    }
    if (state().init.running) {
      await appState.update(draft => {
        draft.bots.init = {
          running: false,
          ...(draft.bots.init.conversationId === undefined ? {} : { conversationId: draft.bots.init.conversationId }),
          error: '服务在初始化期间重启，请重新发起初始化。',
        }
      })
    }
    scheduleWatchdog()
  }

  let closed = false
  const close = async (): Promise<void> => {
    closed = true
    scheduler.close()
    const stops = [...watches.values()].map(watch => watch.stop().catch(() => undefined))
    watches.clear()
    await Promise.allSettled(stops)
    await Promise.race([
      Promise.allSettled([...tasks]),
      new Promise<void>(resolveTimer => { const timer = setTimeout(resolveTimer, 60_000); timer.unref?.() }),
    ])
  }

  return {
    attachExtension: (extension: Extension): void => { botsExtension = extension },
    roster,
    knowledgeBody,
    botKnowledge,
    setBotLead,
    createBot,
    updateBot,
    setBotAvatarImage,
    clearBotAvatarImage,
    botAvatarImageBytes,
    overview,
    initBots,
    finishInitFromOrchestrator,
    updateConfig,
    createRoom,
    postToRoom,
    postAsBot,
    directMessage,
    readRoom,
    roomLog,
    runWatchdog,
    lastWatchdogRun,
    reconcile,
    close,
  }
}

/** The first submission that starts the orchestrator run. */
function botInitSubmission(): string {
  return [
    '[bot-init] 开始初始化模块 bot 团队。',
    '按你的编排指令执行：侦察工作区与近期提交，提出 3-6 个模块切分，逐模块 bot_create 并写知识文档初版，最后 finish_init 总结。',
  ].join('\n')
}
