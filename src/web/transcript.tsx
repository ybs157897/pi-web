import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconCopyOutlineRegular, IconDatabaseOutlineRegular, IconDislikeFillRegular,
  IconDislikeOutlineRegular, IconLikeFillRegular, IconLikeOutlineRegular, IconLoadingOutlineRegular, ImageLightbox, MarkdownDelegateProvider,
  Menu, MenuItemButton, IconRefreshOutlineRegular, MarkdownText, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatMessage, ContentBlock, FileArtifact, InteractionRequest, SubagentSummary } from '../shared/types.ts'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import ChangedFiles from './ChangedFiles.tsx'
import ToolCard from './ToolCard.tsx'
import { formatTokens, markdownLabels, type Translate } from './render-labels.ts'
import { buildRenderModel, interactionBlocksTurnLoading, messageText, transcriptMessageDomId, turnChatLoadingVisible, type ProcessPart, type RenderRun, type ResponsePart } from './render-model.ts'
import type { PlanDocument } from './plan-preview.ts'
import { presentationPolicyFor, type ChatPresentationPolicy } from './presentation-policy.ts'
import { lateAnswerOf, type LateAnswer } from './tool-render-model.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { ReasoningBlock } from './message-rendering/ReasoningBlock.tsx'
import { ProcessExpansionProvider } from './message-rendering/ProcessExpansion.tsx'
import { PluginUiConversationContext, showsInlinePluginUi } from './plugin-ui-bridge.ts'
import { parseAnswerFileLink } from './answer-markdown-model.ts'
import { ChevronRight, ListChecks } from 'lucide-react'
import './message-rendering/theme.css'
import { currentWorkLine, defaultProcessOpen, foldedProsePreview, otherActivitySummary, processGroupAutoOpen, processGroupBoundary, workGroupTitle, workSummaryCounts, workSummaryText } from './process-presentation.ts'
import SubagentRunStrip from './SubagentRunStrip.tsx'
import { groupSubagentRuns, type TranscriptPart } from './subagent-run-model.ts'
import css from './Transcript.module.css'

/** 已发送但尚未落盘的消息（乐观 UI）：气泡渲染用，状态为发送中/已接收。 */
export interface PendingMessage {
  id: string
  requestId: string
  submissionId?: string
  text: string
  images: Array<{ preview: string; mimeType: string; name?: string; path?: string; size?: number }>
  files?: Array<{ name: string; mimeType: string; size: number; path?: string; preview?: string }>
  status: 'sending' | 'accepted'
}

/** 交给 inspector 展示的文件 diff 载荷。 */
export interface InspectorDiff {
  path: string
  oldText?: string | null
  newText?: string
  diff?: string
}

/** Transcript 组件的全部输入与回调。 */
export interface TranscriptProps {
  messages: readonly ChatMessage[]
  /** 消息所属的会话；子智能体条带据此重读活跃孩子。 */
  conversationId?: string
  pending?: readonly PendingMessage[]
  /** 压缩进行中：渲染与会话级完成标记同款的转录状态行。 */
  compactionRunning?: boolean
  /** 会话存在活跃 run：尾部 spinner 表明转录仍在工作。 */
  running?: boolean
  /** 投影出的交互记录，让提问行读取其调用的 DSH 状态。 */
  interactions?: readonly InteractionRequest[]
  /** 会话的直接子智能体投影；作为条带首帧，随后由条带自己的轮询刷新。 */
  subagents?: readonly SubagentSummary[]
  /** 工作详情呈现策略；缺省用已保存设置。 */
  policy?: ChatPresentationPolicy
  onFork?: (entryId: string) => void
  onRetry?: (entryId: string) => void
  onFeedback?: (entryId: string, rating: 'up' | 'down' | null) => void
  onOpenFile?: (path: string, line?: number) => void
  onInspectDiff?: (diff: InspectorDiff) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
  /** 把 `subagent` 行创建的子会话作为只读 inspector tab 打开。 */
  onOpenSubagent?: (conversationId: string, title?: string) => void
  /** 在 inspector 计划视图中打开已提交计划；`auto` 标记 DSH 的唯一一次自动打开。 */
  onOpenPlan?: (plan: PlanDocument, auto?: boolean) => void
  /** 在 inspector 打开插件 UI 页面；fullscreen 表面时行调用一次，内联卡片传入宿主让两表面共用一个 iframe。 */
  onOpenPluginUi?: (page: PluginUiPage, host?: HTMLElement) => void
  /** 内联插件页的 context/消息/链接中继。 */
  onPluginContext?: (entry: PluginContextEntry) => void
  onPluginMessage?: (text: string) => void
  onPluginOpenLink?: (url: string) => void
  resolveFileImage?: (path: string) => string | undefined
}

