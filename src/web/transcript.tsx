import { Fragment, useEffect, useId, useMemo, useState } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconCopyOutlineRegular, IconDatabaseOutlineRegular, IconDislikeFillRegular,
  IconDislikeOutlineRegular, IconLikeFillRegular, IconLikeOutlineRegular, IconLoadingOutlineRegular, ImageLightbox, MarkdownDelegateProvider,
  Menu, MenuItemButton, IconRefreshOutlineRegular, MarkdownText, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions, MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatMessage, ContentBlock, FileArtifact, InteractionRequest } from '../shared/types.ts'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import ChangedFiles from './ChangedFiles.tsx'
import ToolCard from './ToolCard.tsx'
import { ProcessToolGroup } from './ProcessToolGroup.tsx'
import { formatTokens, markdownLabels, type Translate } from './render-labels.ts'
import { buildRenderModel, interactionBlocksTurnLoading, messageText, transcriptMessageDomId, turnChatLoadingVisible, type ProcessPart, type RenderRun, type ResponsePart } from './render-model.ts'
import type { PlanDocument } from './plan-preview.ts'
import { presentationPolicyFor, type ChatPresentationPolicy } from './presentation-policy.ts'
import { dismissedQuestionOf, lateAnswerClipboardText, lateAnswerOf, lateAnswerRows, lateAnswerSummary, type LateAnswer } from './tool-render-model.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { ReasoningBlock } from './message-rendering/ReasoningBlock.tsx'
import { ProcessExpansionProvider } from './message-rendering/ProcessExpansion.tsx'
import { PluginUiConversationContext } from './plugin-ui-bridge.ts'
import { parseAnswerFileLink } from './answer-markdown-model.ts'
import { ChevronRight } from 'lucide-react'
import './message-rendering/theme.css'
import { defaultProcessOpen, workGroupTitle } from './process-presentation.ts'
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
  /** The conversation these messages belong to; the subagent strip re-reads its live children. */
  conversationId?: string
  pending?: readonly PendingMessage[]
  /** A compaction is running: render the same transcript-level status row as the completed marker. */
  compactionRunning?: boolean
  /** The conversation has a live run: the tail spinner marks the transcript as still working. */
  running?: boolean
  /** Projected interactions, so question rows read their call's DSH state. */
  interactions?: readonly InteractionRequest[]
  /** Work-details presentation policy; absent uses the saved settings. */
  policy?: ChatPresentationPolicy
  onFork?: (entryId: string) => void
  onRetry?: (entryId: string) => void
  onFeedback?: (entryId: string, rating: 'up' | 'down' | null) => void
  onOpenFile?: (path: string, line?: number) => void
  onInspectDiff?: (diff: InspectorDiff) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
  /** Open the child conversation a `subagent` row created as a read-only inspector tab. */
  onOpenSubagent?: (conversationId: string, title?: string) => void
  /** Open a submitted plan in the inspector's plan view; `auto` marks DSH's one automatic open. */
  onOpenPlan?: (plan: PlanDocument, auto?: boolean) => void
  /** Open a plugin UI page in the inspector; a row calls it once for a fullscreen surface, and
   * an inline card passes its host so both surfaces share one iframe. */
  onOpenPluginUi?: (page: PluginUiPage, host?: HTMLElement) => void
  /** Context/message/link relays for inline plugin pages. */
  onPluginContext?: (entry: PluginContextEntry) => void
  onPluginMessage?: (text: string) => void
  onPluginOpenLink?: (url: string) => void
  resolveFileImage?: (path: string) => string | undefined
}

