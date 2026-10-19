import { useMemo, useState } from 'react'
import {
  DiffBlock, DisclosureRow, IconBrowseOutlineRegular, IconCodeOutlineRegular, IconGlobeOutlineRegular,
  IconInspectOutlineRegular, IconPlanOutlineRegular, IconQuestionOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular,
  ImageLightbox, JsonBlock, ReadBlock, SearchBlock, StateDot, TerminalBlock, TextShimmer, WebBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContentBlock, InteractionRequest } from '../shared/types.ts'
import type { InspectorDiff } from './Inspector.tsx'
import type { PlanDocument } from './plan-preview.ts'
import type { ToolItem } from './render-model.ts'
import { diffLabels, readLabels, searchLabels, terminalLabels, webLabels, type Translate } from './render-labels.ts'
import {
  askQuestionRowModel, buildToolRenderModel, subagentRowModel,
  type AskQuestionRecord, type LateAnswer, type SubagentRowModel,
} from './tool-render-model.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './ToolCard.module.css'

interface ToolCardProps {
  item: ToolItem
  runRunning: boolean
  t: Translate
  /** Late answers by question call, so an answered row shows its record while pending results stay recorded. */
  replies?: ReadonlyMap<string, LateAnswer>
  /** Projected interactions, so the question row reads its call's DSH state (waiting/continued/closed). */
  interactions?: readonly InteractionRequest[]
  onOpenFile?: (path: string, line?: number) => void
  onInspectDiff?: (diff: InspectorDiff) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
  /** Open the child conversation a `subagent` call created, through the normal selection path. */
  onOpenSubagent?: (conversationId: string) => void
  /** Open this call's plan in the inspector's plan view (DSH's `openPlan`, `PlanCard.tsx:48-57`). */
  onOpenPlan?: (plan: PlanDocument) => void
}

