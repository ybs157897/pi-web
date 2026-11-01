import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ConversationDetail,
  CreateConversationInput,
  SubmitInput,
  ThinkingLevel,
  WetrackAnalysisRun,
  WetrackAnalysisSettings,
  WetrackAnalysisStartInput,
  ModelRef,
  WorkspaceSummary,
} from '../../shared/types.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { isDefectNumber, readWetrackAnalysis } from './wetrack-analysis.ts'
import type { RuntimeConversation } from '../runtime/automations.ts'
import { CTX, safeFailure } from '../runtime/helpers.ts'

/**
 * The analysis conversation reasons at this level unless the binding pins another one.
 * Measured on DTS006763701: `max` took a 119s median, `high` 113s, `off` 75s — with the
 * same verified conclusion every time. `high` keeps the reasoning trace, so it is the
 * default; `off` is offered for latency, not for correctness.
 */
export const DEFAULT_ANALYSIS_THINKING_LEVEL: ThinkingLevel = 'high'

const runSchema = z.object({
  defectNumber: z.string().regex(/^DTS\d{3,16}$/u),
  workspaceId: z.string().min(1).max(160),
  workspaceName: z.string().min(1).max(120),
  conversationId: z.string().min(1).max(200).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  error: z.string().max(2_000).optional(),
}).strict()

export function wetrackAnalysisRunPrompt(defectNumber: string): string {
  return [
    `[wetrack-analysis:${defectNumber}]`,
    `请结合当前绑定的代码工作区分析这个 bug 单：${defectNumber}。先读取缺陷详情，定位实际原因并给出有代码证据的分析；不要修改代码、提交或推送。`,
    '按任务匹配到的 Skill 规则执行只读分析，优先使用已提供的宿主工具获取信息。',
    '调研按以下方式进行：',
    '1. 第 1 轮：在同一轮里调用 `wetrack_analysis_detail` 读取本次缺陷、`wetrack_analysis_get` 读取已有结论作为定位线索、`list_files` 读取仓库顶层模块。已有报告只用于提供候选入口，不要求逐条复核其全部引用或重写整份报告。',
    '2. 定位候选文件：在发出第一次 `subagent` 调用之前，你的工具检索轮次最多 3 轮（第 1 轮计入），第 4 轮必须派发。这几轮必须遵守：\n- 每次 `grep` 都要带 `path` 或 `include` 限定范围；禁止对仓库根 `.` 做中文自然语言的宽匹配\n- 优先用精确标识符检索——枚举名、常量名、方法名的英文形式。中文功能名可按仓库命名习惯直接转写猜测（例如「移交并分享同意」→ `SITE_DELIVER_AND_SHARE_AGREE`），猜错就换写法，不要改用中文泛搜\n- 禁止逐模块横扫式 `grep`；一次检索命中多个模块时，只读最相关的 1–2 个\n- 同一个路径不要重复 `list_files`\n第 3 轮结束时，手上必须已有 1–2 个候选文件路径和一个待验证的根因假设。',
    '3. 立即派发：第 4 轮在同一轮发出两个 `subagent` 调用（`agent_type: "Explore"`），A 核对操作入口及直接调用链，B 核对数据读写、通知或展示链路。任务里写清缺陷编号、现象、预期结果、已定位的文件路径、待验证的假设和只读约束。不要为了补齐背景继续预研而推迟分派——派发本身就是最快的检索方式。已经能闭环的简单问题直接完成，不为并行而并行。',
    '4. 子 Agent 是定向证据核对者，不负责重新做一份完整分析。每个子任务只回答一个必要问题，限定到已定位的文件或方法；grep、glob、read、list_files 等检索读取动作合计不超过 8 次，达到上限就返回未证实缺口，不能改用其他工具绕过。不得扩展到其他服务、相似缺陷或新假设。给出完整的仓库相对路径，禁止用 `...` 省略路径；不要求子 Agent 重查已知入口或缺陷详情。子 Agent 不继承本会话消息或 Skill 正文，因此任务中须包含缺陷编号、必要事实、范围和只读约束。',
    '5. 子 Agent 只返回该问题的精炼结论、必要 `path:line` 证据和未证实缺口，不写最终分析记录，也不再派生子 Agent。证据足够就立即返回；无法证实时报告缺口，不要为了排除所有可能继续搜索。',
    '6. 主 Agent 负责归因。子 Agent 返回后最多再补查 1 轮，然后立即整理报告并调用 `wetrack_analysis_save`。只有结论直接冲突或影响根因成立的缺口才补查；不得为补齐背景、相似分支、精确行号或排除所有假设继续搜索。其他缓存、客户端、外部中台等未证实因素列为“未覆盖/需确认”。证据闭环后立即整理报告并保存，不重复完整调研。',
    '结论必须有代码证据，关键位置用 `path:line` 引用；证据不足时明确说明缺失的信息，不要猜测。修复建议围绕已证实的根因，不把其他潜在问题扩展成额外调研。每条关键证据写成 Markdown 链接 `[文件名.java:175](完整/仓库/相对/路径.java#L175-L178)`——链接里的路径以及正文里提到的任何路径都必须完整写出，不得用 `...` 省略，页面按这个格式渲染可跳转的证据。',
    '完成后必须调用 `wetrack_analysis_save`，将最终分析正文放入 markdown，给出 title、简短 summary；结论可靠时 status 使用 analyzed，确实无法定位时使用 blocked。正文包含根因、代码证据和修复建议，不要只记录工具调用过程。',
  ].join('\n\n')
}

