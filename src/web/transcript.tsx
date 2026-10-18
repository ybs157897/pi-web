import { Fragment, useId, useMemo, useState } from 'react'
import {
  DisclosureRow, IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  CodeBlock, DiffBlock, IconCopyOutlineRegular, IconDislikeFillRegular, IconDislikeOutlineRegular,
  IconLikeFillRegular, IconLikeOutlineRegular, IconThinkOutlineRegular, ImageLightbox, MarkdownDelegateProvider,
  IconRefreshOutlineRegular, MarkdownText, ReadBlock, StateDot, TextShimmer, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatMessage, ContentBlock, FileArtifact, MessageUsage } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import ToolCard from './ToolCard.tsx'
import { diffLabels, markdownLabels, readLabels, type Translate } from './render-labels.ts'
import { buildRenderModel, messageText, reasoningDisplay, transcriptMessageDomId, type ProcessPart, type RenderRun, type ResponsePart } from './render-model.ts'
import { toolActivityTitle } from './tool-render-model.ts'
import css from './Transcript.module.css'

export interface PendingMessage {
  id: string
  requestId: string
  submissionId?: string
  text: string
  images: Array<{ preview: string; mimeType: string; name?: string; path?: string; size?: number }>
  files?: Array<{ name: string; mimeType: string; size: number; path?: string; preview?: string }>
  status: 'sending' | 'accepted'
}

export interface InspectorDiff {
  path: string
  oldText?: string | null
  newText?: string
  diff?: string
}

export interface TranscriptProps {
  messages: readonly ChatMessage[]
  pending?: readonly PendingMessage[]
  displayMode?: 'detailed' | 'compact'
  autoCollapseCompleted?: boolean
  onFork?: (entryId: string) => void
  onRetry?: (entryId: string) => void
  onFeedback?: (entryId: string, rating: 'up' | 'down' | null) => void
  onOpenFile?: (path: string, line?: number) => void
  onInspectDiff?: (diff: InspectorDiff) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
  resolveFileImage?: (path: string) => string | undefined
}

/** Render Pi Durable conversation messages with DSH process, Markdown, and tool components. */
export default function Transcript({
  messages, pending = [], displayMode, autoCollapseCompleted, onFork, onRetry, onFeedback,
  onOpenFile, onInspectDiff, onOpenTool, resolveFileImage,
}: TranscriptProps) {
  const { settings, t } = useUiPreferences()
  const processDisplay = displayMode ?? settings.processDisplay
  const collapseProcess = autoCollapseCompleted === undefined ? settings.collapseProcess
    : autoCollapseCompleted ? 'afterResponse' : 'never'
  const model = useMemo(() => buildRenderModel(messages), [messages])
  const labels = useMemo(() => markdownLabels(t), [t])
  const fileImages = useMemo(() => resolveFileImage === undefined ? undefined : ({
    resolve: resolveFileImage,
    labels: {
      open: t('打开图片预览', 'Open image preview'),
      loading: t('正在加载图片…', 'Loading image…'),
      failed: t('无法加载图片', 'Image could not be loaded'),
      dialog: t('图片预览', 'Image preview'),
      close: t('关闭图片预览', 'Close image preview'),
    },
  }), [resolveFileImage, t])
  const openMarkdownFile = useMemo(() => onOpenFile === undefined ? undefined
    : (path: string, options?: { line?: number }) => { onOpenFile(path, options?.line) }, [onOpenFile])
  const showChanges = settings.codingViews
  return (
    <div className={css.transcript}>
      <MarkdownDelegateProvider openFile={openMarkdownFile} fileImages={fileImages}>
        {model.runs.map((run, index) => (
          <RunTranscript key={run.key} run={run} latest={index === model.runs.length - 1}
            onFork={onFork} onRetry={onRetry} onFeedback={onFeedback} onOpenFile={onOpenFile}
            onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} resolveFileImage={resolveFileImage} labels={labels} t={t}
            processDisplay={processDisplay} collapseProcess={collapseProcess} showChanges={showChanges} />
        ))}
        {model.systemMessages.map(message => <div className={css.systemMessage} key={message.id}>{messageText(message)}</div>)}
        {pending.map(message => <PendingRow key={message.id} message={message} onOpenFile={onOpenFile} t={t} />)}
      </MarkdownDelegateProvider>
    </div>
  )
}

