import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert, BorderBeam, Button, Card, ConfigProvider, Empty, Input, Listy, Segmented, Select, Skeleton, Tabs, Tag, theme as antdTheme,
} from 'antd'
import type { ThemeConfig } from 'antd'
import { IconRefreshOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type {
  ThinkingLevel, WetrackAnalysisRecord, WetrackAnalysisRun, WetrackAnalysisSettings, WetrackAnalysisStatus, WetrackAnalysisSummary,
  WetrackDefectDetail, WetrackDefectItem, WetrackDefectList, WetrackDefectReport, WorkspaceSummary,
} from '../shared/types.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { api } from './api.ts'
import { markdownLabels, type Translate } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import {
  compareDefectsNewest, defectDescriptionText, fieldText, filterDefects, groupDefectsByProject, projectLabelOf, severityTone, statusTone, workflowOf,
} from './wetrack-view.ts'
import css from './WetrackPage.module.css'

interface LoadState { loading: boolean; error: string; list?: WetrackDefectList }
interface DetailState { loading: boolean; error: string; value?: WetrackDefectDetail }
interface ReportState { loading: boolean; error: string; value?: WetrackDefectReport }
interface AnalysisState { loading: boolean; error: string; value?: WetrackAnalysisRecord | null }
type View = 'list' | 'detail' | 'settings'
type WorkflowFilter = 'development' | 'verification' | 'all'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function themeConfig(dark: boolean): ThemeConfig {
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? 'rgb(122, 170, 255)' : 'rgb(65, 118, 230)',
      colorBgContainer: dark ? 'rgb(35, 35, 36)' : '#ffffff',
      colorBgElevated: dark ? 'rgb(27, 27, 28)' : '#ffffff',
      colorBorderSecondary: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)',
      colorText: dark ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)',
      colorTextSecondary: dark ? 'rgb(173, 178, 184)' : 'rgb(97, 102, 107)',
      borderRadius: 10,
      fontFamily: 'inherit',
      fontSize: 13,
    },
  }
}

const ANALYSIS_STATUS_LABELS: Record<WetrackAnalysisStatus, { zh: string; en: string; color: string }> = {
  analyzing: { zh: '分析中', en: 'Analyzing', color: 'gold' },
  analyzed: { zh: '已分析', en: 'Analyzed', color: 'blue' },
  fixed: { zh: '已修复', en: 'Fixed', color: 'green' },
  blocked: { zh: '受阻', en: 'Blocked', color: 'red' },
}

