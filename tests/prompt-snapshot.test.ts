import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getCurrentSystemMessage, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime/index.ts'
import { observeDemoRequests } from '../src/server/model/demo.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'
import type { Runtime } from '../src/server/contracts.ts'

/**
 * The assembled request at the provider boundary, rendered as reviewable text. Every prompt
 * change shows up as a snapshot diff; refresh with `npx vitest run tests/prompt-snapshot.test.ts -u`.
 */
type CapturedTool = { name: string; description: string; parameters: string }
type Captured = { user: string; sections: Record<string, string>; tools: CapturedTool[] }

const PROBE = '[prompt-probe]'

let runtime: Runtime | undefined
let unobserve: (() => void) | undefined
let root = ''
let rawRoot = ''
let workspace = ''
let dataDir = ''
let memoryRoot = ''
const captured: Captured[] = []

function textOfUser(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

async function probe(id: string, label: string): Promise<Captured> {
  const marker = `${PROBE} ${label}`
  const count = (await runtime!.detail(id)).messages.length
  await runtime!.submit(id, { text: marker, requestId: randomUUID() })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const detail = await runtime!.detail(id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) break
    await delay(20)
  }
  const request = captured.findLast(item => item.user.includes(marker))
  if (request === undefined) throw new Error(`No provider request for ${marker}`)
  return request
}

function normalize(text: string): string {
  return text
    .replaceAll(memoryRoot, '<MEMORY>')
    .replaceAll(root, '<ROOT>')
    .replaceAll(rawRoot, '<ROOT>')
    .replace(/当前日期：\d{4}-\d{2}-\d{2}（时区 [^）]+）/gu, '当前日期：<DATE>（时区 <TZ>）')
    .replace(/平台：[a-z0-9]+；/gu, '平台：<PLATFORM>；')
}

function render(name: string, request: Captured, fullTools: boolean): string {
  const sections = Object.entries(request.sections)
  const sectionChars = sections.reduce((sum, [, value]) => sum + value.length, 0)
  const descriptionChars = request.tools.reduce((sum, tool) => sum + tool.description.length, 0)
  const parameterChars = request.tools.reduce((sum, tool) => sum + tool.parameters.length, 0)
  const lines = [
    `# ${name}`,
    '',
    `sections (${sectionChars} chars): ${sections.map(([key, value]) => `${key} ${value.length}`).join(', ')}`,
    `tools (${request.tools.length}; descriptions ${descriptionChars} chars; parameters ${parameterChars} chars): ${request.tools.map(tool => tool.name).join(', ')}`,
  ]
  for (const [key, value] of sections) lines.push('', `## section ${key}`, '', value)
  if (fullTools) {
    for (const tool of request.tools) lines.push('', `## tool ${tool.name}`, '', tool.description, '', tool.parameters)
  }
  return `${normalize(lines.join('\n'))}\n`
}

async function create(title: string, accessMode: 'fullAccess' | 'readOnly' = 'fullAccess'): Promise<string> {
  return (await runtime!.create({ title, accessMode })).conversation.id
}

