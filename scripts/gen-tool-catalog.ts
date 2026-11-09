/**
 * Generate `docs/tool-catalog.md` — the exhaustive builtin-tool catalog — from a real runtime.
 *
 * The catalog is not hand-copied from source: the script boots the demo runtime with the same
 * wiring as `tests/prompt-snapshot.test.ts` (mkdtemp dataDir/workspace, `observeDemoRequests`),
 * drives one probe per agent variant, and records the exact tool list the provider request
 * carries. MCP dynamic tools and plugin-provided tools are out of scope.
 *
 * Usage:
 *   npx tsx scripts/gen-tool-catalog.ts           regenerate docs/tool-catalog.md
 *   npx tsx scripts/gen-tool-catalog.ts --check   freshness gate: byte-compare with the disk copy
 *
 * Completeness guards (run before write/check; each failure blocks the run):
 *   1. source → runtime: every tool `name: '…'` literal and `*_TOOL*` constant found under the
 *      `src/server/tools` tree must appear in the union of all variants — a name that never
 *      reaches a provider request is either not booted or missing from this catalog's variants;
 *   2. runtime → mapping: every union tool must have a `TOOL_SOURCES` entry;
 *   3. mapping → runtime: every non-vendor `TOOL_SOURCES` entry must appear in the union, and
 *      its source path must exist (dead or mistyped mappings fail).
 */
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime/index.ts'
import { observeDemoRequests } from '../src/server/model/demo.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'
import type { Runtime } from '../src/server/contracts.ts'

const repoRoot = join(fileURLToPath(new URL('../', import.meta.url)))
const docPath = join(repoRoot, 'docs', 'tool-catalog.md')
const scanRoot = join(repoRoot, 'src', 'server', 'tools')

const VARIANTS = ['default', 'plan', 'readonly', 'subagent-general', 'subagent-explore'] as const
type Variant = (typeof VARIANTS)[number]

/** Where each catalog tool is defined. Vendor tools carry `(vendor)` instead of a repo path. */
const VENDOR_SOURCE = '(vendor)'
const TOOL_SOURCES: Record<string, string> = {
  read: 'src/server/tools/shell/tools.ts',
  write: 'src/server/tools/shell/tools.ts',
  edit: 'src/server/tools/shell/tools.ts',
  bash: 'src/server/tools/shell/tools.ts',
  list_files: 'src/server/tools/research.ts',
  search_files: 'src/server/tools/research.ts',
  glob: 'src/server/tools/research.ts',
  grep: 'src/server/tools/research.ts',
  browser: 'src/server/tools/browser.ts',
  todo_write: 'src/server/tools/todo.ts',
  wetrack_analysis_save: 'src/server/tools/wetrack-analysis.ts',
  wetrack_analysis_get: 'src/server/tools/wetrack-analysis.ts',
  wetrack_analysis_detail: 'src/server/tools/wetrack-analysis.ts',
  wetrack_analysis_list: 'src/server/tools/wetrack-analysis.ts',
  get_goal: 'src/server/tools/goal.ts',
  create_goal: 'src/server/tools/goal.ts',
  update_goal: 'src/server/tools/goal.ts',
  ask_user_question: 'src/server/tools/interaction.ts',
  enter_plan_mode: 'src/server/tools/plan.ts',
  exit_plan_mode: 'src/server/tools/plan.ts',
  skill_list: 'src/server/tools/skill.ts',
  skill_load: 'src/server/tools/skill.ts',
  skill_save: 'src/server/tools/skill.ts',
  skill_validate: 'src/server/tools/skill.ts',
  subagent: 'src/server/tools/subagent.ts',
  spawn_teammate: 'src/server/tools/team.ts',
  send_message: 'src/server/tools/team.ts',
  list_agents: 'src/server/tools/team.ts',
  wait_agent: 'src/server/tools/team.ts',
  interrupt_agent: 'src/server/tools/team.ts',
  team_task_create: 'src/server/tools/team.ts',
  team_task_list: 'src/server/tools/team.ts',
  team_task_get: 'src/server/tools/team.ts',
  team_task_update: 'src/server/tools/team.ts',
  codemode: 'src/server/codemode-policy.ts',
  // Vendor tools ship with @earendil-works/pi-durable; `tool_search` is registered only when an
  // MCP server exposes deferred tools, so a bare demo runtime does not surface it.
  tool_search: VENDOR_SOURCE,
}