/** Issue list, full-page detail and list-level analysis settings. */
export default function WetrackPage({ workspaces, onOpenConversation }: {
  workspaces: readonly WorkspaceSummary[]
  onOpenConversation: (id: string) => void
}) {
  const { t, settings, dark } = useUiPreferences()
  const [view, setView] = useState<View>('list')
  const [workflow, setWorkflow] = useState<WorkflowFilter>('development')
  const [state, setState] = useState<LoadState>({ loading: true, error: '' })
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [selected, setSelected] = useState<WetrackDefectItem>()
  const [tab, setTab] = useState('analysis')
  const [detail, setDetail] = useState<DetailState>({ loading: false, error: '' })
  const [report, setReport] = useState<ReportState>({ loading: false, error: '' })
  const [analysis, setAnalysis] = useState<AnalysisState>({ loading: false, error: '' })
  const [analyses, setAnalyses] = useState<ReadonlyMap<string, WetrackAnalysisSummary>>(() => new Map())
  const [runs, setRuns] = useState<ReadonlyMap<string, WetrackAnalysisRun>>(() => new Map())
  const [analysisSettings, setAnalysisSettings] = useState<WetrackAnalysisSettings>({ skillIds: [] })
  const [starting, setStarting] = useState(false)
  const [savingWorkspace, setSavingWorkspace] = useState(false)
  const [actionError, setActionError] = useState('')
  const latest = useRef<string>()

  const refreshAnalysis = useCallback(async (): Promise<void> => {
    const [index, runResult] = await Promise.all([api.wetrackAnalyses(), api.wetrackAnalysisRuns()])
    setAnalyses(new Map(index.analyses.map(summary => [summary.defectNumber, summary])))
    setRuns(new Map(runResult.runs.map(run => [run.defectNumber, run])))
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setState(current => ({ ...current, loading: true, error: '' }))
    const analysisRequest = refreshAnalysis().catch(() => undefined)
    try {
      const [list] = await Promise.all([api.wetrackDefects(), analysisRequest])
      setState({ loading: false, error: '', list })
    } catch (cause) {
      setState({ loading: false, error: messageOf(cause) || t('无法读取 WeTrack 问题清单', 'Could not load WeTrack issues') })
    }
  }, [refreshAnalysis, t])

  const loadSettings = useCallback(async (): Promise<void> => {
    try { setAnalysisSettings(await api.wetrackAnalysisSettings()) } catch (cause) { setActionError(messageOf(cause)) }
  }, [])

  useEffect(() => { void load(); void loadSettings() }, [load, loadSettings])

  useEffect(() => {
    if (![...runs.values()].some(run => run.status === 'running' || run.status === 'queued')) return
    const timer = setInterval(() => {
      void refreshAnalysis().then(async () => {
        const defectNumber = latest.current
        if (defectNumber === undefined) return
        const response = await api.wetrackAnalysis(defectNumber)
        if (latest.current === defectNumber) setAnalysis({ loading: false, error: '', value: response.analysis })
      }).catch(() => undefined)
    }, 2_000)
    return () => { clearInterval(timer) }
  }, [refreshAnalysis, runs])

  const open = useCallback((item: WetrackDefectItem): void => {
    const defectNumber = item.defectNumber
    latest.current = defectNumber
    setSelected(item)
    setView('detail')
    setTab('analysis')
    setActionError('')
    setDetail({ loading: true, error: '' })
    setReport({ loading: true, error: '' })
    setAnalysis({ loading: true, error: '' })
    void api.wetrackDefect(defectNumber).then(
      value => { if (latest.current === defectNumber) setDetail({ loading: false, error: '', value }) },
      (cause: unknown) => { if (latest.current === defectNumber) setDetail({ loading: false, error: messageOf(cause) }) },
    )
    void api.wetrackReport(defectNumber).then(
      value => { if (latest.current === defectNumber) setReport({ loading: false, error: '', value }) },
      (cause: unknown) => { if (latest.current === defectNumber) setReport({ loading: false, error: messageOf(cause) }) },
    )
    void api.wetrackAnalysis(defectNumber).then(
      ({ analysis: value }) => { if (latest.current === defectNumber) setAnalysis({ loading: false, error: '', value }) },
      (cause: unknown) => { if (latest.current === defectNumber) setAnalysis({ loading: false, error: messageOf(cause) }) },
    )
  }, [])

  const backToList = useCallback((): void => {
    latest.current = undefined
    setSelected(undefined)
    setView('list')
    void load()
  }, [load])

  const bindWorkspace = async (workspaceId: string): Promise<void> => {
    setSavingWorkspace(true)
    setActionError('')
    try { setAnalysisSettings(await api.updateWetrackAnalysisSettings({ workspaceId })) }
    catch (cause) { setActionError(messageOf(cause)) }
    finally { setSavingWorkspace(false) }
  }

  const bindThinkingLevel = async (thinkingLevel: ThinkingLevel): Promise<void> => {
    setSavingWorkspace(true)
    setActionError('')
    try { setAnalysisSettings(await api.updateWetrackAnalysisSettings({ workspaceId: analysisSettings.workspaceId, thinkingLevel })) }
    catch (cause) { setActionError(messageOf(cause)) }
    finally { setSavingWorkspace(false) }
  }

  const startAnalysis = async (): Promise<void> => {
    const defectNumber = latest.current
    if (defectNumber === undefined) return
    if (analysisSettings.workspaceId === undefined) {
      setView('settings')
      return
    }
    setStarting(true)
    setActionError('')
    try {
      const run = await api.startWetrackAnalysis({ defectNumber })
      setRuns(current => new Map(current).set(defectNumber, run))
      await refreshAnalysis()
    } catch (cause) { setActionError(messageOf(cause)) }
    finally { setStarting(false) }
  }

  const items = state.list?.items ?? []
  const sorted = useMemo(() => [...items].sort(compareDefectsNewest), [items])
  const workflowItems = useMemo(() => workflow === 'all' ? sorted : sorted.filter(item => workflowOf(item) === workflow), [sorted, workflow])
  const filtered = useMemo(() => filterDefects(workflowItems, query), [workflowItems, query])
  const groups = useMemo(() => groupDefectsByProject(filtered), [filtered])
  const activeKey = project === 'all' || groups.some(group => group.key === project) ? project : 'all'
  const active = activeKey === 'all' ? filtered : groups.find(group => group.key === activeKey)?.items ?? []
  const tabs = useMemo(() => [
    { key: 'all', label: <span className={css.tabLabel}>{t('全部项目', 'All projects')}<em>{filtered.length}</em></span> },
    ...groups.map(group => ({ key: group.key, label: <span className={css.tabLabel}>{group.label}<em>{group.items.length}</em></span> })),
  ], [filtered.length, groups, t])

  const shell = (body: ReactNode): ReactNode => <main className={css.page}>
    <ConfigProvider locale={settings.locale === 'en' ? enUS : zhCN} theme={themeConfig(dark)}>{body}</ConfigProvider>
  </main>

  if (view === 'settings') return shell(<>
    <PageHeader title={t('问题清单设置', 'Issue analysis settings')} subtitle={t('共享配置应用于列表中的所有缺陷分析，不为单个缺陷重复绑定。', 'Shared settings apply to all analyses in this list, not to one defect at a time.')} onBack={backToList} />
    <div className={css.panelWrap}>
      <Card title={t('代码工作区', 'Code workspace')} extra={<Tag color="blue">{t('列表共享', 'Shared')}</Tag>}>
        <p className={css.hint}>{t('选择一个已添加的代码目录。分析会话以只读方式检索此目录，并激活其中的本地 Skills。', 'Choose an existing code directory. Analysis reads this directory and activates its local Skills.')}</p>
        <Select className={css.workspaceSelect} value={analysisSettings.workspaceId} loading={savingWorkspace}
          placeholder={t('选择代码工作区', 'Choose a code workspace')} onChange={value => { void bindWorkspace(value) }}
          options={workspaces.map(workspace => ({ value: workspace.id, label: `${workspace.name} · ${workspace.path}` }))} />
        <div className={css.settingFacts}>
          <span>{t('分析模型', 'Analysis model')}</span><Tag color={analysisSettings.model === undefined ? 'red' : 'blue'}>{analysisSettings.model?.modelId ?? 'deepseek-v4.1-flash'}</Tag>
          <span>{t('思考等级', 'Thinking level')}</span>
          <Select size="small" value={analysisSettings.thinkingLevel} loading={savingWorkspace} disabled={analysisSettings.workspaceId === undefined}
            onChange={value => { void bindThinkingLevel(value) }}
            options={(analysisSettings.supportedThinkingLevels ?? []).map(level => ({
              value: level,
              label: level === 'off' ? t('关闭（最快）', 'Off (fastest)') : level,
            }))} />
          <span>{t('权限', 'Access')}</span><span>{t('只读代码，不修改、提交或推送', 'Read-only; no code edits, commits or pushes')}</span>
        </div>
        <p className={css.hint}>{t('思考等级越高，推理越充分、耗时越长；关闭思考最快，但复杂因果链的结论可能变浅。', 'A higher thinking level reasons more deeply and costs more time; off is fastest but may weaken conclusions on complex causal chains.')}</p>
      </Card>
      <Card className={css.settingsCard} title={t('激活的工作区 Skills', 'Active workspace Skills')}>
        {analysisSettings.workspaceId === undefined
          ? <Empty description={t('绑定共享工作区后自动发现并激活本地 Skills', 'Bind a shared workspace to discover and activate its local Skills')} />
          : analysisSettings.skillIds.length === 0
            ? <Empty description={t('此工作区没有发现匹配的 WeTrack Skill', 'No matching WeTrack Skill was found in this workspace')} />
            : <div className={css.skillTags}>{analysisSettings.skillIds.map(id => <Tag color="blue" key={id}>{id}</Tag>)}</div>}
      </Card>
      {actionError !== '' && <Alert className={css.notice} type="error" showIcon message={actionError} />}
    </div>
  </>)

  if (view === 'detail' && selected !== undefined) {
    const run = runs.get(selected.defectNumber)
    return shell(<>
      <PageHeader title={selected.defectNumber} subtitle={selected.simpleDesc ?? t('缺陷详情与问题分析', 'Defect detail and analysis')} onBack={backToList}
        actions={<Button type="primary" loading={starting} disabled={run?.status === 'running' || run?.status === 'queued'} onClick={() => { void startAnalysis() }}>
          {run === undefined ? t('开始 AI 分析', 'Start AI analysis') : run.status === 'running' || run.status === 'queued' ? t('分析中', 'Analyzing') : t('重新分析', 'Analyze again')}
        </Button>} />
      <div className={css.detailWrap}>
        <Card>
          <Tabs activeKey={tab} onChange={setTab} items={[
            { key: 'analysis', label: t('问题分析', 'Analysis'), children: <AnalysisPanel state={analysis} run={run}
              workspace={workspaces.find(item => item.id === analysisSettings.workspaceId)}
              model={analysisSettings.model?.modelId} error={actionError} onOpenConversation={onOpenConversation} /> },
            { key: 'detail', label: t('缺陷详情', 'Defect detail'), children: <DetailPane state={detail} t={t} /> },
            { key: 'report', label: t('本地结论', 'Local conclusion'), children: <ReportPane state={report} t={t} /> },
          ]} />
        </Card>
      </div>
    </>)
  }

  const list = state.list
  return shell(<>
    <header className={css.pageHead}>
      <div><h1>{t('WeTrack 问题清单', 'WeTrack issues')}</h1><p>{t('默认分析待开发解决问题；待自验单独查看，最新问题优先。', 'Analyze pending development issues by default. Verification issues are separate; newest first.')}</p></div>
      <div className={css.headerActions}>
        <Button icon={<IconSettingsOutlineRegular size={15} />} onClick={() => { setView('settings'); void loadSettings() }}>{t('设置', 'Settings')}</Button>
        <Button icon={<IconRefreshOutlineRegular size={14} />} loading={state.loading} onClick={() => { void load() }}>{t('刷新', 'Refresh')}</Button>
      </div>
    </header>
    <div className={css.panelWrap}>
      <BorderBeam color={dark ? 'rgb(122, 170, 255)' : 'rgb(65, 118, 230)'} duration={9} size={120}>
        <section className={css.panel} aria-label={t('WeTrack 问题清单', 'WeTrack issues')}>
          <div className={css.panelHead}>
            <Segmented value={workflow} onChange={value => { setWorkflow(value as WorkflowFilter); setProject('all') }} options={[
              { value: 'development', label: t('待开发解决', 'Development') },
              { value: 'verification', label: t('待自验', 'Verification') },
              { value: 'all', label: t('全部', 'All') },
            ]} />
            <Input className={css.search} allowClear size="small" prefix={<IconSearchOutlineRegular size={14} />}
              value={query} onChange={event => { setQuery(event.currentTarget.value) }}
              placeholder={t('搜索编号、描述、项目', 'Search number, summary, project')} aria-label={t('搜索问题清单', 'Search issues')} />
            <span className={css.meta}>{list !== undefined && <span>{t('更新于', 'Updated')} {list.generatedAt}</span>}</span>
          </div>
          {state.error !== '' && <Alert className={css.notice} type="error" showIcon message={state.error} action={<Button size="small" onClick={() => { void load() }}>{t('重试', 'Retry')}</Button>} />}
          {list !== undefined && !list.configured && <Alert className={css.notice} type="info" showIcon message={t('未连接 WeTrack', 'WeTrack is not configured')} description={<span className={css.hint}>{list.notice}</span>} />}
          {state.loading && list === undefined ? <Skeleton active className={css.empty} paragraph={{ rows: 6 }} /> : <>
            <Tabs items={tabs} activeKey={activeKey} onChange={setProject} />
            {active.length === 0 ? <Empty className={css.empty} description={workflow === 'development' ? t('暂无待开发解决问题', 'No development issues') : t('没有匹配的问题', 'No matching issues')} />
              : <Listy items={active} rowKey="defectNumber" virtual={false}
                itemRender={item => <DefectCard item={item} analysis={analyses.get(item.defectNumber)} run={runs.get(item.defectNumber)} onOpen={open} />}
                styles={{ root: { maxHeight: 'min(66vh, 760px)', overflowY: 'auto' }, item: { padding: 0, borderBottom: 'none', background: 'transparent' } }}
                classNames={{ root: css.list }} />}
          </>}
        </section>
      </BorderBeam>
    </div>
  </>)
}

