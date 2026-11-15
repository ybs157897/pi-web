/**
 * 文档字数预算门：按 scripts/doc-budgets.manifest.json 声明的上限逐条校验文档体量。
 * 计数单位 = 汉字数 + 非 CJK 词数（见 countUnits）。失败条件：
 * 1) manifest 条目的上限不是正整数；2) 条目指向的文件不存在；
 * 3) 非空超限——超限条目逐条报错并以非零码退出。
 * 用法：`--list` 只打印各条目计数与余量百分比（不判超限），否则执行校验。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'scripts/doc-budgets.manifest.json')

// 中文无空格分词，纯词数计数失效；计数单位 = 汉字数 + 非 CJK 词数。
const countUnits = (text: string): number => {
  const han = (text.match(/\p{Script=Han}/gu) || []).length
  const words = text.replace(/\p{Script=Han}+/gu, ' ').split(/\s+/).filter(Boolean).length
  return han + words
}

// manifest 结构：文件路径 → 字数上限正整数；`_comment` 键是注释字段，不参与校验。
type Manifest = Record<string, unknown>
const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const entries = Object.entries(manifest).filter(([key]) => key !== '_comment')

const listMode = process.argv.includes('--list')
// failures 聚合所有问题（配置非法/文件缺失/超限）一次性报出；rows 收集计数供 --list 展示。
const failures: string[] = []
const rows: Array<readonly [string, number, number]> = []

// 主校验循环：先验配置合法性，再读文件计数，非 list 模式下超限记入 failures。
for (const [path, limit] of entries) {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    failures.push(`${path}: 上限必须是正整数，当前为 ${JSON.stringify(limit)}`)
    continue
  }
  let text: string
  try {
    text = await readFile(join(root, path), 'utf8')
  } catch {
    failures.push(`${path}: manifest 条目指向的文件不存在（改名或删除须同步更新 scripts/doc-budgets.manifest.json）`)
    continue
  }
  const count = countUnits(text)
  rows.push([path, count, limit])
  if (!listMode && count > limit) {
    failures.push(`${path}: 计数 ${count} 超过上限 ${limit}（docs/AGENTS.md「字数预算」：先搬走、再压缩、最后才提额）`)
  }
}

if (listMode) {
  const width = Math.max(...rows.map(([path]) => path.length))
  for (const [path, count, limit] of rows) {
    const headroom = Math.round(((limit - count) / limit) * 100)
    console.log(`${path.padEnd(width)}  ${count}/${limit}  余量 ${headroom}%`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[doc-budgets] ${failure}`)
  process.exitCode = 1
} else if (!listMode) {
  console.log(`doc-budgets: ${rows.length} 个条目全部在预算内`)
}
