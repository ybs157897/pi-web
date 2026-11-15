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
 * 问题分析会话的默认思考档位，除非绑定里另行固定。
 * 实测（DTS006763701）：`max` 中位 119s、`high` 113s、`off` 75s，结论一致。
 * 默认取 `high`（保留推理痕迹且成本约为 max 的三分之一）；`off` 只为低延迟提供，不以正确性为先。
 */
export const DEFAULT_ANALYSIS_THINKING_LEVEL: ThinkingLevel = 'high'
const MISSING_RESULT_ERROR = '分析会话已结束，但没有保存该缺陷的分析结果。请打开会话查看原因后重试。'
const UNCERTAIN_RESULT_ERROR = '分析会话已结束；近期尝试记录已截断，无法确认本次是否保存结果，请打开会话查看。'

/** 从分析记录的历史尝试中倒序找指定会话发起的那次尝试；找不到时回退比对 latestAttempt。 */
function attemptForConversation(record: WetrackAnalysisRecord | undefined, conversationId: string): WetrackAnalysisAttempt | undefined {
  const history = record?.attempts
  if (history !== undefined) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.conversationId === conversationId) return history[i]
    }
  }
  return record?.latestAttempt?.conversationId === conversationId ? record.latestAttempt : undefined
}

/** 单次分析运行落盘 JSON 的 zod 校验模式；strict 模式拒绝未知字段。 */
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

/**
 * 功能：拼装发起一次缺陷分析会话时的初始提示词。
 * @param defectNumber 缺陷编号（DTS 前缀）
 * @returns 标记行 + 任务描述 + 调研规程（delegate 变体）拼接的完整提示词
 */
export function wetrackAnalysisRunPrompt(defectNumber: string): string {
  return [
    `[wetrack-analysis:${defectNumber}]`,
    `请结合当前绑定的代码工作区分析这个 bug 单：${defectNumber}。先读取缺陷详情，定位实际原因并给出有代码证据的分析；不要修改代码、提交或推送。`,
    '按任务匹配到的 Skill 规则执行只读分析；与下面的调研规程冲突时以规程为准，取数用宿主工具，结论由 wetrack_analysis_save 保存。',
    '调研按以下方式进行：',
    analysisProcedure('delegate'),
  ].join('\n\n')
}

/** 分析运行文件的存放目录：`<dataDir>/wetrack/analysis-runs`。 */
function runDir(dataDir: string): string {
  return join(dataDir, 'wetrack', 'analysis-runs')
}

/** 单个缺陷的运行文件路径；缺陷编号不合法时抛 INVALID_INPUT。 */
function runPath(dataDir: string, defectNumber: string): string {
  if (!isDefectNumber(defectNumber)) throw new RuntimeError('INVALID_INPUT', '缺陷编号不合法')
  return join(runDir(dataDir), `${defectNumber}.json`)
}

const runWrites = new Map<string, Promise<void>>()
/**
 * 功能：把一次分析运行原子落盘；同一目标文件的写入按 Map 中的前序 Promise 串行排队。
 * @param dataDir 服务端数据目录
 * @param run 要写入的运行记录
 * @param guard 可选的乐观锁基线：传入时先重读磁盘，若记录已不是该基线（createdAt/conversationId/updatedAt 任一不符）则放弃覆盖、返回磁盘上的现状
 * @returns 写入成功返回 structuredClone(run)；被并发改动抢占时返回磁盘上的最新记录（不存在则返回 run）
 * 内部逻辑：先挂起排队、await 前序写入；写入用临时文件 + wx 独占创建 + rename 原子替换，失败时清理临时文件；
 * finally 释放锁并清理 Map 中属于自己的项。
 */
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

/**
 * 功能：从磁盘读取并校验单个缺陷的运行记录。
 * @returns 校验通过的运行记录；文件不存在、JSON 损坏或 schema 不符时返回 undefined
 */
export async function readWetrackAnalysisRun(dataDir: string, defectNumber: string): Promise<WetrackAnalysisRun | undefined> {
  try {
    return runSchema.parse(JSON.parse(await readFile(runPath(dataDir, defectNumber), 'utf8')))
  } catch {
    return undefined
  }
}

/** 分析运行的运行期依赖：会话生命周期、工作区解析、模型与技能激活均由外部注入。 */
export interface WetrackAnalysisRunsDeps {
  dataDir: string
  create(input: CreateConversationInput): Promise<ConversationDetail>
  submit(id: string, input: SubmitInput): Promise<{ submissionId: string }>
  requireConversation(id: string): Promise<RuntimeConversation>
  currentDetail(id: string): Promise<ConversationDetail>
  selectedWorkspace(id: string): WorkspaceSummary
  analysisModel(): ModelRef | undefined
  /** 分析模型实际支持的思考档位，页面据此只展示真实可选项。 */
  supportedThinkingLevels?(): ThinkingLevel[]
  activateSkills(workspace: WorkspaceSummary): Promise<{ skillIds: string[] }>
}

/**
 * 功能：创建 WeTrack 缺陷分析运行的管理器（启动、列出、恢复、绑定工作区）。
 * @returns 暴露 start/list/recover/bindWorkspace/workspaceBinding/settings/drain 的门面对象
 * 内部状态：tasks 集合追踪在途的后台等待任务（drain 用）；starts 以缺陷编号去重并发启动；
 * observed 记录已确认提交过提示词的「缺陷:会话」组合，供 refresh 区分排队与无果。
 */