/** Render host-owned conversation state with the ZCode-aligned message and work components. */
export default function Transcript({
  messages, conversationId, pending = [], compactionRunning = false, running = false, interactions, policy, onFork, onRetry, onFeedback,
  onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan, onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage,
}: TranscriptProps) {
  const { settings, t } = useUiPreferences()
  const presentation = policy ?? presentationPolicyFor(settings.transcriptView, settings.collapseTiming)
  const model = useMemo(() => buildRenderModel(messages), [messages])
  // Late answers keyed by their question call: the reply bubble reads them from
  // its own message, and the tool row uses its call's answer to settle.
  const replies = useMemo(() => {
    const byCall = new Map<string, LateAnswer>()
    for (const message of messages) {
      if (message.role !== 'user') continue
      const reply = lateAnswerOf(messageText(message))
      if (reply !== null) byCall.set(reply.callId, reply)
    }
    return byCall
  }, [messages])
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
  const lastRun = model.runs.at(-1)
  const lastRunKey = lastRun?.key
  // DSH mounts its running status at the end of the flow; ZCode decides whether the
  // turn-tail spinner may show at all. Both point at the same place: the transcript tail.
  const tailLoading = turnChatLoadingVisible({
    isRunning: running,
    blockedByInteraction: interactionBlocksTurnLoading(interactions),
    blockedByActiveWork: compactionRunning,
  })
  return (
    <div className={css.transcript} data-message-column>
      <PluginUiConversationContext.Provider value={conversationId}>
      <ProcessExpansionProvider key={conversationId}>
      <MarkdownDelegateProvider openFile={openMarkdownFile} fileImages={fileImages}>
        {model.timeline.map(entry => entry.kind === 'run'
          ? <RunTranscript key={entry.run.key} run={entry.run} latest={entry.run.key === lastRunKey}
            liveCompaction={compactionRunning && entry.run.key === lastRunKey} policy={presentation}
            onFork={onFork} onRetry={onRetry} onFeedback={onFeedback} onOpenFile={onOpenFile}
            onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent} onOpenPlan={onOpenPlan}
            onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext} onPluginMessage={onPluginMessage}
            onPluginOpenLink={onPluginOpenLink}
            resolveFileImage={resolveFileImage} labels={labels} t={t}
            showChanges={showChanges} replies={replies} interactions={interactions} />
          : <SystemMessageRow key={entry.row.key} message={entry.row.message} />)}
        {compactionRunning && lastRunKey === undefined && <CompactionRunningRow t={t} />}
        {pending.map(message => <PendingRow key={message.id} message={message} onOpenFile={onOpenFile} t={t} />)}
        {tailLoading && <TurnRunningIndicator t={t} />}
      </MarkdownDelegateProvider>
      </ProcessExpansionProvider>
      </PluginUiConversationContext.Provider>
    </div>
  )
}

/**
 * The transcript-tail spinner, shaped like ZCode's `ChatLoading`: a lone rotating icon
 * with no caption, because the process group already names the live work. The rotation
 * lives on the HTML wrapper rather than on the SVG, so the animation stays on the
 * compositor instead of re-triggering main-thread style updates every frame.
 */
function TurnRunningIndicator({ t }: { t: Translate }) {
  return (
    <div className={css.runningIndicator} role="status" aria-live="polite" aria-label={t('加载中', 'Loading')}>
      <span className={css.runningIndicatorIcon} aria-hidden="true">
        <IconLoadingOutlineRegular size={16} />
      </span>
    </div>
  )
}

/** One recorded system message, rendered as the transcript's own status row. */
function SystemMessageRow({ message }: { message: ChatMessage }) {
  return <div className={css.systemMessage}>{messageText(message)}</div>
}

/** The live compaction marker; it belongs to the turn that is compacting. */
function CompactionRunningRow({ t }: { t: Translate }) {
  return (
    <div className={`${css.systemMessage} ${css.compactionRunning}`} role="status" aria-live="polite">
      <span className={css.compactionSpinner} aria-hidden="true" />
      <span>{t('正在进行上下文压缩', 'Context compaction in progress')}</span>
    </div>
  )
}


