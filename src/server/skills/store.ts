import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
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
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

type SkillSource = SkillSummary['source']
/**
 * One discovery root. Workspace roots (`agents`/`pi`) carry `base`: the workspace
 * level the root hangs off, which may be an ancestor of the workspace up to the
 * repository root (ZCode-style layered discovery).
 */
export interface SkillRoot { source: SkillSource; path: string; pluginId?: string; pluginName?: string; base?: string }
interface SkillDirectory extends SkillRoot { name: string; directory: string; skillPath: string }
interface SkillDocument {
  name?: string
  description?: string
  whenToUse?: string
  body: string
  warnings: string[]
  errors: string[]
}

export interface SkillStoreOptions {
  /** Bundled, read-only skills. Defaults to the repository's top-level `skills/` directory. */
  builtinRoot?: string
  /** User-level (global) skills, read-only; defaults to none. Anchored at `~/.pi-web/skills` in production. */
  globalRoot?: string
  /** Enabled plugin skill roots, read on every catalog/list operation. */
  pluginRoots?: () => readonly SkillRoot[]
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown filesystem error'
}

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function validateSkillName(name: string): string[] {
  const errors: string[] = []
  if (name.length < 1 || name.length > 64 || !SKILL_NAME.test(name)) {
    errors.push('name must be 1 to 64 characters in lowercase kebab-case')
  }
  if (WINDOWS_RESERVED_NAME.test(name)) errors.push('name is reserved on Windows')
  return errors
}

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
 * Parses a SKILL.md with ZCode's two-tier failure model: `errors` drop the Skill,
 * `warnings` are routing-quality notes only. A file without frontmatter still loads,
 * named after its directory with an empty description; a file whose frontmatter
 * exists but lacks `name`/`description` (or overruns the description limit) is
 * dropped. Malformed YAML lines are skipped as warnings.
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
    // An unterminated delimiter cannot be frontmatter; treat the file as frontmatter-free.
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
    // Malformed lines are skipped instead of dropping the Skill (ZCode behavior).
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

function isTemporaryFile(name: string): boolean {
  return name.startsWith(TEMP_FILE_PREFIX) && name.endsWith('.tmp')
}

