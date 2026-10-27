import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { AgentDoc, Harness, createRegistry, defineDoc, type ConversationId } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { getCurrentSystemMessage, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { SystemMessage } from '@earendil-works/pi-ai'
import { createRuntime, type ConversationMetadata } from '../src/server/runtime.ts'
import { createDemoModelRuntime, observeDemoRequests } from '../src/server/demo-model.ts'
import { RUNTIME_CORE_PROMPT } from '../src/server/work-policy.ts'
import { resolveMemoryRoot } from '../src/server/memory.ts'
import type { Runtime } from '../src/server/contracts.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

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

  it('loads and refreshes only the bound workspace root instructions at the provider boundary', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'AGENTS.md'), 'OUTSIDE_SCOPE_541')
    await writeFile(join(f.options.workspace, 'AGENTS.md'), 'ROOT_RULE_REVISION_ONE_541')
    const preset = await f.runtime.createPreset({ name: 'Root context reader', instructions: '', extensions: [], tools: [], accessMode: 'readOnly' })
    const conversation = await f.runtime.create({ title: 'Root instructions', presetId: preset.id })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] root-one')
    const first = currentRequest(f.requests, '[prompt-probe] root-one')
    expect(first.system?.sections?.['project-instructions']).toContain('ROOT_RULE_REVISION_ONE_541')
    expect(first.system?.sections?.['project-instructions']).not.toContain('OUTSIDE_SCOPE_541')
    expect(first.tools).toEqual([])
    await writeFile(join(f.options.workspace, 'AGENTS.md'), 'ROOT_RULE_REVISION_TWO_541')
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] root-two')
    const second = currentRequest(f.requests, '[prompt-probe] root-two')
    expect(second.system?.sections?.['project-instructions']).toContain('ROOT_RULE_REVISION_TWO_541')
    expect(second.system?.sections?.['project-instructions']).not.toContain('ROOT_RULE_REVISION_ONE_541')
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
    expect(request.system?.sections?.codemode).toContain('Only codemode is directly offered')
    expect(request.system?.sections?.codemode).toContain('Ordinary assistant text is still available')
    expect(request.system?.sections?.codemode).toContain('use describeTool(name)')
    expect(request.system?.sections?.codemode).not.toContain('Use direct tools for individual operations')
  })

  it('keeps plan mode research-only and suspends an existing goal continuation', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Planning' })
    await f.runtime.goal(conversation.conversation.id, { action: 'create', objective: 'Research the change', maxGoalRounds: 3 })
    await f.runtime.setPlan(conversation.conversation.id, true)
    const detail = await send(f.runtime, conversation.conversation.id, '[prompt-probe] planning')
    const request = currentRequest(f.requests, '[prompt-probe] planning')
    expectCore(request)
    const planPolicy = request.system?.sections?.['plan-policy'] ?? ''
    expect(planPolicy).toContain('先探索')
    expect(planPolicy).toContain('命令式语言要求实施时')
    expect(planPolicy).toContain('不结束计划模式')
    expect(planPolicy).toContain('计划要决策完整')
    expect(planPolicy).toContain('唯一且最后一个工具调用')
    expect(planPolicy).toContain('不要把计划当普通回复粘贴')
    expect(planPolicy).toContain('ask_user_question')
    expect(request.system?.sections?.['work-policy']).not.toContain('tools.todo_write')
    expect(request.tools).toEqual(expect.arrayContaining(['read', 'glob', 'grep']))
    expect(request.tools).not.toEqual(expect.arrayContaining(['write', 'edit', SHELL_TOOL]))
    expect(request.tools).not.toContain('send_message')
    expect(request.system?.sections?.codemode).not.toContain(`tools.${SHELL_TOOL}(`)
    expect(detail.goal?.roundsStarted).toBe(0)
    expect(f.requests.filter(item => item.user.startsWith('[goal '))).toHaveLength(0)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  it('rejects attempted writes and shell execution in Plan, then restores the same preset tools on exit', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ codemodeMode: 'off' })
    const conversation = await f.runtime.create({ title: 'Plan enforcement', accessMode: 'fullAccess' })
    const id = conversation.conversation.id
    await f.runtime.setPlan(id, true)
    const planned = await send(f.runtime, id, '[render-fixture]')
    const writes = planned.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(writes.map(message => message.toolName)).toEqual(['write', 'edit', SHELL_TOOL])
    expect(writes.every(message => message.isError === true)).toBe(true)
    expect(planned.plan?.active).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])

    await f.runtime.setPlan(id, false)
    const resumed = await send(f.runtime, id, '[render-fixture]')
    const latestWrite = resumed.messages.findLast(message => message.role === 'tool' && message.toolName === 'write')
    expect(latestWrite?.isError ?? false).toBe(false)
    expect(await readFile(join(f.options.workspace, 'render-fixture.md'), 'utf8')).toContain('# After')
  })

  it('blocks a code-mode script from reaching shell tools while Plan is active', async () => {
    const f = await fixture()
    await f.runtime.updateSettings({ codemodeMode: 'only' })
    const conversation = await f.runtime.create({ title: 'Plan nested enforcement' })
    await f.runtime.setPlan(conversation.conversation.id, true)
    const result = await send(f.runtime, conversation.conversation.id, '[codemode]')
    expect(result.messages.some(message => message.role === 'tool' && message.toolName === 'codemode' && message.isError)).toBe(true)
    expect(result.messages.some(message => message.role === 'tool' && message.toolName === SHELL_TOOL && !message.isError)).toBe(false)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  it('keeps delegated child calls in Plan and preserves the guard after restart', async () => {
    const f = await fixture()
    const parent = await f.runtime.create({ title: 'Plan delegation' })
    await f.runtime.setPlan(parent.conversation.id, true)
    const parentDetail = await send(f.runtime, parent.conversation.id, '[subagent]')
    const child = (await f.runtime.children(parent.conversation.id))[0]!
    expect((await f.runtime.detail(child.id)).plan?.active).toBe(true)
    await f.restart()
    const result = await send(f.runtime, child.id, '[render-fixture]')
    const denied = result.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(denied).toHaveLength(3)
    expect(denied.every(message => message.isError)).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])
    const entry = parentDetail.messages.findLast(message => message.role === 'assistant' && message.entryId)!.entryId!
    const fork = await f.runtime.fork(parent.conversation.id, entry)
    expect(fork.plan?.active).toBe(true)
  })

  it('constrains an existing child when its owner enters Plan, including restart and reuse', async () => {
    const f = await fixture()
    const parent = await f.runtime.create({ title: 'Existing writer' })
    await send(f.runtime, parent.conversation.id, '[subagent]')
    const child = (await f.runtime.children(parent.conversation.id))[0]!
    expect((await f.runtime.detail(child.id)).plan?.active).toBe(false)
    await f.runtime.setPlan(parent.conversation.id, true)
    expect((await f.runtime.detail(child.id)).plan?.active).toBe(true)
    await f.restart()
    const result = await send(f.runtime, child.id, '[render-fixture]')
    const denied = result.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(denied).toHaveLength(3)
    expect(denied.every(message => message.isError)).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])
  })

  it('does not advertise a plan submission route when the preset has no such tool', async () => {
    const f = await fixture()
    const preset = await f.runtime.createPreset({ name: 'Plan analyst', instructions: '', extensions: ['plan'], tools: [], accessMode: 'readOnly' })
    const conversation = await f.runtime.create({ title: 'Text plan', presetId: preset.id })
    await f.runtime.setPlan(conversation.conversation.id, true)
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] no-plan-tool')
    const request = currentRequest(f.requests, '[prompt-probe] no-plan-tool')
    expect(request.tools).toEqual([])
    expect(request.system?.sections?.['plan-policy']).not.toContain('Submit it with exit_plan_mode')
  })

  it('deduplicates code-mode declarations without hiding their discovery route', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Compact tool context' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] compact-tools')
    const request = currentRequest(f.requests, '[prompt-probe] compact-tools')
    expect(request.tools).toEqual(expect.arrayContaining(['read', 'write', SHELL_TOOL, 'codemode']))
    const code = request.system?.sections?.codemode ?? ''
    expect(code).toContain('describeTool')
    expect(code.length).toBeLessThan(2_000)
    expect(code).not.toContain('declare function')
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
    expect(request.tools).not.toContain(SHELL_TOOL)
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

  it('installs execution guards before recovering a queued edit that starts the scheduler', async () => {
    const f = await fixture()
    const preset = await f.runtime.createPreset({
      name: 'Legacy writer', instructions: '', extensions: ['coding-tools'],
      tools: ['read', 'write', 'edit', SHELL_TOOL], accessMode: 'fullAccess',
    })
    const conversation = await f.runtime.create({ title: 'Recovered plan', presetId: preset.id })
    const id = Number(conversation.conversation.id) as ConversationId
    await f.runtime.setPlan(String(id), true)
    await f.runtime.close()
    const registry = createRegistry()
    registry.install(CodingTools)
    const harness = await Harness.open(await openNodeSqliteStorage(join(f.options.dataDir, 'pi-durable.sqlite')), {
      models: createDemoModelRuntime().models, registry,
    }, BACKGROUND_CONTEXT)
    const metadata = defineDoc<ConversationMetadata>({
      kind: 'pi-durable-web.conversation', version: 1, scope: 'conversation',
      history: 'latest', fork: 'initial',
      initial: () => { throw new Error('The fixture must already have conversation metadata') },
    })
    try {
      await harness.commit(async tx => {
        const source = await tx.createSubmission({ type: 'input', conversationId: id, status: 'unanswered', reason: 'aborted' })
        const agent = await tx.doc(AgentDoc, id)
        agent.extensions = ['coding-tools']
        const doc = await tx.doc(metadata, id)
        doc.queueEdits['recovered-plan-edit'] = {
          fingerprint: 'recovery-fixture', sourceSubmissionId: Number(source.id),
          status: 'aborted', submissionId: null,
          input: { text: '[render-fixture] recovered-plan', whenBusy: 'followUp', images: [], files: [] },
        }
      }, BACKGROUND_CONTEXT)
    } finally { await harness.close(BACKGROUND_CONTEXT) }
    await f.restart()
    const deadline = Date.now() + 15_000
    let result = await f.runtime.detail(String(id))
    while ((result.conversation.busy || !result.messages.some(message => message.role === 'tool')) && Date.now() < deadline) {
      await delay(20)
      result = await f.runtime.detail(String(id))
    }
    expect(result.conversation.busy).toBe(false)
    const request = currentRequest(f.requests, 'recovered-plan')
    expectCore(request)
    expect(request.tools).not.toContain('write')
    const writes = result.messages.filter(message => message.role === 'tool' && ['write', 'edit', SHELL_TOOL].includes(message.toolName ?? ''))
    expect(writes).toHaveLength(3)
    expect(writes.every(message => message.isError)).toBe(true)
    expect(await readdir(f.options.workspace)).toEqual([])
  })
})

