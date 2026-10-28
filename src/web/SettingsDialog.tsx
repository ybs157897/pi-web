import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button, IconAgentPresetOutlineRegular, IconApiOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular,
  IconSkillOutlineRegular, IconPluginPinwheelOutlineRegular,
  IconSettingsOutlineRegular, IconDatabaseOutlineRegular,
  IconDarkOutlineRegular, IconFollowsystemOutlineRegular, IconLightOutlineRegular,
  IconChevronLeftOutlineRegular, Menu, Modal, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccessMode, AppSettings, CodemodeMode, CollapseTiming, McpServerView, McpView, ModelCatalog, ProviderInput, PerformanceUsageMode, TranscriptViewMode, UpdateAppSettingsInput } from '../shared/types.ts'
import { api } from './api.ts'
import { DEFAULT_UI_SETTINGS, useUiPreferences } from './ui-preferences.tsx'
import { DEFAULT_SHORTCUTS, displayShortcut, shortcutFromEvent, resolveShortcuts, type ShortcutCommand } from './keyboard.ts'
import { ModelsPanel } from './ModelSettings.tsx'
import SkillsPanel from './SkillsPanel.tsx'
import PluginsPanel from './PluginsPanel.tsx'
import css from './SettingsDialog.module.css'

export type SettingsTab = 'general' | 'models' | 'presets' | 'mcp' | 'skills' | 'plugins'
export interface SettingsDialogProps {
  open: boolean; catalog: ModelCatalog | null; saving: boolean; onClose: () => void
  onSave: (input: ProviderInput) => Promise<void>
  settings?: AppSettings; onSettingsChange?: (patch: UpdateAppSettingsInput) => Promise<unknown>
  initialTab?: SettingsTab; presetsPanel?: ReactNode
  onRefreshCatalog?: () => Promise<void>; accessModes?: AccessMode[]
  /** Provider of the model in use right now, shown as DSH's 正在使用 badge. */
  activeProvider?: string
  /** Current project workspace, used to preselect the Skills catalog. */
  workspaceId?: string
  /** Start a new task with the plugin-creator Skill preloaded. */
  onCreatePlugin?: () => void
}
const API_OPTIONS = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' }, { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' }, { id: 'google-generative-ai', label: 'Google Generative AI' },
]

