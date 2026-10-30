import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { createMemoryExtension, memoryInstructions, MEMORY_EXTENSION_NAME } from '../src/server/memory/policy.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(options: { enabled?: boolean; planActive?: boolean; tools?: string[]; memory?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-policy-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const memoryRoot = resolveMemoryRoot({ dataDir, workspacePath: workspace })
  const extension = createMemoryExtension({ dataDir, memoryEnabled: () => options.enabled ?? true })
  const input = {
    conversationId: 1,
    env: { cwd: workspace },
    shown: {},
    agent: { tools: (options.tools ?? ['write', 'edit', 'read']).map(name => ({ name })), callable: [] },
    read: { snapshot: async () => ({ active: options.planActive ?? false, updatedAt: 1 }) },
  }
  const render = async (key: string): Promise<string | undefined> => {
    const item = extension.sections?.find(section => section.key === key)
    if (item === undefined) throw new Error(`missing section ${key}`)
    return await item.render(input as never, {} as never)
  }
  const wrap = (name: 'write' | 'edit') => {
    const entry = extension.wraps?.find(item => 'tool' in item && item.tool === name) as
      | { tool: string; wrap(tool: ToolRegistration): ToolRegistration }
      | undefined
    if (entry === undefined) throw new Error(`missing wrap ${name}`)
    return (tool: ToolRegistration) => entry.wrap(tool)
  }
  return { root, dataDir, workspace, memoryRoot, extension, render, wrap, input }
}

describe('memory extension identity', () => {
  it('contributes two tagged sections and the write/edit stamp wraps', async () => {
    const f = await fixture()
    const extension: Extension = f.extension

    expect(extension.name).toBe(MEMORY_EXTENSION_NAME)
    expect(extension.sections?.map(section => section.key)).toEqual(['memory', 'memory-index'])
    expect(extension.wraps?.map(item => ('tool' in item ? item.tool : item.section))).toEqual(['write', 'edit'])
    expect(extension.tools).toBeUndefined()
  })
})

describe('memory instructions section', () => {
  it('renders the save protocol with the absolute memory root', async () => {
    const f = await fixture()
    const rendered = await f.render('memory')

    expect(rendered).toBe(memoryInstructions(f.memoryRoot))
    expect(rendered).toContain(`\`${f.memoryRoot}/\``)
    expect(rendered).toContain('metadata:')
    expect(rendered).toContain('user | feedback | project | reference')
    expect(rendered).toContain('MEMORY.md')
    expect(rendered).toContain('修改 `MEMORY.md` 前先 read 它')
    expect(rendered).toContain('不要保存仓库本身已记录的内容')
  })

  it('omits the section when memory is disabled or no workspace is bound', async () => {
    const disabled = await fixture({ enabled: false })
    expect(await disabled.render('memory')).toBeUndefined()

    const f = await fixture()
    const item = f.extension.sections?.find(section => section.key === 'memory')
    const rendered = await item?.render({ ...f.input, env: undefined } as never, {} as never)
    expect(rendered).toBeUndefined()
  })

  it('omits the section for a read-only tool surface, including plan mode', async () => {
    const readOnly = await fixture({ tools: ['read', 'list_files', 'search_files', 'glob', 'grep'] })
    expect(await readOnly.render('memory')).toBeUndefined()

    // Plan mode filters write/edit out of the advertised tools, so the save protocol stays out;
    // "remember this" is still captured later by background extraction.
    const plan = await fixture({ tools: ['read'], planActive: true })
    expect(await plan.render('memory')).toBeUndefined()
  })
})

