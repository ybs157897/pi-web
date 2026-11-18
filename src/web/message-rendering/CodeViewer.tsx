import { lazy, Suspense, useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { FileContents, FileOptions, SupportedLanguages } from '@pierre/diffs'
import { bundledLanguagesInfo } from 'shiki/langs'
import { useMessageTheme } from './hooks.ts'
import './theme.css'
import css from './CodeViewer.module.css'

const File = lazy(() => import('@pierre/diffs/react').then(module => ({ default: module.File })))
const languages = new Map(bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])].map(id => [id, info.id] as const)))
/**
 * 功能：把任意语言名（含别名，如 `py`、`ts`）归一到 shiki 支持的语言 id。
 * @param language fenced 代码块标注的语言名
 * @returns shiki 支持的规范化语言 id；未收录时回落 `text`（不尝试高亮）
 */
export function codeLanguage(language: string): SupportedLanguages {
  return (languages.get(language.toLowerCase()) ?? 'text') as SupportedLanguages
}
/**
 * 功能：FNV-1a 32 位内容哈希，转 36 进制短串。
 * @param text 任意文本
 * @returns 稳定的短哈希字符串，用作高亮缓存的 cacheKey 成分，让等价内容复用高亮结果
 */
export function contentHash(text: string): string {
  let value = 2166136261
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return (value >>> 0).toString(36)
}

/**
 * 功能：带语法高亮的只读代码查看器，用 @pierre/diffs 的 File 渲染（与 ZCode 同款）。
 * @param code 代码全文
 * @param language 语言名（经 codeLanguage 归一）
 * @param streaming 流式生成中：lang 固定 `text` 跳过高亮，避免边写边重解析
 * @param wrap 自动换行（false 时横向滚动）
 * @param lineNumbers 是否显示行号
 * @param className 附加样式类
 * 内部逻辑：File 组件 lazy 加载（Shiki WASM 高亮器按需拉起），加载中回落纯 <pre>；cacheKey 由主题/语言/流式/内容哈希构成；CSS 变量把 diff 渲染主题接到消息卡片主题上。
 */
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