describe.skipIf(process.platform === 'win32')('assembled model prompt', () => {
  beforeAll(async () => {
    rawRoot = await mkdtemp(join(tmpdir(), 'pi-web-prompt-snapshot-'))
    root = await realpath(rawRoot)
    workspace = join(root, 'workspace')
    dataDir = join(root, 'data')
    const piDir = join(root, 'pi')
    await mkdir(workspace)
    await mkdir(piDir)
    await writeFile(join(piDir, 'settings.json'), '{}')
    await writeFile(join(workspace, 'AGENTS.md'), '# Project rules\n- Use pnpm for scripts.\n')
    memoryRoot = resolveMemoryRoot({ dataDir, workspacePath: workspace })
    runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
    unobserve = observeDemoRequests(request => {
      const messages = normalizeContext(request).messages
      const user = [...messages].reverse().find(message => message.role === 'user')
      const text = user?.role === 'user' ? textOfUser(user.content) : ''
      if (!text.includes(PROBE)) return
      const system = getCurrentSystemMessage(messages)
      captured.push({
        user: text,
        sections: Object.fromEntries(Object.entries(system?.sections ?? {}).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])),
        tools: getCurrentTools(messages).map(tool => ({
          name: tool.name,
          description: tool.description ?? '',
          parameters: JSON.stringify(tool.parameters ?? {}),
        })),
      })
    })
  }, 30_000)

  afterAll(async () => {
    unobserve?.()
    await runtime?.close()
    if (rawRoot) await rm(rawRoot, { recursive: true, force: true })
  })

  it('default session (code mode on)', async () => {
    const request = await probe(await create('Snapshot default'), 'default')
    await expect(render('default', request, true)).toMatchFileSnapshot('./__snapshots__/prompt/default.txt')
  })

  it('keeps each rule in one place and the stable core bounded', async () => {
    const request = await probe(await create('Snapshot uniqueness'), 'uniqueness')
    const prompt = Object.values(request.sections).join('\n')

    for (const marker of [
      '调研→形成计划→等待确认',
      '不要泛泛地“请确认”',
      'agent 状态目录',
      '只读调研后给出计划',
      'shell 只用于构建、测试、git、进程',
      '待分析的数据',
    ]) {
      expect(prompt.split(marker).length - 1, marker).toBe(1)
    }
    // The routing rule lives once in the core; the skill catalog also names the skill.
    expect(prompt).toContain('builtin:plugin-creator')

    // Scenario details live in the owning skills, not the global prompt.
    for (const marker of ['设置 → 插件市场', '不得声称已安装', '只会被标为不支持', '工具调用过程复盘']) {
      expect(prompt, marker).not.toContain(marker)
    }

    expect(request.sections['runtime-core']?.length ?? 0).toBeLessThanOrEqual(3_300)
  })

  it('plan mode', async () => {
    const id = await create('Snapshot plan')
    await runtime!.setPlan(id, true)
    await expect(render('plan', await probe(id, 'plan'), false)).toMatchFileSnapshot('./__snapshots__/prompt/plan.txt')
  })

  it('read-only session', async () => {
    const request = await probe(await create('Snapshot read-only', 'readOnly'), 'readonly')
    await expect(render('readonly', request, false)).toMatchFileSnapshot('./__snapshots__/prompt/readonly.txt')
  })

  it('code mode only', async () => {
    await runtime!.updateSettings({ codemodeMode: 'only' })
    const request = await probe(await create('Snapshot code mode only'), 'codemode-only')
    await expect(render('codemode-only', request, false)).toMatchFileSnapshot('./__snapshots__/prompt/codemode-only.txt')
  })

  it('code mode off', async () => {
    await runtime!.updateSettings({ codemodeMode: 'off' })
    const request = await probe(await create('Snapshot code mode off'), 'codemode-off')
    await runtime!.updateSettings({ codemodeMode: 'on' })
    await expect(render('codemode-off', request, false)).toMatchFileSnapshot('./__snapshots__/prompt/codemode-off.txt')
  })

  it('workspace memory, with and without plan mode', async () => {
    await mkdir(memoryRoot, { recursive: true })
    await writeFile(join(memoryRoot, 'MEMORY.md'), '- [Prefers pnpm](prefers-pnpm.md) — use pnpm for scripts\n', 'utf8')
    await runtime!.updateSettings({ memoryEnabled: true })
    const request = await probe(await create('Snapshot memory'), 'memory')
    await expect(render('memory', request, false)).toMatchFileSnapshot('./__snapshots__/prompt/memory.txt')
    const planned = await create('Snapshot memory plan')
    await runtime!.setPlan(planned, true)
    const planRequest = await probe(planned, 'memory-plan')
    await runtime!.updateSettings({ memoryEnabled: false })
    await expect(render('memory-plan', planRequest, false)).toMatchFileSnapshot('./__snapshots__/prompt/memory-plan.txt')
  })
})
