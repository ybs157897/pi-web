import { useId, useMemo, useState } from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import type { FileArtifact } from '../shared/types.ts'
import { fileStats } from './file-stats.ts'
import type { Translate } from './render-labels.ts'
import { MessageFileIcon } from './message-rendering/FileIcon.tsx'
import './message-rendering/theme.css'
import css from './ChangedFiles.module.css'

/** 单个文件的合并改动条目：路径、文件名、增删行数与前后文本/差异内容。 */
export interface ChangedFileEntry {
  readonly path: string; readonly name: string; readonly added: number; readonly deleted: number
  readonly before: string | undefined; readonly after: string | undefined; readonly diff: string | undefined; readonly lineStart: number | undefined
}
/** ChangedFiles 的属性定义：文件工件列表、差异查看回调与翻译函数。 */
export interface ChangedFilesProps {
  readonly artifacts: readonly FileArtifact[]
  readonly onInspectDiff?: (diff: { path: string; oldText?: string | null; newText?: string; diff?: string }) => void
  readonly t: Translate
}
/**
 * 功能：宿主侧文件改动摘要（对应 ZCode 折叠的「已更改文件」汇总行），
 * 出现在消息流中：头部显示改动文件数与总增删行数，展开后逐行列出文件及各自增删。
 * @param props artifacts 文件写入/编辑工件列表；onInspectDiff 点击某文件时回调
 *              （携带路径与 old/new/diff 之一）；t 双语翻译函数。
 * 内部逻辑：collectChangeFiles 以 useMemo 聚合同一文件的多次改动；open 控制折叠区，
 * 收起时以 inert + aria-hidden 隐藏；onInspectDiff 未提供时行按钮禁用。
 */
export default function ChangedFiles({ artifacts, onInspectDiff, t }: ChangedFilesProps) {
  const files = useMemo(() => collectChangeFiles(artifacts), [artifacts])
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!files.length) return null
  const added = files.reduce((sum, file) => sum + file.added, 0), deleted = files.reduce((sum, file) => sum + file.deleted, 0)
  const inspect = (file: ChangedFileEntry) => onInspectDiff?.({ path: file.path,
    ...(file.before === undefined ? {} : { oldText: file.before }), ...(file.after === undefined ? {} : { newText: file.after }), ...(file.diff === undefined ? {} : { diff: file.diff }) })
  return <section className={css.changes} data-message-changes>
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
 * 把文件工件按路径聚合为每个文件一条的合并改动：取首次记录的 `before` 与
 * 最后一次记录的 `after`，因此一次 write 后跟多次 edit 只报一行。
 * @param artifacts 全部消息文件工件（含非文件类，内部过滤）。
 * @returns 按显示路径排序（与 DSH 记录器一致，避免并行写入完成顺序打乱行序）
 *          的 ChangedFileEntry 数组，增删行数来自 fileStats。
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
  // DSH 的记录器按显示路径排序汇总；保持同一顺序，避免行随并行写入的完成顺序抖动。
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
