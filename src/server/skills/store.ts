import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import type {
  SkillCatalog,
  SkillContent,
  SkillSaveInput,
  SkillSaveResult,
  SkillSummary,
  SkillValidation,
} from '../../shared/skills.ts'
import { RuntimeError } from '../runtime-errors.ts'

const MAX_SKILL_BYTES = 64 * 1024
const MAX_FRONTMATTER_BYTES = 16 * 1024
const MAX_DESCRIPTION_LENGTH = 1_024
const MAX_WHEN_TO_USE_LENGTH = 1_024
const MAX_ROOT_ENTRIES = 500
const MAX_RESOURCE_FILES = 500
const MAX_RESOURCE_DEPTH = 16
const MAX_RESOURCE_BYTES = 64 * 1024
const MAX_YAML_ALIASES = 16
const TEMP_FILE_PREFIX = '.skill-save-'
/** 技能名格式：小写 kebab-case。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Windows 保留设备名，作为技能名时拒绝。 */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

type SkillSource = SkillSummary['source']
/**
 * 一个发现根。工作区根（`agents`/`pi`）带 `base`：该根挂靠的工作区层级，可以是
 * 工作区到仓库根之间的任何祖先（ZCode 式分层发现）。
 */
export interface SkillRoot { source: SkillSource; path: string; pluginId?: string; pluginName?: string; base?: string }
/** 一个具体技能目录（根 + 目录名 + 规范化路径）。 */
interface SkillDirectory extends SkillRoot { name: string; directory: string; skillPath: string }
/** SKILL.md 的解析结果；errors 丢弃技能，warnings 只影响路由质量。 */
interface SkillDocument {
  name?: string
  description?: string
  whenToUse?: string
  body: string
  warnings: string[]
  errors: string[]
}

export interface SkillStoreOptions {
  /** 随包内置、只读的技能。默认取仓库顶层 `skills/` 目录。 */
  builtinRoot?: string
  /** 用户级（全局）技能，只读；默认无。生产环境锚定 `~/.pi-web/skills`。 */
  globalRoot?: string
  /**
   * 共享用户级技能，只读；默认无。锚定 `~/.agents/skills`——ZCode、pi 与 opencode
   * 都读的跨 agent 约定。单列一个来源，让用户副本与工作区 `.agents/skills` 副本
   * 在目录里可区分。
   */
  userAgentsRoot?: string
  /** 已启用插件的技能根；每次目录/列表操作都会读取。 */
  pluginRoots?: () => readonly SkillRoot[]
}

/** 判断 target 是否位于 root 内（含等于 root），防路径逃逸。 */
function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** 判断错误是否为 ENOENT（路径不存在）。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** 取错误的 message 文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown filesystem error'
}

/** 内容的 sha256 十六进制指纹（作为技能版本号）。 */
function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 校验技能名格式与 Windows 保留名，返回错误列表（空列表表示合法）。 */
function validateSkillName(name: string): string[] {
  const errors: string[] = []
  if (name.length < 1 || name.length > 64 || !SKILL_NAME.test(name)) {
    errors.push('name must be 1 to 64 characters in lowercase kebab-case')
  }
  if (WINDOWS_RESERVED_NAME.test(name)) errors.push('name is reserved on Windows')
  return errors
}

/** 技能内相对路径安全化：拒绝超长、NUL、反斜杠、绝对路径、盘符与 `..` 上跳。 */
function safeRelativePath(value: string): string {
  if (
    value.length > 2_048
    || value.includes('\u0000')
    || value.includes('\\')
    || isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
  ) {
    throw new RuntimeError('FORBIDDEN', 'Skill resource path must be relative to its skill directory')
  }
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) {
    throw new RuntimeError('FORBIDDEN', 'Skill resource path cannot leave its skill directory')
  }
  return segments.join('/')
}

/**
 * 功能：按 ZCode 的两级失败模型解析 SKILL.md：`errors` 丢弃技能，`warnings` 只是
 * 路由质量提示。
 * @param content SKILL.md 原文
 * @param expectedName 目录名（查找键）
 * @returns 解析结果
 * 内部逻辑：全文 ≤ 64 KB；无 frontmatter 的文件照常加载（以目录名命名、描述为空）；
 * frontmatter 存在但缺 `name`/`description`（或描述超限）则丢弃；YAML 坏行跳过记
 * warning；frontmatter name 与目录名不一致时以目录名为准并给 warning。
 */
