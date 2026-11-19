import { useState } from 'react'
import type { ConversationFailure } from '../shared/conversation-failure.ts'
import type { ModelCatalog, ModelRef } from '../shared/types.ts'
import type { WorkbenchRetryInput } from '../shared/workbench.ts'
import ConversationFailureNotice from './ConversationFailureNotice.tsx'
import { useUiPreferences } from './ui-preferences.tsx'
import { workbenchApi } from './workbench-api.ts'
import css from './AgentWorkbench.module.css'

export function WorkbenchFailureActions({ failure, workspaceId, target, catalog, onOpenModels, reload }: {
  failure: ConversationFailure
  workspaceId: string
  target: WorkbenchRetryInput
  catalog?: ModelCatalog | null
  onOpenModels?: () => void
  reload: () => void
}) {
  const { t } = useUiPreferences()
  const [model, setModel] = useState<ModelRef>()
  const available = catalog?.models.filter(item => item.available) ?? []
  const token = (value: ModelRef) => JSON.stringify([value.provider, value.modelId])
  async function retry() {
    try {
      await workbenchApi.retry(workspaceId, { ...target, ...(model ? { model } : {}) })
    } finally { reload() }
  }
  return <div className={css.failureActions}>
    {failure.code.startsWith('MODEL_') && available.length > 0 && <label>{t('继续使用的模型', 'Model for this retry')}
      <select value={model ? token(model) : ''} onChange={e => {
        const chosen = available.find(option => token(option) === e.currentTarget.value)
        setModel(chosen && { provider: chosen.provider, modelId: chosen.modelId })
      }}>
        <option value="">{t('原模型', 'Original model')}</option>
        {available.map(option => <option key={token(option)} value={token(option)}>{option.name} · {option.provider}</option>)}
      </select>
    </label>}
    <ConversationFailureNotice failure={failure} onRetry={retry} onModelSettings={onOpenModels} />
  </div>
}