/**
 * `name: '…'` literals under src/server/tools that are not model-facing tools. Extension names
 * with hyphens or dots (`coding-tools`, `research-tools`, `browser-tools`, `pi-web.team-anchor`)
 * never match the snake-case scan regexes; only these snake-case names need an explicit entry.
 */
const NON_TOOL_NAMES: Record<string, string> = {
  todo: 'defineExtension name, not a tool',
  interactions: 'defineExtension name, not a tool',
  plan: 'defineExtension name, not a tool',
  goal: 'defineExtension name, not a tool',
  skills: 'defineExtension name, not a tool',
  team: 'defineExtension name, not a tool',
  // The shell tool is split by platform (tests/prompt-snapshot.test.ts skips win32 the same way):
  // this generator runs on posix, where the runtime registers `bash` instead of `pwsh`.
  pwsh: 'win32-only shell tool; posix runtime registers bash',
}

type CapturedTool = { name: string; description: string; parametersJson: string }
type Captured = { user: string; tools: CapturedTool[] }

function textOfUser(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

function usage(): never {
  console.error('用法：npx tsx scripts/gen-tool-catalog.ts [--check]')
  process.exit(1)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) usage()
  const check = args[0] === '--check'
  // The catalog documents the posix tool surface (`bash`); win32 registers `pwsh` instead, and
  // tests/prompt-snapshot.test.ts skips that platform for the same reason.
  if (process.platform === 'win32') {
    console.error('gen-tool-catalog 在 win32 上不可用：该平台的 shell 工具是 pwsh，产物以 posix（bash）为准。')
    process.exit(1)
  }

  const variantTools = await captureVariants()
  const problems = await guard(variantTools)
  if (problems.length > 0) {
    console.error('完整性守卫失败：')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  const generated = render(variantTools)
  if (!check) {
    await writeFile(docPath, generated)
    const union = new Set(VARIANTS.flatMap(variant => variantTools[variant].map(tool => tool.name)))
    console.log(`已写入 ${relative(repoRoot, docPath)}（default ${variantTools.default.length} 个工具，并集 ${union.size} 个，变体 ${VARIANTS.length} 个）`)
    return
  }
  let onDisk: string
  try {
    onDisk = await readFile(docPath, 'utf8')
  } catch {
    console.error(`${relative(repoRoot, docPath)} 不存在；先运行 npx tsx scripts/gen-tool-catalog.ts 生成。`)
    process.exit(1)
  }
  if (onDisk === generated) {
    console.log(`docs/tool-catalog.md 新鲜度检查通过（default ${variantTools.default.length} 个工具）。`)
    return
  }
  const expectedLines = generated.split('\n')
  const actualLines = onDisk.split('\n')
  const index = expectedLines.findIndex((line, i) => line !== actualLines[i])
  console.error(`docs/tool-catalog.md 已过期。第一处差异在第 ${index + 1} 行：`)
  console.error(`  期望（重新生成）: ${expectedLines[index] ?? '<文件结束>'}`)
  console.error(`  实际（磁盘文件） : ${actualLines[index] ?? '<文件结束>'}`)
  console.error('运行 npx tsx scripts/gen-tool-catalog.ts（npm run gen:docs）重新生成。')
  process.exit(1)
}

/** Boot the demo runtime in a temp root and capture the provider-request tools per variant. */
async function captureVariants(): Promise<Record<Variant, CapturedTool[]>> {
  const rawRoot = await mkdtemp(join(tmpdir(), 'pi-web-tool-catalog-'))
  let runtime: Runtime | undefined
  let unobserve: (() => void) | undefined
  const captured: Captured[] = []
  try {
    const root = await realpath(rawRoot)
    const workspace = join(root, 'workspace')
    const dataDir = join(root, 'data')
    const piDir = join(root, 'pi')
    await mkdir(workspace)
    await mkdir(piDir)
    await writeFile(join(piDir, 'settings.json'), '{}')
    await writeFile(join(workspace, 'AGENTS.md'), '# Project rules\n- Use pnpm for scripts.\n')
    await writeFile(join(workspace, 'probe.txt'), 'READABLE_CHILD_EVIDENCE\n')
    const memoryRoot = resolveMemoryRoot({ dataDir, workspacePath: workspace })
    // 抹平绝对路径/日期/平台差异，保证产物逐字节可复现（同 tests/prompt-snapshot.test.ts 的 normalize）。
    const normalize = (text: string): string => text
      .replaceAll(memoryRoot, '<MEMORY>')
      .replaceAll(root, '<ROOT>')
      .replaceAll(rawRoot, '<ROOT>')
      .replace(/当前日期：\d{4}-\d{2}-\d{2}（时区 [^）]+）/gu, '当前日期：<DATE>（时区 <TZ>）')
      .replace(/平台：[a-z0-9]+；/gu, '平台：<PLATFORM>；')

    runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
    unobserve = observeDemoRequests(request => {
      const messages = normalizeContext(request).messages
      const user = [...messages].reverse().find(message => message.role === 'user')
      const text = user?.role === 'user' ? textOfUser(user.content) : ''
      if (!text.includes('[prompt-probe]') && !text.includes('[subagent-child]')) return
      captured.push({
        user: text,
        tools: getCurrentTools(messages).map(tool => ({
          name: tool.name,
          description: normalize((tool.description ?? '').replaceAll('\n', ' ')),
          parametersJson: normalize(JSON.stringify(tool.parameters ?? {}, null, 2)),
        })),
      })
    })

    const create = async (title: string, accessMode: 'fullAccess' | 'readOnly' = 'fullAccess'): Promise<string> =>
      (await runtime!.create({ title, accessMode })).conversation.id
    const waitTurn = async (id: string, count: number): Promise<void> => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const detail = await runtime!.detail(id)
        if (detail.error) throw new Error(detail.error)
        if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return
        await delay(20)
      }
      throw new Error(`会话 ${id} 的 demo 回合在 30 秒内未完成`)
    }
    const probeMarker = async (id: string, marker: string): Promise<Captured> => {
      const count = (await runtime!.detail(id)).messages.length
      await runtime!.submit(id, { text: `[prompt-probe] ${marker}`, requestId: randomUUID() })
      await waitTurn(id, count)
      const request = captured.findLast(item => item.user.includes(marker))
      if (request === undefined) throw new Error(`没有捕获到 ${marker} 的 provider 请求`)
      return request
    }
    const probeSubagent = async (profile: 'general' | 'explore'): Promise<Captured> => {
      const marker = profile === 'explore' ? '[subagent-explore]' : '[subagent]'
      const id = await create(`Catalog subagent ${profile}`)
      const first = captured.length
      const count = (await runtime!.detail(id)).messages.length
      await runtime!.submit(id, { text: `${marker} [child-read]`, requestId: randomUUID() })
      await waitTurn(id, count)
      const request = captured.slice(first).find(item => item.user.includes('[subagent-child]'))
      if (request === undefined) throw new Error(`没有捕获到 subagent-${profile} 子会话的 provider 请求`)
      return request
    }

    const requests: Record<Variant, Captured> = {
      default: await probeMarker(await create('Catalog default'), 'catalog-default'),
      plan: await (async () => {
        const id = await create('Catalog plan')
        await runtime!.setPlan(id, true)
        return probeMarker(id, 'catalog-plan')
      })(),
      readonly: await probeMarker(await create('Catalog readonly', 'readOnly'), 'catalog-readonly'),
      'subagent-general': await probeSubagent('general'),
      'subagent-explore': await probeSubagent('explore'),
    }
    return Object.fromEntries(VARIANTS.map(variant => [variant, requests[variant].tools])) as Record<Variant, CapturedTool[]>
  } finally {
    unobserve?.()
    await runtime?.close()
    await rm(rawRoot, { recursive: true, force: true })
  }
}

