import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button, IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular,
  IconPlusOutlineRegular, IconSettingsOutlineRegular, IconDatabaseOutlineRegular, IconCordisPluginOutlineRegular,
  IconChevronUpOutlineRegular, Input, JsonBlock, Menu, Modal, SettingsSecretField,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccessMode, AppSettings, ModelCatalog, ProviderConfigSummary, ProviderInput, ProviderSummary, UpdateAppSettingsInput } from '../shared/types.ts'
import { api } from './api.ts'
import { DEFAULT_UI_SETTINGS, useUiPreferences } from './ui-preferences.tsx'
import { DEFAULT_SHORTCUTS, displayShortcut, shortcutFromEvent, resolveShortcuts, type ShortcutCommand } from './keyboard.ts'
import css from './SettingsDialog.module.css'

export type SettingsTab = 'general' | 'models' | 'plugins' | 'presets'
export interface SettingsDialogProps {
  open: boolean; catalog: ModelCatalog | null; saving: boolean; onClose: () => void
  onSave: (input: ProviderInput) => Promise<void>
  settings?: AppSettings; onSettingsChange?: (patch: UpdateAppSettingsInput) => Promise<unknown>
  initialTab?: SettingsTab; pluginsPanel?: ReactNode; presetsPanel?: ReactNode
  onRefreshCatalog?: () => Promise<void>; accessModes?: AccessMode[]
}
const API_OPTIONS = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' }, { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' }, { id: 'google-generative-ai', label: 'Google Generative AI' },
]

