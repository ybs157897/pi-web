/**
 * 生成 `docs/tool-catalog.md`——穷举的内置工具目录——产物来自真实 runtime，不是手抄源码。
 *
 * 脚本以与 `tests/prompt-snapshot.test.ts` 相同的装配启动 demo runtime（mkdtemp 数据目录/
 * 工作区、observeDemoRequests），对每个 agent 变体各发一条探测请求，记录 provider 请求实际
 * 携带的工具清单。MCP 动态工具与插件工具不在范围内。
 *
 * 用法：
 *   npx tsx scripts/gen-tool-catalog.ts           重新生成 docs/tool-catalog.md
 *   npx tsx scripts/gen-tool-catalog.ts --check   新鲜度门：与磁盘副本逐字节比对
 *
 * 完整性守卫（写盘/校验前执行，任一失败即阻断本次运行）：
 *   1. 源码 → runtime：src/server/tools 树下每个工具 `name: '…'` 字面量与 `*_TOOL*` 常量
 *      必须出现在全部变体的并集里——从未到达 provider 请求的名字要么没被 boot，
 *      要么没被本目录的变体覆盖；
 *   2. runtime → 映射：并集里的每个工具都必须有 `TOOL_SOURCES` 条目；
 *   3. 映射 → runtime：TOOL_SOURCES 里每个非 vendor 条目都必须出现在并集里，且其源码
 *      路径必须存在（死映射或拼错的路径判失败）。
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

// 目录覆盖的五个 agent 变体，即总表的列序；每个变体单独发起一次真实探测请求。
const VARIANTS = ['default', 'plan', 'readonly', 'subagent-general', 'subagent-explore'] as const
type Variant = (typeof VARIANTS)[number]

/** 每个目录内工具的定义来源；vendor 工具以 `(vendor)` 标注而非仓库路径。 */
const VENDOR_SOURCE = '(vendor)'
const TOOL_SOURCES: Record<string, string> = {
  read: 'src/server/tools/shell/tools.ts',
  write: 'src/server/tools/shell/tools.ts',
  edit: 'src/server/tools/shell/tools.ts',
  bash: 'src/server/tools/shell/tools.ts',
  shell_session: 'src/server/tools/shell/session.ts',
  list_files: 'src/server/tools/research.ts',
  search_files: 'src/server/tools/research.ts',
  glob: 'src/server/tools/research.ts',
  grep: 'src/server/tools/research.ts',
  browser: 'src/server/tools/browser.ts',
  todo_write: 'src/server/tools/todo.ts',
  schedule_create: 'src/server/tools/schedule.ts',
  schedule_edit: 'src/server/tools/schedule.ts',
  schedule_list: 'src/server/tools/schedule.ts',
  schedule_view: 'src/server/tools/schedule.ts',
  wetrack_analysis_save: 'src/server/tools/wetrack-analysis.ts',
  wetrack_analysis_get: 'src/server/tools/wetrack-analysis.ts',
  wetrack_analysis_detail: 'src/server/tools/wetrack-analysis.ts',
  wetrack_analysis_list: 'src/server/tools/wetrack-analysis.ts',
  get_goal: 'src/server/tools/goal.ts',
  create_goal: 'src/server/tools/goal.ts',
  update_goal: 'src/server/tools/goal.ts',
  ask_user_question: 'src/server/tools/interaction.ts',
  manage_hooks: 'src/server/hooks/tool.ts',
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
  // vendor 工具随 @earendil-works/pi-durable 发布；`tool_search` 仅在 MCP 服务暴露延迟工具时
  // 注册，裸 demo runtime 不会出现它。
  tool_search: VENDOR_SOURCE,
}

/**
 * src/server/tools 树下出现、但不是面向模型的工具的 `name: '…'` 字面量。带连字符或点的
 * 扩展名（`coding-tools`、`research-tools`、`browser-tools`、`pi-web.team-anchor`）不会被
 * snake-case 扫描正则命中；只有这些 snake-case 名字需要显式登记为豁免。
 */
const NON_TOOL_NAMES: Record<string, string> = {
  todo: 'defineExtension name, not a tool',
  schedule: 'defineExtension name, not a tool',
  interactions: 'defineExtension name, not a tool',
  plan: 'defineExtension name, not a tool',
  goal: 'defineExtension name, not a tool',
  skills: 'defineExtension name, not a tool',
  team: 'defineExtension name, not a tool',
  // shell 工具按平台拆分（tests/prompt-snapshot.test.ts 同样跳过 win32）：本生成器跑在
  // posix 上，runtime 注册的是 `bash` 而非 `pwsh`。
  pwsh: 'win32-only shell tool; posix runtime registers bash',
}

// 捕获到的单个工具（描述与参数 JSON 已做归一化）；Captured 是一次探测的上下文。
type CapturedTool = { name: string; description: string; parametersJson: string }
type Captured = { user: string; tools: CapturedTool[] }

/**
 * 功能：从 provider 请求消息里提取最后一条 user 消息的纯文本。
 * @param content user 消息内容（字符串或分块数组）。
 * @returns 全部 text 块按 \n 拼接的结果；非字符串且非数组时返回 ''。
 * 内部逻辑：用于探测标记匹配（[prompt-probe] / [subagent-child]），数组只取 type=text 的部分。
 */
