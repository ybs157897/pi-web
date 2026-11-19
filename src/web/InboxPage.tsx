import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Archive, ArrowLeft, ArrowUpRight, Check, ChevronDown, Clock3, Inbox, ListFilter, Mail, Reply, RotateCcw, Send } from 'lucide-react'
import type {
  DecisionInboxLink, DecisionMail, DecisionMailKind, DecisionMailResolution, DecisionMailSummary, DecisionReason, UpdateDecisionMail,
} from '../shared/decision-inbox.ts'
import type { AskUserQuestionAnswerItem } from '../shared/types.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import ConversationFailureNotice from './ConversationFailureNotice.tsx'
import { api } from './api.ts'
import { DECISION_INBOX_CHANGED, decisionInboxApi } from './decision-inbox-api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './InboxPage.module.css'
import heroIllustration from './assets/inbox/upgrade.webp'

type InboxPageProps = {
  workspaceId?: string
  workbenchConversationId?: string
  initialMailId?: string
  initialWorkItemId?: string
  onOpenConversation?: (link: DecisionInboxLink, mailId?: string) => void
  onOpenFile?: (path: string, line?: number) => void
}

const kinds: Record<DecisionMailKind, [string, string]> = {
  choice: ['选择', 'Choice'],
  confirmation: ['确认', 'Confirmation'],
  review: ['审阅', 'Review'],
  exception: ['异常', 'Exception'],
  result: ['结果', 'Result'],
}

const reasons: Record<DecisionReason, [string, string]> = {
  requirement_ambiguity: ['需求有歧义', 'Ambiguous requirement'],
  high_impact: ['高影响 / 不可逆', 'High impact or irreversible'],
  scope_conflict: ['范围冲突', 'Conflicting scope'],
  cannot_verify: ['无法自动验收', 'Cannot verify automatically'],
  accept_result: ['结果待验收', 'Result needs acceptance'],
}

const resolutions: Record<DecisionMailResolution, [string, string]> = {
  answered: ['已答复', 'Answered'],
  cancelled: ['已关闭', 'Closed'],
  superseded: ['已有更新', 'Superseded'],
  accepted: ['验收通过', 'Accepted'],
  revise: ['已退回修改', 'Returned for changes'],
}

const evidenceStates: Record<DecisionMail['evidence'][number]['status'], [string, string]> = {
  passed: ['通过', 'Passed'],
  failed: ['失败', 'Failed'],
  recorded: ['已记录', 'Recorded'],
  insufficient: ['证据不足', 'Insufficient evidence'],
}

type Folder = 'pending' | 'results' | 'snoozed' | 'archived'
const folders: Record<Folder, [string, string]> = {
  pending: ['待你决定', 'Needs your decision'],
  results: ['结果', 'Results'],
  snoozed: ['稍后提醒', 'Snoozed'],
  archived: ['已处理', 'Processed'],
}

type InboxList = Awaited<ReturnType<typeof decisionInboxApi.list>>

function folderOf(mail: DecisionMailSummary): Folder {
  return mail.folder === 'pending' && mail.kind === 'result' ? 'results' : mail.folder
}

function groupMails(mails: DecisionMailSummary[]) {
  const groups = new Map<string, { title: string; mails: DecisionMailSummary[] }>()
  for (const mail of mails) {
    const group = groups.get(mail.groupId) ?? { title: mail.groupTitle, mails: [] }
    group.mails.push(mail)
    groups.set(mail.groupId, group)
  }
  return groups
}

function MailType({ kind }: { kind: DecisionMailKind }) {
  const { t } = useUiPreferences()
  return <span className={css.type} data-kind={kind}>{t(...kinds[kind])}</span>
}

/**
 * 一封邮件一张卡：类型胶囊 + 状态（同一行左右分列）、细分隔线、标题、底部元信息。
 * @param item 邮件摘要
 * @param canBatch 当前分类是否允许批量选择（决定是否渲染勾选框）
 * @param selected 是否已选中
 * @param disabled 批量操作进行中时禁用交互
 * @param t / locale 文案与时间格式
 * @param onToggle / onOpen 选择与打开回调
 * 内部逻辑：只呈现类型、标题、状态三样信息，按这个顺序排列；状态用彩色圆点 +
 * 同色文字而不是胶囊，信息密度最高。勾选框绝对定位在右上角，不参与可访问名。
 */