/**
 * 功能：转录区主组件——用对齐 ZCode 的消息与工作组件渲染宿主持有的会话状态。
 * @param props 见 TranscriptProps
 * 内部逻辑：buildRenderModel 把消息切分成 run/时间线；迟到应答按 callId 建索引（reply 气泡从自己的消息读，工具行用调用的应答结算）；呈现策略缺省取设置；尾部 spinner 由 turnChatLoadingVisible 决定；压缩进行中显示状态行。
 */
export default function Transcript({
  messages, conversationId, pending = [], compactionRunning = false, running = false, interactions, policy, subagents, onFork, onRetry, onFeedback,
  onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan, onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage,
}: TranscriptProps) {
  const { settings, t } = useUiPreferences()
  const presentation = policy ?? presentationPolicyFor(settings.transcriptView, settings.collapseTiming)
  const model = useMemo(() => buildRenderModel(messages, interactions), [messages, interactions])
  // 迟到应答按其提问调用建索引：reply 气泡从自己的消息读取，工具行用其调用的应答结算。
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
  // 子智能体条带的活跃孩子：投影作种子，有孩子仍在运行时 1.5s 轮询刷新，
  // chip 状态保持更新而无需重新投影整个会话。
  const liveSubagents = useLiveSubagents(conversationId, subagents)
  // DSH 把运行状态挂在流程末尾；ZCode 决定回合尾 spinner 是否允许显示。
  // 两者指向同一位置：转录尾部。
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
          ? <RunTranscript key={entry.run.key} run={entry.run} latest={entry.run.key === lastRunKey} live={running && entry.run.key === lastRunKey}
            liveCompaction={compactionRunning && entry.run.key === lastRunKey} policy={presentation}
            subagents={liveSubagents}
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
 * The conversation's live subagent list. The parent projection seeds it; while any child
 * still runs, a 1.5-second poll keeps the strip's chips fresh without waiting for the
 * parent's next full projection. A settled list stops polling.
 */
function useLiveSubagents(conversationId: string | undefined, projected: readonly SubagentSummary[] | undefined) {
  const [rows, setRows] = useState<readonly SubagentSummary[]>(() => projected ?? [])
  useEffect(() => { setRows(projected ?? []) }, [projected])
  const running = rows.some(row => row.status === 'running')
  useEffect(() => {
    if (conversationId === undefined || !running) return
    let active = true
    const timer = window.setInterval(() => {
      api.listChildren(conversationId).then(next => { if (active) setRows(next) }).catch(() => undefined)
    }, 1_500)
    return () => { active = false; window.clearInterval(timer) }
  }, [conversationId, running])
  return rows
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

/** 一条已记录的系统消息，渲染为转录自己的状态行。 */
function SystemMessageRow({ message }: { message: ChatMessage }) {
  return <div className={css.systemMessage}>{messageText(message)}</div>
}

/** 活跃压缩标记；归属正在压缩的回合。 */
function CompactionRunningRow({ t }: { t: Translate }) {
  return (
    <div className={`${css.systemMessage} ${css.compactionRunning}`} role="status" aria-live="polite">
      <span className={css.compactionSpinner} aria-hidden="true" />
      <span>{t('正在进行上下文压缩', 'Context compaction in progress')}</span>
    </div>
  )
}


/**
 * 功能：单个 run 的转录段：首条用户行 → 工作分组 → 答案前的系统行 → 各段响应 →
 * 答案后的系统行 → 失败/停止重试条 → 活跃压缩标记。
 * @param run 渲染 run
 * @param latest 是否为最新 run
 * @param live 会话仍在运行这个最新回合
 * @param liveCompaction 活跃压缩标记归属正在压缩的回合
 * @param policy 呈现策略（透传给 ProcessGroup）
 * 其余参数为各类回调与共享载荷（replies/interactions/labels）。
 */
function RunTranscript({
  run, latest, live, liveCompaction, policy, subagents, onFork, onRetry, onFeedback, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan,
  onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage, labels, t, showChanges, replies, interactions,
}: {
  run: RenderRun
  latest: boolean
  /** 会话仍在运行这个最新回合。 */
  live: boolean
  /** 活跃压缩标记归属正在压缩的回合。 */
  liveCompaction: boolean
  policy: ChatPresentationPolicy
  subagents?: readonly SubagentSummary[]
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
  const filePaths = useMemo(() => {
    const paths = new Set<string>()
    for (const message of run.messages) {
      if (message.isError || message.status === 'error' || message.status === 'cancelled') continue
      for (const artifact of message.artifacts ?? []) paths.add(artifact.path)
      for (const block of message.blocks) if (block.type === 'file') paths.add(block.path)
    }
    return [...paths]
  }, [run.messages])
  return (
    <section className={css.run} data-run-id={run.runId}>
      {run.users[0] !== undefined && <MessageRow key={run.users[0].id} message={run.users[0]}
        onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} t={t} />}
      {(run.process.length > 0 || run.status === 'error' || run.status === 'cancelled') && (
        <ProcessGroup run={run} latest={latest} live={live} policy={policy} t={t} subagents={subagents}
          onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent}
          onOpenPlan={onOpenPlan} onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext}
          onPluginMessage={onPluginMessage} onPluginOpenLink={onPluginOpenLink}
          resolveFileImage={resolveFileImage} filePaths={filePaths} labels={labels} replies={replies} interactions={interactions} />
      )}
      {run.systemRows.filter(row => row.beforeAnswer).map(row => <SystemMessageRow key={row.key} message={row.message} />)}
      {run.responses.map((response, index) => (
        <AssistantResponse key={response.key} response={response} run={run} last={index === run.responses.length - 1} live={live}
          showChanges={showChanges} onInspectDiff={onInspectDiff}
          onFork={onFork} onRetry={onRetry} onFeedback={onFeedback} onOpenFile={onOpenFile}
          labels={labels} resolveFileImage={resolveFileImage} filePaths={filePaths} t={t} />
      ))}
      {run.systemRows.filter(row => !row.beforeAnswer).map(row => <SystemMessageRow key={row.key} message={row.message} />)}
      {/* DSH 的回合尾计划卡（`ui-plan/index.ts:79-96`）由 `exit_plan_mode` 工具行承载，
          该行在自身正文里渲染同一张卡。 */}
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
 * DSH 的回合尾计划卡（`ui-plan/index.ts:79-96`、`PlanCard.tsx:43-60`）位于提交计划的回合末尾；
 * Pi 中计划挂在 `exit_plan_mode` 工具行上，该行已带同样的「计划 · Markdown」标签与标题，
 * 因此卡片在那里渲染（`ToolCard.tsx`），而不在答案后重复一份。
 */
/**
 * 功能：用户消息气泡行：内容块按纯文本渲染，带时间戳与复制按钮。
 * @param message 用户消息
 * @param onOpenFile 打开文件回调（文件块点击）
 * @param resolveFileImage 工作区图片地址解析
 * @param t 双语标签函数
 * 内部逻辑：无可见内容块不渲染；复制走 navigator.clipboard，1.5s 恢复按钮态。
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
 * 功能：一个 run 的工作分组：可折叠头（标题 + 可选正文预览）与过程体。
 * @param run 渲染 run
 * @param latest / live 驱动自动展开的边界事实
 * @param policy 呈现策略（stepGrouping 决定折叠形态，liveReasoningPreview 传给思考块）
 * @param subagents 会话的活跃子智能体投影（供内联条带）
 * 其余为过程部件渲染所需的回调与载荷。
 * 内部逻辑：autoOpen 只在 live/latest 边界移动（run 接管/落定/被取代），manualOpen 记录用户手动翻转；夹带用户输入时强制展开。折叠时头部优先显示正文预览，其次显示调用计数；成功的内联插件页固定在折叠区外，连续子智能体调用折叠成条带。
 */
function ProcessGroup({ run, latest, live, policy, t, subagents, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan,
  onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage, filePaths, labels, replies, interactions }: {
  run: RenderRun
  latest: boolean
  /** 会话仍在运行这个最新回合。 */
  live: boolean
  policy: ChatPresentationPolicy
  t: Translate
  /** 会话的活跃子智能体投影，供内联条带使用。 */
  subagents?: readonly SubagentSummary[]
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
  filePaths: readonly string[]
  labels: ReturnType<typeof markdownLabels>
  replies: ReadonlyMap<string, LateAnswer>
  interactions?: readonly InteractionRequest[]
}) {
  const hasInterleavedUser = run.process.some(part => part.kind === 'user')
  // 保留工作头部同时遵循各显示档的默认展开。
  // verbose 保持平铺，交错用户消息保持可见。
  const grouped = policy.stepGrouping !== 'none'
  // 自动展开态只在 live/latest 边界移动（run 接管、落定或被取代）；普通重投影帧
  // 保持原值，分组不会自己开合抖动。
  const [autoOpen, setAutoOpen] = useState(() => defaultProcessOpen(policy, latest, live, hasInterleavedUser))
  const previousFrame = useRef({ live, latest })
  useEffect(() => {
    const was = previousFrame.current
    if (was.live === live && was.latest === latest) return
    previousFrame.current = { live, latest }
    const boundary = processGroupBoundary(was, { live, latest })
    const settledOpen = defaultProcessOpen(policy, latest, false, hasInterleavedUser)
    setAutoOpen(current => processGroupAutoOpen(current, boundary, settledOpen))
  }, [live, latest, policy, hasInterleavedUser])
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined)
  const open = hasInterleavedUser ? true : manualOpen ?? autoOpen
  const bodyId = useId()
  const title = workGroupTitle(run, t, live)
  // ZCode summary group：折叠头两层——「已工作 X」在上，统计文案（或运行中的当前动作）在下；
  // 模型在工具轮之间写的说明另起一行，折叠时也保持可见（ZCode 把它们放在组外）。
  const statistics = workSummaryText(workSummaryCounts(run), t, live) ?? otherActivitySummary(run, t)
  const prose = open ? undefined : foldedProsePreview(run)
  const liveLine = open || !live ? undefined : currentWorkLine(run, t, live)
  const statisticsLine = open ? undefined
    : liveLine ?? statistics ?? (live || prose !== undefined ? undefined : t('思考', 'Reasoning'))
  const describedBy = statisticsLine === undefined && prose === undefined ? undefined : `${bodyId}-summary`
  // ZCode 把带内联插件页的成功工具行留在折叠历史区之外。否则分组收起时页面
  // 会消失，最终答案顶替它的位置。
  type ToolPart = Extract<ProcessPart, { kind: 'tool' }>
  const pinned = grouped
    ? run.process.filter((part): part is ToolPart => part.kind === 'tool'
      && showsInlinePluginUi(part.item.result?.details, part.item.result))
    : []
  const inline = pinned.length === 0 ? run.process : run.process.filter(part => !pinned.includes(part as ToolPart))
  // 连续的子智能体调用在此折叠成内联条带（codemode 调用会把嵌套子智能体提升成
  // 自己的条带）；其余部件原样通过。
  const parts = useMemo(
    () => groupSubagentRuns(inline, t, live, subagents),
    [inline, t, live, subagents],
  )
  const renderPart = (part: TranscriptPart): JSX.Element => part.kind === 'subagentRun'
    ? <SubagentRunStrip key={part.key} group={part} summaries={subagents} t={t} onOpen={onOpenSubagent} />
    : <ProcessPartView key={part.key} part={part} runRunning={live}
      policy={policy} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent}
      onOpenPlan={onOpenPlan} onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext}
      onPluginMessage={onPluginMessage} onPluginOpenLink={onPluginOpenLink}
      resolveFileImage={resolveFileImage} filePaths={filePaths} labels={labels} t={t} replies={replies} interactions={interactions} />
  const body = parts.map(renderPart)
  const pinnedBody = pinned.map(renderPart)
  if (!grouped) {
    return (
      <div className={css.processGroup} data-state={live ? 'running' : run.status} data-live={live || undefined} data-latest={latest || undefined} data-flat data-run-id={run.runId}>
        <div className={css.processFlatStatus} data-state={run.status}>
          <span className={css.processTitle} data-running={live || undefined}>{title}</span>
        </div>
        <div className={css.processFlatBody}>{body}</div>
      </div>
    )
  }
  return <>
    {inline.length > 0 && <div className={css.processGroup} data-state={live ? 'running' : run.status} data-live={live || undefined} data-latest={latest || undefined} data-run-id={run.runId}>
      <button type="button" className={css.processHeader} aria-expanded={open} aria-controls={bodyId}
        aria-labelledby={`${bodyId}-title`} aria-describedby={describedBy}
        disabled={hasInterleavedUser}
        onClick={() => { setManualOpen(value => !(value ?? autoOpen)) }}>
        <span className={css.processTitleRow}>
          <span id={`${bodyId}-title`} className={css.processTitle} data-running={live || undefined}>{title}</span>
          <ChevronRight className={css.processChevron} size={16} aria-hidden="true" data-open={open || undefined} />
        </span>
        {statisticsLine !== undefined && <span id={`${bodyId}-summary`} className={css.processPreviewRow} data-process-statistics="">
          <ListChecks className={css.processPreviewIcon} size={14} aria-hidden="true" />
          <span className={css.processPreview} title={statisticsLine}>{statisticsLine}</span>
        </span>}
        {prose !== undefined && <span className={css.processProseRow} data-process-preview="" title={prose}>{prose}</span>}
      </button>
      <div id={bodyId} className={css.processCollapse} data-open={open || undefined} aria-hidden={!open} {...(!open ? { inert: '' } : {})}><div className={css.processClip}><div className={css.processBody} data-work-list>{body}</div></div></div>
    </div>}
    {pinnedBody.length > 0 && <div className={css.pinnedProcess} data-pinned-plugin-ui>{pinnedBody}</div>}
  </>
}