function runDir(dataDir: string): string {
  return join(dataDir, 'wetrack', 'analysis-runs')
}

function runPath(dataDir: string, defectNumber: string): string {
  if (!isDefectNumber(defectNumber)) throw new RuntimeError('INVALID_INPUT', '缺陷编号不合法')
  return join(runDir(dataDir), `${defectNumber}.json`)
}

async function saveRun(dataDir: string, run: WetrackAnalysisRun): Promise<WetrackAnalysisRun> {
  const target = runPath(dataDir, run.defectNumber)
  await mkdir(runDir(dataDir), { recursive: true, mode: 0o700 })
  const temp = join(runDir(dataDir), `.tmp-${process.pid}-${crypto.randomUUID()}`)
  try {
    await writeFile(temp, JSON.stringify(run, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  return structuredClone(run)
}

export async function readWetrackAnalysisRun(dataDir: string, defectNumber: string): Promise<WetrackAnalysisRun | undefined> {
  try {
    return runSchema.parse(JSON.parse(await readFile(runPath(dataDir, defectNumber), 'utf8')))
  } catch {
    return undefined
  }
}

export interface WetrackAnalysisRunsDeps {
  dataDir: string
  create(input: CreateConversationInput): Promise<ConversationDetail>
  submit(id: string, input: SubmitInput): Promise<{ submissionId: string }>
  requireConversation(id: string): Promise<RuntimeConversation>
  currentDetail(id: string): Promise<ConversationDetail>
  selectedWorkspace(id: string): WorkspaceSummary
  analysisModel(): ModelRef | undefined
  /** The thinking levels the analysis model honours, so the page can offer only real ones. */
  supportedThinkingLevels?(): ThinkingLevel[]
  activateSkills(workspace: WorkspaceSummary): Promise<{ skillIds: string[] }>
}

export function createWetrackAnalysisRuns(deps: WetrackAnalysisRunsDeps) {
  const tasks = new Set<Promise<void>>()
  const starts = new Map<string, Promise<WetrackAnalysisRun>>()
  const observed = new Set<string>()

  const refresh = async (run: WetrackAnalysisRun, recovering = false): Promise<WetrackAnalysisRun> => {
    if (run.conversationId === undefined) return run
    if (!recovering && run.status !== 'running' && run.status !== 'queued') {
      const analysis = await readWetrackAnalysis(deps.dataDir, run.defectNumber)
      if (run.status !== 'completed' && analysis?.conversationId === run.conversationId) {
        return saveRun(deps.dataDir, { ...run, status: 'completed', updatedAt: Date.now() })
      }
      return run
    }
    const next = { ...run }
    try {
      const detail = await deps.currentDetail(run.conversationId)
      const analysis = await readWetrackAnalysis(deps.dataDir, run.defectNumber)
      if (analysis?.conversationId === run.conversationId) {
        next.status = detail.conversation.busy ? 'running' : 'completed'
        delete next.error
      } else if (run.status === 'queued' && !observed.has(`${run.defectNumber}:${run.conversationId}`)) {
        next.status = 'queued'
      } else if (detail.conversation.busy) {
        next.status = 'running'
      } else if (detail.error) {
        next.status = 'failed'
        next.error = safeFailure(detail.error)
      } else {
        next.status = 'failed'
        next.error = '分析会话已结束，但没有保存该缺陷的分析结果。请打开会话查看原因后重试。'
      }
    } catch (error) {
      next.status = 'failed'
      next.error = safeFailure(error)
    }
    if (next.status === run.status && next.error === run.error) return run
    next.updatedAt = Date.now()
    return saveRun(deps.dataDir, next)
  }

  const start = async (input: WetrackAnalysisStartInput): Promise<WetrackAnalysisRun> => {
    const defectNumber = input.defectNumber.trim()
    if (!isDefectNumber(defectNumber)) throw new RuntimeError('INVALID_INPUT', '缺陷编号不合法')
    const inFlight = starts.get(defectNumber)
    if (inFlight !== undefined) return inFlight
    const promise = (async () => {
      const binding = await workspaceBinding()
      const workspaceId = binding.workspaceId
      // The analysis workflow keeps its own thinking default: it is a background evidence
      // hunt whose latency the operator waits on, and `high` reasons fully while costing
      // about a third of what `max` does. The binding may pin another level.
      const thinkingLevel = binding.thinkingLevel ?? DEFAULT_ANALYSIS_THINKING_LEVEL
      if (workspaceId === undefined) throw new RuntimeError('INVALID_INPUT', '请先在问题清单设置中绑定共享代码工作区')
      const workspace = deps.selectedWorkspace(workspaceId)
      const model = deps.analysisModel()
      if (model === undefined) throw new RuntimeError('MODEL_UNAVAILABLE', '问题分析需要配置 deepseek-v4.1-flash 模型，请先在模型设置中添加')
      const existing = await readWetrackAnalysisRun(deps.dataDir, defectNumber)
      if (existing !== undefined && (existing.status === 'running' || existing.status === 'queued')) {
        const refreshed = await refresh(existing)
        if (refreshed.status === 'running' || refreshed.status === 'queued') return refreshed
      }
      const now = Date.now()
      let run: WetrackAnalysisRun = {
        defectNumber, workspaceId: workspace.id, workspaceName: workspace.name,
        status: 'queued', createdAt: now, updatedAt: now,
      }
      await saveRun(deps.dataDir, run)
      try {
        const detail = await deps.create({
          title: `问题分析 · ${defectNumber}`, workspaceId: workspace.id, accessMode: 'readOnly', kind: 'defectAnalysis', model,
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        })
        run = { ...run, conversationId: detail.conversation.id, status: 'running', updatedAt: Date.now() }
        await saveRun(deps.dataDir, run)
        await deps.submit(detail.conversation.id, {
          text: wetrackAnalysisRunPrompt(defectNumber), requestId: `wetrack-analysis:${run.createdAt}`, whenBusy: 'reject',
        })
        observed.add(`${defectNumber}:${detail.conversation.id}`)
        const conversation = await deps.requireConversation(detail.conversation.id)
        const task = (async () => {
          try {
            await conversation.waitForIdle(CTX)
          } catch {
            // Refresh projects both provider failures and a missing save result.
          }
          const latest = await readWetrackAnalysisRun(deps.dataDir, defectNumber)
          if (latest?.conversationId === detail.conversation.id) await refresh(latest)
        })()
        tasks.add(task)
        void task.finally(() => tasks.delete(task)).catch(() => undefined)
        return run
      } catch (error) {
        const current = await readWetrackAnalysisRun(deps.dataDir, defectNumber)
        if (current?.createdAt === now) await saveRun(deps.dataDir, {
          ...current, status: 'failed', error: safeFailure(error), updatedAt: Date.now(),
        })
        throw error
      }
    })()
    starts.set(defectNumber, promise)
    try {
      return await promise
    } finally {
      starts.delete(defectNumber)
    }
  }

  const list = async (): Promise<WetrackAnalysisRun[]> => {
    let names: string[]
    try {
      names = await readdir(runDir(deps.dataDir))
    } catch {
      return []
    }
    const runs = await Promise.all(names.filter(name => /^DTS\d{3,16}\.json$/u.test(name))
      .map(name => readWetrackAnalysisRun(deps.dataDir, name.slice(0, -5))))
    const refreshed = await Promise.all(runs.filter((run): run is WetrackAnalysisRun => run !== undefined).map(run => refresh(run)))
    return refreshed.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const bindWorkspace = async (workspaceId: string, thinkingLevel?: ThinkingLevel): Promise<WetrackAnalysisSettings> => {
    const workspace = deps.selectedWorkspace(workspaceId)
    const target = join(deps.dataDir, 'wetrack', 'workspace.json')
    await mkdir(join(deps.dataDir, 'wetrack'), { recursive: true, mode: 0o700 })
    // Rebinding the workspace keeps the pinned thinking level unless the caller sets one.
    const level = thinkingLevel ?? (await workspaceBinding()).thinkingLevel
    const binding = { workspaceId: workspace.id, ...(level === undefined ? {} : { thinkingLevel: level }) }
    await writeFile(target, JSON.stringify(binding) + '\n', { encoding: 'utf8', mode: 0o600 })
    const skills = await deps.activateSkills(workspace)
    return { workspaceId: workspace.id, model: deps.analysisModel(), thinkingLevel: level ?? DEFAULT_ANALYSIS_THINKING_LEVEL, supportedThinkingLevels: deps.supportedThinkingLevels?.() ?? [], skillIds: skills.skillIds }
  }

  const workspaceBinding = async (): Promise<{ workspaceId?: string; thinkingLevel?: ThinkingLevel }> => {
    try {
      const value = z.object({ workspaceId: z.string().min(1).max(160), thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional() }).parse(JSON.parse(await readFile(join(deps.dataDir, 'wetrack', 'workspace.json'), 'utf8')))
      deps.selectedWorkspace(value.workspaceId)
      return value
    } catch {
      return {}
    }
  }

  const recover = async (): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(runDir(deps.dataDir))
    } catch {
      return
    }
    for (const name of names.filter(name => /^DTS\d{3,16}\.json$/u.test(name))) {
      const run = await readWetrackAnalysisRun(deps.dataDir, name.slice(0, -5))
      if (run === undefined || (run.status !== 'running' && run.status !== 'queued')) continue
      const refreshed = await refresh(run, true)
      if (refreshed.status !== 'running' && refreshed.status !== 'queued') continue
      await saveRun(deps.dataDir, {
        ...refreshed, status: 'interrupted', error: '服务在分析期间重新启动，请打开会话确认或重新分析。', updatedAt: Date.now(),
      })
    }
  }

  const settings = async (): Promise<WetrackAnalysisSettings> => {
    const { workspaceId, thinkingLevel } = await workspaceBinding()
    const skills = workspaceId === undefined
      ? { skillIds: [] }
      : await deps.activateSkills(deps.selectedWorkspace(workspaceId))
    return {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      model: deps.analysisModel(),
      thinkingLevel: thinkingLevel ?? DEFAULT_ANALYSIS_THINKING_LEVEL,
      supportedThinkingLevels: deps.supportedThinkingLevels?.() ?? [],
      skillIds: skills.skillIds,
    }
  }

  return { start, list, recover, bindWorkspace, workspaceBinding, settings, drain: () => Promise.allSettled([...tasks]) }
}
