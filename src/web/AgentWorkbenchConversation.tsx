import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ClipboardList, FolderOpen } from 'lucide-react'
import type { ChatMessage, ConversationDetail, ModelCatalog, ModelOption, ThinkingLevel } from '../shared/types.ts'
import type { WorkbenchAgent, WorkbenchReplyInput, WorkItem, WorkItemEvidence } from '../shared/workbench.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import Composer from './Composer.tsx'
import ConversationFailureNotice, { ConversationRetryNotice } from './ConversationFailureNotice.tsx'
import { DiffContents } from './Inspector.tsx'
import QuestionComposer from './QuestionComposer.tsx'
import TodoPanel from './TodoPanel.tsx'
import { ApiFailure, api } from './api.ts'
import { clampThinkingLevel, isImageType, submissionFingerprint } from './conversation-input.ts'
import { MessageDialog } from './message-rendering/Dialog.tsx'
import { accessModeLabel } from './render-labels.ts'
import { asRecord, conversationStats, messageText, transcriptMessageDomId, visibleTranscriptMessages } from './render-model.ts'
import Transcript, { type InspectorDiff, type PendingMessage } from './transcript.tsx'
import { useUiPreferences } from './ui-preferences.tsx'
import { useWorkbenchDraft } from './use-workbench-draft.ts'
import { useDecisionInboxPresence } from './use-decision-inbox-presence.ts'
import { WorkbenchResultReview } from './WorkbenchResultReview.tsx'
import { workbenchApi } from './workbench-api.ts'
import css from './AgentWorkbench.module.css'
import nativeCss from './AgentWorkbenchConversation.module.css'

const evidenceStatus = {
  passed: ['验证通过', 'Validation passed'],
  failed: ['验证失败', 'Validation failed'],
  recorded: ['已记录', 'Recorded'],
  insufficient: ['证据不足', 'Evidence missing'],
} as const

const windowsAbsolutePath = /^(?:[A-Za-z]:[\\/]|\\\\)/u
const absolutePath = (path: string) => path.startsWith('/') || windowsAbsolutePath.test(path)

/** Resolve references against the worker directory or the original workspace. */
function workerFilePath(path: string, cwd: string | undefined): string | undefined {
  if (absolutePath(path)) return path
  if (cwd === undefined || !absolutePath(cwd) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(path)) return undefined
  if (windowsAbsolutePath.test(cwd)) {
    const relative = path.replaceAll('/', '\\').replace(/^(?:\.\\)+/u, '')
    return `${cwd.replace(/[\\/]+$/u, '')}\\${relative}`
  }
  return `${cwd.replace(/\/+$/u, '')}/${path.replace(/^(?:\.\/)+/u, '')}`
}

function normalizeFilePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/(?:\/\.)+(?=\/)/gu, '')
}

function filePathKey(path: string): string {
  const normalized = normalizeFilePath(path)
  return windowsAbsolutePath.test(path) ? normalized.toLowerCase() : normalized
}

function relativeFilePath(path: string, root: string | undefined): string | undefined {
  if (root === undefined || !absolutePath(root)) return undefined
  const prefix = normalizeFilePath(root).replace(/\/+$/u, '') + '/'
  const prefixKey = windowsAbsolutePath.test(root) ? prefix.toLowerCase() : prefix
  return filePathKey(path).startsWith(prefixKey) ? normalizeFilePath(path).slice(prefix.length) : undefined
}

type EvidenceRow = { entry: WorkItemEvidence; target?: string; label: string; worker?: boolean; pathLabel?: boolean }

function deliveryEvidenceRows(evidence: readonly WorkItemEvidence[], cwd: string | undefined, workspacePath: string | undefined) {
  const rows: EvidenceRow[] = []
  const indexByTarget = new Map<string, number>()
  for (const entry of evidence) {
    const target = entry.path ? workerFilePath(entry.path, cwd) : undefined
    if (target === undefined || entry.kind !== 'artifact') {
      rows.push({ entry, target, label: entry.label })
      continue
    }
    const key = filePathKey(target)
    const project = relativeFilePath(target, workspacePath)
    const scratch = relativeFilePath(target, cwd)
    const worker = scratch !== undefined && (project === undefined || scratch.length < project.length)
    const pathLabel = entry.label === entry.path || filePathKey(entry.label) === key
    const label = pathLabel ? (worker ? scratch : project) || entry.label : entry.label
    const row = { entry, target, label, worker, pathLabel }
    const existing = indexByTarget.get(key)
    if (existing === undefined) {
      indexByTarget.set(key, rows.length)
      rows.push(row)
    } else if (rows[existing]?.pathLabel && !pathLabel) {
      rows[existing] = row
    }
  }
  return rows
}

