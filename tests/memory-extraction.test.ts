import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssistantMessage, Message, ToolCall, Usage } from '@earendil-works/pi-ai'
import {
  MEMORY_EXTRACTION_MAX_TURNS,
  MEMORY_EXTRACTION_POLICY_MESSAGE,
  createExtractionScheduler,
  executeExtractionTool,
  extractionPrompt,
  memoryExtractionTools,
  memorySkipReason,
  runExtractionLoop,
  scanMemoryManifest,
} from '../src/server/memory/extraction.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-extraction-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const memoryRoot = resolveMemoryRoot({ dataDir, workspacePath: workspace })
  return { root, dataDir, workspace, memoryRoot }
}

function usage(): Usage {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, api: 'faux', provider: 'test', model: 'demo', usage: usage(), stopReason, timestamp: Date.now() }
}

function toolCall(name: string, args: Record<string, unknown>, id = 'call-1'): ToolCall {
  return { type: 'toolCall', id, name, arguments: args as never }
}

describe('extraction run decision', () => {
  const cwd = '/workspace/demo'
  const root = '/data/memories/projects/demo-0123456789abcdef/memory'
  const prose: Message = { role: 'user', content: 'please remember this preference for later', timestamp: 1 }

  it('skips a run whose assistant already wrote or edited inside the memory root', () => {
    const messages: Message[] = [
      prose,
      assistant([toolCall('write', { path: join(root, 'fact.md') })], 'toolUse'),
    ]
    expect(memorySkipReason(messages, root, cwd)).toBe('direct-memory-write')

    const relative: Message[] = [
      prose,
      assistant([toolCall('edit', { path: '../../data/memories/projects/demo-0123456789abcdef/memory/fact.md' })], 'toolUse'),
    ]
    expect(memorySkipReason(relative, root, cwd)).toBe('direct-memory-write')

    const nonMarkdown: Message[] = [
      prose,
      assistant([toolCall('write', { path: join(root, 'notes.txt') })], 'toolUse'),
    ]
    expect(memorySkipReason(nonMarkdown, root, cwd)).toBe('direct-memory-write')
  })

  it('does not treat a write outside the root, or a read, as a direct memory write', () => {
    const messages: Message[] = [
      prose,
      assistant([
        toolCall('write', { path: join(cwd, 'notes.txt') }),
        toolCall('read', { path: join(root, 'fact.md') }, 'call-2'),
      ], 'toolUse'),
    ]
    expect(memorySkipReason(messages, root, cwd)).toBeUndefined()
  })

  it('skips a run without at least three words of user prose', () => {
    expect(memorySkipReason([{ role: 'user', content: '说中文', timestamp: 1 }], root, cwd)).toBe('no-user-prose')
    expect(memorySkipReason([{
      role: 'user',
      content: [{ type: 'text', text: 'short' }, { type: 'image', data: 'x', mimeType: 'image/png' }],
      timestamp: 1,
    }], root, cwd)).toBe('no-user-prose')
    expect(memorySkipReason([{
      role: 'toolResult',
      toolCallId: '1',
      toolName: 'read',
      content: [{ type: 'text', text: 'one two three four' }],
      isError: false,
      timestamp: 1,
    }], root, cwd)).toBe('no-user-prose')
  })
})

describe('extraction scheduler', () => {
  it('coalesces a burst into one running slot plus one latest-pending slot', async () => {
    let runs = 0
    let active = 0
    let maxActive = 0
    const gates: Array<() => void> = []
    const scheduler = createExtractionScheduler(async () => {
      runs += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolveGate => gates.push(resolveGate))
      active -= 1
      return { outcome: 'success', cursor: runs as never }
    })

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()
    expect(runs).toBe(1)
    gates.shift()?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    gates.shift()?.()
    await scheduler.drain()

    expect(runs).toBe(2)
    expect(maxActive).toBe(1)
    expect(scheduler.cursor()).toBe(2)
  })

  it('advances the cursor on success and skip but not on error or abort', async () => {
    const seen: Array<unknown> = []
    let step = 0
    const scheduler = createExtractionScheduler(async (cursor) => {
      seen.push(cursor)
      step += 1
      if (step === 1) return { outcome: 'success', cursor: 'a' as never }
      if (step === 2) return { outcome: 'error' }
      if (step === 3) return { outcome: 'aborted' }
      return { outcome: 'skip', cursor: 'b' as never }
    })

    scheduler.schedule()
    await scheduler.drain()
    scheduler.schedule()
    await scheduler.drain()
    scheduler.schedule()
    await scheduler.drain()
    scheduler.schedule()
    await scheduler.drain()

    expect(seen).toEqual([undefined, 'a', 'a', 'a'])
    expect(scheduler.cursor()).toBe('b')
  })

  it('aborts the running task and refuses new schedules after shutdown', async () => {
    let runs = 0
    let aborted = false
    const scheduler = createExtractionScheduler(async (_cursor, signal) => {
      runs += 1
      await new Promise<void>(resolveAbort => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolveAbort()
        }, { once: true })
      })
      return { outcome: 'aborted' }
    })

    scheduler.schedule()
    await Promise.resolve()
    scheduler.shutdown()
    scheduler.schedule()
    await scheduler.drain()

    expect(runs).toBe(1)
    expect(aborted).toBe(true)
  })
})

