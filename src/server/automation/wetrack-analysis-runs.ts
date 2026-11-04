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
  WetrackAnalysisRecord,
  WetrackAnalysisAttempt,
} from '../../shared/types.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { analysisProcedure } from './analysis-procedure.ts'
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
const MISSING_RESULT_ERROR = '分析会话已结束，但没有保存该缺陷的分析结果。请打开会话查看原因后重试。'
const UNCERTAIN_RESULT_ERROR = '分析会话已结束；近期尝试记录已截断，无法确认本次是否保存结果，请打开会话查看。'

function attemptForConversation(record: WetrackAnalysisRecord | undefined, conversationId: string): WetrackAnalysisAttempt | undefined {
  const history = record?.attempts
  if (history !== undefined) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.conversationId === conversationId) return history[i]
    }
  }
  return record?.latestAttempt?.conversationId === conversationId ? record.latestAttempt : undefined
}

const runSchema = z.object({
  defectNumber: z.string().regex(/^DTS\d{3,16}$/u),
  workspaceId: z.string().min(1).max(160),
  workspaceName: z.string().min(1).max(120),
  conversationId: z.string().min(1).max(200).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  outcome: z.enum(['analyzing', 'analyzed', 'fixed', 'blocked']).optional(),
  blockedReason: z.enum(['budget-exhausted', 'access', 'missing-code', 'contract', 'other']).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  error: z.string().max(2_000).optional(),
}).strict()

export function wetrackAnalysisRunPrompt(defectNumber: string): string {
  return [
    `[wetrack-analysis:${defectNumber}]`,
    `请结合当前绑定的代码工作区分析这个 bug 单：${defectNumber}。先读取缺陷详情，定位实际原因并给出有代码证据的分析；不要修改代码、提交或推送。`,
    '按任务匹配到的 Skill 规则执行只读分析；与下面的调研规程冲突时以规程为准，取数用宿主工具，结论由 wetrack_analysis_save 保存。',
    '调研按以下方式进行：',
    analysisProcedure('delegate'),
  ].join('\n\n')
}

function runDir(dataDir: string): string {
  return join(dataDir, 'wetrack', 'analysis-runs')
}

function runPath(dataDir: string, defectNumber: string): string {
  if (!isDefectNumber(defectNumber)) throw new RuntimeError('INVALID_INPUT', '缺陷编号不合法')
  return join(runDir(dataDir), `${defectNumber}.json`)
}

const runWrites = new Map<string, Promise<void>>()
async function saveRun(dataDir: string, run: WetrackAnalysisRun, guard?: WetrackAnalysisRun): Promise<WetrackAnalysisRun> {
  const target = runPath(dataDir, run.defectNumber)
  const previous = runWrites.get(target) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  runWrites.set(target, next)
  await previous
  try {
    if (guard !== undefined) {
      const current = await readWetrackAnalysisRun(dataDir, run.defectNumber)
      if (current === undefined || current.createdAt !== guard.createdAt || current.conversationId !== guard.conversationId || current.updatedAt !== guard.updatedAt) return current ?? run
    }
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
  } finally {
    release()
    if (runWrites.get(target) === next) runWrites.delete(target)
  }
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
      const attempt = attemptForConversation(analysis, run.conversationId)
      if (run.status === 'failed' && run.error === MISSING_RESULT_ERROR && (attempt !== undefined || (analysis?.latestAttempt === undefined && analysis?.conversationId === run.conversationId))) {
        try {
          const detail = await deps.currentDetail(run.conversationId)
          const next: WetrackAnalysisRun = {
            ...run, status: detail.conversation.busy ? 'running' : detail.error ? 'failed' : 'completed',
            outcome: attempt?.status ?? analysis?.status,
            ...(attempt?.blockedReason === undefined ? {} : { blockedReason: attempt.blockedReason }),
            updatedAt: Math.max(Date.now(), run.updatedAt + 1),
          }
          if (!detail.conversation.busy && detail.error) next.error = safeFailure(detail.error)
          else delete next.error
          return saveRun(deps.dataDir, next, run)
        } catch {
          return run
        }
      }
      return run
    }
    const next = { ...run }
    try {
      const detail = await deps.currentDetail(run.conversationId)
      const analysis = await readWetrackAnalysis(deps.dataDir, run.defectNumber)
      const attempt = attemptForConversation(analysis, run.conversationId)
      if (attempt !== undefined || (analysis?.latestAttempt === undefined && analysis?.conversationId === run.conversationId)) {
        next.status = detail.conversation.busy ? 'running' : detail.error ? 'failed' : 'completed'
        next.outcome = attempt?.status ?? analysis?.status
        if (attempt?.blockedReason === undefined) delete next.blockedReason
        else next.blockedReason = attempt.blockedReason
        if (!detail.conversation.busy && detail.error) next.error = safeFailure(detail.error)
        else delete next.error
      } else if (run.status === 'queued' && !observed.has(`${run.defectNumber}:${run.conversationId}`)) {
        next.status = 'queued'
      } else if (detail.conversation.busy) {
        next.status = 'running'
      } else if (detail.error) {
        next.status = 'failed'
        next.error = safeFailure(detail.error)
      } else {
        next.status = 'failed'
        next.error = (analysis?.revision ?? 0) > (analysis?.attempts?.length ?? 0) ? UNCERTAIN_RESULT_ERROR : MISSING_RESULT_ERROR
      }
    } catch (error) {
      next.status = 'failed'
      next.error = safeFailure(error)
    }
    if (next.status === run.status && next.error === run.error && next.outcome === run.outcome && next.blockedReason === run.blockedReason) return run
    next.updatedAt = Math.max(Date.now(), run.updatedAt + 1)
    return saveRun(deps.dataDir, next, run)
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
        run = { ...run, conversationId: detail.conversation.id, updatedAt: Math.max(Date.now(), run.updatedAt + 1) }
        await saveRun(deps.dataDir, run)
        await deps.submit(detail.conversation.id, {
          text: wetrackAnalysisRunPrompt(defectNumber), requestId: `wetrack-analysis:${run.createdAt}`, whenBusy: 'reject',
        })
        observed.add(`${defectNumber}:${detail.conversation.id}`)
        run = await saveRun(deps.dataDir, { ...run, status: 'running', updatedAt: Math.max(Date.now(), run.updatedAt + 1) }, run)
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
        }, current)
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
        ...refreshed, status: 'interrupted', error: '服务在分析期间重新启动，请打开会话确认或重新分析。', updatedAt: Math.max(Date.now(), refreshed.updatedAt + 1),
      }, refreshed)
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
