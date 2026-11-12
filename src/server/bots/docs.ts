/**
 * The module-bot knowledge document protocol: frontmatter parse/serialize, the skeleton a new
 * bot starts from, and the content hash the compliance check compares. Files live inside the
 * workspace at `docs/bots/<botId>.md`; every read is an ordinary bounded file read, not a
 * second permission system.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { BotRecord } from '../../shared/types.ts'

/** The body bound the watchdog checks (frontmatter excluded) and the identity section truncates at. */
export const KNOWLEDGE_BODY_CHAR_LIMIT = 8_000

/** Relative directory (workspace-relative) holding one knowledge document per bot. */
export const BOTS_DOC_DIR = ['docs', 'bots'] as const

export type KnowledgeFrontmatter = {
  botId: string
  module: string
  globs: string[]
  updatedStamp?: string
}

const FRONTMATTER = /^(\uFEFF?)---[ \t]*(\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/u

/** Absolute path of one bot's knowledge document inside the workspace. */
export function knowledgeAbsolutePath(workspacePath: string, bot: Pick<BotRecord, 'knowledgePath'>): string {
  return resolve(workspacePath, bot.knowledgePath)
}

/** The workspace-relative knowledge path a bot id maps to. */
export function knowledgeRelativePath(botId: string): string {
  return [...BOTS_DOC_DIR, `${botId}.md`].join('/')
}

/** Whether the content carries a leading frontmatter block at all. */
export function hasFrontmatterBlock(content: string): boolean {
  return FRONTMATTER.exec(content) !== null
}

/** Parse the leading frontmatter block; `undefined` when there is none or required fields are missing. */
export function parseFrontmatter(content: string): KnowledgeFrontmatter | undefined {
  const match = FRONTMATTER.exec(content)
  if (match === null) return undefined
  const fields: Record<string, string> = {}
  for (const rawLine of (match[3] ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  if (fields.botId === undefined || fields.module === undefined) return undefined
  let globs: string[] = []
  const globsRaw = fields.globs ?? ''
  if (globsRaw.startsWith('[') && globsRaw.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(globsRaw)
      if (Array.isArray(parsed)) globs = parsed.filter((item): item is string => typeof item === 'string')
    } catch {
      globs = globsRaw.slice(1, -1).split(',').map(item => item.trim().replace(/^["']|["']$/gu, '')).filter(item => item !== '')
    }
  }
  return {
    botId: fields.botId,
    module: fields.module,
    globs,
    ...(fields.updatedStamp === undefined ? {} : { updatedStamp: fields.updatedStamp }),
  }
}

/** The document body with the frontmatter block stripped (unchanged when there is none). */
export function stripFrontmatter(content: string): string {
  const match = FRONTMATTER.exec(content)
  return match === null ? content : content.slice(match[0].length)
}

export function knowledgeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Bounded read of one knowledge document; `undefined` when the file is missing or unreadable. */
export async function readKnowledgeFile(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

/** Serialize frontmatter fields as one YAML block. */
export function renderFrontmatter(frontmatter: KnowledgeFrontmatter): string {
  return [
    '---',
    `botId: ${frontmatter.botId}`,
    `module: ${frontmatter.module}`,
    `globs: ${JSON.stringify(frontmatter.globs)}`,
    ...(frontmatter.updatedStamp === undefined ? [] : [`updatedStamp: ${frontmatter.updatedStamp}`]),
    '---',
    '',
  ].join('\n')
}

/** The skeleton body a freshly created bot starts from (no frontmatter; the writer prepends it). */
export function knowledgeSkeleton(bot: Pick<BotRecord, 'id' | 'name' | 'module' | 'globs' | 'description'>, now: string): string {
  return [
    `# ${bot.name}（${bot.module}）知识文档`,
    '',
    `> ${bot.description}`,
    '',
    '## 职责',
    '',
    `- 负责 \`${bot.module}\` 模块（关注路径：${bot.globs.map(glob => `\`${glob}\``).join('、')}）。`,
    '- 参与群聊协作后，把新得出的模块知识增量写回本文档。',
    '',
    '## 关键文件',
    '',
    '- （待补充：入口文件、核心路径与职责一句话说明）',
    '',
    '## 已知坑',
    '',
    '- （待补充：容易踩的边界、历史修复中发现的非显而易见约束）',
    '',
    '## changelog',
    '',
    `- ${now} 由宿主创建骨架。`,
    '',
  ].join('\n')
}

/** Atomically replace the knowledge document (frontmatter re-rendered) and return its new hash. */
export async function writeKnowledgeFile(
  absolutePath: string,
  bot: Pick<BotRecord, 'id' | 'name' | 'module' | 'globs'>,
  body: string,
  now: string,
): Promise<string> {
  const content = `${renderFrontmatter({
    botId: bot.id,
    module: bot.module,
    globs: bot.globs,
    updatedStamp: now,
  })}${body}`
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o755 })
  const temporary = join(dirname(absolutePath), `.tmp-bot-${process.pid}-${Date.now()}`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, absolutePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return knowledgeHash(content)
}
