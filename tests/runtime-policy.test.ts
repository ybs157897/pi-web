import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { AgentDoc, Harness, createRegistry, type ConversationId } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { getCurrentSystemMessage, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { SystemMessage } from '@earendil-works/pi-ai'
import { createRuntime } from '../src/server/runtime.ts'
import { createDemoModelRuntime, observeDemoRequests } from '../src/server/demo-model.ts'
import { RUNTIME_CORE_PROMPT } from '../src/server/work-policy.ts'
import type { Runtime } from '../src/server/contracts.ts'

type RequestEvidence = { user: string; system: SystemMessage | undefined; tools: string[] }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-policy-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { dataDir: join(root, 'data'), workspace: join(root, 'workspace'), piDir: join(root, 'pi'), demo: true }
  await mkdir(options.piDir)
  await writeFile(join(options.piDir, 'settings.json'), '{}')
  let runtime = await createRuntime(options)
  cleanup.push(() => runtime.close())
  const requests: RequestEvidence[] = []
  const unobserve = observeDemoRequests(request => {
    const messages = normalizeContext(request).messages
    const user = [...messages].reverse().find(message => message.role === 'user')
    requests.push({
      user: user?.role === 'user' ? typeof user.content === 'string' ? user.content : user.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : '',
      system: structuredClone(getCurrentSystemMessage(messages)),
      tools: getCurrentTools(messages).map(tool => tool.name),
    })
  })
  cleanup.push(async () => unobserve())
  return {
    root, options, requests,
    get runtime() { return runtime },
    async restart() { await runtime.close(); runtime = await createRuntime(options) },
  }
}

async function send(runtime: Runtime, id: string, text: string) {
  const count = (await runtime.detail(id)).messages.length
  await runtime.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return detail
    await delay(20)
  }
  throw new Error('Policy acceptance turn did not settle')
}

function currentRequest(requests: RequestEvidence[], marker: string) {
  const value = requests.findLast(request => request.user.includes(marker))
  if (!value) throw new Error(`No provider request for ${marker}`)
  return value
}
function expectCore(request: RequestEvidence) {
  expect(request.system?.sections?.['runtime-core']).toContain(RUNTIME_CORE_PROMPT)
  expect(Object.keys(request.system?.sections ?? {}).filter(key => key === 'runtime-core')).toHaveLength(1)
}