function PageHeader({ title, subtitle, onBack, actions }: { title: string; subtitle: string; onBack: () => void; actions?: ReactNode }) {
  const { t } = useUiPreferences()
  return <header className={css.pageHead}>
    <div className={css.detailHeadRow}>
      <Button onClick={onBack}>← {t('返回列表', 'Back to list')}</Button>
      <div><h1>{title}</h1><p>{subtitle}</p></div>
    </div>
    {actions}
  </header>
}

export function AnalysisPanel({ state, run, workspace, model, error, onOpenConversation }: {
  state: AnalysisState
  run?: WetrackAnalysisRun
  workspace?: WorkspaceSummary
  model?: string
  error: string
  onOpenConversation: (id: string) => void
}) {
  const { t } = useUiPreferences()
  const active = run?.status === 'running' || run?.status === 'queued'
  return <div className={css.report}>
    <div className={css.analysisFacts}>
      <span>{t('共享工作区', 'Shared workspace')}</span><strong>{workspace?.path ?? t('请在列表设置中选择', 'Choose in list settings')}</strong>
      <span>{t('模型', 'Model')}</span><span>{model ?? 'deepseek-v4.1-flash'}</span>
      {run?.conversationId !== undefined && <Button size="small" onClick={() => { onOpenConversation(run.conversationId as string) }}>{t('查看分析会话', 'Open analysis conversation')}</Button>}
    </div>
    {active && <Alert type="info" showIcon message={t('后台分析进行中', 'Analysis is running in the background')} description={t('可返回列表处理其他缺陷，完成后这里会自动更新。', 'Return to the list while it runs; this page updates when the result is saved.')} />}
    {(run?.status === 'failed' || run?.status === 'interrupted') && <Alert type="error" showIcon message={run.status === 'failed' ? t('分析失败', 'Analysis failed') : t('分析已中断', 'Analysis interrupted')} description={run.error} />}
    {error !== '' && <Alert type="error" showIcon message={error} />}
    {(!active || state.value !== undefined && state.value !== null) && <AnalysisBody state={state} t={t} />}
  </div>
}