function extractLocalMarkdownLinks(markdown: string): string[] {
  // Code samples are examples, not resource dependencies.
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

async function readBoundedBuffer(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path)
  if (before.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Skill files cannot be symbolic links')
  if (!before.isFile()) throw new RuntimeError('INVALID_INPUT', 'Skill resource must be a regular file')
  if (before.size > maxBytes) throw new RuntimeError('INVALID_INPUT', `Skill file exceeds ${maxBytes} bytes`)
  let handle
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    try {
      handle = await open(path, constants.O_RDONLY | noFollow)
    } catch (error) {
      if (noFollow === 0 || !(typeof error === 'object' && error !== null && 'code' in error && (error.code === 'EINVAL' || error.code === 'ENOTSUP' || error.code === 'ENOSYS'))) throw error
      // On platforms without O_NOFOLLOW, the inode checks below provide the fallback guard.
      handle = await open(path, constants.O_RDONLY)
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
      throw new RuntimeError('FORBIDDEN', 'Skill files cannot be symbolic links')
    }
    throw error
  }
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
    const after = await lstat(path)
    if (after.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Skill files cannot be symbolic links')
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

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const content = await readBoundedBuffer(path, maxBytes)
  return content.toString('utf8')
}

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

export class SkillStore {
  private readonly builtinRoot: string
  private readonly globalRoot: string | undefined
  private readonly pluginRoots: () => readonly SkillRoot[]
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(options: SkillStoreOptions = {}) {
    this.builtinRoot = resolve(options.builtinRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../../../skills'))
    this.globalRoot = options.globalRoot === undefined ? undefined : resolve(options.globalRoot)
    this.pluginRoots = options.pluginRoots ?? (() => [])
  }

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
          info = await lstat(directoryPath)
        } catch (error) {
          if (isMissing(error)) continue
          diagnostics.push({ path: directoryPath, message: errorMessage(error) })
          continue
        }
        if (info.isSymbolicLink()) {
          diagnostics.push({ path: directoryPath, message: 'skill directory is a symbolic link' })
          continue
        }
        if (!info.isDirectory()) continue
        // Directory names are not format-checked (ZCode loads skills by file path);
        // `save` still enforces kebab-case for anything this app creates.
        const skillDirectory: SkillDirectory = { ...root, name, directory: directoryPath, skillPath: join(directoryPath, 'SKILL.md') }
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
          diagnostics.push({ path: join(directoryPath, 'SKILL.md'), message: errorMessage(error) })
        }
      }
    }
    // Shadowed same-id copies (same name on several workspace levels) collapse to the
    // first in discovery order — the one that would load; the catalog stays the
    // loadable set. Sorting happens after dedup so display order stays stable.
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

  async save(workspace: string, input: SkillSaveInput): Promise<SkillSaveResult> {
    const name = input.name.trim()
    const nameErrors = validateSkillName(name)
    if (nameErrors.length > 0) throw new RuntimeError('INVALID_INPUT', nameErrors.join('; '))
    if (typeof input.content !== 'string') throw new RuntimeError('INVALID_INPUT', 'Skill content must be a string')
    // Loading accepts loose frontmatter, but anything this app writes must be canonical.
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

  private roots(workspaceRoot: string): SkillRoot[] {
    return [
      { source: 'builtin', path: this.builtinRoot },
      ...(this.globalRoot === undefined ? [] : [{ source: 'global' as const, path: this.globalRoot }]),
      ...this.workspaceRoots(workspaceRoot),
      ...this.pluginRoots(),
    ]
  }

  /**
   * ZCode-style layered workspace roots: walk from the workspace up to its repository
   * root (a `.git` entry stops the walk); without a repository only the workspace level
   * itself counts, so stray skill directories above an un-versioned folder stay out of
   * scope. Deeper levels win, and within the layer `.pi-web/skills` is scanned before
   * `.agents/skills`, mirroring ZCode's `.zcode` before `.agents`.
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

  private async rootPath(root: SkillRoot, workspaceRoot: string, diagnostics: SkillCatalog['diagnostics']): Promise<string | undefined> {
    try {
      if (root.source === 'agents' || root.source === 'pi') {
        const segments = root.source === 'agents' ? ['.agents', 'skills'] : ['.pi-web', 'skills']
        return await checkedDirectory(root.base ?? workspaceRoot, segments, false)
      }
      if (root.source === 'global') {
        // The global root is user-configured and may legitimately sit under a
        // symlinked prefix (macOS /var, network homes): resolve it, then require
        // a real directory. A missing root is the normal fresh-install state.
        return await realpath(root.path)
      }
      return await assertNoSymlinkComponents(root.path)
    } catch (error) {
      if (isMissing(error)) return undefined
      diagnostics.push({ path: root.path, message: errorMessage(error) })
      return undefined
    }
  }

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
      // The lookup key is a directory name; it need not be kebab-case, but it must
      // stay a single path segment.
      if (name === '' || name === '.' || name === '..' || /[/\\\u0000]/u.test(name)) {
        throw new RuntimeError('INVALID_INPUT', 'Skill id must name a single directory')
      }
      const rootPath = await this.rootPath(root, workspaceRoot, [])
      if (!rootPath) continue
      const directory = await checkedDirectory(rootPath, [name], false)
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
    // ZCode-style shadowing: same-named Skills at several roots are all discovered but
    // only the first in discovery order loads, so the bare name is never ambiguous.
    return directories[0]!
  }

  private async optionalBuiltinRoot(): Promise<string | undefined> {
    try { return await assertNoSymlinkComponents(this.builtinRoot) } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  private async checkedSkillTarget(directory: SkillDirectory, resource: string): Promise<string> {
    const safePath = safeRelativePath(resource)
    const target = resolve(directory.directory, safePath)
    if (!isWithin(directory.directory, target)) throw new RuntimeError('FORBIDDEN', 'Skill resource path escaped its directory')
    let cursor = directory.directory
    for (const segment of safePath.split('/').filter(Boolean)) {
      cursor = join(cursor, segment)
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Skill resources cannot be symbolic links')
      if (cursor !== target && !info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'Skill resource path contains a non-directory')
    }
    const canonical = await realpath(target)
    if (!isWithin(directory.directory, canonical)) throw new RuntimeError('FORBIDDEN', 'Skill resource path escaped its directory')
    return canonical
  }

  private async checkedSkillFile(directory: SkillDirectory, resource: string, maxBytes: number): Promise<string> {
    const target = await this.checkedSkillTarget(directory, resource)
    const info = await lstat(target)
    if (!info.isFile()) throw new RuntimeError('INVALID_INPUT', 'Skill resource must be a regular file')
    if (info.size > maxBytes) throw new RuntimeError('INVALID_INPUT', `Skill resource exceeds ${maxBytes} bytes`)
    return target
  }

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
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new RuntimeError('FORBIDDEN', 'Skill resources cannot be symbolic links')
        const relativePath = prefix === '' ? name : `${prefix}/${name}`
        if (info.isDirectory()) await visit(path, relativePath, depth + 1)
        else if (info.isFile()) files.push(relativePath)
        else throw new RuntimeError('INVALID_INPUT', 'Skill resources must be regular files or directories')
      }
    }
    await visit(directory, '', 0)
    return files.sort()
  }

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
      } catch { /* Some filesystems do not support syncing directory handles. */ }
    } catch (error) {
      await file?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

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
