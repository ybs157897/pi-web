import { describe, expect, it } from 'vitest'
import type { FileArtifact } from '../src/shared/types.ts'
import { fileStats, formatFileStats } from '../src/web/file-stats.ts'

/**
 * 构造一条文件工件记录，默认 kind=edit、path=a.ts。
 * @param overrides 需要覆盖的字段（kind/path/before/after）
 * @returns 完整的 FileArtifact
 */
function artifact(overrides: Partial<FileArtifact>): FileArtifact {
  return { kind: 'edit', path: 'a.ts', ...overrides }
}

/**
 * 文件增删行数统计（fileStats）测试。
 *
 * 关键契约：
 * - 多条工件取第一条 before 与最后一条 after 做整体 diff；
 * - 新文件（write、无 before）全部计为新增；
 * - read 工件与其他路径的工件不计入；
 * - 整个运行没有内容快照时放弃统计返回 undefined；
 * - formatFileStats 用真实减号渲染「+n −m」，无变化时不输出。
 */
describe('fileStats', () => {
  // 首条 before（a\nb\n）对末条 after（a\nB\nc\n）做整体 diff：b→B 加新增 c，即 +2/−1，而不是逐条求和。
  it('diffs the first before against the last after', () => {
    expect(fileStats([
      artifact({ before: 'a\nb\n', after: 'a\nB\n' }),
      artifact({ before: 'a\nB\n', after: 'a\nB\nc\n' }),
    ], 'a.ts')).toEqual({ added: 2, removed: 1 })
  })

  // write 且无 before 的新文件：全部行计为新增（+2/−0），没有删除。
  it('counts a new file as additions only', () => {
    expect(fileStats([artifact({ kind: 'write', after: 'x\ny\n' })], 'a.ts')).toEqual({ added: 2, removed: 0 })
  })

  // read 工件与其他路径的工件都不计入目标文件的统计，返回 undefined。
  it('ignores reads and other paths', () => {
    expect(fileStats([artifact({ kind: 'read', after: 'x' })], 'a.ts')).toBeUndefined()
    expect(fileStats([artifact({ path: 'b.ts', after: 'x' })], 'a.ts')).toBeUndefined()
  })

  // 工件既没有 before 也没有 after（运行未记录内容）时放弃统计，返回 undefined 而不是 0/0。
  it('gives up when the run recorded no content', () => {
    expect(fileStats([artifact({})], 'a.ts')).toBeUndefined()
  })
})

/** formatFileStats 契约：加减行数的展示形式与静默规则。 */
describe('formatFileStats', () => {
  // 输出形如 +12 −3，删除数使用真实减号（U+2212）而非连字符。
  it('renders the two numbers with a real minus sign', () => {
    expect(formatFileStats({ added: 12, removed: 3 })).toBe('+12 −3')
  })

  // 零变化（+0 −0）与没有统计值时都保持安静，不输出任何文本。
  it('stays quiet when nothing changed', () => {
    expect(formatFileStats({ added: 0, removed: 0 })).toBeUndefined()
    expect(formatFileStats(undefined)).toBeUndefined()
  })
})