function AnalysisBody({ state, t }: { state: AnalysisState; t: Translate }) {
  if (state.loading) return <Skeleton active className={css.empty} paragraph={{ rows: 8 }} />
  if (state.error !== '') return <Alert type="error" showIcon message={state.error} />
  const record = state.value
  if (record === undefined || record === null) return <Empty className={css.empty} description={t('尚未分析。点击顶部「开始 AI 分析」，在共享工作区中后台执行。', 'Not analyzed yet. Start AI analysis above to run in the shared workspace.')} />
  const label = ANALYSIS_STATUS_LABELS[record.status]
  const blockedAttempt = record.latestAttempt?.status === 'blocked' ? record.latestAttempt : undefined
  const pendingAttempt = record.status !== 'analyzing' && record.latestAttempt?.status === 'analyzing' ? record.latestAttempt : undefined
  const reason = blockedAttempt?.blockedReason === 'budget-exhausted' ? t('检索预算已用尽', 'Search budget exhausted')
    : blockedAttempt?.blockedReason === 'access' ? t('缺少访问权限', 'Access unavailable')
      : blockedAttempt?.blockedReason === 'missing-code' ? t('缺少代码', 'Code unavailable')
        : blockedAttempt?.blockedReason === 'contract' ? t('需要处理接口契约', 'Contract needs attention')
          : t('证据不足或其他原因', 'Insufficient evidence or another reason')
  return <>
    {blockedAttempt !== undefined && <Alert type="warning" showIcon
      message={record.status === 'blocked' ? t('本次分析受阻', 'Analysis blocked') : t('最近一次分析受阻，已保留此前结论', 'Latest analysis was blocked; the previous conclusion is preserved')}
      description={<><p>{reason}{blockedAttempt.summary === '' ? '' : `：${blockedAttempt.summary}`}</p>
        {record.status !== 'blocked' && <AnswerMarkdown text={blockedAttempt.markdown} labels={markdownLabels(t)} t={t} />}</>} />}
    {pendingAttempt !== undefined && <Alert type="info" showIcon
      message={t('最新分析仍待验证，已保留此前结论', 'Latest analysis needs verification; the previous conclusion is preserved')}
      description={<AnswerMarkdown text={pendingAttempt.markdown} labels={markdownLabels(t)} t={t} />} />}
    <div className={css.readingMeta}><Tag color={label.color}>{t(label.zh, label.en)}</Tag>{record.title !== '' && <span className={css.readingDocTitle}>{record.title}</span>}<span className={css.spacer} />{record.updatedAt !== '' && <span className={css.time}>{t('更新于', 'Updated')} {record.updatedAt}</span>}</div>
    {record.summary !== '' && <p className={css.readingSummary}>{record.summary}</p>}
    <div className={css.answer}><AnswerMarkdown text={record.markdown} labels={markdownLabels(t)} t={t} /></div>
  </>
}

