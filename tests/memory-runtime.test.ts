import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime/index.ts'
import { observeDemoRequests } from '../src/server/model/demo.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { Message } from '@earendil-works/pi-ai'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-runtime-'))
  const options = { dataDir: join(root, 'data'), workspace: join(root, 'workspace'), piDir: join(root, 'pi'), demo: true }
  await mkdir(options.workspace, { recursive: true })
  await mkdir(options.piDir, { recursive: true })
  await writeFile(join(options.piDir, 'settings.json'), '{}')
  const runtime = await createRuntime(options)
  const requests: Array<{ system: string; tools: string[]; messages: readonly Message[] }> = []
  const unobserve = observeDemoRequests((request) => {
    const messages = normalizeContext(request).messages
    requests.push({
      system: messages
        .filter(message => message.role === 'system')
        .flatMap((message) => {
          const sections = (message as { sections?: Record<string, string> }).sections
          return [
            typeof message.content === 'string' ? message.content : '',
            ...Object.values(sections ?? {}),
          ]
        })
        .join('\n'),
      tools: getCurrentTools(messages).map(tool => tool.name),
      messages: structuredClone(messages),
    })
  })
  cleanups.push(async () => { unobserve(); await runtime.close(); await rm(root, { recursive: true, force: true }) })
  return {
    root,
    options,
    runtime,
    requests,
    async memoryRoot(): Promise<string> {
      return resolveMemoryRoot({ dataDir: options.dataDir, workspacePath: await realpath(options.workspace) })
    },
    extractionRequests: () => requests.filter(request =>
      request.system.includes('记忆提取子代理')
      || request.messages.some(message => message.role === 'user'
        && (typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')).includes('记忆提取子代理'))),
  }
}

async function sendAndWait(runtime: Runtime, id: string, text: string): Promise<void> {
  const count = (await runtime.detail(id)).messages.length
  await runtime.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return
    await delay(20)
  }
  throw new Error('run did not settle')
}

async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

describe('workspace memory at runtime', () => {
  it('extracts a fact after a successful run and writes stamped files plus the index', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Memory extraction' })
    const root = await f.memoryRoot()

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-demo] I prefer Chinese replies for every answer.')
    await waitFor(async () => (await readIfPresent(join(root, 'MEMORY.md'))) !== undefined, 'MEMORY.md')
    await waitFor(() => Promise.resolve(f.extractionRequests().length >= 3), 'three extraction requests')

    const fact = await readIfPresent(join(root, 'user-prefers-zh.md'))
    expect(fact).toBeDefined()
    expect(fact).toContain('node_type: memory')
    expect(fact).toContain(`originSessionId: "${conversation.conversation.id}"`)
    expect(await readIfPresent(join(root, 'MEMORY.md'))).toContain('user-prefers-zh.md')

    const extraction = f.extractionRequests()[0]
    expect(extraction?.tools).toEqual(['read', 'list_files', 'search_files', 'write', 'edit', 'delete'])
    expect(extraction?.system).toContain(root)
    const lastUser = [...(extraction?.messages ?? [])].reverse().find(message => message.role === 'user')
    const lastUserText = lastUser?.role === 'user'
      ? typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      : ''
    expect(lastUserText).toContain('记忆提取子代理')

    // The injected index is visible to the next request in the same conversation.
    await sendAndWait(f.runtime, conversation.conversation.id, '[prompt-probe] index-after-extraction')
    const injection = f.requests.findLast(request => !request.system.includes('记忆提取子代理') && request.messages.some(message => message.role === 'user'
      && (typeof message.content === 'string' ? message.content : '').includes('[prompt-probe] index-after-extraction')))
    expect(injection?.system).toContain('user-prefers-zh.md')
  }, 30_000)

  it('does not extract when memory is disabled', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Memory off' })

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-demo] I prefer Chinese replies for every answer.')
    await delay(100)
    await f.runtime.close()

    expect(f.extractionRequests()).toHaveLength(0)
  }, 20_000)

  it('skips extraction when the main run already wrote memory', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Direct memory write' })
    const root = await f.memoryRoot()

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-write] remember this preference for later.')
    const direct = join(root, 'nested', 'direct-write.md')
    await waitFor(async () => (await readIfPresent(direct)) !== undefined, 'direct memory write')
    expect(await readIfPresent(direct)).toContain('originSessionId:')
    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-write] remember this preference again.')
    await delay(100)
    await f.runtime.close()

    expect(f.extractionRequests()).toHaveLength(0)
  }, 30_000)

  it('skips extraction for a read-only conversation', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Read only', accessMode: 'readOnly' })

    await sendAndWait(f.runtime, conversation.conversation.id, 'I prefer Chinese replies for every answer.')
    await delay(100)
    await f.runtime.close()

    expect(f.extractionRequests()).toHaveLength(0)
  }, 20_000)

  it('allows the session to write memory under workspaceWrite', async () => {
    const f = await fixture()
    if (!f.runtime.capabilities().accessModes.includes('workspaceWrite')) return
    await f.runtime.updateSettings({ memoryEnabled: true })
    const conversation = await f.runtime.create({ title: 'Workspace write', accessMode: 'workspaceWrite' })
    const root = await f.memoryRoot()
    // The nested directory exists before the write, so the canonical root check is exercised.
    await mkdir(join(root, 'nested'), { recursive: true })

    await sendAndWait(f.runtime, conversation.conversation.id, '[memory-write] remember this preference for later.')
    await waitFor(async () => (await readIfPresent(join(root, 'nested', 'direct-write.md'))) !== undefined, 'memory write under workspaceWrite')
  }, 30_000)
})