/**
 * 功能：单个过程部件的分派渲染：user → 消息行；tool → 工具行；content → 过程正文；reasoning → 思考块。
 * @param part 过程部件
 * @param runRunning run 是否在运行（影响工具行状态）
 * 其余为透传回调与载荷。
 */
function ProcessPartView({ part, runRunning, policy, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan,
  onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink, resolveFileImage, filePaths, labels, t, replies, interactions }: {
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
  filePaths: readonly string[]
  labels: ReturnType<typeof markdownLabels>
  t: Translate
  replies: ReadonlyMap<string, LateAnswer>
  interactions?: readonly InteractionRequest[]
}) {
  if (part.kind === 'user') return <MessageRow message={part.message} onOpenFile={onOpenFile}
    resolveFileImage={resolveFileImage} t={t} />
  if (part.kind === 'tool') return <ToolCard item={part.item} runRunning={runRunning} replies={replies} interactions={interactions}
    onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent}
    onOpenPlan={onOpenPlan} onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext}
    onPluginMessage={onPluginMessage} onPluginOpenLink={onPluginOpenLink} t={t} />
  if (part.kind === 'content') return <div className={css.processOutput} data-message-id={part.message.id}>
    <ContentBlockView block={part.block} streaming={part.streaming} answer
      onOpenFile={onOpenFile} resolveFileImage={resolveFileImage} filePaths={filePaths} labels={labels} t={t} />
  </div>
  return <ReasoningBlock id={part.key} text={part.text} streaming={part.streaming} redacted={part.redacted} preview={policy.liveReasoningPreview} t={t} />
}

