import { useEffect, useState } from 'react'
import type { BotRecord, ModelCatalog } from '../shared/types.ts'
import { formatModelRef, parseModelRef } from '../shared/model-ref.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './SettingsDialog.module.css'

export function BotModelSettings({ catalog }: { catalog: ModelCatalog | null }) {
  const { t } = useUiPreferences()
  const available = (catalog?.models ?? []).filter(model => model.available)
  const [bots, setBots] = useState<BotRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try { setBots((await api.getBots()).bots) }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('无法读取 Bot 列表', 'Could not load the bot roster')) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const save = async (bot: BotRecord, value: string) => {
    if (pendingId !== null) return
    const next = value === '' ? undefined : value
    if (next === bot.model) return
    setPendingId(bot.id)
    setError('')
    try {
      const { bot: updated } = await api.updateBot(bot.id, { model: next ?? '' })
      setBots(list => list.map(item => item.id === updated.id ? updated : item))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('保存 Bot 模型失败', 'Could not save the bot model'))
    } finally {
      setPendingId(null)
    }
  }

  const optionLabel = (provider: string, modelId: string, name?: string): string => {
    const shown = name ?? modelId
    return `${shown} · ${provider}`
  }

  if (loading && bots.length === 0) {
    return <p className={css.description} role="status">{t('正在读取 Bot 列表…', 'Loading the bot roster…')}</p>
  }
  if (bots.length === 0) {
    return <p className={css.description} role="status">{t('还没有 Bot。先在 Bot 团队页面创建后，再回到这里为它们选择模型。', 'There are no bots yet. Create some on the Bot team page, then come back to choose a model for each one.')}</p>
  }

  return <div className={css.general}>
    {error !== '' && <p className={css.error} role="alert">{error}</p>}
    {bots.map(bot => {
      const current = bot.model ?? ''
      const currentRef = parseModelRef(current)
      const inCatalog = currentRef !== undefined && available.some(model => model.provider === currentRef.provider && model.modelId === currentRef.modelId)
      return <div className={css.settingRow} key={bot.id}>
        <div className={css.settingLabel}>
          <span>{bot.name}</span>
          <p>{bot.module}</p>
        </div>
        <div className={css.settingControl}>
          <select
            className={css.nativeSelect}
            aria-label={t(`${bot.name} 的模型`, `Model for ${bot.name}`)}
            disabled={pendingId !== null}
            value={current}
            onChange={event => void save(bot, event.currentTarget.value)}
          >
            <option value="">{t('跟随默认模型', 'Use default model')}</option>
            {available.map(model => {
              const value = formatModelRef(model)
              return <option key={value} value={value}>{optionLabel(model.provider, model.modelId, model.name)}</option>
            })}
            {current !== '' && !inCatalog && (
              <option value={current}>{currentRef === undefined ? current : optionLabel(currentRef.provider, currentRef.modelId)}</option>
            )}
          </select>
        </div>
      </div>
    })}
  </div>
}
