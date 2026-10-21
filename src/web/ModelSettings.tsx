import { useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent, KeyboardEvent, ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular,
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
  const selectedId = editing ?? configured[0]?.id
  const selected = configured.find(provider => provider.id === selectedId)
  const [editorEpoch, setEditorEpoch] = useState(0)
  return <div className={css.models}>
    <div className={css.modelsToolbar}>
      <div className={css.modelsActions}>
        {savedName !== undefined && <span className={css.savedNotice} role="status" aria-live="polite">{t(`已保存 ${savedName}。`, `Saved ${savedName}.`)}</span>}
        <Button size="sm" variant="primary" disabled={saving} onClick={openAdd}>
          <IconPlusOutlineRegular size={14} aria-hidden="true" />{t('添加供应商', 'Add provider')}
        </Button>
      </div>
    </div>
    <div className={css.modelPage}>
      <aside className={css.providerPane} aria-label={t('模型提供商', 'Model providers')}>
        <p className={css.paneGroupTitle}>{t('已配置', 'Configured')}</p>
        {configured.map(provider => {
          const active = !addOpen && provider.id === selectedId
          return <button key={provider.id} type="button" className={css.providerTile}
            aria-current={active ? 'true' : undefined}
            onClick={() => { setAddOpen(false); setSavedName(undefined); setEditing(provider.id) }}>
            <span className={css.providerLogo} aria-hidden="true">{providerInitial(provider.name)}</span>
            <span className={css.providerTileBody}>
              <span className={css.providerTileName}>{provider.name}</span>
              <span className={css.providerTileMeta}>{provider.custom ? t('自定义', 'Custom') : provider.id}</span>
            </span>
            <span className={css.credentialDot} data-configured={provider.configured ? 'true' : undefined}
              role="img" aria-label={provider.configured ? t('API 密钥已配置', 'API key configured') : t('API 密钥缺失', 'API key missing')}
              title={provider.configured ? t('API 密钥已配置', 'API key configured') : t('API 密钥缺失', 'API key missing')} />
          </button>
        })}
        {configured.length === 0 && <p className={css.paneEmpty}>{t('还没有配置提供商。', 'No providers configured yet.')}</p>}
      </aside>
      <section className={css.providerDetail} aria-label={t('提供商详情', 'Provider details')}>
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
        </div> : selected !== undefined ? <>
          <header className={css.detailHeader}>
            <span className={css.providerLogo} aria-hidden="true">{providerInitial(selected.name)}</span>
            <div className={css.detailHeading}>
              <h3>{selected.name}</h3>
              <p>{selected.id}</p>
            </div>
            <div className={css.detailActions}>
              {selected.source === 'project' && <button type="button" className={css.rowDangerButton} disabled={saving}
                aria-label={t(`删除 ${selected.name}`, `Delete ${selected.name}`)}
                onClick={() => { setDeleteFailure(''); setDeleteTarget(selected) }}>{t('删除', 'Delete')}</button>}
            </div>
          </header>
          <ProviderEditor key={`${selected.id}:${editorEpoch}`} provider={selected} catalog={catalog} saving={saving}
            hideTitle onSave={onSave} onRefresh={onRefresh}
            onCancel={() => { setEditorEpoch(value => value + 1) }}
            onSaved={name => { setSavedName(name) }} />
        </> : <div className={css.detailEmpty}>
          <p>{t('选择左侧的提供商查看并编辑配置。', 'Select a provider on the left to view and edit its configuration.')}</p>
        </div>}
      </section>
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

interface ModelDraft {
  key: string
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  input: Array<'text' | 'image'>
  /** Declared reasoning levels; undefined is how a model says it does not reason. */
  levels?: ReasoningEntry[]
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
    base: model,
  }
}