function RunTranscript({
  run, latest, liveCompaction, policy, onFork, onRetry, onFeedback, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan,
  onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage, labels, t, showChanges, replies, interactions,
}: {
  run: RenderRun
  latest: boolean
  /** The live compaction marker belongs to the turn that is compacting. */
  liveCompaction: boolean
  policy: ChatPresentationPolicy
  onFork?: TranscriptProps['onFork']
  onRetry?: TranscriptProps['onRetry']
  onFeedback?: TranscriptProps['onFeedback']
  onOpenFile?: TranscriptProps['onOpenFile']
  onInspectDiff?: TranscriptProps['onInspectDiff']
  onOpenTool?: TranscriptProps['onOpenTool']
  onOpenSubagent?: TranscriptProps['onOpenSubagent']
  onOpenPlan?: TranscriptProps['onOpenPlan']
  onOpenPluginUi?: TranscriptProps['onOpenPluginUi']
  onPluginContext?: TranscriptProps['onPluginContext']
  onPluginMessage?: TranscriptProps['onPluginMessage']
  onPluginOpenLink?: TranscriptProps['onPluginOpenLink']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  labels: ReturnType<typeof markdownLabels>
  t: Translate
  showChanges: boolean
  replies: ReadonlyMap<string, LateAnswer>
  interactions?: readonly InteractionRequest[]
}) {
  return (
    <section className={css.run} data-run-id={run.runId}>
      {run.users[0] !== undefined && <UserEntryRow key={run.users[0].id} message={run.users[0]}
        onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} />}
      {(run.process.length > 0 || run.status === 'error' || run.status === 'cancelled') && (
        <ProcessGroup run={run} latest={latest} policy={policy} t={t}
          onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent}
          onOpenPlan={onOpenPlan} onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext}
          onPluginMessage={onPluginMessage} onPluginOpenLink={onPluginOpenLink}
          resolveFileImage={resolveFileImage} labels={labels} replies={replies} interactions={interactions} />
      )}
      {run.systemRows.filter(row => row.beforeAnswer).map(row => <SystemMessageRow key={row.key} message={row.message} />)}
      {run.responses.map((response, index) => (
        <AssistantResponse key={response.key} response={response} run={run} last={index === run.responses.length - 1}
          showChanges={showChanges} onInspectDiff={onInspectDiff}
          onFork={onFork} onRetry={onRetry} onFeedback={onFeedback} onOpenFile={onOpenFile}
          labels={labels} resolveFileImage={resolveFileImage} t={t} />
      ))}
      {run.systemRows.filter(row => !row.beforeAnswer).map(row => <SystemMessageRow key={row.key} message={row.message} />)}
      {/* DSH's turn-tail plan card (`ui-plan/index.ts:79-96`) is carried by the
          `exit_plan_mode` tool row, which renders the same card in its body. */}
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
      {liveCompaction && <CompactionRunningRow t={t} />}
    </section>
  )
}

/**
 * DSH's turn-tail plan card (`ui-plan/index.ts:79-96`, `PlanCard.tsx:43-60`) sits at the end of
 * the turn that submitted the plan; in Pi the plan lives on the `exit_plan_mode` tool row, which
 * already carries the same "计划 · Markdown" label and heading title, so the card is rendered
 * there (`ToolCard.tsx`) instead of being duplicated after the answer.
 */
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

/**
 * Render one user-role transcript entry: a late answer to earlier questions
 * presents as DSH's reply bubble, a dismissal of a question set presents as the
 * compact "gave up the questions" bubble, and every other message stays the plain
 * bubble. A payload the reader cannot parse keeps its raw text, so a reply is
 * never shown as an empty row.
 */
function UserEntryRow({ message, onOpenFile, resolveFileImage, t }: {
  message: ChatMessage
  onOpenFile?: TranscriptProps['onOpenFile']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  t: Translate
}) {
  const text = useMemo(() => messageText(message), [message])
  const reply = useMemo(() => lateAnswerOf(text), [text])
  const dismissal = useMemo(() => reply === null ? dismissedQuestionOf(text) : null, [reply, text])
  if (reply !== null) return <QuestionReplyRow message={message} data={reply} t={t} />
  if (dismissal !== null) return <QuestionDismissedRow message={message} t={t} />
  return <MessageRow message={message} onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} />
}

/**
 * DSH has no user message for a cancelled question set (its waterfall rejects with
 * `ASK_CANCELLED`), while Pi steers the dismissal so the model learns about it. The
 * transcript shows that steer as a compact bubble rather than the raw payload.
 */
