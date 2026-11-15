/**
 * Markdown 相对链接门：校验相对链接、图片与定义（definition）的目标都能解析到真实存在的文件
 * （「引用代码用 Markdown 相对链接」，规则归属 docs/AGENTS.md）。跳过项：带协议前缀的 URL
 * （https:、mailto: 等）、协议相对（//host）与根绝对（/path）目标、纯页内锚点、快照模板占位符
 * （<ROOT>、<PLATFORM>、<DATE>、<TZ> 等）；`target#anchor` 形式只探测路径部分——锚点由渲染器
 * 负责，不做判断。docs/history/ 下的冻结文档豁免其出站链接，但从其他文件链入 history 的链接
 * 仍检查。历史死链按条目豁免：`file` 条目豁免整个源文件，`file:line` 条目只豁免单条链接，
 * 以保持豁免清单最小。失败条件：存在未豁免的死链（非零退出）；豁免条目若已无对应死链也会
 * 报 stale 要求清理。本检查器从不改写文件。
 */

import assert from 'node:assert/strict'
import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')

/** 历史死链豁免清单：`file` 条目豁免整个源文件，`file:line` 条目只豁免一条链接。 */
const GRANDFATHERED: string[] = [
]

/** 快照模板占位符（<ROOT>、<PLATFORM>、<DATE>、<TZ> 等），出现在链接目标中即跳过。 */
const PLACEHOLDER = /<[A-Z][A-Z0-9_-]*>/u

/** 一条坏链：解析后指向不存在文件的相对目标。 */
interface Violation {
  file: string
  /** 链接/图片/定义节点起始行的 1-based 行号。 */
  line: number
  url: string
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

// 检查范围：仓库根的 README.md / AGENTS.md，以及 docs/ 与 .agents/notes/ 全树，
// 统一转成仓库相对路径、排除冻结的 docs/history/ 后排序。一个文件都没有说明范围发现逻辑坏了，直接断言失败。
const files = [
  ...['README.md', 'AGENTS.md'].map(name => join(root, name)).filter(path => existsSync(path)),
  ...['docs', '.agents/notes'].flatMap(dir => walkMarkdown(join(root, dir))),
]
  .map(relativePath)
  .filter(file => !file.startsWith('docs/history/'))
  .sort()
assert.ok(files.length > 0, 'verify-md-links: no Markdown files found — scope discovery is broken')

/**
 * 功能：判断目标是否属于本门不检查的范围——带协议的 URL（https:、mailto: 等）、
 * 协议相对（//host）、根绝对（/path）、纯页内锚点（#frag）。只有仓库相对目标才会被判分。
 * @param url 链接目标原文。
 * @returns true 表示跳过（外链或锚点），false 表示需要探测文件存在性。
 */
function isExternalOrAnchor(url: string): boolean {
  if (url === '' || url.startsWith('#') || url.startsWith('//') || url.startsWith('/')) return true
  // A scheme like `https:` / `mailto:` — a colon before any slash, dot, or hash.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(url)
}

/** 一个 Markdown 链接目标及其 1-based 起始行与原始源码片段。 */
interface Destination {
  url: string
  line: number
  /** 节点的原始源码切片：mdast 会剥掉尖括号包裹（如 `[x](<ROOT>)`），保留原文才能匹配占位符。 */
  raw: string
}

/** 一次解析收集全部链接、图片与定义目标，按文档顺序返回。 */
function collectDestinations(source: string): Destination[] {
  const out: Destination[] = []
  visitMarkdown(parseMarkdown(source), (node: Nodes): void => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return
    const start = node.position?.start
    const end = node.position?.end
    if (start?.offset === undefined || end?.offset === undefined) return
    out.push({ url: node.url, line: start.line, raw: source.slice(start.offset, end.offset) })
  })
  return out
}

/** 去掉链接目标中的 `#fragment` 与 `?query`，只留路径部分（锚点/查询串不参与文件存在性探测）。 */
function pathPart(url: string): string {
  return url.replace(/[?#].*$/u, '')
}

/**
 * 功能：基于 AST 找出单个 Markdown 文件里全部坏链目标。
 * @param absPath 文件绝对路径。
 * @returns 违规列表（目标解析后不存在的相对链接）。
 * 内部逻辑：先收集全部链接目标，跳过外链/锚点与占位符目标（占位符同时查 url 与原始片段，
 * 以覆盖 mdast 剥尖括号的情况）；再把相对路径按源文件所在目录解析并探测存在性。
 */
function findViolations(absPath: string): Violation[] {
  const file = relativePath(absPath)
  const source = readFileSync(absPath, 'utf8')
  const out: Violation[] = []
  for (const destination of collectDestinations(source)) {
    if (isExternalOrAnchor(destination.url)) continue
    if (PLACEHOLDER.test(destination.url) || PLACEHOLDER.test(destination.raw)) continue
    const resolved = resolve(dirname(absPath), pathPart(destination.url))
    if (!existsSync(resolved)) out.push({ file, line: destination.line, url: destination.url })
  }
  return out
}

// 判分主流程：全量收集违规 → 按整文件或 file:line 过滤豁免 → 剩余即新鲜违规；
// 同时反向检查豁免清单里已无对应死链的条目（stale）并要求人工清理，防止豁免清单无限膨胀。
const violations = files.flatMap(file => findViolations(join(root, file)))
const key = (violation: Violation) => `${violation.file}:${violation.line}`
const exempt = (violation: Violation) => GRANDFATHERED.includes(violation.file) || GRANDFATHERED.includes(key(violation))
const fresh = violations.filter(violation => !exempt(violation))
const checkedSources = files.filter(file => !GRANDFATHERED.includes(file))
const stale = GRANDFATHERED.filter(entry => !violations.some(violation => entry === violation.file || entry === key(violation)))
if (stale.length > 0) console.error(`verify-md-links: stale grandfather entries (no current dead link, remove them): ${stale.join(', ')}`)

// 结果分档：无新鲜违规 → 打印统计并以 0 退出（stale 只告警不阻断）；否则逐条打印并以 1 退出。
if (fresh.length === 0) {
  console.log(`verify-md-links: ${checkedSources.length} file(s) checked, all relative link targets exist (${files.length - checkedSources.length} file(s) grandfathered).`)
  process.exit(0)
}

console.error('verify-md-links: broken relative link targets found:')
for (const violation of fresh) {
  console.error(`  ${violation.file}:${violation.line} -> ${violation.url}`)
}
console.error(`verify-md-links: ${fresh.length} violation(s) in ${new Set(fresh.map(violation => violation.file)).size} file(s).`)
process.exit(1)
