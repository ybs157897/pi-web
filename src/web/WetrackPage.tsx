import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, BorderBeam, Button, ConfigProvider, Empty, Input, Listy, Skeleton, Tabs, Tag, theme as antdTheme,
} from 'antd'
import type { ThemeConfig } from 'antd'
import {
  IconRefreshOutlineRegular, IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type { WetrackDefectItem, WetrackDefectList } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { filterDefects, groupDefectsByProject, projectLabelOf, severityTone, statusTone } from './wetrack-view.ts'
import css from './WetrackPage.module.css'

interface LoadState {
  loading: boolean
  error: string
  list?: WetrackDefectList
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
        <p>{t('按项目归类查看待办缺陷；本页只读，不经过模型。', 'Browse pending defects grouped by project. This page is read-only and never calls the model.')}</p>
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
                    itemRender={item => <DefectCard item={item} />}
                    styles={{
                      root: { maxHeight: 'min(62vh, 680px)', overflowY: 'auto' },
                      // Cards own their border and spacing; Listy's row divider and hover fill would double them.
                      item: { padding: 0, borderBottom: 'none', background: 'transparent' },
                    }}
                    classNames={{ root: css.list }} />}
              </>}
          </section>
        </BorderBeam>
      </ConfigProvider>
    </div>
  </main>
}

function DefectCard({ item }: { item: WetrackDefectItem }) {
  const severity = typeof item.severityName === 'string' ? item.severityName.trim() : ''
  const status = typeof item.defectStatusName === 'string' ? item.defectStatusName.trim() : ''
  const submitTime = typeof item.submitTime === 'string' ? item.submitTime.trim() : ''
  const creator = typeof item.creatorName === 'string' ? item.creatorName.trim() : ''
  const summary = typeof item.simpleDesc === 'string' ? item.simpleDesc.trim() : ''
  return <article className={css.defect}>
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
