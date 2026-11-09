/** Shared Markdown parsing and traversal helpers for the documentation gates. */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes, Root } from 'mdast'

/** Parse GitHub-flavored Markdown into an mdast tree. */
export function parseMarkdown(source: string): Root {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/**
 * Visit a Markdown tree depth-first; returning false prunes a node's children.
 * @param node - current tree node.
 * @param visitor - callback invoked before each node's children.
 */
export function visitMarkdown(node: Nodes, visitor: (node: Nodes) => boolean | void): void {
  if (visitor(node) === false) return
  if ('children' in node) {
    for (const child of node.children) visitMarkdown(child, visitor)
  }
}

/** One code block's physical line range and full info string. */
export interface MarkdownFence {
  /** 1-based source line of the block's first line (the opening fence when fenced). */
  start: number
  /** 1-based source line of the block's last line (the closing fence when closed). */
  end: number
  /** Full info string (e.g. `ts` or `md ignore-check`); '' on a bare or indented block. */
  info: string
}

/**
 * Extract every code block with its physical line range and info string, in document order.
 * @param source - Markdown source to scan.
 * @returns each block's opening line, closing line, and full info string.
 */
export function markdownFences(source: string): MarkdownFence[] {
  const fences: MarkdownFence[] = []
  visitMarkdown(parseMarkdown(source), (node) => {
    if (node.type !== 'code' || node.position === undefined) return
    const lang = node.lang ?? null
    const meta = node.meta ?? ''
    fences.push({
      start: node.position.start.line,
      end: node.position.end.line,
      info: lang === null ? '' : meta === '' ? lang : `${lang} ${meta}`,
    })
  })
  return fences
}
