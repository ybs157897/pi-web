/**
 * 右侧手动创建面板，对应 DSH 的「手动创建」抽屉：填写名称、指令提示词、
 * 每次执行的落点（工作区）以及触发时机规则。
 */
import { useState } from 'react'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateAutomationInput, WorkspaceSummary } from '../shared/types.ts'
import { systemTimeZone, timingDraftValid } from '../shared/automation-timing.ts'
import { AutomationEditor, createInputOf, newDraft, type AutomationDraft } from './AutomationEditor.tsx'
import type { Translate } from './render-labels.ts'
import css from './AutomationsPage.module.css'

/**
 * 功能：自动化任务「手动创建」右侧面板，出现在 AutomationsPage 中；
 * 内嵌 AutomationEditor 编辑草稿，底部提供「放弃/创建」操作。
 * @param props defaultWorkspaceId 新建草稿默认选中的工作区；workspaces 可选工作区列表；
 *              saving 是否正在提交创建；t 双语翻译函数；onClose 关闭面板回调；
 *              onCreate 用组装好的 CreateAutomationInput 发起创建。
 * 内部逻辑：draft 状态由 newDraft 初始化（含默认工作区与系统时区）；
 * valid 校验名称非空且 ≤120 字符、提示词非空、时机规则合法（按当前时间判断）；
 * 编辑器每次 onChange 以 patch 合并更新草稿，创建按钮仅在 valid 且非 saving 时可用。
 */
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