function providerInitial(name: string): string {
  const trimmed = name.trim()
  return trimmed === '' ? '?' : Array.from(trimmed)[0]!.toLocaleUpperCase()
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
        </div>
      </details>}
      {create ? null : <ModelDirectory catalog={catalog} config={config} customized={customized} defaults={defaults}
        rows={rows} disabled={disabled} discovering={discovering} canDiscover={provider !== undefined}
        onRows={replaceRows} onPatch={patchRow} onAdd={addRows} onDiscover={() => void discover()}
        checksDisabled={requestDirty} onRestore={() => { if (defaults !== undefined) replaceRows(defaults.map(draftFromModel)) }}
        availableLevels={availableLevels} t={t} />}
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
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const editingRow = rows.find(row => row.key === editingKey)
  // 弹窗里的“完成”只把草稿写回目录；整个提供商的保存仍由编辑器底部按钮负责。
  const commitDraft = (draft: ModelDraft) => {
    onPatch(draft.key, {
      id: draft.id, name: draft.name, contextWindow: draft.contextWindow, maxTokens: draft.maxTokens,
      input: [...draft.input], levels: draft.levels,
    })
    setEditingKey(null)
  }
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
          <div className={css.modelSummary}>
            <span className={css.modelSummaryValue} data-role="id" title={row.id}>{row.id || <span className={css.modelSummaryEmpty}>{t('未填写模型 ID', 'No model ID')}</span>}</span>
            <span className={css.modelSummaryName} title={row.name || row.id}>{row.name || row.id || '—'}</span>
            <span className={css.modelChips}>
              {row.contextWindow.trim() !== '' || row.base?.contextWindow !== undefined
                ? <span className={css.modelChip}>{row.contextWindow.trim() !== '' ? row.contextWindow.trim() : formatCapacity(row.base?.contextWindow)}</span>
                : null}
              {row.input.includes('image') ? <span className={css.modelChip}>{t('视觉', 'Vision')}</span> : null}
              {row.levels !== undefined ? <span className={css.modelChip}>{t('推理', 'Reasoning')}</span> : null}
            </span>
          </div>
          <button type="button" className={css.rowTextButton} disabled={disabled}
            aria-label={t(`编辑模型 ${index + 1}`, `Edit model ${index + 1}`)}
            onClick={() => { setEditingKey(row.key) }}>{t('编辑', 'Edit')}</button>
          <button type="button" className={css.modelRemoveButton} disabled={disabled} title={t('删除模型', 'Delete model')}
            aria-label={t(`删除模型 ${index + 1}`, `Delete model ${index + 1}`)}
            onClick={() => onRows(rows.filter(item => item.key !== row.key))}><IconTrashOutlineRegular size={14} /></button>
        </div>
      </div>)}
    </div>
    <Button type="button" size="sm" variant="outline" className={css.addModelButton} disabled={disabled}
      onClick={() => onAdd([{ id: '', name: '' }])}>{t('添加模型', 'Add model')}</Button>
    {editingRow !== undefined && <ModelEditorModal key={editingRow.key} row={editingRow} position={rows.indexOf(editingRow) + 1}
      availableLevels={availableLevels} disabled={disabled} t={t}
      onCommit={commitDraft} onClose={() => { setEditingKey(null) }} />}
  </section>
}

/** The levels the editor starts with when the reasoning switch turns on. */
function initialReasoningLevels(available: readonly string[]): ReasoningEntry[] {
  return INITIAL_LEVELS.filter(level => available.includes(level))
    .map(level => ({ level, value: defaultLevelValue(level) }))
}

/** Move one reasoning entry; out-of-range targets leave the order untouched. */
function moveReasoningEntries(entries: readonly ReasoningEntry[], from: number, to: number): ReasoningEntry[] {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return [...entries]
  const next = [...entries]
  const [entry] = next.splice(from, 1)
  next.splice(to, 0, entry!)
  return next
}

/**
 * The next level the add button inserts: the first unused level after the
 * highest level already used, so a fresh chip lands at the end of the
 * escalation order even after the user reordered the row.
 */
function nextReasoningLevel(used: readonly string[], available: readonly string[]): string | undefined {
  const highest = Math.max(-1, ...used.map(level => available.indexOf(level)))
  return available.find((level, index) => index > highest && !used.includes(level))
    ?? available.find(level => !used.includes(level))
}

/** One grouped block inside the model dialog: heading, one-line explanation, controls. */
function ModelSettingsGroup({ group, title, description, children }: {
  group: 'basic' | 'tokens' | 'modalities' | 'capabilities' | 'reasoning'
  title: string
  description: string
  children: ReactNode
}) {
  return <section className={css.modelGroup} data-model-settings-group={group} aria-label={title}>
    <div className={css.modelGroupHead}>
      <h3 className={css.modelGroupTitle}>{title}</h3>
      <p className={css.modelGroupDescription}>{description}</p>
    </div>
    <div className={css.modelGroupBody}>{children}</div>
  </section>
}