function taskFileResolver(cwd: string | undefined, workspacePath: string | undefined,
  messages: readonly ChatMessage[], evidence: readonly WorkItemEvidence[] = []) {
  const observed = new Map<string, string>()
  const actual = new Map<string, string>()
  function record(map: Map<string, string>, path: string | undefined) {
    if (path) map.set(filePathKey(path), path)
  }
  for (const message of messages) {
    if (message.role !== 'tool' || message.streaming) continue
    const details = asRecord(message.details)
    // Code mode records successful nested file operations even if a later operation failed.
    if (message.toolName === 'codemode' && Array.isArray(details?.workbenchFiles)) {
      for (const file of details.workbenchFiles) {
        const path = asRecord(file)?.path
        if (typeof path === 'string' && absolutePath(path)) record(actual, path)
      }
    }
    if (message.isError || message.status === 'error' || message.status === 'cancelled') continue
    const path = details?.resolvedPath
    if (typeof path === 'string' && absolutePath(path) &&
      (message.toolName === 'read' || message.toolName === 'write' || message.toolName === 'edit')) record(actual, path)
    for (const artifact of message.artifacts ?? []) record(observed, workerFilePath(artifact.path, cwd))
  }
  for (const entry of evidence) if (entry.path) record(observed, workerFilePath(entry.path, cwd))

  return (path: string) => {
    if (absolutePath(path)) return path
    const workerPath = workerFilePath(path, cwd)
    const projectPath = workerFilePath(path, workspacePath)
    const workerKey = workerPath && filePathKey(workerPath)
    const projectKey = projectPath && filePathKey(projectPath)
    // Confirmed paths follow current file tool semantics. Older relative paths came from the worker cwd.
    return (projectKey && actual.get(projectKey)) ?? (workerKey && actual.get(workerKey)) ??
      (workerKey && observed.get(workerKey)) ?? (projectKey && observed.get(projectKey)) ?? workerPath
  }
}

type PlanPreview = { markdown: string; title?: string }
type WorkerProps = {
  workspaceId: string
  workspacePath?: string
  item: WorkItem
  agent: WorkbenchAgent | undefined
  catalog?: ModelCatalog | null
  onOpenModels?: () => void
  onFileOpen?: (path: string, line?: number) => void
  onChange: () => void
  embedded?: boolean
}

export function WorkbenchProgress({ running, inProgress = running }: { running: boolean; inProgress?: boolean }) {
  const { t } = useUiPreferences()
  return <span className={css.status} data-running={running} data-ended={!inProgress}>
    <span className={css.statusDot} aria-hidden="true" />
    {inProgress ? t('进行中', 'In progress') : t('已结束', 'Ended')}
  </span>
}

export function WorkbenchQuestions({ detail, onAnswered }: { detail: ConversationDetail; onAnswered: (value: ConversationDetail) => void }) {
  const [plan, setPlan] = useState<PlanPreview>()
  return <>
    <QuestionComposer conversationId={detail.conversation.id} interactions={detail.interactions}
      onAnswered={onAnswered} onOpenPlan={setPlan} />
    {plan && <PlanDialog plan={plan} close={() => setPlan(undefined)} />}
  </>
}

function PlanDialog({ plan, close }: { plan: PlanPreview; close: () => void }) {
  const { t } = useUiPreferences()
  return <MessageDialog open title={plan.title || t('完整计划', 'Full plan')} onClose={close} t={t} wide>
    <AnswerMarkdown text={plan.markdown} t={t} />
  </MessageDialog>
}

