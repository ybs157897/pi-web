import { describe, expect, it } from 'vitest'
import { wetrackAnalysisRunPrompt } from '../src/server/automation/wetrack-analysis-runs.ts'
import { wetrackDailyCoordinatorPrompt } from '../src/server/automation/wetrack-daily.ts'
import { analysisProcedure } from '../src/server/automation/analysis-procedure.ts'

/** The rules that decide how fast and how well an analysis runs. */
const SHARED_RULES = [
  '每次 `grep` 都要带 `path` 或 `include` 限定范围',
  '禁止对仓库根 `.` 做中文自然语言的宽匹配',
  '优先用精确标识符检索',
  '禁止逐模块横扫式 `grep`',
  '工具检索轮次最多 3 轮',
  '不得用 `...` 省略',
  '`wetrack_analysis_save`',
]

describe('analysis procedure', () => {
  it('gives the single-defect flow the shared rules plus its delegation step', () => {
    const prompt = wetrackAnalysisRunPrompt('DTS006763701')
    for (const rule of SHARED_RULES) expect(prompt).toContain(rule)
    expect(prompt).toContain('第 4 轮必须派发')
    expect(prompt).toContain('`subagent` 调用（`agent_type: "Explore"`）')
  })

  it('hands the same rules to the nightly automation\'s workers', () => {
    const coordinator = wetrackDailyCoordinatorPrompt()
    for (const rule of SHARED_RULES) expect(coordinator).toContain(rule)
    // The coordinator delegates to workers, so it must not demand a second
    // delegation round of its own; the worker closes the evidence chains itself.
    expect(coordinator).not.toContain('第 4 轮必须派发')
    expect(coordinator).toContain('原样带上下面这段调研规程')
    expect(coordinator).toContain('不再派生子 Agent')
  })

  it('keeps the two variants apart', () => {
    expect(analysisProcedure('delegate')).toContain('第 4 轮必须派发')
    expect(analysisProcedure('own')).not.toContain('第 4 轮必须派发')
    expect(analysisProcedure('own')).toContain('自己做证据核对')
    for (const rule of SHARED_RULES) {
      expect(analysisProcedure('own')).toContain(rule)
      expect(analysisProcedure('delegate')).toContain(rule)
    }
  })
})
