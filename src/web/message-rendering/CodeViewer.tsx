import { lazy, Suspense, useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { FileContents, FileOptions, SupportedLanguages } from '@pierre/diffs'
import { bundledLanguagesInfo } from 'shiki/langs'
import { useMessageTheme } from './hooks.ts'
import './theme.css'
import css from './CodeViewer.module.css'

const File = lazy(() => import('@pierre/diffs/react').then(module => ({ default: module.File })))
const languages = new Map(bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])].map(id => [id, info.id] as const)))
export function codeLanguage(language: string): SupportedLanguages {
  return (languages.get(language.toLowerCase()) ?? 'text') as SupportedLanguages
}
export function contentHash(text: string): string {
  let value = 2166136261
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return (value >>> 0).toString(36)
}

/** Same File renderer and WASM highlighter as ZCode; Shadow DOM isolates token styles. */
export function CodeViewer({ code, language = 'text', streaming = false, wrap = false, lineNumbers = false, className = '' }: {
  code: string; language?: string; streaming?: boolean; wrap?: boolean; lineNumbers?: boolean; className?: string
}) {
  const { codeTheme, dark, settings } = useMessageTheme()
  const file = useMemo<FileContents>(() => ({
    name: `preview.${language || 'txt'}`, contents: code,
    lang: streaming ? 'text' : codeLanguage(language),
    cacheKey: `${codeTheme}:${language}:${streaming}:${contentHash(code)}:${code.length}`,
  }), [code, language, streaming, codeTheme])
  const options = useMemo<FileOptions<undefined>>(() => ({
    disableFileHeader: true, disableLineNumbers: !lineNumbers, overflow: wrap ? 'wrap' : 'scroll',
    theme: codeTheme, preferredHighlighter: 'shiki-wasm', lineHoverHighlight: 'disabled',
    enableLineSelection: false, enableGutterUtility: false,
  }), [codeTheme, lineNumbers, wrap])
  const style = {
    colorScheme: dark ? 'dark' : 'light',
    '--diffs-bg': 'var(--message-card)', '--diffs-light-bg': 'var(--message-card)', '--diffs-dark-bg': 'var(--message-card)',
    '--diffs-font-family': 'var(--message-mono)', '--diffs-font-size': `${settings.codeFontSize}px`, '--diffs-gap-block': '0px',
  } as CSSProperties
  return <div className={`${css.viewer} ${className}`} data-message-code-viewer data-language={language} data-wrap={wrap} data-highlighted={!streaming} style={style}>
    <Suspense fallback={<pre className={css.fallback} data-wrap={wrap}>{code}</pre>}><File file={file} options={options} style={style} /></Suspense>
  </div>
}