export function WorkbenchChildConversation(props: WorkerProps) {
  const { item } = props
  const { settings, t } = useUiPreferences()
  const date = new Date(item.createdAt).toLocaleTimeString(settings.locale === 'en' ? 'en' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })
  const goal = settings.locale === 'en' ? `Task “${item.title}”` : `已接收任务「${item.title}」`
  return <section className={nativeCss.conversation} data-embedded={props.embedded || undefined} aria-label={t('子智能体会话', 'Child conversation')}>
    <header className={`${nativeCss.source} ${nativeCss.sizing}`}>
      <ClipboardList size={14} aria-hidden="true" />
      <span>{goal} · {t('来自', 'From')} {t('主 Agent', 'Lead Agent')} · {date}</span>
    </header>
    {item.childId === undefined
      ? <WaitingForWorker {...props} />
      : <ChildChat key={item.childId} {...props} childId={item.childId} />}
  </section>
}

function WaitingForWorker({ workspaceId, item, catalog, onOpenModels, onChange }: WorkerProps) {
  const { t } = useUiPreferences()
  const [modelId, setModelId] = useState('')
  const models = catalog?.models.filter(model => model.available) ?? []
  const modelKey = (model: ModelOption) => `${model.provider}/${model.modelId}`
  if (item.failure === undefined) {
    return <p className={`${nativeCss.notice} ${nativeCss.sizing}`} role="status">{item.error || t('正在等待派发…', 'Waiting for dispatch…')}</p>
  }
  return <div className={`${nativeCss.notice} ${nativeCss.sizing}`}>
    {models.length > 0 && item.failure.code.startsWith('MODEL_') && <label className={nativeCss.recoveryModel}>
      {t('本次重试使用的模型', 'Model for this retry')}
      <select value={modelId} onChange={event => setModelId(event.currentTarget.value)}>
        <option value="">{t('当前 Bot 模型', 'Current Bot model')}</option>
        {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.name} · {model.provider}</option>)}
      </select>
    </label>}
    <ConversationFailureNotice failure={item.failure} onModelSettings={onOpenModels} onRetry={async () => {
      const model = models.find(option => modelKey(option) === modelId)
      await workbenchApi.retry(workspaceId, { itemId: item.id, attempt: item.attempt,
        ...(model && { model: { provider: model.provider, modelId: model.modelId } }) })
      onChange()
    }} />
  </div>
}