function MailCard({ item, canBatch, selected, disabled, t, locale, onToggle, onOpen }: {
  item: DecisionMailSummary
  canBatch: boolean
  selected: boolean
  disabled: boolean
  t: ReturnType<typeof useUiPreferences>['t']
  locale: string
  onToggle: (id: string, selected: boolean) => void
  onOpen: (id: string) => void
}) {
  const awaiting = item.actionable && item.folder !== 'archived'
  return <li className={css.messageRow}>
    {canBatch && <input className={css.rowSelect} type="checkbox" aria-label={t(`选择 ${item.subject}`, `Select ${item.subject}`)}
      checked={selected} disabled={disabled} onChange={event => onToggle(item.id, event.target.checked)} />}
    <button className={css.card} type="button" data-mail-id={item.id} data-kind={item.kind}
      data-awaiting={awaiting ? '' : undefined} disabled={disabled} onClick={() => onOpen(item.id)}>
      <span className={css.cardHead}>
        <span className={css.cardKind} data-kind={item.kind}>{t(...kinds[item.kind])}</span>
        <span className={css.cardState}>
          {item.folder === 'archived' && item.actionable && <span className={css.rowOpen}>{t('仍待处理', 'Still open')}</span>}
          <span className={css.cardDot} data-kind={item.kind} aria-hidden="true" />
          <span className={css.cardStatus} data-kind={item.kind}>
            {item.resolution ? t(...resolutions[item.resolution])
              : awaiting ? t(...reasons[item.reason]) : t('已归档', 'Archived')}
          </span>
        </span>
      </span>
      <span className={css.cardRule} aria-hidden="true" />
      <strong className={css.cardTitle}>{item.subject}</strong>
      <span className={css.cardMeta}>
        <time className={css.cardTime} dateTime={new Date(item.createdAt).toISOString()}>
          {mailTime(item.snoozedUntil ?? item.createdAt, locale)}
        </time>
      </span>
    </button>
  </li>
}

function mailTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp)
}

function waitTime(milliseconds: number, t: ReturnType<typeof useUiPreferences>['t']): string {
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes <= 0) return t('不足 1 分钟', 'Under 1 minute')
  if (minutes < 60) return t(`${minutes} 分钟`, `${minutes} min`)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t(`${hours} 小时`, `${hours} hr`)
  const days = Math.floor(hours / 24)
  return t(`${days} 天`, `${days} d`)
}

