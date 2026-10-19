import { useMemo, useState } from 'react'
import { Button, IconCordisPluginOutlineRegular, IconRefreshOutlineRegular, Input, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginSummary } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './PluginsPage.module.css'

/** Chinese wording for the built-in Pi tools; every other tool keeps its original description. */
const TOOL_DESCRIPTIONS_ZH: Record<string, string> = {
  read: '读取文件内容。支持文本文件和图片（jpg、png、gif、webp），图片以附件形式返回。文本内容截断到 2000 行或 50KB（先到者为准），大文件可用 offset/limit 继续读取。',
  write: '写入文件内容：文件不存在时创建，已存在时覆盖，并自动创建父级目录。',
  edit: '用精确文本替换的方式编辑单个文件。每处 edits[].oldText 必须唯一匹配原文中一段互不重叠的内容；同一段或相邻行的改动请合并为一次 edit。',
  bash: '在当前工作目录执行 bash 命令，返回合并后的 stdout 和 stderr。输出截断到最近 2000 行或 50KB（先到者为准），可选传入超时时间（秒）。',
}

export interface PluginsPanelProps {
  plugins: readonly PluginSummary[]
  loading?: boolean
  error?: string
  onRefresh?: () => void
  onTogglePlugin: (pluginId: string, enabled: boolean) => void
  onToggleTool: (pluginId: string, toolName: string, enabled: boolean) => void
  embedded?: boolean
}

/** Render live Pi plugin and tool switches in the settings tab or full page. */
export function PluginsPanel({ plugins, loading = false, error = '', onRefresh, onTogglePlugin, onToggleTool, embedded = false }: PluginsPanelProps) {
  const { t } = useUiPreferences()
  const [query, setQuery] = useState('')
  const describeTool = (name: string, description: string | undefined): string => {
    const localized = TOOL_DESCRIPTIONS_ZH[name]
    return localized === undefined ? description ?? '' : t(localized, description ?? '')
  }
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle === '' ? [...plugins] : plugins.filter(plugin => `${plugin.name}\n${plugin.id}\n${plugin.description ?? ''}\n${plugin.tools.map(tool => `${tool.name} ${tool.description ?? ''}`).join('\n')}`.toLocaleLowerCase().includes(needle))
  }, [plugins, query])

  return <div className={`${css.panel} ${embedded ? css.embedded : ''}`}>
    {!embedded && <header className={css.pageHead}>
      <div><h1>{t('插件', 'Plugins')}</h1><p>{t('管理 Pi Agent 可调用的工具', 'Manage tools available to the Pi agent')}</p></div>
      <div className={css.toolbar}>
        <Input value={query} onChange={event => { setQuery(event.currentTarget.value) }} placeholder={t('搜索插件', 'Search plugins')} aria-label={t('搜索插件', 'Search plugins')} />
        {onRefresh !== undefined && <Button variant="ghost" size="sm" aria-label={t('刷新插件', 'Refresh plugins')}
          icon={<IconRefreshOutlineRegular size={15} />} onClick={onRefresh} />}
      </div>
    </header>}
    {embedded && <div className={css.embeddedHead}>
      <Input value={query} onChange={event => { setQuery(event.currentTarget.value) }} placeholder={t('搜索插件', 'Search plugins')} aria-label={t('搜索插件', 'Search plugins')} />
      {onRefresh !== undefined && <Button variant="ghost" size="sm" aria-label={t('刷新插件', 'Refresh plugins')}
        icon={<IconRefreshOutlineRegular size={15} />} onClick={onRefresh} />}
    </div>}
    {error !== '' && <div className={css.failure} role="alert"><span>{error}</span>
      {onRefresh !== undefined && <Button variant="outline" size="sm" onClick={onRefresh}>{t('重试', 'Retry')}</Button>}</div>}
    {loading && plugins.length === 0 && <div className={css.skeleton} aria-label={t('正在读取插件', 'Loading plugins')}><i /><i /><i /></div>}
    {!loading && error === '' && visible.length === 0 && <p className={css.empty}>{query.trim() === '' ? t('没有可配置的插件', 'No configurable plugins') : t('没有匹配的插件', 'No plugins match your search')}</p>}
    <ul className={css.list}>{visible.map(plugin => <li key={plugin.id} className={css.card}>
      <div className={css.cardHead}>
        <div className={css.pluginGlyph} aria-hidden><IconCordisPluginOutlineRegular size={22} /></div>
        <div className={css.pluginInfo}>
          <div className={css.titleRow}><strong>{plugin.name}</strong><span className={css.kind}>{plugin.builtin ? t('内置', 'Built in') : t('自定义', 'Custom')}</span></div>
          <code>{plugin.id}</code>
          {plugin.description && <p>{plugin.description}</p>}
        </div>
        <Switch checked={plugin.enabled} label={t(`启用插件 ${plugin.name}`, `Enable plugin ${plugin.name}`)}
          onChange={enabled => { onTogglePlugin(plugin.id, enabled) }} />
      </div>
      <div className={css.toolsHead}><span>{t('工具', 'Tools')} · {plugin.tools.length}</span>
        <span className={css.toolSummary}><StateDot state={plugin.enabled ? 'done' : 'idle'} size={8} />
          {plugin.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</span></div>
      {plugin.tools.length === 0
        ? <p className={css.noTools}>{t('这个插件没有单独的工具开关', 'This plugin has no individual tool switches')}</p>
        : <ul className={css.toolList}>{plugin.tools.map(tool => {
          const description = describeTool(tool.name, tool.description)
          return <li key={tool.name} className={css.tool}>
            <div className={css.toolInfo}><strong>{tool.name}</strong>{description !== '' && <small>{description}</small>}</div>
            <Switch checked={tool.enabled} disabled={!plugin.enabled} label={t(`启用工具 ${tool.name}`, `Enable tool ${tool.name}`)}
              onChange={enabled => { onToggleTool(plugin.id, tool.name, enabled) }} />
          </li>
        })}</ul>}
    </li>)}</ul>
  </div>
}

/** Main-navigation page for the plugin inventory. */
export default function PluginsPage(props: PluginsPanelProps) {
  return <main className={css.page}><PluginsPanel {...props} /></main>
}
