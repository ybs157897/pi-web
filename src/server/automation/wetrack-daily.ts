/**
 * The built-in WeTrack issue analysis task.
 *
 * The operator asked for the issue list to be analysed every night, with each defect
 * handed to its own agent and the main conversation acting only as a coordinator. This
 * module owns the task's identity, its schedule and the coordinator prompt; the
 * automations service owns the scheduling and the run history.
 *
 * The task is provisioned once: a marker file in the data directory records that it was
 * created, so an operator who deletes it does not get it back on the next restart.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AutomationSchedule } from '../../shared/types.ts'
import { analysisProcedure } from './analysis-procedure.ts'

/** Marks the task in the automations list. */
export const WETRACK_DAILY_AUTOMATION_KEY = 'wetrack-analysis-daily'
/** Every night at midnight, in local time. */
export const WETRACK_DAILY_SCHEDULE: AutomationSchedule = { unit: 'day', timeOfDay: '00:00' }
/** Where the "the operator created this once" marker lives. */
export const WETRACK_DAILY_MARKER = 'wetrack/daily-automation.json'

/**
 * The coordinator prompt.
 *
 * The main conversation reads the list, delegates every defect to a subagent and only
 * reports what came back — it never reads the code itself. The wording matters: an
 * earlier prompt asked for "a few directed searches" before delegating, and the model
 * spent twenty rounds searching on its own before it ever dispatched anything.
 */
export function wetrackDailyCoordinatorPrompt(): string {
  return [
    '你是「问题清单每日分析」的协调会话。主会话只做调度与监控：把问题清单里的每一个缺陷交给子 Agent 分析，你自己不读代码、不下结论。',
    '',
    '1. 第 1 轮调用 `wetrack_analysis_list` 拿到待分析缺陷清单（编号 + 标题）。清单为空就报告「今日没有待分析的缺陷」并结束，不要再调用别的工具。',
    '2. 第 2 轮起逐批派发子 Agent。在同一轮里把互不依赖的缺陷合并成一个批次（一个缺陷一个 `subagent` 调用，`agent_type: "general-purpose"`），每批最多 6 个；一批返回后再派下一批，直到清单派完。',
    '3. 每个子 Agent 的任务必须自包含，并且**原样带上下面这段调研规程**（不要改写、不要删减、不要替它做总结）：',
    '',
    analysisProcedure('own'),
    '',
    '4. 任务里还要写清：缺陷编号、标题、现象、只读约束（禁止修改任何文件、禁止 git 操作、禁止提交或推送）、以及要返回什么（结论摘要 + 关键 `path:line` 证据 + 未证实的缺口）。',
    '5. 子 Agent 自己完成全部工作：它调用 `wetrack_analysis_detail` 读详情、在绑定工作区里检索代码和调用链、给出带证据的结论、调用 `wetrack_analysis_save` 保存。它不需要你参与，也不要把详情或代码贴进任务里。',
    '6. 全部派发完成后汇总一份清单：每个缺陷的编号、状态（已保存 / 失败）、失败原因与子 Agent 的要点。不要在主会话里重做分析，也不要替缺陷补写结论。',
    '7. 结论质量优先于速度：证据不足的缺陷让子 Agent 标 blocked 并说明缺什么，不要编造结论。',
  ].join('\n')
}

/** Whether the operator has already had this task provisioned once. */
export async function wetrackDailyProvisioned(dataDir: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, WETRACK_DAILY_MARKER), 'utf8')) as { provisioned?: unknown }
    return raw.provisioned === true
  } catch {
    return false
  }
}

/** Records that the task was provisioned, so a deletion is not undone by a restart. */
export async function markWetrackDailyProvisioned(dataDir: string): Promise<void> {
  const target = join(dataDir, WETRACK_DAILY_MARKER)
  await mkdir(join(dataDir, 'wetrack'), { recursive: true, mode: 0o700 })
  await writeFile(target, `${JSON.stringify({ provisioned: true })}\n`, { encoding: 'utf8', mode: 0o600 })
}