function textOfUser(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

/** 打印用法提示并以退出码 1 结束；多余参数或不认识的参数都会走到这里。 */
function usage(): never {
  console.error('用法：npx tsx scripts/gen-tool-catalog.ts [--check]')
  process.exit(1)
}

/**
 * 功能：主流程——捕获各变体工具面 → 完整性守卫 → 渲染/写盘或新鲜度校验。
 * @returns 无返回值；失败路径以非零 process.exit 终止，--check 通过或 win32 跳过则正常返回。
 * @throws 参数非法调用 usage；守卫失败或目录产物过期以退出码 1 结束。
 * 内部逻辑：--check 模式下目录不存在或与再生成结果不一致都判失败，并打印第一处差异行
 * 帮助定位；生成模式直接覆盖写盘并打印工具统计。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) usage()
  const check = args[0] === '--check'
  // 目录记录的是 posix 工具面（bash）；win32 注册的是 pwsh，tests/prompt-snapshot.test.ts 也
  // 因此跳过该平台。win32 上既无法校验也无法再生成产物，两种模式在此分叉：--check 声明跳过
  // 并通过（漂移防护由 macOS/Linux 承担），生成模式仍然拒绝，防止 win32 覆写 posix 基准目录。
  if (process.platform === 'win32') {
    if (check) {
      console.error('gen-tool-catalog 在 win32 上跳过 --check：catalog 记录 posix（bash）工具面，本平台 shell 工具是 pwsh，漂移校验在 macOS/Linux 进行。')
      return
    }
    console.error('gen-tool-catalog 在 win32 上不可用：该平台的 shell 工具是 pwsh，产物以 posix（bash）为准，请在 macOS/Linux 上运行 `npm run gen:docs`。')
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

/**
 * 功能：在临时根目录启动 demo runtime，按变体捕获 provider 请求携带的工具清单。
 * @returns 每个变体到工具数组的映射（default/plan/readonly/subagent-general/subagent-explore）。
 * @throws 任一变体的探测请求 30 秒内未回合、或未捕获到对应 provider 请求时抛错。
 * 内部逻辑：临时工作区写入固定 fixture（AGENTS.md、probe.txt）保证输出可复现；normalize
 * 把绝对路径/日期/平台替换为占位符；observeDemoRequests 只收带探测标记的请求；
 * subagent 变体通过触发委派、按捕获序切片锁定子会话请求。
 */
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

    // 三个探测辅助：create 建会话；waitTurn 轮询回合结束（以提交前的消息数为基线）；
    // probeMarker 发探测消息并按标记定位捕获；probeSubagent 触发委派并按捕获序切片找子请求。
    const create = async (title: string, accessMode: 'fullAccess' | 'readOnly' = 'fullAccess'): Promise<string> =>
      (await runtime!.create({ title, accessMode })).conversation.id
    // 等待一次 demo 回合结束：非 busy 且基线之后出现完整 assistant 消息即返回，30 秒超时抛错。
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
    // 发送带标记的探测消息，回合结束后从捕获列表里找最后一条包含该标记的请求。
    const probeMarker = async (id: string, marker: string): Promise<Captured> => {
      const count = (await runtime!.detail(id)).messages.length
      await runtime!.submit(id, { text: `[prompt-probe] ${marker}`, requestId: randomUUID() })
      await waitTurn(id, count)
      const request = captured.findLast(item => item.user.includes(marker))
      if (request === undefined) throw new Error(`没有捕获到 ${marker} 的 provider 请求`)
      return request
    }
    // 触发 subagent 委派：从提交前的捕获索引开始切片，避免匹配到前一个变体的子请求。
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

/**
 * 功能：双向完整性守卫（源码↔runtime↔映射三向闭环）。
 * @param variantTools 各变体捕获到的工具清单。
 * @returns 问题列表（空数组 = 全部通过）。
 * 内部逻辑：1) 扫描 src/server/tools 下工具名字面量与 *_TOOL* 常量，凡不在变体并集里的
 * 名字（且不在 NON_TOOL_NAMES 豁免内）报「未 boot 或未文档化」；2) 并集里每个工具都必须
 * 有 TOOL_SOURCES 条目；3) TOOL_SOURCES 里每个非 vendor 条目必须仍在并集里且源文件存在。
 */
async function guard(variantTools: Record<Variant, CapturedTool[]>): Promise<string[]> {
  const problems: string[] = []
  const union = new Set(VARIANTS.flatMap(variant => variantTools[variant].map(tool => tool.name)))

  // 1. 源码 → runtime：扫描 src/server/tools 下的工具名字面量与 TOOL 常量。
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

  // 2. runtime → 映射：并集里的每个工具都要有来源条目。
  for (const name of union) {
    if (TOOL_SOURCES[name] === undefined) {
      problems.push(`runtime 工具 ${name} 缺少 TOOL_SOURCES 来源映射；新工具必须同时补 TOOL_SOURCES。`)
    }
  }

  // 3. 映射 → runtime（和磁盘）：不允许死映射或拼错的路径。
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

/** 静默版存在性探测：路径存在返回 true，statSync 抛错（不存在/无权限）返回 false。 */
function existsSyncQuiet(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * 功能：把各变体工具清单渲染成完整的 Markdown 目录文档。
 * @param variantTools 各变体捕获到的工具清单。
 * @returns 完整文档文本（总表 + 每个工具的独立小节），末尾带换行，供写盘或与磁盘逐字节比对。
 * 内部逻辑：排序 = default 变体注册序，其余变体首次出现的工具追加在后；每个工具的描述与
 * 参数 JSON 来自真实请求（已归一化）；来源列 vendor 工具写 `(vendor)`，仓库工具写相对链接。
 */
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
