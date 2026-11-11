import { useMemo } from 'react'
import { FileDiff, MessageSquareText } from 'lucide-react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatMessage, ConversationDetail, FileArtifact } from '../shared/types.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { fileStats } from './file-stats.ts'
import { conversationStats } from './render-model.ts'
import { formatTokens, type Translate } from './render-labels.ts'
import { MessageFileIcon } from './message-rendering/FileIcon.tsx'
import type { InspectorDiff } from './transcript.tsx'
import './message-rendering/theme.css'
import css from './TaskViews.module.css'

/** One path's combined change across the whole task, mirroring `collectChangeFiles`' merge rule. */
export interface TaskChangeEntry {
  readonly path: string
  readonly name: string
  readonly kind: 'write' | 'edit' | 'nativeEdit'
  readonly added: number
  readonly removed: number
  readonly lineStart: number | undefined
  readonly lineEnd: number | undefined
  readonly before: string | undefined
  readonly after: string | undefined
  readonly diff: string | undefined
}

const CHANGE_KINDS = new Set<FileArtifact['kind']>(['write', 'edit', 'nativeEdit'])

/** A change artifact must carry some recorded content; a bare read or empty write is not a change. */
function isChangeArtifact(artifact: FileArtifact): boolean {
  return CHANGE_KINDS.has(artifact.kind)
    && (artifact.before !== undefined || artifact.after !== undefined || artifact.diff !== undefined)
}

/** Cheap distinct-path count for the tab badge and the summary stat; no line diffing. */
export function countTaskChanges(messages: readonly ChatMessage[]): number {
  const paths = new Set<string>()
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      if (isChangeArtifact(artifact)) paths.add(artifact.path)
    }
  }
  return paths.size
}

/**
 * Aggregate every write/edit/nativeEdit artifact in the task, merged per path: the first recorded
 * `before` against the last recorded `after`, the widest line range, and the last edit kind. Sorted
 * by display path like the transcript's changed-files card so rows do not shuffle between polls.
 */
export function collectTaskChanges(messages: readonly ChatMessage[]): TaskChangeEntry[] {
  const artifacts: FileArtifact[] = []
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      if (isChangeArtifact(artifact)) artifacts.push(artifact)
    }
  }
  const order: string[] = []
  const groups = new Map<string, FileArtifact[]>()
  for (const artifact of artifacts) {
    const group = groups.get(artifact.path)
    if (group === undefined) { groups.set(artifact.path, [artifact]); order.push(artifact.path) }
    else group.push(artifact)
  }
  return order.sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map(path => {
    const group = groups.get(path) ?? []
    const first = group[0]
    const last = group[group.length - 1]
    const stats = fileStats(artifacts, path)
    let lineStart: number | undefined
    let lineEnd: number | undefined
    for (const artifact of group) {
      if (artifact.lineStart !== undefined) lineStart = lineStart === undefined ? artifact.lineStart : Math.min(lineStart, artifact.lineStart)
      if (artifact.lineEnd !== undefined) lineEnd = lineEnd === undefined ? artifact.lineEnd : Math.max(lineEnd, artifact.lineEnd)
    }
    return {
      path,
      name: path.split(/[\\/]/u).pop() ?? path,
      kind: last === undefined ? 'edit' : last.kind === 'write' ? 'write' : last.kind === 'nativeEdit' ? 'nativeEdit' : 'edit',
      added: stats?.added ?? 0,
      removed: stats?.removed ?? 0,
      lineStart,
      lineEnd,
      before: first?.before,
      after: last?.after,
      diff: last?.diff,
    }
  })
}

function changeKindLabel(entry: TaskChangeEntry, t: Translate): string {
  if (entry.kind === 'write') return entry.before === undefined ? t('新建', 'New') : t('写入', 'Write')
  return t('编辑', 'Edit')
}

/** Prefer the recorded line range; fall back to the +N −M magnitude when no range was captured. */
function changeLineMetric(entry: TaskChangeEntry): string {
  if (entry.lineStart !== undefined && entry.lineEnd !== undefined) return `L${entry.lineStart}–${entry.lineEnd}`
  if (entry.added === 0 && entry.removed === 0) return ''
  return `+${entry.added} −${entry.removed}`
}

