/**
 * 组装后提示词的快照评审门（提示词完整请求快照）。
 *
 * 用真实 runtime + demo 模型捕获发往 provider 的请求，把 system sections 与工具目录
 * 渲染为可评审文本，与 tests/__snapshots__/prompt/ 下的文件快照比对——任何提示词改动
 * 都会以 diff 形式出现（刷新：`npx vitest run tests/prompt-snapshot.test.ts -u`）。
 *
 * 覆盖场景：默认会话（code mode on）、计划模式、只读会话、code mode only/off、
 * 工作区记忆（含计划模式）、以及 5 种委派子代理组合（profile × codemode × plan）。
 * 另有规则唯一性 / runtime-core 字数上限（≤3,300）/ 中文文案覆盖等非快照断言。
 */
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
 * provider 边界处捕获的组装请求，渲染为可评审文本。任何提示词改动都会体现为快照 diff；
 * 用 `npx vitest run tests/prompt-snapshot.test.ts -u` 刷新。
 */
type CapturedTool = { name: string; description: string; parameters: string }
type Captured = { user: string; sections: Record<string, string>; tools: CapturedTool[] }

/** 探针标记：出现在提交文本中，用于从捕获列表定位对应请求。 */
const PROBE = '[prompt-probe]'

/** 共享 runtime 与捕获状态（beforeAll 建立一次，全部用例复用）。 */
let runtime: Runtime | undefined
let unobserve: (() => void) | undefined
let root = ''
let rawRoot = ''
let workspace = ''
let dataDir = ''
let memoryRoot = ''
const captured: Captured[] = []

/**
 * 提取用户消息的文本（字符串直取，分块内容拼接 text 部分）。
 * @param content 用户消息内容
 * @returns 拼接后的文本
 */
