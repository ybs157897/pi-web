import { constants } from 'node:fs'
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RuntimeError } from '../runtime-errors.ts'

/**
 * 个性化指令常量：ZCode 的个性化是应用主目录下的用户级 `AGENTS.md` 文件而非设置字段；
 * 保持同一文件与作用域，编辑器与手工编辑共享一份来源。
 */
export const PERSONALIZATION_FILE = 'AGENTS.md'
/** ZCode 最多读写 100 KB；超出部分截断，保存直接拒绝。 */
export const MAX_PERSONALIZATION_BYTES = 100 * 1024

/** 读取失败的具象原因：文件不可读，或不是合法 UTF-8。 */
export type PersonalizationIssue = 'source-unreadable' | 'source-invalid-utf8'

/**
 * 个性化指令的读取记录：status 区分正常加载 / 文件缺失（正常空态）/ 读取错误；
 * truncated 标记超出上限被截断；issue 仅在 error 时给出原因。
 */
export interface PersonalizationRecord {
  status: 'loaded' | 'missing' | 'error'
  filePath: string
  content: string
  bytes: number
  truncated: boolean
  issue?: PersonalizationIssue
}

/**
 * 功能：拼出个性化文件在数据目录下的绝对路径。
 * @param dataDir 应用数据目录。
 * @returns `dataDir/AGENTS.md`。
 */
export function personalizationPath(dataDir: string): string {
  return join(dataDir, PERSONALIZATION_FILE)
}

/**
 * 功能：从未知错误对象中安全提取 `code` 字符串（Node fs 错误约定），非对象或非字符串时返回 undefined。
 * @param error 任意抛出的错误值。
 */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

/**
 * 功能：读取用户级个性化指令；文件缺失是正常空态而非错误。
 * @param dataDir 应用数据目录。
 * @returns PersonalizationRecord：loaded（含内容与截断标记）/ missing / error（附 issue）。
 * 内部逻辑：以 O_NONBLOCK 打开，防止路径被替换成 FIFO 时阻塞请求（普通文件忽略该标志）；
 * 按上限+1 逐段读满以检测截断；仅在截断时用流式 UTF-8 解码（丢弃不完整尾码点），
 * 其余非法字节仍拒绝该文件。
 */
export async function readPersonalization(dataDir: string): Promise<PersonalizationRecord> {
  const filePath = personalizationPath(dataDir)
  // O_NONBLOCK 防止被替换成 FIFO 的路径阻塞请求；普通文件会忽略它。
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
      // 仅在截断时用流式解码：丢弃不完整的尾部码点而不是失败；其余非法字节仍会拒绝该文件。
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

/**
 * 功能：原子替换个性化文件；内容形状由调用方校验，本函数只强制大小与编码约束。
 * @param dataDir 应用数据目录。
 * @param content 新的个性化内容（UTF-8 文本）。
 * @returns 成功无返回值；包含空字符或超过字节上限时抛 INVALID_INPUT。
 * 内部逻辑：先做写入前置校验（空字符、大小）；再经"临时文件（wx 独占创建，0600）→ chmod → rename"三步
 * 原子落盘，目录 0700；任一步失败即清理临时文件并原样抛出。
 */
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

/** 提示词中包裹个性化内容的 XML 标签名，渲染与转义共用。 */
const BODY_TAG = 'personal_instructions'

/**
 * 功能：把读取记录渲染进系统提示词。
 * @param record readPersonalization 的结果。
 * @returns 渲染文本；文件缺失或内容为空时返回 undefined——从不打开该面板的用户提示词保持逐字节不变。
 * 内部逻辑：loaded 时拼接权威框定句 + `<personal_instructions>` 包裹体；正文中的字面结束标签会被转义，
 * 防止被引用文本提前闭合块；截断时附加说明行；error 时输出"未加载、不要声称已遵循"的提示行。
 */
export function renderPersonalization(record: PersonalizationRecord): string | undefined {
  if (record.status === 'missing') return undefined
  if (record.status === 'loaded') {
    if (record.content.trim() === '') return undefined
    const body = record.content.split(`</${BODY_TAG}`).join(`<\\/${BODY_TAG}`)
    return [
      `用户个性化指令（${record.filePath}）适用于所有工作区。发生冲突时，项目指令和明确的任务指令优先：`,
      `<${BODY_TAG}>`,
      body,
      `</${BODY_TAG}>`,
      ...(record.truncated ? [`（文件超过 ${MAX_PERSONALIZATION_BYTES / 1024} KB 读取上限，仅已读取的开头部分生效。）`] : []),
    ].join('\n')
  }
  return `无法加载 ${record.filePath} 的用户个性化指令（${record.issue ?? record.status}）；不要声称已遵循。`
}