/** DSH's two-column settings shell; every control updates the project configuration. */
export default function SettingsDialog(props: SettingsDialogProps) {
  const { open, catalog, saving, onClose, onSave, initialTab = 'general', presetsPanel, onRefreshCatalog } = props
  const { t, settings: contextSettings } = useUiPreferences()
  const settings = props.settings ?? contextSettings ?? DEFAULT_UI_SETTINGS
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [moreFonts, setMoreFonts] = useState(false)
  const [openingConfig, setOpeningConfig] = useState(false)
  const [configToast, setConfigToast] = useState<{ id: number; text: string } | null>(null)
  const configToastSequence = useRef(0)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [recording, setRecording] = useState<string | null>(null)
  // The MCP tab owns its read-only snapshot: it is fetched when the tab opens, not with settings.
  const [mcp, setMcp] = useState<McpView | null>(null)
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState('')
  useEffect(() => { if (open) { setTab(initialTab); setError('') } }, [open, initialTab])
  const available = (catalog?.models ?? []).filter(model => model.available)
  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode; group: string; description: string }> = [
    {
      id: 'general', label: t('常规', 'General'), group: t('基础设置', 'Basics'),
      description: t('外观、字号、快捷键与工作步骤的展示方式。', 'Appearance, type size, shortcuts, and how work steps are shown.'),
      icon: <IconSettingsOutlineRegular size={16} />,
    },
    {
      id: 'models', label: t('模型设置', 'Models'), group: t('模型与能力', 'Models'),
      description: t('管理模型提供商、API 密钥与每个模型的参数。', 'Manage model providers, API keys, and each model’s parameters.'),
      icon: <IconDatabaseOutlineRegular size={16} />,
    },
    {
      id: 'presets', label: t('Agent 预设', 'Agent presets'), group: t('模型与能力', 'Models'),
      description: t('保存一组指令、工具与模型配置，新建会话时直接套用。', 'Save instructions, tools, and model settings to reuse in new conversations.'),
      icon: <IconAgentPresetOutlineRegular size={16} />,
    },
    {
      id: 'plugins', label: t('插件市场', 'Plugins'), group: t('扩展', 'Extensions'),
      description: t('从本地目录或 HTTPS 市场安装插件，查看已安装插件与其提供的能力。', 'Install plugins from a local directory or an HTTPS marketplace and inspect their capabilities.'),
      icon: <IconPluginPinwheelOutlineRegular size={16} aria-hidden="true" />,
    },
    {
      id: 'mcp', label: 'MCP', group: t('扩展', 'Extensions'),
      description: t('Pi 用户级 mcp.json 与已启用插件的 MCP 服务器；插件来源热重载，mcp.json 修改后重启。', 'Pi’s user-level mcp.json plus enabled plugin MCP servers; plugin changes reload live, mcp.json edits need a restart.'),
      icon: <IconApiOutlineRegular size={16} />,
    },
    {
      id: 'skills', label: t('技能', 'Skills'), group: t('扩展', 'Extensions'),
      description: t('查看、创建与校验可复用的技能。', 'Browse, create, and validate reusable skills.'),
      icon: <IconSkillOutlineRegular size={16} aria-hidden="true" />,
    },
  ]
  const currentTab = tabs.find(item => item.id === tab) ?? tabs[0]!
  const navGroups = [...new Set(tabs.map(item => item.group))]
  const update = async (patch: UpdateAppSettingsInput) => {
    if (!props.onSettingsChange || pending) return
    setPending(true); setError('')
    try { await props.onSettingsChange(patch) } catch (cause) { setError(cause instanceof Error ? cause.message : t('保存设置失败', 'Could not save settings')) }
    finally { setPending(false) }
  }
  /** DSH's own top-right action: hand the configuration file to the system's default program. */
  const openConfig = async () => {
    if (openingConfig) return
    setOpeningConfig(true)
    try { await api.openConfigFile() }
    catch (cause) {
      configToastSequence.current += 1
      setConfigToast({ id: configToastSequence.current, text: cause instanceof Error ? cause.message : t('无法打开配置文件', 'Could not open the configuration file') })
    }
    finally { setOpeningConfig(false) }
  }
  /** Read the imported Pi MCP catalog; the MCP tab is a read-only view and never rewrites it. */
  const loadMcp = async () => {
    if (mcpLoading) return
    setMcpLoading(true); setMcpError('')
    try { setMcp(await api.getMcp()) }
    catch (cause) { setMcpError(cause instanceof Error ? cause.message : t('无法读取 MCP 配置', 'Could not read the MCP configuration')) }
    finally { setMcpLoading(false) }
  }
  // Opening the tab is the only trigger: the dialog does not read the file until it is shown.
  useEffect(() => { if (open && tab === 'mcp') void loadMcp() }, [open, tab])
  const accessName = (value: AccessMode) => value === 'readOnly' ? t('仅可查看', 'Read only') : value === 'workspaceWrite' ? t('工作区内修改', 'Workspace write') : t('完全权限', 'Full access')
  const themes = [
    { value: 'light' as const, label: t('浅色', 'Light'), icon: <IconLightOutlineRegular size={16} /> },
    { value: 'dark' as const, label: t('深色', 'Dark'), icon: <IconDarkOutlineRegular size={16} /> },
    { value: 'system' as const, label: t('跟随系统', 'System'), icon: <IconFollowsystemOutlineRegular size={16} /> },
  ]
  const bindingNames: Record<string, string> = {
    newConversation: t('新建会话', 'New conversation'), search: t('搜索会话', 'Search conversations'), settings: t('打开设置', 'Open settings'),
    toggleSidebar: t('切换侧栏', 'Toggle sidebar'), rename: t('重命名会话', 'Rename conversation'),
    fork: t('分叉会话', 'Fork conversation'), archive: t('归档会话', 'Archive conversation'),
    send: t('发送消息', 'Send message'), newline: t('换行', 'New line'), alternateSend: t('使用另一发送方式', 'Alternate send mode'),
  }
  return <>
    <Modal open={open} onClose={onClose} title={t('设置', 'Settings')} headless className={css.modal} backdropBlur={false}>
      <aside className={css.navigation}>
        <button className={css.back} type="button" onClick={onClose}>
          <IconChevronLeftOutlineRegular size={14} aria-hidden="true" />
          <span>{t('返回工作区', 'Back to workspace')}</span>
        </button>
        <nav aria-label={t('设置分类', 'Settings categories')}>
          {navGroups.map(group => <div className={css.navGroup} key={group}>
            <p className={css.navGroupTitle}>{group}</p>
            {tabs.filter(item => item.group === group).map(item => <button key={item.id} type="button"
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => { setTab(item.id); setError('') }}>{item.icon}<span>{item.label}</span></button>)}
          </div>)}
        </nav>
      </aside>
      <section className={css.main}>
        <header className={css.pageHeader}>
          <div className={css.pageHeading}>
            <h2>{currentTab.label}</h2>
            <p>{currentTab.description}</p>
          </div>
          <div className={css.pageActions}>
            <Button variant="outline" size="sm" disabled={openingConfig} onClick={() => void openConfig()}>{t('打开配置文件', 'Open configuration file')}</Button>
            <button className={css.close} type="button" aria-label={t('关闭设置', 'Close settings')} onClick={onClose}><IconCloseOutlineRegular size={18} /></button>
          </div>
        </header>
        <div className={css.scroll}>
          {error && <p className={css.error} role="alert">{error}</p>}
          {tab === 'general' && <div className={css.general}>
            <SettingRow title={t('权限', 'Permissions')} description={t('选择新会话的默认权限模式', 'Choose the default access mode for new conversations')}>
              <Choice label={t('默认权限', 'Default access')} value={settings.defaultAccessMode} disabled={pending} options={(props.accessModes ?? ['readOnly', 'workspaceWrite', 'fullAccess'] as AccessMode[]).map(value => ({ value, label: accessName(value) }))} onChange={value => void update({ defaultAccessMode: value as AccessMode })} />
            </SettingRow>
            <SettingRow title={t('代码模式', 'Code mode')} description={t('关闭时不提供代码工具；开启时与原生工具并存；仅脚本时模型只能通过脚本调用工具', 'Off offers no code tool; On offers it beside the native tools; Script only reaches every other tool from a script')}>
              <Choice label={t('代码模式', 'Code mode')} value={settings.codemodeMode} disabled={pending} options={[
                { value: 'off', label: t('关闭', 'Off') },
                { value: 'on', label: t('开启', 'On') },
                { value: 'only', label: t('仅脚本', 'Script only') },
              ]} onChange={value => void update({ codemodeMode: value as CodemodeMode })} />
            </SettingRow>
            <SettingRow title={t('工作区记忆', 'Workspace memory')} description={t('开启后，系统会自动提取和注入长期记忆，可能产生额外的模型请求与 Token 用量。', 'Extract and inject long-term memory automatically; this adds model requests and token usage.')}>
              <Toggle label={t('工作区记忆', 'Workspace memory')} checked={settings.memoryEnabled} disabled={pending} onChange={memoryEnabled => void update({ memoryEnabled })} />
            </SettingRow>
            <SettingRow title={t('语言', 'Language')}><Choice label={t('语言', 'Language')} value={settings.locale} disabled={pending} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} onChange={value => void update({ locale: value as AppSettings['locale'] })} /></SettingRow>
            <SettingRow stacked title={t('外观', 'Appearance')}><div className={css.themeCards}>{themes.map(option => <button key={option.value} className={css.themeCard} type="button" aria-pressed={settings.theme === option.value} disabled={pending} onClick={() => void update({ theme: option.value })}>{option.icon}<span>{option.label}</span></button>)}</div></SettingRow>
            <SettingRow title={t('字号大小', 'Font size')} description={t('仅影响会话内容的字号', 'Applies to conversation content')}><div className={css.fontControls}><SizeSelect value={settings.fontSize} min={12} max={20} label={t('正文字号', 'Text size')} disabled={pending} onChange={fontSize => void update({ fontSize })} /><button className={css.moreButton} type="button" aria-label={t('更多字体设置', 'More font settings')} aria-expanded={moreFonts} onClick={() => setMoreFonts(value => !value)}><IconSettingsOutlineRegular size={14} /></button></div></SettingRow>
            {moreFonts && <div className={css.subSettings}><SettingRow title={t('代码字号', 'Code font size')}><SizeSelect value={settings.codeFontSize} min={10} max={16} label={t('代码字号', 'Code size')} disabled={pending} onChange={codeFontSize => void update({ codeFontSize })} /></SettingRow><SettingRow title={t('终端字号', 'Terminal font size')}><SizeSelect value={settings.terminalFontSize} min={10} max={20} label={t('终端字号', 'Terminal size')} disabled={pending} onChange={terminalFontSize => void update({ terminalFontSize })} /></SettingRow></div>}
            <SettingRow title={t('工作步骤展示', 'Work step display')} description={t('选择希望看到多少工具调用细节', 'Choose how much tool detail to show')}><Choice label={t('工作步骤展示', 'Work step display')} value={settings.transcriptView} disabled={pending} options={[
              { value: 'compact', label: t('简洁', 'Compact') }, { value: 'standard', label: t('标准', 'Standard') },
              { value: 'detailed', label: t('详细', 'Detailed') }, { value: 'verbose', label: t('完全展开', 'Expanded') },
            ]} onChange={value => void update({ transcriptView: value as TranscriptViewMode })} /></SettingRow>
            <SettingRow title={t('工作步骤收起时机', 'Collapse work steps')} description={t('选择何时自动收起工作步骤', 'Choose when work steps collapse')}><Choice label={t('工作步骤收起时机', 'Collapse work steps')} value={settings.collapseTiming} disabled={pending} options={[
              { value: 'completion', label: t('回答结束后', 'After the response') }, { value: 'next-input', label: t('下次有新消息时', 'On the next message') },
            ]} onChange={value => void update({ collapseTiming: value as CollapseTiming })} /></SettingRow>
            <SettingRow title={t('性能与用量', 'Performance and usage')} description={t('选择性能与用量信息展示的详细程度', 'Choose how much performance and usage detail to show')}><Choice label={t('性能与用量', 'Performance and usage')} value={settings.performanceUsage} disabled={pending} options={[
              { value: 'compact', label: t('简洁', 'Compact') }, { value: 'detailed', label: t('详细', 'Detailed') },
            ]} onChange={value => void update({ performanceUsage: value as PerformanceUsageMode })} /></SettingRow>
            <SettingRow title={t('显示代码工作视图', 'Show coding views')} description={t('显示文件预览与代码差异', 'Show files and code changes')}><Toggle label={t('显示代码工作视图', 'Show coding views')} checked={settings.codingViews} disabled={pending} onChange={codingViews => void update({ codingViews })} /></SettingRow>
            <SettingRow title={t('快捷键', 'Keyboard shortcuts')} description={t('查看和编辑可用的快捷键与输入操作', 'View and edit shortcuts and input actions')}><Button size="sm" variant="outline" onClick={() => { setRecording(null); setShortcutsOpen(true) }}>{t('编辑快捷键', 'Edit shortcuts')}</Button></SettingRow>
            <SettingRow title={t('繁忙时的发送行为', 'Send while running')} description={t('Enter 和发送按钮的行为；另一快捷键使用相反方式', 'Behavior of Enter and Send; the alternate shortcut uses the other mode')}><Choice label={t('繁忙时的发送行为', 'Send while running')} value={settings.busySendMode} disabled={pending} options={[{ value: 'followUp', label: t('排队发送', 'Queue message') }, { value: 'steer', label: t('立即插入', 'Steer now') }]} onChange={value => void update({ busySendMode: value as AppSettings['busySendMode'] })} /></SettingRow>
            <SettingRow title={t('默认模型', 'Default model')} description={t('用于新建会话，不改变正在运行的请求', 'Used for new conversations; active requests stay unchanged')}><select className={css.nativeSelect} aria-label={t('默认模型', 'Default model')} disabled={pending} value={settings.defaultModel ? JSON.stringify(settings.defaultModel) : '__inherit'} onChange={event => void update({ defaultModel: event.currentTarget.value === '__inherit' ? null : JSON.parse(event.currentTarget.value) })}><option value="__inherit">{t('使用 Pi 默认配置', 'Use Pi defaults')}</option>{available.map(model => <option key={`${model.provider}/${model.modelId}`} value={JSON.stringify({ provider: model.provider, modelId: model.modelId })}>{model.name} · {model.provider}</option>)}</select></SettingRow>
          </div>}
          {tab === 'models' && <ModelsPanel catalog={catalog} saving={saving} onSave={onSave} onRefresh={onRefreshCatalog} />}
          {tab === 'presets' && (presetsPanel ?? <p role="status">{t('正在加载预设…', 'Loading presets…')}</p>)}
          {tab === 'plugins' && <PluginsPanel onCreatePlugin={props.onCreatePlugin} />}
          {tab === 'mcp' && <div className={css.mcp}>
            <div className={css.mcpHead}>
              <h3>{t('MCP 服务器', 'MCP servers')}</h3>
              <Button size="sm" variant="outline" disabled={mcpLoading} onClick={() => void loadMcp()}>{mcpLoading ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}</Button>
            </div>
            <p className={css.description}>{t('来自 Pi 用户级 mcp.json 与已启用插件的 MCP 服务器；插件来源随安装/启停/更新/卸载热重载，mcp.json 修改后需重启。', 'Pi’s user-level mcp.json plus MCP servers from enabled plugins. Plugin changes reload live; mcp.json edits need a restart.')}</p>
            {mcpError !== '' && <p className={css.error} role="alert">{mcpError}</p>}
            {mcpLoading && mcp === null && <p className={css.description} role="status">{t('正在读取 MCP 配置…', 'Loading the MCP configuration…')}</p>}
            {mcp !== null && <>
              <div className={css.mcpConfig}>
                <span className={css.fieldLabel}>{t('配置文件', 'Configuration file')}</span>
                <code className={css.mcpPath}>{mcp.configPath}</code>
              </div>
              {!mcp.configExists && <p className={css.mcpNotice} role="status">{t('未找到 mcp.json，按 Pi 格式创建后重启服务', 'No mcp.json found. Create one in Pi’s format, then restart the service.')}</p>}
              {mcp.error !== undefined && <p className={css.error} role="alert">{mcp.error}</p>}
              {mcp.servers.length === 0
                ? <p className={css.mcpEmpty} role="status">{t('还没有可用的 MCP 服务器。', 'No MCP servers are available yet.')}</p>
                : <div className={css.mcpServers}>{mcp.servers.map(server => <McpServerCard key={server.name} server={server} t={t} />)}</div>}
            </>}
          </div>}
          {open && tab === 'skills' && <SkillsPanel initialWorkspaceId={props.workspaceId} />}
        </div>
      </section>
    </Modal>
    <Modal open={shortcutsOpen} onClose={() => { if (recording) setRecording(null); else setShortcutsOpen(false) }} title={t('快捷键', 'Keyboard shortcuts')} closeLabel={t('关闭', 'Close')} className={css.childModal}>
      <p className={css.description}>{t('点击右侧按键，然后按下新的组合键。Escape 取消录制。', 'Click a binding, then press a new key combination. Escape cancels recording.')}</p>
      {(Object.keys(DEFAULT_SHORTCUTS) as ShortcutCommand[]).map(id => <div className={css.shortcutRow} key={id}><span>{bindingNames[id]}</span><button type="button" className={css.binding} data-recording={recording === id || undefined} onClick={() => setRecording(id)} onKeyDown={event => {
        if (recording !== id) return
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Escape') { setRecording(null); return }
        const chord = shortcutFromEvent(event.nativeEvent)
        if (!chord) return
        const bindings = { ...resolveShortcuts(settings.shortcuts), [id]: chord }
        if (Object.values(bindings).filter(value => value === chord).length > 1) { setError(t('快捷键已被其他操作使用', 'This shortcut is already assigned')); return }
        setRecording(null); void update({ shortcuts: bindings })
      }}>{recording === id ? t('按下组合键…', 'Press a shortcut…') : displayShortcut(resolveShortcuts(settings.shortcuts)[id])}</button></div>)}
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => void update({ shortcuts: { ...DEFAULT_SHORTCUTS } })}>{t('恢复默认快捷键', 'Restore default shortcuts')}</Button>
    </Modal>
    {/* A failed open has to say what broke, so it holds longer than the default banner. */}
    {configToast !== null && <Toast key={configToast.id} text={configToast.text} holdMs={6000}
      onDone={() => { setConfigToast(current => current?.id === configToast.id ? null : current) }} />}
  </>
}

