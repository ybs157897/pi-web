import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
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
} from '../shared/skills.ts'
import { RuntimeError } from './runtime-errors.ts'

const MAX_SKILL_BYTES = 64 * 1024
const MAX_FRONTMATTER_BYTES = 16 * 1024
const MAX_DESCRIPTION_LENGTH = 1_024
const MAX_ROOT_ENTRIES = 500
const MAX_RESOURCE_FILES = 500
const MAX_RESOURCE_DEPTH = 16
const MAX_RESOURCE_BYTES = 64 * 1024
const MAX_YAML_ALIASES = 16
const TEMP_FILE_PREFIX = '.skill-save-'
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

type SkillSource = SkillSummary['source']
interface SkillRoot { source: SkillSource; path: string }
interface SkillDirectory extends SkillRoot { name: string; directory: string; skillPath: string }
interface SkillDocument {
  name?: string
  description?: string
  body: string
  warnings: string[]
  errors: string[]
}

export interface SkillStoreOptions {
  /** Bundled, read-only skills. Defaults to the repository's top-level `skills/` directory. */
  builtinRoot?: string
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

function parseSkillDocument(content: string, expectedName: string): SkillDocument {
  const errors: string[] = []
  const warnings: string[] = []
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    return { body: '', warnings, errors: [`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`] }
  }

  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { body: '', warnings, errors: ['SKILL.md must start with YAML frontmatter delimited by ---'] }
  }

  const openingEnd = normalized.indexOf('\n') + 1
  const closingMatch = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(normalized.slice(openingEnd))
  if (!closingMatch || closingMatch.index === undefined) {
    return { body: '', warnings, errors: ['YAML frontmatter is missing its closing --- delimiter'] }
  }
  const frontmatter = normalized.slice(openingEnd, openingEnd + closingMatch.index)
  if (Buffer.byteLength(frontmatter, 'utf8') > MAX_FRONTMATTER_BYTES) {
    return { body: '', warnings, errors: [`YAML frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`] }
  }
  const bodyOffset = openingEnd + closingMatch.index + closingMatch[0].length
  const body = normalized.slice(bodyOffset).replace(/^\r?\n/, '')
  if (!body.trim()) errors.push('SKILL.md body must not be empty')

  let metadata: unknown
  try {
    const document = parseDocument(frontmatter, { uniqueKeys: true, version: '1.2' })
    errors.push(...document.errors.map(issue => `invalid YAML frontmatter: ${issue.message}`))
    warnings.push(...document.warnings.map(issue => `YAML frontmatter: ${issue.message}`))
    if (document.errors.length === 0) metadata = document.toJS({ maxAliasCount: MAX_YAML_ALIASES })
  } catch (error) {
    errors.push(`invalid YAML frontmatter: ${errorMessage(error)}`)
  }

  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    errors.push('YAML frontmatter must be a mapping')
    return { body, warnings, errors }
  }

  const fields = metadata as Record<string, unknown>
  const name = typeof fields.name === 'string' ? fields.name : undefined
  const description = typeof fields.description === 'string' ? fields.description : undefined
  if (name === undefined) errors.push('frontmatter name must be a string')
  else {
    errors.push(...validateSkillName(name))
    if (name !== expectedName) errors.push(`frontmatter name must match directory name "${expectedName}"`)
  }
  if (description === undefined || !description.trim()) errors.push('frontmatter description must be a non-empty string')
  else if (description.length > MAX_DESCRIPTION_LENGTH) errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`)
  return { name, description, body, warnings, errors }
}

function summary(directory: SkillDirectory, name: string, description: string, version: string): SkillSummary {
  return {
    id: `${directory.source}:${directory.name}`,
    name,
    description,
    source: directory.source,
    path: directory.skillPath,
    version,
    writable: directory.source === 'agents',
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
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(options: SkillStoreOptions = {}) {
    this.builtinRoot = resolve(options.builtinRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../../skills'))
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
        const nameErrors = validateSkillName(name)
        if (nameErrors.length > 0) {
          diagnostics.push({ path: directoryPath, message: nameErrors.join('; ') })
          continue
        }
        const skillDirectory: SkillDirectory = { ...root, name, directory: directoryPath, skillPath: join(directoryPath, 'SKILL.md') }
        try {
          const bytes = await readBoundedBuffer(skillDirectory.skillPath, MAX_SKILL_BYTES)
          const raw = bytes.toString('utf8')
          const document = parseSkillDocument(raw, name)
          if (document.errors.length > 0) {
            diagnostics.push({ path: skillDirectory.skillPath, message: document.errors.join('; ') })
            continue
          }
          skills.push(summary(skillDirectory, document.name!, document.description!, hash(bytes)))
        } catch (error) {
          diagnostics.push({ path: join(directoryPath, 'SKILL.md'), message: errorMessage(error) })
        }
      }
    }
    skills.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
    diagnostics.sort((left, right) => left.path.localeCompare(right.path))
    return { skills, diagnostics }
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
    const skill = summary(directory, document.name!, document.description!, hash(skillBytes))
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
    const document = parseSkillDocument(input.content, name)
    if (document.errors.length > 0) throw new RuntimeError('INVALID_INPUT', document.errors.join('; '))
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
          skill: summary(directory, document.name!, document.description!, hash(current)),
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
        skill: summary(directory, savedDocument.name!, savedDocument.description!, hash(Buffer.from(savedContent, 'utf8'))),
        created: current === undefined,
        unchanged: false,
        validation: { valid: true, errors: [], warnings: savedDocument.warnings },
      }
    })
  }

  private roots(workspaceRoot: string): SkillRoot[] {
    return [
      { source: 'builtin', path: this.builtinRoot },
      { source: 'agents', path: join(workspaceRoot, '.agents', 'skills') },
      { source: 'pi', path: join(workspaceRoot, '.pi', 'skills') },
    ]
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
        const segments = root.source === 'agents' ? ['.agents', 'skills'] : ['.pi', 'skills']
        return await checkedDirectory(workspaceRoot, segments, false)
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
    const delimiter = id.indexOf(':')
    let requestedSource: SkillSource | undefined
    let name = id
    if (delimiter >= 0) {
      const source = id.slice(0, delimiter)
      name = id.slice(delimiter + 1)
      if (source !== 'builtin' && source !== 'agents' && source !== 'pi') throw new RuntimeError('INVALID_INPUT', 'Skill ID source is invalid')
      requestedSource = source
    }
    const nameErrors = validateSkillName(name)
    if (nameErrors.length > 0) throw new RuntimeError('INVALID_INPUT', nameErrors.join('; '))

    const directories: SkillDirectory[] = []
    for (const root of this.roots(workspaceRoot)) {
      if (requestedSource !== undefined && root.source !== requestedSource) continue
      const rootPath = root.source === 'agents'
        ? await checkedDirectory(workspaceRoot, ['.agents', 'skills'], false)
        : root.source === 'pi'
          ? await checkedDirectory(workspaceRoot, ['.pi', 'skills'], false)
          : await this.optionalBuiltinRoot()
      if (!rootPath) continue
      const directory = await checkedDirectory(rootPath, [name], false)
      if (!directory) continue
      directories.push({ ...root, path: rootPath, directory, name, skillPath: join(directory, 'SKILL.md') })
    }
    if (directories.length === 0) throw new RuntimeError('NOT_FOUND', `Skill "${id}" was not found`)
    if (directories.length > 1) throw new RuntimeError('CONFLICT', `Skill name "${name}" is ambiguous; use a source-qualified ID`)
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
