import { memo, useState } from 'react'
import { Check, Copy, WrapText } from 'lucide-react'
import type { Translate } from '../render-labels.ts'
import { MessageFileIcon } from './FileIcon.tsx'
import { CodeViewer } from './CodeViewer.tsx'
import { useCopyFeedback } from './hooks.ts'
import css from './CodeBlock.module.css'

/**
 * 消息正文里的代码块卡片：与 Markdown fenced code 渲染对应，带语言图标标题、自动换行开关与复制按钮。
 *
 * @param code 代码文本（由 Markdown 渲染管线传入）
 * @param language fenced 标注的语言名；空白时回落 `text`
 * @param streaming 流式生成中：置灰高亮（交给 CodeViewer 处理）
 * @param lineNumbers 是否显示行号
 * @param t 双语标签函数（zh/en 两参，按 UI 语言取一）
 * 内部逻辑：wrapped 是本地 UI 状态；复制反馈（已复制/失败提示）来自 useCopyFeedback；memo 包裹避免流式重渲染整棵树。
 */
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