/** One settings row; `stacked` puts the control on its own full-width line, as DSH's appearance cards do. */
function SettingRow({ title, description, stacked = false, children }: { title: string; description?: string; stacked?: boolean; children: ReactNode }) {
  return <div className={css.settingRow} data-stacked={stacked || undefined}><div className={css.settingLabel}><span>{title}</span>{description && <p>{description}</p>}</div><div className={css.settingControl}>{children}</div></div>
}

function Choice({ label, value, options, disabled, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => setOpen(false)} portal align="end" selectedId={value} items={options.map(option => ({ id: option.value, label: option.label }))} onSelect={id => { onChange(id); setOpen(false) }} anchor={<button className={css.choice} type="button" aria-label={label} disabled={disabled} onClick={() => setOpen(value => !value)}>{options.find(option => option.value === value)?.label ?? value}<IconChevronDownOutlineRegular size={11} /></button>} />
}
function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={css.toggle}><span /></button>
}

/**
 * One MCP server row: DSH's connection dot with its wording, the transport and
 * exposure tags, and the native tool catalog behind a disclosure.
 */
function McpServerCard({ server, t }: { server: McpServerView; t: (chinese: string, english: string) => string }) {
  const dot = server.status === 'connected' ? 'done' : server.status === 'error' ? 'error' : 'idle'
  const toolCount = server.tools.length
  return <section className={css.mcpServer} data-status={server.status}>
    <div className={css.mcpServerHead}>
      <StateDot state={dot} size={10} />
      <span className={css.mcpServerName}>{server.name}</span>
      <span className={css.mcpServerStatus}>{mcpStatusName(server.status, t)}</span>
      <span className={css.mcpTag}>{server.transport}</span>
      <span className={css.mcpTag} title={t('工具暴露方式', 'Tool exposure')}>{server.exposure}</span>
      <span className={css.mcpTag} data-disabled={!server.enabled || undefined}>{server.enabled ? t('已启用', 'Enabled') : t('已禁用', 'Disabled')}</span>
    </div>
    {server.description !== undefined && server.description !== '' && <p className={css.mcpServerDescription}>{server.description}</p>}
    {server.error !== undefined && <p className={css.mcpServerError} role="alert">{server.error}</p>}
    <details className={css.mcpTools}>
      <summary>{t(`工具 ${toolCount} 个`, `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`)}</summary>
      {toolCount === 0
        ? <p className={css.mcpNoTools}>{t('这个服务器没有提供工具', 'This server exposes no tools')}</p>
        : <ul className={css.mcpToolList}>{server.tools.map(tool => <li key={tool.name} className={css.mcpTool}>
          <span className={css.mcpToolName} title={tool.description}>{tool.name}</span>
          {tool.title !== undefined && tool.title !== tool.name && <span className={css.mcpToolTitle}>{tool.title}</span>}
          <span className={css.mcpTag}>{tool.exposure}</span>
        </li>)}</ul>}
    </details>
  </section>
}

/** DSH's MCP connection states in words: the dot alone is not enough for a screen reader. */
function mcpStatusName(status: McpServerView['status'], t: (chinese: string, english: string) => string): string {
  switch (status) {
    case 'connected': return t('已连接', 'Connected')
    case 'error': return t('连接失败', 'Failed')
    case 'disabled': return t('已禁用', 'Disabled')
  }
}
/** DSH's font-size control: a filled value box, the unit, then the menu chevron. */
function SizeSelect({ value, min, max, label, disabled, onChange }: { value: number; min: number; max: number; label: string; disabled?: boolean; onChange: (value: number) => void }) {
  const [open, setOpen] = useState(false)
  const sizes = useMemo(() => Array.from({ length: max - min + 1 }, (_item, index) => min + index), [min, max])
  return <Menu open={open} onClose={() => setOpen(false)} portal align="end" selectedId={String(value)}
    items={sizes.map(size => ({ id: String(size), label: `${size} px` }))}
    onSelect={id => { onChange(Number(id)); setOpen(false) }}
    anchor={<button className={css.sizeSelect} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)}><span className={css.sizeValue}>{value}</span><span className={css.sizeUnit}>px</span><IconChevronDownOutlineRegular size={11} /></button>} />
}