describe('restricted extraction loop', () => {
  const baseOptions = {
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'remember this preference', timestamp: 1 }] as Message[],
    tools: memoryExtractionTools(),
    signal: new AbortController().signal,
    maxTokens: 100,
    sessionId: 'memory-1',
    timeoutMs: 1_000,
  }

  it('rejects an unknown tool and a memory write outside the root without calling the executor', async () => {
    const root = '/data/memories/projects/demo/memory'
    const calls: ToolCall[] = []
    const executed: string[] = []
    const answers = [
      assistant([toolCall('bash', { command: 'ls' }, 'c1'), toolCall('write', { path: '/etc/x.md', content: 'x' }, 'c2')], 'toolUse'),
      assistant([{ type: 'text', text: 'done' }]),
    ]
    let index = 0
    const result = await runExtractionLoop(baseOptions, {
      complete: async () => answers[index++]!,
      execute: async (call) => {
        executed.push(call.name)
        calls.push(call)
        return { content: 'ok', isError: false }
      },
      root,
      cwd: '/workspace/demo',
    })

    expect(executed).toEqual([])
    const toolResults = result.messages.filter((message): message is Extract<Message, { role: 'toolResult' }> => message.role === 'toolResult')
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]?.content[0]).toEqual({ type: 'text', text: 'Error: No such tool available: bash' })
    expect(toolResults[1]?.content[0]).toEqual({ type: 'text', text: MEMORY_EXTRACTION_POLICY_MESSAGE(root) })
    expect(toolResults.every(message => message.isError)).toBe(true)
  })

  it('executes allowed calls and stops at the turn cap after executing the fifth round', async () => {
    const root = '/data/memories/projects/demo/memory'
    let completions = 0
    let executions = 0
    const result = await runExtractionLoop(baseOptions, {
      complete: async () => {
        completions += 1
        return assistant([toolCall('read', { path: join(root, 'fact.md') }, `call-${completions}`)], 'toolUse')
      },
      execute: async () => {
        executions += 1
        return { content: 'file body', isError: false }
      },
      root,
      cwd: '/workspace/demo',
    })

    expect(completions).toBe(MEMORY_EXTRACTION_MAX_TURNS)
    expect(executions).toBe(MEMORY_EXTRACTION_MAX_TURNS)
    expect(result.turns).toBe(MEMORY_EXTRACTION_MAX_TURNS)
    expect(result.usage.totalTokens).toBeGreaterThan(0)
  })

  it('throws before the first request when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let completions = 0
    await expect(runExtractionLoop({ ...baseOptions, signal: controller.signal }, {
      complete: async () => {
        completions += 1
        return assistant([])
      },
      execute: async () => ({ content: '', isError: false }),
      root: '/data/memories/projects/demo/memory',
      cwd: '/workspace/demo',
    })).rejects.toThrow()
    expect(completions).toBe(0)
  })

  it('treats an error stop reason as a failed run instead of completing', async () => {
    await expect(runExtractionLoop(baseOptions, {
      complete: async () => assistant([], 'error'),
      execute: async () => ({ content: '', isError: false }),
      root: '/data/memories/projects/demo/memory',
      cwd: '/workspace/demo',
    })).rejects.toThrow('extraction request stopped with error')
  })
})

