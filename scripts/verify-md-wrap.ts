/**
 * 一段一行门：拒绝跨多个物理行的散文段落（「一段一行」，规则归属 docs/AGENTS.md）。
 * GFM AST 天然区分段落（含列表项与引用块内的段落）与结构节点，因此代码块、表格、
 * frontmatter 无需特判。docs/history/ 下的冻结文档不在检查范围。已知历史违规按精确的
 * `file:line` 条目豁免，保证当前绿灯的同时任何新违规仍会被咬住。失败条件：存在未豁免的
 * 硬换行段落（非零退出）；豁免条目若已无对应违规也会报 stale 要求清理。本检查器从不改写文件。
 */

import assert from 'node:assert/strict'
import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')

/** 历史违规豁免清单（精确 `file:line` 条目），当前为空——新违规一律报错。 */
const GRANDFATHERED: string[] = []

/** 一处硬换行违规：跨多个源码行的散文段落。 */
interface Violation {
  file: string
  /** 硬换行段落起始行的 1-based 行号。 */
  line: number
  text: string
}

const relativePath = (absPath: string) => relative(root, absPath).replaceAll('\\', '/')

/** 收集一个目录树下全部 Markdown 文件；目录不存在时返回空数组。 */
function walkMarkdown(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(...walkMarkdown(join(dir, entry.name)))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(join(dir, entry.name))
  }
  return out
}

// 检查范围：仓库根的 README.md / AGENTS.md 与 docs/、.agents/notes/ 全树，
// 转仓库相对路径、排除冻结的 docs/history/ 后排序；一个文件都没有即断言失败。
const files = [
  ...['README.md', 'AGENTS.md'].map(name => join(root, name)).filter(path => existsSync(path)),
  ...['docs', '.agents/notes'].flatMap(dir => walkMarkdown(join(root, dir))),
]
  .map(relativePath)
  .filter(file => !file.startsWith('docs/history/'))
  .sort()
assert.ok(files.length > 0, 'verify-md-wrap: no Markdown files found — scope discovery is broken')

/**
 * 功能：基于 AST 找出单个 Markdown 文件里全部硬换行的散文段落。
 * @param absPath 文件绝对路径。
 * @returns 违规列表（end.line > start.line 的段落）。
 * 内部逻辑：段落起始行内容（裁剪后）存入违规供报告展示；段落子节点是 phrasing 内容、
 * 不可能再嵌套段落，故回调返回 false 剪枝，避免重复访问。
 */
function findViolations(absPath: string): Violation[] {
  const file = relativePath(absPath)
  const source = readFileSync(absPath, 'utf8')
  const lines = source.split('\n')
  const out: Violation[] = []
  visitMarkdown(parseMarkdown(source), (node: Nodes): boolean | void => {
    if (node.type !== 'paragraph' || node.position === undefined) return
    const { start, end } = node.position
    if (end.line > start.line) {
      out.push({ file, line: start.line, text: (lines[start.line - 1] ?? '').trim() })
    }
    // 段落的子节点是 phrasing 内容，下层不会出现嵌套段落，直接剪枝。
    return false
  })
  return out
}

// 判分主流程：全量收集违规 → 过滤豁免条目 → 剩余即新鲜违规；反向检查已无对应违规的
// 豁免条目（stale）并要求清理，防止豁免清单膨胀。
const violations = files.flatMap(file => findViolations(join(root, file)))
const key = (violation: Violation) => `${violation.file}:${violation.line}`
const fresh = violations.filter(violation => !GRANDFATHERED.includes(key(violation)))
const stale = GRANDFATHERED.filter(entry => !violations.some(violation => key(violation) === entry))
if (stale.length > 0) console.error(`verify-md-wrap: stale grandfather entries (no current violation, remove them): ${stale.join(', ')}`)

// 结果分档：无新鲜违规 → 打印统计并以 0 退出（stale 只告警不阻断）；否则逐条打印并以 1 退出。
if (fresh.length === 0) {
  console.log(`verify-md-wrap: ${files.length} file(s) checked, no hard-wrapped prose paragraphs (${violations.length} grandfathered).`)
  process.exit(0)
}

console.error('verify-md-wrap: hard-wrapped prose paragraphs found (write one physical line per paragraph):')
for (const violation of fresh) {
  console.error(`  ${violation.file}:${violation.line}  ${violation.text.slice(0, 60)}${violation.text.length > 60 ? '…' : ''}`)
}
console.error(`verify-md-wrap: ${fresh.length} violation(s), ${violations.length - fresh.length} grandfathered.`)
process.exit(1)
