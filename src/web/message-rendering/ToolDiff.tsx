import { useEffect, useMemo, useState } from 'react'
import { diffLines } from 'diff'
import type { BundledLanguage, ThemedToken } from 'shiki'
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../render-labels.ts'
import { languageForPath } from '@deepseek-ai/dsh-util-code-language'
import { useMessageTheme } from './hooks.ts'
import css from './ToolDiff.module.css'

type DiffLine = { kind: 'add' | 'remove' | 'context'; text: string }
/**
 * 功能：把文件改动前后文本变成逐行 diff 序列（add/remove/context 三种行）。
 * @param before 改动前全文；null（新文件）按空串处理
 * @param after 改动后全文
 * @returns 行对象数组；diff 超时或编辑长度超限时 diffLines 返回 null，此时整体退化为「整段删除 + 整段新增」
 * 内部逻辑：jsdiff 的 diffLines（timeout 50ms、maxEditLength 5000），结果按行切分并抹掉行尾换行。
 */
export function toolDiffLines(before: string | null, after: string): DiffLine[] {
  const changes = diffLines(before ?? '', after, { timeout: 50, maxEditLength: 5000 })
    ?? [{ value: before ?? '', removed: true }, { value: after, added: true }]
  return changes.flatMap(change => {
    const lines = change.value.replace(/\n$/u, '').split('\n')
    if (change.value === '') return []
    return lines.map(text => ({ kind: change.added ? 'add' as const : change.removed ? 'remove' as const : 'context' as const, text }))
  })
}
/**
 * 功能：工具改动（write/edit）的多文件 diff 列表，对应 host DTO 中工具行的 diffs 载荷。
 * @param diffs 各文件的 diff hunk（path + oldText/newText）
 * @param t 双语标签函数
 */
export function ToolDiff({ diffs, t }: { diffs: readonly DiffHunk[]; t: Translate }) {
  return <div className={css.group}>{diffs.map((diff, index) => <FileDiff key={`${diff.path}:${index}`} diff={diff} t={t} />)}</div>
}
/**
 * 功能：单个文件的 diff 渲染：行前缀 +/−/空格，异步做 shiki 语法着色（token 覆盖纯文本）。
 * @param diff 单文件 hunk
 * @param t 双语标签函数
 * 内部逻辑：code 超 120k 字符直接放弃高亮；语言由路径推断，不在 shiki 内置表则按 text；高亮结果以「code+主题」为一致性校验，内容或主题变了就先用纯文本兜底，避免错位着色；卸载时置 active 防止过期 setState。
 */
function FileDiff({ diff, t }: { diff: DiffHunk; t: Translate }) {
  const { codeTheme, settings } = useMessageTheme()
  const lines = useMemo(() => toolDiffLines(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const code = useMemo(() => lines.map(line => line.text).join('\n'), [lines])
  const [highlight, setHighlight] = useState<{ code: string; theme: string; tokens: ThemedToken[][] }>()
  useEffect(() => {
    if (code.length > 120_000) return
    let active = true
    void import('shiki').then(async shiki => {
      const language = languageForPath(diff.path)
      const lang = language && language in shiki.bundledLanguages ? language as BundledLanguage : 'text'
      const result = await shiki.codeToTokens(code, { lang, theme: codeTheme })
      if (active) setHighlight({ code, theme: codeTheme, tokens: result.tokens })
    }).catch(() => {})
    return () => { active = false }
  }, [code, codeTheme, diff.path])
  const tokens = highlight?.code === code && highlight.theme === codeTheme ? highlight.tokens : undefined
  return <div className={css.diff} role="region" tabIndex={0} aria-label={t(`文件差异：${diff.path}`, `File diff: ${diff.path}`)} data-message-diff style={{ fontSize: settings.codeFontSize }}>
    {lines.map((line, index) => <div key={index} className={css.line} data-kind={line.kind}><span className={css.marker} aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><code>{tokens?.[index]?.map((token, i) => <span key={i} style={{ color: token.color }}>{token.content}</span>) ?? (line.text || ' ')}</code></div>)}
  </div>
}
