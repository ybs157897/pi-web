import { describe, expect, it, vi } from 'vitest'

// 组件树会连带加载图标包的 CSS；这里只测收集逻辑，整包换成空组件。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => new Proxy({}, {
  get: (_target, key) => key === 'then' ? undefined : () => null,
  has: () => true,
  ownKeys: () => [],
  getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, writable: true, value: () => null }),
}))

import type { FileArtifact } from '../src/shared/types.ts'
import { collectChangeFiles } from '../src/web/ChangedFiles.tsx'

/**
 * 构造一条文件工件记录，默认 kind=write、path=a.ts。
 * @param overrides 需要覆盖的字段（path/kind/before/after）
 * @returns 完整的 FileArtifact
 */
function artifact(overrides: Partial<FileArtifact>): FileArtifact {
  return { kind: 'write', path: 'a.ts', ...overrides }
}

/**
 * 变更文件行收集（collectChangeFiles）测试。
 *
 * 关键契约：
 * - 行按路径排序，与 DSH 记录器的顺序一致；
 * - 同一路径的 write + 后续 edit 折叠成一行：before 取第一次的旧内容、after 取最后一次的新内容，
 *   增删行数跨整段计算；
 * - read 工件与没有内容快照的工件不产生行。
 */
describe('collectChangeFiles', () => {
  // 输出按 path 字典序排序（docs/a、b、c），与 DSH 记录器的排序行为保持一致。
  it('sorts the rows by path like the DSH recorder does', () => {
    const files = collectChangeFiles([
      artifact({ path: 'docs/c.md', after: 'c\n' }),
      artifact({ path: 'docs/a.md', after: 'a\n' }),
      artifact({ path: 'docs/b.md', after: 'b\n' }),
    ])
    expect(files.map(file => file.path)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
  })

  // write + edit 折叠成单行：added/deleted 覆盖首 before 到末 after 的整体 diff（y→Y、新增 z 共 +3/-0），before 取首条的 undefined。
  it('folds a write followed by edits into one row with the first before and last after', () => {
    const files = collectChangeFiles([
      artifact({ path: 'a.ts', before: undefined, after: 'x\ny\n' }),
      artifact({ kind: 'edit', path: 'a.ts', before: 'x\ny\n', after: 'x\nY\nz\n' }),
    ])
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'a.ts', name: 'a.ts', added: 3, deleted: 0, before: undefined, after: 'x\nY\nz\n' })
  })

  // read 工件和没有 after 内容的工件（空 write）不产生行，只有带内容快照的 c.ts 输出。
  it('ignores reads and artifacts without content', () => {
    const files = collectChangeFiles([
      artifact({ kind: 'read', path: 'a.ts', after: 'x' }),
      artifact({ path: 'b.ts' }),
      artifact({ path: 'c.ts', after: 'c\n' }),
    ])
    expect(files.map(file => file.path)).toEqual(['c.ts'])
  })
})
