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

function artifact(overrides: Partial<FileArtifact>): FileArtifact {
  return { kind: 'write', path: 'a.ts', ...overrides }
}

describe('collectChangeFiles', () => {
  it('sorts the rows by path like the DSH recorder does', () => {
    const files = collectChangeFiles([
      artifact({ path: 'docs/c.md', after: 'c\n' }),
      artifact({ path: 'docs/a.md', after: 'a\n' }),
      artifact({ path: 'docs/b.md', after: 'b\n' }),
    ])
    expect(files.map(file => file.path)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
  })

  it('folds a write followed by edits into one row with the first before and last after', () => {
    const files = collectChangeFiles([
      artifact({ path: 'a.ts', before: undefined, after: 'x\ny\n' }),
      artifact({ kind: 'edit', path: 'a.ts', before: 'x\ny\n', after: 'x\nY\nz\n' }),
    ])
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'a.ts', name: 'a.ts', added: 3, deleted: 0, before: undefined, after: 'x\nY\nz\n' })
  })

  it('ignores reads and artifacts without content', () => {
    const files = collectChangeFiles([
      artifact({ kind: 'read', path: 'a.ts', after: 'x' }),
      artifact({ path: 'b.ts' }),
      artifact({ path: 'c.ts', after: 'c\n' }),
    ])
    expect(files.map(file => file.path)).toEqual(['c.ts'])
  })
})