/** A toggle rendered as a bordered option button with its own check indicator. */
function BooleanModelOption({ label, selected, disabled = false, onToggle }: {
  label: string
  selected: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return <button type="button" role="checkbox" aria-checked={selected} aria-label={label}
    className={css.booleanOption} data-selected={selected} data-model-boolean-option="true" disabled={disabled} onClick={onToggle}>
    {/* 勾选指示不可再嵌一个可聚焦控件：外层按钮已经承担完整点击与键盘语义。 */}
    <span className={css.booleanCheck} data-selected={selected} aria-hidden="true">
      {selected ? <IconCheckOutlineRegular size={11} /> : null}
    </span>
    <span>{label}</span>
  </button>
}

/**
 * The chips that order a model's reasoning levels. Each chip carries its wire
 * value underneath: clicking the level swaps it for a select of the levels
 * still free, clicking the value edits the parameter sent for that level.
 */
function ReasoningChipEditor({ entries, available, disabled, onChange, t }: {
  entries: ReasoningEntry[]
  available: readonly string[]
  disabled: boolean
  onChange: (entries: ReasoningEntry[]) => void
  t: (chinese: string, english: string) => string
}) {
  const [editingLevel, setEditingLevel] = useState<number | null>(null)
  const [levelChoice, setLevelChoice] = useState('')
  const [editingWire, setEditingWire] = useState<number | null>(null)
  const [wireText, setWireText] = useState('')
  const [dragging, setDragging] = useState<number | null>(null)
  // 拖动或 Alt+方向键后把焦点交回移动后的档位，键盘用户不会丢掉操作位置。
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const wireRef = useRef<HTMLInputElement>(null)
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => { if (editingLevel !== null) selectRef.current?.focus() }, [editingLevel])
  useEffect(() => { if (editingWire !== null) wireRef.current?.focus() }, [editingWire])
  useEffect(() => {
    if (focusIndex === null) return
    chipRefs.current[focusIndex]?.focus()
    setFocusIndex(null)
  }, [focusIndex, entries])
  const used = entries.map(entry => entry.level)
  const beginLevelEdit = (index: number) => {
    setEditingWire(null)
    setEditingLevel(index)
    setLevelChoice(entries[index]?.level ?? '')
  }
  const commitLevelEdit = () => {
    if (editingLevel === null) return
    const entry = entries[editingLevel]
    const choice = levelChoice
    setEditingLevel(null)
    if (entry === undefined || choice === '' || choice === entry.level) return
    onChange(entries.map((item, at) => at === editingLevel ? { level: choice, value: defaultLevelValue(choice) } : item))
  }
  const beginWireEdit = (index: number) => {
    setEditingLevel(null)
    setEditingWire(index)
    setWireText(entries[index]?.value ?? '')
  }
  const commitWireEdit = () => {
    if (editingWire === null) return
    const entry = entries[editingWire]
    const text = wireText.trim()
    setEditingWire(null)
    if (entry === undefined) return
    const value = text === '' ? defaultLevelValue(entry.level) : text
    if (value === entry.value) return
    onChange(entries.map((item, at) => at === editingWire ? { level: item.level, value } : item))
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length) return
    onChange(moveReasoningEntries(entries, from, to))
    setFocusIndex(to)
  }
  const handleChipKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      move(index, event.key === 'ArrowLeft' ? index - 1 : index + 1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      beginLevelEdit(index)
    }
  }
  const handleDrop = (event: DragEvent<HTMLDivElement>, target: number) => {
    event.preventDefault()
    if (dragging !== null) move(dragging, target)
    setDragging(null)
  }
  const addLevel = () => {
    const level = nextReasoningLevel(used, available)
    if (level === undefined) return
    onChange([...entries, { level, value: defaultLevelValue(level) }])
  }
  return <div className={css.levelChips} data-model-reasoning-level-editor="true">
    {entries.map((entry, index) => {
      const current = entry.level
      // 只列没被其他 chip 占用的档位；模型自带的目录外档位仍保留在选择里。
      const choices = [...(available.includes(current) ? [] : [current]),
        ...available.filter(level => level === current || !used.includes(level))]
      return <div key={`${entry.level}:${index}`} className={css.levelChip}
        data-model-reasoning-chip="true" data-dragging={dragging === index || undefined}
        draggable={!disabled && editingLevel !== index}
        onDragStart={event => {
          setDragging(index)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', String(index))
        }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
        onDrop={event => handleDrop(event, index)}
        onDragEnd={() => setDragging(null)}>
        <div className={css.levelChipHead}>
          {editingLevel === index
            ? <select ref={selectRef} className={css.levelChipSelect} value={levelChoice} disabled={disabled}
              aria-label={t('选择档位', 'Choose a level')}
              onChange={event => setLevelChoice(event.currentTarget.value)}
              onBlur={commitLevelEdit}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); commitLevelEdit() }
                else if (event.key === 'Escape') { event.preventDefault(); setEditingLevel(null) }
              }}>
              {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
            </select>
            : <button type="button" className={css.levelChipButton} disabled={disabled}
              ref={element => { chipRefs.current[index] = element }}
              aria-label={t(`${current} 档位；按 Enter 更换档位，Alt 加左右方向键调整顺序`, `${current} level; press Enter to change it, Alt plus Left or Right to reorder`)}
              onClick={() => beginLevelEdit(index)}
              onKeyDown={event => handleChipKeyDown(event, index)}>
              {current}
            </button>}
          <button type="button" className={css.levelChipRemove} disabled={disabled || entries.length <= 1}
            title={t('删除档位', 'Delete level')} aria-label={t(`删除档位 ${current}`, `Delete level ${current}`)}
            onClick={() => onChange(entries.filter((_item, at) => at !== index))}>
            <IconCloseOutlineRegular size={11} />
          </button>
        </div>
        {editingWire === index
          ? <input ref={wireRef} className={css.levelChipWireInput} value={wireText} disabled={disabled}
            aria-label={t(`${current} 的 API 参数值`, `API value for ${current}`)}
            placeholder={t('留空时使用档位名', 'Uses the level name when blank')}
            onChange={event => setWireText(event.currentTarget.value)}
            onBlur={commitWireEdit}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); commitWireEdit() }
              else if (event.key === 'Escape') { event.preventDefault(); setEditingWire(null) }
            }} />
          : <button type="button" className={css.levelChipWire} disabled={disabled || current === 'off'}
            data-model-reasoning-level-value="true"
            aria-label={t(`编辑 ${current} 的 API 参数值`, `Edit the API value for ${current}`)}
            title={current === 'off' ? t('关闭思考时不需要参数值', 'Turning thinking off sends no value') : t('点击编辑 API 参数值', 'Click to edit the API value')}
            onClick={() => beginWireEdit(index)}>
            {current === 'off' ? t('关闭思考', 'Thinking off') : entry.value ?? current}
          </button>}
      </div>
    })}
    <button type="button" className={css.levelChipAdd} data-model-reasoning-level-add="true"
      disabled={disabled || nextReasoningLevel(used, available) === undefined}
      title={t('添加档位', 'Add level')} aria-label={t('添加档位', 'Add level')} onClick={addLevel}>
      <IconPlusOutlineRegular size={12} />
    </button>
  </div>
}