/** The plan markdown a call carries, for the tools whose whole argument is the plan. */
function planArgument(item: ToolItem): string | undefined {
  if ((item.call?.name ?? item.result?.toolName)?.toLocaleLowerCase() !== 'exit_plan_mode') return undefined
  const value = item.call?.arguments.plan
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** The plan's first level-1 heading; DSH shows it as the row title instead of the whole plan. */
function planHeading(plan: string): string | undefined {
  const heading = plan.split('\n').map(line => line.trim()).find(line => line.startsWith('# '))
  const title = heading?.slice(2).trim()
  return title ? title : undefined
}

/** Render a Pi tool call and its durable result using the matching DSH output card. */
export default function ToolCard({ item, runRunning, t, replies, interactions, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan }: ToolCardProps) {
  const [open, setOpen] = useState(false)
  const model = useMemo(() => buildToolRenderModel(item, t, runRunning), [item, runRunning, t])
  const callId = item.call?.id ?? item.result?.toolCallId
  const interactionStatus = useMemo(() => callId === undefined
    ? undefined
    : interactions?.find(interaction => interaction.id === callId)?.status, [callId, interactions])
  const ask = useMemo(() => askQuestionRowModel({
    name: model.name,
    args: model.args,
    details: model.details,
    failed: model.failed,
    reply: callId === undefined ? undefined : replies?.get(callId),
    ...(interactionStatus === undefined ? {} : { status: interactionStatus }),
  }, t), [model, callId, replies, interactionStatus, t])
  const subagent = useMemo(() => subagentRowModel({
    name: model.name,
    args: model.args,
    details: model.details,
    failed: model.failed,
  }, t), [model, t])
  const plan = planArgument(item)
  const planDocument = plan === undefined ? undefined : {
    markdown: plan,
    ...(planHeading(plan) === undefined ? {} : { title: planHeading(plan) }),
  }
  const planTitleText = planDocument?.title ?? t('计划', 'Plan')
  const hasArgs = Object.keys(model.args).length > 0
  const hasResult = item.result !== undefined
  const hasDetails = model.details !== undefined && model.details !== null
  const hasChildren = item.children.length > 0
  const expandable = hasResult || hasArgs || hasDetails || hasChildren || model.artifacts.length > 0
  const icon = model.running ? <StateDot state="ongoing" size={14} />
    : model.failed ? <StateDot state="error" size={14} />
      : model.cancelled ? <StateDot state="warning" size={14} />
        : ask !== null ? <IconQuestionOutlineRegular size={14} />
          : toolIcon(model.name)
  const summary = ask !== null ? ask.summary : subagent !== null ? subagent.summary : model.summary
  const diagnostics = ask !== null && model.failed ? <span className={css.failedSummary}>{ask.summary}</span>
    : subagent !== null && model.failed ? <span className={css.failedSummary}>{t('子智能体未返回答案', 'The subagent returned no answer')}</span>
      : model.failed && model.errorText !== undefined ? <span className={css.failedSummary}>{model.errorText}</span>
        : model.cancelled ? <span className={css.stoppedSummary}>{t('已停止', 'Stopped')}</span>
          : <TextShimmer active={model.running}>{plan === undefined ? summary : t('计划 · Markdown', 'Plan · Markdown')}</TextShimmer>
  const title = ask !== null ? ask.title : subagent !== null ? subagent.title
    : plan === undefined || model.failed || model.cancelled ? model.title : planHeading(plan) ?? model.title
  const outputCard = model.command !== undefined ? (
    <TerminalBlock command={model.command} cwd={model.cwd} output={model.output}
      {...model.exitCode === undefined ? {} : { exitCode: model.exitCode }}
      {...model.signal === undefined ? {} : { signal: model.signal }}
      running={model.running} runStateDot={false} labels={terminalLabels(t)} />
  ) : model.read !== undefined ? (
    <ReadBlock label={model.path} lines={model.read.lines} totalLines={model.read.totalLines}
      lang={model.language} labels={readLabels(t)} />
  ) : model.diffs !== undefined ? (
    <DiffBlock diffs={[...model.diffs]} labels={diffLabels(t)} />
  ) : model.search !== undefined ? (
    <SearchBlock {...model.search} labels={searchLabels(t)} />
  ) : model.web !== undefined ? (
    <WebBlock {...model.web} labels={webLabels(t)} />
  ) : null
  const hasOutputCard = outputCard !== null
  const unknownPayload = !model.knownPresentation && !hasOutputCard
  // A recorded question pair replaces the row's own I/O card the way DSH's
  // transcript card does; the raw arguments and details stay available below.
  const record = ask?.record ?? null
  const resultText = !hasOutputCard && record === null && model.output !== '' ? model.output : ''
  const sourceMessage = item.call === undefined ? item.result ?? item.message : item.message
  const toolImages = item.result?.blocks.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image') ?? []
  const toolFiles = item.result?.blocks.filter((block): block is Extract<ContentBlock, { type: 'file' }> => block.type === 'file') ?? []
  const inspect = onOpenTool === undefined ? undefined : () => { onOpenTool(sourceMessage.id, item.call?.id) }
  // A plan call's arguments hold the whole plan, which the row already summarizes by its heading.
  // A subagent call's arguments hold the whole delegated task, shown by the receipt instead.
  const argsPayload = hasArgs && unknownPayload && plan === undefined && subagent === null ? model.args : undefined
  // DSH's plan card is one button: icon, plan title, "计划 · Markdown", and "打开"
  // (`ui-plan/src/client/PlanCard.tsx:48-57`, copy `locales.ts:7-11`).
  const planOpen = planDocument !== undefined && onOpenPlan !== undefined ? () => { onOpenPlan(planDocument) } : undefined
  // DSH's plan card action stays visible on the row (`PlanCard.tsx:48-57`), so the collapsed
  // process group still offers the same "打开" affordance as the expanded card below.
  const planAccessory = planOpen === undefined ? undefined
    : <button type="button" className={css.planOpenButton} data-plan-open={callId}
      aria-label={t(`打开计划：${planTitleText}`, `Open plan: ${planTitleText}`)}
      onClick={event => { event.stopPropagation(); planOpen() }}>{t('打开', 'Open')}</button>

  return (
    <div className={css.root} data-error={model.failed || undefined} data-stopped={model.cancelled || undefined}
      data-tool-name={model.name} data-parent-tool-call-id={item.parentToolCallId}>
      <DisclosureRow
        icon={icon}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        running={model.running}
        headerAccessory={planAccessory}
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={<span className={css.summary}><span className={css.sep} aria-hidden="true" />{diagnostics}</span>}
      >
        <div className={css.body}>
          {planDocument !== undefined && planOpen !== undefined && (
            <button type="button" className={css.planCard} data-plan-card={callId}
              aria-label={t(`打开计划：${planTitleText}`, `Open plan: ${planTitleText}`)} onClick={planOpen}>
              <span className={css.planCardIcon} aria-hidden="true"><IconPlanOutlineRegular size={18} /></span>
              <span className={css.planCardDetails}>
                <span className={css.planCardTitle}>{planTitleText}</span>
                <span className={css.planCardDescription}>{t('计划 · Markdown', 'Plan · Markdown')}</span>
              </span>
              <span className={css.planCardOpen}>{t('打开', 'Open')}</span>
            </button>
          )}
          {model.path !== undefined && onOpenFile !== undefined && !model.failed && !model.cancelled && (
            <button type="button" className={css.pathLink} onClick={() => { onOpenFile(model.path ?? '') }}>{model.path}</button>
          )}
          {record !== null && <QuestionRecord record={record} t={t} />}
          {subagent !== null && <SubagentReceipt row={subagent} onOpen={onOpenSubagent} t={t} />}
          {outputCard}
          {resultText !== '' && <pre className={css.output}>{resultText}</pre>}
          {toolImages.map((block, index) => <ToolImage key={`${item.key}:image:${index}`} block={block} />)}
          {toolFiles.map((block, index) => (
            <button key={`${item.key}:file:${index}`} type="button" className={css.pathLink}
              onClick={() => { onOpenFile?.(block.path) }} disabled={onOpenFile === undefined}>{block.name}</button>
          ))}
          {!hasResult && model.running && <div className={css.inProgress}><StateDot state="ongoing" size={10} />{t('等待工具结果', 'Waiting for tool result')}</div>}
          {!hasResult && !model.running && <div className={css.empty}>{t('没有可显示的工具结果', 'No tool result was recorded')}</div>}
          {hasResult && model.output === '' && !hasOutputCard && toolImages.length === 0 && toolFiles.length === 0
            && <div className={css.empty}>{t('工具没有返回可显示的内容', 'The tool returned no displayable content')}</div>}
          {argsPayload !== undefined && <JsonBlock label={t('调用参数', 'Call arguments')} payload={argsPayload}
            truncatedLabel={count => t(`内容过长，原始长度 ${count} 字符`, `Content too long (${count} characters)`)} />}
          {hasDetails && !hasOutputCard && subagent === null && <JsonBlock label={t('工具详情', 'Tool details')} payload={model.details}
            truncatedLabel={count => t(`内容过长，原始长度 ${count} 字符`, `Content too long (${count} characters)`)} />}
          {model.failed && <div className={css.errorLabel} role="alert">{t('工具执行失败', 'Tool failed')}</div>}
          {model.cancelled && <div className={css.stoppedLabel} role="status">{t('工具已停止', 'Tool stopped')}</div>}
          {hasChildren && <div className={css.nestedTools}>
            {item.children.map(child => <ToolCard key={child.key} item={child} runRunning={runRunning} replies={replies}
              interactions={interactions} onOpenSubagent={onOpenSubagent} onOpenPlan={onOpenPlan}
              t={t} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} />)}
          </div>}
          {onInspectDiff !== undefined && model.diffs !== undefined && model.diffs.map((diff, index) => (
            <button key={`${item.key}:inspect:${index}`} type="button" className={css.inspectButton}
              onClick={() => { onInspectDiff(toInspectorDiff(diff)) }}>
              <IconInspectOutlineRegular size={13} />{t('在侧栏查看差异', 'Inspect diff in side panel')}
            </button>
          ))}
          {inspect !== undefined && <button type="button" className={css.inspectButton} onClick={inspect}>
            <IconInspectOutlineRegular size={13} />{t('在轨迹中查看', 'Inspect in trajectory')}
          </button>}
        </div>
      </DisclosureRow>
    </div>
  )
}

