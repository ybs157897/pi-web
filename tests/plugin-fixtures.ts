import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

export interface ZipFixtureEntry {
  name: string
  content?: string | Buffer
  symlink?: boolean
  encrypt?: boolean
}

/**
 * Minimal stored-ZIP writer. Tests need a deterministic archive without adding a dependency;
 * stored entries are enough to exercise path safety, checksums, and the central directory reader.
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

export const SKILL_MD = (name: string, description = `${name} skill`) => [
  '---',
  `name: ${name}`,
  `description: ${description}`,
  '---',
  '',
  `Use the ${name} workflow when the task asks for it.`,
  '',
].join('\n')

export const DEMO_MANIFEST = {
  name: 'demo-plugin',
  version: '1.0.0',
  description: 'A directory-plugin fixture',
  skills: ['./skills'],
}

export interface PluginFixtureOptions {
  marketplaceName?: string
  pluginName?: string
  version?: string
  skills?: Array<{ name: string; description?: string }>
  manifest?: Record<string, unknown>
  manifestDirectory?: '.pi-plugin' | '.zcode-plugin' | '.claude-plugin'
}

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

/** Write an arbitrary relative file, creating parents. */
export async function writeFixture(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
