import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchTools, RESEARCH_TOOL_NAMES } from '../src/server/research-tools.ts'

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
  return { env: { cwd: path } } as unknown as ToolExecutionApi
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
  it('exports the two intended read-only tools', () => {
    expect(RESEARCH_TOOL_NAMES).toEqual(['list_files', 'search_files'])
    expect(ResearchTools.tools?.map(tool => tool.name)).toEqual(['list_files', 'search_files'])
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