function decisionChanged(workspaceId: string) {
  window.dispatchEvent(new CustomEvent(DECISION_INBOX_CHANGED, { detail: { workspaceId } }))
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function InboxMailView({
  workspaceId, mail, goBack, openConversation, openFile, update,
}: {
  workspaceId: string
  mail: DecisionMail
  goBack: () => void
  openConversation?: InboxPageProps['onOpenConversation']
  openFile?: InboxPageProps['onOpenFile']
  update: (next?: DecisionMail) => void
}) {
  const { t, settings } = useUiPreferences()
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const letterRef = useRef<HTMLElement>(null)
  const busyRef = useRef(false)
  const attemptedReply = useRef<{ text: string; requestId: string }>()
  useEffect(() => { headingRef.current?.focus() }, [])
  const confirmOpened = useMemo(() => {
    let opening: Promise<void> | undefined
    return () => {
      opening ??= decisionInboxApi.opened(workspaceId, mail.id).then(() => undefined, () => { opening = undefined })
      return opening
    }
  }, [workspaceId, mail.id])
  useEffect(() => {
    if (!mail.actionable) return
    const observed = () => {
      if (document.visibilityState === 'visible' && document.hasFocus() && letterRef.current?.getClientRects().length) {
        void confirmOpened()
      }
    }
    observed()
    document.addEventListener('visibilitychange', observed)
    window.addEventListener('focus', observed)
    return () => {
      document.removeEventListener('visibilitychange', observed)
      window.removeEventListener('focus', observed)
    }
  }, [confirmOpened, mail.actionable])

  const activeQuestions = mail.actionable ? (mail.questions ?? []) : []
  const answers: AskUserQuestionAnswerItem[] = activeQuestions.map((question) => {
    if (skipped.has(question.id)) return { id: question.id, selected: [] }
    const text = (activeQuestions.length === 1 ? reply : custom[question.id] ?? '').trim()
    return { id: question.id, selected: selected[question.id] ?? [], ...(text ? { custom: text } : {}) }
  })
  const answeredCount = answers.filter(answer => answer.selected.length || answer.custom || skipped.has(answer.id)).length
  const interactionId = mail.link.interactionId
  const plan = mail.actionable && mail.kind === 'review' && interactionId !== undefined
  const result = mail.actionable && mail.kind === 'result'
  const needsRecovery = mail.actionable && (mail.failure?.action === 'check_model' || mail.failure?.action === 'compact')
  const canReply = !needsRecovery && (mail.link.workItemId === undefined || mail.link.conversationId !== mail.link.parentConversationId)
  const canSend = activeQuestions.length
    ? answeredCount === activeQuestions.length
    : canReply && reply.trim() !== ''
  const messageTime = mailTime(mail.createdAt, settings.locale)

  async function perform(action: () => Promise<DecisionMail | void>, clearReply = false) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      if (clearReply && interactionId && mail.actionable) await confirmOpened()
      const next = await action()
      if (clearReply) setReply('')
      update(next ?? undefined)
      decisionChanged(workspaceId)
      if (next?.resolution || (clearReply && interactionId && mail.actionable)) headingRef.current?.focus()
    } catch (cause) {
      setError(errorText(cause, t('处理失败，请重试。', 'Could not process this message. Try again.')))
      update()
    } finally {
      setBusy(false)
      busyRef.current = false
    }
  }

  function changeFolder(input: UpdateDecisionMail) {
    void perform(() => decisionInboxApi.update(workspaceId, mail.id, input))
  }

  function planDecision(approve: boolean) {
    if (!interactionId) return
    void perform(async () => {
      await api.answerInteraction(mail.link.conversationId, interactionId, [{
        id: 'plan-review',
        selected: [approve ? mail.approveLabel ?? '同意执行' : '要求修改'],
        ...(reply.trim() ? { custom: reply.trim() } : {}),
      }])
    }, true)
  }

  function resultDecision(action: 'accept' | 'revise') {
    const feedback = reply.trim()
    void perform(() => decisionInboxApi.verdict(workspaceId, mail.id, { action, ...(feedback ? { feedback } : {}) }), true)
  }

  function includeQuestion(id: string) {
    if (skipped.has(id)) setSkipped(previous => {
      const next = new Set(previous)
      next.delete(id)
      return next
    })
  }

  function toggleSkip(id: string) {
    if (skipped.has(id)) includeQuestion(id)
    else setSkipped(previous => new Set(previous).add(id))
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSend || busyRef.current) return
    if (activeQuestions.length && interactionId) {
      void perform(async () => { await api.answerInteraction(mail.link.conversationId, interactionId, answers) }, true)
      return
    }
    if (plan) {
      planDecision(false)
      return
    }
    if (result) {
      resultDecision('revise')
      return
    }
    const text = reply.trim()
    let request = attemptedReply.current
    if (request?.text !== text) request = { text, requestId: crypto.randomUUID() }
    attemptedReply.current = request
    void perform(async () => {
      await api.submit(mail.link.conversationId, { ...request, whenBusy: 'followUp' })
      attemptedReply.current = undefined
    }, true)
  }

  return <div className={css.mailView}>
    <header className={css.toolbar}>
      <Button icon={<ArrowLeft size={16} />} onClick={goBack}>{t('返回', 'Back')}</Button>
      <span className={css.toolbarDivider} aria-hidden="true" />
      {canReply && <Button icon={<Reply size={16} />}
        onClick={() => (replyRef.current ?? letterRef.current?.querySelector('textarea'))?.focus()}>{t('回复', 'Reply')}</Button>}
      {mail.actionable && (mail.folder === 'pending' ? <Button icon={<Clock3 size={16} />} disabled={busy} onClick={() => changeFolder({
        action: 'snooze', until: Date.now() + 60 * 60 * 1_000,
      })}>{t('稍后 1 小时', 'Snooze for 1 hour')}</Button> : <Button icon={<RotateCcw size={16} />} disabled={busy}
        onClick={() => changeFolder({ action: 'restore' })}>{t('移回待处理', 'Move to pending')}</Button>)}
      {mail.folder !== 'archived' && <Button icon={<Archive size={16} />} disabled={busy}
        onClick={() => changeFolder({ action: 'archive' })}>{t('归档', 'Archive')}</Button>}
      <div className={css.toolbarSpacer} />
      {openConversation && <Button className={css.toolbarConversation} icon={<ArrowUpRight size={16} />}
        onClick={() => openConversation(mail.link, mail.id)}>{mail.link.workItemId ? t('打开智能体会话', 'Open worker conversation') : t('打开会话', 'Open conversation')}</Button>}
    </header>
    <div className={css.letterScroll}>
      <article className={css.letter} ref={letterRef}>
        <div className={css.senderLine}>
          <span className={css.avatar} aria-hidden="true"><Mail size={18} /></span>
          <dl className={css.mailMeta}>
            <div><dt>{t('发件人', 'From')}</dt><dd>pi-web Agent</dd></div>
            <div><dt>{t('收件人', 'To')}</dt><dd>{t('我', 'Me')}</dd></div>
          </dl>
          <time dateTime={new Date(mail.createdAt).toISOString()}>{messageTime}</time>
        </div>
        <div className={css.subject}>
          <h1 ref={headingRef} tabIndex={-1}>{mail.subject}</h1><MailType kind={mail.kind} />
          {mail.resolution && <span className={css.resolution} role="status"><Check size={14} />{t(...resolutions[mail.resolution])}</span>}
        </div>
        {mail.actionable && mail.reason !== 'accept_result' && <section className={css.why}>
          <h2>{t('为什么找你', 'Why you are needed')}</h2>
          <div><strong>{needsRecovery ? t('执行异常', 'Execution error') : t(...reasons[mail.reason])}</strong>
            <p>{needsRecovery ? t('到原对话查看恢复选项，处理后可继续工作项。', 'Open the original conversation for recovery options and resume the work item.') : mail.why}</p>
          </div>
        </section>}
        {mail.failure && <ConversationFailureNotice failure={mail.failure} />}
        {mail.body && mail.body !== mail.failure?.message && <section className={css.block} data-tone="delivery">
          <h2>{t('交付内容', 'Delivery')}</h2>
          <div className={css.body}><AnswerMarkdown text={mail.body} t={t}
            filePaths={mail.evidence.flatMap(item => item.path ? [item.path] : [])} onOpenFile={openFile} /></div>
        </section>}
        {mail.questions && mail.questions.length > 0 && <section className={css.block} data-tone="decision">
          <h2>{t('需要你的决定', 'Your decision')}</h2>
          {mail.questions.map(question => {
          const current = selected[question.id] ?? []
          const answered = mail.answers?.find(answer => answer.id === question.id)
          const isSkipped = skipped.has(question.id)
          return <fieldset className={css.question} key={question.id} disabled={busy || !mail.actionable}>
            <legend>{question.question}</legend>
            {question.options?.map(option => {
              const chosen = (mail.actionable ? isSkipped ? [] : current : answered?.selected ?? []).includes(option.label)
              return <label className={css.option} key={option.label} data-selected={chosen || undefined}>
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'} name={question.id} checked={chosen}
                  onChange={() => {
                    includeQuestion(question.id)
                    setSelected(previous => ({
                      ...previous,
                      [question.id]: question.multiSelect
                        ? chosen ? current.filter(label => label !== option.label) : [...new Set([...current, option.label])]
                        : [option.label],
                    }))
                  }}
                />
                <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              </label>
            })}
            {mail.actionable && activeQuestions.length > 1 && <label className={css.customReply}>
              {question.options?.length ? t('补充回答', 'Additional answer') : t('你的回答', 'Your answer')}
              <textarea value={isSkipped ? '' : custom[question.id] ?? ''} rows={2} maxLength={4_000}
                onChange={event => {
                  includeQuestion(question.id)
                  setCustom(previous => ({ ...previous, [question.id]: event.target.value }))
                }} />
            </label>}
            {mail.actionable && <Button className={css.skipQuestion} type="button" size="sm" aria-pressed={isSkipped}
              onClick={() => toggleSkip(question.id)}>
              {isSkipped ? t('已跳过 · 恢复作答', 'Skipped · Answer this question') : t('跳过此题', 'Skip this question')}
            </Button>}
            {answered?.custom && <p className={css.savedReply}>{answered.custom}</p>}
            {answered && !answered.selected.length && !answered.custom && <p className={css.savedReply}>{t('已跳过', 'Skipped')}</p>}
          </fieldset>
          })}
        </section>}
        {((mail.acceptance?.length ?? 0) > 0 || mail.evidence.length > 0) && <section className={css.block} data-tone="verify">
          <h2>{t('验收', 'Acceptance')}</h2>
          <div className={css.verifyColumns}>
            {mail.acceptance && mail.acceptance.length > 0 && <div className={css.acceptance}>
              <h3>{t('验收条件', 'Criteria')}</h3>
              <ul>{mail.acceptance.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
            </div>}
            {mail.evidence.length > 0 && <div className={css.evidence}>
              <h3>{t('验收证据', 'Evidence')}</h3>
              <ul>{mail.evidence.map((item, index) => <li key={`${item.label}-${index}`} data-state={item.status}>
                <span>{item.path && openFile
                  ? <button className={css.evidenceLink} type="button" title={item.label} onClick={() => openFile(item.path!)}>{item.label}<ArrowUpRight size={14} /></button>
                  : <span title={item.label}>{item.label}</span>}</span>
                <span className={css.evidenceState}>{t(...evidenceStates[item.status])}</span>
              </li>)}</ul>
            </div>}
          </div>
        </section>}
        {mail.answers && !mail.questions && <section className={css.block} data-tone="reply">
          <h2>{t('已提交的答复', 'Submitted reply')}</h2>
          {mail.answers.map(answer => <p key={answer.id}>{[...answer.selected, answer.custom].filter(Boolean).join(' · ')}</p>)}
        </section>}
        {(plan || result) && <div className={css.actions}>
          <Button variant="primary" disabled={busy} onClick={() => result ? resultDecision('accept') : planDecision(true)}>
            {result ? t('验收通过', 'Accept result') : mail.approveLabel}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => result ? resultDecision('revise') : planDecision(false)}>
            {t('退回修改', 'Request changes')}
          </Button>
        </div>}
      </article>
    </div>
    <div className={css.replyDock}>
      <form className={css.replyForm} onSubmit={onSubmit}>
        {error && <p className={css.error} role="alert">{error}</p>}
        {canReply && activeQuestions.length <= 1 && <textarea ref={replyRef} aria-label={t('回复内容', 'Reply text')} rows={2} maxLength={result ? 2_000 : 4_000}
          placeholder={activeQuestions.length
            ? t('输入回答，或选择上方选项…', 'Write your answer or select an option above…')
            : result || plan
              ? t('填写意见（可选）…', 'Add feedback (optional)…')
              : t('回复这封信，或继续对应会话…', 'Reply to this message or continue its conversation…')}
          value={activeQuestions[0] && skipped.has(activeQuestions[0].id) ? '' : reply} disabled={busy} onChange={event => {
            if (activeQuestions[0]) includeQuestion(activeQuestions[0].id)
            setReply(event.target.value)
          }} />}
        <div className={css.replyActions}>
          <span title={mail.conversationTitle}>{needsRecovery ? mail.conversationTitle : activeQuestions.length > 1
            ? t(`已作答或跳过 ${answeredCount}/${activeQuestions.length} 题`, `${answeredCount}/${activeQuestions.length} answered or skipped`)
            : <>{t('发送到', 'Send to')} <strong>{mail.conversationTitle}</strong></>}</span>
          {openConversation && <Button variant={needsRecovery ? 'primary' : undefined} onClick={() => openConversation(mail.link, mail.id)}>
            {needsRecovery ? t('去处理异常', 'Open recovery options') : (mail.link.workItemId ? t('在智能体会话中查看', 'View in worker conversation') : t('在会话中查看', 'View in conversation'))}
          </Button>}
          {canReply && <Button variant="primary" type="submit" icon={<Send size={14} />} disabled={!canSend || busy}>
            {result ? t('发送返修意见', 'Send revision feedback') : plan ? t('发送修改意见', 'Send review feedback') : t('发送', 'Send')}
          </Button>}
        </div>
      </form>
    </div>
  </div>
}