function QuestionDismissedRow({ message, t }: {
  message: ChatMessage
  t: Translate
}) {
  const { settings } = useUiPreferences()
  const [copied, setCopied] = useState(false)
  const label = t('放弃整组问题', 'Dismissed the questions')
  const summary = t('未提交回答', 'No answers submitted')
  const copy = (): void => {
    if (copied) return
    void writeClipboard(`${label} · ${summary}`).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }
  return (
    <div className={`${css.message} ${css.userMessage}`} id={transcriptMessageDomId(message.id)} data-message-id={message.id}
      data-role="user" data-question-dismissed role="group" aria-label={label}>
      <div className={css.replyBubble}>
        <span className={css.replyLabelRow}>
          <span className={css.replyLabel}>{label}</span>
        </span>
        <span className={css.replySummary}>{summary}</span>
      </div>
      <div className={css.userMeta}>
        <time dateTime={safeIsoTime(message.timestamp)}>{formatClock(message.timestamp, settings.locale)}</time>
        <Tooltip label={copied ? t('已复制', 'Copied') : t('复制', 'Copy')} side="bottom" portal>
          <button type="button" className={css.iconAction} aria-label={t('复制问答放弃记录', 'Copy the dismissal')} onClick={copy}>
            {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
          </button>
        </Tooltip>
        <span className={css.visuallyHidden} aria-live="polite">{copied ? t('已复制', 'Copied') : ''}</span>
      </div>
    </div>
  )
}

/**
 * DSH's right-aligned late-reply bubble: a label naming the earlier pending
 * questions, the answers as a one-line summary, and — once open — one question
 * and answer pair per question. What the payload cannot express falls back to
 * the model-facing text.
 */
function QuestionReplyRow({ message, data, t }: {
  message: ChatMessage
  data: LateAnswer
  t: Translate
}) {
  const { settings } = useUiPreferences()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const label = t('回答先前等待的问题', 'Reply to earlier pending questions')
  const rows = useMemo(() => lateAnswerRows(data), [data])
  const summary = lateAnswerSummary(data, t)
  const copy = (): void => {
    if (copied) return
    void writeClipboard(lateAnswerClipboardText(data, t)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }
  return (
    <div className={`${css.message} ${css.userMessage}`} id={transcriptMessageDomId(message.id)} data-message-id={message.id}
      data-role="user" data-question-reply={data.callId} role="group" aria-label={label}>
      <div className={css.replyBubble}>
        <button type="button" className={css.replyToggle} aria-expanded={open}
          aria-label={`${label} · ${t(open ? '收起问题详情' : '展开问题详情', open ? 'Close question details' : 'Open question details')}`}
          onClick={() => { setOpen(value => !value) }}>
          <span className={css.replyLabelRow}>
            {/* The caret is the only sign the bubble opens; the label alone reads as plain text. */}
            <span className={css.replyCaret} aria-hidden="true">
              {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
            </span>
            <span className={css.replyLabel}>{label}</span>
          </span>
          {!open && <span className={css.replySummary}>{summary === '' ? t('已跳过', 'Skipped') : summary}</span>}
        </button>
        {open && (rows.length === 0
          ? <div className={css.replyText}>{data.text}</div>
          : <dl className={css.replyDetails}>
            {rows.map(({ question, answers }) => (
              <div key={question.id}>
                <dt className={css.replyQuestion}>
                  {question.header !== undefined && question.header !== question.question && <span className={css.replyHeader}>{question.header}</span>}
                  <span className={css.replyQuestionText}>{question.question}</span>
                  {question.detail !== undefined && <span className={css.replyDetail}>{question.detail}</span>}
                  {question.options !== undefined && question.options.length > 0 && <ul className={css.replyOptions}>
                    {question.options.map(option => <li key={option.label}>{option.label}{option.description === undefined ? '' : ` — ${option.description}`}</li>)}
                  </ul>}
                </dt>
                <dd className={css.replyAnswer}>
                  <span className={css.replyAnswerLabel}>{t('回答：', 'Answer: ')}</span>
                  {answers.length === 0 ? t('已跳过', 'Skipped') : answers.join(t('、', ', '))}
                </dd>
              </div>
            ))}
          </dl>)}
      </div>
      <div className={css.userMeta}>
        <time dateTime={safeIsoTime(message.timestamp)}>{formatClock(message.timestamp, settings.locale)}</time>
        <Tooltip label={copied ? t('已复制', 'Copied') : t('复制', 'Copy')} side="bottom" portal>
          <button type="button" className={css.iconAction} aria-label={t('复制问答回答', 'Copy the question reply')} onClick={copy}>
            {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
          </button>
        </Tooltip>
        <span className={css.visuallyHidden} aria-live="polite">{copied ? t('已复制', 'Copied') : ''}</span>
      </div>
    </div>
  )
}

function ProcessGroup({ run, latest, policy, t, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan,
  onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage, labels, replies, interactions }: {
  run: RenderRun
  latest: boolean
  policy: ChatPresentationPolicy
  t: Translate
  onOpenFile?: TranscriptProps['onOpenFile']
  onInspectDiff?: TranscriptProps['onInspectDiff']
  onOpenTool?: TranscriptProps['onOpenTool']
  onOpenSubagent?: TranscriptProps['onOpenSubagent']
  onOpenPlan?: TranscriptProps['onOpenPlan']
  onOpenPluginUi?: TranscriptProps['onOpenPluginUi']
  onPluginContext?: TranscriptProps['onPluginContext']
  onPluginMessage?: TranscriptProps['onPluginMessage']
  onPluginOpenLink?: TranscriptProps['onPluginOpenLink']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  labels: ReturnType<typeof markdownLabels>
  replies: ReadonlyMap<string, LateAnswer>
  interactions?: readonly InteractionRequest[]
}) {
  const live = run.status === 'running'
  const hasInterleavedUser = run.process.some(part => part.kind === 'user')
  // Keep a work header while preserving each display mode's default expansion.
  // Verbose mode remains flat and interleaved user messages stay visible.
  const grouped = policy.stepGrouping !== 'none'
  const defaultOpen = defaultProcessOpen(policy, latest, live, hasInterleavedUser)
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined)
  const open = hasInterleavedUser ? true : manualOpen ?? defaultOpen
  const bodyId = useId()
  const title = workGroupTitle(run, t)
  // Every tool keeps its own row; subagent rows open a read-only child tab instead of
  // folding into a separate strip.
  const body = run.process.map(part => <ProcessPartView key={part.key} part={part} runRunning={live}
    policy={policy} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent}
    onOpenPlan={onOpenPlan} onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext}
    onPluginMessage={onPluginMessage} onPluginOpenLink={onPluginOpenLink}
    resolveFileImage={resolveFileImage} labels={labels} t={t} replies={replies} interactions={interactions} />)
  if (!grouped) {
    return (
      <div className={css.processGroup} data-state={run.status} data-latest={latest || undefined} data-flat data-run-id={run.runId}>
        <div className={css.processFlatStatus} data-state={run.status}>
          <span className={css.processTitle} data-running={live || undefined}>{title}</span>
        </div>
        <div className={css.processFlatBody}>{body}</div>
      </div>
    )
  }
  return (
    <div className={css.processGroup} data-state={run.status} data-latest={latest || undefined} data-run-id={run.runId}>
      <button type="button" className={css.processHeader} aria-expanded={open} aria-controls={bodyId}
        disabled={hasInterleavedUser}
        onClick={() => { setManualOpen(value => !(value ?? defaultOpen)) }}>
        <span className={css.processTitle} data-running={live || undefined}>{title}</span>
        <ChevronRight className={css.processChevron} size={16} aria-hidden="true" data-open={open || undefined} />
      </button>
      <div id={bodyId} className={css.processCollapse} data-open={open || undefined} aria-hidden={!open} {...(!open ? { inert: '' } : {})}><div className={css.processClip}><div className={css.processBody}>{body}</div></div></div>
    </div>
  )
}

function ProcessPartView({ part, runRunning, policy, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan,
  onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage, labels, t, replies, interactions }: {
  part: ProcessPart
  runRunning: boolean
  policy: ChatPresentationPolicy
  onOpenFile?: TranscriptProps['onOpenFile']
  onInspectDiff?: TranscriptProps['onInspectDiff']
  onOpenTool?: TranscriptProps['onOpenTool']
  onOpenSubagent?: TranscriptProps['onOpenSubagent']
  onOpenPlan?: TranscriptProps['onOpenPlan']
  onOpenPluginUi?: TranscriptProps['onOpenPluginUi']
  onPluginContext?: TranscriptProps['onPluginContext']
  onPluginMessage?: TranscriptProps['onPluginMessage']
  onPluginOpenLink?: TranscriptProps['onPluginOpenLink']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  labels: ReturnType<typeof markdownLabels>
  t: Translate
  replies: ReadonlyMap<string, LateAnswer>
  interactions?: readonly InteractionRequest[]
}) {
  if (part.kind === 'user') return <UserEntryRow message={part.message} onOpenFile={onOpenFile}
    resolveFileImage={resolveFileImage} t={t} />
  if (part.kind === 'tool') return <ToolCard item={part.item} runRunning={runRunning} replies={replies} interactions={interactions}
    onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent}
    onOpenPlan={onOpenPlan} onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext}
    onPluginMessage={onPluginMessage} onPluginOpenLink={onPluginOpenLink} t={t} />
  if (part.kind === 'toolGroup') return <ProcessToolGroup groupKey={part.key} group={part.group} items={part.items}
    runRunning={runRunning} replies={replies} interactions={interactions} onOpenFile={onOpenFile}
    onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent} onOpenPlan={onOpenPlan} t={t} />
  if (part.kind === 'content') return <div className={css.processOutput} data-message-id={part.message.id}>
    <ContentBlockView block={part.block} streaming={part.streaming} answer
      onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} labels={labels} t={t} />
  </div>
  return <ReasoningBlock id={part.key} text={part.text} streaming={part.streaming} redacted={part.redacted} preview={policy.liveReasoningPreview} t={t} />
}

