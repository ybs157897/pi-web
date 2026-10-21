import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { classifyCode, splitInline } from './doc-inline.ts'
import css from './DocBlock.module.css'

export type { CodeKind, InlineToken } from './doc-inline.ts'

export interface DocInlineProps {
  readonly text: string
  /** Opens a workspace file; absent when the surface has no inspector. */
  readonly onOpenFile?: ((path: string) => void) | undefined
}

/** 渲染一行块内文本；路径可点、命令可复制、其余保持普通 chip。 */
export function DocInline({ text, onOpenFile }: DocInlineProps): ReactElement {
  const [copiedIndex, setCopiedIndex] = useState<number | undefined>(undefined)
  const resetTimer = useRef<number | undefined>(undefined)
  const copy = (value: string, index: number): void => {
    void writeClipboard(value).then((ok) => {
      if (!ok) return
      setCopiedIndex(index)
      window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => { setCopiedIndex(undefined) }, 1200)
    })
  }
  const tokens = splitInline(text)
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === 'text') return token.text
        if (token.kind === 'strong') return <strong key={`strong:${index}`}>{token.text}</strong>
        if (token.kind === 'link') {
          return <a key={`link:${index}`} href={token.href} target="_blank" rel="noreferrer">{token.text}</a>
        }
        const kind = classifyCode(token.text)
        if (kind === 'path' && onOpenFile !== undefined) {
          return <button key={`path:${index}`} type="button" className={`${css.inlineCode} ${css.inlinePath}`}
            title={token.text} onClick={() => { onOpenFile(token.text) }}>{token.text}</button>
        }
        if (kind === 'command') {
          return <button key={`cmd:${index}`} type="button" className={`${css.inlineCode} ${css.inlineCommand}`}
            data-copied={copiedIndex === index || undefined} title="点击复制"
            onClick={() => { copy(token.text, index) }}>{token.text}</button>
        }
        return <code key={`code:${index}`} className={css.inlineCode}>{token.text}</code>
      })}
    </>
  )
}
