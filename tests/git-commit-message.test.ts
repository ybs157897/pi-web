import { describe, expect, it } from 'vitest'
import { commitMessageSystemPrompt, frameCommitContext, normalizeCommitMessage } from '../src/server/workspace/git/commit-message.ts'

describe('commit message helpers', () => {
  it('removes fences, labels and surrounding quotes from the model answer', () => {
    expect(normalizeCommitMessage('```text\n"Add the status panel"\n```')).toBe('Add the status panel')
    expect(normalizeCommitMessage('提交信息：修复 Git 状态卡')).toBe('修复 Git 状态卡')
    expect(normalizeCommitMessage('  `Wire commit and push`  ')).toBe('Wire commit and push')
    expect(normalizeCommitMessage('Add X\n\n\n\nBody')).toBe('Add X\n\nBody')
  })

  it('frames the branch, file list and diff with explicit delimiters', () => {
    const framed = frameCommitContext({
      branchName: 'main',
      locale: 'en',
      files: [{ path: 'src/a.ts', status: 'modified', added: 2, removed: 1 }],
      diff: '- old\n+ new',
    })
    expect(framed).toContain('Branch: main')
    expect(framed).toContain('MODIFIED src/a.ts +2 -1')
    expect(framed).toContain('<<<DIFF\n- old\n+ new\nDIFF>>>')
  })

  it('explains an empty diff and caps the file list at 120 rows', () => {
    const files = Array.from({ length: 130 }, (_, index) => ({
      path: `file-${index}.ts`, status: 'modified' as const, added: 1, removed: 0,
    }))
    const framed = frameCommitContext({ branchName: null, files, diff: '', locale: 'zh' })
    expect(framed).toContain('detached HEAD')
    expect(framed).toContain('10 more files')
    expect(framed).toContain('No textual diff is available')
    expect(commitMessageSystemPrompt('zh')).toContain('Write in Simplified Chinese')
    expect(commitMessageSystemPrompt('en')).toContain('Write in English')
  })
})