/** The changes view: every file the task touched, one row per path, opening the diff or the file. */
export function TaskChangesView({ messages, onInspectDiff, onOpenFile, t }: {
  messages: readonly ChatMessage[]
  onInspectDiff: (diff: InspectorDiff) => void
  onOpenFile: (path: string) => void
  t: Translate
}) {
  const changes = useMemo(() => collectTaskChanges(messages), [messages])
  if (changes.length === 0) {
    return <div className={css.viewEmpty} role="status">{t('本任务没有文件改动', 'No file changes in this task')}</div>
  }
  const open = (entry: TaskChangeEntry): void => {
    if (entry.before === undefined && entry.after === undefined && entry.diff === undefined) {
      onOpenFile(entry.path)
      return
    }
    onInspectDiff({
      path: entry.path,
      ...(entry.before === undefined ? {} : { oldText: entry.before }),
      ...(entry.after === undefined ? {} : { newText: entry.after }),
      ...(entry.diff === undefined ? {} : { diff: entry.diff }),
    })
  }
  return (
    <div className={css.changesView}>
      <div className={css.changesHeader}>
        <span>{t(`${changes.length} 个文件改动`, `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed`)}</span>
      </div>
      <div className={css.changesList}>
        {changes.map(entry => {
          const metric = changeLineMetric(entry)
          return (
            <button key={entry.path} type="button" className={css.changeRow} title={entry.path}
              aria-label={t(`查看 ${entry.name} 的改动`, `View changes to ${entry.name}`)} onClick={() => { open(entry) }}>
              <span className={css.changeIcon}><MessageFileIcon path={entry.path} /></span>
              <span className={css.changePath}>{entry.path}</span>
              <span className={css.changeKind} data-kind={entry.kind}>{changeKindLabel(entry, t)}</span>
              {metric !== '' && <span className={css.changeLines}>{metric}</span>}
              <FileDiff size={14} aria-hidden="true" className={css.changeDiffIcon} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The last assistant answer as full markdown text (not the row's collapsed preview). */
function lastAssistantText(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = message.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n').trim()
    if (text !== '') return text
  }
  return undefined
}

/** Compact localized duration: 42秒 / 3分05秒 / 1小时02分. */
function formatDuration(ms: number, t: Translate): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t(`${hours}小时${String(minutes).padStart(2, '0')}分`, `${hours}h ${String(minutes).padStart(2, '0')}m`)
  if (minutes > 0) return t(`${minutes}分${String(seconds).padStart(2, '0')}秒`, `${minutes}m ${String(seconds).padStart(2, '0')}s`)
  return t(`${seconds}秒`, `${seconds}s`)
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return <div className={css.summaryStat}><span className={css.summaryStatValue}>{value}</span><span className={css.summaryStatLabel}>{label}</span></div>
}

/** The summary view: the final answer plus the task's headline numbers, with a way back to the process. */
export function TaskSummaryView({ detail, changeCount, onOpenFile, resolveFileImage, onViewProcess, t }: {
  detail: ConversationDetail
  changeCount: number
  onOpenFile: (path: string, line?: number) => void
  resolveFileImage?: (path: string) => string | undefined
  onViewProcess: () => void
  t: Translate
}) {
  const answer = useMemo(() => lastAssistantText(detail.messages), [detail.messages])
  const stats = useMemo(() => conversationStats(detail.messages), [detail.messages])
  const pathImages = useMemo(() => resolveFileImage === undefined ? undefined : { resolve: resolveFileImage }, [resolveFileImage])
  const turns = detail.messages.filter(message => message.role === 'user').length
  const durationMs = detail.conversation.durationMs
  const subagents = detail.subagents?.length ?? 0
  return (
    <div className={css.summaryView}>
      <div className={css.summaryStats}>
        <SummaryStat label={t('轮数', 'Turns')} value={String(turns)} />
        {durationMs !== undefined && <SummaryStat label={t('时长', 'Duration')} value={formatDuration(durationMs, t)} />}
        <SummaryStat label={t('Tokens', 'Tokens')} value={formatTokens(stats.totalTokens)} />
        <SummaryStat label={t('改动文件', 'Files changed')} value={String(changeCount)} />
        <SummaryStat label={t('子智能体', 'Subagents')} value={String(subagents)} />
      </div>
      <div className={css.summaryAnswer}>
        {answer === undefined
          ? <div className={css.summaryAnswerEmpty}>{t('本任务还没有回答', 'This task has no answer yet')}</div>
          : <AnswerMarkdown text={answer} t={t} onOpenFile={onOpenFile} pathImages={pathImages} />}
      </div>
      <div className={css.summaryFooter}>
        <Button variant="outline" size="sm" icon={<MessageSquareText size={14} />} onClick={onViewProcess}>
          {t('查看过程', 'View process')}
        </Button>
      </div>
    </div>
  )
}
