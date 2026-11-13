import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { readMemoryFile, resolveSafeMemoryPath, stampOriginSessionId, stripFrontmatter } from './store.ts'

/**
 * Host-managed governance sidecar next to the fact files. It is not a `.md`, so
 * `resolveSafeMemoryPath` never lets a model write reach it; only the host write paths below do.
 */
export const MEMORY_GOVERNANCE_FILENAME = '.memory-governance.json'
/** Bound the ledger and the dedup scan so a long-lived workspace cannot grow them without limit. */
const MAX_LEDGER_ENTRIES = 1_000
const MAX_SCANNED_FILES = 2_000
const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', '.data'])
const FRONTMATTER = /^(\uFEFF?)---[ \t]*(\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/u

export interface MemoryTombstone {
  hash: string
  file: string
  disabledBy: string
  disabledReason: string
  disabledAt: string
}

export interface MemorySupersede {
  file: string
  supersededBy: string
}

export interface MemoryGovernanceLedger {
  tombstones: MemoryTombstone[]
  superseded: MemorySupersede[]
}

export type MemoryWriteGate =
  | { action: 'reject'; reason: string }
  | { action: 'dedup'; file: string }
  | { action: 'allow'; content: string }

/** Content identity: the whitespace-collapsed, lowercased body without frontmatter, sha256 truncated to 32 hex chars. */
export function memoryTextHash(content: string): string {
  const normalized = stripFrontmatter(content).replace(/\s+/gu, ' ').trim().toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

/** The model-visible notice both write paths return on a dedup hit. */
export function memoryDedupMessage(file: string): string {
  return `记忆 ${file} 已有相同内容，不重复写入。`
}

function emptyLedger(): MemoryGovernanceLedger {
  return { tombstones: [], superseded: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function sanitizeLedger(value: unknown): MemoryGovernanceLedger {
  if (!isRecord(value)) return emptyLedger()
  const tombstones = Array.isArray(value.tombstones)
    ? value.tombstones.filter((entry): entry is MemoryTombstone =>
      isRecord(entry) && nonEmptyString(entry.hash) && nonEmptyString(entry.file)
      && nonEmptyString(entry.disabledBy) && nonEmptyString(entry.disabledReason) && nonEmptyString(entry.disabledAt))
    : []
  const superseded = Array.isArray(value.superseded)
    ? value.superseded.filter((entry): entry is MemorySupersede =>
      isRecord(entry) && nonEmptyString(entry.file) && nonEmptyString(entry.supersededBy))
    : []
  return { tombstones, superseded }
}

/** Fail-open: a missing, unreadable, or corrupt ledger reads as empty and never blocks a memory write. */
export async function readGovernanceLedger(root: string): Promise<MemoryGovernanceLedger> {
  const record = await readMemoryFile(join(root, MEMORY_GOVERNANCE_FILENAME))
  if (record.status !== 'loaded') return emptyLedger()
  try {
    return sanitizeLedger(JSON.parse(record.content))
  } catch {
    return emptyLedger()
  }
}

/** Atomic tmp+rename write, the same pattern as the fact-file writes; callers swallow failures. */
async function writeGovernanceLedger(root: string, ledger: MemoryGovernanceLedger): Promise<void> {
  await mkdir(root, { recursive: true })
  const bounded: MemoryGovernanceLedger = {
    tombstones: ledger.tombstones.slice(-MAX_LEDGER_ENTRIES),
    superseded: ledger.superseded.slice(-MAX_LEDGER_ENTRIES),
  }
  const temporary = join(root, `.tmp-governance-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temporary, `${JSON.stringify(bounded, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, join(root, MEMORY_GOVERNANCE_FILENAME))
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

interface FrontmatterFields {
  name?: string
  textHash?: string
  supersedes?: string
}

function frontmatterFields(content: string): FrontmatterFields {
  const match = FRONTMATTER.exec(content)
  if (match === null) return {}
  const document = parseDocument(match[3] ?? '')
  if (document.errors.length > 0) return {}
  const fields: FrontmatterFields = {}
  const name = document.get('name')
  if (nonEmptyString(name)) fields.name = name.trim()
  const metadata = document.get('metadata')
  if (isMap(metadata)) {
    const textHash = metadata.get('textHash')
    if (nonEmptyString(textHash)) fields.textHash = textHash.trim()
    const supersedes = metadata.get('supersedes')
    if (nonEmptyString(supersedes)) fields.supersedes = supersedes.trim()
  }
  return fields
}

/**
 * Pure frontmatter transform that records the body's content identity in `metadata.textHash`.
 * Idempotent for an unchanged hash; malformed or unrecognized frontmatter is returned untouched
 * so a governance stamp can never block a write. Mirrors `stampOriginSessionId`'s AST handling.
 */
export function injectTextHash(content: string, hash: string): string {
  const match = FRONTMATTER.exec(content)
  if (match === null) return content
  const [, bom = '', lineEnding = '\n', frontmatter = '', closing = ''] = match
  const document = parseDocument(frontmatter)
  if (document.errors.length > 0) return content
  if (!document.has('metadata')) {
    document.set('metadata', document.createNode({ textHash: hash }))
  } else {
    const metadata = document.get('metadata')
    if (!isMap(metadata)) return content
    if (metadata.get('textHash') === hash) return content
    metadata.set('textHash', hash)
  }
  const serialized = document.toString().replace(/\r?\n$/u, '')
  const restored = lineEnding === '\r\n' ? serialized.replace(/\n/gu, '\r\n') : serialized
  return `${bom}---${lineEnding}${restored}${closing}${content.slice(match[0].length)}`
}

export interface ScannedMemoryFile {
  /** Path relative to the memory root, with forward slashes. */
  file: string
  path: string
  name?: string
  textHash?: string
}

async function scanMemoryFiles(root: string): Promise<ScannedMemoryFile[]> {
  const files: ScannedMemoryFile[] = []
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= MAX_SCANNED_FILES) return
    let items
    try {
      items = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (files.length >= MAX_SCANNED_FILES) return
      if (item.isSymbolicLink()) continue
      const path = join(directory, item.name)
      if (item.isDirectory()) {
        if (!OMITTED_DIRECTORIES.has(item.name)) await walk(path)
        continue
      }
      if (!item.isFile() || !item.name.endsWith('.md') || item.name === 'MEMORY.md') continue
      const record = await readMemoryFile(path)
      if (record.status !== 'loaded') continue
      const fields = frontmatterFields(record.content)
      files.push({
        file: relative(root, path).split(sep).join('/'),
        path,
        ...(fields.name === undefined ? {} : { name: fields.name }),
        ...(fields.textHash === undefined ? {} : { textHash: fields.textHash }),
      })
    }
  }
  await walk(root)
  return files
}

/** Fact files still feeding dedup and recall: superseded and tombstoned entries are out. */
export async function scanActiveMemoryFiles(root: string, ledger: MemoryGovernanceLedger): Promise<ScannedMemoryFile[]> {
  const superseded = new Set(ledger.superseded.map(entry => entry.file))
  const tombstonedFiles = new Set(ledger.tombstones.map(entry => entry.file))
  const tombstonedHashes = new Set(ledger.tombstones.map(entry => entry.hash))
  const files = await scanMemoryFiles(root)
  return files.filter(entry =>
    !superseded.has(entry.file)
    && !tombstonedFiles.has(entry.file)
    && !(entry.textHash !== undefined && tombstonedHashes.has(entry.textHash)))
}

/**
 * The non-resurrection and dedup gate shared by both write paths. `MEMORY.md` is the index, not a
 * fact, and passes through untouched. A tombstone hit rejects with who deleted the body and why;
 * an identical active body dedups to the existing file (the write target itself is exempt, so
 * in-place updates stay possible); otherwise the content comes back with `metadata.textHash`
 * injected. The tombstone's `disabledBy`/`disabledReason` come from the ledger, not the caller.
 */
export async function gateWrite(root: string, path: string, content: string): Promise<MemoryWriteGate> {
  if (basename(path) === 'MEMORY.md') return { action: 'allow', content }
  const hash = memoryTextHash(content)
  const ledger = await readGovernanceLedger(root)
  const tombstone = ledger.tombstones.find(entry => entry.hash === hash)
  if (tombstone !== undefined) {
    return {
      action: 'reject',
      reason: `这条记忆已被删除（by ${tombstone.disabledBy}，原因 ${tombstone.disabledReason}），不再重新保存。`,
    }
  }
  const target = relative(root, path).split(sep).join('/')
  const active = await scanActiveMemoryFiles(root, ledger)
  const duplicate = active.find(entry => entry.file !== target && entry.textHash === hash)
  if (duplicate !== undefined) return { action: 'dedup', file: duplicate.file }
  return { action: 'allow', content: injectTextHash(content, hash) }
}

/**
 * Tombstone the deleted body's hash before the file is removed, so the same content cannot be
 * re-saved later. Unreadable files leave no tombstone; a hash already tombstoned is not duplicated.
 */
export async function recordDelete(root: string, path: string, sessionId: string, reason = '用户/提取删除'): Promise<void> {
  if (basename(path) === 'MEMORY.md') return
  const record = await readMemoryFile(path)
  if (record.status !== 'loaded') return
  const hash = memoryTextHash(record.content)
  const ledger = await readGovernanceLedger(root)
  if (ledger.tombstones.some(entry => entry.hash === hash)) return
  ledger.tombstones.push({
    hash,
    file: relative(root, path).split(sep).join('/'),
    disabledBy: sessionId,
    disabledReason: reason,
    disabledAt: new Date().toISOString(),
  })
  await writeGovernanceLedger(root, ledger)
}

/** Record that `oldFile` was corrected by `newFile`; both are root-relative paths with forward slashes. */
export async function recordSupersede(root: string, oldFile: string, newFile: string): Promise<void> {
  if (oldFile === newFile) return
  const ledger = await readGovernanceLedger(root)
  const existing = ledger.superseded.find(entry => entry.file === oldFile)
  if (existing !== undefined) {
    if (existing.supersededBy === newFile) return
    existing.supersededBy = newFile
  } else {
    ledger.superseded.push({ file: oldFile, supersededBy: newFile })
  }
  await writeGovernanceLedger(root, ledger)
}

/** Resolve `metadata.supersedes: <name>` against the active files and retire the named fact. */
export async function applySupersedes(root: string, newPath: string, content: string): Promise<void> {
  const supersedes = frontmatterFields(content).supersedes
  if (supersedes === undefined) return
  const newFile = relative(root, newPath).split(sep).join('/')
  const ledger = await readGovernanceLedger(root)
  const active = await scanActiveMemoryFiles(root, ledger)
  const old = active.find(entry => entry.file !== newFile && entry.name === supersedes)
  if (old === undefined) return
  await recordSupersede(root, old.file, newFile)
}

/** Best-effort replay of the edit semantics for the pre-execution gate; undefined when not replayable. */
export function replayEdits(content: string, edits: unknown): string | undefined {
  if (!Array.isArray(edits) || edits.length === 0) return undefined
  let result = content
  for (const value of edits) {
    if (!isRecord(value)) return undefined
    const { oldText, newText } = value
    if (typeof oldText !== 'string' || oldText === '' || typeof newText !== 'string') return undefined
    const first = result.indexOf(oldText)
    if (first < 0) return undefined
    if (result.indexOf(oldText, first + oldText.length) >= 0) return undefined
    result = result.slice(0, first) + newText + result.slice(first + oldText.length)
  }
  return result
}

/** Whether a fact file still lacks its origin stamp or carries a missing/stale `metadata.textHash`. */
export async function fileNeedsGovernanceStamp(source: string): Promise<boolean> {
  if (basename(source) === 'MEMORY.md') return false
  const record = await readMemoryFile(source)
  if (record.status !== 'loaded') return false
  const match = FRONTMATTER.exec(record.content)
  if (match === null) return false
  const document = parseDocument(match[3] ?? '')
  if (document.errors.length > 0) return false
  const metadata = document.get('metadata')
  if (!isMap(metadata)) return true
  const originOk = nonEmptyString(metadata.get('originSessionId'))
  const hashOk = metadata.get('textHash') === memoryTextHash(record.content)
  return !(originOk && hashOk)
}

/**
 * Post-edit stamp: the origin session plus the current body's `textHash` in one atomic write-back.
 * Returns the final content, or undefined when the file cannot be read. Callers swallow errors.
 */
export async function stampFileWithGovernance(source: string, rootDir: string, sessionId: string): Promise<string | undefined> {
  if (resolveSafeMemoryPath(source, rootDir) === undefined) return undefined
  if (basename(source) === 'MEMORY.md') return undefined
  const record = await readMemoryFile(source)
  if (record.status !== 'loaded') return undefined
  const stamped = stampOriginSessionId(record.content, source, rootDir, sessionId)
  const governed = injectTextHash(stamped, memoryTextHash(stamped))
  if (governed !== record.content) {
    const temporary = join(dirname(source), `.tmp-governance-stamp-${process.pid}-${randomUUID()}`)
    try {
      await writeFile(temporary, governed, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, source)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
  return governed
}
