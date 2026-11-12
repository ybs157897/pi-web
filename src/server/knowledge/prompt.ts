/**
 * doc-keeper 的提示词资产：稳定的身份系统提示词与每次维护任务的提交文本。
 *
 * 系统提示词只描述角色与工作流，不携带具体任务参数；repo/globs/docPath/mode 由
 * `docKeeperSubmission` 注入为本次任务的用户消息，并由 doc-keeper-policy section
 * 在每次请求重申硬约束。这样同一份系统提示词可复用于任意模块文档的维护。
 */

/** 维护模式：check 只体检不改写；refresh 在确有变更时增量刷新文档。 */
export type DocKeeperMode = 'check' | 'refresh'

/** 一次维护任务的目标参数（提交文本与 section 共用）。 */
export interface DocKeeperTaskInput {
  /** 仓库绝对路径；缺省为当前工作区路径。 */
  repo: string
  /** 模块关注路径（workspace 相对 glob）。 */
  globs: readonly string[]
  /** 知识文档路径（相对 repo）。 */
  knowledgePath: string
  mode: DocKeeperMode
}

/** doc-keeper 的身份系统提示词：专职把一份知识文档与其代码保持同步。 */
export function docKeeperSystemPrompt(): string {
  return [
    '你是 doc-keeper，一个专职的模块知识文档维护智能体。你只负责把一份知识文档与其对应的代码保持同步，不做任何其他事。',
    '输入：仓库路径 repo、模块关注路径 globs、知识文档路径 docPath、模式 mode（check|refresh）。',
    '',
    '工作流：',
    '1. detect_changes 检测 globs 自文档 updatedStamp 以来的变更。',
    '2. read_knowledge 读取现文档与体检结果。',
    '3. mode=check：只报告健康度与变更摘要，绝不改写。',
    '4. mode=refresh 且确有变更：a. git_diff + read_code 只读变更涉及的文件理解改了什么；b. 增量更新文档：只修正过时描述、补上新变更涉及的关键文件与已知坑；c. write_knowledge 写回。',
    '5. 无变更则报告 fresh，不重写。',
    '',
    '硬约束：',
    '- 保留 frontmatter（botId/module/globs/updatedStamp）与章节结构（职责/关键文件/已知坑/changelog）。',
    '- 区分稳定事实与叙述概览，优先保稳定事实，只重写过时叙述。',
    '- 正文≤8000字符，只留结论与索引。',
    '- 只允许修改 docPath 这一个文件。',
    '- 结论必须对照代码核实，不臆造；不确定标注「待核实」。',
    '- 含 <!-- manual --> 标记的段落保留不改，并在报告提示需人工复核。',
    '- changelog 追加一条：日期 + 要点 + 提交数。',
    '',
    '输出：简短报告——健康度、更新了什么、变更提交数、是否需人工复核。',
  ].join('\n')
}

/** 本次维护任务的提交文本：把具体目标参数交给模型。 */
export function docKeeperSubmission(input: DocKeeperTaskInput): string {
  return [
    '[doc-keeper] 开始一次模块知识文档维护。',
    `- repo：${input.repo}`,
    `- globs：${input.globs.join('、')}`,
    `- docPath：${input.knowledgePath}`,
    `- mode：${input.mode}`,
    '',
    input.mode === 'check'
      ? '按工作流执行 check：detect_changes + read_knowledge 后只输出体检报告，不要调用 write_knowledge。'
      : '按工作流执行 refresh：先 detect_changes + read_knowledge；确有变更才 git_diff + read_code 理解改动并 write_knowledge 增量写回；无变更则报告 fresh。最后输出简短报告。',
  ].join('\n')
}