/**
 * The procedure every agent follows when it owns a defect's analysis.
 *
 * Two roles use it. The single-defect flow hands the agent the whole defect and
 * lets it delegate the two evidence chains to `Explore` subagents; the nightly
 * automation's workers each own one defect outright and must do the work
 * themselves. The parts that decide how fast and how well the analysis runs —
 * the search budget, the grep discipline, the evidence format — are the same in
 * both roles, so they live here instead of being restated per prompt.
 *
 * Measured on DTS006763701: the discipline cut a single analysis from a
 * 284s median to 115s. Workers that never saw it ran 35 to 153 rounds on the
 * same kind of defect.
 */

/** Who the agent may delegate the evidence gathering to. */
export type AnalysisVariant = 'delegate' | 'own'

const SEARCH_BUDGET = '你的工具检索轮次最多 3 轮（第 1 轮计入）'

const SEARCH_RULES = [
  '- 每次 `grep` 都要带 `path` 或 `include` 限定范围；禁止对仓库根 `.` 做中文自然语言的宽匹配',
  '- 优先用精确标识符检索——枚举名、常量名、方法名的英文形式。中文功能名可按仓库命名习惯直接转写猜测（例如「移交并分享同意」→ `SITE_DELIVER_AND_SHARE_AGREE`），猜错就换写法，不要改用中文泛搜',
  '- 禁止逐模块横扫式 `grep`；一次检索命中多个模块时，只读最相关的 1–2 个',
  '- 同一个路径不要重复 `list_files`',
  '第 3 轮结束时，手上必须已有 1–2 个候选文件路径和一个待验证的根因假设。',
].join('\n')

const EVIDENCE_RULES = [
  '结论必须有代码证据，关键位置用 `path:line` 引用；证据不足时明确说明缺失的信息，不要猜测。修复建议围绕已证实的根因，不把其他潜在问题扩展成额外调研。',
  '每条关键证据写成 Markdown 链接 `[文件名.java:175](完整/仓库/相对/路径.java#L175-L178)`——链接里的路径以及正文里提到的任何路径都必须完整写出，不得用 `...` 省略，页面按这个格式渲染可跳转的证据。',
].join('\n')

const SAVE_RULES = '完成后必须调用 `wetrack_analysis_save`，将最终分析正文放入 markdown，给出 title、简短 summary；结论可靠时 status 使用 analyzed，确实无法定位时使用 blocked。正文包含根因、代码证据和修复建议，不要只记录工具调用过程。'

/**
 * The shared procedure, as numbered rules.
 *
 * `delegate` adds the subagent hand-off; `own` replaces it with the same two
 * evidence chains the agent has to close by itself, under the same budget.
 */
export function analysisProcedure(variant: AnalysisVariant): string {
  const rules: string[] = [
    '1. 第 1 轮：在同一轮里调用 `wetrack_analysis_detail` 读取本次缺陷、`wetrack_analysis_get` 读取已有结论作为定位线索、`list_files` 读取仓库顶层模块。已有报告只用于提供候选入口，不要求逐条复核其全部引用或重写整份报告。',
    variant === 'delegate'
      ? `2. 定位候选文件：在发出第一次 \`subagent\` 调用之前，${SEARCH_BUDGET}，第 4 轮必须派发。这几轮必须遵守：\n${SEARCH_RULES}`
      : `2. 定位候选文件：${SEARCH_BUDGET}。这几轮必须遵守：\n${SEARCH_RULES}`,
  ]
  if (variant === 'delegate') {
    rules.push([
      '3. 立即派发：第 4 轮在同一轮发出两个 `subagent` 调用（`agent_type: "Explore"`），A 核对操作入口及直接调用链，B 核对数据读写、通知或展示链路。任务里写清缺陷编号、现象、预期结果、已定位的文件路径、待验证的假设和只读约束。不要为了补齐背景继续预研而推迟分派——派发本身就是最快的检索方式。已经能闭环的简单问题直接完成，不为并行而并行。',
      '4. 子 Agent 是定向证据核对者，不负责重新做一份完整分析。每个子任务只回答一个必要问题，限定到已定位的文件或方法；grep、glob、read、list_files 等检索读取动作合计不超过 8 次，达到上限就返回未证实缺口，不能改用其他工具绕过。不得扩展到其他服务、相似缺陷或新假设。给出完整的仓库相对路径，禁止用 `...` 省略路径；不要求子 Agent 重查已知入口或缺陷详情。子 Agent 不继承本会话消息或 Skill 正文，因此任务中须包含缺陷编号、必要事实、范围和只读约束。',
      '5. 子 Agent 只返回该问题的精炼结论、必要 `path:line` 证据和未证实缺口，不写最终分析记录，也不再派生子 Agent。证据足够就立即返回；无法证实时报告缺口，不要为了排除所有可能继续搜索。',
      '6. 主 Agent 负责归因。子 Agent 返回后最多再补查 1 轮，然后立即整理报告并调用 `wetrack_analysis_save`。只有结论直接冲突或影响根因成立的缺口才补查；不得为补齐背景、相似分支、精确行号或排除所有假设继续搜索。其他缓存、客户端、外部中台等未证实因素列为“未覆盖/需确认”。证据闭环后立即整理报告并保存，不重复完整调研。',
    ].join('\n\n'))
  } else {
    rules.push([
      '3. 自己做证据核对，不再派生子 Agent：完成两条独立证据链——A 操作入口与直接调用链，B 数据读写、通知或展示链路。每条链路的检索读取动作合计不超过 8 次，达到上限就返回未证实缺口，不能换工具绕过。不得扩展到其他服务、相似缺陷或新假设。只回答这一个缺陷，不要顺手分析别的缺陷。',
    ].join('\n'))
  }
  rules.push(EVIDENCE_RULES)
  rules.push(SAVE_RULES)
  return rules.join('\n\n')
}
