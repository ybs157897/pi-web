import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { RuntimeError } from '../runtime-errors.ts'
import {
  MAX_MARKETPLACE_BYTES,
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_FILES,
  MAX_PLUGIN_FILE_BYTES,
  normalizeCatalog,
  type NormalizedCatalog,
  type NormalizedPluginSource,
} from './types.ts'

export interface MarketplaceSource {
  kind: 'directory' | 'url'
  source: string
  /** Absolute local directory for `kind: 'directory'`. */
  root?: string
  /** HTTPS URL for `kind: 'url'`. */
  url?: string
}

export interface MaterializedPlugin {
  fingerprint: string
  sourceType: 'directory' | 'zip' | 'github' | 'git'
  bytes: number
}

const GITHUB_ARCHIVE = 'https://codeload.github.com'
const GIT_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

function checkedUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Source URL is invalid')
  }
  if (url.username || url.password || url.hash) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Source URL cannot contain credentials or a fragment')
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url
  throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Sources must use HTTPS (HTTP is allowed only for loopback)')
}

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (reader === undefined) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Download exceeds ${limit} bytes`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** Fetch one URL with the source rules; `undefined` means HTTP 404, other failures throw. */
async function fetchBoundedOrMissing(raw: string, limit: number): Promise<Buffer | undefined> {
  const url = checkedUrl(raw)
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    throw new RuntimeError('PROVIDER_ERROR', `Could not fetch the plugin source: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.ok) throw new RuntimeError('PROVIDER_ERROR', `Plugin source returned HTTP ${response.status}`)
  checkedUrl(response.url || url.toString())
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > limit) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Download exceeds ${limit} bytes`)
  return await readBoundedResponse(response, limit)
}

async function fetchBounded(raw: string, limit: number): Promise<Buffer> {
  const bytes = await fetchBoundedOrMissing(raw, limit)
  if (bytes === undefined) throw new RuntimeError('PROVIDER_ERROR', 'Plugin source returned HTTP 404')
  return bytes
}

function checkedGitUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Git source URL is invalid')
  }
  if (url.username || url.password || url.hash) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Git source URL cannot contain credentials or a fragment')
  if (url.protocol !== 'https:') throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Git sources must use HTTPS')
  return url.toString()
}

/** A GitHub zipball wrapper holds one top-level directory; a plain zip may not. */
async function extractedRoot(directory: string): Promise<string> {
  const items = (await readdir(directory, { withFileTypes: true }))
    .filter(item => item.name !== '__MACOSX' && item.name !== '.DS_Store')
  if (items.length === 1 && items[0]!.isDirectory()) return join(directory, items[0]!.name)
  return directory
}

async function packageSubtree(root: string, subpath: string | undefined): Promise<string> {
  if (subpath === undefined) return root
  const target = resolve(root, subpath)
  if (!within(root, target)) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Plugin path escapes its repository')
  let info
  try {
    info = await lstat(target)
  } catch {
    throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Plugin path does not exist in the repository: ${subpath}`)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Plugin path is not a directory: ${subpath}`)
  return target
}

async function materializeArchive(
  bytes: Buffer,
  destination: string,
  subpath: string | undefined,
  sourceType: 'zip' | 'github',
  fingerprint?: string,
): Promise<MaterializedPlugin> {
  const unpack = `${destination}.unpack-${randomUUID().slice(0, 8)}`
  await rm(unpack, { recursive: true, force: true }).catch(() => undefined)
  try {
    await extractZip(bytes, unpack)
    const subtree = await packageSubtree(await extractedRoot(unpack), subpath)
    const materialized = await copyDirectory(subtree, destination)
    return { ...materialized, sourceType, ...(fingerprint === undefined ? {} : { fingerprint }) }
  } finally {
    await rm(unpack, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function materializeGithub(
  source: Extract<NormalizedPluginSource, { kind: 'github' }>,
  destination: string,
): Promise<MaterializedPlugin> {
  const ref = source.ref
  const candidates = ref === undefined
    ? ['HEAD']
    : /^[0-9a-f]{7,40}$/iu.test(ref)
      ? [ref]
      : [`refs/heads/${ref}`, `refs/tags/${ref}`]
  let bytes: Buffer | undefined
  for (const candidate of candidates) {
    bytes = await fetchBoundedOrMissing(`${GITHUB_ARCHIVE}/${source.repo}/zip/${candidate}`, MAX_PLUGIN_ARCHIVE_BYTES)
    if (bytes !== undefined) break
  }
  if (bytes === undefined) throw new RuntimeError('PROVIDER_ERROR', `GitHub repository or ref was not found: ${source.repo}${ref ? `@${ref}` : ''}`)
  return await materializeArchive(bytes, destination, source.path, 'github')
}

async function materializeGit(
  source: Extract<NormalizedPluginSource, { kind: 'git' }>,
  destination: string,
): Promise<MaterializedPlugin> {
  const url = checkedGitUrl(source.url)
  const clone = `${destination}.clone-${randomUUID().slice(0, 8)}`
  await rm(clone, { recursive: true, force: true }).catch(() => undefined)
  try {
    const args = ['clone', '--depth', '1', '--single-branch', '--no-tags',
      ...(source.ref === undefined ? [] : ['--branch', source.ref]),
      '--', url, clone]
    try {
      await execFileAsync('git', args, {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (error) {
      throw new RuntimeError('PLUGIN_SOURCE_INVALID', `git clone failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await rm(join(clone, '.git'), { recursive: true, force: true }).catch(() => undefined)
    const subtree = await packageSubtree(clone, source.path)
    const materialized = await copyDirectory(subtree, destination)
    return { ...materialized, sourceType: 'git' }
  } finally {
    await rm(clone, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Accept an absolute local marketplace directory or an HTTPS URL to its marketplace.json. */
export function parseMarketplaceSource(source: string): MarketplaceSource {
  if (/^https?:\/\//iu.test(source)) {
    const url = checkedUrl(source)
    return { kind: 'url', source: url.toString(), url: url.toString() }
  }
  if (!isAbsolute(source)) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'A local marketplace source must be an absolute directory path')
  return { kind: 'directory', source, root: resolve(source) }
}

export async function loadMarketplace(source: MarketplaceSource): Promise<NormalizedCatalog> {
  if (source.kind === 'url') {
    if (source.url === undefined) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Marketplace URL is missing')
    const bytes = await fetchBounded(source.url, MAX_MARKETPLACE_BYTES)
    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      throw new RuntimeError('PLUGIN_SOURCE_INVALID', `marketplace.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    return normalizeCatalog(value, 'url')
  }

  if (source.root === undefined) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Marketplace path is missing')
  let root: string
  try {
    root = await realpath(source.root)
  } catch {
    throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'Marketplace directory is unavailable')
  }
  const info = await lstat(root)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Marketplace source must be a directory, not a symbolic link')
  const file = join(root, 'marketplace.json')
  let bytes: Buffer
  try {
    const manifestInfo = await lstat(file)
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'marketplace.json must be a regular file')
    if (manifestInfo.size > MAX_MARKETPLACE_BYTES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'marketplace.json is too large')
    bytes = await readFile(file)
  } catch (error) {
    if (error instanceof RuntimeError) throw error
    throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'marketplace.json was not found in the selected directory')
  }
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new RuntimeError('PLUGIN_SOURCE_INVALID', `marketplace.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return normalizeCatalog(value, 'directory')
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function copyDirectory(source: string, destination: string): Promise<MaterializedPlugin> {
  let root: string
  try {
    root = await realpath(source)
  } catch {
    throw new RuntimeError('PLUGIN_NOT_FOUND', 'Plugin directory is unavailable')
  }
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Plugin source must be a directory')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const digest = createHash('sha256')
  let files = 0
  let total = 0

  const walk = async (directory: string, target: string): Promise<void> => {
    const items = await readdir(directory, { withFileTypes: true })
    items.sort((left, right) => left.name.localeCompare(right.name))
    for (const item of items) {
      files += 1
      if (files > MAX_PLUGIN_FILES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Plugin contains more than ${MAX_PLUGIN_FILES} files`)
      const sourcePath = join(directory, item.name)
      const targetPath = join(target, item.name)
      if (item.isSymbolicLink()) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Plugin contains a symbolic link: ${item.name}`)
      if (item.isDirectory()) {
        await mkdir(targetPath, { recursive: true, mode: 0o700 })
        await walk(sourcePath, targetPath)
        continue
      }
      if (!item.isFile()) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Plugin contains an unsupported file type: ${item.name}`)
      const info = await lstat(sourcePath)
      if (info.size > MAX_PLUGIN_FILE_BYTES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Plugin file is too large: ${item.name}`)
      total += info.size
      if (total > MAX_PLUGIN_ARCHIVE_BYTES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Plugin package is too large')
      const bytes = await readFile(sourcePath)
      const relativePath = relative(root, sourcePath).split(sep).join('/')
      digest.update(`${relativePath}\0${createHash('sha256').update(bytes).digest('hex')}\n`)
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      await writeFile(targetPath, bytes, { mode: info.mode & 0o111 ? 0o700 : 0o600 })
    }
  }
  await walk(root, destination)
  return { fingerprint: `sha256:${digest.digest('hex')}`, sourceType: 'directory', bytes: total }
}

function u16(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP archive is truncated')
  return buffer.readUInt16LE(offset)
}

function u32(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP archive is truncated')
  return buffer.readUInt32LE(offset)
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  externalAttributes: number
  flags: number
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength <= buffer.length) return offset
  }
  throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP archive has no central directory')
}

function zipEntries(buffer: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(buffer)
  const count = u16(buffer, end + 10)
  const size = u32(buffer, end + 12)
  const offset = u32(buffer, end + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP64 archives are not supported')
  }
  if (offset + size > buffer.length) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP central directory is out of bounds')
  if (count > MAX_PLUGIN_FILES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP archive contains more than ${MAX_PLUGIN_FILES} entries`)

  const entries: ZipEntry[] = []
  let cursor = offset
  for (let index = 0; index < count; index += 1) {
    if (u32(buffer, cursor) !== 0x02014b50) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP central directory entry is invalid')
    const flags = u16(buffer, cursor + 8)
    const method = u16(buffer, cursor + 10)
    const compressedSize = u32(buffer, cursor + 20)
    const uncompressedSize = u32(buffer, cursor + 24)
    const nameLength = u16(buffer, cursor + 28)
    const extraLength = u16(buffer, cursor + 30)
    const commentLength = u16(buffer, cursor + 32)
    const externalAttributes = u32(buffer, cursor + 38)
    const localOffset = u32(buffer, cursor + 42)
    if (nameLength === 0 || cursor + 46 + nameLength > buffer.length) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP entry name is invalid')
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, externalAttributes, flags })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function zipEntryName(name: string): string {
  if (name.includes('\0') || name.includes('\\') || /^[A-Za-z]:/u.test(name) || name.startsWith('/')) {
    throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry path is unsafe: ${name}`)
  }
  const segments = name.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry path escapes the package: ${name}`)
  return segments.join('/')
}

async function extractZip(buffer: Buffer, destination: string): Promise<MaterializedPlugin> {
  const entries = zipEntries(buffer)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const seen = new Set<string>()
  let files = 0
  let total = 0

  for (const entry of entries) {
    const name = zipEntryName(entry.name)
    if (name === '') continue
    if ((entry.externalAttributes >>> 16) & 0o170000) {
      const kind = (entry.externalAttributes >>> 16) & 0o170000
      if (kind === 0o120000) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP archive contains a symbolic link: ${name}`)
      if (kind !== 0o040000 && kind !== 0o100000) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP archive contains an unsupported entry: ${name}`)
    }
    if ((entry.flags & 0x1) !== 0) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Encrypted ZIP archives are not supported')
    if (entry.method !== 0 && entry.method !== 8) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `Unsupported ZIP compression method ${entry.method}`)
    const kind = (entry.externalAttributes >>> 16) & 0o170000
    if (kind === 0o040000 || name.endsWith('/')) continue
    if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff || entry.localOffset === 0xffffffff) {
      throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP64 entries are not supported')
    }
    if (seen.has(name)) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP archive contains a duplicate entry: ${name}`)
    seen.add(name)
    files += 1
    if (files > MAX_PLUGIN_FILES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP archive contains more than ${MAX_PLUGIN_FILES} files`)
    if (entry.uncompressedSize > MAX_PLUGIN_FILE_BYTES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry is too large: ${name}`)
    total += entry.uncompressedSize
    if (total > MAX_PLUGIN_ARCHIVE_BYTES) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP archive is too large after extraction')

    if (u32(buffer, entry.localOffset) !== 0x04034b50) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP local header is invalid: ${name}`)
    const nameLength = u16(buffer, entry.localOffset + 26)
    const extraLength = u16(buffer, entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLength + extraLength
    const end = start + entry.compressedSize
    if (end > buffer.length) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry data is out of bounds: ${name}`)
    const compressed = buffer.subarray(start, end)
    let content: Buffer
    if (entry.method === 0) {
      content = compressed
    } else {
      try {
        content = inflateRawSync(compressed, { maxOutputLength: MAX_PLUGIN_FILE_BYTES })
      } catch (error) {
        throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry could not be inflated: ${name}`)
      }
    }
    if (content.byteLength !== entry.uncompressedSize) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry size mismatch: ${name}`)
    const target = join(destination, ...name.split('/'))
    if (!within(destination, target)) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry escapes the package: ${name}`)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const mode = (entry.externalAttributes >>> 16) & 0o111 ? 0o700 : 0o600
    await writeFile(target, content, { mode })
  }

  return {
    fingerprint: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
    sourceType: 'zip',
    bytes: total,
  }
}

/** Copy or download one plugin package into a staging directory. */
export async function materializePluginSource(
  source: NormalizedPluginSource,
  options: { marketplaceRoot?: string; destination: string },
): Promise<MaterializedPlugin> {
  if (source.kind === 'directory') {
    if (options.marketplaceRoot === undefined) throw new RuntimeError('PLUGIN_UNSUPPORTED_SOURCE', 'Directory packages need a local marketplace')
    const relativePath = source.path.replace(/\\/gu, '/')
    if (isAbsolute(relativePath) || relativePath.split('/').some(segment => segment === '..')) {
      throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Plugin path must stay inside its marketplace')
    }
    const target = resolve(options.marketplaceRoot, relativePath)
    if (!within(options.marketplaceRoot, target)) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'Plugin path escapes its marketplace')
    return await copyDirectory(target, options.destination)
  }
  if (source.kind === 'zip') {
    const bytes = await fetchBounded(source.url, MAX_PLUGIN_ARCHIVE_BYTES)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== source.sha256) throw new RuntimeError('PLUGIN_CHECKSUM_MISMATCH', 'Downloaded plugin checksum does not match the marketplace catalog')
    return await materializeArchive(bytes, options.destination, undefined, 'zip', `sha256:${digest}`)
  }
  if (source.kind === 'github') return await materializeGithub(source, options.destination)
  if (source.kind === 'git') return await materializeGit(source, options.destination)
  throw new RuntimeError('PLUGIN_UNSUPPORTED_SOURCE', source.reason)
}

/** Best-effort staging directory name so a crash cannot collide with the next attempt. */
export function stagingDirectory(root: string, transactionId: string, name: string): string {
  return join(root, transactionId, `${name}-${randomUUID().slice(0, 8)}`)
}

export { MAX_PLUGIN_ARCHIVE_BYTES }
