import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconPlusOutlineRegular, IconTrashOutlineRegular, Input, Modal, SegmentedControl, Switch, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelCatalog, ProviderConfigSummary, ProviderInput, ProviderModelInput, ProviderSummary } from '../shared/types.ts'
import { api } from './api.ts'
import { draftReasoningLevels, pinReasoningLevels, type ReasoningEntry } from './reasoning-levels.ts'
import {
  beginProviderCheck, canCheckSavedProviderRequest, clearProviderEditorFeedback, createProviderEditorCheckState,
  finishProviderCheck, isProviderEditorDirty, loadProviderEditorRequest, markProviderEditorSaved,
  setProviderEditorFeedback, updateProviderEditorRequest,
} from './provider-editor-state.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './ModelSettings.module.css'

const API_OPTIONS = [
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
  { id: 'google-generative-ai', label: 'Google Generative AI' },
]

/** A route id usable as a settings key and as the stem of a credential name. */
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

/** The two ways the add card gains a provider, matching DSH's segmented control. */
type AddMode = 'catalog' | 'custom'

/**
 * DSH's Models page: one row per configured provider, then one add card with
 * two ways in — adopt a provider the catalog already ships, or declare a
 * custom model API. Only one editor is open at a time.
 */
export function ModelsPanel({ catalog, saving, onSave, onRefresh }: {
  catalog: ModelCatalog | null
  saving: boolean
  onSave: (input: ProviderInput) => Promise<void>
  onRefresh?: () => Promise<void>
}) {
  const { t } = useUiPreferences()
  const providers = catalog?.providers ?? []
  // A row is a provider the user can already reach or has stored a profile
  // for; everything else in the directory is what the add card can adopt.
  const configured = providers.filter(provider => provider.configured || provider.source === 'project')
  const addable = providers.filter(provider => !configured.some(item => item.id === provider.id))
  const [editing, setEditing] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addMode, setAddMode] = useState<AddMode>('catalog')
  const [visited, setVisited] = useState<ReadonlySet<AddMode>>(() => new Set<AddMode>(['catalog']))
  const [choice, setChoice] = useState<string | undefined>(() => addable[0]?.id)
  const [savedName, setSavedName] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<ProviderSummary | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState('')
  const picked = addable.find(provider => provider.id === choice) ?? addable[0]

  const openAdd = () => {
    const initial: AddMode = addable.length > 0 ? 'catalog' : 'custom'
    setEditing(null); setSavedName(undefined); setDeleteFailure('')
    setAddMode(initial); setVisited(new Set<AddMode>([initial]))
    setChoice(addable[0]?.id); setAddOpen(true)
  }
  const closeAdd = () => { setAddOpen(false); setEditing(null) }
  const finish = (name: string) => { closeAdd(); setSavedName(name) }
  const openEditor = (id: string) => {
    setAddOpen(false); setSavedName(undefined)
    setEditing(current => current === id ? null : id)
  }
  const remove = async () => {
    if (deleteTarget === undefined || deleting) return
    setDeleting(true); setDeleteFailure('')
    try {
      await api.deleteProvider(deleteTarget.id)
      await onRefresh?.()
      setDeleteTarget(undefined)
    } catch (cause) {
      setDeleteFailure(cause instanceof Error ? cause.message : t('移除失败', 'Could not remove provider'))
    } finally { setDeleting(false) }
  }
  return <div className={css.models}>
    <h3>{t('模型', 'Models')}</h3>
    <p className={css.modelsIntro}>{t('填入各提供商的 API 密钥即可使用其模型。', 'Enter your API keys to use models from the following providers.')}</p>
    {savedName !== undefined && <p className={css.savedNotice} role="status" aria-live="polite">{t(`已保存 ${savedName}。`, `Saved ${savedName}.`)}</p>}
    <ul className={css.providerRows}>
      {configured.map(provider => <ProviderRow key={provider.id} provider={provider} catalog={catalog} saving={saving}
        open={!addOpen && editing === provider.id}
        onToggle={() => { openEditor(provider.id) }}
        onSave={onSave} onRefresh={onRefresh}
        onSaved={name => { setEditing(null); setSavedName(name) }}
        onDelete={() => { setDeleteFailure(''); setDeleteTarget(provider) }} />)}
    </ul>
    <div className={css.addBlock}>
      {addOpen ? <div className={css.addCard}>
        <div className={css.addModes}>
          <SegmentedControl id="model-add-mode" label={t('添加方式', 'How to add')} value={addMode} disabled={saving}
            options={[
              {
                value: 'catalog', label: t('第三方模型提供商', 'Third-party model provider'),
                disabled: addable.length === 0,
                ...(addable.length === 0 ? { title: t('目录中的提供商都已添加。', 'Every catalog provider is already configured.') } : {}),
              },
              { value: 'custom', label: t('自定义模型 API', 'Custom model API') },
            ]}
            onChange={next => { setAddMode(next); setVisited(previous => new Set<AddMode>([...previous, next])) }} />
          <p className={css.advancedHint}>{addMode === 'catalog'
            ? t('从内置目录中选择 OpenAI、Anthropic、Kimi 等提供商，填入其 API 密钥即可使用。', 'Pick OpenAI, Anthropic, Kimi, or another provider from the built-in catalog and enter its API key.')
            : t('连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。', 'Connect a relay, a self-hosted server, or another OpenAI- or Anthropic-compatible endpoint by its base URL, protocol, and models.')}</p>
        </div>
        {visited.has('catalog') && <div className={css.addPanel} hidden={addMode !== 'catalog'}>
          {picked === undefined
            ? <p className={css.advancedHint}>{t('目录中的提供商都已添加。', 'Every catalog provider is already configured.')}</p>
            : <>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('提供商', 'Provider')}</span>
                <select className={css.selectInput} value={picked.id} aria-label={t('提供商', 'Provider')} disabled={saving}
                  onChange={event => { setChoice(event.currentTarget.value) }}>
                  {addable.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </label>
              <ProviderEditor key={picked.id} provider={picked} catalog={catalog} saving={saving}
                hideTitle onSave={onSave} onRefresh={onRefresh}
                onCancel={() => { closeAdd() }} onSaved={name => { finish(name) }} />
            </>}
        </div>}
        {visited.has('custom') && <div className={css.addPanel} hidden={addMode !== 'custom'}>
          <ProviderEditor create catalog={catalog} saving={saving}
            onSave={onSave} onCancel={() => { closeAdd() }} onSaved={name => { finish(name) }} />
        </div>}
      </div> : <button className={css.addProvider} type="button" disabled={saving} onClick={openAdd}>
        <IconPlusOutlineRegular size={14} />{t('添加模型提供商', 'Add model provider')}
      </button>}
    </div>
    <Modal open={deleteTarget !== undefined} onClose={() => { if (!deleting) { setDeleteTarget(undefined); setDeleteFailure('') } }}
      title={deleteTarget === undefined ? '' : t(`删除 ${deleteTarget.name}？`, `Delete ${deleteTarget.name}?`)}
      closeLabel={t('关闭', 'Close')}
      description={deleteTarget === undefined ? '' : deleteTarget.custom
        ? t(`删除 ${deleteTarget.name} 会移除其配置和存储的 API 密钥。`, `Deleting ${deleteTarget.name} removes its configuration and stored API key.`)
        : t(`删除 ${deleteTarget.name} 会移除其全局配置并恢复内置模型目录；已保存的密钥会保留。`, `Deleting ${deleteTarget.name} removes its global configuration and restores the shipped model directory. The stored key is kept.`)}
      footer={<>
        <Button variant="outline" disabled={deleting} onClick={() => { setDeleteTarget(undefined); setDeleteFailure('') }}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" disabled={deleting} onClick={() => void remove()}>{deleting
          ? t(`正在删除 ${deleteTarget?.name ?? ''}…`, `Deleting ${deleteTarget?.name ?? ''}…`)
          : t(`删除 ${deleteTarget?.name ?? ''}`, `Delete ${deleteTarget?.name ?? ''}`)}</Button>
      </>}>
      {deleteFailure === '' ? null : <p className={css.error} role="alert">{deleteFailure}</p>}
    </Modal>
  </div>
}