function RunTranscript({
  run, latest, onFork, onRetry, onFeedback, onOpenFile, onInspectDiff, onOpenTool, resolveFileImage, labels, t, processDisplay, collapseProcess, showChanges,
}: {
  run: RenderRun
  latest: boolean
  onFork?: TranscriptProps['onFork']
  onRetry?: TranscriptProps['onRetry']
  onFeedback?: TranscriptProps['onFeedback']
  onOpenFile?: TranscriptProps['onOpenFile']
  onInspectDiff?: TranscriptProps['onInspectDiff']
  onOpenTool?: TranscriptProps['onOpenTool']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  labels: ReturnType<typeof markdownLabels>
  t: Translate
  processDisplay: 'detailed' | 'compact'
  collapseProcess: 'afterResponse' | 'always' | 'never'
  showChanges: boolean
}) {
  return (
    <section className={css.run} data-run-id={run.runId}>
      {run.users[0] !== undefined && <MessageRow key={run.users[0].id} message={run.users[0]}
        onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} />}
      {(run.process.length > 0 || run.status === 'error' || run.status === 'cancelled') && (
        <ProcessGroup run={run} latest={latest} t={t} processDisplay={processDisplay}
          collapseProcess={collapseProcess} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool}
          resolveFileImage={resolveFileImage} labels={labels} />
      )}
      {run.responses.map((response, index) => (
        <AssistantResponse key={response.key} response={response} run={run} last={index === run.responses.length - 1}
          onFork={onFork} onRetry={onRetry} onFeedback={onFeedback} onOpenFile={onOpenFile}
          labels={labels} resolveFileImage={resolveFileImage} t={t} />
      ))}
      {run.responses.length === 0 && (run.status === 'error' || run.status === 'cancelled') && (
        <div className={css.retryNotice} data-status={run.status} role={run.status === 'error' ? 'alert' : 'status'}>
          <span>{run.status === 'error' ? t('回答失败', 'Response failed') : t('回答已停止', 'Response stopped')}</span>
          {run.users.at(-1)?.entryId !== undefined && onRetry !== undefined && (
            <Tooltip label={t('重试', 'Retry')} side="bottom" portal>
              <button type="button" className={css.retryButton} aria-label={t('重试此回答', 'Retry this response')}
                onClick={() => {
                  const entryId = run.users.at(-1)?.entryId
                  if (entryId !== undefined) onRetry(entryId)
                }}>
                <IconRefreshOutlineRegular size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      <ChangedFiles artifacts={run.artifacts} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff}
        expandDetails={showChanges} t={t} />
    </section>
  )
}

function MessageRow({ message, onOpenFile, resolveFileImage, t }: {
  message: ChatMessage
  onOpenFile?: TranscriptProps['onOpenFile']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  t: Translate
}) {
  const { settings } = useUiPreferences()
  const [copied, setCopied] = useState(false)
  const visible = message.blocks.some(block => block.type === 'text' && block.text !== '' || block.type === 'image' || block.type === 'file')
  if (!visible) return null
  const copy = async (): Promise<void> => {
    const text = messageText(message)
    if (text === '') return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1500)
    } catch (error) {
      console.warn('Unable to copy the user message', error)
    }
  }
  return (
    <div className={`${css.message} ${css.userMessage}`} id={transcriptMessageDomId(message.id)} data-message-id={message.id} data-role="user">
      <div className={css.userBubble}>
        {message.blocks.map((block, index) => <ContentBlockView key={`${message.id}:${index}`} block={block}
          plainText onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} />)}
      </div>
      <div className={css.userMeta}>
        <time dateTime={safeIsoTime(message.timestamp)}>{formatClock(message.timestamp, settings.locale)}</time>
        <Tooltip label={copied ? t('已复制', 'Copied') : t('复制', 'Copy')} side="bottom" portal>
          <button type="button" className={css.iconAction} aria-label={t('复制用户消息', 'Copy user message')} onClick={() => { void copy() }}>
            <IconCopyOutlineRegular size={14} />
          </button>
        </Tooltip>
        <span className={css.visuallyHidden} aria-live="polite">{copied ? t('已复制', 'Copied') : ''}</span>
      </div>
    </div>
  )
}

