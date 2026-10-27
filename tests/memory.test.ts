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
} from '../src/server/memory.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function expectedHash(path: string): string {
  const key = process.platform === 'win32' ? path.toLowerCase() : path
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

describe('memory root', () => {
  it('keys one directory per canonical workspace path', () => {
    const workspace = '/tmp/My Project'
    const root = resolveMemoryRoot({ dataDir: '/data', workspacePath: workspace })

    expect(root).toBe(join('/data', 'memories', 'projects', `my-project-${expectedHash(resolve(workspace))}`, 'memory'))
  })

  it('falls back to project when the basename has no usable characters', () => {
    const root = resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/项目' })

    expect(root).toContain(`project-${expectedHash('/tmp/项目')}`)
  })

  it('is stable for the same workspace and distinct across workspaces', () => {
    const a = resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/a' })
    const b = resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/b' })

    expect(resolveMemoryRoot({ dataDir: '/data', workspacePath: '/tmp/a' })).toBe(a)
    expect(a).not.toBe(b)
    expect(a.split('/').at(-2)?.split('-').at(-1)).toHaveLength(16)
  })

  it('truncates the slug to 48 characters', () => {
    const name = 'a'.repeat(60)
    const root = resolveMemoryRoot({ dataDir: '/data', workspacePath: `/tmp/${name}` })

    expect(root).toContain(`${'a'.repeat(48)}-`)
  })

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

describe('memory path safety', () => {
  const root = '/data/memories/projects/demo-0123456789abcdef/memory'

  it('accepts contained Markdown paths and rejects everything else', () => {
    expect(resolveSafeMemoryPath(join(root, 'prefs.md'), root)).toBe(join(root, 'prefs.md'))
    expect(resolveSafeMemoryPath(join(root, 'nested', 'prefs.md'), root)).toBe(join(root, 'nested', 'prefs.md'))
    expect(resolveSafeMemoryPath(join(root, 'prefs.txt'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, '..', 'escape.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath('/etc/passwd.md', root)).toBeUndefined()
    expect(resolveSafeMemoryPath(root, root)).toBeUndefined()
  })

  it('containment alone does not require Markdown (direct-write detection)', () => {
    expect(isContainedMemoryPath(join(root, 'notes.txt'), root)).toBe(true)
    expect(isContainedMemoryPath(join(root, '..', 'x'), root)).toBe(false)
  })

  it('rejects every protected segment', () => {
    for (const segment of SENSITIVE_MEMORY_PATH_SEGMENTS) {
      expect(resolveSafeMemoryPath(join(root, segment, 'fact.md'), root), segment).toBeUndefined()
    }
  })

  it('rejects normalized lookalikes of protected segments', () => {
    expect(resolveSafeMemoryPath(join(root, 'HEAD.', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, 'config:ads', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, 'co\u200cnfig', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, '.git   ', 'fact.md'), root)).toBeUndefined()
    expect(resolveSafeMemoryPath(`${root}\\.git\\fact.md`, root)).toBeUndefined()
    expect(resolveSafeMemoryPath(join(root, 'skills', 'fact.md'), root)).toBeUndefined()
  })
})

describe('memory index formatting', () => {
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

  it('returns an empty string for empty or comment-only content', () => {
    expect(formatMemoryIndex('')).toBe('')
    expect(formatMemoryIndex('  \n\n')).toBe('')
    expect(formatMemoryIndex('<!-- only a comment -->\n')).toBe('')
  })

  it('truncates by lines and appends the warning', () => {
    const content = Array.from({ length: MEMORY_INDEX_LINE_LIMIT + 1 }, (_, index) => `- line ${index}`).join('\n')
    const formatted = formatMemoryIndex(content)

    expect(formatted.split('\n')[0]).toBe('- line 0')
    expect(formatted).toContain(`> 警告：MEMORY.md 超过 ${MEMORY_INDEX_LINE_LIMIT} 行，仅加载了部分内容。`)
    expect(formatted).not.toContain('- line 200')
  })

  it('truncates by characters at a newline boundary and appends the warning', () => {
    const line = `- ${'x'.repeat(130)}`
    const content = Array.from({ length: 200 }, () => line).join('\n')
    expect(content.length).toBeGreaterThan(MEMORY_INDEX_CHARACTER_LIMIT)
    const formatted = formatMemoryIndex(content)

    expect(formatted.length).toBeLessThan(MEMORY_INDEX_CHARACTER_LIMIT + 200)
    expect(formatted).toContain('——索引行过长')
    expect(formatted.endsWith(line)).toBe(false)
  })

  it('reports both limits when both are exceeded', () => {
    const content = Array.from({ length: MEMORY_INDEX_LINE_LIMIT + 5 }, () => `- ${'y'.repeat(200)}`).join('\n')
    const formatted = formatMemoryIndex(content)

    expect(formatted).toContain(`超过 ${MEMORY_INDEX_LINE_LIMIT} 行且超过 ${MEMORY_INDEX_CHARACTER_LIMIT} 字符`)
  })
})

describe('memory file reads', () => {
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

describe('originSessionId stamping', () => {
  const root = '/data/memories/projects/demo-0123456789abcdef/memory'
  const file = join(root, 'prefs.md')

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

  it('keeps existing metadata keys and places node_type first', () => {
    const content = '---\nname: prefs\nmetadata:\n  type: user\n---\nBody\n'
    const stamped = stampOriginSessionId(content, file, root, '42')

    expect(stamped).toContain('metadata:\n  node_type: memory\n  type: user\n  originSessionId: "42"')
  })

  it('is idempotent and never overwrites an existing origin', () => {
    const first = stampOriginSessionId('---\nname: prefs\n---\nBody\n', file, root, '7')
    const second = stampOriginSessionId(first, file, root, '99')

    expect(second).toBe(first)
    expect(second).toContain('originSessionId: "7"')
    expect(second).not.toContain('"99"')
  })

  it('preserves CRLF line endings and a BOM', () => {
    const content = '\uFEFF---\r\nname: prefs\r\n---\r\nBody\r\n'
    const stamped = stampOriginSessionId(content, file, root, '5')

    expect(stamped.startsWith('\uFEFF---\r\n')).toBe(true)
    expect(stamped).toContain('\r\n  node_type: memory\r\n')
    expect(stamped.endsWith('---\r\nBody\r\n')).toBe(true)
  })

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

  it('does not treat MEMORY.md as needing a stamp', async () => {
    const directory = await tempRoot()
    const source = join(directory, 'MEMORY.md')
    await writeFile(source, '- [One](one.md) — first\n')

    expect(await fileNeedsOriginStamp(source)).toBe(false)
  })
})