function DefectCard({ item, analysis, run, onOpen }: { item: WetrackDefectItem; analysis?: WetrackAnalysisSummary; run?: WetrackAnalysisRun; onOpen: (item: WetrackDefectItem) => void }) {
  const { t } = useUiPreferences()
  const severity = fieldText(item.severityName)
  const status = fieldText(item.defectStatusName)
  const submitTime = fieldText(item.submitTime) || fieldText(item.updateTime)
  const creator = fieldText(item.creatorName)
  const summary = fieldText(item.simpleDesc)
  const label = analysis === undefined ? undefined : ANALYSIS_STATUS_LABELS[analysis.status]
  const active = run?.status === 'running' || run?.status === 'queued'
  return <article className={css.defect} role="button" tabIndex={0} aria-label={`${item.defectNumber} ${summary}`} onClick={() => onOpen(item)}
    onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); onOpen(item) }}>
    <div className={css.defectHead}>
      <span className={css.number}>{item.defectNumber}</span>{severity !== '' && <Tag color={severityTone(severity)}>{severity}</Tag>}{status !== '' && <Tag color={statusTone(status)}>{status}</Tag>}
      {active ? <Tag color="processing">{t('分析中', 'Analyzing')}</Tag> : label !== undefined && <Tag color={label.color}>{t(label.zh, label.en)}</Tag>}
      <span className={css.spacer} />{submitTime !== '' && <span className={css.time}>{submitTime}</span>}
    </div>
    <p className={css.desc}>{summary === '' ? '—' : summary}</p>
    <div className={css.foot}><span>{projectLabelOf(item)}</span>{creator !== '' && <span>{creator}</span>}</div>
  </article>
}