/**
 * The row's read-only question record: one question per line with the values
 * the user chose (multi-select joined by 、) or 已跳过. While the questions are
 * still waiting there is nothing to answer with, so the list stays questions-only.
 * DSH's verdict line closes a continued, closed, or cancelled record.
 */
function QuestionRecord({ record, t }: { record: AskQuestionRecord; t: Translate }) {
  return (
    <dl className={css.questionRecord} data-question-record={record.waiting ? 'waiting' : 'answered'}>
      {record.verdict !== undefined && <div className={css.questionVerdict}>{record.verdict}</div>}
      {record.items.map(item => (
        <div key={item.id}>
          <dt className={css.questionText}>{item.question}</dt>
          {!record.waiting && <dd className={css.questionAnswer} data-skipped={item.answers.length === 0 || undefined}>
            {item.answers.length === 0 ? t('已跳过', 'Skipped') : item.answers.join(t('、', ', '))}
          </dd>}
        </div>
      ))}
    </dl>
  )
}

/**
 * The `subagent` row's receipt, standing in for DSH's `started subagent <id>` details
 * card: the delegated task takes the place of the raw JSON arguments, and the child
 * conversation opens through the ordinary conversation selection.
 */
function SubagentReceipt({ row, onOpen, t }: { row: SubagentRowModel; onOpen?: (conversationId: string) => void; t: Translate }) {
  return (
    <div className={css.subagentReceipt} data-subagent-receipt>
      <div className={css.subagentMeta}>
        <span className={css.subagentStatus}>{t('已开始子智能体', 'Started subagent')}</span>
        {row.childId !== undefined && <span>{t('子会话', 'Subagent session')}: {row.childId}</span>}
      </div>
      {row.task !== undefined && <div className={css.subagentTask} data-subagent-task>{row.task}</div>}
      {row.childId !== undefined && onOpen !== undefined && (
        <button type="button" className={css.inspectButton} data-open-subagent onClick={() => { onOpen(row.childId ?? '') }}>
          <IconBrowseOutlineRegular size={13} />{t('打开子会话', 'Open subagent session')}
        </button>
      )}
    </div>
  )
}