/**
 * 功能：一段助手响应：Markdown 答案 + 失败/停止提示 + 改动文件卡 + 操作栏
 * （复制、点赞点踩、分叉、重试、用量菜单、时间戳）。
 * @param response 响应段（一条助手消息的内容块）
 * @param run 所属 run（状态/产物/usage）
 * @param last 是否为本 run 最后一段响应（重试/改动文件/用量只挂最后一段）
 * @param live 会话仍在运行这个最新回合
 * @param showChanges 是否开启编码视图（含改动文件卡）
 * 内部逻辑：streaming = 消息流式或 run 状态 running 或会话 live——run 状态在两次工具轮之间会短暂回落 completed，会话级 live 让末态操作、用量与改动文件保持隐藏直到真正落定。
 */
function AssistantResponse({ response, run, last, live, showChanges, onInspectDiff, onFork, onRetry, onFeedback, onOpenFile, labels, resolveFileImage, filePaths, t }: {
  response: ResponsePart
  run: RenderRun
  last: boolean
  /** 会话仍在运行这个最新回合。 */
  live: boolean
  /** 编码视图（含改动文件卡）是否开启。 */
  showChanges?: boolean
  onInspectDiff?: TranscriptProps['onInspectDiff']
  onFork?: TranscriptProps['onFork']
  onRetry?: TranscriptProps['onRetry']
  onFeedback?: TranscriptProps['onFeedback']
  onOpenFile?: TranscriptProps['onOpenFile']
  labels: ReturnType<typeof markdownLabels>
  resolveFileImage?: TranscriptProps['resolveFileImage']
  filePaths: readonly string[]
  t: Translate
}) {
  const { settings } = useUiPreferences()
  const message = response.message
  const [copied, setCopied] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const text = responseText(response)
  // run 状态在两次工具轮之间会回落为 completed；会话级 live 标志让末态操作、
  // 用量与改动文件保持隐藏，直到回合真正落定。
  const streaming = message.streaming === true || run.status === 'running' || live
  const entryId = message.entryId
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
          filePaths={filePaths} pathImages={pathImages} />)}
        {!streaming && run.status === 'cancelled' && <div className={css.runNotice} data-status="cancelled" role="status">
          {t('回答已停止', 'Response stopped')}
        </div>}
        {!streaming && run.status === 'error' && <div className={css.runNotice} data-status="error" role="alert">
          {t('回答失败', 'Response failed')}
        </div>}
        {/* DSH 的回合尾顺序：改动文件卡在操作栏之前，操作栏留在最后。 */}
        {last && !streaming && showChanges === true && <ChangedFiles artifacts={run.artifacts} onInspectDiff={onInspectDiff} t={t} />}
        {!streaming && <div className={css.actionRow}>
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
        </div>}
      </div>
    </div>
  )
}