function textOfUser(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

/**
 * 提交一条带探针标记的消息，等待回合完成，返回包含该标记的 provider 请求。
 * @param id 会话 id
 * @param label 探针标签（进入标记文本）
 * @returns 捕获的组装请求
 */
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

/**
 * 快照归一化：把环境相关的绝对路径、日期、时区、平台替换为稳定占位符，保证快照可复现。
 * @param text 待归一化文本
 * @returns 归一化后的文本
 */
function normalize(text: string): string {
  return text
    .replaceAll(memoryRoot, '<MEMORY>')
    .replaceAll(root, '<ROOT>')
    .replaceAll(rawRoot, '<ROOT>')
    .replace(/当前日期：\d{4}-\d{2}-\d{2}（时区 [^）]+）/gu, '当前日期：<DATE>（时区 <TZ>）')
    .replace(/平台：[a-z0-9]+；/gu, '平台：<PLATFORM>；')
}

/**
 * 把捕获请求渲染成快照文本：首行为 section/tool 的名称与字符数汇总（评审 diff 的摘要行），
 * 随后逐个输出 section 全文；fullTools 为真时附上每个工具的描述与参数全文。
 * @param name 快照名（标题）
 * @param request 捕获的请求
 * @param fullTools 是否输出工具描述/参数全文
 * @returns 可写入快照文件的文本
 */
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

/**
 * 在共享 runtime 上创建一个会话。
 * @param title 会话标题
 * @param accessMode 访问模式，默认 fullAccess
 * @returns 会话 id
 */
async function create(title: string, accessMode: 'fullAccess' | 'readOnly' = 'fullAccess'): Promise<string> {
  return (await runtime!.create({ title, accessMode })).conversation.id
}

/** 组装提示词的快照与契约测试（Windows 跳过）。 */
describe.skipIf(process.platform === 'win32')('assembled model prompt', () => {
  /**
   * 搭建一次性环境：临时目录 + 带项目规则的 workspace + demo runtime，
   * 并挂上 demo 请求观察器——只捕获含探针标记或子代理子请求的轮次，
   * 抽出 system sections 与工具目录存入 captured。
   */
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
      if (!text.includes(PROBE) && !text.includes('[subagent-child]')) return
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

  /** 清理：移除观察器、关闭 runtime、删除临时目录树。 */
  afterAll(async () => {
    unobserve?.()
    await runtime?.close()
    if (rawRoot) await rm(rawRoot, { recursive: true, force: true })
  })

  // 默认会话（code mode on）的完整提示词快照，含工具描述与参数全文。
  it('default session (code mode on)', async () => {
    const request = await probe(await create('Snapshot default'), 'default')
    await expect(render('default', request, true)).toMatchFileSnapshot('./__snapshots__/prompt/default.txt')
  })

  // 非快照契约：每条规则只出现在一处（五个标记各恰好一次）；插件创建/状态图的路由位置固定；
  // work-policy 不含 /plan；全局提示词不包含归属技能的场景细节；runtime-core ≤ 3,300 字符；
  // 自有 prose 为中文（除上游工具 read/write/edit/codemode/tool_search 外，工具描述
  // 与参数 schema 中的 description 均含汉字）。
  it('keeps each rule in one place and the stable core bounded', async () => {
    const request = await probe(await create('Snapshot uniqueness'), 'uniqueness')
    const prompt = Object.values(request.sections).join('\n')

    for (const marker of [
      '不要泛泛地“请确认”',
      'agent 状态目录',
      '只读调研后给出计划',
      'shell 只用于构建、测试、git、进程',
      '待分析的数据',
    ]) {
      expect(prompt.split(marker).length - 1, marker).toBe(1)
    }
    // 插件创建保持稳定路由；statechart 仅由其窄目录元数据路由。
    expect(prompt).toContain('builtin:plugin-creator')
    expect(prompt).toContain('builtin:statechart')
    expect(request.sections['runtime-core']).not.toContain('builtin:statechart')
    expect(request.sections['work-policy']).not.toContain('/plan')
    expect(request.sections['skills-policy']).toContain('普通业务流程查询、无状态逻辑和格式调整不适用')
    expect(prompt).not.toMatch(/调用 Call|directly\.，|委达/u)

    // 场景细节放在归属技能里，不出现在全局提示词。
    for (const marker of ['设置 → 插件市场', '不得声称已安装', '只会被标为不支持', '工具调用过程复盘']) {
      expect(prompt, marker).not.toContain(marker)
    }

    expect(request.sections['runtime-core']?.length ?? 0).toBeLessThanOrEqual(3_300)

    // 自有 prose 用中文；上游描述与协议标识符保持原文。
    const upstreamTools = new Set(['read', 'write', 'edit', 'codemode', 'tool_search'])
    const checkDescriptions = (value: unknown, owner: string): void => {
      if (value === null || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (key === 'description' && typeof child === 'string') {
          expect(child, owner).toMatch(/\p{Script=Han}/u)
        } else checkDescriptions(child, owner)
      }
    }
    for (const tool of request.tools) {
      if (upstreamTools.has(tool.name)) continue
      expect(tool.description, tool.name).toMatch(/\p{Script=Han}/u)
      checkDescriptions(JSON.parse(tool.parameters), tool.name)
    }
  })

  // 计划模式的提示词快照（不含工具全文）。
  it('plan mode', async () => {
    const id = await create('Snapshot plan')
    await runtime!.setPlan(id, true)
    await expect(render('plan', await probe(id, 'plan'), false)).toMatchFileSnapshot('./__snapshots__/prompt/plan.txt')
  })

  // 只读会话（readOnly 访问模式）的提示词快照。
  it('read-only session', async () => {
    const request = await probe(await create('Snapshot read-only', 'readOnly'), 'readonly')
    await expect(render('readonly', request, false)).toMatchFileSnapshot('./__snapshots__/prompt/readonly.txt')
  })

  // code mode only：工具收敛为 codemode 单工具形态的快照。
  it('code mode only', async () => {
    await runtime!.updateSettings({ codemodeMode: 'only' })
    const request = await probe(await create('Snapshot code mode only'), 'codemode-only')
    await expect(render('codemode-only', request, false)).toMatchFileSnapshot('./__snapshots__/prompt/codemode-only.txt')
  })

  // code mode off：关闭 codemode 后的提示词快照（探测完恢复设置为 on）。
  it('code mode off', async () => {
    await runtime!.updateSettings({ codemodeMode: 'off' })
    const request = await probe(await create('Snapshot code mode off'), 'codemode-off')
    await runtime!.updateSettings({ codemodeMode: 'on' })
    await expect(render('codemode-off', request, false)).toMatchFileSnapshot('./__snapshots__/prompt/codemode-off.txt')
  })

  // 工作区记忆：写入 MEMORY.md 并启用后快照 memory；计划模式叠加记忆的快照 memory-plan
  // （结束后关闭记忆开关，避免污染后续用例）。
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

  it.each([
    { profile: 'general', mode: 'on', plan: false },
    { profile: 'explore', mode: 'on', plan: false },
    { profile: 'general', mode: 'only', plan: false },
    { profile: 'explore', mode: 'only', plan: false },
    { profile: 'general', mode: 'on', plan: true },
  ] as const)('delegated $profile child: code mode $mode, plan $plan', async ({ profile, mode, plan }) => {
    // 参数化验证委派子链：父会话提交委派标记后等父回合完成，子会话恰有一个且能读到
    // 探针文件（CHILD_READ_OK / READABLE_CHILD_EVIDENCE）、无 pending 交互、无孙代理；
    // 子请求的工具目录不含禁止面（plan 切换/提问/目标/团队类工具），无 delegation-policy
    // section，work-policy 不含 /plan；plan 子代理的 plan-policy 用委派方措辞；
    // codemode only 下工具恰为 ['codemode']；最后渲染对应快照。finally 恢复 code mode on。
    await runtime!.updateSettings({ codemodeMode: mode })
    await writeFile(join(workspace, 'probe.txt'), 'READABLE_CHILD_EVIDENCE\n')
    const name = `subagent-${profile}${mode === 'only' ? '-codemode' : ''}${plan ? '-plan' : ''}`
    const id = await create(`Snapshot ${name}`)
    if (plan) await runtime!.setPlan(id, true)
    const first = captured.length
    await runtime!.submit(id, {
      text: `${profile === 'explore' ? '[subagent-explore]' : '[subagent]'} [child-read]`,
      requestId: randomUUID(),
    })
    try {
      const deadline = Date.now() + 15_000
      let completed = false
      while (Date.now() < deadline) {
        const detail = await runtime!.detail(id)
        if (detail.error) throw new Error(detail.error)
        if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) {
          completed = true
          break
        }
        await delay(20)
      }
      expect(completed, 'parent completes with its child result').toBe(true)
      const children = await runtime!.children(id)
      expect(children).toHaveLength(1)
      const child = await runtime!.detail(children[0]!.id)
      const answer = child.messages.filter(message => message.role === 'assistant').at(-1)
      const text = answer?.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
      expect(text).toContain('CHILD_READ_OK')
      expect(text).toContain('READABLE_CHILD_EVIDENCE')
      expect(child.interactions?.some(item => item.status === 'pending')).not.toBe(true)
      expect(await runtime!.children(children[0]!.id)).toEqual([])
      const request = captured.slice(first).find(item => item.user.includes('[subagent-child]'))
      expect(request, 'provider receives a real child request').toBeDefined()
      const forbidden = /^(?:enter_plan_mode|exit_plan_mode|ask_user_question|(?:get|create|update)_goal|subagent|spawn_teammate|send_message|list_agents|wait_agent|interrupt_agent|team_task_.*)$/u
      expect(request!.tools.filter(tool => forbidden.test(tool.name))).toEqual([])
      expect(request!.sections['delegation-policy']).toBeUndefined()
      expect(request!.sections['work-policy']).not.toContain('/plan')
      if (plan) {
        expect(request!.sections['plan-policy']).toContain('委派方')
        expect(request!.sections['plan-policy']).not.toContain('等待用户明确决定')
      }
      if (mode === 'only') expect(request!.tools.map(tool => tool.name)).toEqual(['codemode'])
      await expect(render(name, request!, false)).toMatchFileSnapshot(`./__snapshots__/prompt/${name}.txt`)
    } finally {
      await runtime!.updateSettings({ codemodeMode: 'on' })
    }
  })
})