function ChildChat({ childId, workspaceId, workspacePath, item, agent, catalog = null, onOpenModels,
  onFileOpen, onChange }: WorkerProps & { childId: string }) {
  const { t } = useUiPreferences()
  const draft = useWorkbenchDraft(childId)
  const [detail, setDetail] = useState<ConversationDetail>()
  const [connectionError, setConnectionError] = useState<Error>()
  const [actionError, setActionError] = useState<Error>()
  const [reconnect, setReconnect] = useState(0)
  const [modelOverride, setModelOverride] = useState<ModelOption>()
  const [thinkingOverride, setThinkingOverride] = useState<ThinkingLevel>()
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<PendingMessage & { previousAttempt: number }>()
  const [plan, setPlan] = useState<PlanPreview>()
  const [diff, setDiff] = useState<InspectorDiff>()
  const [jumpVisible, setJumpVisible] = useState(false)
  const [compactReceipt, setCompactReceipt] = useState<number>()
  const [recoveringAttempt, setRecoveringAttempt] = useState<number>()
  const viewport = useRef<HTMLDivElement>(null)
  const snapshotVersion = useRef(0)
  useDecisionInboxPresence(workspaceId, childId, { interactions: detail?.interactions, item: detail ? item : undefined, surface: viewport })
  const nearEnd = useRef(true)
  const sendingRef = useRef(false)
  const lastRequest = useRef<{ key: string; id: string }>()
  const disconnectMessage = t('子会话连接中断，正在重连。', 'The child conversation disconnected. Reconnecting.')
  const loadError = t('无法打开子会话', 'Could not open the child conversation')

  useEffect(() => {
    let active = true
    let snapshotSeen = false
    const source = api.watch(childId, value => {
      if (!active) return
      snapshotSeen = true
      snapshotVersion.current += 1
      setDetail(value)
      setConnectionError(undefined)
    }, (state, error) => {
      if (active && state === 'error' && (error || snapshotSeen)) setConnectionError(error ?? new Error(disconnectMessage))
    })
    void api.getConversation(childId).then(value => {
      if (!active || snapshotSeen) return
      setDetail(value)
      setConnectionError(undefined)
    }, cause => {
      if (active && !snapshotSeen) setConnectionError(cause instanceof Error ? cause : new Error(loadError))
    })
    return () => { active = false; source.close() }
  }, [childId, disconnectMessage, loadError, reconnect])

  const messages = useMemo(() => visibleTranscriptMessages(detail?.messages.filter(message =>
    message.role !== 'user' || !/^workbench-(?:start|revise|retry):/u.test(message.requestId ?? '')) ?? [],
  detail?.compaction?.running === true), [detail?.messages, detail?.compaction?.running])
  const stats = useMemo(() => detail === undefined ? undefined : conversationStats(detail.messages), [detail?.messages])
  const waitingForDecision = detail?.interactions?.some(interaction => interaction.status === 'pending') === true ||
    item.status === 'needs_human' && !item.failure && !item.error
  const busy = detail?.conversation.busy === true
  const needsTerminalSnapshot = busy && (item.status === 'pending_review' || item.status === 'ended')
  useEffect(() => {
    if (!needsTerminalSnapshot) return
    let current = true
    const version = snapshotVersion.current
    // A fast worker can finish between the interaction reply and the final SSE frame.
    // Use the actual child snapshot before enabling acceptance or folding its work.
    void api.getConversation(childId).then(value => {
      if (current && version === snapshotVersion.current) setDetail(value)
    }, () => {})
    return () => { current = false }
  }, [childId, item.attempt, needsTerminalSnapshot])

  const acknowledged = pending !== undefined && (
    detail?.messages.some(message => message.requestId === pending.requestId) === true ||
    pending.status === 'accepted' && item.attempt > pending.previousAttempt && item.status === 'needs_human' && item.error !== undefined)
  const incoming = pending && !acknowledged ? pending : undefined
  const sendBlocked = waitingForDecision
    ? t('先答复当前裁决，再继续对话。', 'Answer the pending decision before continuing.')
    : busy || item.status === 'running' || item.status === 'ready' || incoming !== undefined || recoveringAttempt === item.attempt
      ? t('智能体正在处理当前任务，完成后可以发送。', 'Send after the worker finishes its current task.')
      : undefined
  const currentModel = modelOverride ?? (busy ? detail?.conversation.model : agent?.config?.model ?? detail?.conversation.model) ?? agent?.model
  const replyAccess = item.replyAccessMode ?? agent?.accessMode ?? agent?.config?.accessMode
  const attemptActive = busy || item.status === 'running' || item.status === 'ready' || waitingForDecision
  const attemptAccess = item.accessMode ?? detail?.conversation.accessMode
  const composerAccess = (attemptActive ? attemptAccess ?? replyAccess : replyAccess ?? attemptAccess) ?? 'readOnly'
  const selectedModel = catalog?.models.find(option => option.provider === currentModel?.provider && option.modelId === currentModel.modelId)
  const thinkingLevel = clampThinkingLevel(thinkingOverride ?? detail?.conversation.thinkingLevel ?? 'off', selectedModel?.thinkingLevels)
  const reviewable = item.status === 'pending_review' && !busy && !waitingForDecision
  const suppressPreviousFailure = busy || item.status === 'ready' || recoveringAttempt === item.attempt
  const failure = suppressPreviousFailure ? undefined : item.failure ?? detail?.failure
  const cwd = detail?.conversation.cwd

  useEffect(() => { if (acknowledged) setPending(undefined) }, [acknowledged])
  useLayoutEffect(() => {
    if (nearEnd.current && viewport.current !== null) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [messages, incoming, busy, failure, detail?.retry])

  const summary = item.outcome?.summary.trim()
  const resultMessageId = messages.findLast(message => message.role === 'assistant' && (
    message.entryId !== undefined && item.evidence.some(entry => entry.kind === 'response' && entry.entryId === message.entryId) ||
    summary && messageText(message).trim() === summary))?.id
  const resultId = resultMessageId === undefined ? undefined : transcriptMessageDomId(resultMessageId)
  const createRunFileResolver = useCallback((runMessages: readonly ChatMessage[]) => {
    const entryIds = new Set(runMessages.map(message => message.entryId))
    const evidence = runMessages.some(message => message.id === resultMessageId) ? item.evidence
      : item.evidence.filter(entry => entry.entryId !== undefined && entryIds.has(entry.entryId))
    return taskFileResolver(cwd, workspacePath, runMessages, evidence)
  }, [cwd, workspacePath, item.evidence, resultMessageId])
  const resolveDeliveryFile = useMemo(() => taskFileResolver(cwd, workspacePath, [], item.evidence), [cwd, workspacePath, item.evidence])
  const evidenceRows = useMemo(() => deliveryEvidenceRows(item.evidence, cwd, workspacePath), [item.evidence, cwd, workspacePath])

  const openTaskFile = useMemo(() => onFileOpen === undefined ? undefined : (path: string, line?: number) => {
    const target = workerFilePath(path, cwd)
    if (target !== undefined) onFileOpen(target, line)
  }, [cwd, onFileOpen])

  const resolveFileImage = useCallback((path: string) => {
    const target = workerFilePath(path, cwd)
    return target === undefined ? undefined : `/api/workspaces/${encodeURIComponent(workspaceId)}/asset?${new URLSearchParams({ path: target })}`
  }, [cwd, workspaceId])

  const searchFiles = useCallback(async (query: string) => {
    const result = query.trim() === '' ? await api.listWorkspaceFiles(workspaceId) : await api.searchWorkspaceFiles(workspaceId, query)
    return result.entries
  }, [workspaceId])

  const enabledSkills = agent?.config?.skillIds
  const searchSkills = useCallback(async (query: string) => {
    const { skills } = await api.getSkills(workspaceId)
    const needle = query.trim().toLocaleLowerCase()
    return skills.filter(skill => (enabledSkills == null || enabledSkills.includes(skill.id)) &&
      [skill.name, skill.description, skill.id].some(text => text.toLocaleLowerCase().includes(needle)))
  }, [workspaceId, enabledSkills])

  function configOverride() {
    return {
      ...(modelOverride && { model: { provider: modelOverride.provider, modelId: modelOverride.modelId } }),
      ...((thinkingOverride !== undefined || modelOverride !== undefined) && { thinkingLevel }),
    }
  }

  async function perform(action: () => Promise<unknown>, fallback: string) {
    setActionError(undefined)
    try { await action() }
    catch (cause) { setActionError(cause instanceof Error ? cause : new Error(fallback)) }
  }

  async function send() {
    const text = draft.value.trim()
    const attachments = draft.attachments
    if (sendingRef.current || sendBlocked || attachments.some(item => item.status !== 'ready') || (!text && attachments.length === 0)) return
    const images = attachments.filter(item => isImageType(item.mimeType))
    const files = attachments.filter(item => !isImageType(item.mimeType))
    const configuration = configOverride()
    const key = submissionFingerprint(childId, text, attachments) + JSON.stringify(configuration)
    if (lastRequest.current?.key !== key) lastRequest.current = { key, id: crypto.randomUUID() }
    const requestId = lastRequest.current.id
    const input: WorkbenchReplyInput = {
      text, requestId, whenBusy: 'followUp', ...configuration,
      ...(images.length > 0 && { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }),
      ...(files.length > 0 && { files: files.map(({ file, mimeType, data }) => ({ name: file.name, mimeType, data })) }),
    }
    const optimistic: PendingMessage & { previousAttempt: number } = {
      id: `pending:${requestId}`, requestId, text, status: 'sending',
      previousAttempt: item.attempt,
      images: images.map(({ mimeType, data, file }) => ({ mimeType, preview: `data:${mimeType};base64,${data}`, name: file.name })),
      files: files.map(({ mimeType, file }) => ({ mimeType, name: file.name, size: file.size })),
    }
    sendingRef.current = true
    setSending(true)
    setActionError(undefined)
    nearEnd.current = true
    setJumpVisible(false)
    setPending(optimistic)
    try {
      await workbenchApi.reply(workspaceId, item.id, input)
      lastRequest.current = undefined
      setPending(current => current === undefined ? undefined : { ...current, status: 'accepted' })
      draft.sent(draft.value, attachments)
      setModelOverride(undefined)
      setThinkingOverride(undefined)
      onChange()
    } catch (cause) {
      setPending(undefined)
      setActionError(cause instanceof Error ? cause : new Error(t('消息发送失败，输入内容已保留', 'Message failed to send. Your draft has been preserved')))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  async function retry() {
    setActionError(undefined)
    await workbenchApi.retry(workspaceId, { itemId: item.id, attempt: item.attempt, ...configOverride() })
    setRecoveringAttempt(item.attempt)
    setModelOverride(undefined)
    setThinkingOverride(undefined)
    onChange()
  }

  const compact = () => { void perform(async () => {
    await api.compact(childId)
    setCompactReceipt(Date.now())
  }, t('上下文压缩失败', 'Context compaction failed')) }

  function jumpToEnd() {
    if (!viewport.current) return
    nearEnd.current = true
    setJumpVisible(false)
    viewport.current.scrollTop = viewport.current.scrollHeight
  }

  return <>
    {connectionError && <div className={`${nativeCss.notice} ${nativeCss.sizing}`}>
      {connectionError instanceof ApiFailure && connectionError.failure
        ? <ConversationFailureNotice failure={connectionError.failure} onModelSettings={onOpenModels}
          onRetry={() => setReconnect(value => value + 1)} />
        : <span className={nativeCss.error} role="alert">{connectionError.message}</span>}
      {!detail && !(connectionError instanceof ApiFailure && connectionError.failure) &&
        <button type="button" className={css.linkButton} onClick={() => setReconnect(value => value + 1)}>{t('重试', 'Retry')}</button>}
    </div>}
    {!detail && !connectionError && <p className={`${nativeCss.notice} ${nativeCss.sizing}`} role="status">{t('正在打开会话…', 'Opening the conversation…')}</p>}
    <div className={`${nativeCss.transcript} ${nativeCss.sizing}`}>
      <div ref={viewport} className={nativeCss.viewport} tabIndex={-1} onScroll={event => {
        const node = event.currentTarget
        nearEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 76
        setJumpVisible(!nearEnd.current)
      }}>
        {detail !== undefined && <Transcript messages={messages} conversationId={childId}
          pending={incoming ? [incoming] : undefined} interactions={detail.interactions} subagents={detail.subagents} running={busy}
          compactionRunning={detail.compaction?.running} onOpenFile={openTaskFile} resolveFileImage={resolveFileImage}
          createRunFileResolver={createRunFileResolver}
          onOpenPlan={setPlan} onInspectDiff={setDiff}
          onFeedback={(entryId, rating) => { void perform(() => api.saveFeedback(childId, { entryId, rating }), t('反馈发送失败', 'Could not save feedback')) }} />}
        {failure !== undefined
          ? <div className={nativeCss.artifacts}><ConversationFailureNotice failure={failure}
            onRetry={item.failure ? retry : undefined} onModelSettings={onOpenModels} onCompact={compact} /></div>
          : !suppressPreviousFailure && (item.error || detail?.error)
            ? <p className={`${nativeCss.artifacts} ${nativeCss.error}`} role="alert">{item.error || detail?.error}</p>
            : null}
        {detail?.retry && <div className={nativeCss.artifacts}><ConversationRetryNotice retry={detail.retry} /></div>}
        {detail && !busy && !waitingForDecision && (item.evidence.length > 0 || item.outcome !== undefined || reviewable) &&
          <section className={nativeCss.artifacts} aria-label={t('交付结果', 'Deliverables')}>
            <div className={css.resultHeading}>
              <h2>{t('交付结果', 'Deliverables')}</h2>
              {item.outcome?.decision === 'accepted' && <small>{t('验收通过', 'Accepted')}</small>}
              {item.status === 'pending_review' && <small>{t('结果待验收', 'Awaiting acceptance')}</small>}
            </div>
            {resultId === undefined && item.outcome?.summary &&
              <AnswerMarkdown text={item.outcome.summary} t={t} onOpenFile={openTaskFile && ((path, line) => {
                const target = resolveDeliveryFile(path)
                if (target !== undefined) openTaskFile(target, line)
              })} />}
            {evidenceRows.length > 0 && <ul className={css.evidenceList}>
              {evidenceRows.map(({ entry, target, label, worker }, index) => {
                const [statusZh, statusEn] = evidenceStatus[entry.status]
                const locationId = worker ? `workbench-file-location-${item.id}-${index}` : undefined
                return <li key={`${entry.kind}:${index}`}>
                  <div className={css.evidenceIdentity}>
                    {entry.kind === 'response' && resultId !== undefined
                      ? <a className={css.linkButton} href={`#${resultId}`} onClick={event => {
                        const answer = document.getElementById(resultId)
                        if (answer === null) return
                        event.preventDefault()
                        answer.scrollIntoView({ block: 'start' })
                      }}>{label}</a>
                      : !target || openTaskFile === undefined
                        ? <span title={target}>{label}</span>
                        : <button type="button" className={css.linkButton} title={target} aria-describedby={locationId} onClick={() => openTaskFile(target)}>
                          <FolderOpen size={14} aria-hidden="true" /><span>{label}</span>
                        </button>}
                    {locationId && <span id={locationId} className={css.evidenceLocation}>{t('工作项目录', 'Work item folder')}</span>}
                  </div>
                  <small data-evidence={entry.status}>{t(statusZh, statusEn)}</small>
                </li>
              })}
            </ul>}
            {reviewable && <WorkbenchResultReview key={item.attempt} item={item} onChange={onChange} />}
          </section>}
      </div>
      {jumpVisible && <button type="button" className={nativeCss.jump} aria-label={t('滚动到底部', 'Scroll to bottom')} onClick={jumpToEnd}>
        <ArrowDown size={16} aria-hidden="true" />
      </button>}
    </div>
    {compactReceipt !== undefined && <Toast key={compactReceipt} text={t('已提交上下文压缩请求', 'Context compaction requested')}
      onDone={() => setCompactReceipt(current => current === compactReceipt ? undefined : current)} />}
    {detail && <div className={`${nativeCss.footer} ${nativeCss.sizing}`}>
      {actionError && <div className={nativeCss.notice}>
        {actionError instanceof ApiFailure && actionError.failure
          ? <ConversationFailureNotice failure={actionError.failure} onModelSettings={onOpenModels} />
          : <span className={nativeCss.error} role="alert">{actionError.message}</span>}
      </div>}
      {draft.attachmentError && <p className={`${nativeCss.notice} ${nativeCss.error}`} role="alert">{draft.attachmentError}</p>}
      <TodoPanel todos={detail.todos} />
      <QuestionComposer conversationId={childId} interactions={detail.interactions}
        onAnswered={() => { setReconnect(value => value + 1); onChange() }} onOpenPlan={setPlan} />
      {detail.compaction?.failure && !detail.compaction.running && <p className={`${nativeCss.notice} ${nativeCss.error}`} role="alert">{detail.compaction.failure}</p>}
      {attemptActive && replyAccess && composerAccess !== replyAccess && <p className={nativeCss.notice} role="status">
        {t(`本轮使用「${accessModeLabel(composerAccess, t)}」，下次发消息时使用「${accessModeLabel(replyAccess, t)}」。`,
          `This run uses ${accessModeLabel(composerAccess, t)}. Your next message will use ${accessModeLabel(replyAccess, t)}.`)}
      </p>}
      <Composer value={draft.value} images={draft.attachments} catalog={catalog} model={currentModel} thinkingLevel={thinkingLevel}
        busy={busy} sending={sending} sendBlocked={sendBlocked} queue={detail.queue} sendMode="followUp"
        accessMode={composerAccess} stats={stats}
        onChange={draft.change} onAddImages={draft.add} onRemoveImage={draft.remove} onRetryImage={draft.retry}
        onSend={() => { void send() }}
        onStop={() => { void perform(() => api.stop(childId), t('无法停止回答', 'Could not stop the response')) }}
        onRemoveQueue={id => { void perform(() => api.removeQueued(childId, id), t('无法移除排队消息', 'Could not remove the queued message')) }}
        onSelectModel={value => {
          setModelOverride(value)
          setThinkingOverride(clampThinkingLevel(thinkingLevel, value.thinkingLevels))
        }}
        onThinkingLevel={setThinkingOverride} onOpenSettings={onOpenModels}
        onSearchFiles={workspacePath ? searchFiles : undefined} onSearchSkills={searchSkills}
        onPreviewFile={path => { onFileOpen?.(workerFilePath(path, workspacePath) ?? path) }}
        resolveReferencePath={path => workerFilePath(path, workspacePath) ?? path}
        plan={detail.plan?.active === true} onPlan={active => {
          void perform(async () => setDetail(await api.setPlan(childId, active)), t('无法切换计划模式', 'Could not change plan mode'))
        }}
        onCompact={busy || detail.compaction?.running ? undefined : compact} />
    </div>}
    {plan && <PlanDialog plan={plan} close={() => setPlan(undefined)} />}
    {diff && <MessageDialog open wide title={diff.path} onClose={() => setDiff(undefined)} t={t}><DiffContents diff={diff} /></MessageDialog>}
  </>
}
