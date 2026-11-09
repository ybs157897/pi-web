/**
 * 文档门聚合器：顺序执行全部 doc 验证门，任一非零即整体失败。
 * 规则与预算见 docs/AGENTS.md；单个门的语义以各自脚本为准。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// [脚本名, 参数]；生成目录的 --check 门最重（boot demo runtime），放在最后。
const gates: Array<readonly [string, readonly string[]]> = [
  ['verify-md-wrap', []],
  ['verify-md-links', []],
  ['verify-doc-budgets', []],
  ['verify-agent-note-format', []],
  ['gen-tool-catalog', ['--check']],
  ['gen-section-catalog', ['--check']],
]

let failed = 0
for (const [name, args] of gates) {
  const started = performance.now()
  const result = spawnSync('npx', ['tsx', `scripts/${name}.ts`, ...args], {
    cwd: root,
    stdio: 'inherit',
  })
  const elapsed = ((performance.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    failed += 1
    console.error(`[doc-sync] ${name} 失败（${elapsed}s）`)
  } else {
    console.log(`[doc-sync] ${name} 通过（${elapsed}s）`)
  }
}

if (failed > 0) {
  console.error(`[doc-sync] ${failed}/${gates.length} 个门失败`)
  process.exitCode = 1
} else {
  console.log(`[doc-sync] ${gates.length} 个门全部通过`)
}
