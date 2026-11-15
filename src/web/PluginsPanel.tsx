import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconPluginPinwheelOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginDescription, PluginOverview, PluginStoreItem } from '../shared/plugins.ts'
import { api } from './api.ts'
import {
  capabilityTags,
  displayName,
  failedOperation,
  filterPlugins,
  pluginInitial,
  pluginState,
  runningOperation,
  updateAvailable,
  type PluginFilter,
} from './plugin-store-model.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './PluginsPanel.module.css'

/** 插件筛选页签的值与中英文案。 */
const FILTERS: Array<{ id: PluginFilter; zh: string; en: string }> = [
  { id: 'all', zh: '全部', en: 'All' },
  { id: 'available', zh: '可安装', en: 'Available' },
  { id: 'installed', zh: '已安装', en: 'Installed' },
]

/** 提取错误的 message 文本；为空时回退到给定的兜底文案。 */
function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

/** 按界面语言把时间戳格式化为「月/日 时:分」；格式化失败回退 ISO 字符串。 */
function timestamp(value: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value)
  } catch {
    return new Date(value).toISOString()
  }
}

/**
 * 功能：插件市场面板——顶部为刷新/创建插件/添加市场操作与市场来源卡；
 * 中部为筛选页签、搜索框与插件卡片网格（安装/更新/启停/卸载）；底部为
 * 诊断列表与安装/更新确认弹窗（展示插件将运行的 MCP 命令与能力清单）。
 * @param props onCreatePlugin 打开「创建插件」流程的回调（缺省时按钮不渲染）。
 * 内部逻辑：overview 经 load 拉取并以请求序号丢弃过期响应；api.watchPlugins 订阅
 * 服务端推送的完整概览（有变更即全量推送，无需轮询）；存在运行中操作时每 800ms
 * 静默刷新；act 以 busy[key] 防重入；install/update 先 describePlugin 拉详情弹确认框
 * （安装等于信任其 MCP 命令以当前用户权限运行），确认后才真正执行。
 */