function WorkspaceInbox({
  workspaceId, initialMailId, initialWorkItemId, onOpenConversation, onOpenFile,
}: InboxPageProps & { workspaceId: string }) {
  const { t, settings } = useUiPreferences()
  const [list, setList] = useState<InboxList>()
  const [listError, setListError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [folder, setFolder] = useState<Folder>('pending')
  const [selectedId, setSelectedId] = useState(initialMailId)
  const [mail, setMail] = useState<DecisionMail>()
  const [refresh, setRefresh] = useState(0)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filter, setFilter] = useState<DecisionReason>()
  /** 展示形态：分组（按会话折叠）或卡片（一封一张卡平铺）。 */
  const [view, setView] = useState<'grouped' | 'cards'>('cards')
  /** 卡片模式下的会话筛选；undefined 表示全部会话。 */
  const [groupFilter, setGroupFilter] = useState<string>()
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const firstLoaded = useRef(false)
  const openedWorkItem = useRef<string>()
  const selectedSummary = list?.mails.find(item => item.id === selectedId)
  const mailState = selectedSummary && `${selectedSummary.folder}/${selectedSummary.actionable}/${selectedSummary.resolution ?? ''}`

  useEffect(() => { if (initialMailId !== undefined) setSelectedId(initialMailId) }, [initialMailId])

  useEffect(() => {
    if (initialWorkItemId === undefined || initialMailId !== undefined) {
      openedWorkItem.current = initialWorkItemId
      return
    }
    if (!list || openedWorkItem.current === initialWorkItemId) return
    openedWorkItem.current = initialWorkItemId
    const related = list.mails.find(item =>
      item.link.workItemId === initialWorkItemId && item.actionable && item.folder !== 'archived')
    if (!related) return
    setFolder(folderOf(related))
    setFilter(undefined)
    setFilterOpen(false)
    setSelectedId(related.id)
  }, [initialMailId, initialWorkItemId, list])

  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const update = () => {
      if (pending || controller.signal.aborted) return
      pending = true
      void decisionInboxApi.list(workspaceId, controller.signal).then(next => {
        if (controller.signal.aborted) return
        if (!firstLoaded.current) {
          firstLoaded.current = true
          const decision = next.mails.some(item => folderOf(item) === 'pending')
          if (!initialMailId && !decision && next.mails.some(item => folderOf(item) === 'results')) setFolder('results')
        }
        setList(next)
        setListError('')
      }).catch(cause => {
        if (!controller.signal.aborted) setListError(errorText(cause, t('无法读取收件箱', 'Could not load inbox')))
      }).finally(() => { pending = false })
    }
    update()
    const interval = window.setInterval(() => { if (!document.hidden) update() }, 2_500)
    return () => { controller.abort(); window.clearInterval(interval) }
  }, [initialMailId, refresh, t, workspaceId])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    setDetailError('')
    void decisionInboxApi.detail(workspaceId, selectedId, controller.signal).then(next => {
      if (!controller.signal.aborted) setMail(next)
    }).catch(cause => {
      if (!controller.signal.aborted) setDetailError(errorText(cause, t('无法读取邮件', 'Could not load this message')))
    })
    return () => controller.abort()
  }, [selectedId, mailState, refresh, t, workspaceId])

  function goBack() {
    const initialMail = selectedId === initialMailId ? mail ?? selectedSummary : undefined
    const returnFolder = initialMail ? folderOf(initialMail) : folder
    setFolder(returnFolder)
    setSelectedId(undefined)
    setMail(undefined)
    requestAnimationFrame(() => {
      const origin = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-mail-id]') ?? [])
        .find(button => button.dataset.mailId === selectedId)
      if (origin) origin.focus()
      else listRef.current?.querySelector<HTMLButtonElement>(`button[data-inbox-folder="${returnFolder}"]`)?.focus()
    })
  }

  if (selectedId) return <section className={css.page} aria-label={t('收件箱', 'Inbox')}>
    {mail?.id === selectedId
      ? <InboxMailView key={mail.id} workspaceId={workspaceId} mail={mail} goBack={goBack} openConversation={onOpenConversation}
          openFile={onOpenFile}
          update={(next) => { if (next) setMail(next); setRefresh(value => value + 1) }} />
      : <div className={css.loadingDetail}>
          <Button icon={<ArrowLeft size={16} />} onClick={goBack}>{t('返回', 'Back')}</Button>
          {detailError
            ? <><p role="alert" className={css.error}>{detailError}</p><Button onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</Button></>
            : <p role="status">{t('正在读取邮件…', 'Loading message…')}</p>}
        </div>}
  </section>

  const all = list?.mails ?? []
  const inFolder = all.filter(item => folderOf(item) === folder)
  const inReason = filter === undefined ? inFolder : inFolder.filter(item => item.reason === filter)
  /** 卡片模式下可选的会话清单（当前分类里出现过的分组）。 */
  const conversationOptions = Array.from(new Map(inReason.map(item => [item.groupId, item.groupTitle])).entries())
  const visible = groupFilter === undefined ? inReason : inReason.filter(item => item.groupId === groupFilter)
  const groups = groupMails(visible)
  const canBatch = folder !== 'archived' && visible.length > 0
  const ids = canBatch ? visible.filter(item => selectedRows.has(item.id)).map(item => item.id) : []
  const now = new Date()
  const today = new Date(now).setHours(0, 0, 0, 0)
  const settledToday = all.filter(item => (item.settledAt ?? 0) >= today).length
  const oldest = all.findLast(item => item.actionable && item.folder === 'pending')

  function toggleRow(id: string, selected: boolean) {
    setSelectedRows(previous => {
      const updated = new Set(previous)
      if (selected) updated.add(id)
      else updated.delete(id)
      return updated
    })
  }

  async function updateSelected(input: UpdateDecisionMail) {
    if (ids.length === 0 || bulkBusy) return
    setBulkBusy(true)
    setBulkError('')
    try {
      await decisionInboxApi.updateMany(workspaceId, ids, input)
      setSelectedRows(new Set())
      decisionChanged(workspaceId)
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`button[data-inbox-folder="${folder}"]`)?.focus())
    } catch (cause) {
      setBulkError(errorText(cause, t('批量处理失败，请重试。', 'Could not update the selected messages. Try again.')))
    } finally {
      setBulkBusy(false)
      setRefresh(value => value + 1)
    }
  }

  return <section className={css.page} aria-labelledby="decision-inbox-heading">
    <div className={css.listScroll}>
      <div className={css.list} ref={listRef}>
        <header className={css.heading}>
          <h1 id="decision-inbox-heading">{t('收件箱', 'Inbox')}</h1>
          {list && <span>{t(`${list.pendingCount} 封等你处理`, `${list.pendingCount} awaiting you`)}</span>}
        </header>
        <div className={css.hero}>
          <img src={heroIllustration} alt="" aria-hidden="true" />
          <span className={css.heroText}>
            <strong>Upgrade with AI</strong>
            <small>{t('让收件箱更强', 'For more powerful Inbox')}</small>
          </span>
        </div>
        <nav className={css.folders} aria-label={t('收件箱分类', 'Inbox folders')}>
          {(Object.keys(folders) as Folder[]).map(name => <button key={name} type="button" data-inbox-folder={name}
            aria-current={folder === name ? 'page' : undefined} disabled={bulkBusy} onClick={() => {
              if (name === folder) return
              setFolder(name)
              setFilter(undefined)
              setFilterOpen(false)
              setSelectedRows(new Set())
              setBulkError('')
            }}>
            {t(...folders[name])} <span className={css.count}>{all.filter(item => folderOf(item) === name).length}</span>
          </button>)}
        </nav>
        {list && <div className={css.statCards}>
          <div className={css.statCard} data-tone="handled">
            <span className={css.statLabel}>{t('今天已处理', 'Processed today')}</span>
            <strong className={css.statValue}>{settledToday}</strong>
            <span className={css.statHint}>{t('封', 'messages')}</span>
          </div>
          <div className={css.statCard} data-tone="waiting">
            <span className={css.statLabel}>{t('等你处理', 'Awaiting you')}</span>
            <strong className={css.statValue}>{list.pendingCount}</strong>
            <span className={css.statHint}>{t('封', 'messages')}</span>
          </div>
          <div className={css.statCard} data-tone="oldest">
            <span className={css.statLabel}>{t('等待最久', 'Longest wait')}</span>
            <strong className={css.statValue}>{oldest ? waitTime(now.getTime() - oldest.createdAt, t) : '—'}</strong>
            <span className={css.statHint}>{oldest ? t('需要优先处理', 'Needs attention first') : t('暂无积压', 'Nothing queued')}</span>
          </div>
        </div>}
        {listError && <div className={css.listError}>
          <p role="alert" className={css.error}>{listError}</p>
          <Button onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</Button>
        </div>}
        {list ? <div className={css.listCard}>
          <div className={css.cardHeading}>
            <h2>{t(...folders[folder])}</h2>
            <span>{view === 'grouped' ? t('按会话分组', 'Grouped by conversation') : t(`${visible.length} 封邮件`, `${visible.length} messages`)}</span>
            <div className={css.listActions}>
              <div className={css.viewToggle} role="group" aria-label={t('展示形态', 'Layout')}>
                <button type="button" aria-pressed={view === 'cards'} disabled={bulkBusy}
                  onClick={() => setView('cards')}>{t('卡片', 'Cards')}</button>
                <button type="button" aria-pressed={view === 'grouped'} disabled={bulkBusy}
                  onClick={() => setView('grouped')}>{t('分组', 'Grouped')}</button>
              </div>
              {view === 'cards' && conversationOptions.length > 1 && <select className={css.conversationSelect}
                aria-label={t('按会话筛选', 'Filter by conversation')} value={groupFilter ?? ''} disabled={bulkBusy}
                onChange={event => { setGroupFilter(event.currentTarget.value === '' ? undefined : event.currentTarget.value); setSelectedRows(new Set()) }}>
                <option value="">{t('全部会话', 'All conversations')}</option>
                {conversationOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
              </select>}
              {canBatch && <label className={css.selectAll}>
                <input type="checkbox" checked={ids.length === visible.length} disabled={bulkBusy}
                  ref={input => { if (input) input.indeterminate = ids.length > 0 && ids.length < visible.length }}
                  onChange={event => setSelectedRows(event.target.checked ? new Set(visible.map(item => item.id)) : new Set())} />
                {t('全选', 'Select all')}
              </label>}
              <Button size="sm" icon={<ListFilter size={15} />} aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}>
                {filter ? t(...reasons[filter]) : t('筛选', 'Filter')}
              </Button>
            </div>
          </div>
          {filterOpen && <div className={css.filters} aria-label={t('裁决类别', 'Decision categories')}>
            {([undefined, ...Object.keys(reasons)] as Array<DecisionReason | undefined>).map(reason =>
              <Button key={reason ?? 'all'} size="sm" variant={filter === reason ? 'primary' : 'outline'} aria-pressed={filter === reason}
                disabled={bulkBusy} onClick={() => { setFilter(reason); setSelectedRows(new Set()); setBulkError('') }}>
                {reason ? t(...reasons[reason]) : t('全部', 'All')}
              </Button>)}
          </div>}
          {ids.length > 0 && <div className={css.batchBar}>
            <strong>{t(`已选 ${ids.length} 封`, `${ids.length} selected`)}</strong>
            {folder === 'snoozed'
              ? <Button size="sm" disabled={bulkBusy} icon={<RotateCcw size={15} />}
                  onClick={() => { void updateSelected({ action: 'restore' }) }}>{t('移回待处理', 'Move to pending')}</Button>
              : <Button size="sm" disabled={bulkBusy} icon={<Clock3 size={15} />}
                  onClick={() => { void updateSelected({ action: 'snooze', until: Date.now() + 60 * 60 * 1_000 }) }}>{t('稍后 1 小时', 'Snooze for 1 hour')}</Button>}
            <Button size="sm" disabled={bulkBusy} icon={<Archive size={15} />}
              onClick={() => { void updateSelected({ action: 'archive' }) }}>{t('归档', 'Archive')}</Button>
          </div>}
          {bulkError && <p className={css.bulkError} role="alert">{bulkError}</p>}
          {groups.size === 0 ? <div className={css.empty}>
            <Inbox size={26} />
            <p>{filter !== undefined || groupFilter !== undefined
              ? t('没有符合筛选条件的邮件', 'No messages match this filter')
              : folder === 'pending' ? t('暂无待你决定的事项', 'Nothing needs your decision') : t('这个分类还没有邮件', 'No messages in this folder')}</p>
          </div> : view === 'cards' ? <ul className={css.cardGrid}>
            {visible.map(item => <MailCard key={item.id} item={item} canBatch={canBatch} selected={selectedRows.has(item.id)}
              disabled={bulkBusy} t={t} locale={settings.locale} onToggle={toggleRow} onOpen={id => {
                setMail(undefined)
                setSelectedId(id)
              }} />)}
          </ul> : Array.from(groups, ([id, group]) => <details className={css.group} key={id} open>
            <summary data-kind={group.mails[0]?.kind}><strong>{group.title}</strong><span>{t(`${group.mails.length} 封`, `${group.mails.length} messages`)}</span><ChevronDown size={15} /></summary>
            <ul className={css.cardGrid}>
              {group.mails.map(item => <MailCard key={item.id} item={item} canBatch={canBatch} selected={selectedRows.has(item.id)}
                disabled={bulkBusy} t={t} locale={settings.locale} onToggle={toggleRow} onOpen={id => {
                  setMail(undefined)
                  setSelectedId(id)
                }} />)}
            </ul>
          </details>)}
        </div> : !listError && <p role="status" className={css.loading}>{t('正在读取收件箱…', 'Loading inbox…')}</p>}
      </div>
    </div>
  </section>
}

export default function InboxPage({ workspaceId, ...props }: InboxPageProps): ReactNode {
  const { t } = useUiPreferences()
  if (!workspaceId) return <section className={css.page} aria-label={t('收件箱', 'Inbox')}>
    <div className={css.empty}><Inbox size={26} /><p>{t('选择工作区后查看收件箱', 'Select a workspace to open its inbox')}</p></div>
  </section>
  return <WorkspaceInbox key={workspaceId} workspaceId={workspaceId} {...props} />
}
