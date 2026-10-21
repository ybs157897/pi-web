import { useMemo, useRef, useState } from 'react'
import {
  CodeBlock, DiffBlock, FileTypeIcon, HoverCard, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, ReadBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileArtifact } from '../shared/types.ts'
import { fileStats } from './file-stats.ts'
import { diffLabels, readLabels, type Translate } from './render-labels.ts'
import css from './ChangedFiles.module.css'

/** Rows shown before the fold, matching DSH's closing-message summary height. */
const COLLAPSED_ROWS = 4

/** One file of the turn, with the content its preview and its diff need. */
export interface ChangedFileEntry {
  readonly path: string
  readonly name: string
  readonly added: number
  readonly deleted: number
  readonly before: string | undefined
  readonly after: string | undefined
  readonly diff: string | undefined
  readonly lineStart: number | undefined
}

export interface ChangedFilesProps {
  readonly artifacts: readonly FileArtifact[]
  readonly onInspectDiff?: ((diff: { path: string; oldText?: string | null; newText?: string; diff?: string }) => void) | undefined
  readonly t: Translate
}

/**
 * The turn's changed files, laid out like DSH's deliverables card: one filled
 * header for the turn, one compact row per file, a fold after four rows, the
 * comparison in the inspector on click and a hover preview on dwell.
 *
 * DSH keeps the turn's authoritative summary on the Host; pi-web derives the
 * same rows from the run's own file artifacts, which is where its diff stats
 * already come from.
 */
export default function ChangedFiles({ artifacts, onInspectDiff, t }: ChangedFilesProps) {
  const files = useMemo(() => collectChangeFiles(artifacts), [artifacts])
  const [expanded, setExpanded] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  if (files.length === 0) return null
  const total = files.length
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0)
  const single = total === 1 ? files[0] : undefined
  const foldable = files.length > COLLAPSED_ROWS
  const rows = foldable && !expanded ? files.slice(0, COLLAPSED_ROWS) : files
  const open = (file: ChangedFileEntry): void => {
    onInspectDiff?.({
      path: file.path,
      ...(file.before === undefined ? {} : { oldText: file.before }),
      ...(file.after === undefined ? {} : { newText: file.after }),
      ...(file.diff === undefined ? {} : { diff: file.diff }),
    })
  }
  const header = (
    <button type="button" className={css.header}
      aria-label={single === undefined ? t('在侧边栏查看本轮改动', 'Review this turn’s changes in the sidebar') : t(`查看 ${single.name} 的改动`, `View changes to ${single.name}`)}
      onClick={() => { open(files[0]) }}>
      <span className={css.tile}>
        {single === undefined ? <FileTypeIcon kind="code" size={20} /> : <FileTypeIcon path={single.path} size={20} />}
      </span>
      <span className={css.titles}>
        <span className={css.title}>{single === undefined
          ? t(`已编辑 ${total} 个文件`, `Edited ${total} files`)
          : t(`已编辑 ${single.name}`, `Edited ${single.name}`)}</span>
        <span className={css.stat}>
          <span className={css.statCounts}>
            <span className={css.added}>{`+${added}`}</span>
            <span className={css.deleted}>{`-${deleted}`}</span>
          </span>
          <span className={css.previewHint}>{t('在侧边栏预览', 'Preview in sidebar')}</span>
        </span>
      </span>
    </button>
  )
  return (
    <div ref={cardRef} className={css.card} data-changed-files="" data-single={single === undefined ? undefined : ''}>
      {single === undefined
        ? header
        : <HoverCard variant="preview" widthAnchorRef={cardRef} openDelayMs={500} anchor={header}
          content={<ChangePreview file={single} t={t} />} />}
      {single === undefined && (
        <ul className={css.list}>
          {rows.map(file => (
            <li key={file.path}>
              <HoverCard variant="preview" widthAnchorRef={cardRef} openDelayMs={500}
                anchor={<button type="button" className={css.row}
                  aria-label={t(`查看 ${file.name} 的改动`, `View changes to ${file.name}`)}
                  onClick={() => { open(file) }}>
                  <span className={css.path}>{file.path}</span>
                  <span className={css.counts}>
                    <span className={css.added}>{`+${file.added}`}</span>
                    <span className={css.deleted}>{`-${file.deleted}`}</span>
                  </span>
                </button>}
                content={<ChangePreview file={file} t={t} />} />
            </li>
          ))}
        </ul>
      )}
      {foldable && (
        <button type="button" className={css.toggle} aria-expanded={expanded}
          aria-label={expanded ? t('收起改动文件列表', 'Collapse changed files') : t(`展开全部 ${total} 个改动文件`, `Show all ${total} changed files`)}
          onClick={() => { setExpanded(value => !value) }}>
          <span>{expanded ? t('收起', 'Collapse') : t(`全部 ${total} 个文件`, `All ${total} files`)}</span>
          {expanded ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />}
        </button>
      )}
    </div>
  )
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

/** The hover preview: the file's comparison, read-only and bounded by the card. */
function ChangePreview({ file, t }: { readonly file: ChangedFileEntry; readonly t: Translate }) {
  const lines = file.after === undefined ? [] : file.after.split(/\r?\n/u)
  return (
    <div className={css.preview} data-changes-hover-preview="">
      <div className={css.previewHeader}><span className={css.previewPath}>{file.path}</span></div>
      {file.before !== undefined && file.after !== undefined
        ? <DiffBlock diffs={[{ path: file.path, oldText: file.before, newText: file.after }]} labels={diffLabels(t)} />
        : file.diff !== undefined
          ? <CodeBlock code={file.diff} lang="diff" copyLabel={t('复制差异', 'Copy diff')} copiedLabel={t('已复制', 'Copied')} />
          : file.after !== undefined
            ? <ReadBlock label={file.path} lines={lines.map((text, index) => ({ number: (file.lineStart ?? 1) + index, text }))}
              totalLines={lines.length} labels={readLabels(t)} />
            : null}
    </div>
  )
}