/**
 * 功能：单个内容块的渲染分派：text 按场景（用户纯文本 / 答案 Markdown / 过程 Markdown）；
 * thinking 与 toolCall 在转录区由专用组件渲染，这里返回 null；image → 灯箱；file → 文件 chip。
 * @param block 内容块
 * @param streaming 该块是否流式
 * @param plainText 用户气泡内的纯文本模式
 * @param answer 答案区模式（用 AnswerMarkdown，带文件提及与图片路径解析）
 */
function ContentBlockView({ block, streaming = false, plainText = false, answer = false, onOpenFile, resolveFileImage, t, labels, filePaths, pathImages }: {
  block: ContentBlock
  streaming?: boolean
  plainText?: boolean
  answer?: boolean
  onOpenFile?: TranscriptProps['onOpenFile']
  resolveFileImage?: TranscriptProps['resolveFileImage']
  t: Translate
  labels?: ReturnType<typeof markdownLabels>
  filePaths?: readonly string[]
  pathImages?: MarkdownPathImages
}) {
  switch (block.type) {
    case 'text':
      return plainText ? <div className={css.userText}>{block.text}</div>
        : answer ? <AnswerMarkdown text={block.text} streaming={streaming} labels={labels ?? markdownLabels(t)} t={t}
          filePaths={filePaths} pathImages={pathImages} onOpenFile={onOpenFile} />
        : <MarkdownText text={block.text} streaming={streaming} labels={labels ?? markdownLabels(t)}
          pathImages={pathImages} />
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

/** 可点击放大的图片块：缩略按钮 + DSH ImageLightbox 全屏预览。 */
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

/**
 * 功能：消息里的文件块：图片类型解析出预览地址走 ImageBlock；否则渲染文件 chip
 * （字形 + 文件名 + 大小），点击经 onOpenFile 打开。
 */
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

/**
 * 功能：乐观 UI 的「待落盘」消息行：渲染发送中的文本、图片/文件附件与状态（发送中/已接收）。
 */
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

/** 响应段的纯文本（只收 text 块），供复制按钮使用。 */
function responseText(response: ResponsePart): string {
  return response.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** 用量菜单里的一行只读数据（label + 数值/金额）。 */
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

/** 把模型写出的图片目标地址解析成本工作区的资产 URL。 */
function localPathMediaUrl(value: string, resolveFileImage: NonNullable<TranscriptProps['resolveFileImage']>): string | undefined {
  const file = parseAnswerFileLink(value)
  return file ? resolveFileImage(file.path) : undefined
}

/** 消息时间戳的 HH:mm 展示（24 小时制，按 UI 语言选 locale）。 */
function formatClock(timestamp: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}

/** 时间戳的 ISO 形式（供 `<time dateTime>`）；非法时间返回 undefined。 */
function safeIsoTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp).getTime())) return undefined
  return new Date(timestamp).toISOString()
}

/** 文件大小的 B/KB/MB 展示；非法尺寸显示「未知大小」。 */
function formatFileSize(size: number, t: Translate): string {
  if (!Number.isFinite(size) || size < 0) return t('未知大小', 'Unknown size')
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** 把文件产物转换成 inspector 的 diff 载荷。 */
function inspectorDiff(artifact: FileArtifact): InspectorDiff {
  return {
    path: artifact.path,
    ...(artifact.before === undefined ? {} : { oldText: artifact.before }),
    ...(artifact.after === undefined ? {} : { newText: artifact.after }),
    ...(artifact.diff === undefined ? {} : { diff: artifact.diff }),
  }
}

