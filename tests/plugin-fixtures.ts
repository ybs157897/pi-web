/**
 * 插件 / 市场测试 fixture 工具集。
 *
 * 提供：
 * - makeZip：手写的最小 stored-ZIP 生成器（无第三方依赖、字节确定），
 *   支持符号链接条目与加密标志位，用于路径安全 / 校验和 / 中央目录解析测试；
 * - writePlugin / writeMarketplace：在临时目录中搭建标准插件包与市场目录结构；
 * - SKILL_MD / DEMO_MANIFEST / writeFixture：SKILL.md 模板、默认 manifest 与任意文件写入。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 预生成的 CRC-32 查表（多项式 0xedb88320），makeZip 计算条目校验和用。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * 计算给定缓冲区的 CRC-32 校验和（IEEE 802.3 标准，初值/终值 0xffffffff 异或）。
 * @param buffer 待校验的字节序列
 * @returns 无符号 32 位校验和
 */
export function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** 单个 ZIP 条目的描述：文件名（可含路径或以 / 结尾表示目录）、内容与可选标志。 */
export interface ZipFixtureEntry {
  name: string
  content?: string | Buffer
  symlink?: boolean
  encrypt?: boolean
}

/**
 * 最小 stored-ZIP 生成器。测试需要一个字节确定的归档而又不引入第三方依赖；
 * 全部条目使用 stored（不压缩）方式，足以覆盖路径安全、校验和与中央目录解析逻辑。
 * @param entries 条目列表，按写入顺序排列
 * @returns 完整 ZIP 字节流（本地条目 + 中央目录 + 结束记录）
 */
export function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.content ?? '')
    const crc = crc32(data)
    const mode = entry.symlink ? 0o120777 : entry.name.endsWith('/') ? 0o040755 : 0o100644
    const flags = 0x0800 | (entry.encrypt ? 0x0001 : 0)
    const local = Buffer.alloc(30 + name.length + data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    data.copy(local, 30 + name.length)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralDirectory, end])
}

/**
 * 生成符合 frontmatter 格式的 SKILL.md 文本。
 * @param name 技能名（写入 frontmatter 的 name 字段）
 * @param description 技能描述，默认 "<name> skill"
 * @returns 完整的 SKILL.md 文件内容
 */
export const SKILL_MD = (name: string, description = `${name} skill`) => [
  '---',
  `name: ${name}`,
  `description: ${description}`,
  '---',
  '',
  `Use the ${name} workflow when the task asks for it.`,
  '',
].join('\n')

/** 默认的 directory 插件 manifest fixture，writePlugin 未显式传 manifest 时使用。 */
export const DEMO_MANIFEST = {
  name: 'demo-plugin',
  version: '1.0.0',
  description: 'A directory-plugin fixture',
  skills: ['./skills'],
}

/** writePlugin 的可选项：名称/版本/技能列表、自定义 manifest 与 manifest 目录变体。 */
export interface PluginFixtureOptions {
  marketplaceName?: string
  pluginName?: string
  version?: string
  skills?: Array<{ name: string; description?: string }>
  manifest?: Record<string, unknown>
  manifestDirectory?: '.pi-plugin' | '.zcode-plugin' | '.claude-plugin'
}

/**
 * 在 root 下写出一个标准插件包：<manifestDir>/plugin.json + skills/<name>/SKILL.md。
 * @param root 插件包根目录（通常是临时目录）
 * @param options 名称/版本/技能等覆盖项；manifest 缺省时基于 DEMO_MANIFEST 生成
 */
export async function writePlugin(root: string, options: PluginFixtureOptions = {}): Promise<void> {
  const pluginName = options.pluginName ?? 'demo-plugin'
  const directory = options.manifestDirectory ?? '.pi-plugin'
  await mkdir(join(root, directory), { recursive: true })
  const manifest = options.manifest ?? {
    ...DEMO_MANIFEST,
    name: pluginName,
    version: options.version ?? '1.0.0',
  }
  await writeFile(join(root, directory, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  for (const skill of options.skills ?? [{ name: 'draw' }]) {
    const skillRoot = join(root, 'skills', skill.name)
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), SKILL_MD(skill.name, skill.description), 'utf8')
  }
}

/** writeMarketplace 的可选项：市场名、精选列表与插件条目（source 缺省为 ./<name>）。 */
export interface MarketplaceFixtureOptions {
  name?: string
  plugins: Array<{
    name: string
    version?: string
    description?: string
    category?: string
    source?: unknown
    listing?: Record<string, unknown>
  }>
  featured?: string[]
}

/**
 * 在 root 下写出 marketplace.json 市场目录文件。
 * @param root 市场目录（通常是临时目录）
 * @param options 市场名与插件清单；条目可选字段缺省时该键不出现在 JSON 中
 */
export async function writeMarketplace(root: string, options: MarketplaceFixtureOptions): Promise<void> {
  await mkdir(root, { recursive: true })
  const catalog = {
    name: options.name ?? 'fixture-market',
    description: 'Fixture marketplace',
    featured: options.featured ?? [],
    plugins: options.plugins.map(plugin => ({
      name: plugin.name,
      version: plugin.version ?? '1.0.0',
      ...(plugin.description === undefined ? {} : { description: plugin.description }),
      ...(plugin.category === undefined ? {} : { category: plugin.category }),
      source: plugin.source ?? `./${plugin.name}`,
      ...(plugin.listing === undefined ? {} : { listing: plugin.listing }),
    })),
  }
  await writeFile(join(root, 'marketplace.json'), JSON.stringify(catalog, null, 2), 'utf8')
}

/** 写入任意相对路径文件，自动创建父目录。 */
export async function writeFixture(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
