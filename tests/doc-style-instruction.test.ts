import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { getCurrentSystemMessage, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime.ts'
import { docStyleContract } from '../src/server/doc-style-instruction.ts'
import { observeDemoRequests } from '../src/server/demo-model.ts'
import type { Runtime } from '../src/server/contracts.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(): Promise<{ runtime: Runtime; systems: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-doc-style-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  const options = { dataDir: join(root, 'data'), workspace: join(root, 'workspace'), piDir: join(root, 'pi'), demo: true }
  await mkdir(options.piDir)
  await writeFile(join(options.piDir, 'settings.json'), '{}')
  const runtime = await createRuntime(options)
  cleanup.push(async () => { await runtime.close() })
  const systems: string[] = []
  const unobserve = observeDemoRequests(request => {
    // The agent's own instructions ride in the system message's `instructions` section.
    const message = getCurrentSystemMessage(normalizeContext(request).messages)
    systems.push(message?.sections?.instructions ?? '')
  })
  cleanup.push(async () => { unobserve() })
  return { runtime, systems }
}

async function send(runtime: Runtime, id: string, text: string): Promise<void> {
  const count = (await runtime.detail(id)).messages.length
  await runtime.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return
    await delay(20)
  }
  throw new Error('the demo model did not answer in time')
}

describe('doc style instruction', () => {
  it('teaches the model the doc block format while the layout is on', async () => {
    const { runtime, systems } = await fixture()
    const conversation = await runtime.create({ title: 'Doc style' })
    await send(runtime, conversation.conversation.id, '总结一下')
    const system = systems.at(-1) ?? ''
    expect(system).toContain('type: cards')
    expect(system).toContain('type: compare')
    expect(system).toContain('type: note')
  })

  it('drops the instruction for conversations created after the switch went off', async () => {
    const { runtime, systems } = await fixture()
    await runtime.updateSettings({ docStyle: false })
    const conversation = await runtime.create({ title: 'Plain layout' })
    await send(runtime, conversation.conversation.id, '总结一下')
    const system = systems.at(-1) ?? ''
    expect(system).not.toContain('type: cards')
  })

  it('leaves a conversation that already started on its own contract', async () => {
    const { runtime, systems } = await fixture()
    const existing = await runtime.create({ title: 'Started with layout' })
    await send(runtime, existing.conversation.id, '总结一下')
    expect(systems.at(-1) ?? '').toContain('type: cards')

    // 开关只影响新会话：改完之后老会话的下一条仍然带着原来的契约。
    await runtime.updateSettings({ docStyle: false })
    await send(runtime, existing.conversation.id, '再总结一下')
    expect(systems.at(-1) ?? '').toContain('type: cards')

    const fresh = await runtime.create({ title: 'Created after the switch' })
    await send(runtime, fresh.conversation.id, '总结一下')
    expect(systems.at(-1) ?? '').not.toContain('type: cards')
  })

  it('keeps the preset instructions of the operator alongside the doc contract', async () => {
    const { runtime, systems } = await fixture()
    const preset = await runtime.createPreset({
      name: 'Translator', instructions: 'ONLY_TRANSLATE_ROLE_928', extensions: [], tools: [], accessMode: 'readOnly',
    })
    const conversation = await runtime.create({ title: 'Preset', presetId: preset.id })
    await send(runtime, conversation.conversation.id, '总结一下')
    const system = systems.at(-1) ?? ''
    expect(system).toContain('ONLY_TRANSLATE_ROLE_928')
    expect(system).toContain('type: cards')
  })
})

describe('doc style contract', () => {
  it('sends no contract when the layout is off', () => {
    expect(docStyleContract(false, false)).toBeUndefined()
    expect(docStyleContract(false, true)).toBeUndefined()
  })

  it('teaches YAML to a model without the structured-output capability', () => {
    const contract = docStyleContract(true, false) ?? ''
    expect(contract).toContain('type: cards')
    expect(contract).not.toContain('结构化输出')
  })

  it('teaches JSON payloads to a model with the structured-output capability', () => {
    const contract = docStyleContract(true, true) ?? ''
    expect(contract).toContain('type: cards')
    expect(contract).toContain('结构化输出')
    expect(contract).toContain('{"type":"cards"')
  })
})