function parseSkillDocument(content: string, expectedName: string): SkillDocument {
  const errors: string[] = []
  const warnings: string[] = []
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    return { body: '', warnings, errors: [`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`] }
  }

  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { name: expectedName, description: '', body: normalized, warnings, errors }
  }

  const openingEnd = normalized.indexOf('\n') + 1
  const closingMatch = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(normalized.slice(openingEnd))
  if (!closingMatch || closingMatch.index === undefined) {
    // 未闭合的分隔符不可能是 frontmatter；按无 frontmatter 处理。
    warnings.push('SKILL.md starts with --- but has no closing delimiter; treating it as frontmatter-free')
    return { name: expectedName, description: '', body: normalized, warnings, errors }
  }
  const frontmatter = normalized.slice(openingEnd, openingEnd + closingMatch.index)
  if (Buffer.byteLength(frontmatter, 'utf8') > MAX_FRONTMATTER_BYTES) {
    return { body: '', warnings, errors: [`YAML frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`] }
  }
  const bodyOffset = openingEnd + closingMatch.index + closingMatch[0].length
  const body = normalized.slice(bodyOffset).replace(/^\r?\n/, '')
  if (!body.trim()) warnings.push('SKILL.md body is empty')

  let metadata: unknown
  try {
    const document = parseDocument(frontmatter, { uniqueKeys: true, version: '1.2' })
    // 坏行被跳过而不是丢弃技能（ZCode 行为）。
    warnings.push(...document.errors.map(issue => `invalid YAML frontmatter: ${issue.message}`))
    warnings.push(...document.warnings.map(issue => `YAML frontmatter: ${issue.message}`))
    metadata = document.toJS({ maxAliasCount: MAX_YAML_ALIASES })
  } catch (error) {
    errors.push(`invalid YAML frontmatter: ${errorMessage(error)}`)
  }

  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    errors.push('frontmatter must be a mapping with name and description')
    return { body, warnings, errors }
  }

  const fields = metadata as Record<string, unknown>
  const rawName = typeof fields.name === 'string' ? fields.name.trim() : ''
  const name = rawName === '' ? undefined : rawName
  const description = typeof fields.description === 'string' ? fields.description : undefined
  let whenToUse = typeof fields.when_to_use === 'string' ? fields.when_to_use.trim() : undefined
  if (whenToUse !== undefined && whenToUse.length > MAX_WHEN_TO_USE_LENGTH) {
    warnings.push(`when_to_use exceeds ${MAX_WHEN_TO_USE_LENGTH} characters and was ignored`)
    whenToUse = undefined
  }
  if (name === undefined) errors.push('frontmatter name must be a non-empty string')
  else {
    if (!SKILL_NAME.test(name)) warnings.push('frontmatter name is not lowercase kebab-case')
    if (name !== expectedName) warnings.push(`frontmatter name "${name}" differs from its directory name "${expectedName}"; the directory name stays the lookup key`)
  }
  if (description === undefined) errors.push('frontmatter description must be a string')
  else if (description.length > MAX_DESCRIPTION_LENGTH) errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`)
  else if (!description.trim()) warnings.push('frontmatter description is empty; the model has little to match on')
  return { name, description, whenToUse: whenToUse === undefined || whenToUse === '' ? undefined : whenToUse, body, warnings, errors }
}

/** 由技能目录构造目录条目摘要：插件技能 ID 为 `pluginId:目录名`，其余为 `source:目录名`；仅 agents 来源可写。 */
function summary(directory: SkillDirectory, name: string, description: string, version: string, whenToUse?: string): SkillSummary {
  const id = directory.source === 'plugin' && directory.pluginId !== undefined
    ? `${directory.pluginId}:${directory.name}`
    : `${directory.source}:${directory.name}`
  return {
    id,
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    source: directory.source,
    path: directory.skillPath,
    version,
    writable: directory.source === 'agents',
    ...(directory.pluginId === undefined ? {} : { pluginId: directory.pluginId }),
    ...(directory.pluginName === undefined ? {} : { pluginName: directory.pluginName }),
  }
}

/** 判断是否为本应用的保存临时文件（`.skill-save-*.tmp`），扫描资源时跳过。 */
function isTemporaryFile(name: string): boolean {
  return name.startsWith(TEMP_FILE_PREFIX) && name.endsWith('.tmp')
}

/** 提取 Markdown 正文里的本地链接（内联 + 引用式）；先剥掉代码块与行内代码——代码示例不是资源依赖。 */
function extractLocalMarkdownLinks(markdown: string): string[] {
  // 代码示例只是示例，不是资源依赖。
  const text = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:`{3,}|~{3,})[ \t]*$/gm, '')
    .replace(/(`+)[^`\n]*?\1/g, '')
  const links: string[] = []
  const patterns = [
    /!?\[[^\]]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+[^)]*)?\)/g,
    /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>\n]+>|\S+)/gm,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]?.replace(/^<|>$/g, '')
      if (raw) links.push(raw)
    }
  }
  return links
}