/** DSH's two-column settings shell; every control updates the project configuration. */
export default function SettingsDialog(props: SettingsDialogProps) {
  const { open, catalog, saving, onClose, onSave, initialTab = 'general', pluginsPanel, presetsPanel, onRefreshCatalog } = props
  const { t, settings: contextSettings } = useUiPreferences()
  const settings = props.settings ?? contextSettings ?? DEFAULT_UI_SETTINGS
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [moreFonts, setMoreFonts] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [recording, setRecording] = useState<string | null>(null)
  const [newProvider, setNewProvider] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [providerChoice, setProviderChoice] = useState<ProviderSummary | undefined>()
  useEffect(() => { if (open) { setTab(initialTab); setError(''); setNewProvider(false) } }, [open, initialTab])
  const providers = catalog?.providers ?? []
  const configured = providers.filter(provider => provider.configured || provider.custom)
  const available = (catalog?.models ?? []).filter(model => model.available)
  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
    { id: 'general', label: t('通用设置', 'General'), icon: <IconSettingsOutlineRegular size={16} /> },
    { id: 'models', label: t('模型', 'Models'), icon: <IconDatabaseOutlineRegular size={16} /> },
    { id: 'plugins', label: t('内置插件', 'Built-in plugins'), icon: <IconCordisPluginOutlineRegular size={16} /> },
    { id: 'presets', label: t('Agent 预设', 'Agent presets'), icon: <IconAgentPresetOutlineRegular size={16} /> },
  ]
  const update = async (patch: UpdateAppSettingsInput) => {
    if (!props.onSettingsChange || pending) return
    setPending(true); setError('')
    try { await props.onSettingsChange(patch) } catch (cause) { setError(cause instanceof Error ? cause.message : t('保存设置失败', 'Could not save settings')) }
    finally { setPending(false) }
  }
  const accessName = (value: AccessMode) => value === 'readOnly' ? t('只读', 'Read only') : value === 'workspaceWrite' ? t('工作区内修改', 'Workspace write') : t('完全访问', 'Full access')
  const bindingNames: Record<string, string> = {
    newConversation: t('新建会话', 'New conversation'), search: t('搜索会话', 'Search conversations'), settings: t('打开设置', 'Open settings'),
    toggleSidebar: t('切换侧栏', 'Toggle sidebar'), send: t('发送消息', 'Send message'), newline: t('换行', 'New line'), alternateSend: t('使用另一发送方式', 'Alternate send mode'),
  }
  return <>
    <Modal open={open} onClose={onClose} title={t('设置', 'Settings')} headless className={css.modal} backdropBlur={false}>
      <aside className={css.navigation}>
        <h2>{t('设置', 'Settings')}</h2>
        <nav aria-label={t('设置分类', 'Settings categories')}>{tabs.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => { setTab(item.id); setError('') }}>{item.icon}<span>{item.label}</span></button>)}</nav>
      </aside>
      <section className={css.main}>
        <div className={css.topbar}><Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>{t('查看配置', 'View configuration')}</Button><button className={css.close} type="button" aria-label={t('关闭设置', 'Close settings')} onClick={onClose}><IconCloseOutlineRegular size={18} /></button></div>
        <div className={css.scroll}>
          {error && <p className={css.error} role="alert">{error}</p>}
          {tab === 'general' && <div className={css.general}>
            <SettingRow title={t('权限', 'Permissions')} description={t('选择新会话的默认权限模式', 'Choose the default access mode for new conversations')}>
              <Choice label={t('默认权限', 'Default access')} value={settings.defaultAccessMode} disabled={pending} options={(props.accessModes ?? ['readOnly', 'workspaceWrite', 'fullAccess'] as AccessMode[]).map(value => ({ value, label: accessName(value) }))} onChange={value => void update({ defaultAccessMode: value as AccessMode })} />
            </SettingRow>
            <SettingRow title={t('语言', 'Language')}><Choice label={t('语言', 'Language')} value={settings.locale} disabled={pending} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} onChange={value => void update({ locale: value as AppSettings['locale'] })} /></SettingRow>
            <SettingRow title={t('外观', 'Appearance')}><div className={css.segment}>{(['light', 'dark', 'system'] as const).map(value => <button key={value} type="button" aria-pressed={settings.theme === value} disabled={pending} onClick={() => void update({ theme: value })}>{value === 'light' ? t('浅色', 'Light') : value === 'dark' ? t('深色', 'Dark') : t('跟随系统', 'System')}</button>)}</div></SettingRow>
            <SettingRow title={t('字号大小', 'Font size')} description={t('仅影响会话内容的字号', 'Applies to conversation content')}><div className={css.fontControls}><NumberField value={settings.fontSize} min={12} max={20} label={t('正文字号', 'Text size')} disabled={pending} onChange={fontSize => void update({ fontSize })} /><span>px</span><button className={css.moreButton} type="button" aria-label={t('更多字体设置', 'More font settings')} aria-expanded={moreFonts} onClick={() => setMoreFonts(value => !value)}><IconSettingsOutlineRegular size={14} /></button></div></SettingRow>
            {moreFonts && <div className={css.subSettings}><SettingRow title={t('代码字号', 'Code font size')}><NumberField value={settings.codeFontSize} min={10} max={16} label={t('代码字号', 'Code size')} disabled={pending} onChange={codeFontSize => void update({ codeFontSize })} /></SettingRow><SettingRow title={t('终端字号', 'Terminal font size')}><NumberField value={settings.terminalFontSize} min={10} max={20} label={t('终端字号', 'Terminal size')} disabled={pending} onChange={terminalFontSize => void update({ terminalFontSize })} /></SettingRow></div>}
            <SettingRow title={t('工作步骤展示', 'Work step display')} description={t('选择希望看到多少工具调用细节', 'Choose how much tool detail to show')}><Choice label={t('工作步骤展示', 'Work step display')} value={settings.processDisplay} disabled={pending} options={[{ value: 'detailed', label: t('详细', 'Detailed') }, { value: 'compact', label: t('简洁', 'Compact') }]} onChange={value => void update({ processDisplay: value as AppSettings['processDisplay'] })} /></SettingRow>
            <SettingRow title={t('工作步骤收起时机', 'Collapse work steps')} description={t('选择何时自动收起工作步骤', 'Choose when work steps collapse')}><Choice label={t('工作步骤收起时机', 'Collapse work steps')} value={settings.collapseProcess} disabled={pending} options={[{ value: 'afterResponse', label: t('回答结束后', 'After response') }, { value: 'always', label: t('始终收起', 'Always collapsed') }, { value: 'never', label: t('保持展开', 'Keep expanded') }]} onChange={value => void update({ collapseProcess: value as AppSettings['collapseProcess'] })} /></SettingRow>
            <SettingRow title={t('显示代码工作视图', 'Show coding views')} description={t('显示轨迹、文件预览与代码差异', 'Show trajectory, files and code changes')}><Toggle label={t('显示代码工作视图', 'Show coding views')} checked={settings.codingViews} disabled={pending} onChange={codingViews => void update({ codingViews })} /></SettingRow>
            <SettingRow title={t('快捷键', 'Keyboard shortcuts')} description={t('查看和编辑可用的快捷键与输入操作', 'View and edit shortcuts and input actions')}><Button size="sm" variant="outline" onClick={() => { setRecording(null); setShortcutsOpen(true) }}>{t('编辑快捷键', 'Edit shortcuts')}</Button></SettingRow>
            <SettingRow title={t('繁忙时的发送行为', 'Send while running')} description={t('Enter 和发送按钮的行为；另一快捷键使用相反方式', 'Behavior of Enter and Send; the alternate shortcut uses the other mode')}><Choice label={t('繁忙时的发送行为', 'Send while running')} value={settings.busySendMode} disabled={pending} options={[{ value: 'followUp', label: t('排队发送', 'Queue message') }, { value: 'steer', label: t('立即插入', 'Steer now') }]} onChange={value => void update({ busySendMode: value as AppSettings['busySendMode'] })} /></SettingRow>
            <SettingRow title={t('默认模型', 'Default model')} description={t('用于新建会话，不改变正在运行的请求', 'Used for new conversations; active requests stay unchanged')}><select className={css.nativeSelect} aria-label={t('默认模型', 'Default model')} disabled={pending} value={settings.defaultModel ? JSON.stringify(settings.defaultModel) : '__inherit'} onChange={event => void update({ defaultModel: event.currentTarget.value === '__inherit' ? null : JSON.parse(event.currentTarget.value) })}><option value="__inherit">{t('使用 Pi 默认配置', 'Use Pi defaults')}</option>{available.map(model => <option key={`${model.provider}/${model.modelId}`} value={JSON.stringify({ provider: model.provider, modelId: model.modelId })}>{model.name} · {model.provider}</option>)}</select></SettingRow>
          </div>}
          {tab === 'models' && <div className={css.models}>
            <h3>{t('模型', 'Models')}</h3><p className={css.description}>{t('填入各提供商的 API 密钥即可使用其模型。', 'Configure provider credentials to use their models.')}</p>
            {configured.map(provider => <ProviderCard key={provider.id} provider={provider} catalog={catalog} saving={saving} onSave={onSave} onRefresh={onRefreshCatalog} />)}
            {newProvider && <ProviderCard key={`new-${providerChoice?.id ?? 'custom'}`} provider={providerChoice} isNew catalog={catalog} saving={saving} onSave={async input => { await onSave(input); setNewProvider(false) }} onCancel={() => setNewProvider(false)} onRefresh={onRefreshCatalog} />}
            {!newProvider && <Menu open={addMenuOpen} onClose={() => setAddMenuOpen(false)} portal items={[{ id: '__custom', label: t('自定义模型提供商', 'Custom provider') }, ...providers.filter(provider => !configured.some(item => item.id === provider.id)).map(provider => ({ id: provider.id, label: provider.name }))]}
              onSelect={id => { setProviderChoice(providers.find(provider => provider.id === id)); setNewProvider(true); setAddMenuOpen(false) }} anchor={<button className={css.addProvider} type="button" onClick={() => setAddMenuOpen(true)}><IconPlusOutlineRegular size={16} />{t('添加模型提供商', 'Add model provider')}</button>} />}
          </div>}
          {tab === 'plugins' && (pluginsPanel ?? <p role="status">{t('正在加载插件…', 'Loading plugins…')}</p>)}
          {tab === 'presets' && (presetsPanel ?? <p role="status">{t('正在加载预设…', 'Loading presets…')}</p>)}
        </div>
      </section>
    </Modal>
    <Modal open={configOpen} onClose={() => setConfigOpen(false)} title={t('配置预览', 'Configuration preview')} closeLabel={t('关闭', 'Close')} className={css.childModal}><JsonBlock label="settings.json" payload={settings} truncatedLabel={count => `${count} bytes`} /><p className={css.description}>{t('此处只展示应用偏好，模型凭据保留在服务端。', 'This view contains preferences only. Model credentials remain on the server.')}</p></Modal>
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
  </>
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className={css.settingRow}><div className={css.settingLabel}><span>{title}</span>{description && <p>{description}</p>}</div><div className={css.settingControl}>{children}</div></div>
}
function Choice({ label, value, options, disabled, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => setOpen(false)} portal align="end" selectedId={value} items={options.map(option => ({ id: option.value, label: option.label }))} onSelect={id => { onChange(id); setOpen(false) }} anchor={<button className={css.choice} type="button" aria-label={label} disabled={disabled} onClick={() => setOpen(value => !value)}>{options.find(option => option.value === value)?.label ?? value}<IconChevronDownOutlineRegular size={11} /></button>} />
}
function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={css.toggle}><span /></button>
}
function NumberField({ value, min, max, label, disabled, onChange }: { value: number; min: number; max: number; label: string; disabled?: boolean; onChange: (value: number) => void }) {
  return <div className={css.numberField}><span aria-label={label}>{value}</span><div><button type="button" aria-label={`${label} +`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}><IconChevronUpOutlineRegular size={10} /></button><button type="button" aria-label={`${label} −`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}><IconChevronDownOutlineRegular size={10} /></button></div></div>
}