function DetailPane({ state, t }: { state: DetailState; t: Translate }) {
  if (state.loading) return <Skeleton active className={css.modalLoading} paragraph={{ rows: 8 }} />
  if (state.error !== '') return <Alert type="error" showIcon message={state.error} />
  const value = state.value
  if (value === undefined) return null
  if (!value.configured) return <Alert type="info" showIcon message={t('未连接 WeTrack', 'WeTrack is not configured')} description={<span className={css.hint}>{value.notice}</span>} />
  const defect = value.defect
  if (defect === undefined) return <Empty description={t('没有详情', 'No detail')} />
  const severity = fieldText(defect.severityName)
  const status = fieldText(defect.defectStatusName)
  const project = fieldText(defect.projectName)
  const description = defectDescriptionText(fieldText(defect.description))
  const steps = Array.isArray(defect.processHistories) ? defect.processHistories : []
  const files = Array.isArray(defect.attachmentFiles) ? defect.attachmentFiles : []
  const images = Array.isArray(defect.images) ? defect.images : []
  const allRows: Array<[string, string]> = [
    [t('缺陷类型', 'Type'), fieldText(defect.categoryName)], [t('测试类型', 'Test type'), fieldText(defect.testTypeName)],
    [t('复现概率', 'Frequency'), fieldText(defect.probabilityName)], [t('测试领域', 'Domain'), fieldText(defect.fieldName)],
    [t('功能模块', 'Module'), fieldText(defect.moduleName)], [t('项目编号', 'Project'), fieldText(defect.projectNumber)],
    [t('产品线', 'Product line'), fieldText(defect.projectLineName)], [t('问题版本', 'Version'), fieldText(defect.issueVerName)],
    [t('创建人', 'Creator'), fieldText(defect.creatorName)], [t('创建时间', 'Created'), fieldText(defect.createTime)],
    [t('提单时间', 'Submitted'), fieldText(defect.submitTime)], [t('修改内容', 'Fix'), fieldText(defect.modifyContent)],
    [t('原因分类', 'Cause'), fieldText(defect.twoLevelCauseName)], [t('根因描述', 'Root cause'), fieldText(defect.threeLevelCause)],
  ]
  const rows = allRows.filter(([, content]) => content !== '')
  return <div className={css.detail}>
    <div className={css.defectHead}><span className={css.number}>{defect.defectNumber}</span>{severity !== '' && <Tag color={severityTone(severity)}>{severity}</Tag>}{status !== '' && <Tag color={statusTone(status)}>{status}</Tag>}<span className={css.spacer} />{project !== '' && <span className={css.time}>{project}</span>}</div>
    <p className={css.detailSummary}>{fieldText(defect.simpleDesc) || '—'}</p>
    {rows.length > 0 && <dl className={css.fields}>{rows.map(([label, content]) => <div key={label}><dt>{label}</dt><dd>{content}</dd></div>)}</dl>}
    <section className={css.section}><h4>{t('详细描述', 'Description')}</h4><div className={css.description}>{description === '' ? '—' : description}</div></section>
    {steps.length > 0 && <section className={css.section}><h4>{t('处理记录', 'History')}</h4><ol className={css.steps}>{steps.map((step, index) => {
      const flow = [fieldText(step.startStatusName), fieldText(step.endStatusName)].filter(part => part !== '').join(' → ')
      const users = fieldText(step.userFromName) === '' || fieldText(step.userToName) === '' ? fieldText(step.userFromName) || fieldText(step.userToName) : `${fieldText(step.userFromName)} → ${fieldText(step.userToName)}`
      return <li key={`${fieldText(step.createTime)}-${index}`}><span className={css.stepTime}>{fieldText(step.createTime)}</span><span className={css.stepBody}><span>{flow || fieldText(step.endStepName) || '—'}</span>{fieldText(step.remark) !== '' && <em>{fieldText(step.remark)}</em>}{users !== '' && <span className={css.stepUsers}>{users}</span>}</span></li>
    })}</ol></section>}
    {(files.length > 0 || images.length > 0) && <section className={css.section}><h4>{t('附件与图片', 'Attachments')}</h4><ul className={css.files}>
      {files.map((file, index) => <li key={`file-${index}`}><code>{fieldText(file.fileName) || '—'}</code>{fieldText(file.path) !== '' && <span>{fieldText(file.path)}</span>}</li>)}
      {images.map((image, index) => <li key={`image-${index}`}><code>{image}</code><span>{t('内嵌图片', 'Inline image')}</span></li>)}
    </ul></section>}
  </div>
}

function ReportPane({ state, t }: { state: ReportState; t: Translate }) {
  if (state.loading) return <Skeleton active className={css.modalLoading} paragraph={{ rows: 10 }} />
  if (state.error !== '') return <Alert type="error" showIcon message={state.error} />
  const value = state.value
  if (value === undefined) return null
  if (!value.available) return <Alert type="info" showIcon message={t('暂无结论', 'No conclusion yet')} description={<span className={css.hint}>{t('把分析文档放到下面这个目录，文件名用缺陷编号：', 'Put the analysis file in this directory, named after the defect number:')}{'\n'}{value.directory}{'\n'}{value.file}</span>} />
  return <div className={css.report}><div className={css.reportMeta}>{value.file}{value.updatedAt === undefined ? '' : ` · ${t('更新于', 'Updated')} ${value.updatedAt}`}</div><AnswerMarkdown text={value.markdown ?? ''} labels={markdownLabels(t)} t={t} /></div>
}
