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

/** 市场来源：本地绝对目录或指向 marketplace.json 的 HTTPS URL。 */
export interface MarketplaceSource {
  kind: 'directory' | 'url'
  source: string
  /** `kind: 'directory'` 时的绝对本地目录。 */
  root?: string
  /** `kind: 'url'` 时的 HTTPS URL。 */
  url?: string
}

/** 一次物化的结果：来源指纹、来源类型与总字节数。 */
export interface MaterializedPlugin {
  fingerprint: string
  sourceType: 'directory' | 'zip' | 'github' | 'git'
  bytes: number
}

const GITHUB_ARCHIVE = 'https://codeload.github.com'
const GIT_TIMEOUT_MS = 120_000
const execFileAsync = promisify(execFile)

/** 判断主机名是否为环回地址（localhost / 127.0.0.1 / ::1 / *.localhost）。 */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

/**
 * 功能：校验来源 URL：必须是 https（http 仅限环回），且不得带凭据或 fragment。
 * @returns 解析后的 URL 对象；非法时抛 PLUGIN_SOURCE_INVALID
 */
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

/** 流式读取响应体并实时累计字节，超过 limit 立即取消读取并抛错。 */
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

/** 按来源规则抓取一个 URL；HTTP 404 返回 undefined，其余失败抛错（PROVIDER_ERROR / PLUGIN_SOURCE_INVALID）。 */
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

/** fetchBoundedOrMissing 的必得版本：404 也抛 PROVIDER_ERROR。 */
async function fetchBounded(raw: string, limit: number): Promise<Buffer> {
  const bytes = await fetchBoundedOrMissing(raw, limit)
  if (bytes === undefined) throw new RuntimeError('PROVIDER_ERROR', 'Plugin source returned HTTP 404')
  return bytes
}

/** 校验 git 仓库 URL：必须是 https 且不得带凭据或 fragment；返回规范化的 URL 字符串。 */
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

/** GitHub zipball 外面套一层顶层目录，普通 zip 未必；只有一个子目录时穿透进它。 */
async function extractedRoot(directory: string): Promise<string> {
  const items = (await readdir(directory, { withFileTypes: true }))
    .filter(item => item.name !== '__MACOSX' && item.name !== '.DS_Store')
  if (items.length === 1 && items[0]!.isDirectory()) return join(directory, items[0]!.name)
  return directory
}

/** 取仓库内的插件子目录：未声明 subpath 用根；声明了则校验在根内、真实存在且非符号链接目录。 */
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

/**
 * 功能：把 zip 字节流物化到 staging 目标目录（zip / github 来源共用）。
 * @param bytes 压缩包字节
 * @param destination staging 目标目录
 * @param subpath 包内插件子目录（可选）
 * @param sourceType 来源类型，写入结果
 * @param fingerprint 预计算指纹（zip 来源带下载内容的 sha256；github 不带）
 * 内部逻辑：先解压到独立 `.unpack-*` 临时目录，穿透 zipball 包装目录、定位子树
 * 后复制到 destination；无论成败 finally 都清理临时目录。
 */
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

/**
 * 功能：从 codeload.github.com 下载 zipball 并物化 github 来源。
 * 内部逻辑：ref 为空取 HEAD；ref 是 7–40 位十六进制当作提交直接用，否则依次
 * 尝试 refs/heads/ 与 refs/tags/ 前缀；全部 404 报 PROVIDER_ERROR。
 */
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

/**
 * 功能：git clone（浅克隆单分支、禁终端交互、限时 120s）后物化 git 来源。
 * 内部逻辑：克隆到独立 `.clone-*` 临时目录，删除 .git 后按 subpath 定位子树并
 * 复制到 destination；clone 失败抛 PLUGIN_SOURCE_INVALID；finally 清理临时目录。
 */
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

/** 解析市场来源声明：接受本地绝对目录路径或指向 marketplace.json 的 HTTPS URL。 */
export function parseMarketplaceSource(source: string): MarketplaceSource {
  if (/^https?:\/\//iu.test(source)) {
    const url = checkedUrl(source)
    return { kind: 'url', source: url.toString(), url: url.toString() }
  }
  if (!isAbsolute(source)) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'A local marketplace source must be an absolute directory path')
  return { kind: 'directory', source, root: resolve(source) }
}

