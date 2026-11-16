import { describe, expect, it } from 'vitest'
import { commitMessageSystemPrompt, frameCommitContext, normalizeCommitMessage } from '../src/server/workspace/git/commit-message.ts'

/**
 * Git 提交信息辅助函数测试。
 *
 * 关键契约：
 * - normalizeCommitMessage 清洗模型回答：剥掉代码围栏、中英文标签前缀、包裹引号/反引号、首尾空白，
 *   并把多余空行压缩成一个空行（保留标题与正文的分隔）；
 * - frameCommitContext 用显式定界符（<<<DIFF...DIFF>>>）包住 diff，列出分支与文件统计行；
 * - 空 diff 有专门文案；文件列表封顶 120 行并提示剩余数量；系统提示按 locale 要求输出语言。
 */
describe('commit message helpers', () => {
  // 模型回答的包装物全部剥掉：```text 围栏 + 引号、中文「提交信息：」前缀、反引号与首尾空白；连续多空行压缩为一行。
  it('removes fences, labels and surrounding quotes from the model answer', () => {
    expect(normalizeCommitMessage('```text\n"Add the status panel"\n```')).toBe('Add the status panel')
    expect(normalizeCommitMessage('提交信息：修复 Git 状态卡')).toBe('修复 Git 状态卡')
    expect(normalizeCommitMessage('  `Wire commit and push`  ')).toBe('Wire commit and push')
    expect(normalizeCommitMessage('Add X\n\n\n\nBody')).toBe('Add X\n\nBody')
  })

  // 上下文框架必须包含中文「分支：」行、带增删统计的文件行（MODIFIED src/a.ts +2 -1），diff 用显式定界符包住防止歧义。
  it('frames the branch, file list and diff with explicit delimiters', () => {
    const framed = frameCommitContext({
      branchName: 'main',
      locale: 'en',
      files: [{ path: 'src/a.ts', status: 'modified', added: 2, removed: 1, staged: false }],
      diff: '- old\n+ new',
    })
    expect(framed).toContain('分支：main')
    expect(framed).toContain('MODIFIED src/a.ts +2 -1')
    expect(framed).toContain('<<<DIFF\n- old\n+ new\nDIFF>>>')
  })

  // 分支为 null 时写 detached HEAD；130 个文件只列 120 行并提示「另有 10 个文件」；空 diff 提示没有文本差异；系统提示按 locale 指定输出语言。
  it('explains an empty diff and caps the file list at 120 rows', () => {
    const files = Array.from({ length: 130 }, (_, index) => ({
      path: `file-${index}.ts`, status: 'modified' as const, added: 1, removed: 0, staged: false,
    }))
    const framed = frameCommitContext({ branchName: null, files, diff: '', locale: 'zh' })
    expect(framed).toContain('detached HEAD')
    expect(framed).toContain('另有 10 个文件')
    expect(framed).toContain('没有可用的文本差异')
    expect(commitMessageSystemPrompt('zh')).toContain('使用简体中文')
    expect(commitMessageSystemPrompt('en')).toContain('使用英文')
  })
})