/** 归一化一个本地 Markdown 引用：跳过锚点与远程协议（undefined），拒绝盘符/绝对路径/反斜杠，返回技能内相对路径。 */
function normalizeMarkdownReference(reference: string): string | undefined {
  const trimmed = reference.trim()
  if (!trimmed || trimmed.startsWith('#')) return undefined
  if (/^[A-Za-z]:/.test(trimmed)) throw new RuntimeError('FORBIDDEN', 'Markdown resource link cannot use a drive-qualified path')
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) return undefined
  if (trimmed.startsWith('/') || trimmed.includes('\\')) {
    throw new RuntimeError('FORBIDDEN', 'Markdown resource link must stay inside its skill directory')
  }
  let path = trimmed.split(/[?#]/, 1)[0] ?? ''
  try { path = decodeURIComponent(path) } catch {
    throw new RuntimeError('INVALID_INPUT', 'Markdown resource link has invalid percent encoding')
  }
  if (path === '') return undefined
  return safeRelativePath(path)
}

/**
 * 功能：读取一个有大小上限的常规文件。
 * 平台差异：符号链接会被跟随（与 ZCode/pi/opencode 一致）；inode 前后比对仍能
 * 发现「大小探测与读取之间文件被换掉」的情况。
 * @returns 文件内容（必须为合法 UTF-8 且 ≤ maxBytes，否则抛错）
 */
async function readBoundedBuffer(path: string, maxBytes: number): Promise<Buffer> {
  const before = await stat(path)
  if (!before.isFile()) throw new RuntimeError('INVALID_INPUT', 'Skill resource must be a regular file')
  if (before.size > maxBytes) throw new RuntimeError('INVALID_INPUT', `Skill file exceeds ${maxBytes} bytes`)
  const handle = await open(path, constants.O_RDONLY)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new RuntimeError('INVALID_INPUT', 'Skill resource must be a regular file')
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new RuntimeError('CONFLICT', 'Skill file changed while it was being opened')
    if (opened.size > maxBytes) throw new RuntimeError('INVALID_INPUT', `Skill file exceeds ${maxBytes} bytes`)
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead <= maxBytes) {
      const result = await handle.read(buffer, bytesRead, maxBytes + 1 - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > maxBytes || (await handle.stat()).size > maxBytes) {
      throw new RuntimeError('INVALID_INPUT', `Skill file exceeds ${maxBytes} bytes`)
    }
    const after = await stat(path)
    if (after.dev !== opened.dev || after.ino !== opened.ino) throw new RuntimeError('CONFLICT', 'Skill file changed while it was being read')
    const content = buffer.subarray(0, bytesRead)
    try { new TextDecoder('utf-8', { fatal: true }).decode(content) } catch {
      throw new RuntimeError('INVALID_INPUT', 'Skill file must be valid UTF-8')
    }
    return Buffer.from(content)
  } finally {
    await handle.close()
  }
}

/** readBoundedBuffer 的 UTF-8 字符串版本。 */
async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const content = await readBoundedBuffer(path, maxBytes)
  return content.toString('utf8')
}

/**
 * 功能：为只读发现解析目录。
 * 平台差异：ZCode、pi 与 opencode 都跟随符号链接的技能根与技能目录，因此链进
 * `~/.agents/skills`（或工作区 `.agents/skills`）的 dotfiles 仓库表现得像真实目录。
 * 写入保持严格：save() 用 checkedDirectory()，仍然拒绝穿过符号链接写。
 * @returns realpath 后的规范路径；目录不存在返回 undefined
 */
async function readDirectory(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'Skill path contains a non-directory')
    // 返回规范路径，资源包含性比较用真实路径而不是链接路径。
    return await realpath(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * 功能：写路径专用：逐段（lstat）向下走，任何一段是符号链接即 FORBIDDEN；缺段且
 * create=true 时按 0o700 逐级创建；最终 realpath 必须仍在 root 内。
 * @returns 规范化路径；段不存在且不允许创建时返回 undefined
 */
async function checkedDirectory(root: string, segments: string[], create: boolean): Promise<string | undefined> {
  let cursor = root
  for (const segment of segments) {
    cursor = join(cursor, segment)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Skill directories cannot be symbolic links')
      if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'Skill path contains a non-directory')
    } catch (error) {
      if (!isMissing(error)) throw error
      if (!create) return undefined
      try {
        await mkdir(cursor, { mode: 0o700 })
      } catch (mkdirError) {
        if (!(typeof mkdirError === 'object' && mkdirError !== null && 'code' in mkdirError && mkdirError.code === 'EEXIST')) throw mkdirError
      }
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Skill directories cannot be symbolic links')
      if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'Skill path contains a non-directory')
    }
  }
  const canonical = await realpath(cursor)
  if (!isWithin(root, canonical)) throw new RuntimeError('FORBIDDEN', 'Skill path escapes its configured root')
  return canonical
}

/** 逐段验证路径不含符号链接且全为目录（builtin 根的只读校验），返回 realpath。 */
async function assertNoSymlinkComponents(path: string): Promise<string> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const segments = relative(root, absolute).split(sep).filter(Boolean)
  let cursor = root
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Skill roots cannot be symbolic links')
    if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'Skill root path must contain only directories')
    if (index === segments.length - 1) break
  }
  return realpath(absolute)
}

