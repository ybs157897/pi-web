import { useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PersonalizationView } from '../shared/types.ts'
import { api } from './api.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './PersonalizationPanel.module.css'

/** ZCode's personalization editor: one Markdown document, saved into the app home's AGENTS.md. */
export default function PersonalizationPanel() {
  const { settings } = useUiPreferences()
  const t = (chinese: string, english: string) => settings.locale === 'en' ? english : chinese
  const [state, setState] = useState<PersonalizationView | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void api.getPersonalization().then(view => {
      if (!active) return
      setState(view)
      setDraft(view.content)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : t('读取个性化指令失败', 'Could not load personalization instructions'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [settings.locale])

  const used = useMemo(() => new TextEncoder().encode(draft).length, [draft])
  const limit = state?.limitBytes ?? 100 * 1024
  const overLimit = used > limit
  const dirty = state !== null && draft !== state.content

  const save = async () => {
    if (saving || !dirty || overLimit) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const view = await api.savePersonalization(draft)
      setState(view)
      setDraft(view.content)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('保存失败', 'Could not save'))
    } finally {
      setSaving(false)
    }
  }

  const formatKb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

  return <div className={css.panel}>
    <p className={css.description}>
      {t('添加自定义指令来个性化 Agent 的回复。指令保存在用户级 AGENTS.md 中，应用于本机所有工作区；与项目指令冲突时以项目指令为准。', 'Add custom instructions to personalize Agent responses. They live in the user-level AGENTS.md and apply to every local workspace; project instructions win on conflict.')}
    </p>
    {loading
      ? <p className={css.status} role="status">{t('正在读取个性化指令…', 'Loading personalization instructions…')}</p>
      : <>
        {state !== null && <div className={css.fileRow}><span>{t('文件', 'File')}</span><code className={css.path}>{state.filePath}</code></div>}
        <textarea
          className={css.editor}
          aria-label={t('个性化指令编辑器', 'Personalization instructions editor')}
          placeholder={t('添加自定义指令…', 'Add custom instructions…')}
          spellCheck={false}
          value={draft}
          onChange={event => { setDraft(event.currentTarget.value); setSaved(false) }}
          data-over-limit={overLimit || undefined}
        />
        <div className={css.footer}>
          <span className={css.count} data-over-limit={overLimit || undefined}>
            {formatKb(used)} / {formatKb(limit)}
          </span>
          {overLimit && <span className={css.overLimit} role="alert">{t(`内容超出 ${formatKb(limit)} 上限，请精简后再保存。`, `Content exceeds the ${formatKb(limit)} limit; trim it before saving.`)}</span>}
          {!overLimit && saved && <span className={css.saved} role="status">{t('已保存，后续请求生效', 'Saved; applies to the next request')}</span>}
          {!overLimit && !saved && dirty && <span className={css.unsaved}>{t('有未保存的修改', 'Unsaved changes')}</span>}
          <Button size="sm" disabled={saving || !dirty || overLimit} onClick={() => void save()}>
            {saving ? t('保存中…', 'Saving…') : t('保存', 'Save')}
          </Button>
        </div>
      </>}
    {error !== '' && <p className={css.error} role="alert">{error}</p>}
  </div>
}
