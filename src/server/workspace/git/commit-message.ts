import type { GitWorktreeStatus } from '../../../shared/types.ts'

/** 生成提交说明所需的上下文输入：分支、改动文件、文本差异与语言。 */
export interface CommitContextInput {
  branchName: string | null
  files: GitWorktreeStatus['files']
  diff: string
  locale: 'zh' | 'en'
}

const MAX_MESSAGE_CHARS = 4_000

/** 清洗出一条干净的提交说明：去掉代码围栏、标签前缀、首尾引号与失控的连续空行。 */
export function normalizeCommitMessage(input: string): string {
  let text = input.replace(/\r\n?/gu, '\n').trim()
  text = text.replace(/^```[a-zA-Z]*\n?/u, '').replace(/\n?```$/u, '').trim()
  text = text.replace(/^(?:commit message|提交信息|提交消息)\s*[:：]\s*/iu, '').trim()
  const lines = text.split('\n')
  if (lines[0] !== undefined) {
    lines[0] = lines[0].replace(/^["'`]+|["'`]+$/gu, '').trim()
  }
  text = lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
  return text.slice(0, MAX_MESSAGE_CHARS)
}

/** 提交说明生成的系统提示词：祈使句首行 ≤ 72 字符、只返回说明本身、按 locale 定语言。 */
export function commitMessageSystemPrompt(locale: 'zh' | 'en'): string {
  return [
    '为提供的工作区改动编写一条 Git 提交说明。',
    '仅返回提交说明，不加引号、代码围栏、标签或解释。',
    '首行使用祈使句，最多 72 字符；只有确有帮助时，才空一行后添加简短正文。',
    '差异能明确说明时，描述改了什么以及原因。不要虚构文件、行为或动机。',
    locale === 'zh' ? '使用简体中文。' : '使用英文。',
  ].join('\n')
}

/** 把分支、文件统计与差异拼成纯文本上下文；差异用 `<<<DIFF…DIFF>>>` 包住，文件文本不会被误当成指令。 */
export function frameCommitContext(input: CommitContextInput): string {
  const fileLines = input.files.slice(0, 120).map(file => {
    const counts = file.added + file.removed > 0 ? ` +${file.added} -${file.removed}` : ''
    return `- ${file.status.toUpperCase()} ${file.path}${counts}`
  })
  const omitted = input.files.length > fileLines.length ? `\n- ……另有 ${input.files.length - fileLines.length} 个文件` : ''
  const diff = input.diff.trim() === ''
    ? '没有可用的文本差异（例如未跟踪文件）。仅根据文件列表编写。'
    : `<<<DIFF\n${input.diff}\nDIFF>>>`
  return [
    `分支：${input.branchName ?? 'detached HEAD'}`,
    `改动文件（${input.files.length}）：`,
    ...(fileLines.length > 0 ? fileLines : ['- (none)']),
    `${omitted}`.trim(),
    '',
    diff,
  ].filter((line, index, lines) => line !== '' || index === 0 || lines[index - 1] !== '').join('\n')
}
