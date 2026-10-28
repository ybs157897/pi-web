import { useId, useMemo, useState } from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import type { FileArtifact } from '../shared/types.ts'
import { fileStats } from './file-stats.ts'
import type { Translate } from './render-labels.ts'
import { MessageFileIcon } from './message-rendering/FileIcon.tsx'
import './message-rendering/theme.css'
import css from './ChangedFiles.module.css'

export interface ChangedFileEntry {
  readonly path: string; readonly name: string; readonly added: number; readonly deleted: number
  readonly before: string | undefined; readonly after: string | undefined; readonly diff: string | undefined; readonly lineStart: number | undefined
}
export interface ChangedFilesProps {
  readonly artifacts: readonly FileArtifact[]
  readonly onInspectDiff?: (diff: { path: string; oldText?: string | null; newText?: string; diff?: string }) => void
  readonly t: Translate
}
/** Host-owned changes, presented as ZCode's collapsed file summary. */
export default function ChangedFiles({ artifacts, onInspectDiff, t }: ChangedFilesProps) {
  const files = useMemo(() => collectChangeFiles(artifacts), [artifacts])
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!files.length) return null
  const added = files.reduce((sum, file) => sum + file.added, 0), deleted = files.reduce((sum, file) => sum + file.deleted, 0)
  const inspect = (file: ChangedFileEntry) => onInspectDiff?.({ path: file.path,
    ...(file.before === undefined ? {} : { oldText: file.before }), ...(file.after === undefined ? {} : { newText: file.after }), ...(file.diff === undefined ? {} : { diff: file.diff }) })
  return <section className={css.card} data-message-changes>
    <button type="button" className={css.header} aria-label={open ? t('收起已更改文件', 'Collapse changed files') : t('展开已更改文件', 'Expand changed files')} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <ChevronRight size={14} data-open={open || undefined} aria-hidden="true" /><span>{t(`${files.length} 个文件已更改`, `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`)}</span>
      <span className={css.counts}><span>+{added}</span><span>−{deleted}</span></span>
    </button>
    <div id={id} className={css.collapse} data-open={open || undefined} aria-hidden={!open} {...(!open ? { inert: '' } : {})}><div className={css.clip}><div className={css.list}>
      {files.map(file => <button key={file.path} type="button" className={css.row} title={file.path} disabled={!onInspectDiff} onClick={() => inspect(file)} aria-label={t(`查看 ${file.name} 的改动`, `View changes to ${file.name}`)}>
        <MessageFileIcon path={file.path} /><span className={css.path}>{file.path}</span><span className={css.counts}><span>+{file.added}</span><span>−{file.deleted}</span></span><FileDiff size={14} aria-hidden="true" />
      </button>)}
    </div></div></div>
  </section>
}

/**
 * One artifact path's combined change: the first recorded `before` against the
 * last recorded `after`, so a write followed by edits reports one row.
 */
export function collectChangeFiles(artifacts: readonly FileArtifact[]): ChangedFileEntry[] {
  const order: string[] = []
  const groups = new Map<string, FileArtifact[]>()
  for (const artifact of artifacts) {
    if (artifact.kind !== 'write' && artifact.kind !== 'edit' && artifact.kind !== 'nativeEdit') continue
    if (artifact.before === undefined && artifact.after === undefined && artifact.diff === undefined) continue
    const group = groups.get(artifact.path)
    if (group === undefined) {
      groups.set(artifact.path, [artifact])
      order.push(artifact.path)
    } else {
      group.push(artifact)
    }
  }
  // DSH's recorder sorts the summary by display path; keep the same order so the
  // rows do not shuffle with the order parallel writes happen to finish in.
  return order.sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((path) => {
    const group = groups.get(path) ?? []
    const first = group[0]
    const last = group[group.length - 1]
    const stats = fileStats(artifacts, path)
    return {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      added: stats?.added ?? 0,
      deleted: stats?.removed ?? 0,
      before: first?.before,
      after: last?.after,
      diff: last?.diff,
      lineStart: last?.lineStart,
    }
  })
}
