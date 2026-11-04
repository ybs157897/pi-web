import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWetrackAnalysisRuns, readWetrackAnalysisRun, wetrackAnalysisRunPrompt } from '../src/server/automation/wetrack-analysis-runs.ts'
import { writeWetrackAnalysis } from '../src/server/automation/wetrack-analysis.ts'
import type { ConversationDetail, CreateConversationInput, WorkspaceSummary } from '../src/shared/types.ts'
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { createRuntime } from '../src/server/runtime/index.ts'
import { createApp } from '../src/server/app.ts'

let root: string
let dataDir: string
let workspace: WorkspaceSummary

function detail(id = '42'): ConversationDetail {
  return {
    conversation: { id, title: 'Analysis', createdAt: 1, updatedAt: 1, archived: false, pinned: false, busy: false, thinkingLevel: 'medium', cwd: workspace.path },
    messages: [], queue: [],
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-runs-'))
  dataDir = join(root, 'data')
  workspace = { id: 'ws-1', name: 'Code', path: join(root, 'code'), createdAt: 1, updatedAt: 1 }
  await mkdir(workspace.path, { recursive: true })
  await writeFile(join(workspace.path, 'demo.ts'), 'export const rootCause = "missing migration role"\n')
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('WeTrack background analysis', () => {
  it('starts a read-only conversation bound to the chosen code workspace', async () => {
    let createInput: CreateConversationInput | undefined
    let submitted = ''
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    const runs = createWetrackAnalysisRuns({
      dataDir,
      selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: ['agents:rd-cli-ops'] }),
      create: async input => { createInput = input; return detail() },
      submit: async (_id, input) => { submitted = input.text; return { submissionId: '1' } },
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => undefined }),
      currentDetail: async () => detail(),
    })
    const run = await runs.start({ defectNumber: 'DTS006680988' })
    expect(createInput).toMatchObject({ workspaceId: workspace.id, accessMode: 'readOnly', kind: 'defectAnalysis', model: { provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }, thinkingLevel: 'high' })
    expect(submitted).not.toContain('rd-cli-ops')
    expect(submitted).not.toContain('遵循工作区分析规范')
    expect(submitted).not.toContain('skill_load')
    expect(run).toMatchObject({ defectNumber: 'DTS006680988', workspaceId: workspace.id, conversationId: '42', status: 'running' })
    expect(submitted).toContain('DTS006680988')
    expect(submitted).toContain('wetrack_analysis_save')
    expect(submitted).toContain('分析这个 bug 单：DTS006680988')
    expect(submitted).toContain('按任务匹配到的 Skill 规则执行只读分析')
    expect(submitted).toContain('在同一轮发出两个 `subagent` 调用')
    expect(submitted).toContain('定向证据核对者')
    expect(submitted).toContain('禁止用 `...` 省略路径')
    expect(submitted).toContain('证据不足时明确说明缺失的信息')
    expect(submitted).not.toContain('不需要你执行 rd-cli')
    expect(submitted).not.toContain('"defect"')
    // The search budget is what keeps a background analysis from sweeping the repository:
    // a hard cap before the first delegation, plus rules that forbid the slow grep shapes.
    expect(submitted).toContain('你的工具检索轮次最多 3 轮')
    expect(submitted).toContain('第 4 轮必须派发')
    expect(submitted).toContain('禁止对仓库根 `.` 做中文自然语言的宽匹配')
    expect(submitted).toContain('禁止逐模块横扫式 `grep`')
    expect(submitted).toContain('子 Agent 返回后最多再补查 1 轮')
    // Evidence must stay machine-checkable: full paths, no ellipsis.
    expect(submitted).toContain('正文里提到的任何路径都必须完整写出，不得用 `...` 省略')
    expect(wetrackAnalysisRunPrompt(run.defectNumber)).toBe(submitted)
    await runs.drain()
  })

  it('pins the thinking level the workspace binding asks for', async () => {
    let createInput: CreateConversationInput | undefined
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id, thinkingLevel: 'off' }))
    const runs = createWetrackAnalysisRuns({
      dataDir,
      selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      supportedThinkingLevels: () => ['off', 'high', 'max'],
      activateSkills: async () => ({ skillIds: [] }),
      create: async input => { createInput = input; return detail() },
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => undefined }),
      currentDetail: async () => detail(),
    })
    await runs.start({ defectNumber: 'DTS006680988' })
    expect(createInput).toMatchObject({ thinkingLevel: 'off' })
    expect(await runs.settings()).toMatchObject({ thinkingLevel: 'off', supportedThinkingLevels: ['off', 'high', 'max'] })
    await runs.drain()
  })

  it('stays queued during submission and deduplicates another start', async () => {
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    let submitStarted!: () => void
    let accept!: () => void
    const started = new Promise<void>(resolve => { submitStarted = resolve })
    const accepted = new Promise<void>(resolve => { accept = resolve })
    let creates = 0
    const runs = createWetrackAnalysisRuns({
      dataDir, selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: [] }), create: async () => { creates += 1; return detail() },
      submit: async () => { submitStarted(); await accepted; return { submissionId: '1' } },
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => undefined }),
      currentDetail: async () => detail(),
    })
    const first = runs.start({ defectNumber: 'DTS006680988' })
    await started
    const second = runs.start({ defectNumber: 'DTS006680988' })
    expect((await runs.list())[0]).toMatchObject({ status: 'queued', conversationId: '42' })
    accept()
    const [a, b] = await Promise.all([first, second])
    expect(a.conversationId).toBe(b.conversationId)
    expect(creates).toBe(1)
    await runs.drain()
  })

  it('keeps the pinned thinking level when the workspace is rebound', async () => {
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id, thinkingLevel: 'off' }))
    const runs = createWetrackAnalysisRuns({
      dataDir,
      selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      supportedThinkingLevels: () => ['off', 'high', 'max'],
      activateSkills: async () => ({ skillIds: [] }),
      create: async () => detail(),
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => undefined }),
      currentDetail: async () => detail(),
    })
    const rebound = await runs.bindWorkspace(workspace.id)
    expect(rebound.thinkingLevel).toBe('off')
    expect(JSON.parse(await readFile(join(dataDir, 'wetrack', 'workspace.json'), 'utf8'))).toMatchObject({ workspaceId: workspace.id, thinkingLevel: 'off' })
    await runs.drain()
  })

  it('reuses an active run and completes only when that conversation saved an analysis', async () => {
    let creates = 0
    let busy = true
    const current = detail()
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    const runs = createWetrackAnalysisRuns({
      dataDir,
      selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: ['agents:rd-cli-ops'] }),
      create: async () => { creates += 1; return current },
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => undefined }),
      currentDetail: async () => ({ ...current, conversation: { ...current.conversation, busy } }),
    })
    const started = await runs.start({ defectNumber: 'DTS006680988' })
    const again = await runs.start({ defectNumber: 'DTS006680988' })
    expect(creates).toBe(1)
    expect(again.conversationId).toBe(started.conversationId)
    busy = false
    await runs.drain()
    expect((await runs.list())[0]).toMatchObject({ status: 'failed' })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006680988', markdown: '代码根因', status: 'analyzed' }, { conversationId: '42' })
    expect((await runs.list())[0]).toMatchObject({ status: 'completed' })
    await runs.drain()
  })

  it('settles a blocked attempt without replacing the earlier conclusion', async () => {
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006680988', markdown: '原结论', status: 'analyzed' }, { conversationId: 'older', expectedRevision: 0 })
    let finish!: () => void
    const idle = new Promise<void>(resolve => { finish = resolve })
    const runs = createWetrackAnalysisRuns({
      dataDir, selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: [] }), create: async () => detail(),
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => idle }),
      currentDetail: async () => detail(),
    })
    await runs.start({ defectNumber: 'DTS006680988' })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006680988', markdown: '已核对入口，预算耗尽', status: 'blocked', blockedReason: 'budget-exhausted' }, { conversationId: '42', expectedRevision: 1 })
    finish()
    await runs.drain()
    expect((await runs.list())[0]).toMatchObject({ status: 'completed', outcome: 'blocked', blockedReason: 'budget-exhausted' })
    const stored = await readFile(join(dataDir, 'wetrack', 'analyses', 'DTS006680988.json'), 'utf8')
    expect(JSON.parse(stored)).toMatchObject({ markdown: '原结论', status: 'analyzed', latestAttempt: { markdown: '已核对入口，预算耗尽' } })
  })

  it('finds its own saved attempt when another conversation saves before refresh', async () => {
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    let finish!: () => void
    const idle = new Promise<void>(resolve => { finish = resolve })
    const runs = createWetrackAnalysisRuns({
      dataDir, selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: [] }), create: async () => detail(),
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => idle }),
      currentDetail: async () => detail(),
    })
    await runs.start({ defectNumber: 'DTS006680988' })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006680988', markdown: 'A 预算耗尽', status: 'blocked', blockedReason: 'budget-exhausted' }, { conversationId: '42', expectedRevision: 0 })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006680988', markdown: 'B 权限不足', status: 'blocked', blockedReason: 'access' }, { conversationId: '43', expectedRevision: 1 })
    finish()
    await runs.drain()
    expect((await runs.list())[0]).toMatchObject({ status: 'completed', outcome: 'blocked', blockedReason: 'budget-exhausted' })
  })

  it('does not let a slow stale refresh revert a completed run to running', async () => {
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    let finish!: () => void
    const idle = new Promise<void>(resolve => { finish = resolve })
    let releaseSlow!: () => void
    let slowStarted!: () => void
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })
    const started = new Promise<void>(resolve => { slowStarted = resolve })
    let checks = 0
    const runs = createWetrackAnalysisRuns({
      dataDir, selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: [] }), create: async () => detail(),
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => idle }),
      currentDetail: async () => {
        checks += 1
        if (checks === 1) {
          slowStarted()
          await slowGate
          return { ...detail(), conversation: { ...detail().conversation, busy: true } }
        }
        return detail()
      },
    })
    await runs.start({ defectNumber: 'DTS006680988' })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006680988', markdown: '已分析', status: 'analyzed' }, { conversationId: '42', expectedRevision: 0 })
    const slow = runs.list()
    await started
    expect((await runs.list())[0]?.status).toBe('completed')
    releaseSlow()
    expect((await slow)[0]?.status).toBe('completed')
    finish()
    await runs.drain()
  })

  it('does not turn a provider error into success when a late result arrives', async () => {
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    let providerError = false
    const runs = createWetrackAnalysisRuns({
      dataDir, selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: [] }), create: async () => detail(),
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => undefined }),
      currentDetail: async () => ({ ...detail(), ...(providerError ? { error: 'provider failure' } : {}) }),
    })
    await runs.start({ defectNumber: 'DTS006680988' })
    await runs.drain()
    expect((await runs.list())[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('没有保存') })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006680988', markdown: '已保存', status: 'analyzed' }, { conversationId: '42', expectedRevision: 0 })
    providerError = true
    const result = (await runs.list())[0]
    expect(result).toMatchObject({ status: 'failed', outcome: 'analyzed', error: expect.any(String) })
    expect(result?.error).not.toContain('没有保存')
  })

  it('runs a real background conversation, saves its result and exposes the session over HTTP', async () => {
    await mkdir(join(workspace.path, '.agents', 'skills', 'rd-cli-ops'), { recursive: true })
    await writeFile(join(workspace.path, '.agents', 'skills', 'rd-cli-ops', 'SKILL.md'), '---\nname: rd-cli-ops\ndescription: WeTrack 缺陷代码分析规范\n---\n遵循此工作区的本地分析规范。\n')
    await mkdir(join(workspace.path, '.agents', 'skills', 'rd-cli-auth'), { recursive: true })
    await writeFile(join(workspace.path, '.agents', 'skills', 'rd-cli-auth', 'SKILL.md'), '---\nname: rd-cli-auth\ndescription: WeTrack 认证\n---\n不应注入认证流程。\n')
    await mkdir(join(workspace.path, '.agents', 'skills', 'yunji-gateway'), { recursive: true })
    await writeFile(join(workspace.path, '.agents', 'skills', 'yunji-gateway', 'SKILL.md'), '---\nname: yunji-gateway\ndescription: 问题日志查询\n---\n不应注入日志流程。\n')
    const models = createModels()
    const faux = fauxProvider({ provider: 'codebuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek test', reasoning: true }] })
    models.setProvider(faux.provider)
    faux.setResponses([
      // A defect analysis conversation is named by the host, so no title call competes for
      // the provider queue: the first scripted response is the one the analysis turn gets.
      async (_context, options) => {
        markStarted()
        if (options?.signal?.aborted !== true) await released
        return fauxAssistantMessage(fauxToolCall('wetrack_analysis_detail', { defectNumber: 'DTS006744740' }), { stopReason: 'toolUse' })
      },
      fauxAssistantMessage(fauxToolCall('read', { path: 'demo.ts' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('wetrack_analysis_save', {
        defectNumber: 'DTS006744740', expectedRevision: 0, status: 'analyzed', title: '代码分析', markdown: '## 根因\n\n`demo.ts:1`',
      }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('分析已保存')),
    ])
    const runtime = await createRuntime({ dataDir, workspace: workspace.path, models, demo: true })
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    let closed = false
    try {
      const bound = await runtime.updateWetrackAnalysisSettings({ workspaceId: runtime.workspaces()[0]!.id })
      expect(bound.workspaceId).toBe(runtime.workspaces()[0]!.id)
      expect(bound.skillIds).toEqual(['rd-cli-ops'])
      const run = await runtime.startWetrackAnalysis({ defectNumber: 'DTS006744740' })
      await started
      const active = await runtime.detail(run.conversationId!)
      expect(active.conversation.busy).toBe(true)
      // The runtime registers the workspace under its realpath; on macOS /var is a symlink to /private/var.
      expect(active.conversation.cwd).toBe(await realpath(workspace.path))
      expect(active.conversation.accessMode).toBe('readOnly')
      expect(active.conversation.kind).toBe('defectAnalysis')
      expect(active.conversation.model?.modelId).toBe('deepseek-v4.1-flash')
      expect(active.messages[0]?.blocks.some(block => block.type === 'text' && block.text.includes('rd-cli-ops'))).toBe(false)
      expect(active.messages[0]?.blocks.some(block => block.type === 'text' && block.text.includes('skill_load'))).toBe(false)
      expect(active.messages[0]?.blocks.some(block => block.type === 'text' && block.text.includes('遵循此工作区的本地分析规范'))).toBe(false)
      expect(active.messages[0]?.blocks.some(block => block.type === 'text' && /rd-cli-auth|rd-cli-setup|yunji-gateway|不应注入/u.test(block.text))).toBe(false)
      expect(active.messages[0]?.blocks.some(block => block.type === 'text' && /"defect"|"item"|本地已有结论/u.test(block.text))).toBe(false)
      const app = createApp(runtime)
      const response = await app.request('/api/wetrack/analysis-runs')
      expect(await response.json()).toMatchObject({ runs: [{ defectNumber: 'DTS006744740', conversationId: run.conversationId, status: 'running' }] })
      release()
      const deadline = Date.now() + 20_000
      let analysis = await runtime.wetrackAnalysis('DTS006744740')
      while (analysis === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
        analysis = await runtime.wetrackAnalysis('DTS006744740')
      }
      expect(analysis).toMatchObject({ conversationId: run.conversationId, status: 'analyzed' })
      while ((await runtime.detail(run.conversationId!)).conversation.busy && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const completed = await runtime.detail(run.conversationId!)
      const query = completed.messages.find(message => message.role === 'tool' && message.toolName === 'wetrack_analysis_detail')
      expect(query?.isError, JSON.stringify({ query, messages: completed.messages.map(message => ({ role: message.role, tool: message.toolName, blocks: message.blocks })) })).not.toBe(true)
      expect(query?.blocks.some(block => block.type === 'text' && block.text.includes('DTS006744740')), JSON.stringify({ query, messages: completed.messages.map(message => ({ role: message.role, tool: message.toolName, blocks: message.blocks })) })).toBe(true)
      while ((await runtime.wetrackAnalysisRuns())[0]?.status !== 'completed' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect((await runtime.wetrackAnalysisRuns())[0]).toMatchObject({ status: 'completed' })
      await runtime.close()
      closed = true
    } finally {
      release()
      if (!closed) await runtime.close()
    }
  }, 30_000)

  it('persists the workspace binding and marks unfinished work interrupted on restart', async () => {
    await mkdir(join(dataDir, 'wetrack', 'analysis-runs'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'analysis-runs', 'DTS006680988.json'), JSON.stringify({
      defectNumber: 'DTS006680988', workspaceId: workspace.id, workspaceName: workspace.name,
      conversationId: '42', status: 'running', createdAt: 1, updatedAt: 1,
    }))
    await mkdir(join(dataDir, 'wetrack'), { recursive: true })
    await writeFile(join(dataDir, 'wetrack', 'workspace.json'), JSON.stringify({ workspaceId: workspace.id }))
    const runs = createWetrackAnalysisRuns({
      dataDir,
      selectedWorkspace: () => workspace,
      analysisModel: () => ({ provider: 'codebuddy', modelId: 'deepseek-v4.1-flash' }),
      activateSkills: async () => ({ skillIds: ['agents:rd-cli-ops'] }),
      create: async () => detail(),
      submit: async () => ({ submissionId: '1' }),
      requireConversation: async () => ({ id: '42' as never, waitForIdle: async () => undefined }),
      currentDetail: async () => ({ ...detail(), conversation: { ...detail().conversation, busy: true } }),
    })
    await runs.bindWorkspace(workspace.id)
    expect(await runs.workspaceBinding()).toEqual({ workspaceId: workspace.id })
    await runs.recover()
    expect(await readWetrackAnalysisRun(dataDir, 'DTS006680988')).toMatchObject({ status: 'interrupted', conversationId: '42' })
    expect(JSON.parse(await readFile(join(dataDir, 'wetrack', 'analysis-runs', 'DTS006680988.json'), 'utf8')).status).toBe('interrupted')
  })
})
