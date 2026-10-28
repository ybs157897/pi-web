import { useEffect, useMemo, useState } from 'react'
import { diffLines } from 'diff'
import type { BundledLanguage, ThemedToken } from 'shiki'
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../render-labels.ts'
import { languageForPath } from '@deepseek-ai/dsh-util-code-language'
import { useMessageTheme } from './hooks.ts'
import css from './ToolDiff.module.css'

type DiffLine = { kind: 'add' | 'remove' | 'context'; text: string }
export function toolDiffLines(before: string | null, after: string): DiffLine[] {
  const changes = diffLines(before ?? '', after, { timeout: 50, maxEditLength: 5000 })
    ?? [{ value: before ?? '', removed: true }, { value: after, added: true }]
  return changes.flatMap(change => {
    const lines = change.value.replace(/\n$/u, '').split('\n')
    if (change.value === '') return []
    return lines.map(text => ({ kind: change.added ? 'add' as const : change.removed ? 'remove' as const : 'context' as const, text }))
  })
}
export function ToolDiff({ diffs, t }: { diffs: readonly DiffHunk[]; t: Translate }) {
  return <div className={css.group}>{diffs.map((diff, index) => <FileDiff key={`${diff.path}:${index}`} diff={diff} t={t} />)}</div>
}
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
