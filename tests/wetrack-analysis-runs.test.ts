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

/**
 * WeTrack 后台分析运行（analysis runs）契约测试：只读会话的创建与提示词拼装
 * （检索预算、证据格式规则）、思考等级绑定、去重与排队、运行状态结算
 * （completed/blocked/failed/interrupted）、慢刷新竞态防御、真实 runtime 端到端。
 */
let root: string
let dataDir: string
let workspace: WorkspaceSummary

/**
 * 构造会话详情 fixture。
 * @returns 空消息队列的「Analysis」会话，cwd 指向测试 workspace
 */
function detail(id = '42'): ConversationDetail {
  return {
    conversation: { id, title: 'Analysis', createdAt: 1, updatedAt: 1, archived: false, pinned: false, busy: false, thinkingLevel: 'medium', cwd: workspace.path },
    messages: [], queue: [],
  }
}

/** 每个用例一个临时根：数据目录 + 代码 workspace（含一个 demo.ts 根因样本）。 */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-runs-'))
  dataDir = join(root, 'data')
  workspace = { id: 'ws-1', name: 'Code', path: join(root, 'code'), createdAt: 1, updatedAt: 1 }
  await mkdir(workspace.path, { recursive: true })
  await writeFile(join(workspace.path, 'demo.ts'), 'export const rootCause = "missing migration role"\n')
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('WeTrack background analysis', () => {
  // 启动契约：只读 + defectAnalysis 类型 + 指定模型 + 高思考等级；提示词不得内嵌
  // 技能正文或已保存结论，但必须带缺陷号、保存工具指引、检索轮次预算
  // （最多 3 轮 + 第 4 轮必须派发 + 禁止宽匹配/横扫 grep + 子 Agent 后补查 1 轮）
  // 与完整路径/无省略号的证据规则；wetrackAnalysisRunPrompt 返回同一文本。
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

  // 思考等级：workspace 绑定文件中的 thinkingLevel 优先于默认值，
  // settings 反映绑定值与模型支持列表的交集。
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

  // 去重契约：提交进行中（submit 未返回）时状态为 queued；同一缺陷的第二次 start
  // 复用同一会话，不重复创建。
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

  // 重绑定保留：换绑 workspace（同 id）时不丢失已钉住的 thinkingLevel，落盘一致。
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

  // 结算判据：活跃运行被复用而非重建；会话空闲但未保存分析 → failed；
  // 该会话随后保存了分析 → completed（按 conversationId 关联，而非轮询顺序）。
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

  // blocked 结算：本次运行保存了 blocked 尝试时运行标 completed + outcome=blocked，
  // 存储中既有结论（原 analyzed 正文）保持不动，只追加 latestAttempt。
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

  // 归属判定：另一个会话（conv 43）抢先把记录推进到自己的尝试后，
  // 本运行（conv 42）仍能从 latestAttempt.attempts 里找到自己那次保存并正确结算。
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

  // 竞态防御：一次挂在慢 gate 上的陈旧刷新不得把已 completed 的运行回退为 running——
  // 慢刷新返回的 busy 状态晚于结算落盘时，最终值仍是 completed。
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

  // 错误优先：provider 报错且没有保存 → failed（错误含「没有保存」）；
  // 之后即使发现已保存的分析（outcome=analyzed），错误也不得被翻案为成功，
  // 但错误文案要移除「没有保存」的误导部分。
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

  // 真实 runtime 端到端：技能激活只按任务匹配 rd-cli-ops（其他技能不注入提示词）；
  // 后台只读会话在真实 provider（faux 脚本序列：查询 → read → save → 收尾）上跑完，
  // 分析经 HTTP 可查，运行最终 completed。
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
      // 缺陷分析会话由宿主命名，因此没有标题调用抢占 provider 队列：
      // 第一条脚本响应就是分析轮拿到的响应。
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
      // runtime 以 realpath 注册 workspace；macOS 上 /var 是 /private/var 的符号链接。
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

  // 重启恢复：绑定持久化在 workspace.json；恢复流程把遗留的 running 运行标记为
  // interrupted（进行中的工作不再假装还在跑），落盘同步更新。
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