function ProcessGroup({ run, latest, t, processDisplay, collapseProcess, onOpenFile, onInspectDiff, onOpenTool, resolveFileImage, labels }: {
  run: RenderRun
  latest: boolean
  t: Translate
  processDisplay: 'detailed' | 'compact'
  collapseProcess: 'afterResponse' | 'always' | 'never'
  onOpenFile?: TranscriptProps['onOpenFile']
  onInspectDiff?: TranscriptProps['onInspectDiff']
  onOpenTool?: TranscriptProps['onOpenTool']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  labels: ReturnType<typeof markdownLabels>
}) {
  const live = run.status === 'running'
  const hasInterleavedUser = run.process.some(part => part.kind === 'user')
  const defaultOpen = hasInterleavedUser || (live ? collapseProcess !== 'always' : collapseProcess === 'never')
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined)
  const open = hasInterleavedUser ? true : manualOpen ?? defaultOpen
  const bodyId = useId()
  const title = processTitle(run, t)
  const preview = run.status === 'running' && processDisplay === 'detailed' ? processPreview(run.process, t) : ''
  return (
    <div className={css.processGroup} data-state={run.status} data-latest={latest || undefined} data-run-id={run.runId}>
      <button type="button" className={css.processHeader} aria-expanded={open} aria-controls={bodyId}
        disabled={hasInterleavedUser}
        onClick={() => { setManualOpen(value => !(value ?? defaultOpen)) }}>
        <span className={css.processLeading} aria-hidden="true">
          {live ? <StateDot state="ongoing" size={14} /> : run.status === 'error' ? <StateDot state="error" size={14} />
            : run.status === 'cancelled' ? <StateDot state="warning" size={14} /> : <IconThinkOutlineRegular size={14} />}
        </span>
        <TextShimmer active={live} className={css.processTitle}>{title}</TextShimmer>
        {preview !== '' && <span className={css.processPreview}>{preview}</span>}
        <span className={css.processChevron} aria-hidden="true">{open ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />}</span>
      </button>
      <div id={bodyId} className={css.processBody} hidden={!open}>
        {run.process.map(part => <ProcessPartView key={part.key} part={part} runRunning={live}
          processDisplay={processDisplay} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool}
          resolveFileImage={resolveFileImage} labels={labels} t={t} />)}
      </div>
    </div>
  )
}

function ProcessPartView({ part, runRunning, processDisplay, onOpenFile, onInspectDiff, onOpenTool, resolveFileImage, labels, t }: {
  part: ProcessPart
  runRunning: boolean
  processDisplay: 'detailed' | 'compact'
  onOpenFile?: TranscriptProps['onOpenFile']
  onInspectDiff?: TranscriptProps['onInspectDiff']
  onOpenTool?: TranscriptProps['onOpenTool']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  labels: ReturnType<typeof markdownLabels>
  t: Translate
}) {
  if (part.kind === 'user') return <MessageRow message={part.message} onOpenFile={onOpenFile}
    resolveFileImage={resolveFileImage} t={t} />
  if (part.kind === 'tool') return <ToolCard item={part.item} runRunning={runRunning}
    processDisplay={processDisplay} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} t={t} />
  if (part.kind === 'content') return <div className={css.processOutput} data-message-id={part.message.id}>
    <ContentBlockView block={part.block} streaming={runRunning && part.message.streaming === true}
      onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} labels={labels} t={t} />
  </div>
  const [open, setOpen] = useState(false)
  const display = reasoningDisplay(part.text, part.redacted, t('思考内容已隐藏', 'Reasoning is hidden'))
  const redacted = part.redacted
  const text = display.text
  const summary = display.summary
  const running = runRunning && part.message.streaming === true
  return (
    <div className={css.reasoning} data-running={running || undefined}>
      <DisclosureRow icon={<IconThinkOutlineRegular size={14} />} title={t('思考过程', 'Reasoning')}
        open={open} expandable onToggle={() => { setOpen(value => !value) }} expandOnRowClick running={running}
        collapsedContent={<span className={css.reasoningSummary}>{running ? <TextShimmer>{summary}</TextShimmer> : summary}</span>}>
        {redacted ? <div className={css.redactedReasoning}>{t('此模型隐藏了思考内容', 'This model hides its reasoning content')}</div>
          : <div className={css.reasoningBody}><MarkdownText text={text} streaming={running} labels={markdownLabels(t)} variant="compact" /></div>}
      </DisclosureRow>
    </div>
  )
}