describe('workspace memory sections at the provider boundary', () => {
  it('injects the rules and the index only while the setting is on, and keeps them across a restart', async () => {
    const f = await fixture()
    const root = resolveMemoryRoot({ dataDir: f.options.dataDir, workspacePath: await realpath(f.options.workspace) })
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'MEMORY.md'), '- [Pref](prefs.md) — prefers Chinese\n', 'utf8')
    await f.runtime.updateSettings({ memoryEnabled: true })

    const conversation = await f.runtime.create({ title: 'Memory on' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] memory-on')
    const on = currentRequest(f.requests, '[prompt-probe] memory-on')
    expect(on.system?.sections?.memory).toContain(`\`${root}/\``)
    expect(on.system?.sections?.['memory-index']).toContain('- [Pref](prefs.md) — prefers Chinese')
    expect(on.system?.sections?.['memory-index']).toContain(join(root, 'MEMORY.md'))

    await f.runtime.updateSettings({ memoryEnabled: false })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] memory-off')
    const off = currentRequest(f.requests, '[prompt-probe] memory-off')
    expect(off.system?.sections?.memory).toBeUndefined()
    expect(off.system?.sections?.['memory-index']).toBeUndefined()

    await f.runtime.updateSettings({ memoryEnabled: true })
    await f.restart()
    const restarted = await f.runtime.create({ title: 'Memory restarted' })
    await send(f.runtime, restarted.conversation.id, '[prompt-probe] memory-restart')
    const after = currentRequest(f.requests, '[prompt-probe] memory-restart')
    expect(after.system?.sections?.memory).toContain(`\`${root}/\``)
    expect(after.system?.sections?.['memory-index']).toContain('- [Pref](prefs.md) — prefers Chinese')
  }, 30_000)

  it('omits the save rules for a read-only session but still offers an existing index', async () => {
    const f = await fixture()
    const root = resolveMemoryRoot({ dataDir: f.options.dataDir, workspacePath: await realpath(f.options.workspace) })
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'MEMORY.md'), '- [Pref](prefs.md) — prefers Chinese\n', 'utf8')
    await f.runtime.updateSettings({ memoryEnabled: true })

    const conversation = await f.runtime.create({ title: 'Read-only memory', accessMode: 'readOnly' })
    await send(f.runtime, conversation.conversation.id, '[prompt-probe] memory-readonly')
    const request = currentRequest(f.requests, '[prompt-probe] memory-readonly')
    expect(request.system?.sections?.memory).toBeUndefined()
    expect(request.system?.sections?.['memory-index']).toContain('- [Pref](prefs.md) — prefers Chinese')
  }, 20_000)
})
