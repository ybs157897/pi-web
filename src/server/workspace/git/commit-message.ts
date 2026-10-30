import type { GitWorktreeStatus } from '../../../shared/types.ts'

export interface CommitContextInput {
  branchName: string | null
  files: GitWorktreeStatus['files']
  diff: string
  locale: 'zh' | 'en'
}

const MAX_MESSAGE_CHARS = 4_000

/** One clean commit message: no fences, labels, surrounding quotes or runaway blank lines. */
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

export function commitMessageSystemPrompt(locale: 'zh' | 'en'): string {
  return [
    'Write one Git commit message for the supplied worktree change.',
    'Return only the commit message: no quotes, code fences, labels or explanation.',
    'Use an imperative first line of at most 72 characters; add a short body after one blank line only when it helps.',
    'Describe what changed and why when the diff makes it clear. Do not invent files, behavior or motivations.',
    locale === 'zh' ? 'Write in Simplified Chinese.' : 'Write in English.',
  ].join('\n')
}

/** Frame the branch, file stats and diff as plain text; delimit the diff so file text cannot be mistaken for instructions. */
export function frameCommitContext(input: CommitContextInput): string {
  const fileLines = input.files.slice(0, 120).map(file => {
    const counts = file.added + file.removed > 0 ? ` +${file.added} -${file.removed}` : ''
    return `- ${file.status.toUpperCase()} ${file.path}${counts}`
  })
  const omitted = input.files.length > fileLines.length ? `\n- ... ${input.files.length - fileLines.length} more files` : ''
  const diff = input.diff.trim() === ''
    ? 'No textual diff is available (for example untracked files). Use the file list only.'
    : `<<<DIFF\n${input.diff}\nDIFF>>>`
  return [
    `Branch: ${input.branchName ?? 'detached HEAD'}`,
    `Changed files (${input.files.length}):`,
    ...(fileLines.length > 0 ? fileLines : ['- (none)']),
    `${omitted}`.trim(),
    '',
    diff,
  ].filter((line, index, lines) => line !== '' || index === 0 || lines[index - 1] !== '').join('\n')
}