describe('extraction tool executor', () => {
  it('writes a stamped fact file inside the memory root only', async () => {
    const f = await fixture()
    const result = await executeExtractionTool(toolCall('write', {
      path: join(f.memoryRoot, 'prefs.md'),
      content: '---\nname: prefs\ndescription: Chinese replies\n---\nBody\n',
    }), { root: f.memoryRoot, cwd: f.workspace, conversationId: 9 as never, signal: new AbortController().signal })

    expect(result.isError).toBe(false)
    const written = await readFile(join(f.memoryRoot, 'prefs.md'), 'utf8')
    expect(written).toContain('node_type: memory')
    expect(written).toContain('originSessionId: "9"')

    const rejected = await executeExtractionTool(toolCall('write', {
      path: join(f.workspace, 'outside.md'),
      content: 'x',
    }, 'call-2'), { root: f.memoryRoot, cwd: f.workspace, conversationId: 9 as never, signal: new AbortController().signal })
    expect(rejected.isError).toBe(true)
    expect(rejected.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))
  })

  it('applies a unique edit and rejects a non-unique one without writing', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    const source = join(f.memoryRoot, 'fact.md')
    await writeFile(source, '---\nname: fact\n---\nrepeat repeat\n', 'utf8')

    const rejected = await executeExtractionTool(toolCall('edit', {
      path: source,
      edits: [{ oldText: 'repeat', newText: 'once' }],
    }), { root: f.memoryRoot, cwd: f.workspace, conversationId: 3 as never, signal: new AbortController().signal })
    expect(rejected.isError).toBe(true)
    expect(await readFile(source, 'utf8')).toContain('repeat repeat')

    const applied = await executeExtractionTool(toolCall('edit', {
      path: source,
      edits: [{ oldText: 'repeat repeat', newText: 'single value' }],
    }, 'call-2'), { root: f.memoryRoot, cwd: f.workspace, conversationId: 3 as never, signal: new AbortController().signal })
    expect(applied.isError).toBe(false)
    const edited = await readFile(source, 'utf8')
    expect(edited).toContain('single value')
    expect(edited).toContain('originSessionId: "3"')
  })

  it('deletes a fact file inside the memory root but never MEMORY.md or outside paths', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    const source = join(f.memoryRoot, 'stale.md')
    const index = join(f.memoryRoot, 'MEMORY.md')
    await writeFile(source, '---\nname: stale\n---\noutdated\n', 'utf8')
    await writeFile(index, '- [Stale](stale.md) — index\n', 'utf8')
    const options = { root: f.memoryRoot, cwd: f.workspace, conversationId: 4 as never, signal: new AbortController().signal }

    const protectIndex = await executeExtractionTool(toolCall('delete', { path: index }), options)
    expect(protectIndex.isError).toBe(true)
    expect(protectIndex.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))

    const outside = await executeExtractionTool(toolCall('delete', { path: join(f.workspace, 'notes.md') }, 'call-2'), options)
    expect(outside.isError).toBe(true)
    expect(outside.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))

    const removed = await executeExtractionTool(toolCall('delete', { path: source }, 'call-3'), options)
    expect(removed.isError).toBe(false)
    await expect(readFile(source, 'utf8')).rejects.toThrow()

    const again = await executeExtractionTool(toolCall('delete', { path: source }, 'call-4'), options)
    expect(again.isError).toBe(true)
    expect(again.content).toContain('File not found')
  })

  it('reads, lists and searches the workspace and the memory root', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.workspace, 'notes.txt'), 'Workspace Note One\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'fact.md'), '- [Pref](prefs.md) — prefers Chinese\n', 'utf8')
    const options = { root: f.memoryRoot, cwd: f.workspace, conversationId: 1 as never, signal: new AbortController().signal }

    const read = await executeExtractionTool(toolCall('read', { path: join(f.memoryRoot, 'fact.md') }), options)
    expect(read.isError).toBe(false)
    expect(read.content).toContain('prefers Chinese')

    const listed = await executeExtractionTool(toolCall('list_files', {}), options)
    expect(listed.isError).toBe(false)
    expect(listed.content).toContain('notes.txt')

    const searched = await executeExtractionTool(toolCall('search_files', { pattern: 'note one' }), options)
    expect(searched.isError).toBe(false)
    expect(searched.content).toContain('notes.txt:1')

    const outside = await executeExtractionTool(toolCall('read', { path: '/etc/hosts' }), options)
    expect(outside.isError).toBe(true)
    expect(outside.content).toBe(MEMORY_EXTRACTION_POLICY_MESSAGE(f.memoryRoot))
  })
})

describe('memory manifest', () => {
  it('lists frontmatter facts newest first and excludes MEMORY.md', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '- [Old](old.md) — index\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'old.md'), '---\nname: old\ndescription: older fact\nmetadata:\n  type: project\n---\nBody\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'new.md'), '---\nname: new\ndescription: newer fact\nmetadata:\n  type: user\n---\nBody\n', 'utf8')
    await writeFile(join(f.memoryRoot, 'notes.txt'), '---\nname: notes\n---\n', 'utf8')
    await utimes(join(f.memoryRoot, 'old.md'), new Date(1_000), new Date(1_000))
    await utimes(join(f.memoryRoot, 'new.md'), new Date(2_000), new Date(2_000))

    const manifest = await scanMemoryManifest(f.memoryRoot)

    expect(manifest.map(entry => entry.file)).toEqual(['new.md', 'old.md'])
    expect(manifest[0]).toMatchObject({ type: 'user', description: 'newer fact' })
    expect(manifest[1]).toMatchObject({ type: 'project', description: 'older fact' })
  })

  it('writes the manifest and the Nothing-to-save contract into the prompt', async () => {
    const withManifest = extractionPrompt('/data/root', 12, [{ file: 'a.md', type: 'user', description: 'prefers Chinese', modifiedAt: 0 }])
    expect(withManifest).toContain('最近约 12 条消息')
    expect(withManifest).toContain('## 已有记忆文件')
    expect(withManifest).toContain('- [user] a.md (1970-01-01T00:00:00.000Z): prefers Chinese')
    expect(withManifest).toContain('「Nothing to save.」')
    expect(withManifest).toContain('/data/root')

    const withoutManifest = extractionPrompt('/data/root', 3, [])
    expect(withoutManifest).not.toContain('## 已有记忆文件')
  })
})