export default function PluginsPanel({ onCreatePlugin }: { onCreatePlugin?: () => void }) {
  const { settings } = useUiPreferences()
  const t = useCallback((zh: string, en: string) => settings.locale === 'en' ? en : zh, [settings.locale])
  const [overview, setOverview] = useState<PluginOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<PluginFilter>('all')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [sourceOpen, setSourceOpen] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm] = useState<{ description: PluginDescription; mode: 'install' | 'update' } | null>(null)
  const [describing, setDescribing] = useState<string | undefined>(undefined)
  const requestSequence = useRef(0)

  /** 拉取插件概览：quiet 为 true 时不进入加载态（用于后台轮询）；序号防过期响应。 */
  const load = useCallback(async (quiet = false) => {
    const request = ++requestSequence.current
    if (!quiet) setLoading(true)
    try {
      const next = await api.getPluginOverview()
      if (request === requestSequence.current) {
        setOverview(next)
        setError('')
      }
    } catch (cause) {
      if (request === requestSequence.current) setError(errorText(cause, t('无法读取插件目录', 'Could not load plugins')))
    } finally {
      if (request === requestSequence.current && !quiet) setLoading(false)
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  // 每次插件库变更服务端都会推送完整概览；面板无需为进度轮询。
  useEffect(() => {
    const source = api.watchPlugins((next) => {
      setOverview(next)
      setLoading(false)
      setError('')
    })
    return () => source.close()
  }, [])

  const running = overview?.operations.some(operation => operation.status === 'running') ?? false
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void load(true), 800)
    return () => clearInterval(timer)
  }, [running, load])

  /** 执行单个插件操作：busy[key] 防重入，成功应用返回的概览，失败写 error。 */
  const act = async (key: string, action: () => Promise<PluginOverview>) => {
    if (busy[key]) return
    setBusy(value => ({ ...value, [key]: true }))
    try {
      const next = await action()
      setOverview(next)
      setError('')
    } catch (cause) {
      setError(errorText(cause, t('操作失败', 'The operation failed')))
    } finally {
      setBusy(value => {
        const copy = { ...value }
        delete copy[key]
        return copy
      })
    }
  }

  /** 安装/更新前先读取插件详情弹确认框：安装会运行其 MCP 命令，先让用户看清再写盘。 */
  const requestAction = async (item: PluginStoreItem, mode: 'install' | 'update') => {
    if (describing !== undefined) return
    setDescribing(item.id)
    setError('')
    try {
      setConfirm({ description: await api.describePlugin(item.id), mode })
    } catch (cause) {
      setError(errorText(cause, t('无法读取插件信息', 'Could not inspect the plugin')))
    } finally {
      setDescribing(undefined)
    }
  }

  /** 确认弹窗点击后真正执行安装/更新，随后重新拉取概览。 */
  const confirmAction = async () => {
    const target = confirm
    if (target === null) return
    setConfirm(null)
    const { description, mode } = target
    await act(`${mode}:${description.id}`, async () => {
      if (mode === 'install') await api.installPlugin({ marketplace: description.marketplace, name: description.name })
      else await api.updatePlugin(description.id)
      return await api.getPluginOverview()
    })
  }

  /** 添加市场来源（本地目录或 HTTPS 地址）：成功清空输入并收起表单。 */
  const addSource = async () => {
    const value = source.trim()
    if (value === '' || busy['add-source']) return
    setBusy(current => ({ ...current, 'add-source': true }))
    try {
      const next = await api.addPluginMarketplace(value)
      setOverview(next)
      setSource('')
      setSourceOpen(false)
      setError('')
    } catch (cause) {
      setError(errorText(cause, t('无法添加市场', 'Could not add the marketplace')))
    } finally {
      setBusy(current => {
        const copy = { ...current }
        delete copy['add-source']
        return copy
      })
    }
  }

  const plugins = filterPlugins(overview?.plugins ?? [], filter, query)
  const marketplaces = overview?.marketplaces ?? []
  const diagnostics = overview?.diagnostics ?? []

  return <section className={css.panel}>
    <header className={css.header}>
      <div className={css.heading}>
        <h3>{t('插件市场', 'Plugin market')}</h3>
        <p>{t('从本地目录或 HTTPS 市场安装插件。安装插件等于信任它声明的能力以当前用户权限运行。', 'Install plugins from a local directory or an HTTPS marketplace. Installing a plugin trusts its declared capabilities with your user permissions.')}</p>
      </div>
      <div className={css.actions}>
        <Button size="sm" variant="outline" disabled={loading} icon={<IconRefreshOutlineRegular size={14} />} onClick={() => void load()}>{t('刷新', 'Refresh')}</Button>
        {onCreatePlugin !== undefined && <Button size="sm" variant="primary" data-create-plugin
          icon={<IconPluginPinwheelOutlineRegular size={14} />} onClick={onCreatePlugin}>{t('创建插件', 'Create plugin')}</Button>}
        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={14} />} onClick={() => setSourceOpen(value => !value)}>{t('添加市场', 'Add marketplace')}</Button>
      </div>
    </header>

    {(sourceOpen || marketplaces.length === 0) && <div className={css.sourceForm}>
      <label htmlFor="plugin-marketplace-source">{t('市场来源', 'Marketplace source')}</label>
      <div className={css.sourceRow}>
        <input id="plugin-marketplace-source" value={source} spellCheck={false}
          placeholder={t('/绝对路径/到市场目录 或 https://example.com/marketplace.json', '/absolute/marketplace/directory or https://example.com/marketplace.json')}
          onChange={event => setSource(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') void addSource() }} />
        <Button size="sm" disabled={source.trim() === '' || busy['add-source'] === true} onClick={() => void addSource()}>{busy['add-source'] ? t('添加中…', 'Adding…') : t('添加', 'Add')}</Button>
      </div>
      <p className={css.hint}>{t('本地目录必须包含 marketplace.json；远程来源必须使用 HTTPS（本机回环可用 HTTP）。', 'A local directory must contain marketplace.json. Remote sources must use HTTPS (loopback HTTP is allowed).')}</p>
    </div>}

    {marketplaces.length > 0 && <div className={css.sources}>
      {marketplaces.map(marketplace => <div className={css.source} key={marketplace.id}>
        <div className={css.sourceInfo}>
          <strong>{marketplace.name}</strong>
          <code>{marketplace.source}</code>
          <span>{t(`${marketplace.pluginCount} 个插件`, `${marketplace.pluginCount} plugins`)}{marketplace.lastUpdated > 0 ? ` · ${timestamp(marketplace.lastUpdated, settings.locale)}` : ''}</span>
          {marketplace.lastError && <span className={css.sourceError} role="alert">{marketplace.lastError}</span>}
        </div>
        <div className={css.sourceActions}>
          <Button size="sm" variant="ghost" aria-label={t('刷新市场', 'Refresh marketplace')} disabled={busy[`refresh:${marketplace.id}`] === true}
            icon={<IconRefreshOutlineRegular size={14} />}
            onClick={() => void act(`refresh:${marketplace.id}`, () => api.refreshPluginMarketplace(marketplace.id))} />
          <Button size="sm" variant="ghost" aria-label={t('移除市场', 'Remove marketplace')} disabled={busy[`remove:${marketplace.id}`] === true}
            icon={<IconTrashOutlineRegular size={14} />}
            onClick={() => void act(`remove:${marketplace.id}`, () => api.removePluginMarketplace(marketplace.id))} />
        </div>
      </div>)}
    </div>}

    <div className={css.toolbar}>
      <div className={css.filters} role="tablist" aria-label={t('插件筛选', 'Plugin filter')}>
        {FILTERS.map(item => <button key={item.id} type="button" role="tab" aria-selected={filter === item.id}
          className={css.filter} onClick={() => setFilter(item.id)}>{t(item.zh, item.en)}</button>)}
      </div>
      <input className={css.search} type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}
        placeholder={t('搜索插件', 'Search plugins')} aria-label={t('搜索插件', 'Search plugins')} />
    </div>

    {error && <p className={css.error} role="alert">{error}</p>}
    {loading && <p className={css.muted} role="status">{t('正在读取插件目录…', 'Loading plugins…')}</p>}
    {!loading && plugins.length === 0 && <p className={css.empty}>
      {marketplaces.length === 0
        ? t('还没有市场来源。添加一个包含 marketplace.json 的目录或 HTTPS 地址。', 'No marketplace yet. Add a directory containing marketplace.json or an HTTPS URL.')
        : t('没有符合条件的插件。', 'No plugins match this filter.')}
    </p>}

    <div className={css.cards}>
      {plugins.map(plugin => {
        const operation = runningOperation(plugin, overview?.operations ?? [])
        const failure = failedOperation(plugin, overview?.operations ?? [])
        const state = pluginState(plugin)
        return <article className={css.card} key={plugin.id} data-enabled={plugin.installed ? plugin.enabled : undefined}>
          <div className={css.cardHead}>
            <span className={css.pluginIcon} aria-hidden="true">{plugin.icon
              ? <img src={plugin.icon} alt="" loading="lazy" referrerPolicy="no-referrer" />
              : pluginInitial(plugin)}</span>
            <div className={css.cardTitle}>
              <h4>{displayName(plugin)}{plugin.featured && <span className={css.featured}>{t('推荐', 'Featured')}</span>}</h4>
              <p><code>{plugin.name}@{plugin.marketplace}</code> · v{plugin.version}</p>
            </div>
          </div>
          {plugin.description && <p className={css.description}>{plugin.description}</p>}
          {capabilityTags(plugin).length > 0 && <div className={css.tags}>{capabilityTags(plugin).map(tag => <span key={tag}>{tag}</span>)}</div>}
          <div className={css.cardFooter}>
            <span className={css.state} data-state={state}>
              {state === 'installed'
                ? [
                  t(`已安装 v${plugin.installedVersion ?? plugin.version}`, `Installed v${plugin.installedVersion ?? plugin.version}`),
                  plugin.enabled ? '' : t('已停用', 'Disabled'),
                  plugin.available ? '' : t('市场来源已移除', 'Marketplace removed'),
                  updateAvailable(plugin) ? t(`可更新到 v${plugin.version}`, `v${plugin.version} available`) : '',
                ].filter(label => label !== '').join(' · ')
                : state === 'unsupported'
                  ? t('来源暂不支持', 'Source not supported yet')
                  : state === 'unavailable'
                    ? t('市场来源已移除', 'Marketplace removed')
                    : t('可安装', 'Available')}
            </span>
            <div className={css.cardActions}>
              {plugin.installed ? <>
                {updateAvailable(plugin) && <Button size="sm" variant="outline"
                  disabled={operation !== undefined || describing === plugin.id || busy[`update:${plugin.id}`] === true}
                  onClick={() => void requestAction(plugin, 'update')}>
                  {t(`更新到 v${plugin.version}`, `Update to v${plugin.version}`)}
                </Button>}
                <Button size="sm" variant="outline" disabled={busy[`toggle:${plugin.id}`] === true}
                  onClick={() => void act(`toggle:${plugin.id}`, () => api.setPluginEnabled(plugin.id, !plugin.enabled))}>
                  {plugin.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy[`remove-plugin:${plugin.id}`] === true}
                  onClick={() => void act(`remove-plugin:${plugin.id}`, () => api.uninstallPlugin(plugin.id))}>
                  {t('卸载', 'Uninstall')}
                </Button>
              </> : state === 'available'
                ? <Button size="sm" disabled={operation !== undefined || describing === plugin.id || busy[`install:${plugin.id}`] === true}
                    onClick={() => void requestAction(plugin, 'install')}>
                    {operation !== undefined || busy[`install:${plugin.id}`] === true
                      ? t('安装中…', 'Installing…')
                      : describing === plugin.id ? t('读取中…', 'Inspecting…') : t('安装', 'Install')}
                  </Button>
                : <span className={css.unsupported}>{t('暂不可安装', 'Cannot install yet')}</span>}
            </div>
          </div>
          {failure?.error && <p className={css.error} role="alert">{failure.error}</p>}
        </article>
      })}
    </div>

    {diagnostics.length > 0 && <div className={css.diagnostics}>
      <h4>{t('诊断', 'Diagnostics')}</h4>
      <ul>{diagnostics.map(diagnostic => <li key={`${diagnostic.code}:${diagnostic.pluginId ?? diagnostic.marketplace ?? diagnostic.message}`}>
        <code>{diagnostic.code}</code><span>{diagnostic.message}</span>
      </li>)}</ul>
    </div>}

    {confirm !== null && <div className={css.overlay} role="presentation" onClick={event => { if (event.target === event.currentTarget) setConfirm(null) }}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="plugin-confirm-title">
        <h4 id="plugin-confirm-title">
          {confirm.mode === 'install' ? t('确认安装插件', 'Confirm plugin install') : t('确认更新插件', 'Confirm plugin update')}
        </h4>
        <p className={css.dialogMeta}>
          <code>{confirm.description.id}</code> · v{confirm.description.version} · {confirm.description.sourceType}
        </p>
        {confirm.description.mcpServers.length > 0 && <>
          <p className={css.dialogWarning}>
            {t('安装后，下列 MCP 命令会以当前用户权限运行。只安装你信任的插件。', 'After install, these MCP commands run with your user permissions. Only install plugins you trust.')}
          </p>
          <ul className={css.dialogList}>
            {confirm.description.mcpServers.map(server => <li key={server.name}>
              <code>{server.serverName}</code>
              <span>{server.command} {server.args.join(' ')}</span>
              <span className={css.dialogMuted}>
                {server.exposure}{server.envKeys.length > 0 ? ` · env: ${server.envKeys.join(', ')}` : ''}
              </span>
            </li>)}
          </ul>
        </>}
        {confirm.description.skills.length > 0 && <p className={css.dialogMuted}>
          {t('技能', 'Skills')}: {confirm.description.skills.join(', ')}
        </p>}
        {confirm.description.uiSurfaces.length > 0 && <p className={css.dialogMuted}>
          {t('界面', 'UI surfaces')}: {confirm.description.uiSurfaces.map(surface => surface.title).join(', ')}
        </p>}
        {confirm.description.unsupported.length > 0 && <p className={css.dialogMuted}>
          {t('这个插件还声明了 pi-web 暂不支持的能力', 'This plugin also declares capabilities pi-web does not run')}: {confirm.description.unsupported.join(', ')}
        </p>}
        <div className={css.dialogActions}>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t('取消', 'Cancel')}</Button>
          <Button size="sm" onClick={() => void confirmAction()}>
            {confirm.mode === 'install' ? t('确认安装', 'Install') : t('确认更新', 'Update')}
          </Button>
        </div>
      </div>
    </div>}

    <p className={css.footnote}><IconPluginPinwheelOutlineRegular size={13} aria-hidden="true" />
      {t('插件提供的技能会出现在技能目录中，来源标记为「插件」。插件声明的 MCP 工具在安装后即可使用，不需要重启；插件界面会出现在工具结果的内联卡和右侧面板中。', 'Plugin skills appear in the skill catalog with a Plugin source. Plugin MCP tools become available right after install without a restart; plugin UI appears inline on tool results and in the right-side panel.')}
    </p>
  </section>
}
