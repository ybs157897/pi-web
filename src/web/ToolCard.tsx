import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconPlanOutlineRegular, ImageLightbox, JsonBlock, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SquareTerminal, Search, Pencil, FilePlus2, Globe, Braces, Bot, ListTodo, CircleHelp, Sparkles, Ellipsis, WandSparkles } from 'lucide-react'
import type { ContentBlock, InteractionRequest } from '../shared/types.ts'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import type { InspectorDiff } from './Inspector.tsx'
import type { PlanDocument } from './plan-preview.ts'
import type { ToolItem } from './render-model.ts'
import { type Translate } from './render-labels.ts'
import {
  askQuestionRowModel, buildToolRenderModel, codemodeRowModel, skillRowModel, subagentRowModel,
  type AskQuestionRecord, type CodemodeCallStatus, type CodemodeRowModel, type LateAnswer, type SkillRowModel,
} from './tool-render-model.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { PluginUiCard } from './PluginUiCard.tsx'
import { PluginUiConversationContext, pluginUiDescriptor } from './plugin-ui-bridge.ts'
import { ProcessRow } from './ProcessRow.tsx'
import { ProcessTerminal } from './ProcessTerminal.tsx'
import { useProcessExpansion } from './message-rendering/ProcessExpansion.tsx'
import { MessageCodeBlock } from './message-rendering/CodeBlock.tsx'
import { CodeViewer } from './message-rendering/CodeViewer.tsx'
import { MessageFileIcon } from './message-rendering/FileIcon.tsx'
import { ToolDiff, toolDiffLines } from './message-rendering/ToolDiff.tsx'
import css from './ToolCard.module.css'