function AssistantResponse({ response, run, last, showChanges, onInspectDiff, onFork, onRetry, onFeedback, onOpenFile, labels, resolveFileImage, t }: {
  response: ResponsePart
  run: RenderRun
  last: boolean
  /** Whether the coding views (including the changed-files card) are on. */
  showChanges?: boolean
  onInspectDiff?: TranscriptProps['onInspectDiff']
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
  const [usageOpen, setUsageOpen] = useState(false)
  const text = responseText(response)
  const streaming = message.streaming === true || run.status === 'running'
  const entryId = message.entryId
  const mentionPaths = useMemo(() => [...new Set(run.artifacts
    .filter(artifact => artifact.kind !== 'read')
    .map(artifact => artifact.path))], [run.artifacts])
  const fileMentions = useMemo(() => {
    if (onOpenFile === undefined || mentionPaths.length === 0) return undefined
    return producedFileMentions(mentionPaths, path => { onOpenFile(path) }, path => t(`打开文件 ${path}`, `Open file ${path}`))
  }, [mentionPaths, onOpenFile, t])
  const pathImages = useMemo(() => {
    if (resolveFileImage === undefined) return undefined
    return { resolve: (value: string) => localPathMediaUrl(value, resolveFileImage) }
  }, [resolveFileImage])
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
        {response.blocks.map((block, index) => <ContentBlockView key={`${message.id}:response:${block.slot ?? index}`} block={block}
          streaming={streaming} answer onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} labels={labels}
          fileMentions={fileMentions} pathImages={pathImages} />)}
        {!streaming && run.status === 'cancelled' && <div className={css.runNotice} data-status="cancelled" role="status">
          {t('回答已停止', 'Response stopped')}
        </div>}
        {!streaming && run.status === 'error' && <div className={css.runNotice} data-status="error" role="alert">
          {t('回答失败', 'Response failed')}
        </div>}
        {/* DSH 的回合尾顺序：改动文件卡在操作栏之前，操作栏留在最后。 */}
        {last && showChanges === true && <ChangedFiles artifacts={run.artifacts} onInspectDiff={onInspectDiff} t={t} />}
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
          {last && run.usage !== undefined && <Menu open={usageOpen} onClose={() => { setUsageOpen(false) }} side="top" portal
            anchor={<button type="button" className={css.usage} aria-label={t(`用量 ${formatTokens(run.usage.totalTokens)} tok`, `Usage ${formatTokens(run.usage.totalTokens)} tokens`)}
              onClick={() => { setUsageOpen(value => !value) }}>
              <IconDatabaseOutlineRegular size={14} />{t(`用量 ${formatTokens(run.usage.totalTokens)} tok`, `${formatTokens(run.usage.totalTokens)} tok`)}
            </button>}>
            <UsageRow label={t('未缓存输入', 'Uncached input')} value={run.usage.input} onSelect={() => { setUsageOpen(false) }} />
            <UsageRow label={t('输出', 'Output')} value={run.usage.output} onSelect={() => { setUsageOpen(false) }} />
            <UsageRow label={t('缓存读取', 'Cache read')} value={run.usage.cacheRead} onSelect={() => { setUsageOpen(false) }} />
            {run.usage.cacheWrite > 0 && <UsageRow label={t('缓存写入', 'Cache write')} value={run.usage.cacheWrite} onSelect={() => { setUsageOpen(false) }} />}
            <UsageRow separatorBefore label={t('费用', 'Cost')} value={run.usage.cost.total} money onSelect={() => { setUsageOpen(false) }} />
          </Menu>}
          <time className={css.messageTime} dateTime={safeIsoTime(message.timestamp)}>{formatClock(message.timestamp, settings.locale)}</time>
          <span className={css.visuallyHidden} aria-live="polite">{copied ? t('已复制', 'Copied') : ''}</span>
        </div>
      </div>
    </div>
  )
}