/** 流式枚举目录条目名，超过 limit 立即抛错（防巨目录拖垮扫描）。 */
async function* boundedNames(directory: string, limit: number): AsyncGenerator<string> {
  const handle = await opendir(directory)
  try {
    let count = 0
    for await (const entry of handle) {
      count += 1
      if (count > limit) throw new RuntimeError('INVALID_INPUT', `Directory contains more than ${limit} entries`)
      yield entry.name
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * 技能存储：五个根按固定顺序扫描与遮蔽（shadow）。
 *
 * 扫描顺序（先发现者胜出，load 与 list 的去重都按此顺序）：builtin（仓库 `skills/`，
 * 只读）→ global（`~/.pi-web/skills`，只读）→ user-agents（`~/.agents/skills`，只读）
 * → 工作区分层根（从工作区向仓库根逐层，每层 `.pi-web/skills` 在 `.agents/skills`
 * 之前；同名时更深的层赢）→ 插件技能根（每次操作即时取用）。
 *
 * 写边界：只有工作区的 `.agents/skills/<名>/SKILL.md` 可写（save()），且要求
 * kebab-case 名称、canonical frontmatter、无符号链接、逐段校验 + 原子写；
 * builtin / global / user-agents / 插件根一律只读。
 */
export class SkillStore {
  private readonly builtinRoot: string
  private readonly globalRoot: string | undefined
  private readonly userAgentsRoot: string | undefined
  private readonly pluginRoots: () => readonly SkillRoot[]
  private readonly writeTails = new Map<string, Promise<void>>()

  /** 固定五根配置；未提供的用户级根视为不存在。 */
  constructor(options: SkillStoreOptions = {}) {
    this.builtinRoot = resolve(options.builtinRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../../../skills'))
    this.globalRoot = options.globalRoot === undefined ? undefined : resolve(options.globalRoot)
    this.userAgentsRoot = options.userAgentsRoot === undefined ? undefined : resolve(options.userAgentsRoot)
    this.pluginRoots = options.pluginRoots ?? (() => [])
  }

  /**
   * 功能：按五根顺序扫描全部技能，产出目录与诊断。
   * @param workspace 工作区路径（分层工作区根的起点）
   * @returns SkillCatalog：skills 去重（同 ID 保留先发现者）并按名称排序；diagnostics 按路径排序
   * 内部逻辑：每个根先经 rootPath 解析（缺失/非法跳过并记诊断），条目数上限 500；
   * 技能目录跟随符号链接（stat + realpath）；SKILL.md 缺失的目录不是技能；解析
   * 出错的文档记诊断。
   */
  async list(workspace: string): Promise<SkillCatalog> {
    const workspaceRoot = await this.workspaceRoot(workspace)
    const skills: SkillSummary[] = []
    const diagnostics: SkillCatalog['diagnostics'] = []
    for (const root of this.roots(workspaceRoot)) {
      const rootPath = await this.rootPath(root, workspaceRoot, diagnostics)
      if (!rootPath) continue
      let names: string[]
      try {
        names = []
        for await (const name of boundedNames(rootPath, MAX_ROOT_ENTRIES)) names.push(name)
      } catch (error) {
        diagnostics.push({ path: rootPath, message: `cannot enumerate skill root: ${errorMessage(error)}` })
        continue
      }
      for (const name of names) {
        const directoryPath = join(rootPath, name)
        let info
        try {
          // 此处跟随符号链接，与 ZCode/pi/opencode 的发现一致；悬空链接即 ENOENT。
          info = await stat(directoryPath)
        } catch (error) {
          if (isMissing(error)) continue
          diagnostics.push({ path: directoryPath, message: errorMessage(error) })
          continue
        }
        if (!info.isDirectory()) continue
        // 目录名不做格式检查（ZCode 按文件路径加载技能）；本应用创建的仍由
        // `save` 强制 kebab-case。
        let canonicalDirectory: string
        try {
          canonicalDirectory = await realpath(directoryPath)
        } catch (error) {
          if (isMissing(error)) continue
          diagnostics.push({ path: directoryPath, message: errorMessage(error) })
          continue
        }
        const skillDirectory: SkillDirectory = { ...root, name, directory: canonicalDirectory, skillPath: join(canonicalDirectory, 'SKILL.md') }
        try {
          const bytes = await readBoundedBuffer(skillDirectory.skillPath, MAX_SKILL_BYTES)
          const raw = bytes.toString('utf8')
          const document = parseSkillDocument(raw, name)
          if (document.errors.length > 0) {
            diagnostics.push({ path: skillDirectory.skillPath, message: document.errors.join('; ') })
            continue
          }
          skills.push(summary(skillDirectory, document.name!, document.description!, hash(bytes), document.whenToUse))
        } catch (error) {
          // 没有 SKILL.md 的目录不算技能（ZCode/opencode 行为）；只有真正损坏的
          // 文档才值得记一条诊断。
          if (isMissing(error)) continue
          diagnostics.push({ path: join(directoryPath, 'SKILL.md'), message: errorMessage(error) })
        }
      }
    }
    // 同 ID 被遮蔽的副本（同名出现在多个工作区层级）折叠为发现顺序中的第一个——
    // 也就是会实际加载的那个；目录保持「可加载集合」。去重后再排序，展示顺序稳定。
    const seen = new Set<string>()
    const unique: SkillSummary[] = []
    for (const skill of skills) {
      if (seen.has(skill.id)) continue
      seen.add(skill.id)
      unique.push(skill)
    }
    unique.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
    diagnostics.sort((left, right) => left.path.localeCompare(right.path))
    return { skills: unique, diagnostics }
  }

  /**
   * 功能：加载一个技能的正文或其某个资源文件。
   * @param id 技能 ID（`source:名` / `pluginId:名` 或裸目录名，按五根顺序遮蔽解析）
   * @param resource 相对资源路径；缺省或 'SKILL.md' 读技能正文
   * @returns 技能摘要、资源名、内容与资源文件清单（正文 ≤ 64 KB、资源 ≤ 64 KB）
   */
  async load(workspace: string, id: string, resource = 'SKILL.md'): Promise<SkillContent> {
    const directory = await this.resolveSkill(workspace, id)
    const skillPath = join(directory.directory, 'SKILL.md')
    let skillBytes: Buffer
    try {
      skillBytes = await readBoundedBuffer(skillPath, MAX_SKILL_BYTES)
    } catch (error) {
      if (isMissing(error)) throw new RuntimeError('NOT_FOUND', `Skill "${id}" has no SKILL.md`)
      throw error
    }
    const raw = skillBytes.toString('utf8')
    const document = parseSkillDocument(raw, directory.name)
    if (document.errors.length > 0) throw new RuntimeError('INVALID_INPUT', document.errors.join('; '))
    const skill = summary(directory, document.name!, document.description!, hash(skillBytes), document.whenToUse)
    const safeResource = resource === 'SKILL.md' || resource === '' ? 'SKILL.md' : safeRelativePath(resource)
    const files = await this.scanResources(directory.directory)
    let content = raw
    if (safeResource !== 'SKILL.md') {
      const target = await this.checkedSkillFile(directory, safeResource, MAX_RESOURCE_BYTES)
      content = await readBoundedFile(target, MAX_RESOURCE_BYTES)
    }
    return {
      skill,
      resource: safeResource,
      content,
      files,
    }
  }

  /**
   * 功能：校验一个技能：frontmatter 解析错误/警告 + 资源扫描 + 本地 Markdown 链接可达性。
   * @returns valid（无 errors）、去重后的 errors 与 warnings
   */
  async validate(workspace: string, id: string): Promise<SkillValidation> {
    const directory = await this.resolveSkill(workspace, id)
    const errors: string[] = []
    const warnings: string[] = []
    try {
      const raw = await readBoundedFile(directory.skillPath, MAX_SKILL_BYTES)
      const parsed = parseSkillDocument(raw, directory.name)
      errors.push(...parsed.errors)
      warnings.push(...parsed.warnings)
      await this.scanResources(directory.directory)
      if (parsed.errors.length === 0) {
        for (const reference of extractLocalMarkdownLinks(parsed.body)) {
          try {
            const path = normalizeMarkdownReference(reference)
            if (path === undefined) continue
            await this.checkedSkillTarget(directory, path)
          } catch (error) {
            errors.push(`invalid local Markdown reference "${reference}": ${errorMessage(error)}`)
          }
        }
      }
    } catch (error) {
      errors.push(errorMessage(error))
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] }
  }

  /**
   * 功能：保存/更新一个技能到工作区 `.agents/skills/<名>/SKILL.md`（唯一的写入口）。
   * @param input.name 技能名（小写 kebab-case，非 Windows 保留名）
   * @param input.content 完整 SKILL.md 内容（本应用写入要求 canonical：name 与
   * 目录名一致、描述非空、正文非空——比加载宽松）
   * @param input.expectedVersion 乐观锁：更新已有技能必须提供其当前 sha256
   * @returns 保存结果（created / unchanged / 校验结果）
   * 内部逻辑：写边界校验——逐段建目录（拒绝符号链接）、scanResources 清点资源、
   * validateReferences 检查正文本地链接；同内容重复保存幂等返回 unchanged；版本
   * 不符抛 CONFLICT；写入走 atomicWrite（临时文件 + fsync + rename + 目录 fsync），
   * 落盘后回读再校验一次；同一目标文件的写经 withWriteLock 串行。
   */
  async save(workspace: string, input: SkillSaveInput): Promise<SkillSaveResult> {
    const name = input.name.trim()
    const nameErrors = validateSkillName(name)
    if (nameErrors.length > 0) throw new RuntimeError('INVALID_INPUT', nameErrors.join('; '))
    if (typeof input.content !== 'string') throw new RuntimeError('INVALID_INPUT', 'Skill content must be a string')
    // 加载接受宽松 frontmatter，但本应用写出的必须是规范形式。
    const document = parseSkillDocument(input.content, name)
    if (document.errors.length > 0) throw new RuntimeError('INVALID_INPUT', document.errors.join('; '))
    if (document.name !== name) throw new RuntimeError('INVALID_INPUT', `frontmatter name must match the Skill name "${name}"`)
    if (document.description === undefined || document.description.trim() === '') throw new RuntimeError('INVALID_INPUT', 'frontmatter description must be a non-empty string')
    if (document.body.trim() === '') throw new RuntimeError('INVALID_INPUT', 'SKILL.md body must not be empty')
    const workspaceRoot = await this.workspaceRoot(workspace)
    const agentsRoot = await checkedDirectory(workspaceRoot, ['.agents', 'skills'], true)
    if (!agentsRoot) throw new RuntimeError('NOT_FOUND', 'Workspace skill directory is unavailable')
    const directoryPath = await checkedDirectory(agentsRoot, [name], true)
    if (!directoryPath) throw new RuntimeError('NOT_FOUND', 'Skill directory is unavailable')
    const target = join(directoryPath, 'SKILL.md')
    const lockKey = resolve(target)

    return this.withWriteLock(lockKey, async () => {
      const directory: SkillDirectory = { source: 'agents', path: agentsRoot, name, directory: directoryPath, skillPath: target }
      await this.scanResources(directoryPath)
      let current: Buffer | undefined
      try {
        const info = await lstat(target)
        if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'SKILL.md cannot be a symbolic link')
        if (!info.isFile()) throw new RuntimeError('INVALID_INPUT', 'SKILL.md must be a regular file')
        if (info.size > MAX_SKILL_BYTES) throw new RuntimeError('INVALID_INPUT', `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`)
        current = await readBoundedBuffer(target, MAX_SKILL_BYTES)
      } catch (error) {
        if (!isMissing(error)) throw error
      }

      await this.validateReferences(directory, document.body)
      if (current !== undefined && current.equals(Buffer.from(input.content, 'utf8'))) {
        return {
          skill: summary(directory, document.name!, document.description!, hash(current), document.whenToUse),
          created: false,
          unchanged: true,
          validation: { valid: true, errors: [], warnings: document.warnings },
        }
      }
      if (current !== undefined) {
        const currentVersion = hash(current)
        if (!input.expectedVersion || input.expectedVersion !== currentVersion) {
          throw new RuntimeError('CONFLICT', 'Skill changed since it was loaded; provide its current version to update it')
        }
      } else if (input.expectedVersion !== undefined) {
        throw new RuntimeError('CONFLICT', 'Skill does not exist at the expected version')
      }

      await this.atomicWrite(target, Buffer.from(input.content, 'utf8'))
      const savedContent = await readBoundedFile(target, MAX_SKILL_BYTES)
      const savedDocument = parseSkillDocument(savedContent, name)
      if (savedDocument.errors.length > 0) throw new RuntimeError('PROVIDER_ERROR', `Saved skill failed validation: ${savedDocument.errors.join('; ')}`)
      return {
        skill: summary(directory, savedDocument.name!, savedDocument.description!, hash(Buffer.from(savedContent, 'utf8')), savedDocument.whenToUse),
        created: current === undefined,
        unchanged: false,
        validation: { valid: true, errors: [], warnings: savedDocument.warnings },
      }
    })
  }

  /** 五根扫描顺序：builtin → global → user-agents → 工作区分层根 → 插件根；先发现者在遮蔽中胜出。 */
  private roots(workspaceRoot: string): SkillRoot[] {
    return [
      { source: 'builtin', path: this.builtinRoot },
      ...(this.globalRoot === undefined ? [] : [{ source: 'global' as const, path: this.globalRoot }]),
      ...(this.userAgentsRoot === undefined ? [] : [{ source: 'user-agents' as const, path: this.userAgentsRoot }]),
      ...this.workspaceRoots(workspaceRoot),
      ...this.pluginRoots(),
    ]
  }

  /**
   * ZCode 式分层工作区根：从工作区向上走到仓库根（有 `.git` 即停）；没有仓库时
   * 只算工作区自身一层，未纳入版本管理的目录上方的杂散技能目录不进范围。
   * 更深的层级优先；同一层内 `.pi-web/skills` 先于 `.agents/skills` 扫描，
   * 对应 ZCode 的 `.zcode` 先于 `.agents`。
   */
  private workspaceRoots(workspaceRoot: string): SkillRoot[] {
    const levels: string[] = [workspaceRoot]
    let inRepository = existsSync(join(workspaceRoot, '.git'))
    let cursor = workspaceRoot
    while (!inRepository) {
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
      levels.push(cursor)
      inRepository = existsSync(join(cursor, '.git'))
    }
    if (!inRepository) levels.length = 1
    const roots: SkillRoot[] = []
    for (const source of ['pi', 'agents'] as const) {
      const directory = source === 'pi' ? '.pi-web' : '.agents'
      for (const level of levels) {
        const path = join(level, directory, 'skills')
        roots.push({ source, path, base: level })
      }
    }
    return roots
  }

  /** 工作区根的 realpath（必须是目录）；无效抛 NOT_FOUND / INVALID_INPUT。 */
  private async workspaceRoot(workspace: string): Promise<string> {
    try {
      const canonical = await realpath(resolve(workspace))
      const info = await lstat(canonical)
      if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'Workspace must be a directory')
      return canonical
    } catch (error) {
      if (error instanceof RuntimeError) throw error
      throw new RuntimeError('NOT_FOUND', `Workspace directory is unavailable: ${errorMessage(error)}`)
    }
  }

  /**
   * 解析一个根的可用路径（按来源区分校验强度）。
   * 内部逻辑：agents/pi 跟随符号链接链（ZCode/pi/opencode 一致）；global/user-agents
   * 允许符号链接前缀（dotfiles 仓库、macOS /var、网络主目录），realpath 后要求真实
   * 目录；builtin 逐段禁链接。缺失返回 undefined，其余错误记诊断。
   */
  private async rootPath(root: SkillRoot, workspaceRoot: string, diagnostics: SkillCatalog['diagnostics']): Promise<string | undefined> {
    try {
      if (root.source === 'agents' || root.source === 'pi') {
        // 读侧发现跟随符号链接的 `.agents`/`.pi-web` 链（ZCode/pi/opencode 一致）。
        return await readDirectory(root.path)
      }
      if (root.source === 'global' || root.source === 'user-agents') {
        // 用户级根可能合法地位于符号链接前缀下（从主目录链出的 dotfiles 仓库、
        // macOS /var、网络主目录）：先 resolve 再要求真实目录。根缺失是全新安装的
        // 正常状态。
        return await realpath(root.path)
      }
      return await assertNoSymlinkComponents(root.path)
    } catch (error) {
      if (isMissing(error)) return undefined
      diagnostics.push({ path: root.path, message: errorMessage(error) })
      return undefined
    }
  }

  /**
   * 功能：按五根顺序把技能 ID 解析成具体目录（遮蔽语义：同名只取第一个命中）。
   * @returns SkillDirectory；找不到抛 NOT_FOUND（插件式 ID 但插件未知时给 INVALID_INPUT）
   * 内部逻辑：ID 带来源前缀只查该根；裸名（无冒号）在全部根按序查找；名字必须是
   * 单段路径（拒绝 `/` `\` NUL 与点）。
   */
  private async resolveSkill(workspace: string, id: string): Promise<SkillDirectory> {
    const workspaceRoot = await this.workspaceRoot(workspace)
    const directories: SkillDirectory[] = []
    let matchedPrefix = false
    for (const root of this.roots(workspaceRoot)) {
      const prefix = root.source === 'plugin' && root.pluginId !== undefined ? `${root.pluginId}:` : `${root.source}:`
      let name: string | undefined
      if (id.startsWith(prefix)) {
        matchedPrefix = true
        name = id.slice(prefix.length)
      } else if (!id.includes(':')) {
        name = id
      }
      if (name === undefined) continue
      // 查找键是目录名；不必是 kebab-case，但必须是单个路径段。
      if (name === '' || name === '.' || name === '..' || /[/\\\u0000]/u.test(name)) {
        throw new RuntimeError('INVALID_INPUT', 'Skill id must name a single directory')
      }
      const rootPath = await this.rootPath(root, workspaceRoot, [])
      if (!rootPath) continue
      const directory = await readDirectory(join(rootPath, name))
      if (!directory) continue
      directories.push({ ...root, path: rootPath, directory, name, skillPath: join(directory, 'SKILL.md') })
    }
    if (directories.length === 0) {
      if (!matchedPrefix && id.includes(':')) {
        const pluginId = id.slice(0, id.lastIndexOf(':'))
        if (/^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,63}$/u.test(pluginId)) {
          throw new RuntimeError('NOT_FOUND', `Skill "${id}" was not found`)
        }
        throw new RuntimeError('INVALID_INPUT', 'Skill ID source is invalid')
      }
      throw new RuntimeError('NOT_FOUND', `Skill "${id}" was not found`)
    }
    // ZCode 式遮蔽：同名技能在多个根都会被发现，但只有发现顺序中的第一个加载，
    // 因此裸名永远不会歧义。
    return directories[0]!
  }

  /** builtin 根可用时返回其规范路径；缺失返回 undefined（测试环境常见）。 */
  private async optionalBuiltinRoot(): Promise<string | undefined> {
    try { return await assertNoSymlinkComponents(this.builtinRoot) } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  /**
   * 功能：解析请求的资源路径。
   * 内部逻辑：请求本身必须是相对且无穿越的（`..` 拒绝），但沿途符号链接像
   * ZCode/pi/opencode 一样跟随，因此资源可以合法地住在链接的 dotfiles 树或应用
   * 包里；存在性仍要校验。
   */
  private async checkedSkillTarget(directory: SkillDirectory, resource: string): Promise<string> {
    const safePath = safeRelativePath(resource)
    const target = resolve(directory.directory, safePath)
    // 存在性对校验仍有意义；目标可以是符号链接（跟随）。
    await stat(target)
    return target
  }

  /** checkedSkillTarget + 常规文件与大小上限校验，返回可读的目标路径。 */
  private async checkedSkillFile(directory: SkillDirectory, resource: string, maxBytes: number): Promise<string> {
    const target = await this.checkedSkillTarget(directory, resource)
    const info = await stat(target)
    if (!info.isFile()) throw new RuntimeError('INVALID_INPUT', 'Skill resource must be a regular file')
    if (info.size > maxBytes) throw new RuntimeError('INVALID_INPUT', `Skill resource exceeds ${maxBytes} bytes`)
    return target
  }

  /**
   * 功能：递归清点技能目录下的资源文件（相对路径排序返回）。
   * 内部逻辑：符号链接跟随（与 ZCode/pi/opencode 一致），深度 ≤ 16、条目 ≤ 500
   * 封顶防环；根目录跳过保存临时文件；非常规条目报错。
   */
  private async scanResources(directory: string): Promise<string[]> {
    const files: string[] = []
    let count = 0
    const visit = async (current: string, prefix: string, depth: number): Promise<void> => {
      if (depth > MAX_RESOURCE_DEPTH) throw new RuntimeError('INVALID_INPUT', `Skill resources exceed depth ${MAX_RESOURCE_DEPTH}`)
      for await (const name of boundedNames(current, MAX_RESOURCE_FILES)) {
        if (prefix === '' && isTemporaryFile(name)) continue
        count += 1
        if (count > MAX_RESOURCE_FILES) throw new RuntimeError('INVALID_INPUT', `Skill contains more than ${MAX_RESOURCE_FILES} resources`)
        const path = join(current, name)
        // 跟随符号链接（与 ZCode/pi/opencode 一致）；深度与数量上限让环有界。
        const info = await stat(path)
        const relativePath = prefix === '' ? name : `${prefix}/${name}`
        if (info.isDirectory()) await visit(path, relativePath, depth + 1)
        else if (info.isFile()) files.push(relativePath)
        else throw new RuntimeError('INVALID_INPUT', 'Skill resources must be regular files or directories')
      }
    }
    await visit(directory, '', 0)
    return files.sort()
  }

/** 校验正文中每个本地 Markdown 链接都能落到技能目录内的真实目标；失败抛 INVALID_INPUT。 */
  private async validateReferences(directory: SkillDirectory, body: string): Promise<void> {
    for (const reference of extractLocalMarkdownLinks(body)) {
      try {
        const path = normalizeMarkdownReference(reference)
        if (path === undefined) continue
        await this.checkedSkillTarget(directory, path)
      } catch (error) {
        throw new RuntimeError('INVALID_INPUT', `Invalid local Markdown reference "${reference}": ${errorMessage(error)}`)
      }
    }
  }

  /** 原子写：`.skill-save-*.tmp` 独占创建 → 写入 + fsync → rename → 尽力 fsync 目录；失败清理临时文件。 */
  private async atomicWrite(target: string, content: Buffer): Promise<void> {
    const directory = dirname(target)
    const temporary = join(directory, `${TEMP_FILE_PREFIX}${randomUUID()}.tmp`)
    let file
    try {
      file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await file.writeFile(content)
      await file.sync()
      await file.close()
      file = undefined
      await rename(temporary, target)
      try {
        const directoryHandle = await open(directory, constants.O_RDONLY)
        try { await directoryHandle.sync() } finally { await directoryHandle.close() }
      } catch { /* 某些文件系统不支持同步目录句柄。 */ }
    } catch (error) {
      await file?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  /** 按 key 的写串行锁：同一目标文件的写操作排进 writeTails 队列依次执行。 */
  private async withWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolvePromise => { release = resolvePromise })
    const queued = previous.then(() => current)
    this.writeTails.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.writeTails.get(key) === queued) this.writeTails.delete(key)
    }
  }
}
