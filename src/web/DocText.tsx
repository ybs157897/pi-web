import { useMemo } from 'react'
import {
  MarkdownText, type MarkdownFileMentions, type MarkdownLabels, type MarkdownPathImages,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DocBlockView } from './DocBlock.tsx'
import { splitDocBlocks } from './doc-split.ts'
import docCss from './DocBody.module.css'

export interface DocTextProps {
  readonly text: string
  readonly streaming?: boolean
  /** Whether the document layout sheet applies to the Markdown around the blocks. */
  readonly layout?: boolean
  readonly labels: MarkdownLabels
  readonly fileMentions?: MarkdownFileMentions
  readonly pathImages?: MarkdownPathImages
}

/**
 * Render a conclusion body: the model's `doc` blocks become design-document cards,
 * and the rest stays Markdown under the document layout sheet.
 *
 * Each Markdown segment carries its own `docBody` wrapper so the sheet reaches the
 * library's semantic HTML without touching the doc blocks, whose own components
 * bring their own typography.
 *
 * The blocks render whether the layout is on or off: the model already wrote them
 * as structured blocks, and turning the layout off should not turn a card back
 * into a YAML dump.
 */
export function DocText({ text, streaming, layout, labels, fileMentions, pathImages }: DocTextProps) {
  const segments = useMemo(() => splitDocBlocks(text), [text])
  return (
    <>
      {segments.map((segment, index) => segment.kind === 'doc'
        ? <DocBlockView key={`doc:${index}`} source={segment.text} />
        : (
          <div className={layout === true ? docCss.docBody : undefined} data-doc-body={layout === true ? '' : undefined}
            key={`md:${index}`}>
            <MarkdownText text={segment.text} streaming={streaming === true && index === segments.length - 1}
              labels={labels} fileMentions={fileMentions} pathImages={pathImages} />
          </div>
        ))}
    </>
  )
}