function ContentBlockView({ block, streaming = false, plainText = false, answer = false, onOpenFile, resolveFileImage, t, labels, fileMentions, pathImages }: {
  block: ContentBlock
  streaming?: boolean
  plainText?: boolean
  answer?: boolean
  onOpenFile?: TranscriptProps['onOpenFile']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  t: Translate
  labels?: ReturnType<typeof markdownLabels>
  fileMentions?: MarkdownFileMentions
  pathImages?: MarkdownPathImages
}) {
  switch (block.type) {
    case 'text':
      return plainText ? <div className={css.userText}>{block.text}</div>
        : answer ? <AnswerMarkdown text={block.text} streaming={streaming} labels={labels ?? markdownLabels(t)} t={t}
          fileMentions={fileMentions} pathImages={pathImages} onOpenFile={onOpenFile} />
        : <MarkdownText text={block.text} streaming={streaming} labels={labels ?? markdownLabels(t)}
          fileMentions={fileMentions} pathImages={pathImages} />
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

function responseText(response: ResponsePart): string {
  return response.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** One read-only row of the turn usage panel. */
function UsageRow({ label, value, money = false, separatorBefore = false, onSelect }: {
  label: string
  value: number
  money?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}) {
  return <MenuItemButton separatorBefore={separatorBefore} onSelect={onSelect}>
    <span className={css.usageRow}><span>{label}</span><span>{money ? `$${value.toFixed(5)}` : value.toLocaleString()}</span></span>
  </MenuItemButton>
}

/** Resolve inline-code tokens that name a file this run wrote, matching DSH's mention vocabulary. */
function producedFileMentions(paths: readonly string[], open: (path: string) => void, label: (path: string) => string): MarkdownFileMentions {
  const onlyWithBasename = (value: string): string | undefined => {
    const matches = paths.filter(path => pathBasename(path) === value)
    return matches.length === 1 ? matches[0] : undefined
  }
  return {
    resolve(value) {
      const path = paths.includes(value) ? value : onlyWithBasename(value)
      if (path === undefined) return undefined
      return { open: () => { open(path) }, label: label(path), title: path }
    },
  }
}

function pathBasename(path: string): string {
  return path.split(/[/\\]/u).at(-1) ?? path
}

/** Turn an authored absolute image destination into this workspace's asset URL. */
function localPathMediaUrl(value: string, resolveFileImage: NonNullable<TranscriptProps['resolveFileImage']>): string | undefined {
  const file = parseAnswerFileLink(value)
  return file ? resolveFileImage(file.path) : undefined
}

function formatClock(timestamp: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}

function safeIsoTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) return undefined
  return new Date(timestamp).toISOString()
}

function formatFileSize(size: number, t: Translate): string {
  if (!Number.isFinite(size) || size < 0) return t('未知大小', 'Unknown size')
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function inspectorDiff(artifact: FileArtifact): InspectorDiff {
  return {
    path: artifact.path,
    ...(artifact.before === undefined ? {} : { oldText: artifact.before }),
    ...(artifact.after === undefined ? {} : { newText: artifact.after }),
    ...(artifact.diff === undefined ? {} : { diff: artifact.diff }),
  }
}

