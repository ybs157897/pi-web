import { describe, expect, it } from 'vitest'
import { wetrackAnalysisRunPrompt } from '../src/server/automation/wetrack-analysis-runs.ts'
import { wetrackDailyCoordinatorPrompt } from '../src/server/automation/wetrack-daily.ts'
import { analysisProcedure } from '../src/server/automation/analysis-procedure.ts'

/**
 * 分析规程提示词测试。
 *
 * 验证自动化分析提示词的关键契约：单缺陷分析（wetrackAnalysisRunPrompt）与每日协调器
 * （wetrackDailyCoordinatorPrompt）必须共享同一组检索纪律规则（SHARED_RULES），差异只在
 * 委托策略——前者第 4 轮必须派发 subagent，后者把规程原样交给 worker、自身不再派生。
 * analysisProcedure 按 delegate / own 两种模式生成这段共享规程文本。
 */

/** 决定分析速度与质量的共享检索纪律规则，两种提示词变体都必须完整携带。 */
const SHARED_RULES = [
  '每次 `grep` 都要带 `path` 或 `include` 限定范围',
  '禁止对仓库根 `.` 做中文自然语言的宽匹配',
  '优先用精确标识符检索',
  '禁止逐模块横扫式 `grep`',
  '工具检索轮次最多 3 轮',
  '不得用 `...` 省略',
  '`wetrack_analysis_save`',
]

/** 分析规程契约：共享规则在两个变体中保持一致，委托策略各不相同。 */
describe('analysis procedure', () => {
  // 单缺陷分析流程必须携带全部共享规则，并包含第 4 轮派发 subagent（agent_type: "Explore"）的委托步骤。
  it('gives the single-defect flow the shared rules plus its delegation step', () => {
    const prompt = wetrackAnalysisRunPrompt('DTS006763701')
    for (const rule of SHARED_RULES) expect(prompt).toContain(rule)
    expect(prompt).toContain('第 4 轮必须派发')
    expect(prompt).toContain('`subagent` 调用（`agent_type: "Explore"`）')
  })

  // 每日协调器把同一组规则下发给 worker：自身不再要求二次派发，证据链由 worker 自行闭合。
  it('hands the same rules to the nightly automation\'s workers', () => {
    const coordinator = wetrackDailyCoordinatorPrompt()
    for (const rule of SHARED_RULES) expect(coordinator).toContain(rule)
    // 协调器委托给 worker，因此自身不得再要求一轮委托；证据链由 worker 自行闭合。
    expect(coordinator).not.toContain('第 4 轮必须派发')
    expect(coordinator).toContain('原样带上下面这段调研规程')
    expect(coordinator).toContain('不再派生子 Agent')
  })

  // 两个变体必须可区分：delegate 含派发步骤、own 强调自己做证据核对，但共享规则两者都必须完整保留。
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