/** One configured provider: a collapsed row with edit/delete, one editor card below. */
function ProviderRow({ provider, catalog, saving, open, onToggle, onSave, onSaved, onDelete, onRefresh }: {
  provider: ProviderSummary
  catalog: ModelCatalog | null
  saving: boolean
  open: boolean
  onToggle: () => void
  onSave: (input: ProviderInput) => Promise<void>
  onSaved: (name: string) => void
  onDelete: () => void
  onRefresh?: () => Promise<void>
}) {
  const { t } = useUiPreferences()
  return <li className={css.providerRow}>
    <div className={css.providerHeader}>
      <span className={css.providerIdentity}>
        <span className={css.providerTitle}>{provider.name}</span>
        {provider.custom && <span className={css.rowTag}>{t('自定义', 'Custom')}</span>}
        {provider.configured
          ? <span className={css.credentialDot} data-configured="true" role="img" aria-label={t('API 密钥已配置', 'API key configured')} title={t('API 密钥已配置', 'API key configured')} />
          : <span className={css.credentialDot} role="img" aria-label={t('API 密钥缺失', 'API key missing')} title={t('API 密钥缺失', 'API key missing')} />}
      </span>
      <span className={css.providerRowActions}>
        <button type="button" className={css.rowTextButton} aria-expanded={open} disabled={!open && saving}
          aria-label={t(`编辑 ${provider.name}`, `Edit ${provider.name}`)} onClick={onToggle}>{t('编辑', 'Edit')}</button>
        {provider.source === 'project' && <button type="button" className={css.rowDangerButton} disabled={saving}
          aria-label={t(`删除 ${provider.name}`, `Delete ${provider.name}`)} onClick={onDelete}>{t('删除', 'Delete')}</button>}
      </span>
    </div>
    {open && <ProviderEditor provider={provider} catalog={catalog} saving={saving}
      onSave={onSave} onRefresh={onRefresh} onCancel={onToggle} onSaved={onSaved} />}
  </li>
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
  const levels = draftReasoningLevels(model)
  return {
    key: `${model.id}:${crypto.randomUUID()}`,
    id: model.id,
    name: model.name === model.id ? '' : model.name,
    contextWindow: '',
    maxTokens: '',
    input: model.input !== undefined && model.input.length > 0 ? [...model.input] : ['text'],
    ...(levels === undefined ? {} : { levels }),
    expanded: false,
    base: model,
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * One provider's editor: the write-only API key first, then the curated
 * fields behind DSH's "customized settings" disclosure, and the model
 * directory. A custom route's create form shows the same fields directly
 * because its identity and protocol cannot be defaulted.
 */
function ProviderEditor({ provider, catalog, saving, create = false, hideTitle = false, onSave, onCancel, onSaved, onRefresh }: {
  provider?: ProviderSummary
  catalog: ModelCatalog | null
  saving: boolean
  create?: boolean
  hideTitle?: boolean
  onSave: (input: ProviderInput) => Promise<void>
  onCancel: () => void
  onSaved?: (name: string) => void
  onRefresh?: () => Promise<void>
}) {
  const { t } = useUiPreferences()
  const [config, setConfig] = useState<ProviderConfigSummary | null>(null)
  const [loading, setLoading] = useState(!create)
  const [id, setId] = useState(provider?.id ?? '')
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [protocol, setProtocol] = useState('openai-completions')
  const [rows, setRows] = useState<ModelDraft[]>([])
  const [key, setKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [pending, setPending] = useState(false)
  const [checkState, setCheckState] = useState(createProviderEditorCheckState)
  const requestVersion = useRef(0)
  const testing = checkState.activity === 'testing'
  const discovering = checkState.activity === 'discovering'
  const disabled = saving || pending || loading || testing || discovering
  const makeRequestDraft = (nextBaseUrl = baseUrl, nextProtocol = protocol, nextRows = rows) => ({
    baseUrl: nextBaseUrl,
    protocol: nextProtocol,
    // Internal row keys and expansion state are presentation details, not provider request data.
    models: nextRows.map(row => ({
      id: row.id, name: row.name, contextWindow: row.contextWindow, maxTokens: row.maxTokens,
      input: [...row.input], levels: row.levels, base: row.base,
    })),
  })
  const updateRequestDraft = (nextBaseUrl = baseUrl, nextProtocol = protocol, nextRows = rows, credentialDrafted = key !== '') => {
    requestVersion.current += 1
    setCheckState(current => updateProviderEditorRequest(current, makeRequestDraft(nextBaseUrl, nextProtocol, nextRows), credentialDrafted))
  }
  const clearCheckFeedback = () => setCheckState(current => clearProviderEditorFeedback(current))
  const showFormError = (message: string) => setCheckState(current => setProviderEditorFeedback(current, { tone: 'error', message }))
  const applyConfig = (value: ProviderConfigSummary) => {
    const nextRows = value.models.map(draftFromModel)
    requestVersion.current += 1
    setConfig(value); setId(value.id); setName(value.name)
    setBaseUrl(value.baseUrl ?? ''); setProtocol(value.api)
    setRows(nextRows); setKey(''); setRevealed(false)
    setCheckState(loadProviderEditorRequest(makeRequestDraft(value.baseUrl ?? '', value.api, nextRows), checkState.nextActivityId))
  }
  useEffect(() => {
    if (create || provider === undefined) return
    let active = true
    setLoading(true)
    api.getProvider(provider.id).then(value => { if (active) applyConfig(value) })
      .catch(cause => { if (active) setCheckState(current => setProviderEditorFeedback(current, { tone: 'error', message: cause instanceof Error ? cause.message : t('无法读取配置', 'Could not load configuration') })) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [create, provider?.id])
  const replaceRows = (nextRows: ModelDraft[]) => {
    setRows(nextRows)
    updateRequestDraft(baseUrl, protocol, nextRows)
  }
  const patchRow = (rowKey: string, patch: Partial<ModelDraft>) => {
    replaceRows(rows.map(row => row.key === rowKey ? { ...row, ...patch } : row))
  }
  const addRows = (models: ProviderModelInput[]) => {
    const known = new Set(rows.map(row => row.id).filter(Boolean))
    replaceRows([...rows, ...models.filter(model => model.id === '' || !known.has(model.id)).map(draftFromModel)])
  }
  const discover = async () => {
    if (provider === undefined) return
    const started = beginProviderCheck(checkState, 'discovering')
    if (started === checkState || started.activityId === null) return
    const activityId = started.activityId
    const version = requestVersion.current
    setCheckState(started)
    try {
      const found = await api.discoverProvider(provider.id)
      if (version !== requestVersion.current) return
      if (found.length === 0) {
        setCheckState(current => finishProviderCheck(current, 'discovering', activityId, { tone: 'error', message: t('提供商没有返回任何模型', 'The provider returned no models') }))
        return
      }
      setCheckState(current => finishProviderCheck(current, 'discovering', activityId, null))
      addRows(found.map(model => ({ id: model.id, name: model.name })))
      setCheckState(current => setProviderEditorFeedback(current, { tone: 'success', message: t(`已获取 ${found.length} 个模型`, `Found ${found.length} models`) }))
    } catch (cause) {
      if (version === requestVersion.current) setCheckState(current => finishProviderCheck(current, 'discovering', activityId, { tone: 'error', message: cause instanceof Error ? cause.message : t('无法获取模型', 'Could not list models') }))
    }
  }
  const test = async () => {
    if (provider === undefined) return
    const started = beginProviderCheck(checkState, 'testing')
    if (started === checkState || started.activityId === null) return
    const activityId = started.activityId
    const version = requestVersion.current
    setCheckState(started)
    try {
      const result = await api.testProvider(provider.id)
      if (version !== requestVersion.current) return
      const feedback = result.status === 'connected'
        ? { tone: 'success' as const, message: t('连接成功', 'Connection successful') }
        : { tone: 'error' as const, message: result.message ?? t('连接失败', 'Connection failed') }
      setCheckState(current => finishProviderCheck(current, 'testing', activityId, feedback))
    } catch (cause) {
      if (version === requestVersion.current) setCheckState(current => finishProviderCheck(current, 'testing', activityId, { tone: 'error', message: cause instanceof Error ? cause.message : t('连接失败', 'Connection failed') }))
    }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    clearCheckFeedback()
    const trimmedId = id.trim()
    const displayName = name.trim() || trimmedId
    if (!PROVIDER_ID_PATTERN.test(trimmedId)) {
      showFormError(t('Provider ID 无效：需以字母或数字开头，之后可用字母、数字、点、下划线和短横线。', 'Invalid provider ID: start with a letter or digit, then use letters, digits, dots, underscores, or dashes.')); return
    }
    if (create && catalog?.providers.some(item => item.id === trimmedId)) {
      showFormError(t('已有提供商使用了这个 ID。', 'A provider already uses this ID.')); return
    }
    const normalizedBaseUrl = baseUrl.trim()
    if (create && normalizedBaseUrl === '') {
      showFormError(t('自定义模型 API 需要填写 API 地址。', 'A custom model API needs a base URL.')); return
    }
    if (normalizedBaseUrl !== '' && !isHttpUrl(normalizedBaseUrl)) {
      showFormError(t('请输入有效的 HTTP 或 HTTPS 地址。', 'Enter a valid HTTP or HTTPS URL.')); return
    }
    const drafts = rows.filter(row => row.id.trim() !== '')
    const ids = drafts.map(row => row.id.trim())
    if (new Set(ids).size !== ids.length) {
      showFormError(t('模型 ID 不能重复。', 'Each model ID may appear once.')); return
    }
    if (displayName === '' || drafts.length === 0) {
      showFormError(t('请填写提供商名称和至少一个模型。', 'Enter a provider name and at least one model.')); return
    }
    const models: ProviderModelInput[] = []
    for (const row of drafts) {
      const contextWindow = parseCapacity(row.contextWindow)
      if (row.contextWindow.trim() !== '' && contextWindow === undefined) {
        showFormError(t('上下文窗口必须是正数，例如 131072、256K 或 1M。', 'Context window must be positive, e.g. 131072, 256K or 1M.')); return
      }
      const maxTokens = parseCapacity(row.maxTokens)
      if (row.maxTokens.trim() !== '' && maxTokens === undefined) {
        showFormError(t('最大输出 token 数必须是正数，例如 8192、64K 或 1M。', 'Max output tokens must be positive, e.g. 8192, 64K or 1M.')); return
      }
      const modelId = row.id.trim()
      const listed = catalog?.models.find(model => model.provider === trimmedId && model.modelId === modelId)
      const carried: Record<string, unknown> = { ...(row.base ?? { reasoning: listed?.reasoning, contextWindow: listed?.contextWindow }) }
      // The switch owns the map: off removes it, on writes the pinned one.
      const hadLevels = carried.thinkingLevelMap !== undefined
      delete carried.thinkingLevelMap
      models.push({
        ...carried,
        id: modelId,
        name: row.name.trim() || modelId,
        input: [...row.input],
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(row.levels === undefined
          ? hadLevels ? { reasoning: false } : {}
          : { reasoning: true, thinkingLevelMap: pinReasoningLevels(row.levels) }),
      })
    }
    setPending(true)
    try {
      await onSave({
        id: trimmedId, name: displayName, baseUrl: normalizedBaseUrl, api: protocol, models,
        ...(key ? { apiKey: key } : {}),
        ...(config?.headers ? { headers: config.headers } : {}),
        ...(config?.compat ? { compat: config.compat } : {}),
      })
      setKey(''); setRevealed(false); requestVersion.current += 1
      if (!create) {
        const savedRows = models.map(draftFromModel)
        setBaseUrl(normalizedBaseUrl); setRows(savedRows)
        setCheckState(current => markProviderEditorSaved(current, makeRequestDraft(normalizedBaseUrl, protocol, savedRows)))
      }
      if (onSaved !== undefined) onSaved(displayName)
      else if (!create) applyConfig(await api.getProvider(trimmedId))
    } catch (cause) {
      setCheckState(current => setProviderEditorFeedback(current, { tone: 'error', message: cause instanceof Error ? cause.message : t('保存失败', 'Could not save provider') }))
    } finally { setPending(false) }
  }
  // The editor offers every level the API accepts, not just the model's
  // current directory: a deleted level must be addable again.
  const availableLevels = catalog?.thinkingLevels ?? [...INITIAL_LEVELS]
  const envVars = create ? [] : provider?.envVars ?? []
  const envConfigured = create ? [] : provider?.envConfigured ?? []
  const savedCredential = !create && provider?.storedCredential === true
  const keyHint = envVars[0]
  const credentialHint = key !== '' || savedCredential || keyHint === undefined
    ? undefined
    : envConfigured.length > 0
      ? t(`已检测到环境变量（${envConfigured[0]}）`, `Env var detected. (${envConfigured[0]})`)
      : t(`未检测到环境变量。请填写 API 密钥，或设置环境变量 ${keyHint}。`, `Env var not detected. Enter an API key, or configure ${keyHint} in your env.`)
  const keyHelp = envVars.length === 0
    ? undefined
    : t(`优先使用已保存的凭据；环境后备按以下顺序：${envVars.join(' / ')}。`, `Saved credentials are used first. Environment fallbacks, in order: ${envVars.join(' / ')}.`)
  const keyPlaceholder = savedCredential
    ? t('留空使用已保存凭据', 'Leave blank to use the saved credential')
    : keyHint !== undefined
      ? t(`留空使用环境认证（${keyHint}）`, `Leave blank to use env as auth (${keyHint})`)
      : t('输入 API 密钥', 'Enter an API key')
  const providerId = provider?.id ?? id
  const requestDirty = provider !== undefined && !loading && isProviderEditorDirty(checkState)
  const checksAvailable = provider !== undefined && canCheckSavedProviderRequest(checkState)
  const customized = config?.source === 'project'
  const defaults = config?.defaults
  return <div className={css.editor}>
    {hideTitle ? null : <div className={css.editorHeader}>
      <span className={css.editorTitle}>{create ? t('自定义模型 API', 'Custom model API') : name || t('新提供商', 'New provider')}</span>
      {!create && provider !== undefined && provider.id !== provider.name && <span className={css.editorRoute}>{provider.id}</span>}
    </div>}
    {loading ? <p className={css.advancedHint} role="status">{t('正在读取配置…', 'Loading configuration…')}</p> : <form className={css.editorForm} onSubmit={event => void save(event)}>
      {create && <>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Provider ID', 'Provider ID')}</span>
          <Input value={id} placeholder="acme-gateway" aria-label={t('Provider ID', 'Provider ID')} disabled={disabled}
            onChange={event => setId(event.currentTarget.value)} />
          {id !== '' && !PROVIDER_ID_PATTERN.test(id.trim())
            ? <span className={css.fieldError}>{t('需以字母或数字开头，之后可用字母、数字、点、下划线和短横线。', 'Start with a letter or digit, then use letters, digits, dots, underscores, or dashes.')}</span>
            : <span className={css.advancedHint}>{t('在请求中唯一标识该提供商，并用于派生凭据名。', 'Uniquely names this provider in requests and as its credential name.')}</span>}
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('显示名称', 'Display name')}</span>
          <Input value={name} placeholder={id || t('显示名称', 'Display name')} aria-label={t('显示名称', 'Display name')} disabled={disabled}
            onChange={event => { setName(event.currentTarget.value); clearCheckFeedback() }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('API 地址', 'Base URL')}</span>
          <Input value={baseUrl} aria-label={t('API 地址', 'Base URL')} disabled={disabled}
            placeholder={protocol === 'anthropic-messages' ? 'https://gateway.example' : 'https://gateway.example/v1'}
            onChange={event => { const value = event.currentTarget.value; setBaseUrl(value); updateRequestDraft(value, protocol, rows) }} />
          {baseUrl !== '' && !isHttpUrl(baseUrl.trim()) && <span className={css.fieldError}>{t('请输入有效的 HTTP 或 HTTPS 地址。', 'Enter a valid HTTP or HTTPS URL.')}</span>}
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('接口协议', 'API protocol')}</span>
          <select className={css.selectInput} value={protocol} aria-label={t('接口协议', 'API protocol')} disabled={disabled}
            onChange={event => { const value = event.currentTarget.value; setProtocol(value); updateRequestDraft(baseUrl, value, rows) }}>
            {API_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
      </>}
      <div className={css.field}>
        <span className={css.fieldLabel}>
          {t('API 密钥', 'API key')}
          {keyHelp !== undefined && <Tooltip label={keyHelp} side="right" delayMs={0} focusDelayMs={0} portal openOnClick>
            <button type="button" className={css.helpButton} aria-label={t('认证说明', 'Authentication details')}>?</button>
          </Tooltip>}
        </span>
        <div className={css.keyInput}>
          <Input type={revealed ? 'text' : 'password'} autoComplete="new-password" value={key} disabled={disabled}
            aria-label={t(`API 密钥 ${providerId}`, `API key ${providerId}`)} placeholder={keyPlaceholder}
            onChange={event => { const value = event.currentTarget.value; setRevealed(false); setKey(value); updateRequestDraft(baseUrl, protocol, rows, value !== '') }} />
          {key !== '' && <button type="button" className={css.keyToggle} aria-pressed={revealed} disabled={disabled}
            aria-label={revealed ? t('隐藏密钥', 'Hide key') : t('显示密钥', 'Show key')}
            onClick={() => setRevealed(value => !value)}><IconChevronDownOutlineRegular size={14} /></button>}
        </div>
        {credentialHint !== undefined && <p className={css.credentialHint} data-tone={envConfigured.length > 0 ? 'success' : 'warning'} role="status">{credentialHint}</p>}
      </div>
      {create ? <ModelDirectory catalog={catalog} config={config} customized={customized} defaults={defaults}
        rows={rows} disabled={disabled} discovering={discovering} canDiscover={false}
        onRows={replaceRows} onPatch={patchRow} onAdd={addRows} onDiscover={() => void discover()}
        checksDisabled={requestDirty} onRestore={() => { if (defaults !== undefined) replaceRows(defaults.map(draftFromModel)) }}
        availableLevels={availableLevels} t={t} /> : <details className={css.customized}>
        <summary className={css.customizedSummary}>{t('自定义设置', 'Customized settings')}</summary>
        <div className={css.customizedBody}>
          {provider?.custom === true && <>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('显示名称', 'Display name')}</span>
              <Input value={name} aria-label={t('显示名称', 'Display name')} disabled={disabled}
                onChange={event => { setName(event.currentTarget.value); clearCheckFeedback() }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('接口协议', 'API protocol')}</span>
              <select className={css.selectInput} value={protocol} aria-label={t('接口协议', 'API protocol')} disabled={disabled}
                onChange={event => { const value = event.currentTarget.value; setProtocol(value); updateRequestDraft(baseUrl, value, rows) }}>
                {API_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          </>}
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('API 地址', 'Base URL')}</span>
            <Input value={baseUrl} aria-label={t('API 地址', 'Base URL')} disabled={disabled}
              placeholder={config?.baseUrl ?? t('没有默认地址', 'No default address')}
              onChange={event => { const value = event.currentTarget.value; setBaseUrl(value); updateRequestDraft(value, protocol, rows) }} />
            {baseUrl !== '' && !isHttpUrl(baseUrl.trim()) && <span className={css.fieldError}>{t('请输入有效的 HTTP 或 HTTPS 地址。', 'Enter a valid HTTP or HTTPS URL.')}</span>}
          </label>
          <ModelDirectory catalog={catalog} config={config} customized={customized} defaults={defaults}
            rows={rows} disabled={disabled} discovering={discovering} canDiscover={provider !== undefined}
            onRows={replaceRows} onPatch={patchRow} onAdd={addRows} onDiscover={() => void discover()}
            checksDisabled={requestDirty} onRestore={() => { if (defaults !== undefined) replaceRows(defaults.map(draftFromModel)) }}
            availableLevels={availableLevels} t={t} />
        </div>
      </details>}
      {checkState.feedback !== null && <p className={checkState.feedback.tone === 'error' ? css.error : css.success}
        role={checkState.feedback.tone === 'error' ? 'alert' : 'status'}>{checkState.feedback.message}</p>}
      {requestDirty && <p className={css.advancedHint} role="note">{t('保存更改后测试连接或获取模型。', 'Save changes before testing the connection or fetching models.')}</p>}
      <div className={css.editorActions}>
        {!create && provider !== undefined && <Button type="button" size="sm" variant="ghost" disabled={disabled || !checksAvailable}
          onClick={() => void test()}>{testing ? t('检测中…', 'Testing…') : t('测试连接', 'Test connection')}</Button>}
        <span className={css.actionSpacer} />
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onCancel}>{t('取消', 'Cancel')}</Button>
        <Button type="submit" size="sm" variant="primary" disabled={disabled}>{pending ? t('保存中…', 'Saving…') : t('保存', 'Save')}</Button>
      </div>
    </form>}
  </div>
}

/** The shared model catalog editor used by both provider families. */
function ModelDirectory({ catalog, config, customized, defaults, rows, disabled, discovering, canDiscover, checksDisabled, onRows, onPatch, onAdd, onDiscover, onRestore, availableLevels, t }: {
  catalog: ModelCatalog | null
  config: ProviderConfigSummary | null
  customized: boolean
  defaults?: ProviderModelInput[]
  rows: ModelDraft[]
  disabled: boolean
  discovering: boolean
  canDiscover: boolean
  checksDisabled: boolean
  onRows: (rows: ModelDraft[]) => void
  onPatch: (key: string, patch: Partial<ModelDraft>) => void
  onAdd: (models: ProviderModelInput[]) => void
  onDiscover: () => void
  onRestore: () => void
  availableLevels: readonly string[]
  t: (chinese: string, english: string) => string
}) {
  return <section className={css.modelDirectory} aria-label={t('模型目录', 'Model directory')}>
    <div className={css.modelListHead}>
      <div className={css.directoryHeading}>
        <span className={css.directoryHeader}>{t('模型目录', 'Model directory')}</span>
        {config !== null && <span className={css.directoryMeta}>{customized ? t('已自定义模型目录', 'Custom model directory') : t('正在使用适配器默认模型', "Using the adapter's default models")}</span>}
      </div>
      <div className={css.directoryActions}>
        {customized && defaults !== undefined && <button type="button" className={css.linkButton} disabled={disabled}
          onClick={onRestore}>{t('恢复默认模型', 'Restore default models')}</button>}
        {canDiscover && <button type="button" className={css.linkButton} disabled={disabled || discovering || checksDisabled}
          onClick={onDiscover}>{discovering ? t('正在向提供商请求…', 'Asking the provider…') : t('获取可用模型', 'Fetch available models')}</button>}
      </div>
    </div>
    {rows.length === 0 && <p className={css.directoryHint}>{t('模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。', 'No models will appear in the picker; IDs outside the directory can still be sent.')}</p>}
    <div className={css.modelList}>
      {rows.map((row, index) => <div className={css.modelEntry} key={row.key}>
        <div className={css.modelRow}>
          <Input aria-label={t(`模型 ID ${index + 1}`, `Model ID ${index + 1}`)} value={row.id} placeholder={t('模型 ID', 'Model ID')} disabled={disabled}
            onChange={event => { onPatch(row.key, { id: event.currentTarget.value }) }} />
          <Input aria-label={t(`显示名称 ${index + 1}`, `Display name ${index + 1}`)} value={row.name} placeholder={t('留空时使用模型 ID', 'Uses the model ID when blank')} disabled={disabled}
            onChange={event => { onPatch(row.key, { name: event.currentTarget.value }) }} />
          <button type="button" className={css.modelIconButton} aria-expanded={row.expanded} disabled={disabled} title={t('模型选项', 'Model options')}
            aria-label={t(`模型选项 ${index + 1}`, `Model options ${index + 1}`)} onClick={() => { onPatch(row.key, { expanded: !row.expanded }) }}>
            {row.expanded ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
          </button>
          <button type="button" className={css.modelRemoveButton} disabled={disabled} title={t('删除模型', 'Delete model')}
            aria-label={t(`删除模型 ${index + 1}`, `Delete model ${index + 1}`)}
            onClick={() => onRows(rows.filter(item => item.key !== row.key))}><IconTrashOutlineRegular size={14} /></button>
        </div>
        {row.expanded && <div className={css.modelAdvanced}>
          <label className={css.modelField}><span className={css.fieldLabel}>{t('上下文窗口', 'Context window')}</span>
            <Input inputMode="numeric" value={row.contextWindow} disabled={disabled} aria-label={t(`上下文窗口 ${index + 1}`, `Context window ${index + 1}`)}
              placeholder={row.base?.contextWindow === undefined ? t('使用提供商默认值', "Provider's default") : formatCapacity(row.base.contextWindow)}
              onChange={event => { onPatch(row.key, { contextWindow: event.currentTarget.value }) }} /></label>
          <label className={css.modelField}><span className={css.fieldLabel}>{t('最大输出 token 数', 'Max output tokens')}</span>
            <Input inputMode="numeric" value={row.maxTokens} disabled={disabled} aria-label={t(`最大输出 token 数 ${index + 1}`, `Max output tokens ${index + 1}`)}
              placeholder={row.base?.maxTokens === undefined ? t('使用提供商默认值', "Provider's default") : formatCapacity(row.base.maxTokens)}
              onChange={event => { onPatch(row.key, { maxTokens: event.currentTarget.value }) }} /></label>
          <fieldset className={css.modelInputTypes} aria-label={t(`输入类型 ${index + 1}`, `Input types ${index + 1}`)}>
            <legend className={css.fieldLabel}>{t('输入类型', 'Input types')}</legend>
            <div className={css.modelInputChoices}>
              {(['text', 'image'] as const).map(modality => <Checkbox key={modality} label={modality === 'text' ? t('文本', 'Text') : t('图片', 'Image')}
                checked={row.input.includes(modality)} disabled={disabled || row.input.length === 1 && row.input.includes(modality)}
                onChange={checked => { onPatch(row.key, { input: (['text', 'image'] as const).filter(value => value === modality ? checked : row.input.includes(value)) }) }} />)}
            </div>
          </fieldset>
          <ReasoningLevels row={row} available={availableLevels} position={index + 1} disabled={disabled}
            onChange={patch => { onPatch(row.key, patch) }} t={t} />
        </div>}
      </div>)}
    </div>
    <Button type="button" size="sm" variant="outline" className={css.addModelButton} disabled={disabled}
      onClick={() => onAdd([{ id: '', name: '' }])}>{t('添加模型', 'Add model')}</Button>
  </section>
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
