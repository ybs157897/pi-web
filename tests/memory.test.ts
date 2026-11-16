import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_MEMORY_INDEX_BYTES,
  MEMORY_INDEX_CHARACTER_LIMIT,
  MEMORY_INDEX_LINE_LIMIT,
  SENSITIVE_MEMORY_PATH_SEGMENTS,
  fileNeedsOriginStamp,
  formatMemoryIndex,
  isContainedMemoryPath,
  readMemoryFile,
  resolveMemoryRoot,
  resolveSafeMemoryPath,
  stampExistingFile,
  stampOriginSessionId,
} from '../src/server/memory/store.ts'

/** 临时目录清理队列，用例结束后按创建的逆序逐个递归删除。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 创建一个注册进清理队列的临时根目录。
 * @returns 临时目录绝对路径
 */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * 计算与 store.ts 相同的目录哈希（sha256 前 16 位；Windows 上 key 先小写化）。
 * @param path 归一化后的 workspace 绝对路径
 * @returns 16 位十六进制哈希
 */
function expectedHash(path: string): string {
  const key = process.platform === 'win32' ? path.toLowerCase() : path
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * 记忆根目录解析测试。
 *
 * 关键契约：
 * - 每个 workspace 按规范化路径得到唯一目录：`<slug>-<hash16>/memory`，slug 由 basename 转换、
 *   无可用字符时回退 `project`；
 * - 同一 workspace 结果稳定，不同 workspace 互不相同，哈希恰好 16 位；
 * - slug 截断到 48 字符；Windows 上哈希 key 大小写不敏感。
 */
describe('memory root', () => {
  // basename「My Project」转成 slug my-project，目录名含 16 位哈希，最终以 /memory 结尾。
  it('keys one directory per canonical workspace path', () => {
    const workspace = '/tmp/My Project'
    const root = resolveMemoryRoot({ dataDir: '/data', workspacePath: workspace })

    expect(root).toBe(join('/data', 'memories', 'projects', `my-project-${expectedHash(resolve(workspace))}`, 'memory'))
  })

  // 非 ASCII basename（项目）没有可用 slug 字符时回退到 project-<hash>。
  it('falls back to project when the basename has no usable characters', () => {
    const root = resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/项目' })

    expect(root).toContain(`project-${expectedHash('/tmp/项目')}`)
  })

  // 同一 workspace 多次调用结果一致；不同 workspace 结果不同；目录名中的哈希段恰好 16 位。
  it('is stable for the same workspace and distinct across workspaces', () => {
    const a = resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/a' })
    const b = resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/b' })

    expect(resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/a' })).toBe(a)
    expect(a).not.toBe(b)
    expect(a.split('/').at(-2)?.split('-').at(-1)).toHaveLength(16)
  })

  // 60 个字符的 basename 截断为 48 字符的 slug。
  it('truncates the slug to 48 characters', () => {
    const name = 'a'.repeat(60)
    const root = resolveMemoryRoot({ dataDir: '/data', workspacePath: `/tmp/${name}` })

    expect(root).toContain(`${'a'.repeat(48)}-`)
  })

  // 模拟 win32 平台：哈希 key 用小写路径计算，同一目录不同大小写仍能对上。
  it('lowercases the hash key on Windows', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const root = resolveMemoryRoot({ dataDir: 'C:\\data', workspacePath: 'C:\\Work\\Demo' })
      const normalized = resolve('C:\\Work\\Demo')
      const expected = createHash('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 16)

      expect(root).toContain(expected)
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  })
})

/**
 * 记忆路径安全测试。
 *
 * 关键契约：
 * - resolveSafeMemoryPath 只接受 root 之内的 .md 文件：越界（..）、root 外绝对路径、root 本身都拒绝；
 * - isContainedMemoryPath 是更宽松的包含判断（不限 .md），供直接写入检测使用；
 * - 受保护段（SENSITIVE_MEMORY_PATH_SEGMENTS，如 .git/HEAD/config 等）及其归一化形近体
 *   （尾点、冒号别名、零宽字符、尾空格、反斜杠路径、skills 目录）全部拒绝。
 */
describe('memory path safety', () => {
  /** 测试用的假记忆根目录。 */
  const root = '/data/memories/projects/demo-0123456789abcdef/memory'

  // root 内的 .md（含嵌套）接受；.txt、越界 ..、root 外绝对路径、root 本身都返回 undefined。
  it('accepts contained Markdown paths and rejects everything else', () => {
    expect(resolveSafeMemoryPath(join(root, 'prefs.md'), root)).toBe(join(root, 'prefs.md'))
    expect(resolveSafeMemoryPath(join(root, 'nested', 'prefs.md'), root)).toBe(join(root, 'nested', 'prefs.md'))
    expect(resolveSafeMemoryPath(join(root, 'prefs.txt'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, '..', 'escape.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath('/etc/passwd.md', root)).toBeUndefined()
    expect(resolveSafeMemoryPath(root, root)).toBeUndefined()
  })

  // 包含判断独立于扩展名：notes.txt 在 root 内也算 contained；越界则否（供直写检测）。
  it('containment alone does not require Markdown (direct-write detection)', () => {
    expect(isContainedMemoryPath(join(root, 'notes.txt'), root)).toBe(true)
    expect(isContainedMemoryPath(join(root, '..', 'x'), root)).toBe(false)
  })

  // 每一个受保护路径段出现在路径中时都拒绝（逐段穷举）。
  it('rejects every protected segment', () => {
    for (const segment of SENSITIVE_MEMORY_PATH_SEGMENTS) {
      expect(resolveSafeMemoryPath(join(root, segment, 'fact.md'), root), segment).toBeUndefined()
    }
  })

  // 形近体也拒绝：尾点（HEAD.）、Windows ADS（config:ads）、零宽字符插入（co\u200cnfig）、
  // 尾空格（.git   ）、反斜杠分隔（\.git\）、skills 目录。
  it('rejects normalized lookalikes of protected segments', () => {
    expect(resolveSafeMemoryPath(join(root, 'HEAD.', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, 'config:ads', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, 'co\u200cnfig', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, '.git   ', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(`${root}\\.git\\fact.md`, root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, 'skills', 'fact.md'), root)).toBeUndefined()
  })
})

/**
 * 记忆索引格式化测试。
 *
 * 关键契约：
 * - 剥掉 YAML frontmatter 与顶层 HTML 注释，但保留围栏代码块里的注释；
 * - 空内容或纯注释返回空串；
 * - 超行数限制按行截断并追加中文警告；超字符限制在换行边界截断并追加「索引行过长」警告；
 * - 两项同时超限时警告同时报告两个限制值。
 */
describe('memory index formatting', () => {
  // frontmatter（name: index）与顶层注释被剥掉；围栏代码块内的注释与正文条目保留。
  it('strips frontmatter and top-level comments but keeps fenced comments', () => {
    const content = [
      '---',
      'name: index',
      '---',
      '<!-- top-level comment -->',
      '- [One](one.md) — first',
      '',
      '```',
      '<!-- code comment -->',
      '```',
    ].join('\n')
    const formatted = formatMemoryIndex(content)

    expect(formatted).not.toContain('name: index')
    expect(formatted).not.toContain('top-level comment')
    expect(formatted).toContain('<!-- code comment -->')
    expect(formatted).toContain('- [One](one.md) — first')
  })

  // 空串、纯空白、只有一条注释的内容都格式化为空串。
  it('returns an empty string for empty or comment-only content', () => {
    expect(formatMemoryIndex('')).toBe('')
    expect(formatMemoryIndex('  \n\n')).toBe('')
    expect(formatMemoryIndex('<!-- only a comment -->\n')).toBe('')
  })

  // 超过行数上限时保留前 N 行（首行是 line 0、不出现 line 200），并追加中文部分加载警告。
  it('truncates by lines and appends the warning', () => {
    const content = Array.from({ length: MEMORY_INDEX_LINE_LIMIT + 1 }, (_, index) => `- line ${index}`).join('\n')
    const formatted = formatMemoryIndex(content)

    expect(formatted.split('\n')[0]).toBe('- line 0')
    expect(formatted).toContain(`> 警告：MEMORY.md 超过 ${MEMORY_INDEX_LINE_LIMIT} 行，仅加载了部分内容。`)
    expect(formatted).not.toContain('- line 200')
  })

  // 超字符上限时在换行边界截断（最后一行不完整、不会以完整长行结尾），追加「索引行过长」警告。
  it('truncates by characters at a newline boundary and appends the warning', () => {
    const line = `- ${'x'.repeat(130)}`
    const content = Array.from({ length: 200 }, () => line).join('\n')
    expect(content.length).toBeGreaterThan(MEMORY_INDEX_CHARACTER_LIMIT)
    const formatted = formatMemoryIndex(content)

    expect(formatted.length).toBeLessThan(MEMORY_INDEX_CHARACTER_LIMIT + 200)
    expect(formatted).toContain('——索引行过长')
    expect(formatted.endsWith(line)).toBe(false)
  })

  // 行数与字符同时超限时警告同时报告两个限制值。
  it('reports both limits when both are exceeded', () => {
    const content = Array.from({ length: MEMORY_INDEX_LINE_LIMIT + 5 }, () => `- ${'y'.repeat(200)}`).join('\n')
    const formatted = formatMemoryIndex(content)

    expect(formatted).toContain(`超过 ${MEMORY_INDEX_LINE_LIMIT} 行且超过 ${MEMORY_INDEX_CHARACTER_LIMIT} 字符`)
  })
})

/**
 * 记忆文件读取测试。
 *
 * 关键契约：
 * - 普通文件读出 loaded 状态与内容；不存在返回 missing；
 * - 拒绝一切非普通文件形态：符号链接（source-symlink）、超大文件（source-too-large）、
 *   非法 UTF-8/含 NUL 字节（source-invalid-utf8）、目录（source-not-regular-file）。
 */
describe('memory file reads', () => {
  // 真实文件返回 loaded 并带内容；不存在的文件返回 { status: 'missing' }。
  it('reads a regular file and reports missing files', async () => {
    const root = await tempRoot()
    const source = join(root, 'MEMORY.md')
    await writeFile(source, '- [One](one.md) — first\n')

    const loaded = await readMemoryFile(source)
    expect(loaded.status).toBe('loaded')
    if (loaded.status !== 'loaded') return
    expect(loaded.content).toContain('- [One](one.md)')

    expect(await readMemoryFile(join(root, 'absent.md'))).toEqual({ status: 'missing' })
  })

  // 五类拒绝各带 reason：symlink、超大小上限、非法 UTF-8（含 NUL 字节同类）、目录。
  it('rejects symlinks, oversized files, invalid UTF-8, and NUL bytes', async () => {
    const root = await tempRoot()
    const target = join(root, 'target.md')
    await writeFile(target, 'text\n')
    const link = join(root, 'link.md')
    await symlink(target, link)
    expect(await readMemoryFile(link)).toEqual({ status: 'error', reason: 'source-symlink' })

    const large = join(root, 'large.md')
    await writeFile(large, 'x'.repeat(MAX_MEMORY_INDEX_BYTES + 1))
    expect(await readMemoryFile(large)).toEqual({ status: 'error', reason: 'source-too-large' })

    const invalid = join(root, 'invalid.md')
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0xfd]))
    expect(await readMemoryFile(invalid)).toEqual({ status: 'error', reason: 'source-invalid-utf8' })

    const nul = join(root, 'nul.md')
    await writeFile(nul, 'a\0b')
    expect(await readMemoryFile(nul)).toEqual({ status: 'error', reason: 'source-invalid-utf8' })

    const directory = join(root, 'dir.md')
    await mkdir(directory)
    expect(await readMemoryFile(directory)).toEqual({ status: 'error', reason: 'source-not-regular-file' })
  })
})

/**
 * originSessionId 戳记测试。
 *
 * 关键契约：
 * - 给 frontmatter 补 metadata：node_type: memory 排第一，originSessionId 用引号字符串；
 * - 已有 metadata 时保留原键；幂等且不覆盖已有 origin；
 * - 保留 CRLF 行尾与 BOM；
 * - 无 frontmatter、YAML 解析失败、metadata 非映射、路径越界等情况原样返回不动内容；
 * - fileNeedsOriginStamp / stampExistingFile 对普通事实文件判定并补戳（只补一次），MEMORY.md 不需要戳。
 */
describe('originSessionId stamping', () => {
  /** 测试用的假记忆根目录与目标文件。 */
  const root = '/data/memories/projects/demo-0123456789abcdef/memory'
  const file = join(root, 'prefs.md')

  // 没有 metadata 块时新建：node_type 是第一个 metadata 键，originSessionId 为带引号字符串，正文保持。
  it('adds node_type as the first metadata key when metadata is absent', () => {
    const content = '---\nname: prefs\ndescription: prefers Chinese\n---\n\nBody\n'
    const stamped = stampOriginSessionId(content, file, root, '42')

    expect(stamped).toBe([
      '---',
      'name: prefs',
      'description: prefers Chinese',
      'metadata:',
      '  node_type: memory',
      '  originSessionId: "42"',
      '---',
      '',
      'Body',
      '',
    ].join('\n'))
  })

  // 已有 metadata 键（type: user）时原键保留，node_type 插到最前、originSessionId 追加在后。
  it('keeps existing metadata keys and places node_type first', () => {
    const content = '---\nname: prefs\nmetadata:\n  type: user\n---\nBody\n'
    const stamped = stampOriginSessionId(content, file, root, '42')

    expect(stamped).toContain('metadata:\n  node_type: memory\n  type: user\n  originSessionId: "42"')
  })

  // 幂等：对已戳文件用不同 sessionId 再戳，内容不变，origin 仍是第一次的 "7"（不覆盖）。
  it('is idempotent and never overwrites an existing origin', () => {
    const first = stampOriginSessionId('---\nname: prefs\n---\nBody\n', file, root, '7')
    const second = stampOriginSessionId(first, file, root, '99')

    expect(second).toBe(first)
    expect(second).toContain('originSessionId: "7"')
    expect(second).not.toContain('"99"')
  })

  // CRLF 行尾与 BOM 都保留：戳记以 \r\n 写入，BOM 仍在开头，正文与结束符原样。
  it('preserves CRLF line endings and a BOM', () => {
    const content = '\uFEFF---\r\nname: prefs\r\n---\r\nBody\r\n'
    const stamped = stampOriginSessionId(content, file, root, '5')

    expect(stamped.startsWith('\uFEFF---\r\n')).toBe(true)
    expect(stamped).toContain('\r\n  node_type: memory\r\n')
    expect(stamped.endsWith('---\r\nBody\r\n')).toBe(true)
  })

  // 五类不处理的情况原样返回：无 frontmatter、YAML 解析错误、metadata 非映射、metadata 为空、文件在 root 外。
  it('leaves malformed or unrecognized content untouched', () => {
    const noFrontmatter = 'Just body text\n'
    expect(stampOriginSessionId(noFrontmatter, file, root, '1')).toBe(noFrontmatter)

    const yamlError = '---\nname: [unclosed\n---\nBody\n'
    expect(stampOriginSessionId(yamlError, file, root, '1')).toBe(yamlError)

    const metadataNotMap = '---\nname: prefs\nmetadata: memory\n---\nBody\n'
    expect(stampOriginSessionId(metadataNotMap, file, root, '1')).toBe(metadataNotMap)

    const nullMetadata = '---\nname: prefs\nmetadata:\n---\nBody\n'
    expect(stampOriginSessionId(nullMetadata, file, root, '1')).toBe(nullMetadata)

    const outsideRoot = join(root, '..', 'x.md')
    expect(stampOriginSessionId('---\nname: x\n---\nBody\n', outsideRoot, root, '1')).toBe('---\nname: x\n---\nBody\n')
  })

  // 真实文件流程：无戳判定 true → stampExistingFile 写入 "11" → 判定 false；重复 stamp 不改变已有 origin。
  it('detects files that still need a stamp and writes one back', async () => {
    const directory = await tempRoot()
    const source = join(directory, 'fact.md')
    await writeFile(source, '---\nname: fact\ndescription: a fact\n---\nBody\n')

    expect(await fileNeedsOriginStamp(source)).toBe(true)
    await stampExistingFile(source, directory, '11')
    expect(await fileNeedsOriginStamp(source)).toBe(false)
    const record = await readMemoryFile(source)
    expect(record.status === 'loaded' && record.content).toContain('originSessionId: "11"')

    await stampExistingFile(source, directory, '12')
    const again = await readMemoryFile(source)
    expect(again.status === 'loaded' && again.content).toContain('originSessionId: "11"')
  })

  // MEMORY.md（索引）不属于需要戳记的事实文件，判定为 false。
  it('does not treat MEMORY.md as needing a stamp', async () => {
    const directory = await tempRoot()
    const source = join(directory, 'MEMORY.md')
    await writeFile(source, '- [One](one.md) — first\n')

    expect(await fileNeedsOriginStamp(source)).toBe(false)
  })
})
