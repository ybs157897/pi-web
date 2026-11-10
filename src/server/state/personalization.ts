import { constants } from 'node:fs'
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RuntimeError } from '../runtime-errors.ts'

/**
 * ZCode's personalization is a user-level `AGENTS.md` in the app home rather than a settings
 * field; this keeps the same file and scope so the editor and a hand edit stay one source.
 */
export const PERSONALIZATION_FILE = 'AGENTS.md'
/** ZCode reads and saves at most 100 KB; past that the file is truncated and saves are refused. */
export const MAX_PERSONALIZATION_BYTES = 100 * 1024

export type PersonalizationIssue = 'source-unreadable' | 'source-invalid-utf8'

export interface PersonalizationRecord {
  status: 'loaded' | 'missing' | 'error'
  filePath: string
  content: string
  bytes: number
  truncated: boolean
  issue?: PersonalizationIssue
}

export function personalizationPath(dataDir: string): string {
  return join(dataDir, PERSONALIZATION_FILE)
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/** Read the user-level instructions; a missing file is a normal empty state, not an error. */
export async function readPersonalization(dataDir: string): Promise<PersonalizationRecord> {
  const filePath = personalizationPath(dataDir)
  // O_NONBLOCK keeps a replaced-by-FIFO path from blocking the request; regular files ignore it.
  const nonBlockFlag = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | nonBlockFlag)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return { status: 'missing', filePath, content: '', bytes: 0, truncated: false }
    }
    return { status: 'error', filePath, content: '', bytes: 0, truncated: false, issue: 'source-unreadable' }
  }

  try {
    const buffer = Buffer.alloc(MAX_PERSONALIZATION_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const truncated = bytesRead > MAX_PERSONALIZATION_BYTES
    const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_PERSONALIZATION_BYTES))
    let content: string
    try {
      // `stream` only when truncated: it drops an incomplete trailing code point instead of
      // failing, while every other invalid byte still rejects the file.
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
    } catch {
      return { status: 'error', filePath, content: '', bytes: bytes.length, truncated, issue: 'source-invalid-utf8' }
    }
    return { status: 'loaded', filePath, content, bytes: bytes.length, truncated }
  } catch {
    return { status: 'error', filePath, content: '', bytes: 0, truncated: false, issue: 'source-unreadable' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Replace the file atomically; the caller validates the shape, this enforces size and encoding. */
export async function writePersonalization(dataDir: string, content: string): Promise<void> {
  if (content.includes('\0')) throw new RuntimeError('INVALID_INPUT', '个性化指令不能包含空字符')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_PERSONALIZATION_BYTES) {
    throw new RuntimeError('INVALID_INPUT', `个性化指令超过 ${MAX_PERSONALIZATION_BYTES / 1024} KB 上限（当前 ${Math.ceil(bytes / 1024)} KB）`)
  }
  const filePath = personalizationPath(dataDir)
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temp = join(dirname(filePath), `.tmp-${process.pid}-${crypto.randomUUID()}`)
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600)
    await rename(temp, filePath)
    await chmod(filePath, 0o600)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

const BODY_TAG = 'personal_instructions'

/**
 * Render the record for the system prompt. An absent or empty file contributes nothing, so the
 * prompt stays byte-identical for users who never open the panel. A literal closing tag in the
 * body is escaped so quoted text cannot end the block early.
 */
export function renderPersonalization(record: PersonalizationRecord): string | undefined {
  if (record.status === 'missing') return undefined
  if (record.status === 'loaded') {
    if (record.content.trim() === '') return undefined
    const body = record.content.split(`</${BODY_TAG}`).join(`<\\/${BODY_TAG}`)
    return [
      `User personalization instructions (${record.filePath}) apply to every workspace. Project instructions and explicit task instructions win on conflict:`,
      `<${BODY_TAG}>`,
      body,
      `</${BODY_TAG}>`,
      ...(record.truncated ? [`(The file exceeds the ${MAX_PERSONALIZATION_BYTES / 1024} KB read limit, so only its first part applies.)`] : []),
    ].join('\n')
  }
  return `User personalization instructions at ${record.filePath} could not be loaded (${record.issue ?? record.status}); do not claim to follow them.`
}