function ProviderCard({ provider, catalog, saving, onSave, onCancel, onRefresh, isNew = false }: {
  provider?: ProviderSummary; catalog: ModelCatalog | null; saving: boolean; isNew?: boolean
  onSave: (input: ProviderInput) => Promise<void>; onCancel?: () => void; onRefresh?: () => Promise<void>
}) {
  const { t } = useUiPreferences()
  const [config, setConfig] = useState<ProviderConfigSummary | null>(null)
  const [id, setId] = useState(provider?.id ?? '')
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [protocol, setProtocol] = useState('openai-completions')
  const [models, setModels] = useState('')
  const [key, setKey] = useState('')
  const [advanced, setAdvanced] = useState(isNew)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const reset = (value: ProviderConfigSummary) => {
    setConfig(value); setId(value.id); setName(value.name); setBaseUrl(value.baseUrl ?? ''); setProtocol(value.api)
    setModels(value.models.map(model => `${model.id} | ${model.name}`).join('\n')); setKey('')
  }
  useEffect(() => {
    if (!provider) return
    let active = true; setLoading(true)
    api.getProvider(provider.id).then(value => { if (active) reset(value) }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : t('无法读取配置', 'Could not load configuration')) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [provider?.id])
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setStatus('')
    const modelRows = models.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const [modelId = '', ...rest] = line.split('|'); const modelName = rest.join('|').trim()
      const previous = config?.models.find(model => model.id === modelId.trim())
      const listed = catalog?.models.find(model => model.provider === id && model.modelId === modelId.trim())
      return { ...(previous ?? { reasoning: listed?.reasoning, contextWindow: listed?.contextWindow }), id: modelId.trim(), name: modelName || modelId.trim() }
    })
    if (!id.trim() || !name.trim() || !baseUrl.trim() || !modelRows.length) { setError(t('请填写提供商、接口地址和至少一个模型', 'Enter a provider, endpoint and at least one model')); setAdvanced(true); return }
    try {
      await onSave({ id: id.trim(), name: name.trim(), baseUrl: baseUrl.trim(), api: protocol, models: modelRows, ...(key ? { apiKey: key } : {}), ...(config?.headers ? { headers: config.headers } : {}), ...(config?.compat ? { compat: config.compat } : {}) })
      setKey(''); setStatus(t('已保存', 'Saved'))
      reset(await api.getProvider(id.trim()))
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('保存失败', 'Could not save provider')) }
  }
  const remove = async () => {
    if (!provider) return
    setError('')
    try { await api.deleteProvider(provider.id); setConfirmDelete(false); await onRefresh?.() } catch (cause) { setError(cause instanceof Error ? cause.message : t('移除失败', 'Could not remove provider')) }
  }
  return <form className={css.providerCard} onSubmit={event => void save(event)}>
    <div className={css.providerHeader}><span>{name || t('新提供商', 'New provider')}</span><small>{id}</small></div>
    {loading ? <p className={css.description} role="status">{t('正在读取配置…', 'Loading configuration…')}</p> : <>
      <SettingsSecretField id={`provider-key-${provider?.id ?? 'new'}`} label={t('API 密钥', 'API key')} text={key} onEdit={setKey} configured={config?.credentialConfigured ?? provider?.configured ?? false}
        stateLabel={t('认证已配置', 'Authentication configured')} hint={config?.credentialConfigured || provider?.configured ? t('留空保留现有认证，密钥不会回传。', 'Leave blank to keep existing authentication. Secrets are never returned.') : t('填写 API 密钥，或使用已配置的环境认证。', 'Enter an API key or use configured environment authentication.')} disabled={saving} />
      <button className={css.advancedToggle} type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}><IconChevronDownOutlineRegular size={12} />{t('自定义设置', 'Custom settings')}</button>
      {advanced && <div className={css.providerFields}>
        <div className={css.twoColumns}><Field id={`provider-id-${id}`} label={t('提供商 ID', 'Provider ID')} value={id} onChange={setId} disabled={!isNew} /><Field id={`provider-name-${id}`} label={t('显示名称', 'Display name')} value={name} onChange={setName} /></div>
        <Field id={`provider-url-${id}`} label={t('接口地址', 'Base URL')} value={baseUrl} onChange={setBaseUrl} placeholder="https://api.example.com/v1" />
        <label className={css.field}>{t('接口协议', 'Protocol')}<select value={protocol} onChange={event => setProtocol(event.currentTarget.value)}>{API_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label className={css.field}>{t('模型列表', 'Models')}<textarea rows={4} value={models} onChange={event => setModels(event.currentTarget.value)} placeholder="model-id | Display name" /></label>
      </div>}
      {error && <p className={css.error} role="alert">{error}</p>}{status && <p className={css.success} role="status">{status}</p>}
      <div className={css.providerActions}>
        {!isNew && provider && <><Button type="button" size="sm" variant="ghost" disabled={testing || saving} onClick={() => { setTesting(true); setError(''); setStatus(''); void api.testProvider(provider.id).then(result => { if (result.status === 'connected') setStatus(t('连接成功', 'Connection successful')); else setError(result.message ?? t('连接失败', 'Connection failed')) }).catch(cause => setError(cause instanceof Error ? cause.message : t('连接失败', 'Connection failed'))).finally(() => setTesting(false)) }}>{testing ? t('检测中…', 'Testing…') : t('测试连接', 'Test connection')}</Button>
          {(config?.source ?? provider.source) === 'project' && <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>{t('移除项目覆盖', 'Remove override')}</Button>}</>}
        <span className={css.actionSpacer} /><Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => { if (onCancel) onCancel(); else if (config) reset(config); setError(''); setStatus('') }}>{t('取消', 'Cancel')}</Button><Button type="submit" size="sm" variant="primary" disabled={saving || loading}>{saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}</Button>
      </div>
    </>}
    <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t('移除模型提供商', 'Remove model provider')} closeLabel={t('关闭', 'Close')} description={t('只影响这个项目的配置，不修改现有 Pi 配置。', 'Only this project configuration is affected. Existing Pi settings stay unchanged.')} footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('取消', 'Cancel')}</Button><Button variant="primary" onClick={() => void remove()}>{t('移除', 'Remove')}</Button></>} />
  </form>
}
function Field({ id, label, value, onChange, placeholder, disabled }: { id: string; label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) {
  return <label className={css.field} htmlFor={id}>{label}<Input id={id} value={value} placeholder={placeholder} disabled={disabled} onChange={event => onChange(event.currentTarget.value)} /></label>
}