describe('memory index section', () => {
  it('renders a loaded index and omits missing or empty files', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '---\nname: index\n---\n- [One](one.md) — first\n', 'utf8')

    const rendered = await f.render('memory-index')
    expect(rendered).toContain(`\`${join(f.memoryRoot, 'MEMORY.md')}\` 的内容`)
    expect(rendered).toContain('- [One](one.md) — first')
    expect(rendered).not.toContain('name: index')

    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '', 'utf8')
    expect(await f.render('memory-index')).toBeUndefined()

    const missing = await fixture()
    expect(await missing.render('memory-index')).toBeUndefined()
  })

  it('omits the index when memory is disabled', async () => {
    const f = await fixture({ enabled: false })
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '- [One](one.md) — first\n', 'utf8')
    expect(await f.render('memory-index')).toBeUndefined()
  })
})

describe('memory stamp wraps', () => {
  function writeTool(execute: (args: { path: string; content: string }) => Promise<{ isError?: boolean }>): ToolRegistration {
    return {
      name: 'write',
      description: 'write',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (args: never) => execute(args as never),
    } as unknown as ToolRegistration
  }

  function editTool(execute: (args: { path: string; edits: Array<{ oldText: string; newText: string }> }) => Promise<{ isError?: boolean }>): ToolRegistration {
    return {
      name: 'edit',
      description: 'edit',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (args: never) => execute(args as never),
    } as unknown as ToolRegistration
  }

  function api(f: Awaited<ReturnType<typeof fixture>>) {
    return { env: { cwd: f.workspace }, conversationId: 7 } as never
  }

  it('stamps a write to a safe memory Markdown file before the tool runs', async () => {
    const f = await fixture()
    let received: { path: string; content: string } | undefined
    const wrapped = f.wrap('write')(writeTool(async args => {
      received = args
      return {}
    }))
    await wrapped.execute({
      path: join(f.memoryRoot, 'prefs.md'),
      content: '---\nname: prefs\n---\nBody\n',
    } as never, api(f), {} as never)

    expect(received?.content).toContain('node_type: memory')
    expect(received?.content).toContain('originSessionId: "7"')
  })

  it('passes through non-memory paths, protected segments, and disabled memory', async () => {
    const enabled = await fixture()
    const cases = [
      join('/tmp', 'outside.md'),
      join(enabled.memoryRoot, '.git', 'x.md'),
      join(enabled.memoryRoot, 'prefs.txt'),
    ]
    for (const path of cases) {
      let received: { content: string } | undefined
      const wrapped = enabled.wrap('write')(writeTool(async args => {
        received = args
        return {}
      }))
      await wrapped.execute({ path, content: '---\nname: x\n---\nBody\n' } as never, api(enabled), {} as never)
      expect(received?.content, path).toBe('---\nname: x\n---\nBody\n')
    }

    const disabled = await fixture({ enabled: false })
    let received: { content: string } | undefined
    const wrapped = disabled.wrap('write')(writeTool(async args => {
      received = args
      return {}
    }))
    await wrapped.execute({ path: join(disabled.memoryRoot, 'prefs.md'), content: '---\nname: x\n---\nBody\n' } as never, api(disabled), {} as never)
    expect(received?.content).toBe('---\nname: x\n---\nBody\n')
  })

  it('stamps an edited fact file after a successful call and skips failed calls', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    const source = join(f.memoryRoot, 'prefs.md')
    await writeFile(source, '---\nname: prefs\ndescription: a fact\n---\nBody\n', 'utf8')

    const wrapped = f.wrap('edit')(editTool(async args => {
      await writeFile(args.path, '---\nname: prefs\ndescription: a fact\n---\nBody updated\n', 'utf8')
      return {}
    }))
    await wrapped.execute({ path: source, edits: [{ oldText: 'Body', newText: 'Body updated' }] } as never, api(f), {} as never)
    const stamped = await readFile(source, 'utf8')
    expect(stamped).toContain('originSessionId: "7"')

    const failing = join(f.memoryRoot, 'failed.md')
    await writeFile(failing, '---\nname: failed\n---\nBody\n', 'utf8')
    const failedWrap = f.wrap('edit')(editTool(async () => ({ isError: true })))
    await failedWrap.execute({ path: failing, edits: [] } as never, api(f), {} as never)
    expect(await readFile(failing, 'utf8')).not.toContain('originSessionId')
  })
})