interface ToolCardProps {
  item: ToolItem
  runRunning: boolean
  t: Translate
  /** A grouped child row hides its icon; ZCode keeps the parent group's icon only. */
  showIcon?: boolean
  /** Late answers by question call, so an answered row shows its record while pending results stay recorded. */
  replies?: ReadonlyMap<string, LateAnswer>
  /** Projected interactions, so the question row reads its call's DSH state (waiting/continued/closed). */
  interactions?: readonly InteractionRequest[]
  onOpenFile?: (path: string, line?: number) => void
  onInspectDiff?: (diff: InspectorDiff) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
  /** Open the child conversation a `subagent` call created as a read-only inspector tab. */
  onOpenSubagent?: (conversationId: string, title?: string) => void
  /** Open this call's plan in the inspector's plan view (DSH's `openPlan`, `PlanCard.tsx:48-57`). */
  onOpenPlan?: (plan: PlanDocument) => void
  /** Open a plugin UI page in the right inspector; a fullscreen surface opens automatically once. */
  onOpenPluginUi?: (page: PluginUiPage, host?: HTMLElement) => void
  /** Context/message/link relays an inline plugin page needs; the host supplies the real ones. */
  onPluginContext?: (entry: PluginContextEntry) => void
  onPluginMessage?: (text: string) => void
  onPluginOpenLink?: (url: string) => void
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

/** Present a host tool call with the appropriate summary, file action or expandable result. */
export default function ToolCard({ item, runRunning, t, showIcon = true, replies, interactions, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan, onOpenPluginUi, onPluginContext, onPluginMessage, onPluginOpenLink }: ToolCardProps) {
  const [open, setOpen] = useProcessExpansion(item.key)
  const model = useMemo(() => buildToolRenderModel(item, t, runRunning), [item, runRunning, t])
  const callId = item.call?.id ?? item.result?.toolCallId
  // A plugin MCP tool may carry `details.ui`: its sandboxed page replaces the generic
  // arguments/details dump, and a fullscreen surface opens in the inspector once instead.
  const pluginUi = useMemo(() => pluginUiDescriptor(model.details), [model.details])
  const structuredContent = model.details !== null && typeof model.details === 'object' && !Array.isArray(model.details)
    ? (model.details as Record<string, unknown>).structuredContent
    : undefined
  const pluginConversationId = useContext(PluginUiConversationContext)
  const pluginPage = useMemo<PluginUiPage | undefined>(() => {
    if (pluginUi === undefined) return undefined
    const pageKey = pluginUi.toolCallId ?? callId ?? pluginUi.resourceUri
    return {
      ...pluginUi,
      id: `${pluginUi.pluginId}:${pageKey}`,
      ...(pluginConversationId === undefined ? {} : { conversationId: pluginConversationId }),
      ...(item.result === undefined ? {} : {
        content: item.result.blocks.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []),
      }),
      ...(structuredContent === undefined ? {} : { structuredContent }),
    }
  }, [pluginUi, pluginConversationId, callId, item.result])
  const pluginUiSettled = item.result !== undefined && !model.running && !model.failed && !model.cancelled
  const pluginUiFullscreen = pluginUiSettled && pluginPage !== undefined && pluginUi?.preferredDisplayMode === 'fullscreen'
  const pluginUiInline = pluginUiSettled && pluginUi !== undefined && pluginPage !== undefined
    && pluginUi.preferredDisplayMode !== 'fullscreen' && pluginUi.showInline !== false
  const pluginUiPresented = pluginUiInline || pluginUiFullscreen
  const openedPluginUi = useRef<string | undefined>(undefined)
  const autoOpenedPluginInline = useRef(false)
  // A tool result that carries an inline plugin page is content, not hidden detail: open the
  // row once so the card is visible without the user hunting for the disclosure arrow.
  useEffect(() => {
    if (!pluginUiInline || autoOpenedPluginInline.current) return
    autoOpenedPluginInline.current = true
    setOpen(true)
  }, [pluginUiInline, setOpen])
  useEffect(() => {
    if (!pluginUiFullscreen || pluginPage === undefined || onOpenPluginUi === undefined) return
    if (openedPluginUi.current === pluginPage.id) return
    openedPluginUi.current = pluginPage.id
    onOpenPluginUi(pluginPage)
  }, [pluginUiFullscreen, pluginPage, onOpenPluginUi])
  const interactionStatus = useMemo(() => callId === undefined
    ? undefined
    : interactions?.find(interaction => interaction.id === callId)?.status, [callId, interactions])
  const ask = useMemo(() => askQuestionRowModel({
    name: model.name,
    args: model.args,
    details: model.details,
    failed: model.failed,
    running: model.running,
    reply: callId === undefined ? undefined : replies?.get(callId),
    ...(interactionStatus === undefined ? {} : { status: interactionStatus }),
  }, t), [model, callId, replies, interactionStatus, t])
  const subagent = useMemo(() => subagentRowModel({
    name: model.name,
    args: model.args,
    details: model.details,
    failed: model.failed,
  }, t), [model, t])
  const subagentOpen = subagent?.childId !== undefined && onOpenSubagent !== undefined
    ? () => { onOpenSubagent(subagent.childId as string, subagent.label) }
    : undefined
  // The row's receipt carries the parent's delegated task; the 「任务：」 prefix keeps it
  // distinguishable from the child's own answer, which the subagent panel preview shows.
  const subagentPrimary = subagent === null ? undefined
    : [subagent.label, subagent.task === undefined || subagent.task === '' ? undefined : t('任务：', 'Task: ') + subagent.task]
      .filter((part): part is string => part !== undefined && part !== '').join(' · ') || subagent.summary
  const subagentStatus = subagent === null ? undefined
    : model.failed ? t('失败', 'Failed') : model.cancelled ? t('已停止', 'Stopped') : model.running ? t('运行中', 'Running') : t('已完成', 'Finished')
  // A code-mode result carries its script's nested calls, so the row shows the script,
  // the calls it made, and the result text instead of a generic arguments JSON dump.
  const codemode = useMemo(() => codemodeRowModel({
    name: model.name,
    args: model.args,
    details: model.details,
    output: model.output,
  }, t), [model, t])
  // ZCode's Skill card replaces the raw arguments and details dump with the skill id,
  // its optional resource, and the loaded text.
  const skill = useMemo(() => skillRowModel({
    name: model.name,
    args: model.args,
    running: model.running,
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
  // Subagent children are lifted into the transcript's colored strip, so they are not repeated
  // as nested tool rows under their `codemode` parent.
  const visibleChildren = item.children.filter(child =>
    (child.result?.toolName ?? child.message.toolName)?.toLocaleLowerCase() !== 'subagent')
  const hasChildren = visibleChildren.length > 0
  const fileRead = model.read !== undefined && model.path !== undefined && onOpenFile !== undefined && !model.failed && !model.cancelled && !hasChildren && !(item.result?.blocks.some(block => block.type === 'image' || block.type === 'file'))
  // ZCode's read/search rows are summary-only; a listing keeps its result behind the disclosure.
  const readOnlySummary = /^(find_files|find|glob|grep|ripgrep|search)$/u.test(model.name.toLocaleLowerCase())
  const listingRow = model.name.toLocaleLowerCase() === 'list_files'
  const summaryOnly = fileRead || subagent !== null || (model.search !== undefined || model.web !== undefined || readOnlySummary) && !model.failed && !model.cancelled && !hasChildren
  const expandable = ask !== null ? ask.record !== null : !summaryOnly && (hasResult || hasArgs || hasDetails || hasChildren || model.artifacts.length > 0)
  const icon = ask !== null ? <CircleHelp size={16} />
    : codemode !== null ? <Braces size={16} /> : skill !== null ? <WandSparkles size={16} /> : toolIcon(model.name)
  const summary = ask !== null ? ask.summary : subagent !== null ? (subagentPrimary ?? subagent.summary)
    : codemode !== null ? codemode.summary : skill !== null ? (skill.skill ?? model.summary)
      : model.command !== undefined ? model.command.replace(/\s+/gu, ' ').trim() : model.summary
  const diagnostics = ask !== null && model.failed ? <span className={css.failedSummary}>{ask.summary}</span>
    : subagent !== null && model.failed ? <span className={css.failedSummary}>{t('子智能体未返回答案', 'The subagent returned no answer')}</span>
      : skill !== null && skill.skill !== undefined
        ? <code className={css.skillRowName}>{skill.resource === undefined ? skill.skill : `${skill.skill} · ${skill.resource}`}</code>
        : <span>{plan === undefined ? summary : t('计划 · Markdown', 'Plan · Markdown')}</span>
  // ZCode keeps the failure/stop word at the end of the row; the detail lives in its tooltip.
  const statusAccessory = ask === null && subagent === null && model.failed
    ? <span className={css.statusFailed} title={model.errorText}>{t('执行失败', 'Failed')}</span>
    : ask === null && subagent === null && model.cancelled
      ? <span className={css.statusStopped}>{t('已停止', 'Stopped')}</span>
      : undefined
  const title = ask !== null ? ask.title : subagent !== null ? subagent.title
    : codemode !== null ? codemode.title
      : skill !== null ? skill.title
        : model.command !== undefined ? (model.running ? t('正在执行', 'Running') : t('终端', 'Terminal'))
          : plan === undefined || model.failed || model.cancelled ? model.title : planHeading(plan) ?? model.title
  const outputCard = model.command !== undefined ? (
    <ProcessTerminal command={model.command} cwd={model.cwd} output={model.output}
      {...model.exitCode === undefined ? {} : { exitCode: model.exitCode }}
      {...model.signal === undefined ? {} : { signal: model.signal }}
      running={model.running} t={t} />
  ) : model.read !== undefined ? (
    fileRead ? null : <div className={css.fileContent}><CodeViewer code={model.read.lines.map(line => line.text).join('\n')} language={model.language} lineNumbers /></div>
  ) : model.diffs !== undefined ? (
    <ToolDiff diffs={model.diffs} t={t} />
  ) : null
  const hasOutputCard = outputCard !== null
  const unknownPayload = !model.knownPresentation && !hasOutputCard
  // A recorded question pair replaces the row's own I/O card the way DSH's
  // transcript card does; the raw arguments and details stay available below.
  const record = ask?.record ?? null
  const resultText = !hasOutputCard && ask === null && subagent === null && codemode === null && skill === null && !pluginUiPresented && model.output !== '' ? model.output : ''
  const sourceMessage = item.call === undefined ? item.result ?? item.message : item.message
  const toolImages = item.result?.blocks.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image') ?? []
  const toolFiles = item.result?.blocks.filter((block): block is Extract<ContentBlock, { type: 'file' }> => block.type === 'file') ?? []
  const inspect = onOpenTool === undefined ? undefined : () => { onOpenTool(sourceMessage.id, item.call?.id) }
  // A plan call's arguments hold the whole plan, which the row already summarizes by its heading.
  // A subagent call's arguments hold the whole delegated task, shown by the receipt instead.
  // A code-mode call's argument is the script, shown by its own card instead of raw JSON.
  // The question row's record replaces its raw I/O the way ZCode's ask row does; the
  // arguments and details stay available through the inspect button.
  const argsPayload = hasArgs && unknownPayload && plan === undefined && ask === null && subagent === null && codemode === null && skill === null && !pluginUiPresented
    ? model.args : undefined
  // DSH's plan card is one button: icon, plan title, "计划 · Markdown", and "打开"
  // (`ui-plan/src/client/PlanCard.tsx:48-57`, copy `locales.ts:7-11`).
  const planOpen = planDocument !== undefined && onOpenPlan !== undefined ? () => { onOpenPlan(planDocument) } : undefined
  // DSH's plan card action stays visible on the row (`PlanCard.tsx:48-57`), so the collapsed
  // process group still offers the same "打开" affordance as the expanded card below.
  const planAccessory = planOpen === undefined ? undefined
    : <button type="button" className={css.planOpenButton} data-plan-open={callId}
      aria-label={t(`打开计划：${planTitleText}`, `Open plan: ${planTitleText}`)}
      onClick={event => { event.stopPropagation(); planOpen() }}>{t('打开', 'Open')}</button>

  const fileSummary = (fileRead || model.diffs !== undefined) && model.path && !model.failed && !model.cancelled ? <span className={css.fileSummary}>
    {onOpenFile ? <button type="button" className={css.fileChip} title={model.path} onClick={() => { const diff = model.diffs?.[0]; if (diff && onInspectDiff) onInspectDiff(toInspectorDiff(diff)); else onOpenFile(model.path!) }}><MessageFileIcon path={model.path} /><span>{model.path.split(/[/\\]/u).at(-1)}</span></button>
      : <span className={css.fileChip}><MessageFileIcon path={model.path} /><span>{model.path.split(/[/\\]/u).at(-1)}</span></span>}
    {directoryOf(model.path) !== undefined && <span className={css.directory}>{directoryOf(model.path)}</span>}
    {model.diffs && <span className={css.diffCounts}>{(() => { const lines = model.diffs.flatMap(diff => toolDiffLines(diff.oldText, diff.newText)); return <><span>+{lines.filter(line => line.kind === 'add').length}</span><span>−{lines.filter(line => line.kind === 'remove').length}</span></> })()}</span>}
  </span> : undefined
  const inspectButton = inspect === undefined ? undefined
    : <button type="button" className={css.rowInspect} title={t('查看工具记录', 'Inspect tool record')} aria-label={t('查看工具记录', 'Inspect tool record')} onClick={inspect}><Ellipsis size={14} /></button>
  const subagentAccessory = subagentStatus === undefined ? undefined
    : <span className={css.subagentStatus}>{subagentStatus}</span>
  const accessory = statusAccessory === undefined && planAccessory === undefined && inspectButton === undefined && subagentAccessory === undefined ? undefined
    : <span className={css.accessories}>{statusAccessory}{subagentAccessory}{planAccessory}{inspectButton}</span>

  return (
    <div className={css.root} data-error={model.failed || undefined} data-stopped={model.cancelled || undefined}
      data-tool-name={model.name} data-parent-tool-call-id={item.parentToolCallId}>
      <ProcessRow
        icon={icon}
        showIcon={showIcon}
        title={title}
        open={open}
        expandable={expandable}
        running={model.running}
        accessory={accessory}
        onActivate={subagentOpen}
        interactiveSummary={fileSummary !== undefined}
        keepSummaryWhenOpen={fileSummary !== undefined || listingRow || skill !== null}
        toggleLabel={subagent !== null ? t('打开子智能体会话', 'Open subagent session')
          : open ? t('收起工具详情', 'Collapse tool details') : t('展开工具详情', 'Expand tool details')}
        onToggle={() => { setOpen(value => !value) }}
        summary={fileSummary ?? <span className={css.summary}>{diagnostics}</span>}
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
          {pluginUiInline && pluginPage !== undefined && (
            <PluginUiCard page={pluginPage} onOpenSidePane={onOpenPluginUi}
              onContext={onPluginContext ?? noop} onMessage={onPluginMessage ?? noop}
              onOpenLink={onPluginOpenLink ?? openExternalLink} />
          )}
          {model.path !== undefined && fileSummary === undefined && onOpenFile !== undefined && !model.failed && !model.cancelled && (
            <button type="button" className={css.pathLink} onClick={() => { onOpenFile(model.path ?? '') }}>{model.path}</button>
          )}
          {record !== null && <QuestionRecord record={record} t={t} />}
          {codemode !== null && <CodemodeBody row={codemode} onOpenFile={onOpenFile} t={t} />}
          {skill !== null && <SkillBody skill={skill} output={model.output} running={model.running} failed={model.failed} cancelled={model.cancelled} t={t} />}
          {outputCard}
          {resultText !== '' && <pre className={css.output}>{resultText}</pre>}
          {toolImages.map((block, index) => <ToolImage key={`${item.key}:image:${index}`} block={block} />)}
          {toolFiles.map((block, index) => (
            <button key={`${item.key}:file:${index}`} type="button" className={css.pathLink}
              onClick={() => { onOpenFile?.(block.path) }} disabled={onOpenFile === undefined}>{block.name}</button>
          ))}
          {!hasResult && model.running && <div className={css.inProgress}><StateDot state="ongoing" size={10} />{t('等待工具结果', 'Waiting for tool result')}</div>}
          {!hasResult && !model.running && <div className={css.empty}>{t('没有可显示的工具结果', 'No tool result was recorded')}</div>}
          {hasResult && model.output === '' && ask === null && !hasOutputCard && codemode === null && skill === null && !pluginUiPresented && toolImages.length === 0 && toolFiles.length === 0
            && <div className={css.empty}>{t('工具没有返回可显示的内容', 'The tool returned no displayable content')}</div>}
          {argsPayload !== undefined && <JsonBlock label={t('调用参数', 'Call arguments')} payload={argsPayload}
            truncatedLabel={count => t(`内容过长，原始长度 ${count} 字符`, `Content too long (${count} characters)`)} />}
          {hasDetails && !hasOutputCard && ask === null && subagent === null && codemode === null && skill === null && !pluginUiPresented && <JsonBlock label={t('工具详情', 'Tool details')} payload={model.details}
            truncatedLabel={count => t(`内容过长，原始长度 ${count} 字符`, `Content too long (${count} characters)`)} />}
          {model.failed && <div className={css.errorLabel} role="alert">{t('工具执行失败', 'Tool failed')}</div>}
          {model.cancelled && <div className={css.stoppedLabel} role="status">{t('工具已停止', 'Tool stopped')}</div>}
          {hasChildren && <div className={css.nestedTools}>
            {visibleChildren.map(child => <ToolCard key={child.key} item={child} runRunning={runRunning} replies={replies}
              interactions={interactions} onOpenSubagent={onOpenSubagent} onOpenPlan={onOpenPlan}
              onOpenPluginUi={onOpenPluginUi} onPluginContext={onPluginContext} onPluginMessage={onPluginMessage}
              onPluginOpenLink={onPluginOpenLink}
              t={t} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} />)}
          </div>}
        </div>
      </ProcessRow>
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
  // ZCode's answered-question block: each question, then the chosen values (or the
  // no-answer line) in the secondary color, hung off the row's left rule.
  return (
    <dl className={css.questionRecord} data-question-record>
      {record.items.map(item => (
        <div key={item.id}>
          <dt className={css.questionText}>{item.question}</dt>
          <dd className={css.questionAnswer} data-answered={item.answers.length > 0 || undefined}>
            {item.answers.length === 0 ? t('未提供回答', 'No answer provided') : item.answers.join(t('，', ', '))}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * ZCode's Skill card: the kind label, the skill id as a code chip, the optional resource and
 * the tool's own text. The raw arguments/details JSON stays out of the way.
 */
function SkillBody({ skill, output, running, failed, cancelled, t }: {
  skill: SkillRowModel
  output: string
  running: boolean
  failed: boolean
  cancelled: boolean
  t: Translate
}) {
  return <div className={css.skillCard} data-skill-card>
    <div className={css.skillHead}>
      <span className={css.skillLabel}>{t('技能', 'Skill')}</span>
      <code className={css.skillChip}>{skill.skill ?? t('未知技能', 'Unknown skill')}</code>
    </div>
    {skill.resource !== undefined && <div className={css.skillArgs}>
      <span className={css.skillLabel}>{t('资源', 'Resource')}</span>
      <code className={css.skillArgValue}>{skill.resource}</code>
    </div>}
    {output !== '' && <pre className={css.skillOutput}>{output}</pre>}
    {output === '' && running && <div className={css.inProgress}><StateDot state="ongoing" size={10} />{t('正在读取技能内容', 'Loading the skill body')}</div>}
    {output === '' && !running && !failed && !cancelled && <p className={css.skillEmpty}>{t('没有输出。', 'No output.')}</p>}
  </div>
}

/**
 * The `codemode` card: the script the model ran, the result text, and the tool calls
 * the script made with their state. The script replaces the raw arguments JSON, and
 * the result's complete-output file is offered when the text was cut.
 */
function CodemodeBody({ row, onOpenFile, t }: { row: CodemodeRowModel; onOpenFile?: (path: string) => void; t: Translate }) {
  const fullOutputPath = row.fullOutputPath
  // Delegated children are shown by the transcript's subagent strip, not as script call rows.
  const calls = row.calls.filter(call => call.name.toLocaleLowerCase() !== 'subagent')
  return <div className={css.codemode} data-codemode>
    {row.script !== '' && <div className={css.codemodeSection}>
      <span className={css.codemodeLabel}>{t('脚本', 'Script')}</span>
      <div className={css.codemodeScript}>
        <MessageCodeBlock code={row.script} language="javascript" lineNumbers t={t}
          />
      </div>
    </div>}
    {row.output !== '' && <div className={css.codemodeSection}>
      <span className={css.codemodeLabel}>{t('输出', 'Output')}</span>
      <pre className={css.output}>{row.output}</pre>
      {fullOutputPath !== undefined && (onOpenFile === undefined
        ? <code className={css.codemodePath}>{fullOutputPath}</code>
        : <button type="button" className={css.pathLink}
          onClick={() => { onOpenFile(fullOutputPath) }}>
          {t(`完整输出：${fullOutputPath}`, `Full output: ${fullOutputPath}`)}
        </button>)}
    </div>}
    {calls.length > 0 && <div className={css.codemodeSection}>
      <span className={css.codemodeLabel}>{t(`脚本内工具调用（${calls.length}）`, `Tool calls in script (${calls.length})`)}</span>
      <ul className={css.codemodeCalls}>
        {calls.map((call, index) => <li key={`${call.id}:${index}`} className={css.codemodeCall} data-status={call.status}>
          <span className={css.codemodeCallName} title={call.args === '' ? call.name : call.args}>{call.name}</span>
          <span className={css.codemodeCallSep} aria-hidden="true">·</span>
          <span className={css.codemodeCallStatus}>{codemodeCallLabel(call.status, t)}</span>
          {call.durationMs !== undefined && <>
            <span className={css.codemodeCallSep} aria-hidden="true">·</span>
            <span className={css.codemodeCallDuration}>{formatCallDuration(call.durationMs)}</span>
          </>}
          {call.error !== undefined && <span className={css.codemodeCallError}>{call.error}</span>}
        </li>)}
      </ul>
    </div>}
  </div>
}

/** The script call's state in DSH's wording. */
function codemodeCallLabel(status: CodemodeCallStatus, t: Translate): string {
  switch (status) {
    case 'running': return t('运行中', 'running')
    case 'ok': return t('完成', 'ok')
    case 'error': return t('失败', 'error')
    case 'cancelled': return t('已取消', 'cancelled')
  }
}

/** Compact call duration: milliseconds under a second, then seconds with one decimal. */
function formatCallDuration(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`
}

/** Inline plugin pages need relays even when the host has not wired them yet. */
function noop(): void {}

/** The fallback `ui/open-link` target: a new tab with no opener, https only (the bridge checks). */
function openExternalLink(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function toolIcon(name: string) {  const normalized = name.toLowerCase()
  if (/^(bash|pwsh|shell|exec|exec_command|write_stdin|terminal|run_command)$/u.test(normalized)) return <SquareTerminal size={16} />
  if (/^(read|read_file|readfile|cat|read_image)$/u.test(normalized) || /search|grep|glob|find/u.test(normalized)) return <Search size={16} />
  if (/write|create_file/u.test(normalized)) return <FilePlus2 size={16} />
  if (/edit|patch/u.test(normalized)) return <Pencil size={16} />
  if (/plan|todo|goal/u.test(normalized)) return <ListTodo size={16} />
  if (/ask_user|request_user/u.test(normalized)) return <CircleHelp size={16} />
  if (/web|fetch/u.test(normalized)) return <Globe size={16} />
  if (/subagent/u.test(normalized)) return <Bot size={16} />
  return <Sparkles size={16} />
}

/** The parent directory as ZCode shows it: normalized separators and a trailing slash. */
function directoryOf(path: string): string | undefined {
  const directory = path.split(/[/\\]/u).slice(0, -1).join('/')
  return directory === '' ? undefined : `${directory}/`
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

