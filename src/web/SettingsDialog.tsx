import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button, Checkbox, IconAgentPresetOutlineRegular, IconApiOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
  IconSkillOutlineRegular,
  IconPlusOutlineRegular, IconSettingsOutlineRegular, IconDatabaseOutlineRegular,
  IconDarkOutlineRegular, IconFollowsystemOutlineRegular, IconLightOutlineRegular, IconTrashOutlineRegular,
  Input, Menu, Modal, StateDot, Switch, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccessMode, AppSettings, CodemodeMode, CollapseTiming, McpServerView, McpView, ModelCatalog, ProviderConfigSummary, ProviderInput, ProviderModelInput, ProviderSummary, PerformanceUsageMode, TranscriptViewMode, UpdateAppSettingsInput } from '../shared/types.ts'
import { api } from './api.ts'
import { DEFAULT_UI_SETTINGS, useUiPreferences } from './ui-preferences.tsx'
import { DEFAULT_SHORTCUTS, displayShortcut, shortcutFromEvent, resolveShortcuts, type ShortcutCommand } from './keyboard.ts'
import SkillsPanel from './SkillsPanel.tsx'
import css from './SettingsDialog.module.css'

export type SettingsTab = 'general' | 'models' | 'presets' | 'mcp' | 'skills'
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
  const [newProvider, setNewProvider] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [providerChoice, setProviderChoice] = useState<ProviderSummary | undefined>()
  // The MCP tab owns its read-only snapshot: it is fetched when the tab opens, not with settings.
  const [mcp, setMcp] = useState<McpView | null>(null)
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState('')
  useEffect(() => { if (open) { setTab(initialTab); setError(''); setNewProvider(false) } }, [open, initialTab])
  const providers = catalog?.providers ?? []
  const configured = providers.filter(provider => provider.configured || provider.custom)
  const available = (catalog?.models ?? []).filter(model => model.available)
  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
    { id: 'general', label: t('通用设置', 'General'), icon: <IconSettingsOutlineRegular size={16} /> },
    { id: 'models', label: t('模型', 'Models'), icon: <IconDatabaseOutlineRegular size={16} /> },
    { id: 'presets', label: t('Agent 预设', 'Agent presets'), icon: <IconAgentPresetOutlineRegular size={16} /> },
    { id: 'mcp', label: 'MCP', icon: <IconApiOutlineRegular size={16} /> },
    { id: 'skills', label: t('技能', 'Skills'), icon: <IconSkillOutlineRegular size={16} aria-hidden="true" /> },
  ]
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
        <h2>{t('设置', 'Settings')}</h2>
        <nav aria-label={t('设置分类', 'Settings categories')}>{tabs.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => { setTab(item.id); setError('') }}>{item.icon}<span>{item.label}</span></button>)}</nav>
      </aside>
      <section className={css.main}>
        <div className={css.topbar}><Button variant="outline" size="sm" disabled={openingConfig} onClick={() => void openConfig()}>{t('打开配置文件', 'Open configuration file')}</Button><button className={css.close} type="button" aria-label={t('关闭设置', 'Close settings')} onClick={onClose}><IconCloseOutlineRegular size={18} /></button></div>
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
            <SettingRow title={t('显示代码工作视图', 'Show coding views')} description={t('显示轨迹、文件预览与代码差异', 'Show trajectory, files and code changes')}><Toggle label={t('显示代码工作视图', 'Show coding views')} checked={settings.codingViews} disabled={pending} onChange={codingViews => void update({ codingViews })} /></SettingRow>
            <SettingRow title={t('快捷键', 'Keyboard shortcuts')} description={t('查看和编辑可用的快捷键与输入操作', 'View and edit shortcuts and input actions')}><Button size="sm" variant="outline" onClick={() => { setRecording(null); setShortcutsOpen(true) }}>{t('编辑快捷键', 'Edit shortcuts')}</Button></SettingRow>
            <SettingRow title={t('繁忙时的发送行为', 'Send while running')} description={t('Enter 和发送按钮的行为；另一快捷键使用相反方式', 'Behavior of Enter and Send; the alternate shortcut uses the other mode')}><Choice label={t('繁忙时的发送行为', 'Send while running')} value={settings.busySendMode} disabled={pending} options={[{ value: 'followUp', label: t('排队发送', 'Queue message') }, { value: 'steer', label: t('立即插入', 'Steer now') }]} onChange={value => void update({ busySendMode: value as AppSettings['busySendMode'] })} /></SettingRow>
            <SettingRow title={t('默认模型', 'Default model')} description={t('用于新建会话，不改变正在运行的请求', 'Used for new conversations; active requests stay unchanged')}><select className={css.nativeSelect} aria-label={t('默认模型', 'Default model')} disabled={pending} value={settings.defaultModel ? JSON.stringify(settings.defaultModel) : '__inherit'} onChange={event => void update({ defaultModel: event.currentTarget.value === '__inherit' ? null : JSON.parse(event.currentTarget.value) })}><option value="__inherit">{t('使用 Pi 默认配置', 'Use Pi defaults')}</option>{available.map(model => <option key={`${model.provider}/${model.modelId}`} value={JSON.stringify({ provider: model.provider, modelId: model.modelId })}>{model.name} · {model.provider}</option>)}</select></SettingRow>
          </div>}
          {tab === 'models' && <div className={css.models}>
            <h3>{t('模型', 'Models')}</h3><p className={css.description}>{t('填入各提供商的 API 密钥即可使用其模型。', 'Configure provider credentials to use their models.')}</p>
            <SettingRow stacked title={t('模型白名单', 'Model allowlist')}>
              <AllowlistField value={settings.modelAllowlist} disabled={pending} t={t} onCommit={modelAllowlist => void update({ modelAllowlist })} />
            </SettingRow>
            {configured.map(provider => <ProviderCard key={provider.id} provider={provider} catalog={catalog} saving={saving} onSave={onSave} onRefresh={onRefreshCatalog} />)}
            {newProvider && <ProviderCard key={`new-${providerChoice?.id ?? 'custom'}`} provider={providerChoice} isNew catalog={catalog} saving={saving} onSave={async input => { await onSave(input); setNewProvider(false) }} onCancel={() => setNewProvider(false)} onRefresh={onRefreshCatalog} />}
            {!newProvider && <Menu open={addMenuOpen} onClose={() => setAddMenuOpen(false)} portal items={[{ id: '__custom', label: t('自定义模型提供商', 'Custom provider') }, ...providers.filter(provider => !configured.some(item => item.id === provider.id)).map(provider => ({ id: provider.id, label: provider.name }))]}
              onSelect={id => { setProviderChoice(providers.find(provider => provider.id === id)); setNewProvider(true); setAddMenuOpen(false) }} anchor={<button className={css.addProvider} type="button" onClick={() => setAddMenuOpen(true)}><IconPlusOutlineRegular size={16} />{t('添加模型提供商', 'Add model provider')}</button>} />}
          </div>}
          {tab === 'presets' && (presetsPanel ?? <p role="status">{t('正在加载预设…', 'Loading presets…')}</p>)}
          {tab === 'mcp' && <div className={css.mcp}>
            <div className={css.mcpHead}>
              <h3>{t('MCP 服务器', 'MCP servers')}</h3>
              <Button size="sm" variant="outline" disabled={mcpLoading} onClick={() => void loadMcp()}>{mcpLoading ? t('刷新中…', 'Refreshing…') : t('刷新', 'Refresh')}</Button>
            </div>
            <p className={css.description}>{t('来自 Pi 用户级 mcp.json 的只读清单；修改配置后重启服务生效。', 'A read-only view of Pi’s user-level mcp.json. Restart the service after editing it.')}</p>
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

/**
 * The allowlist line: one `provider/modelId` (or `provider/prefix*`) per line or
 * comma-separated entry. The draft commits on blur so typing never writes the
 * project configuration on every keystroke.
 */
function AllowlistField({ value, disabled, t, onCommit }: {
  value: string[]; disabled?: boolean; t: (chinese: string, english: string) => string; onCommit: (value: string[]) => void
}) {
  const text = value.join('\n')
  const [draft, setDraft] = useState(text)
  useEffect(() => { setDraft(text) }, [text])
  const commit = () => {
    const entries = [...new Set(draft.split(/[\n,]+/u).map(entry => entry.trim()).filter(entry => entry !== ''))]
    if (entries.length === value.length && entries.every((entry, index) => entry === value[index])) return
    onCommit(entries)
  }
  return <div className={css.allowlist}>
    <textarea className={css.allowlistInput} value={draft} disabled={disabled} rows={3}
      aria-label={t('模型白名单', 'Model allowlist')}
      placeholder={t('每行一个，例如 opencode-go/deepseek*', 'One per line, for example opencode-go/deepseek*')}
      onChange={event => setDraft(event.currentTarget.value)} onBlur={commit} />
    <p className={css.description}>{t('留空表示不过滤。只影响本项目的模型目录与选择，不改写 Pi 配置。',
      'Leave blank for no filtering. Only affects this project’s model directory and selection; your Pi configuration is not rewritten.')}</p>
  </div>
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

interface ReasoningEntry {
  level: string
  /** Wire value sent for this level; null is the Off entry, which sends nothing. */
  value: string | null
}

interface ModelDraft {
  key: string
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  input: Array<'text' | 'image'>
  /** Declared reasoning levels; undefined is how a model says it does not reason. */
  levels?: ReasoningEntry[]
  expanded: boolean
  /** Untouched fields of the stored model, carried back on save. */
  base?: ProviderModelInput
}

/** Levels a model offers when the switch turns on, in escalation order. */
const INITIAL_LEVELS = ['off', 'low', 'medium', 'high'] as const

function defaultLevelValue(level: string): string | null {
  return level === 'off' ? null : level
}


/** DSH accepts a plain count or a K/M suffix for the capacity fields. */
function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([KkMm])?$/u.exec(trimmed)
  if (match === null) return undefined
  const suffix = match[2]?.toLocaleUpperCase()
  const scale = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : 1
  const value = Math.round(Number(match[1]) * scale)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Compact capacity text, matching the shipped catalog's own spelling. */
function formatCapacity(value: number | undefined): string {
  if (value === undefined) return ''
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

function draftFromModel(model: ProviderModelInput): ModelDraft {
  return {
    key: `${model.id}:${crypto.randomUUID()}`,
    id: model.id,
    name: model.name === model.id ? '' : model.name,
    contextWindow: '',
    maxTokens: '',
    input: model.input !== undefined && model.input.length > 0 ? [...model.input] : ['text'],
    ...(model.thinkingLevelMap === undefined || model.thinkingLevelMap === null
      ? {}
      : {
        levels: Object.entries(model.thinkingLevelMap as Record<string, unknown>).map(([level, value]) => ({
          level,
          value: typeof value === 'string' ? value : null,
        })),
      }),
    expanded: false,
    base: model,
  }
}

/** DSH's provider row: title, custom tag, credential dot, then edit and delete. */
function ProviderCard({ provider, catalog, saving, onSave, onCancel, onRefresh, isNew = false }: {
  provider?: ProviderSummary; catalog: ModelCatalog | null; saving: boolean; isNew?: boolean
  onSave: (input: ProviderInput) => Promise<void>; onCancel?: () => void; onRefresh?: () => Promise<void>
}) {
  const { t } = useUiPreferences()
  const [open, setOpen] = useState(isNew)
  const [config, setConfig] = useState<ProviderConfigSummary | null>(null)
  const [id, setId] = useState(provider?.id ?? '')
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [protocol, setProtocol] = useState('openai-completions')
  const [rows, setRows] = useState<ModelDraft[]>([])
  const [key, setKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const reset = (value: ProviderConfigSummary) => {
    setConfig(value); setId(value.id); setName(value.name); setBaseUrl(value.baseUrl ?? ''); setProtocol(value.api)
    setRows(value.models.map(draftFromModel)); setKey(''); setRevealed(false)
  }
  useEffect(() => {
    if (!provider) return
    let active = true; setLoading(true)
    api.getProvider(provider.id).then(value => { if (active) reset(value) }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : t('无法读取配置', 'Could not load configuration')) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [provider?.id])
  const patchRow = (key: string, patch: Partial<ModelDraft>) => {
    setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row))
  }
  const addRows = (models: ProviderModelInput[]) => {
    setRows(current => {
      const known = new Set(current.map(row => row.id).filter(Boolean))
      return [...current, ...models.filter(model => model.id === '' || !known.has(model.id)).map(draftFromModel)]
    })
  }
  const discover = async () => {
    if (!provider) return
    setDiscovering(true); setError(''); setStatus('')
    try {
      const found = await api.discoverProvider(provider.id)
      if (found.length === 0) { setError(t('提供商没有返回任何模型', 'The provider returned no models')); return }
      addRows(found.map(model => ({ id: model.id, name: model.name })))
      setStatus(t(`已获取 ${found.length} 个模型`, `Found ${found.length} models`))
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('无法获取模型', 'Could not list models')) }
    finally { setDiscovering(false) }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setStatus('')
    const drafts = rows.filter(row => row.id.trim() !== '')
    const models: ProviderModelInput[] = []
    for (const row of drafts) {
      const contextWindow = parseCapacity(row.contextWindow)
      if (row.contextWindow.trim() !== '' && contextWindow === undefined) {
        setError(t('上下文窗口必须是正数，例如 131072、256K 或 1M。', 'Context window must be positive, e.g. 131072, 256K or 1M.')); return
      }
      const maxTokens = parseCapacity(row.maxTokens)
      if (row.maxTokens.trim() !== '' && maxTokens === undefined) {
        setError(t('最大输出 token 数必须是正数，例如 8192、64K 或 1M。', 'Max output tokens must be positive, e.g. 8192, 64K or 1M.')); return
      }
      const modelId = row.id.trim()
      const listed = catalog?.models.find(model => model.provider === id && model.modelId === modelId)
      models.push({
        ...(row.base ?? { reasoning: listed?.reasoning, contextWindow: listed?.contextWindow }),
        id: modelId,
        name: row.name.trim() || modelId,
        input: [...row.input],
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(row.levels === undefined
          ? {}
          : { thinkingLevelMap: Object.fromEntries(row.levels.map(entry => [entry.level, entry.value])) }),
      })
    }
    if (!id.trim() || !name.trim() || models.length === 0) { setError(t('请填写提供商名称和至少一个模型', 'Enter a provider name and at least one model')); return }
    try {
      await onSave({ id: id.trim(), name: name.trim(), baseUrl: baseUrl.trim(), api: protocol, models, ...(key ? { apiKey: key } : {}), ...(config?.headers ? { headers: config.headers } : {}), ...(config?.compat ? { compat: config.compat } : {}) })
      setKey(''); setStatus(t('已保存', 'Saved'))
      reset(await api.getProvider(id.trim()))
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('保存失败', 'Could not save provider')) }
  }
  const remove = async () => {
    if (!provider) return
    setError('')
    try { await api.deleteProvider(provider.id); setConfirmDelete(false); await onRefresh?.() } catch (cause) { setError(cause instanceof Error ? cause.message : t('移除失败', 'Could not remove provider')) }
  }
  const availableLevels = (row: ModelDraft): readonly string[] => {
    const listed = catalog?.models.find(model => model.provider === id && model.modelId === row.id.trim())
    return listed?.thinkingLevels ?? catalog?.thinkingLevels ?? [...INITIAL_LEVELS]
  }
  const providerId = provider?.id ?? id
  const keyConfigured = config?.credentialConfigured ?? provider?.configured ?? false
  const customized = config?.source === 'project'
  const defaults = config?.defaults
  return <div className={css.providerCard}>
    <div className={css.providerHeader}>
      <span className={css.providerTitle}>{name || t('新提供商', 'New provider')}</span>
      {provider?.custom === true && <span className={css.rowTag}>{t('自定义', 'Custom')}</span>}
      {keyConfigured
        ? <span className={css.credentialDot} data-configured="true" role="img" aria-label={t('API 密钥已配置', 'API key configured')} title={t('API 密钥已配置', 'API key configured')} />
        : <span className={css.credentialDot} role="img" aria-label={t('API 密钥缺失', 'API key missing')} title={t('API 密钥缺失', 'API key missing')} />}
      <span className={css.providerRowActions}>
        {!isNew && provider !== undefined && <button type="button" className={css.rowTextButton} aria-expanded={open}
          aria-label={t(`编辑 ${provider.name}`, `Edit ${provider.name}`)} onClick={() => setOpen(value => !value)}>{t('编辑', 'Edit')}</button>}
        {!isNew && provider?.source === 'project' && <button type="button" className={css.rowDangerButton}
          aria-label={t(`删除 ${provider.name}`, `Delete ${provider.name}`)} onClick={() => setConfirmDelete(true)}>{t('删除', 'Delete')}</button>}
      </span>
    </div>
    {open && <form className={css.providerForm} onSubmit={event => void save(event)}>
      {loading ? <p className={css.description} role="status">{t('正在读取配置…', 'Loading configuration…')}</p> : <>
        <div className={css.keyRow}>
          <span className={css.fieldLabel}>{t('API 密钥', 'API key')}</span>
          <div className={css.keyInput}>
            <Input type={revealed ? 'text' : 'password'} autoComplete="new-password" value={key} disabled={saving}
              aria-label={t(`API 密钥 ${providerId}`, `API key ${providerId}`)}
              placeholder={keyConfigured ? t('留空使用已保存凭据', 'Leave blank to use the saved credential') : t('输入 API 密钥', 'Enter an API key')}
              onChange={event => { setRevealed(false); setKey(event.currentTarget.value) }} />
            {key !== '' && <button type="button" className={css.keyToggle} aria-pressed={revealed} disabled={saving}
              aria-label={revealed ? t('隐藏密钥', 'Hide key') : t('显示密钥', 'Show key')}
              onClick={() => setRevealed(value => !value)}><IconChevronDownOutlineRegular size={14} /></button>}
          </div>
        </div>
        <button type="button" className={css.advancedToggle} aria-expanded={customOpen} onClick={() => setCustomOpen(value => !value)}>
          <IconChevronDownOutlineRegular size={12} />{t('自定义设置', 'Custom settings')}
        </button>
        {customOpen && <div className={css.providerFields}>
          <div className={css.twoColumns}><Field id={`provider-id-${providerId}`} label={t('提供商 ID', 'Provider ID')} value={id} onChange={setId} disabled={!isNew} /><Field id={`provider-name-${providerId}`} label={t('显示名称', 'Display name')} value={name} onChange={setName} /></div>
          <Field id={`provider-url-${providerId}`} label={t('API 地址', 'API base URL')} value={baseUrl} onChange={setBaseUrl} placeholder={t('没有默认地址', 'No default address')} />
          {isNew && <label className={css.field}>{t('接口协议', 'Protocol')}<select value={protocol} onChange={event => setProtocol(event.currentTarget.value)}>{API_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
        </div>}
        <section className={css.modelDirectory} aria-label={t('模型目录', 'Model directory')}>
          <div className={css.modelListHead}>
            <span className={css.directoryHeader}>{t('模型目录', 'Model directory')}</span>
            {config !== null && <span className={css.directoryMeta}>{customized ? t('已自定义模型目录', 'Custom model directory') : t('正在使用适配器默认模型', "Using the adapter's default models")}</span>}
            {customized && defaults !== undefined && <button type="button" className={css.linkButton} disabled={saving}
              onClick={() => setRows(defaults.map(draftFromModel))}>{t('恢复默认模型', 'Restore default models')}</button>}
            {provider !== undefined && <button type="button" className={css.linkButton} disabled={discovering || saving}
              onClick={() => void discover()}>{discovering ? t('正在向提供商请求…', 'Asking the provider…') : t('获取可用模型', 'Fetch available models')}</button>}
          </div>
          {rows.length === 0 && <p className={css.directoryHint}>{t('模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。', 'No models will appear in the picker; IDs outside the directory can still be sent.')}</p>}
          <div className={css.modelList}>
            {rows.map((row, index) => <div className={css.modelEntry} key={row.key}>
              <div className={css.modelRow}>
                <Input aria-label={t(`模型 ID ${index + 1}`, `Model ID ${index + 1}`)} value={row.id} placeholder={t('模型 ID', 'Model ID')} disabled={saving}
                  onChange={event => { patchRow(row.key, { id: event.currentTarget.value }) }} />
                <Input aria-label={t(`显示名称 ${index + 1}`, `Display name ${index + 1}`)} value={row.name} placeholder={t('留空时使用模型 ID', 'Uses the model ID when blank')} disabled={saving}
                  onChange={event => { patchRow(row.key, { name: event.currentTarget.value }) }} />
                <button type="button" className={css.modelIconButton} aria-expanded={row.expanded} title={t('模型选项', 'Model options')}
                  aria-label={t(`模型选项 ${index + 1}`, `Model options ${index + 1}`)} onClick={() => { patchRow(row.key, { expanded: !row.expanded }) }}>
                  {row.expanded ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
                </button>
                <button type="button" className={css.modelRemoveButton} disabled={saving} title={t('删除模型', 'Delete model')}
                  aria-label={t(`删除模型 ${index + 1}`, `Delete model ${index + 1}`)}
                  onClick={() => setRows(current => current.filter(item => item.key !== row.key))}><IconTrashOutlineRegular size={14} /></button>
              </div>
              {row.expanded && <div className={css.modelAdvanced}>
                <label className={css.modelField}><span className={css.fieldLabel}>{t('上下文窗口', 'Context window')}</span>
                  <Input inputMode="numeric" value={row.contextWindow} disabled={saving} aria-label={t(`上下文窗口 ${index + 1}`, `Context window ${index + 1}`)}
                    placeholder={row.base?.contextWindow === undefined ? t('使用提供商默认值', "Provider's default") : formatCapacity(row.base.contextWindow)}
                    onChange={event => { patchRow(row.key, { contextWindow: event.currentTarget.value }) }} /></label>
                <label className={css.modelField}><span className={css.fieldLabel}>{t('最大输出 token 数', 'Max output tokens')}</span>
                  <Input inputMode="numeric" value={row.maxTokens} disabled={saving} aria-label={t(`最大输出 token 数 ${index + 1}`, `Max output tokens ${index + 1}`)}
                    placeholder={row.base?.maxTokens === undefined ? t('使用提供商默认值', "Provider's default") : formatCapacity(row.base.maxTokens)}
                    onChange={event => { patchRow(row.key, { maxTokens: event.currentTarget.value }) }} /></label>
                <fieldset className={css.modelInputTypes} aria-label={t(`输入类型 ${index + 1}`, `Input types ${index + 1}`)}>
                  <legend className={css.fieldLabel}>{t('输入类型', 'Input types')}</legend>
                  <div className={css.modelInputChoices}>
                    {(['text', 'image'] as const).map(modality => <Checkbox key={modality} label={modality === 'text' ? t('文本', 'Text') : t('图片', 'Image')}
                      checked={row.input.includes(modality)} disabled={saving || row.input.length === 1 && row.input.includes(modality)}
                      onChange={checked => { patchRow(row.key, { input: (['text', 'image'] as const).filter(value => value === modality ? checked : row.input.includes(value)) }) }} />)}
                  </div>
                </fieldset>
                <ReasoningLevels row={row} available={availableLevels(row)} position={index + 1} disabled={saving}
                  onChange={patch => { patchRow(row.key, patch) }} t={t} />
              </div>}
            </div>)}
          </div>
          <Button type="button" size="sm" variant="outline" className={css.addModelButton} disabled={saving}
            onClick={() => addRows([{ id: '', name: '' }])}>{t('添加模型', 'Add model')}</Button>
        </section>
        {error && <p className={css.error} role="alert">{error}</p>}{status && <p className={css.success} role="status">{status}</p>}
        <div className={css.providerActions}>
          {!isNew && provider && <Button type="button" size="sm" variant="ghost" disabled={testing || saving} onClick={() => { setTesting(true); setError(''); setStatus(''); void api.testProvider(provider.id).then(result => { if (result.status === 'connected') setStatus(t('连接成功', 'Connection successful')); else setError(result.message ?? t('连接失败', 'Connection failed')) }).catch(cause => setError(cause instanceof Error ? cause.message : t('连接失败', 'Connection failed'))).finally(() => setTesting(false)) }}>{testing ? t('检测中…', 'Testing…') : t('测试连接', 'Test connection')}</Button>}
          <span className={css.actionSpacer} /><Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => { if (onCancel) onCancel(); else if (config) reset(config); setError(''); setStatus('') }}>{t('取消', 'Cancel')}</Button><Button type="submit" size="sm" variant="primary" disabled={saving || loading}>{saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}</Button>
        </div>
      </>}
    </form>}
    <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t('删除模型提供商', 'Delete model provider')} closeLabel={t('关闭', 'Close')} description={t('只影响这个项目的配置，不修改现有 Pi 配置。', 'Only this project configuration is affected. Existing Pi settings stay unchanged.')} footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('取消', 'Cancel')}</Button><Button variant="primary" onClick={() => void remove()}>{t('删除', 'Delete')}</Button></>} />
  </div>
}