function AssistantResponse({ response, run, last, onFork, onRetry, onFeedback, onOpenFile, labels, resolveFileImage, t }: {
  response: ResponsePart
  run: RenderRun
  last: boolean
  onFork?: TranscriptProps['onFork']
  onRetry?: TranscriptProps['onRetry']
  onFeedback?: TranscriptProps['onFeedback']
  onOpenFile?: TranscriptProps['onOpenFile']
  labels: ReturnType<typeof markdownLabels>
  resolveFileImage?: TranscriptProps['resolveFileImage']
  t: Translate
}) {
  const { settings } = useUiPreferences()
  const message = response.message
  const [copied, setCopied] = useState(false)
  const text = responseText(response)
  const streaming = message.streaming === true || run.status === 'running'
  const entryId = message.entryId
  const canFeedback = !streaming && entryId !== undefined && onFeedback !== undefined
  const canFork = !streaming && entryId !== undefined && onFork !== undefined
  const retryEntryId = run.users.at(-1)?.entryId
  const canRetry = last && !streaming && retryEntryId !== undefined && onRetry !== undefined
    && (run.status === 'error' || run.status === 'cancelled')
  const rating = message.feedback ?? null
  const copy = async (): Promise<void> => {
    if (text === '') return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1500)
    } catch (error) {
      console.warn('Unable to copy the assistant response', error)
    }
  }
  return (
    <div className={css.message} id={transcriptMessageDomId(message.id)} data-message-id={message.id} data-role="assistant"
      data-streaming={streaming || undefined}>
      <div className={css.assistantBody}>
        {response.blocks.map((block, index) => <ContentBlockView key={`${message.id}:response:${index}`} block={block}
          streaming={streaming} onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} labels={labels} />)}
        {!streaming && run.status === 'cancelled' && <div className={css.runNotice} data-status="cancelled" role="status">
          {t('回答已停止', 'Response stopped')}
        </div>}
        {!streaming && run.status === 'error' && <div className={css.runNotice} data-status="error" role="alert">
          {t('回答失败', 'Response failed')}
        </div>}
        <div className={css.actionRow}>
          <Tooltip label={copied ? t('已复制', 'Copied') : t('复制', 'Copy')} side="bottom" portal>
            <button type="button" className={css.iconAction} aria-label={t('复制回答', 'Copy response')} onClick={() => { void copy() }}>
              <IconCopyOutlineRegular size={15} />
            </button>
          </Tooltip>
          {canFeedback && (
            <>
              <Tooltip label={t('有帮助', 'Good response')} side="bottom" portal>
                <button type="button" className={css.iconAction} aria-label={t('标记为有帮助', 'Rate as helpful')}
                  aria-pressed={rating === 'up'} onClick={() => { if (entryId !== undefined) onFeedback?.(entryId, rating === 'up' ? null : 'up') }}>
                  {rating === 'up' ? <IconLikeFillRegular size={15} /> : <IconLikeOutlineRegular size={15} />}
                </button>
              </Tooltip>
              <Tooltip label={t('需要改进', 'Needs improvement')} side="bottom" portal>
                <button type="button" className={css.iconAction} aria-label={t('标记为需要改进', 'Rate as needing improvement')}
                  aria-pressed={rating === 'down'} onClick={() => { if (entryId !== undefined) onFeedback?.(entryId, rating === 'down' ? null : 'down') }}>
                  {rating === 'down' ? <IconDislikeFillRegular size={15} /> : <IconDislikeOutlineRegular size={15} />}
                </button>
              </Tooltip>
            </>
          )}
          {canFork && <Tooltip label={t('从此处分叉', 'Fork from here')} side="bottom" portal>
            <button type="button" className={css.iconAction} aria-label={t('从此处分叉', 'Fork from here')}
              onClick={() => { if (entryId !== undefined) onFork?.(entryId) }}>
              <IconBranchOutlineRegular size={15} />
            </button>
          </Tooltip>}
          {canRetry && <Tooltip label={t('重试', 'Retry')} side="bottom" portal>
            <button type="button" className={css.iconAction} aria-label={t('重试此回答', 'Retry this response')}
              onClick={() => { if (retryEntryId !== undefined) onRetry?.(retryEntryId) }}>
              <IconRefreshOutlineRegular size={15} />
            </button>
          </Tooltip>}
          {last && run.usage !== undefined && <span className={css.usage} title={formatUsageDetails(run.usage, t)}>
            <span aria-hidden="true">◉</span>{t(`用量 ${run.usage.totalTokens} tok`, `${run.usage.totalTokens} tokens`)}
          </span>}
          <time className={css.messageTime} dateTime={safeIsoTime(message.timestamp)}>{formatClock(message.timestamp, settings.locale)}</time>
          <span className={css.visuallyHidden} aria-live="polite">{copied ? t('已复制', 'Copied') : ''}</span>
        </div>
      </div>
    </div>
  )
}