/**
 * 功能：加载市场目录并归一化。
 * @param source parseMarketplaceSource 的结果
 * @returns NormalizedCatalog（按市场 kind 归一化各条目来源）
 * 内部逻辑：URL 来源走受限下载 + normalizeCatalog；本地目录要求 realpath 后仍是
 * 普通目录、marketplace.json 是常规文件且不超 4 MB，再 JSON 解析并归一化；
 * 目录/文件缺失抛 MARKETPLACE_NOT_FOUND。
 */
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

/** 判断 target 是否位于 root 内（含等于 root），防路径逃逸。 */
function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * 功能：把本地插件目录递归复制到目标目录并计算来源指纹。
 * @returns `{ fingerprint, sourceType: 'directory', bytes }`
 * 内部逻辑：realpath 后必须是普通目录；遍历按名称排序，条目数/单文件/总量均受
 * 上限约束；符号链接与非常规文件直接拒绝；指纹 = 对「相对路径\0文件内容sha256」
 * 序列再取 sha256；可执行位保留（0o700），否则 0o600。
 */
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

/** 读小端 16 位；越界抛「ZIP 已截断」。 */
function u16(buffer: Buffer, offset: number): number {
  if (offset + 2 > buffer.length) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP archive is truncated')
  return buffer.readUInt16LE(offset)
}

/** 读小端 32 位；越界抛「ZIP 已截断」。 */
function u32(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP archive is truncated')
  return buffer.readUInt32LE(offset)
}

/** 中央目录中的一个条目。 */
interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  externalAttributes: number
  flags: number
}

/** 从尾部倒序扫描 EOCD 魔数（含可能的 zip 注释），返回其偏移；找不到抛错。 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength <= buffer.length) return offset
  }
  throw new RuntimeError('PLUGIN_SOURCE_INVALID', 'ZIP archive has no central directory')
}

/** 解析中央目录：拒绝 ZIP64、越界与超量条目，逐条校验魔数与名称长度后返回条目列表。 */
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

/** 条目名安全化：拒绝 NUL/反斜杠/盘符/绝对路径与 `..` 上跳（防 Zip Slip）；返回归一化路径。 */
function zipEntryName(name: string): string {
  if (name.includes('\0') || name.includes('\\') || /^[A-Za-z]:/u.test(name) || name.startsWith('/')) {
    throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry path is unsafe: ${name}`)
  }
  const segments = name.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `ZIP entry path escapes the package: ${name}`)
  return segments.join('/')
}

/**
 * 功能：把 zip 字节流安全解包到 destination（自研解析，不依赖 zip 库）。
 * @returns `{ fingerprint, sourceType: 'zip', bytes }`；指纹是整个压缩包字节的 sha256
 * 内部逻辑：逐条目校验——符号链接/特殊文件/加密/不支持的压缩方法/ZIP64/重复
 * 条目/条目数与大小超限全部拒绝；解压（仅 store 与 deflate）后核对解压尺寸，
 * 再用 within 复核落点在 destination 内（防 Zip Slip）；目录条目跳过。
 */
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

/**
 * 功能：把一个目录来源的插件复制、或下载远端包并物化，统一送入 staging 目录。
 * @param source 归一化后的插件来源
 * @param options.marketplaceRoot 本地市场根（directory 来源必填）
 * @param options.destination staging 目标目录
 * @returns MaterializedPlugin（含指纹与类型）
 * 内部逻辑（各来源物化规则）：directory 从市场根内解析相对路径并复制；zip 下载
 * 后先核 sha256 校验和（不符抛 PLUGIN_CHECKSUM_MISMATCH）再解压；github 下载
 * zipball；git 浅克隆；unsupported 抛 PLUGIN_UNSUPPORTED_SOURCE。
 */
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

/** 生成 staging 目录名：`<root>/<事务ID>/<名称>-<随机后缀>`，崩溃后不会与下次尝试相撞。 */
export function stagingDirectory(root: string, transactionId: string, name: string): string {
  return join(root, transactionId, `${name}-${randomUUID().slice(0, 8)}`)
}

export { MAX_PLUGIN_ARCHIVE_BYTES }