/** DSH's per-model reasoning levels: a switch, then one row pairing a level with its wire value. */
function ReasoningLevels({ row, available, position, disabled, onChange, t }: {
  row: ModelDraft
  available: readonly string[]
  position: number
  disabled: boolean
  onChange: (patch: Partial<ModelDraft>) => void
  t: (chinese: string, english: string) => string
}) {
  const [typing, setTyping] = useState<{ level: string; text: string } | undefined>(undefined)
  const entries = row.levels
  const used = entries?.map(entry => entry.level) ?? []
  const label = t(`推理等级 ${position}`, `Reasoning levels ${position}`)
  const write = (next: ReasoningEntry[] | undefined): void => { onChange({ levels: next }) }
  return <div className={css.modelReasoning} role="group" aria-label={label}>
    <div className={css.modelReasoningHead}>
      <span className={css.fieldLabel}>
        {t('推理等级', 'Reasoning levels')}
        <Tooltip label={t('API 参数值会写入请求的推理强度字段（如 OpenAI 的 reasoning_effort），默认与档位名相同；如有不同，以模型提供商的 API 文档为准。Off 表示关闭思考，不需要填写参数值；配置中已写入的值会保留并发送。',
          'The API value is written to the request\'s reasoning-effort field (for example OpenAI\'s reasoning_effort). It defaults to the level name; follow the provider\'s API docs when they differ. Off turns thinking off and needs no value.')}
          side="right" delayMs={0} focusDelayMs={0} portal openOnClick>
          <button type="button" className={css.helpButton} aria-label={t('推理等级说明', 'About reasoning levels')}>?</button>
        </Tooltip>
      </span>
      <Switch checked={entries !== undefined} label={label} disabled={disabled}
        onChange={on => {
          write(on ? INITIAL_LEVELS.filter(level => available.includes(level)).map(level => ({ level, value: defaultLevelValue(level) })) : undefined)
          setTyping(undefined)
        }} />
    </div>
    {entries === undefined ? null : <>
      {entries.length > 0 && <div className={css.modelReasoningRow} aria-hidden="true">
        <span className={css.fieldLabel}>{t('档位', 'Level')}</span>
        <span className={css.fieldLabel}>{t('API 参数值', 'API value')}</span>
      </div>}
      {entries.map((entry, index) => {
        const choices = [...(available.includes(entry.level) ? [] : [entry.level]),
          ...available.filter(choice => choice === entry.level || !used.includes(choice))]
        return <div className={css.modelReasoningRow} key={index}>
          <select className={css.selectInput} value={entry.level} disabled={disabled}
            aria-label={t(`档位 ${index + 1}`, `Level ${index + 1}`)}
            onChange={event => {
              const level = event.currentTarget.value
              write(entries.map((item, at) => at === index ? { level, value: defaultLevelValue(level) } : item))
            }}>
            {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
          </select>
          <Input type="text" disabled={disabled || entry.level === 'off'}
            aria-label={t(`${entry.level} API 参数值`, `${entry.level} API value`)}
            placeholder={entry.level === 'off' ? t('关闭思考', 'Thinking off') : entry.level}
            value={typing?.level === entry.level ? typing.text : entry.value ?? ''}
            onChange={event => {
              const text = event.currentTarget.value
              setTyping({ level: entry.level, text })
              const trimmed = text.trim()
              write(entries.map((item, at) => at === index ? { level: item.level, value: trimmed === '' ? defaultLevelValue(item.level) : trimmed } : item))
            }}
            onBlur={() => { setTyping(undefined) }} />
          <button type="button" className={css.modelRemoveButton} disabled={disabled}
            aria-label={t(`删除档位 ${entry.level}`, `Delete level ${entry.level}`)} title={t('删除档位', 'Delete level')}
            onClick={() => { write(entries.filter((_item, at) => at !== index)) }}><IconTrashOutlineRegular size={14} /></button>
        </div>
      })}
      <Button type="button" size="sm" variant="outline" className={css.addModelButton}
        disabled={disabled || available.every(level => used.includes(level))}
        onClick={() => {
          const highest = Math.max(-1, ...used.map(level => available.indexOf(level)))
          const level = available.find((candidate, index) => index > highest && !used.includes(candidate))
            ?? available.find(candidate => !used.includes(candidate))
          if (level === undefined) return
          write([...entries, { level, value: defaultLevelValue(level) }])
        }}>{t('添加档位', 'Add level')}</Button>
    </>}
  </div>
}

function Field({ id, label, value, onChange, placeholder, disabled }: { id: string; label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) {
  return <label className={css.field} htmlFor={id}>{label}<Input id={id} value={value} placeholder={placeholder} disabled={disabled} onChange={event => onChange(event.currentTarget.value)} /></label>
}
