import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resetRipgrepResolverForTests,
  resolveRipgrep,
  searchWithRipgrep,
  setRipgrepForTests,
} from '../src/server/tools/search/native.ts'
import { ResearchTools, RESEARCH_TOOL_NAMES } from '../src/server/tools/research.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const TEST_CONTEXT: Context = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => 'pi-web-research-tools-test',
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-research-tools-'))
  directories.push(directory)
  return directory
}

async function outsideWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-research-outside-'))
  directories.push(directory)
  return directory
}

function apiFor(path: string): ToolExecutionApi {
  return { env: { cwd: path }, diagnostic: () => undefined } as unknown as ToolExecutionApi
}

function registered(name: string) {
  const tool = ResearchTools.tools?.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

async function callTool(name: string, args: Record<string, unknown>, api: ToolExecutionApi, context = TEST_CONTEXT) {
  return registered(name).execute(args as never, api, context)
}

function toolText(result: { output?: readonly { type: string; text?: string }[] }): string {
  return (result.output ?? []).flatMap(item => item.type === 'text' ? [item.text ?? ''] : []).join('\n')
}

describe('ResearchTools', () => {
  it('exports the intended read-only tools', () => {
    expect(RESEARCH_TOOL_NAMES).toEqual(['list_files', 'search_files', 'glob', 'grep'])
    expect(ResearchTools.tools?.map(tool => tool.name)).toEqual(['list_files', 'search_files', 'glob', 'grep'])
  })

  it('lists relative paths and omits hidden, generated, and credential-related entries', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await mkdir(join(root, 'src', 'tokens'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.git', 'objects'), { recursive: true })
    await mkdir(join(root, '.data'), { recursive: true })
    await mkdir(join(root, '.private'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# Project')
    await writeFile(join(root, 'credentials.json'), '{"token":"hidden"}')
    await writeFile(join(root, '.env'), 'SECRET=value')
    await writeFile(join(root, '.private', 'notes.md'), 'hidden')
    await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1')
    await writeFile(join(root, 'src', 'nested', 'helper.ts'), 'export const helper = 1')
    await writeFile(join(root, 'src', 'tokens', 'secrets.ts'), 'export const secretType = "source code"')

    const direct = toolText(await callTool('list_files', {}, apiFor(root)))
    const recursive = toolText(await callTool('list_files', { recursive: true }, apiFor(root)))

    expect(direct).toContain('- file "README.md"')
    expect(direct).toContain('- directory "src"')
    expect(direct).not.toContain('TRUNCATED')
    for (const path of ['README.md', 'src', 'src/main.ts', 'src/nested', 'src/nested/helper.ts', 'src/tokens/secrets.ts']) {
      expect(recursive).toContain(JSON.stringify(path))
    }
    expect(recursive).not.toMatch(/node_modules|\.git|\.data|\.private|credentials|\.env/)
    expect(recursive).not.toContain('TRUNCATED')
  })

  it('marks directory and result limits as truncated', async () => {
    const root = await workspace()
    await writeFile(join(root, 'one.txt'), 'match')
    await writeFile(join(root, 'two.txt'), 'match')

    const listed = toolText(await callTool('list_files', { maxEntries: 1 }, apiFor(root)))
    const searched = toolText(await callTool('search_files', { query: 'match', maxResults: 1 }, apiFor(root)))

    expect(listed.match(/- file /g)).toHaveLength(1)
    expect(listed).toContain('TRUNCATED')
    expect(searched.match(/:1: match/g)).toHaveLength(1)
    expect(searched).toContain('TRUNCATED')
  })

  it('preserves an earlier skipped-file truncation when the result limit is later reached', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'large.txt'), 'needle'.repeat(100_000))
    await writeFile(join(root, 'src', 'match.txt'), 'needle')

    const result = toolText(await callTool('search_files', { query: 'needle', maxResults: 1 }, apiFor(root)))

    expect(result).toContain('skipped 0 unreadable, 0 binary, and 1 oversized files')
    expect(result).toContain('- "src/match.txt":1: needle')
    expect(result).toContain('TRUNCATED')
  })

  it('searches literal text and returns one-based line numbers with excerpts', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'const a = 1\nconst value = "Needle here"\nneedle again\n')
    await writeFile(join(root, 'src', 'credentials.json'), '{"value":"Needle"}')
    await writeFile(join(root, '.env'), 'Needle')

    const result = toolText(await callTool('search_files', { query: 'needle' }, apiFor(root)))

    expect(result).toContain('- "src/app.ts":2: const value = "Needle here"')
    expect(result).toContain('- "src/app.ts":3: needle again')
    expect(result).toContain('searched 1 files')
    expect(result).not.toContain('TRUNCATED')
  })

  it('globs files across depths, includes hidden paths, and sorts newest first', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await mkdir(join(root, '.cursor'), { recursive: true })
    await mkdir(join(root, '.private'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.git', 'objects'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# Project')
    await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1')
    await writeFile(join(root, 'src', 'app.test.ts'), 'export const test = 1')
    await writeFile(join(root, 'src', 'nested', 'helper.ts'), 'export const helper = 1')
    await writeFile(join(root, '.cursor', 'pending.json'), '{}')
    await writeFile(join(root, '.private', 'notes.md'), 'hidden')
    await writeFile(join(root, 'node_modules', 'pkg', 'index.ts'), 'ignored')
    await writeFile(join(root, '.git', 'objects', 'blob.ts'), 'ignored')
    await writeFile(join(root, 'credentials.json'), '{"token":"hidden"}')
    await utimes(join(root, 'src', 'app.ts'), new Date('2026-01-01'), new Date('2026-01-01'))
    await utimes(join(root, 'src', 'app.test.ts'), new Date('2026-02-01'), new Date('2026-02-01'))
    await utimes(join(root, 'src', 'nested', 'helper.ts'), new Date('2026-03-01'), new Date('2026-03-01'))

    const code = toolText(await callTool('glob', { pattern: '**/*.ts' }, apiFor(root)))
    expect(code).toContain('"src/nested/helper.ts"')
    expect(code).toContain('"src/app.test.ts"')
    expect(code).toContain('"src/app.ts"')
    expect(code).not.toMatch(/node_modules|\.git|credentials/)
    expect(code.indexOf('"src/nested/helper.ts"')).toBeLessThan(code.indexOf('"src/app.test.ts"'))
    expect(code.indexOf('"src/app.test.ts"')).toBeLessThan(code.indexOf('"src/app.ts"'))

    const hidden = toolText(await callTool('glob', { pattern: '**/*.json' }, apiFor(root)))
    expect(hidden).toContain('".cursor/pending.json"')
    expect(hidden).not.toContain('credentials.json')

    const basename = toolText(await callTool('glob', { pattern: '*.md' }, apiFor(root)))
    expect(basename).toContain('"README.md"')
    expect(basename).toContain('".private/notes.md"')
  })

  it('greps regex matches, filters by include glob, and respects case sensitivity', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'const value = 1\nconst label = "Needle here"\n')
    await writeFile(join(root, 'src', 'app.test.ts'), 'needle again\n')
    await writeFile(join(root, 'src', 'data.json'), '{"value":"Needle"}')
    await writeFile(join(root, 'credentials.json'), '{"value":"Needle"}')
    await writeFile(join(root, '.env'), 'Needle')

    const filtered = toolText(await callTool('grep', { pattern: 'needle|value', include: '*.ts' }, apiFor(root)))
    expect(filtered).toContain('- "src/app.ts":1: const value = 1')
    expect(filtered).toContain('- "src/app.ts":2: const label = "Needle here"')
    expect(filtered).toContain('- "src/app.test.ts":1: needle again')
    expect(filtered).not.toContain('data.json')
    expect(filtered).not.toContain('credentials')
    expect(filtered).not.toContain('.env')

    const exactCase = toolText(await callTool('grep', { pattern: 'NEEDLE', caseSensitive: true }, apiFor(root)))
    expect(exactCase).toContain('Found 0 regex matches')

    const json = toolText(await callTool('grep', { pattern: 'Needle', include: '*.json' }, apiFor(root)))
    expect(json).toContain('- "src/data.json":1: {"value":"Needle"}')
    expect(json).not.toContain('credentials')

    await expect(callTool('grep', { pattern: '(' }, apiFor(root)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('marks glob and grep result limits as truncated', async () => {
    const root = await workspace()
    await writeFile(join(root, 'one.txt'), 'match')
    await writeFile(join(root, 'two.txt'), 'match')

    const globbed = toolText(await callTool('glob', { pattern: '*.txt', maxResults: 1 }, apiFor(root)))
    const grepped = toolText(await callTool('grep', { pattern: 'match', maxResults: 1 }, apiFor(root)))

    expect(globbed.match(/^- "/gm)).toHaveLength(1)
    expect(globbed).toContain('TRUNCATED')
    expect(grepped.match(/:1: match/g)).toHaveLength(1)
    expect(grepped).toContain('TRUNCATED')
  })

  it('rejects absolute and parent paths and does not follow symlinks', async () => {
    const root = await workspace()
    const outside = await outsideWorkspace()
    await writeFile(join(outside, 'outside.txt'), 'secret-value')
    await symlink(outside, join(root, 'external'))

    await expect(callTool('list_files', { path: '../outside' }, apiFor(root)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(callTool('search_files', { query: 'secret', path: join(outside, 'outside.txt') }, apiFor(root)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(callTool('search_files', { query: 'secret', path: 'external/outside.txt' }, apiFor(root)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    const result = toolText(await callTool('search_files', { query: 'secret' }, apiFor(root)))
    expect(result).not.toContain('outside.txt')
    expect(result).not.toContain('secret-value')
    expect(result).not.toContain('TRUNCATED')
  })

  it('skips oversized and binary files and reports the incomplete search', async () => {
    const root = await workspace()
    await writeFile(join(root, 'large.txt'), 'needle'.repeat(100_000))
    await writeFile(join(root, 'image.dat'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(root, 'small.txt'), 'needle')

    const result = toolText(await callTool('search_files', { query: 'needle' }, apiFor(root)))

    expect(result).toContain('- "small.txt":1: needle')
    expect(result).toContain('skipped 0 unreadable, 1 binary, and 1 oversized files')
    expect(result).toContain('TRUNCATED')
  })

  it('counts binary bytes against the total read budget and marks later files incomplete', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    const binary = Buffer.alloc(512 * 1_024)
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(join(root, `binary-${index}.dat`), binary)))
    await writeFile(join(root, 'src', 'match.txt'), 'needle')

    const result = toolText(await callTool('search_files', { query: 'needle' }, apiFor(root)))

    expect(result).not.toContain('- "src/match.txt":1: needle')
    expect(result).toContain('skipped 0 unreadable, 8 binary, and 1 oversized files')
    expect(result).toContain('TRUNCATED')
  })

  it('honors an aborted context before reading workspace files', async () => {
    const root = await workspace()
    const controller = new AbortController()
    controller.abort()
    const context = { ...TEST_CONTEXT, abortSignal: controller.signal } as Context

    await expect(callTool('list_files', {}, apiFor(root), context)).rejects.toThrow()
  })
})

describe('native ripgrep search', () => {
  it('finds matches with relative paths and one-based lines', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'const a = 1\nconst needle = 2\n')

    const outcome = await searchWithRipgrep({
      root,
      searchPath: root,
      pattern: 'needle',
      caseSensitive: false,
      maxResults: 10,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.matches).toHaveLength(1)
    expect(outcome.matches[0]).toMatchObject({ path: 'src/app.ts', line: 2 })
    expect(outcome.scannedFiles).toBeGreaterThan(0)
  })

  it('reports no matches without failing', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'hello\n')

    const outcome = await searchWithRipgrep({
      root,
      searchPath: root,
      pattern: 'zzzz',
      caseSensitive: false,
      maxResults: 10,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.matches).toHaveLength(0)
  })

  it('skips generated trees and credential files', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'a.ts'), 'needle\n')
    await writeFile(join(root, '.env'), 'needle\n')
    await writeFile(join(root, 'credentials.json'), '{"needle":1}\n')
    await writeFile(join(root, 'src.ts'), 'needle\n')

    const outcome = await searchWithRipgrep({
      root,
      searchPath: root,
      pattern: 'needle',
      caseSensitive: false,
      maxResults: 10,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.matches.map(match => match.path)).toEqual(['src.ts'])
  })

  it('lets the native engine handle ripgrep-only syntax', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'needle\n')

    const result = toolText(await callTool('grep', { pattern: '(?P<word>needle)' }, apiFor(root)))

    expect(result).toContain('a.txt')
    expect(result).not.toContain('not a valid regular expression')
  })

  it('falls back for a JavaScript-only lookahead', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'needle\n')

    const result = toolText(await callTool('grep', { pattern: 'need(?=le)' }, apiFor(root)))

    expect(result).toContain('a.txt')
  })

  it('falls back to the JavaScript walker when ripgrep is unavailable', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'needle\n')
    setRipgrepForTests(undefined)
    try {
      const result = toolText(await callTool('grep', { pattern: 'needle' }, apiFor(root)))
      expect(result).toContain('a.txt')
    } finally {
      resetRipgrepResolverForTests()
    }
  })
})