/** Both-direction completeness guards. Returns the list of problems (empty = pass). */
async function guard(variantTools: Record<Variant, CapturedTool[]>): Promise<string[]> {
  const problems: string[] = []
  const union = new Set(VARIANTS.flatMap(variant => variantTools[variant].map(tool => tool.name)))

  // 1. source → runtime: scan tool name literals and TOOL constants under src/server/tools.
  const literalPattern = /\bname:\s*'([a-z][a-z0-9_]*)'/gu
  const constantPattern = /\b[A-Z][A-Z0-9_]*TOOLS?[A-Z0-9_]*\s*=\s*'([a-z][a-z0-9_]*)'/gu
  const definitions = new Map<string, Array<{ file: string; line: number }>>()
  const record = (name: string, file: string, line: number): void => {
    const hits = definitions.get(name) ?? []
    hits.push({ file, line })
    definitions.set(name, hits)
  }
  const walk = async (dir: string): Promise<Array<{ file: string; source: string }>> => {
    const found: Array<{ file: string; source: string }> = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...await walk(full))
      else if (entry.name.endsWith('.ts')) found.push({ file: full, source: await readFile(full, 'utf8') })
    }
    return found
  }
  for (const { file, source } of (await walk(scanRoot)).sort((a, b) => a.file.localeCompare(b.file))) {
    source.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(literalPattern)) record(match[1]!, file, index + 1)
      for (const match of line.matchAll(constantPattern)) record(match[1]!, file, index + 1)
    })
  }
  for (const [name, hits] of definitions) {
    if (NON_TOOL_NAMES[name] !== undefined) continue
    if (!union.has(name)) {
      const where = hits.map(hit => `${relative(repoRoot, hit.file)}:${hit.line}`).join(', ')
      problems.push(`源码定义的工具 ${name}（${where}）没有出现在任何 runtime 变体中——未被 boot 或未被文档化。`)
    }
  }

  // 2. runtime → mapping: every union tool needs a source entry.
  for (const name of union) {
    if (TOOL_SOURCES[name] === undefined) {
      problems.push(`runtime 工具 ${name} 缺少 TOOL_SOURCES 来源映射；新工具必须同时补 TOOL_SOURCES。`)
    }
  }

  // 3. mapping → runtime (and disk): no dead or mistyped entries.
  for (const [name, source] of Object.entries(TOOL_SOURCES)) {
    if (source === VENDOR_SOURCE) continue
    if (!union.has(name)) {
      problems.push(`TOOL_SOURCES 里的 ${name} 不在任何 runtime 变体中；映射已过期（vendor 工具须标注 ${VENDOR_SOURCE}）。`)
      continue
    }
    if (!existsSyncQuiet(join(repoRoot, source))) {
      problems.push(`TOOL_SOURCES 里 ${name} 的来源文件 ${source} 不存在。`)
    }
  }
  return problems
}