function ContentBlockView({ block, streaming = false, plainText = false, onOpenFile, resolveFileImage, t, labels }: {
  block: ContentBlock
  streaming?: boolean
  plainText?: boolean
  onOpenFile?: TranscriptProps['onOpenFile']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  t: Translate
  labels?: ReturnType<typeof markdownLabels>
}) {
  switch (block.type) {
    case 'text':
      return plainText ? <div className={css.userText}>{block.text}</div>
        : <MarkdownText text={block.text} streaming={streaming} labels={labels ?? markdownLabels(t)} />
    case 'thinking':
      return null
    case 'image':
      return <ImageBlock url={block.url} alt={t('对话图片', 'Conversation image')} />
    case 'file':
      return <FileBlock block={block} onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} />
    case 'toolCall':
      return null
    default:
      return null
  }
}

function ImageBlock({ url, alt }: { url: string; alt: string }) {
  const { t } = useUiPreferences()
  const [lightboxOpen, setLightboxOpen] = useState(false)
  return (
    <Fragment>
      <button className={css.imageButton} type="button" onClick={() => { setLightboxOpen(true) }} aria-label={alt}>
        <img src={url} alt={alt} loading="lazy" />
      </button>
      {lightboxOpen && <ImageLightbox src={url} alt={alt} labels={{ dialog: t('图片预览', 'Image preview'), close: t('关闭图片预览', 'Close image preview') }}
        onClose={() => { setLightboxOpen(false) }} />}
    </Fragment>
  )
}

function FileBlock({ block, onOpenFile, resolveFileImage, t }: {
  block: Extract<ContentBlock, { type: 'file' }>
  onOpenFile?: TranscriptProps['onOpenFile']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  t: Translate
}) {
  const imageUrl = block.mimeType.startsWith('image/') ? resolveFileImage?.(block.path) : undefined
  if (imageUrl !== undefined) return <ImageBlock url={imageUrl} alt={block.name} />
  const size = formatFileSize(block.size, t)
  return (
    <button type="button" className={css.fileChip} onClick={() => { onOpenFile?.(block.path) }}
      disabled={onOpenFile === undefined} aria-label={t(`打开文件 ${block.name}`, `Open file ${block.name}`)}>
      <span className={css.fileGlyph} aria-hidden="true">{block.mimeType.startsWith('image/') ? '▧' : '▤'}</span>
      <span className={css.fileName}>{block.name}</span>
      <span className={css.fileSize}>{size}</span>
    </button>
  )
}

