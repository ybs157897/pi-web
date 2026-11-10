/**
 * The right-side creation panel, matching DSH's 「手动创建」 sheet: a name, the
 * instruction, where each occurrence goes, and the timing rule.
 */
import { useState } from 'react'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateAutomationInput, WorkspaceSummary } from '../shared/types.ts'
import { systemTimeZone, timingDraftValid } from '../shared/automation-timing.ts'
import { AutomationEditor, createInputOf, newDraft, type AutomationDraft } from './AutomationEditor.tsx'
import type { Translate } from './render-labels.ts'
import css from './AutomationsPage.module.css'

export function AutomationCreatePanel({ defaultWorkspaceId, workspaces, saving, t, onClose, onCreate }: {
  defaultWorkspaceId: string
  workspaces: readonly WorkspaceSummary[]
  saving: boolean
  t: Translate
  onClose: () => void
  onCreate: (input: CreateAutomationInput) => void
}) {
  const [draft, setDraft] = useState<AutomationDraft>(() => newDraft(defaultWorkspaceId, systemTimeZone()))
  const valid = draft.name.trim() !== '' && draft.name.trim().length <= 120
    && draft.prompt.trim() !== '' && timingDraftValid(draft.timing, Date.now())
  return <aside className={css.panel} aria-label={t('手动创建', 'Create manually')}>
    <header className={css.panelHead}>
      <h2>{t('手动创建', 'Create manually')}</h2>
      <Button variant="ghost" size="sm" aria-label={t('关闭创建面板', 'Close create panel')}
        icon={<IconCloseOutlineRegular size={15} />} onClick={onClose} />
    </header>
    <div className={css.panelBody}>
      <AutomationEditor draft={draft} onChange={patch => { setDraft(current => ({ ...current, ...patch })) }}
        workspaces={workspaces} disabled={saving} t={t} />
    </div>
    <footer className={css.panelFoot}>
      <Button variant="ghost" disabled={saving} onClick={onClose}>{t('放弃', 'Discard')}</Button>
      <Button variant="primary" disabled={!valid || saving}
        onClick={() => { onCreate(createInputOf(draft)) }}>{saving ? t('正在创建…', 'Creating…') : t('创建', 'Create')}</Button>
    </footer>
  </aside>
}