describe('default policy at the actual Pi provider boundary', () => {
  it('includes the core, workspace, planning route and goal guidance without a preset or existing goal', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Default policy' })
    const detail = await send(f.runtime, conversation.conversation.id, '[prompt-probe] default')
    const request = currentRequest(f.requests, '[prompt-probe] default')
    expectCore(request)
    expect(request.system?.sections?.['work-policy']).toContain(conversation.conversation.cwd)
    expect(request.system?.sections?.['work-policy']).toContain('todo_write')
    expect(request.system?.sections?.['goal-policy']).toContain('create_goal')
    expect(request.tools).toContain('todo_write')
    expect(request.tools).toContain('create_goal')
    expect(detail.goal ?? null).toBeNull()
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  it('adds only the policy to a no-tool preset and preserves its custom instructions', async () => {
    const f = await fixture()
    const preset = await f.runtime.createPreset({ name: 'Translator', instructions: 'ONLY_TRANSLATE_ROLE_928', extensions: [], tools: [], accessMode: 'readOnly' })
    const conversation = await f.runtime.create({ title: 'Restricted role', presetId: preset.id })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] restricted')
    const request = currentRequest(f.requests, '[prompt-probe] restricted')
    expectCore(request)
    expect(request.tools).toEqual([])
    expect(request.system?.sections?.instructions).toContain('ONLY_TRANSLATE_ROLE_928')
    expect(request.system?.sections?.['work-policy']).not.toContain('todo_write')
    expect(request.system?.sections?.['goal-policy']).toBeUndefined()
    expect(f.runtime.presets().find(item => item.id === preset.id)?.tools).toEqual([])
  })

  it('gives script-only routing while the provider sees only codemode', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ codemodeMode: 'only' })
    const conversation = await f.runtime.create({ title: 'Script route' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] script')
    const request = currentRequest(f.requests, '[prompt-probe] script')
    expectCore(request)
    expect(request.tools).toEqual(['codemode'])
    expect(request.system?.sections?.['work-policy']).toContain('tools.todo_write')
    expect(request.system?.sections?.['goal-policy']).toContain('codemode')
  })

  it('keeps plan mode research-only and suspends an existing goal continuation', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Planning' })
    await f.runtime.goal(conversation.conversation.id, { action: 'create', objective: 'Research the change', maxGoalRounds: 3 })
    await f.runtime.setPlan(conversation.conversation.id, true)
    const detail = await send(f.runtime, conversation.conversation.id, '[prompt-probe] planning')
    const request = currentRequest(f.requests, '[prompt-probe] planning')
    expectCore(request)
    expect(request.system?.sections?.['plan-policy']).toBeTruthy()
    expect(request.system?.sections?.['work-policy']).not.toContain('tools.todo_write')
    expect(detail.goal?.roundsStarted).toBe(0)
    expect(f.requests.filter(item => item.user.startsWith('[goal '))).toHaveLength(0)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  it('does not continue an active goal when a preset lacks its completion tools', async () => {
    const f = await fixture()
    const preset = await f.runtime.createPreset({ name: 'Goal reader', instructions: '', extensions: ['goal'], tools: ['get_goal'], accessMode: 'readOnly' })
    const conversation = await f.runtime.create({ title: 'No completion tool', presetId: preset.id })
    await f.runtime.goal(conversation.conversation.id, { action: 'create', objective: 'Remain inspectable', maxGoalRounds: 3 })
    const detail = await send(f.runtime, conversation.conversation.id, '[prompt-probe] no-update')
    expect(currentRequest(f.requests, '[prompt-probe] no-update').tools).toEqual(['get_goal'])
    expect(detail.goal?.roundsStarted).toBe(0)
  })

  it('allows goal tracking in a read-only conversation without filesystem write tools', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Read-only objective', accessMode: 'readOnly' })
    const detail = await send(f.runtime, conversation.conversation.id, '[goal]')
    const request = currentRequest(f.requests, '[goal]')
    expectCore(request)
    expect(request.tools).toEqual(expect.arrayContaining(['create_goal', 'get_goal', 'update_goal']))
    expect(request.tools).not.toContain('write')
    expect(request.tools).not.toContain('bash')
    expect(detail.goal?.roundsStarted).toBe(3)
    expect(detail.messages.filter(item => item.role === 'tool').some(item => item.isError)).toBe(false)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  it('includes the policy in child and forked conversations', async () => {
    const f = await fixture()
    const parent = await f.runtime.create({ title: 'Parent' })
    const detail = await send(f.runtime, parent.conversation.id, '[subagent]')
    const child = (await f.runtime.children(parent.conversation.id))[0]!
    await send(f.runtime, child.id, '[prompt-probe] child')
    expectCore(currentRequest(f.requests, '[prompt-probe] child'))
    const entry = detail.messages.findLast(message => message.role === 'assistant' && message.entryId)!.entryId!
    const fork = await f.runtime.fork(parent.conversation.id, entry)
    await send(f.runtime, fork.conversation.id, '[prompt-probe] fork')
    expectCore(currentRequest(f.requests, '[prompt-probe] fork'))
  })

  it('upgrades an old stored preset selection on restart without adding tools or replacing instructions', async () => {
    const f = await fixture()
    const preset = await f.runtime.createPreset({ name: 'Legacy reader', instructions: 'PERSISTED_READER_ROLE', extensions: ['coding-tools'], tools: ['read'], accessMode: 'readOnly' })
    const conversation = await f.runtime.create({ title: 'Legacy conversation', presetId: preset.id })
    await f.runtime.close()
    const registry = createRegistry()
    registry.install(CodingTools)
    const harness = await Harness.open(await openNodeSqliteStorage(join(f.options.dataDir, 'pi-durable.sqlite')), { models: createDemoModelRuntime().models, registry }, BACKGROUND_CONTEXT)
    try {
      await harness.commit(async tx => {
        const state = await tx.doc(AgentDoc, Number(conversation.conversation.id) as ConversationId)
        state.extensions = ['coding-tools']
      }, BACKGROUND_CONTEXT)
    } finally { await harness.close(BACKGROUND_CONTEXT) }
    await f.restart()
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] restarted')
    const request = currentRequest(f.requests, '[prompt-probe] restarted')
    expectCore(request)
    expect(request.tools).toEqual(['read'])
    expect(request.system?.sections?.instructions).toContain('PERSISTED_READER_ROLE')
  })
})