function PendingRow({ message, onOpenFile, t }: { message: PendingMessage; onOpenFile?: TranscriptProps['onOpenFile']; t: Translate }) {
  const files = [...message.images, ...(message.files ?? [])]
  return (
    <div className={`${css.message} ${css.pendingMessage}`} data-pending="">
      <div className={css.userBubble}>
        {message.text !== '' && <div className={css.userText}>{message.text}</div>}
        {files.length > 0 && <div className={css.images}>{files.map((file, index) => file.mimeType.startsWith('image/') && file.preview
          ? <ImageBlock key={`${message.id}:${index}`} url={file.preview} alt={file.name ?? t(`待发送图片 ${index + 1}`, `Image ${index + 1}`)} />
          : <button key={`${message.id}:${index}`} type="button" className={css.fileChip} disabled={file.path === undefined || onOpenFile === undefined}
            onClick={() => { if (file.path !== undefined) onOpenFile?.(file.path) }}>
            <span className={css.fileGlyph} aria-hidden="true">▤</span>
            <span className={css.fileName}>{file.name ?? t('文件', 'File')}</span>
            {file.size !== undefined && <span className={css.fileSize}>{formatFileSize(file.size, t)}</span>}
          </button>)}</div>}
        <span className={css.pendingStatus} role="status">{message.status === 'sending' ? t('发送中…', 'Sending…') : t('已接收', 'Accepted')}</span>
      </div>
    </div>
  )
}

function ChangedFiles({ artifacts, onOpenFile, onInspectDiff, expandDetails, t }: {
  artifacts: readonly FileArtifact[]
  onOpenFile?: TranscriptProps['onOpenFile']
  onInspectDiff?: TranscriptProps['onInspectDiff']
  expandDetails: boolean
  t: Translate
}) {
  const changes = artifacts.filter(artifact => (artifact.kind === 'edit' || artifact.kind === 'write' || artifact.kind === 'nativeEdit')
    && (artifact.before !== undefined && artifact.after !== undefined || artifact.diff !== undefined || artifact.after !== undefined))
  if (changes.length === 0) return null
  return (
    <div className={css.changedFiles}>
      <div className={css.changedTitle}>{t('已改动文件', 'Changed files')}</div>
      {changes.map((artifact, index) => {
        const diff = inspectorDiff(artifact)
        return (
          <div className={css.changedFile} key={`${artifact.kind}:${artifact.path}:${index}`}>
            <div className={css.changedFileHeader}>
              <span className={css.changedKind}>{artifact.kind === 'write' ? t('写入', 'Wrote') : t('修改', 'Edited')}</span>
              <button type="button" className={css.pathButton} onClick={() => { onOpenFile?.(artifact.path) }}
                disabled={onOpenFile === undefined}>{artifact.path}</button>
              {onInspectDiff !== undefined && (artifact.before !== undefined && artifact.after !== undefined || artifact.diff !== undefined || artifact.after !== undefined)
                && <button type="button" className={css.inspectDiffButton}
                onClick={() => { onInspectDiff(diff) }}>{t('查看差异', 'Inspect diff')}</button>}
            </div>
            {expandDetails && artifact.before !== undefined && artifact.after !== undefined && <div className={css.changedDiff}>
              <DiffBlock diffs={[{ path: artifact.path, oldText: artifact.before, newText: artifact.after }]} labels={diffLabels(t)} />
            </div>}
            {expandDetails && artifact.diff !== undefined && !(artifact.before !== undefined && artifact.after !== undefined) && <div className={css.changedDiff}>
              <CodeBlock code={artifact.diff} lang="diff" copyLabel={t('复制差异', 'Copy diff')} copiedLabel={t('已复制', 'Copied')} />
            </div>}
            {expandDetails && artifact.before === undefined && artifact.after !== undefined && artifact.diff === undefined && <div className={css.changedDiff}>
              <ReadBlock label={artifact.path} lines={artifact.after.split(/\r?\n/u).map((text, line) => ({ number: (artifact.lineStart ?? 1) + line, text }))}
                totalLines={artifact.after.split(/\r?\n/u).length} labels={readLabels(t)} />
            </div>}
          </div>
        )
      })}
    </div>
  )
}

