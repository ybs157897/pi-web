/** 文档验证门共用的 Markdown 解析与遍历辅助函数。 */

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes, Root } from 'mdast'

/** 把 GitHub 风味（GFM）Markdown 源文本解析为 mdast 语法树。 */
export function parseMarkdown(source: string): Root {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

/**
 * 功能：深度优先遍历 Markdown 树；访问回调返回 false 时剪枝，跳过该节点的子树。
 * @param node 当前访问的树节点。
 * @param visitor 在每个节点（其子节点之前）调用的回调；返回 false 表示剪枝。
 * @returns 无返回值。
 * 内部逻辑：先访问当前节点，再按 children 数组逐个递归；无 children 属性的叶子节点直接结束。
 */
export function visitMarkdown(node: Nodes, visitor: (node: Nodes) => boolean | void): void {
  if (visitor(node) === false) return
  if ('children' in node) {
    for (const child of node.children) visitMarkdown(child, visitor)
  }
}

/** 一个代码块的物理行范围与完整 info 字符串。 */
export interface MarkdownFence {
  /** 块首行的 1-based 源码行号（围栏块时即开头 ``` 所在行）。 */
  start: number
  /** 块末行的 1-based 源码行号（围栏闭合时即结尾 ``` 所在行）。 */
  end: number
  /** 完整 info 字符串（如 `ts` 或 `md ignore-check`）；裸代码块或缩进块为 ''。 */
  info: string
}

/**
 * 功能：按文档顺序抽取每个代码块的物理行范围与 info 字符串。
 * @param source 要扫描的 Markdown 源文本。
 * @returns 数组，每项含块的起始行、结束行与完整 info 字符串。
 * 内部逻辑：基于 AST 的 code 节点；lang 为 null（裸/缩进块）时 info 取 ''，有 meta 时拼成 `lang meta`。
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
