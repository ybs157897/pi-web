import { describe, expect, it } from 'vitest'
import type { FileArtifact } from '../src/shared/types.ts'
import { fileStats, formatFileStats } from '../src/web/file-stats.ts'

function artifact(overrides: Partial<FileArtifact>): FileArtifact {
  return { kind: 'edit', path: 'a.ts', ...overrides }
}

describe('fileStats', () => {
  it('diffs the first before against the last after', () => {
    expect(fileStats([
      artifact({ before: 'a\nb\n', after: 'a\nB\n' }),
      artifact({ before: 'a\nB\n', after: 'a\nB\nc\n' }),
    ], 'a.ts')).toEqual({ added: 2, removed: 1 })
  })

  it('counts a new file as additions only', () => {
    expect(fileStats([artifact({ kind: 'write', after: 'x\ny\n' })], 'a.ts')).toEqual({ added: 2, removed: 0 })
  })

  it('ignores reads and other paths', () => {
    expect(fileStats([artifact({ kind: 'read', after: 'x' })], 'a.ts')).toBeUndefined()
    expect(fileStats([artifact({ path: 'b.ts', after: 'x' })], 'a.ts')).toBeUndefined()
  })

  it('gives up when the run recorded no content', () => {
    expect(fileStats([artifact({})], 'a.ts')).toBeUndefined()
  })
})

describe('formatFileStats', () => {
  it('renders the two numbers with a real minus sign', () => {
    expect(formatFileStats({ added: 12, removed: 3 })).toBe('+12 −3')
  })

  it('stays quiet when nothing changed', () => {
    expect(formatFileStats({ added: 0, removed: 0 })).toBeUndefined()
    expect(formatFileStats(undefined)).toBeUndefined()
  })
})