function processTitle(run: RenderRun, t: Translate): string {
  if (run.status === 'running') {
    const last = run.process.at(-1)
    if (last?.kind === 'tool') return toolActivityTitle(last.item.call?.name ?? last.item.result?.toolName ?? '', t)
    if (last?.kind === 'reasoning') return t('正在思考', 'Thinking')
    if (last?.kind === 'content') return t('正在生成回答', 'Writing a response')
    return t('正在处理', 'Working')
  }
  if (run.status === 'error') return t('执行失败', 'Run failed')
  if (run.status === 'cancelled') return t('已停止', 'Stopped')
  if (run.durationMs !== undefined) return t(`已完成，用时 ${formatDuration(run.durationMs, t)}`, `Completed in ${formatDuration(run.durationMs, t)}`)
  return t('已完成', 'Completed')
}

function processPreview(process: readonly ProcessPart[], t: Translate): string {
  const last = process.at(-1)
  if (last?.kind === 'user') return t('收到新的输入', 'New input received')
  if (last?.kind === 'reasoning') return reasoningDisplay(last.text, last.redacted, t('思考内容已隐藏', 'Reasoning is hidden')).summary
  if (last?.kind === 'tool') {
    const args = last.item.call?.arguments
    const candidate = args === undefined ? undefined : stringField(args, ['command', 'cmd', 'script', 'path', 'filePath', 'file_path', 'query', 'pattern'])
    return candidate === undefined ? last.item.call?.name ?? last.item.result?.toolName ?? t('工具', 'Tool') : firstLine(candidate)
  }
  if (last?.kind === 'content') {
    if (last.block.type === 'text') return firstLine(last.block.text)
    if (last.block.type === 'image') return t('图片', 'Image')
    if (last.block.type === 'file') return last.block.name
  }
  return ''
}

function stringField(record: Readonly<Record<string, unknown>>, fields: readonly string[]): string | undefined {
  for (const field of fields) if (typeof record[field] === 'string') return record[field]
  return undefined
}

function responseText(response: ResponsePart): string {
  return response.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function formatClock(timestamp: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}

function safeIsoTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) return undefined
  return new Date(timestamp).toISOString()
}

function formatDuration(milliseconds: number, t: Translate): string {
  const totalSeconds = Math.max(1, Math.floor(milliseconds / 1000))
  if (totalSeconds < 60) return t(`${totalSeconds} 秒`, `${totalSeconds}s`)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return t(`${minutes} 分 ${seconds} 秒`, `${minutes}m ${seconds}s`)
}

function formatUsageDetails(usage: MessageUsage, t: Translate): string {
  return t(`输入 ${usage.input}，输出 ${usage.output}，缓存读取 ${usage.cacheRead}，费用 ${usage.cost.total}`,
    `Input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, cost ${usage.cost.total}`)
}

function formatFileSize(size: number, t: Translate): string {
  if (!Number.isFinite(size) || size < 0) return t('未知大小', 'Unknown size')
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u).find(line => line.trim() !== '')?.trim() ?? ''
}

function inspectorDiff(artifact: FileArtifact): InspectorDiff {
  return {
    path: artifact.path,
    ...(artifact.before === undefined ? {} : { oldText: artifact.before }),
    ...(artifact.after === undefined ? {} : { newText: artifact.after }),
    ...(artifact.diff === undefined ? {} : { diff: artifact.diff }),
  }
}

