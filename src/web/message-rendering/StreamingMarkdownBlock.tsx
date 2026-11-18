import { useMemo, useState } from 'react'
import { Block, createAnimatePlugin, type BlockProps } from 'streamdown'

export const MAX_INITIAL_REVEAL_LENGTH = 600

/** Keep the reveal cursor local to its Markdown block. A new paragraph starts at offset zero. */
export function StreamingMarkdownBlock(props: BlockProps) {
  const [smallFirstFrame] = useState(() => props.content.length <= MAX_INITIAL_REVEAL_LENGTH)
  const sep = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(props.content) ? 'char' : 'word'
  // Long unbroken text should remain cheap to select and scroll through during streaming.
  const enabled = smallFirstFrame && props.content.length <= 4096
  const active = useMemo(() => enabled ? createAnimatePlugin({ sep, duration: 160, stagger: 14, easing: 'ease-out' }) : null, [enabled, sep])
  const plugins = useMemo(() => active
    ? [...(props.rehypePlugins ?? []), active.rehypePlugin]
    : props.rehypePlugins, [active, props.rehypePlugins])
  return <Block {...props} rehypePlugins={plugins} animatePlugin={active} />
}
