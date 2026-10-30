import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime.ts'
import { createApp } from '../src/server/app.ts'
import { DEMO_SKILL } from '../src/server/demo-skills.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

const fixtures: Array<{ root: string; runtime: Runtime }> = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-skills-runtime-'))
  const options = { dataDir: join(root, 'data'), workspace: join(root, 'workspace'), piDir: join(root, 'pi'), demo: true }
  await mkdir(options.piDir)
  await writeFile(join(options.piDir, 'settings.json'), '{}')
  const runtime = await createRuntime(options)
  const item = { root, runtime }
  fixtures.push(item)
  return { ...options, runtime, item }
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.runtime.close()
    await rm(item.root, { recursive: true, force: true })
  }
})
const textOf = (message: ConversationDetail['messages'][number]) => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
async function run(runtime: Runtime, id: string, text: string) {
  const count = (await runtime.detail(id)).messages.length
  await runtime.submit(id, { text, requestId: randomUUID() })
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return detail
    await delay(25)
  }
  throw new Error('Skill demo did not settle')
}

describe('Skills through the application runtime', () => {
  it('loads the bundled creator, saves, discovers and validates a skill, then reuses it in another conversation after restart', async () => {
    const f = await fixture()
    const conversation = await f.runtime.create({ title: 'Create a skill' })
    const detail = await run(f.runtime, conversation.conversation.id, '[skills-create]')
    const results = detail.messages.filter(message => message.role === 'tool')
    expect(results.map(message => message.toolName)).toEqual(['skill_load', 'skill_save', 'skill_list', 'skill_validate', 'skill_load'])
    expect(results.some(message => message.isError)).toBe(false)
    expect(await readFile(join(f.workspace, '.agents/skills/demo-verifier/SKILL.md'), 'utf8')).toBe(DEMO_SKILL)
    const workspaceId = conversation.conversation.workspaceId!
    expect((await f.runtime.skills(workspaceId)).skills.map(skill => skill.id)).toContain('agents:demo-verifier')
    await f.runtime.close()
    f.item.runtime = await createRuntime(f)
    const next = await f.item.runtime.create({ title: 'Use persisted skill', accessMode: 'readOnly' })
    const reused = await run(f.item.runtime, next.conversation.id, '[skills-use]')
    const loaded = reused.messages.find(message => message.toolName === 'skill_load' && message.role === 'tool')!
    expect(loaded.isError).not.toBe(true)
    expect(textOf(loaded)).toContain('PI_WEB_SKILL_READY')
  }, 30_000)

  it('allows read-only discovery but rejects skill saves directly and through code mode', async () => {
    const { runtime, workspace } = await fixture()
    const direct = await runtime.create({ title: 'Read only', accessMode: 'readOnly' })
    const detail = await run(runtime, direct.conversation.id, '[skills-create]')
    expect(detail.messages.find(message => message.role === 'tool' && message.toolName === 'skill_load')?.isError).not.toBe(true)
    expect(detail.messages.find(message => message.role === 'tool' && message.toolName === 'skill_save')?.isError).toBe(true)
    await runtime.updateSettings({ codemodeMode: 'only' })
    const nested = await runtime.create({ title: 'Nested read only', accessMode: 'readOnly' })
    const nestedDetail = await run(runtime, nested.conversation.id, '[skills-nested-save]')
    expect(nestedDetail.messages.some(message => message.role === 'tool' && message.toolName === 'codemode')).toBe(true)
    await expect(readFile(join(workspace, '.agents/skills/demo-verifier/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('supports skill writes through code mode and rejects them while plan mode is active', async () => {
    const { runtime, workspace } = await fixture()
    await runtime.updateSettings({ codemodeMode: 'only' })
    const planning = await runtime.create({ title: 'No writes during plan' })
    await runtime.setPlan(planning.conversation.id, true)
    await run(runtime, planning.conversation.id, '[skills-nested-save]')
    await expect(readFile(join(workspace, '.agents/skills/demo-verifier/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const writer = await runtime.create({ title: 'Nested skill save' })
    const detail = await run(runtime, writer.conversation.id, '[skills-nested-save]')
    expect(detail.messages.find(message => message.role === 'tool' && message.toolName === 'codemode')?.isError).not.toBe(true)
    expect(await readFile(join(workspace, '.agents/skills/demo-verifier/SKILL.md'), 'utf8')).toBe(DEMO_SKILL)
  })

  it('keeps preset tool allowlists and passes configured skill tools to child conversations', async () => {
    const { runtime, workspace } = await fixture()
    await mkdir(join(workspace, '.agents/skills/demo-verifier'), { recursive: true })
    await writeFile(join(workspace, '.agents/skills/demo-verifier/SKILL.md'), DEMO_SKILL)
    const preset = await runtime.createPreset({ name: 'Read files only', instructions: '', extensions: ['coding-tools'], tools: ['read'], accessMode: 'readOnly' })
    const restricted = await runtime.create({ title: 'No skill tools', presetId: preset.id })
    const denied = await run(runtime, restricted.conversation.id, '[skills-use]')
    expect(denied.messages.find(message => message.role === 'tool' && message.toolName === 'skill_load')?.isError).toBe(true)
    const parent = await runtime.create({ title: 'Delegate skill use', accessMode: 'readOnly' })
    const delegated = await run(runtime, parent.conversation.id, '[skills-delegate]')
    const result = delegated.messages.find(message => message.role === 'tool' && message.toolName === 'subagent')!
    expect(result.isError).not.toBe(true)
    expect(textOf(result)).toContain('PI_WEB_SKILL_READY')
    const child = (await runtime.children(parent.conversation.id))[0]!
    expect((await runtime.detail(child.id)).conversation.accessMode).toBe('readOnly')
  })

  it('serves a workspace-scoped catalog, bounded resources and validation through HTTP', async () => {
    const { runtime, workspace } = await fixture()
    const app = createApp(runtime, { demo: true })
    const ws = runtime.workspaces()[0]!
    await mkdir(join(workspace, '.agents/skills/broken'), { recursive: true })
    await writeFile(join(workspace, '.agents/skills/broken/SKILL.md'), '---\nname: broken\n---\nmissing description\n')
    const path = `/api/workspaces/${ws.id}/skills`
    const catalogResponse = await app.request(path)
    expect(catalogResponse.status).toBe(200)
    const catalog = await catalogResponse.json()
    expect(catalog.skills.some((skill: { id: string }) => skill.id === 'builtin:skill-creator')).toBe(true)
    expect(catalog.skills.some((skill: { id: string }) => skill.id === 'builtin:plugin-creator')).toBe(true)
    expect(catalog.diagnostics.length).toBeGreaterThan(0)
    const content = await app.request(`${path}/read?skillId=builtin%3Askill-creator`)
    expect(content.status).toBe(200)
    expect((await content.json()).content).toContain('skill-creator')
    const pluginCreator = await app.request(`${path}/read?skillId=builtin%3Aplugin-creator`)
    expect(pluginCreator.status).toBe(200)
    expect((await pluginCreator.json()).content).toContain('plugin.json')
    const pluginFormat = await app.request(`${path}/read?skillId=builtin%3Aplugin-creator&resource=references%2Fplugin-format.md`)
    expect(pluginFormat.status).toBe(200)
    expect((await pluginFormat.json()).content).toContain('marketplace.json')
    const validation = await app.request(`${path}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skillId: 'agents:broken' }) })
    expect(validation.status).toBe(200)
    expect((await validation.json()).valid).toBe(false)
    expect((await app.request('/api/workspaces/unknown/skills')).status).toBe(404)
    expect((await app.request(`${path}/read`)).status).toBe(400)
    const escape = await app.request(`${path}/read?skillId=builtin%3Askill-creator&resource=..%2F..%2Fpackage.json`)
    expect([400, 403]).toContain(escape.status)
    await app.shutdown()
  })
})
