import { Buffer } from 'node:buffer'

/**
 * 标题生成政策常量：DSH 发布版标题策略的 1:1 镜像，保证 pi-web 的标题观感一致。
 * `fallbackMaxWords`/`fallbackMaxBytes`/`maxTitleBytes` 来自 session-title 服务的限制，
 * 生成侧参数来自首次提示的 LLM provider 配置。
 */
export const TITLE_POLICY = {
  fallbackMaxWords: 8,
  fallbackMaxBytes: 96,
  maxTitleBytes: 120,
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 4096,
  /**
   * DSH 把它压到 32，因为其适配器对标题调用禁用了思考；pi-ai 没有用途标记，
   * 声明 `off: null` 的模型也关不掉思考，所以预算要覆盖推理前导文本。
   */
  titleMaxOutputTokens: 1_024,
  timeoutMs: 15_000,
} as const

/** OSC（操作系统命令）终端转义序列，含未闭合的尾部。 */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** CSI（控制序列引导符）转义，如 SGR 颜色码。 */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** 其余两字节 ESC 控制序列。 */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** 非空白 C0/C1 控制字符。 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** 方向性与不可见控制符：会让展示出来的标题产生误导。 */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/**
 * 功能：清除标题文本中的终端与方向性控制字符，产出单行、去首尾空白、空白归一的文本。
 * @param input 原始标题文本（可能含转义序列与多行）。
 * @returns 终端安全的一行纯文本。
 * 内部逻辑：依次移除 OSC/CSI/ESC 序列、控制字符与方向性控制符，再把全部空白压成单空格并 trim。
 */
export function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 功能：按 UTF-8 字节预算截断文本，不劈开任何 Unicode 码点。
 * @param input 原始文本。
 * @param maxBytes 最大字节数。
 * @returns 不超预算的最长前缀；未超预算时原样返回。
 * 内部逻辑：先做整体比较短路；超限时按码点逐个累加字节数，装不下即停。
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * 功能：把一个被接受的标题归一化为终态形态——终端安全、单行、不超字节预算。
 * @param input 原始标题文本。
 * @param maxBytes 字节上限，默认 TITLE_POLICY.maxTitleBytes。
 * @returns 清洗并截断后的标题（仅去掉尾部空白）。
 * 内部逻辑：先 cleanTitleText 再 truncateTitleUtf8，最后 trimEnd。
 */
export function normalizeSessionTitle(input: string, maxBytes: number = TITLE_POLICY.maxTitleBytes): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

/**
 * 功能：生成确定性的兜底标题（在 LLM 标题生成之前或替代之）——取首条合格人类消息的前几个词。
 * @param text 首条人类消息的文本。
 * @param maxWords 词数上限，默认 TITLE_POLICY.fallbackMaxWords。
 * @param maxBytes 字节上限，默认 TITLE_POLICY.fallbackMaxBytes。
 * @returns 兜底标题；清洗后为空时返回空串。
 * 内部逻辑：清洗后按空格切词，取前 maxWords 个重新拼接，再按字节预算截断。
 */
export function fallbackSessionTitle(
  text: string,
  maxWords: number = TITLE_POLICY.fallbackMaxWords,
  maxBytes: number = TITLE_POLICY.fallbackMaxBytes,
): string {
  const cleaned = cleanTitleText(text)
  if (cleaned === '') return ''
  const words = cleaned.split(' ')
  return truncateTitleUtf8(words.slice(0, maxWords).join(' '), maxBytes).trimEnd()
}

/**
 * 功能：生成与 DSH 标题 provider 一致、随政策参数变化的系统指令（语言感知且稳定）。
 * @param policy 标题政策；默认 TITLE_POLICY。targetWords/targetCjkCharacters 会注入文案。
 * @returns 多行系统提示词文本（内容为固定中文约定，非代码可改）。
 */
export function titleSystemPrompt(policy: typeof TITLE_POLICY = TITLE_POLICY): string {
  return [
    '根据提供的人类消息，为 AI 编程助手会话生成简短标题。',
    '仅返回一行自然语言纯文本标题，不加引号、前缀、解释、Markdown、XML 或终端控制字符。禁止包含代码。',
    '使用消息所用的语言。',
    `非 CJK 语言约 ${policy.targetWords} 个词，CJK 语言约 ${policy.targetCjkCharacters} 个字符。`,
  ].join('\n')
}

/**
 * 功能：把待总结的人类消息按 JSON 数组精确框架成一次标题生成的用户提示。
 * @param messages 消息列表（seq 为序号，text 为消息文本）。
 * @returns 提示词文本；JSON 序列化保证用户文本无法破坏结构定界符。
 */
export function frameTitleMessages(messages: readonly { seq: number; text: string }[]): string {
  return `根据以下人类消息 JSON 数组生成会话标题：\n${JSON.stringify(messages)}`
}