/**
 * The grouped model editor behind the row's Edit button. Edits stay local
 * until Done writes them back into the directory; Cancel or a mask click
 * discards them without touching the provider form.
 */
function ModelEditorModal({ row, position, availableLevels, disabled, onCommit, onClose, t }: {
  row: ModelDraft
  position: number
  availableLevels: readonly string[]
  disabled: boolean
  onCommit: (draft: ModelDraft) => void
  onClose: () => void
  t: (chinese: string, english: string) => string
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => ({
    ...row,
    input: [...row.input],
    ...(row.levels === undefined ? {} : { levels: row.levels.map(entry => ({ ...entry })) }),
  }))
  const patch = (value: Partial<ModelDraft>) => setDraft(current => ({ ...current, ...value }))
  const title = draft.id.trim() === ''
    ? t('编辑模型 · 新模型', 'Edit model · New model')
    : t(`编辑模型 · ${draft.id.trim()}`, `Edit model · ${draft.id.trim()}`)
  const capacityPlaceholder = (inherited: number | undefined) => inherited === undefined
    ? t('使用提供商默认值', "Provider's default")
    : formatCapacity(inherited)
  const levels = draft.levels
  return <Modal open onClose={onClose} title={title} closeLabel={t('关闭', 'Close')}
    description={t('模型 ID', 'Model ID')} className={css.modelEditorModal}
    footer={<>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClose}>{t('取消', 'Cancel')}</Button>
      <Button type="button" variant="primary" size="sm" disabled={disabled} onClick={() => onCommit(draft)}>{t('完成', 'Done')}</Button>
    </>}>
    <div className={css.modelEditorBody}>
      <ModelSettingsGroup group="basic" title={t('基本信息', 'Basic')}
        description={t('模型在请求中使用的标识，以及选择器里显示的名称。', 'The identifier requests use, and the name the picker shows.')}>
        <label className={css.modelField}>
          <span className={css.fieldLabel}>{t('模型 ID', 'Model ID')}</span>
          <Input value={draft.id} placeholder={t('模型 ID', 'Model ID')} disabled={disabled}
            className={css.modelMonoInput} aria-label={t(`模型 ID ${position}`, `Model ID ${position}`)}
            data-modal-autofocus
            onChange={event => patch({ id: event.currentTarget.value })} />
        </label>
        <label className={css.modelField}>
          <span className={css.fieldLabel}>{t('显示名称', 'Display name')}</span>
          <Input value={draft.name} placeholder={t('留空时使用模型 ID', 'Uses the model ID when blank')} disabled={disabled}
            aria-label={t(`显示名称 ${position}`, `Display name ${position}`)}
            onChange={event => patch({ name: event.currentTarget.value })} />
        </label>
      </ModelSettingsGroup>
      <ModelSettingsGroup group="tokens" title={t('容量', 'Capacity')}
        description={t('留空时沿用提供商或内置目录的值。', "Blank keeps the provider's or the catalog's value.")}>
        <div className={css.modelFieldRow}>
          <label className={css.modelField}>
            <span className={css.fieldLabel}>{t('上下文窗口', 'Context window')}</span>
            <Input inputMode="numeric" value={draft.contextWindow} disabled={disabled}
              aria-label={t(`上下文窗口 ${position}`, `Context window ${position}`)}
              placeholder={capacityPlaceholder(draft.base?.contextWindow)}
              onChange={event => patch({ contextWindow: event.currentTarget.value })} />
          </label>
          <label className={css.modelField}>
            <span className={css.fieldLabel}>{t('最大输出 token 数', 'Max output tokens')}</span>
            <Input inputMode="numeric" value={draft.maxTokens} disabled={disabled}
              aria-label={t(`最大输出 token 数 ${position}`, `Max output tokens ${position}`)}
              placeholder={capacityPlaceholder(draft.base?.maxTokens)}
              onChange={event => patch({ maxTokens: event.currentTarget.value })} />
          </label>
        </div>
      </ModelSettingsGroup>
      <ModelSettingsGroup group="modalities" title={t('输入类型', 'Input types')}
        description={t('发送给该模型的请求可以携带的内容；至少保留一种。', 'What requests to this model may carry; keep at least one.')}>
        <div className={css.booleanOptions} role="group" aria-label={t(`输入类型 ${position}`, `Input types ${position}`)}>
          {(['text', 'image'] as const).map(modality => {
            const selected = draft.input.includes(modality)
            return <BooleanModelOption key={modality}
              label={modality === 'text' ? t('文本', 'Text') : t('图片', 'Image')}
              selected={selected} disabled={disabled || draft.input.length === 1 && selected}
              onToggle={() => patch({ input: (['text', 'image'] as const).filter(value => value === modality ? !selected : draft.input.includes(value)) })} />
          })}
        </div>
      </ModelSettingsGroup>
      <ModelSettingsGroup group="capabilities" title={t('能力', 'Capabilities')}
        description={t('开启推理后，可以为该模型配置思考档位。', 'Turn reasoning on to configure thinking levels for this model.')}>
        <div className={css.modelSwitchRow}>
          <span className={css.modelSwitchLabel}>{t('推理', 'Reasoning')}</span>
          <Switch checked={levels !== undefined} label={t(`推理 ${position}`, `Reasoning ${position}`)} disabled={disabled}
            onChange={on => patch({ levels: on ? initialReasoningLevels(availableLevels) : undefined })} />
        </div>
      </ModelSettingsGroup>
      {levels !== undefined && <ModelSettingsGroup group="reasoning" title={t('推理等级', 'Reasoning levels')}
        description={t('拖动或按 Alt+左右方向键调整顺序；点击档位更换它，点击下方参数值编辑请求值。', 'Drag or press Alt+Left/Right to reorder; click a level to replace it, or its value below to edit the request value.')}>
        <ReasoningChipEditor entries={levels} available={availableLevels} disabled={disabled} t={t}
          onChange={next => patch({ levels: next })} />
      </ModelSettingsGroup>}
    </div>
  </Modal>
}