export function createWetrackAnalysisRuns(deps: WetrackAnalysisRunsDeps) {
  const tasks = new Set<Promise<void>>()
  const starts = new Map<string, Promise<WetrackAnalysisRun>>()
  const observed = new Set<string>()

  /**
   * 功能：对照会话当前状态与分析记录，刷新一次运行的 status/outcome/error 并落盘。
   * @param run 待刷新的运行记录
   * @param recovering 服务重启后的恢复刷新；true 时对 running/queued 也强制核对（用于标记 interrupted）
   * @returns 有变化时返回落盘后的新记录；无变化或恢复失败时原样返回
   * 内部逻辑：无会话或（非恢复且）已终态的记录走「失败但提示未保存结果」的补偿核对分支，
   * 仅当此前记录为 MISSING_RESULT_ERROR 且实际存在保存结果时纠正状态；在途记录则按
   * 会话 busy/error 与保存结果存在性推导 running/failed/completed，无果时按是否可能已
   * 截断区分 UNCERTAIN_RESULT_ERROR 与 MISSING_RESULT_ERROR；任何字段都没变就不落盘。
   */
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

  /**
   * 功能：为指定缺陷启动一次只读分析会话并跟踪其生命周期。
   * @param input 含缺陷编号；工作区与模型来自绑定和 deps
   * @returns 已登记（queued → running）的运行记录
   * 内部逻辑：同一缺陷的并发启动经 starts 去重，直接复用在途 Promise；已存在
   * running/queued 记录时先刷新确认仍活着则直接返回；否则新建记录落盘 → 创建
   * 只读会话 → 提交分析提示词 → 置 running；会话空闲后由后台任务再 refresh 一次；
   * 中途任何失败都把「本次 createdAt 匹配的」记录标记为 failed 后原样抛错。
   */
  const start = async (input: WetrackAnalysisStartInput): Promise<WetrackAnalysisRun> => {
    const defectNumber = input.defectNumber.trim()
    if (!isDefectNumber(defectNumber)) throw new RuntimeError('INVALID_INPUT', '缺陷编号不合法')
    const inFlight = starts.get(defectNumber)
    if (inFlight !== undefined) return inFlight
    const promise = (async () => {
      const binding = await workspaceBinding()
      const workspaceId = binding.workspaceId
      // 分析流程有自己的思考档位默认值：它是后台证据 hunt，运营者要等结果，
      // `high` 推理充分且成本约为 `max` 的三分之一；绑定可另行固定。
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
          // 等待空闲的失败（含 provider 故障）与「未保存结果」都由随后的 refresh 统一归因。
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

  /**
   * 功能：列出全部缺陷分析运行，逐个刷新后按 updatedAt 倒序返回。
   * @returns 运行记录数组；目录不存在时返回空数组；非法文件名直接忽略
   */
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

  /**
   * 功能：把分析运行绑定到指定共享代码工作区并激活其技能，落盘 workspace.json。
   * @param workspaceId 目标工作区 ID（必须能被 selectedWorkspace 解析，否则抛错）
   * @param thinkingLevel 可选的思考档位；缺省沿用既有绑定的档位
   * @returns 汇总后的分析设置（工作区、模型、档位、支持档位、技能 ID）
   */
  const bindWorkspace = async (workspaceId: string, thinkingLevel?: ThinkingLevel): Promise<WetrackAnalysisSettings> => {
    const workspace = deps.selectedWorkspace(workspaceId)
    const target = join(deps.dataDir, 'wetrack', 'workspace.json')
    await mkdir(join(deps.dataDir, 'wetrack'), { recursive: true, mode: 0o700 })
    // 重新绑定工作区时沿用已固定的思考档位，除非调用方显式传入。
    const level = thinkingLevel ?? (await workspaceBinding()).thinkingLevel
    const binding = { workspaceId: workspace.id, ...(level === undefined ? {} : { thinkingLevel: level }) }
    await writeFile(target, JSON.stringify(binding) + '\n', { encoding: 'utf8', mode: 0o600 })
    const skills = await deps.activateSkills(workspace)
    return { workspaceId: workspace.id, model: deps.analysisModel(), thinkingLevel: level ?? DEFAULT_ANALYSIS_THINKING_LEVEL, supportedThinkingLevels: deps.supportedThinkingLevels?.() ?? [], skillIds: skills.skillIds }
  }

  /**
   * 功能：读取当前工作区绑定（workspace.json），并校验工作区仍可解析。
   * @returns 绑定内容；文件缺失、损坏、schema 不符或工作区已不可用时返回空对象（未绑定）
   */
  const workspaceBinding = async (): Promise<{ workspaceId?: string; thinkingLevel?: ThinkingLevel }> => {
    try {
      const value = z.object({ workspaceId: z.string().min(1).max(160), thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional() }).parse(JSON.parse(await readFile(join(deps.dataDir, 'wetrack', 'workspace.json'), 'utf8')))
      deps.selectedWorkspace(value.workspaceId)
      return value
    } catch {
      return {}
    }
  }

  /**
   * 功能：服务启动时的恢复流程——把重启前仍在 running/queued 的运行收尾。
   * 内部逻辑：先对每条在途记录做恢复式 refresh，能判定结果就落盘结果；仍判不
 * 出来（会话已不在内存）则标记为 interrupted，提示用户打开会话确认或重跑。
   */
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

  /**
   * 功能：汇总当前分析设置（绑定、模型、思考档位与支持档位、已激活技能）。
   * @returns WetrackAnalysisSettings；未绑定工作区时省略 workspaceId 且技能为空
   */
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

  return { start, list, recover, bindWorkspace, workspaceBinding, settings, /** 等待全部在途后台等待任务结束（含失败），用于测试/关停时排空。 */ drain: () => Promise.allSettled([...tasks]) }
}