function toolIcon(name: string) {
  const normalized = name.toLocaleLowerCase()
  if (/^(bash|shell|exec|terminal|run_command)$/u.test(normalized)) return <IconCodeOutlineRegular size={14} />
  if (/^(read|read_file|readfile|cat)$/u.test(normalized)) return <IconBrowseOutlineRegular size={14} />
  if (/^exit_plan_mode$/u.test(normalized)) return <IconPlanOutlineRegular size={14} />
  if (/^(ask_user_question|request_user_input)$/u.test(normalized)) return <IconQuestionOutlineRegular size={14} />
  if (/web|fetch/u.test(normalized)) return <IconGlobeOutlineRegular size={14} />
  if (/search|grep|glob|find/u.test(normalized)) return <IconSearchOutlineRegular size={14} />
  return <IconSparkleRegular size={14} />
}

function ToolImage({ block }: { block: Extract<ContentBlock, { type: 'image' }> }) {
  const [open, setOpen] = useState(false)
  const { t } = useUiPreferences()
  return (
    <>
      <button type="button" className={css.imageButton} onClick={() => { setOpen(true) }} aria-label={t('打开图片预览', 'Open image preview')}>
        <img src={block.url} alt={t('工具返回的图片', 'Image returned by tool')} loading="lazy" />
      </button>
      {open && <ImageLightbox src={block.url} alt={t('工具返回的图片', 'Image returned by tool')}
        labels={{ dialog: t('图片预览', 'Image preview'), close: t('关闭图片预览', 'Close image preview') }} onClose={() => { setOpen(false) }} />}
    </>
  )
}

function toInspectorDiff(diff: { path: string; oldText: string | null; newText: string }): InspectorDiff {
  return { path: diff.path, oldText: diff.oldText, newText: diff.newText }
}

