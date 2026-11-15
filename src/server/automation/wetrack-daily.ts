/**
 * 内置的 WeTrack 问题分析任务。
 *
 * 运营者要求每晚分析一次问题清单：每个缺陷交给独立的智能体，主会话只做协调。
 * 本模块持有任务的标识、日程与协调提示词；调度与运行历史归 automations 服务。
 *
 * 任务只开通一次：数据目录里的标记文件记录「已创建过」，运营者删除后重启
 * 也不会自动恢复。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { systemTimeZone } from '../../shared/automation-timing.ts'
import { analysisProcedure } from './analysis-procedure.ts'

/** 在自动化列表中标识该任务的 key。 */
export const WETRACK_DAILY_AUTOMATION_KEY = 'wetrack-analysis-daily'
/**
 * 每天午夜一次，按机器所在时区。DTSTART 固定锚在过去的 2000-01-01，规则文本
 * 因此跨天不变（只有时区可能变）；`FREQ=DAILY` 的发生序列总是从 now 之后的
 * 第一个午夜起算。
 */
export const WETRACK_DAILY_RRULE = `DTSTART;TZID=${systemTimeZone()}:20000101T000000\nRRULE:FREQ=DAILY`
/** 「运营者已创建过该任务」标记文件的存放路径（相对数据目录）。 */
export const WETRACK_DAILY_MARKER = 'wetrack/daily-automation.json'

/**
 * 功能：生成协调会话提示词。
 *
 * 主会话只读清单、把每个缺陷委派给子 Agent、汇报返回结果——自己不读代码。
 * 措辞有讲究：早期版本让模型「委派前先做几次定向检索」，结果模型自己搜了
 * 二十轮才派发。现在明确「只做调度与监控」。
 * @returns 多行拼接的协调提示词，内嵌 analysisProcedure('own') 规程要求子 Agent 原样执行
 */
export function wetrackDailyCoordinatorPrompt(): string {
  return [
    '你是「问题清单每日分析」的协调会话。主会话只做调度与监控：把问题清单里的每一个缺陷交给子 Agent 分析，你自己不读代码、不下结论。',
    '',
    '1. 调用 `wetrack_analysis_list` 获取待处理缺陷清单（编号 + 标题）。按返回的 nextOffset 逐页读取，直到末页；工具报错时报告失败，不得说清单为空。全部页为空才报告「今日没有待处理的缺陷」。',
    '2. 第 2 轮起逐批派发子 Agent。在同一轮里把互不依赖的缺陷合并成一个批次（一个缺陷一个 `subagent` 调用，`agent_type: "general-purpose"`），每批最多 6 个；一批返回后再派下一批，直到清单派完。',
    '3. 每个子 Agent 的任务必须自包含，并且**原样带上下面这段调研规程**（不要改写、不要删减、不要替它做总结）：',
    '',
    analysisProcedure('own'),
    '',
    '4. 任务里还要写清：缺陷编号、标题、现象、只读约束（禁止修改任何文件、禁止 git 操作、禁止提交或推送）、以及要返回什么（结论摘要 + 关键证据链接 + 未证实的缺口）。',
    '5. 子 Agent 自己完成全部工作：它调用 `wetrack_analysis_detail` 读详情、在绑定工作区里检索代码和调用链、给出带证据的结论、调用 `wetrack_analysis_save` 保存。它不需要你参与，也不要把详情或代码贴进任务里。',
    '6. 全部派发完成后汇总一份清单：每个缺陷的编号、状态（已保存 / 失败）、失败原因与子 Agent 的要点。不要在主会话里重做分析，也不要替缺陷补写结论。',
    '7. 结论质量优先于速度：证据不足的缺陷让子 Agent 标 blocked 并说明缺什么，不要编造结论。',
  ].join('\n')
}

/**
 * 功能：检查任务是否已开通过。
 * @returns 标记文件存在且 provisioned === true 时为 true；文件缺失或损坏视为未开通
 */
export async function wetrackDailyProvisioned(dataDir: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, WETRACK_DAILY_MARKER), 'utf8')) as { provisioned?: unknown }
    return raw.provisioned === true
  } catch {
    return false
  }
}

/** 写入「已开通」标记，确保运营者删除任务后重启不会自动恢复。 */
export async function markWetrackDailyProvisioned(dataDir: string): Promise<void> {
  const target = join(dataDir, WETRACK_DAILY_MARKER)
  await mkdir(join(dataDir, 'wetrack'), { recursive: true, mode: 0o700 })
  await writeFile(target, `${JSON.stringify({ provisioned: true })}\n`, { encoding: 'utf8', mode: 0o600 })
}
