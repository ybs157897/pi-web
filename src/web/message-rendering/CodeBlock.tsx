import { memo, useState } from 'react'
import { Check, Copy, WrapText } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { MessageFileIcon } from './FileIcon.tsx'
import { CodeViewer } from './CodeViewer.tsx'
import { useCopyFeedback } from './hooks.ts'
import css from './CodeBlock.module.css'

export const MessageCodeBlock = memo(function MessageCodeBlock({ code, language = 'text', streaming = false, lineNumbers = false, t }: {
  code: string; language?: string; streaming?: boolean; lineNumbers?: boolean; t: Translate
}) {
  const [wrapped, setWrapped] = useState(false)
  const { state, copy } = useCopyFeedback()
  const label = language.trim() || 'text'
  return <section className={css.block} data-message-code-block data-language={label} aria-label={t(`${label} 代码`, `${label} code`)}>
    <div className={css.header}>
      <span className={css.title}><MessageFileIcon language={label} /><span>{label}</span></span>
      <div className={css.actions}>
        <button type="button" aria-label={t('自动换行', 'Wrap lines')} title={t('自动换行', 'Wrap lines')} aria-pressed={wrapped} onClick={() => setWrapped(value => !value)}><WrapText size={14} aria-hidden="true" /></button>
        <button type="button" aria-label={state === 'copied' ? t('已复制', 'Copied') : t('复制代码', 'Copy code')} title={t('复制代码', 'Copy code')} onClick={() => { void copy(code) }}>{state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>
      </div>
    </div>
    <div className={css.body}><CodeViewer code={code} language={label} streaming={streaming} wrap={wrapped} lineNumbers={lineNumbers} /></div>
    {state === 'error' && <div className={css.error} role="status">{t('复制失败，请检查剪贴板权限', 'Copy failed. Check clipboard permissions.')}</div>}
  </section>
})
