import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, BorderBeam, Button, ConfigProvider, Empty, Input, Listy, Modal, Skeleton, Tabs, Tag, theme as antdTheme,
} from 'antd'
import type { ThemeConfig } from 'antd'
import {
  IconRefreshOutlineRegular, IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type {
  WetrackDefectDetail, WetrackDefectItem, WetrackDefectList, WetrackDefectReport,
} from '../shared/types.ts'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { api } from './api.ts'
import type { Translate } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import {
  defectDescriptionText, fieldText, filterDefects, groupDefectsByProject, projectLabelOf, severityTone, statusTone,
} from './wetrack-view.ts'
import css from './WetrackPage.module.css'

interface LoadState {
  loading: boolean
  error: string
  list?: WetrackDefectList
}

interface DetailState {
  loading: boolean
  error: string
  value?: WetrackDefectDetail
}

interface ReportState {
  loading: boolean
  error: string
  value?: WetrackDefectReport
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Antd keeps its own token system, so the two palettes mirror the DSH values it must sit on. */
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

/** A standalone reading page for WeTrack defects: no composer, no model, no conversation. */
export default function WetrackPage() {
  const { t, settings, dark } = useUiPreferences()
  const [state, setState] = useState<LoadState>({ loading: true, error: '' })
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [selected, setSelected] = useState<string>()
  const [tab, setTab] = useState('detail')
  const [detail, setDetail] = useState<DetailState>({ loading: false, error: '' })
  const [report, setReport] = useState<ReportState>({ loading: false, error: '' })
  // A slow response for an older row must not overwrite the modal the user just switched to.
  const latest = useRef<string>()

  const load = useCallback(async (): Promise<void> => {
    setState(current => ({ ...current, loading: true, error: '' }))
    try {
      setState({ loading: false, error: '', list: await api.wetrackDefects() })
    } catch (cause) {
      setState({
        loading: false,
        error: cause instanceof Error ? cause.message : t('无法读取 WeTrack 问题清单', 'Could not load WeTrack issues'),
      })
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  const open = useCallback((item: WetrackDefectItem): void => {
    const defectNumber = item.defectNumber
    latest.current = defectNumber
    setSelected(defectNumber)
    setTab('detail')
    setDetail({ loading: true, error: '' })
    setReport({ loading: true, error: '' })
    void api.wetrackDefect(defectNumber).then(
      value => { if (latest.current === defectNumber) setDetail({ loading: false, error: '', value }) },
      (cause: unknown) => { if (latest.current === defectNumber) setDetail({ loading: false, error: messageOf(cause) }) },
    )
    void api.wetrackReport(defectNumber).then(
      value => { if (latest.current === defectNumber) setReport({ loading: false, error: '', value }) },
      (cause: unknown) => { if (latest.current === defectNumber) setReport({ loading: false, error: messageOf(cause) }) },
    )
  }, [])

  const close = useCallback((): void => {
    latest.current = undefined
    setSelected(undefined)
  }, [])

  const items = state.list?.items ?? []
  const filtered = useMemo(() => filterDefects(items, query), [items, query])
  const groups = useMemo(() => groupDefectsByProject(filtered), [filtered])
  // A search can retire the active project tab; fall back to 「全部」 instead of an empty pane.
  const activeKey = project === 'all' || groups.some(group => group.key === project) ? project : 'all'
  const active = activeKey === 'all' ? filtered : groups.find(group => group.key === activeKey)?.items ?? []
  const tabs = useMemo(() => [
    { key: 'all', label: <span className={css.tabLabel}>{t('全部', 'All')}<em>{filtered.length}</em></span> },
    ...groups.map(group => ({
      key: group.key,
      label: <span className={css.tabLabel}>{group.label}<em>{group.items.length}</em></span>,
    })),
  ], [filtered.length, groups, t])
  const list = state.list

  return <main className={css.page}>
    <header className={css.pageHead}>
      <div>
        <h1>{t('WeTrack 问题清单', 'WeTrack issues')}</h1>
        <p>{t('按项目归类查看待办缺陷；点开可看详情与本地结论。本页只读，不经过模型。', 'Browse pending defects by project. Open one for its detail and local conclusion. Read-only; never calls the model.')}</p>
      </div>
      <Button icon={<IconRefreshOutlineRegular size={14} />} loading={state.loading} onClick={() => { void load() }}>
        {t('刷新', 'Refresh')}
      </Button>
    </header>
    <div className={css.panelWrap}>
      <ConfigProvider locale={settings.locale === 'en' ? enUS : zhCN} theme={themeConfig(dark)}>
        <BorderBeam color={dark ? 'rgb(122, 170, 255)' : 'rgb(65, 118, 230)'} duration={9} size={120}>
          <section className={css.panel} aria-label={t('WeTrack 问题清单', 'WeTrack issues')}>
            <div className={css.panelHead}>
              <Input className={css.search} allowClear size="small" prefix={<IconSearchOutlineRegular size={14} />}
                value={query} onChange={event => { setQuery(event.currentTarget.value) }}
                placeholder={t('搜索编号、描述、项目', 'Search number, summary, project')}
                aria-label={t('搜索问题清单', 'Search issues')} />
              <span className={css.meta}>
                {list !== undefined && <span>{t(`${list.count} 条`, `${list.count} issues`)}</span>}
                {list !== undefined && <span>{t('更新于', 'Updated')} {list.generatedAt}</span>}
                {list !== undefined && <Tag color={list.source === 'fixture' ? 'gold' : 'blue'}>
                  {list.source === 'fixture' ? t('演示数据', 'Demo data') : 'WeTrack'}
                </Tag>}
              </span>
            </div>
            {state.error !== '' && <Alert className={css.notice} type="error" showIcon message={state.error}
              action={<Button size="small" onClick={() => { void load() }}>{t('重试', 'Retry')}</Button>} />}
            {list !== undefined && !list.configured && <Alert className={css.notice} type="info" showIcon
              message={t('未连接 WeTrack', 'WeTrack is not configured')}
              description={<span className={css.hint}>{list.notice}</span>} />}
            {state.loading && list === undefined
              ? <Skeleton active className={css.empty} paragraph={{ rows: 6 }} />
              : <>
                <Tabs items={tabs} activeKey={activeKey} onChange={setProject} />
                {active.length === 0
                  ? <Empty className={css.empty} description={items.length === 0
                    ? t('暂无待办问题', 'No pending issues')
                    : t('没有匹配的问题', 'No matching issues')} />
                  : <Listy items={active} rowKey="defectNumber" virtual={false}
                    itemRender={item => <DefectCard item={item} onOpen={open} />}
                    styles={{
                      root: { maxHeight: 'min(62vh, 680px)', overflowY: 'auto' },
                      // Cards own their border and spacing; Listy's row divider and hover fill would double them.
                      item: { padding: 0, borderBottom: 'none', background: 'transparent' },
                    }}
                    classNames={{ root: css.list }} />}
              </>}
          </section>
        </BorderBeam>
        <Modal open={selected !== undefined} onCancel={close} footer={null} width={880}
          title={<span className={css.modalTitle}>{selected ?? ''}<span className={css.modalTitleHint}>
            {t('缺陷详情', 'Defect detail')}
          </span></span>}
          styles={{ body: { maxHeight: 'min(66vh, 640px)', overflowY: 'auto', paddingTop: 4 } }}>
          <Tabs activeKey={tab} onChange={setTab} items={[
            { key: 'detail', label: t('详情', 'Detail'), children: <DetailPane state={detail} t={t} /> },
            { key: 'report', label: t('结论', 'Conclusion'), children: <ReportPane state={report} t={t} /> },
          ]} />
        </Modal>
      </ConfigProvider>
    </div>
  </main>
}

function DefectCard({ item, onOpen }: { item: WetrackDefectItem; onOpen: (item: WetrackDefectItem) => void }) {
  const severity = typeof item.severityName === 'string' ? item.severityName.trim() : ''
  const status = typeof item.defectStatusName === 'string' ? item.defectStatusName.trim() : ''
  const submitTime = typeof item.submitTime === 'string' ? item.submitTime.trim() : ''
  const creator = typeof item.creatorName === 'string' ? item.creatorName.trim() : ''
  const summary = typeof item.simpleDesc === 'string' ? item.simpleDesc.trim() : ''
  return <article className={css.defect} role="button" tabIndex={0}
    onClick={() => onOpen(item)}
    onKeyDown={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      onOpen(item)
    }}>
    <div className={css.defectHead}>
      <span className={css.number}>{item.defectNumber}</span>
      {severity !== '' && <Tag color={severityTone(severity)}>{severity}</Tag>}
      {status !== '' && <Tag color={statusTone(status)}>{status}</Tag>}
      <span className={css.spacer} />
      {submitTime !== '' && <span className={css.time}>{submitTime}</span>}
    </div>
    <p className={css.desc}>{summary === '' ? '—' : summary}</p>
    <div className={css.foot}>
      <span>{projectLabelOf(item)}</span>
      {creator !== '' && <span>{creator}</span>}
    </div>
  </article>
}

function DetailPane({ state, t }: { state: DetailState; t: Translate }) {
  if (state.loading) return <Skeleton active className={css.modalLoading} paragraph={{ rows: 8 }} />
  if (state.error !== '') return <Alert type="error" showIcon message={state.error} />
  const value = state.value
  if (value === undefined) return null
  if (!value.configured) {
    return <Alert type="info" showIcon message={t('未连接 WeTrack', 'WeTrack is not configured')}
      description={<span className={css.hint}>{value.notice}</span>} />
  }
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
    [t('缺陷类型', 'Type'), fieldText(defect.categoryName)],
    [t('测试类型', 'Test type'), fieldText(defect.testTypeName)],
    [t('复现概率', 'Frequency'), fieldText(defect.probabilityName)],
    [t('测试领域', 'Domain'), fieldText(defect.fieldName)],
    [t('功能模块', 'Module'), fieldText(defect.moduleName)],
    [t('项目编号', 'Project'), fieldText(defect.projectNumber)],
    [t('产品线', 'Product line'), fieldText(defect.projectLineName)],
    [t('问题版本', 'Version'), fieldText(defect.issueVerName)],
    [t('创建人', 'Creator'), fieldText(defect.creatorName)],
    [t('创建时间', 'Created'), fieldText(defect.createTime)],
    [t('提单时间', 'Submitted'), fieldText(defect.submitTime)],
    [t('修改内容', 'Fix'), fieldText(defect.modifyContent)],
    [t('原因分类', 'Cause'), fieldText(defect.twoLevelCauseName)],
    [t('根因描述', 'Root cause'), fieldText(defect.threeLevelCause)],
  ]
  const rows = allRows.filter(([, content]) => content !== '')
  return <div className={css.detail}>
    <div className={css.detailHead}>
      <span className={css.number}>{defect.defectNumber}</span>
      {severity !== '' && <Tag color={severityTone(severity)}>{severity}</Tag>}
      {status !== '' && <Tag color={statusTone(status)}>{status}</Tag>}
      <span className={css.spacer} />
      {project !== '' && <span className={css.time}>{project}</span>}
    </div>
    <p className={css.detailSummary}>{fieldText(defect.simpleDesc) || '—'}</p>
    {rows.length > 0 && <dl className={css.fields}>{rows.map(([label, content]) => <div key={label}>
      <dt>{label}</dt>
      <dd>{content}</dd>
    </div>)}</dl>}
    <section className={css.section}>
      <h4>{t('详细描述', 'Description')}</h4>
      <div className={css.description}>{description === '' ? '—' : description}</div>
    </section>
    {steps.length > 0 && <section className={css.section}>
      <h4>{t('处理记录', 'History')}</h4>
      <ol className={css.steps}>{steps.map((step, index) => {
        const flow = [fieldText(step.startStatusName), fieldText(step.endStatusName)].filter(part => part !== '').join(' → ')
        const users = fieldText(step.userFromName) === '' || fieldText(step.userToName) === ''
          ? fieldText(step.userFromName) || fieldText(step.userToName)
          : `${fieldText(step.userFromName)} → ${fieldText(step.userToName)}`
        return <li key={`${fieldText(step.createTime)}-${index}`}>
          <span className={css.stepTime}>{fieldText(step.createTime)}</span>
          <span className={css.stepBody}>
            <span>{flow || fieldText(step.endStepName) || '—'}</span>
            {fieldText(step.remark) !== '' && <em>{fieldText(step.remark)}</em>}
            {users !== '' && <span className={css.stepUsers}>{users}</span>}
          </span>
        </li>
      })}</ol>
    </section>}
    {(files.length > 0 || images.length > 0) && <section className={css.section}>
      <h4>{t('附件与图片', 'Attachments')}</h4>
      <ul className={css.files}>
        {files.map((file, index) => <li key={`file-${index}`}>
          <code>{fieldText(file.fileName) || '—'}</code>
          {fieldText(file.path) !== '' && <span>{fieldText(file.path)}</span>}
        </li>)}
        {images.map((image, index) => <li key={`image-${index}`}>
          <code>{image}</code>
          <span>{t('内嵌图片', 'Inline image')}</span>
        </li>)}
      </ul>
    </section>}
  </div>
}

function ReportPane({ state, t }: { state: ReportState; t: Translate }) {
  if (state.loading) return <Skeleton active className={css.modalLoading} paragraph={{ rows: 10 }} />
  if (state.error !== '') return <Alert type="error" showIcon message={state.error} />
  const value = state.value
  if (value === undefined) return null
  if (!value.available) {
    return <Alert type="info" showIcon message={t('暂无结论', 'No conclusion yet')} description={
      <span className={css.hint}>{t('把分析文档放到下面这个目录，文件名用缺陷编号：', 'Put the analysis file in this directory, named after the defect number:')}{'\n'}{value.directory}{'\n'}{value.file}</span>
    } />
  }
  return <div className={css.report}>
    <div className={css.reportMeta}>{value.file}{value.updatedAt === undefined ? '' : ` · ${t('更新于', 'Updated')} ${value.updatedAt}`}</div>
    <AnswerMarkdown text={value.markdown ?? ''} t={t} />
  </div>
}
