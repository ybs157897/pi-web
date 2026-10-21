import { diffLines } from 'diff'
import type { FileArtifact } from '../shared/types.ts'

export interface FileStats {
  readonly added: number
  readonly removed: number
}

const CHANGE_KINDS = new Set<FileArtifact['kind']>(['write', 'edit', 'nativeEdit'])

/**
 * 从本轮产物算一个文件的增删行数，用于改动清单右侧的 `+N −M`。
 *
 * 模型自己写 stats 时可能漏、也可能猜；本轮真的改过这个文件时，用第一次的
 * before 和最后一次的 after 做一次行级比较，拿到的就是实际数字。拿不到返回
 * undefined，调用方退回模型给的值。
 */
export function fileStats(artifacts: readonly FileArtifact[], path: string): FileStats | undefined {
  const changes = artifacts.filter(artifact => CHANGE_KINDS.has(artifact.kind) && artifact.path === path)
  if (changes.length === 0) return undefined
  const before = changes[0].before
  const after = changes[changes.length - 1].after
  if (after === undefined) return undefined
  // 新文件：before 缺省，整份内容都是新增。
  if (before === undefined) return { added: countLines(after), removed: 0 }
  let added = 0
  let removed = 0
  for (const part of diffLines(before, after)) {
    if (part.added === true) added += countLines(part.value)
    else if (part.removed === true) removed += countLines(part.value)
  }
  return { added, removed }
}

/** 文本的行数；末尾换行不算多一行。 */
function countLines(text: string): number {
  if (text === '') return 0
  const lines = text.split(/\r?\n/u)
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

/** 渲染用的 `+N −M` 文案；两端都为 0 时不显示。 */
export function formatFileStats(stats: FileStats | undefined): string | undefined {
  if (stats === undefined || stats.added === 0 && stats.removed === 0) return undefined
  return `+${stats.added} −${stats.removed}`
}