function existsSyncQuiet(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function render(variantTools: Record<Variant, CapturedTool[]>): string {
  // 工具按 default 变体的注册序排列；并集里 default 之外的名字（目前不存在）按首次出现顺序追加。
  const ordered = [...variantTools.default]
  const seen = new Set(ordered.map(tool => tool.name))
  for (const variant of VARIANTS) {
    for (const tool of variantTools[variant]) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name)
        ordered.push(tool)
      }
    }
  }
  const byName = new Map(ordered.map(tool => [tool.name, tool]))
  const mark = (variant: Variant, name: string): string => variantTools[variant].some(tool => tool.name === name) ? '✓' : '—'
  const sourceCell = (name: string): string => {
    const source = TOOL_SOURCES[name]!
    return source === VENDOR_SOURCE ? VENDOR_SOURCE : `[${source}](${posix.join('..', source)})`
  }

  const lines: string[] = [
    '<!-- Generated by scripts/gen-tool-catalog.ts — do not edit by hand. Run `npm run gen:docs` to regenerate. -->',
    '',
    '# 工具目录（Tool Catalog）',
    '',
    '本目录穷举 pi-web 的内置工具面。每个变体的工具集合都不是手抄源码，而是来自真实 runtime 的模型请求：生成脚本以 demo 模式启动 runtime（与 `tests/prompt-snapshot.test.ts` 同一条生产线），向每个变体发送一条探测消息，捕获到达 provider 的请求并读取其中的工具清单。MCP 动态工具与插件提供的工具不在本目录内。',
    '',
    '变体含义：`default` 为默认会话（code mode on，全量工具）；`plan` 为计划模式会话；`readonly` 为只读会话；`subagent-general` / `subagent-explore` 为 `subagent` 委派出的子智能体（general / explore profile）。总表按 default 变体的注册序排列，✓ 表示该变体的请求里出现了这个工具，— 表示被该变体的工具过滤排除。',
    '',
    '## 总表',
    '',
    `| 工具 | 来源 | ${VARIANTS.join(' | ')} |`,
    `| --- | --- | ${VARIANTS.map(() => '---').join(' | ')} |`,
  ]
  for (const tool of ordered) {
    lines.push(`| ${tool.name} | ${sourceCell(tool.name)} | ${VARIANTS.map(variant => mark(variant, tool.name)).join(' | ')} |`)
  }
  for (const tool of ordered) {
    lines.push(
      '',
      `## tool ${tool.name}`,
      '',
      tool.description,
      '',
      '```json',
      tool.parametersJson,
      '```',
      '',
      `Source: ${sourceCell(tool.name)}`,
    )
  }
  return `${lines.join('\n')}\n`
}

void main()
