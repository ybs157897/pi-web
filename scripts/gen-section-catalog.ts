import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getCurrentSystemMessage, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime/index.ts'
import { observeDemoRequests } from '../src/server/model/demo.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'
import type { Runtime } from '../src/server/contracts.ts'

/**
 * 从真实 runtime 生成 docs/section-catalog.md：每个变体各发一条 demo provider 请求，
 * 在 provider 边界捕获，穷举实际注入的每个提示词 section。
 *
 * 用法：
 *   npx tsx scripts/gen-section-catalog.ts           # 写 docs/section-catalog.md
 *   npx tsx scripts/gen-section-catalog.ts --check   # 在内存中再生成一份，与磁盘逐字节比对
 *
 * 枚举管线与 tests/prompt-snapshot.test.ts 对齐：相同的临时根目录布局、相同的探测标记、
 * 相同的 section 提取（getCurrentSystemMessage）。section 长度是经下方 normalizeEnvironmentLines
 * 归一后的 .length——目录中的数字是环境归一化的，对携带环境事实的 section 有意与快照文件
 * 的原始长度不同。
 */

const DOC_PATH = new URL('../docs/section-catalog.md', import.meta.url)
// --check 开启新鲜度门（不写盘，仅比对）；PROBE/CHILD_MARKER 是探测标记；回合超时 30 秒。
const CHECK = process.argv.includes('--check')
const PROBE = '[prompt-probe]'
const CHILD_MARKER = '[subagent-child]'
const DEADLINE_MS = 30_000

/** 总表渲染的五个变体，按列序排列。 */
const VARIANT_ORDER = ['default', 'plan', 'readonly', 'subagent-general', 'subagent-explore'] as const
type Variant = typeof VARIANT_ORDER[number]

/**
 * 每个 section key 的注册位置。下方守卫会在 runtime 并集出现本表或 SECTION_NOTES 缺失的
 * key 时失败：新增 section 必须两处同时补齐，目录才能再生成。
 */
const SECTION_SOURCES: Record<string, string> = {
  'runtime-core': 'src/server/conversation/work-policy.ts',
  'personal-instructions': 'src/server/conversation/work-policy.ts',
  'project-instructions': 'src/server/conversation/work-policy.ts',
  'work-policy': 'src/server/conversation/work-policy.ts',
  'schedule-policy': 'src/server/tools/schedule.ts',
  'wetrack-analysis': 'src/server/tools/wetrack-analysis.ts',
  'goal-policy': 'src/server/tools/goal.ts',
  'skills-policy': 'src/server/tools/skill.ts',
  'delegation-policy': 'src/server/tools/subagent.ts',
  'codemode': '(vendor) @earendil-works/pi-durable',
  'plan-policy': 'src/server/tools/plan.ts',
  'instructions': '(vendor) @earendil-works/pi-durable',
  'memory': 'src/server/memory/policy.ts',
  'memory-index': 'src/server/memory/policy.ts',
  'team-policy': 'src/server/tools/team.ts',
}

/** 每个 section 一句话的注入条件，从各注册点的渲染逻辑归纳而来。 */
const SECTION_NOTES: Record<string, string> = {
  'runtime-core': '每个模型请求无条件注入：进程启动时读取的 `conversation/prompts/runtime-core.md` 固定核心提示词。',
  'personal-instructions': '用户级个性化文件（数据目录的 AGENTS.md，设置 → 个性化 编辑）非空时注入，每次请求重读；与项目指令冲突时项目指令优先，Explore 子智能体不注入。',
  'project-instructions': '工作区根存在 AGENTS.md 时注入其内容（每次请求重读）；Explore 子智能体不注入项目指令。',
  'work-policy': '每个请求注入会话事实（工作区、平台、日期、模型、写权限、shell 能力）与工具路由、待办约定；计划模式、只读会话与子会话会收窄其中条款。',
  'schedule-policy': '`schedule_create` 或 `schedule_edit` 在本请求可调用（直接或经 codemode）时注入定时任务的授权约束；只有 list/view 可见时不注入。',
  'wetrack-analysis': '本请求可调用 `wetrack_analysis_save`（直接或经 codemode）时注入 WeTrack 分析记录的写入时机。',
  'goal-policy': 'goal 工具（`get_goal` 等）任一可路由时注入目标创建与自动续跑规则；计划模式下只保留禁止条款。',
  'skills-policy': 'skill 工具可调用时注入技能目录约定，并对比上次已展示内容提示新增技能。',
  'delegation-policy': '本请求可调用 `subagent` 或 `spawn_teammate` 时注入委派指引（何时委派、选哪种类型、选哪个模型）；委派出去的子会话自身不注入。',
  'codemode': 'codemode 工具在 agent 工具集中时由 vendored 扩展注入 codemode 使用规则；模式 on/only/off 改变其中条款。',
  'plan-policy': '仅当会话的计划模式开启（`Plans.active`）时注入；委派子会话收到只含只读调研条款的子版本。',
  'instructions': 'vendored pi-durable 的保留 section：委派子会话注入该子会话 agent 的 instructions（内置 profile 的 systemPrompt，见 `src/server/agents/builtins.ts`）；主会话不含。',
  'memory': '设置开启 memory、解析出工作区记忆根、且本请求保留 write/edit 工具时注入记忆保存协议；本轮 5 个变体未开启 memory，故未注入。',
  'memory-index': '设置开启 memory 且记忆根的 `MEMORY.md` 存在并有内容时注入其索引；本轮 5 个变体未开启 memory，故未注入。',
  'team-policy': '团队会话专属：按 TeamLink 身份为 Lead 与 teammate 分别注入共享工作目录与任务板协作条款；普通会话不注入。',
}

// 一次探测的捕获结果：user 文本（含探测标记）与提取出的 sections。
type Captured = { user: string; sections: Record<string, string> }

/**
 * 功能：从 provider 请求消息里提取最后一条 user 消息的纯文本。
 * @param content user 消息内容（字符串或分块数组）。
 * @returns 全部 text 块按 \n 拼接；非字符串且非数组时返回 ''。
 * 内部逻辑：只用于探测标记匹配，数组内容只取 type=text 的块。
 */
function textOfUser(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

/**
 * 功能：从消息数组中提取 system message 的全部字符串 section，并对环境行做归一化。
 * @param messages provider 请求的消息数组。
 * @returns section key → 归一化后的正文文本；非字符串值的 section 被丢弃。
 */
function sectionsOf(messages: Parameters<typeof getCurrentSystemMessage>[0]): Record<string, string> {
  const system = getCurrentSystemMessage(messages)
  return Object.fromEntries(
    Object.entries(system?.sections ?? {}).flatMap(([key, value]) => (typeof value === 'string' ? [[key, normalizeEnvironmentLines(value)] as const] : [])),
  )
}

/**
 * sessionFacts()（src/server/conversation/work-policy.ts）会把依赖环境的行直接烘焙进 section
 * 正文：平台 + shell 文本、日期 + 时区、模型身份与 shell 能力、工作区绝对路径。原始长度只会在
 * 生成目录的那台机器配置（OS、时区、临时目录形状、已装模型）上成立，因此这些行统一归一成
 * 稳定占位符：任何机器（macOS、Linux、Windows）再生成都是逐字节一致，--check 三平台都能查漂移。
 */
const ENV_FACTS_LINES: ReadonlyMap<string, string> = new Map([
  ['平台：', '平台：<platform>；命令解释器：<shell>。'],
  ['当前日期：', '当前日期：<date>（时区 <timezone>）。'],
  ['本请求模型：', '本请求模型：<model>；<permissions>。'],
  ['当前工作区（默认当前项目）由系统提供：', '当前工作区（默认当前项目）由系统提供："<workspace>"。把此目录作为本次任务的项目范围。'],
  ['工作区 ', '工作区 <workspace>/AGENTS.md 适用于工作区根目录及其后代：'],
  // work-policy 的 shell 条款按平台分支：macOS 渲染 `bash` 版，Windows 渲染 `pwsh` 版，两版文本
  // 长度不同。把两个 direct 变体与两个 codemode 变体各归一成同一占位符，字符数才跨平台可比。
  ['- shell 只用于', '- <shell-terms>'],
  ['- shell（`pwsh`）只用于', '- <shell-terms>'],
  ['- 在 `codemode` 里用 `await tools.bash(...)`', '- <shell-codemode-terms>'],
  ['- 在 `codemode` 里用 `await tools.pwsh(...)`', '- <shell-codemode-terms>'],
])

/**
 * 功能：把 section 正文中的环境相关行替换为稳定占位符。
 * @param text 归一化前的 section 正文。
 * @returns 按行替换后的文本：命中 ENV_FACTS_LINES 前缀的行整体替换，仓库路径替换为 <repo>。
 * 内部逻辑：仓库路径在两套分隔符（原生与正斜杠）下都替换；每行先去掉行尾 \r 再做前缀匹配。
 */
function normalizeEnvironmentLines(text: string): string {
  // 内置技能目录条目内嵌 checkout 路径（`(file: <repo>/skills/…/SKILL.md)`），各机器分隔符
  // 不同；两套分隔符写法都做替换。
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  let normalized = text.split(repoRoot).join('<repo>').split(repoRoot.replaceAll('\\', '/')).join('<repo>')
  return normalized.split('\n').map(line => {
    const clean = line.replace(/\r$/, '')
    for (const [prefix, replacement] of ENV_FACTS_LINES) {
      if (clean.startsWith(prefix)) return replacement
    }
    return clean
  }).join('\n')
}

/**
 * 功能：主流程——临时根目录起 runtime → 按变体捕获 sections → 守卫映射完整性 → 写盘或 --check 比对。
 * @returns 无返回值；失败路径设置 process.exitCode = 1 并提前返回（守卫失败、目录缺失、
 * 目录过期），不抛异常。
 * 内部逻辑：守卫要求 runtime 并集的每个 key 都在 SECTION_SOURCES 与 SECTION_NOTES 中登记；
 * --check 模式下目录不存在或内容不一致都判失败并打印第一处差异；生成模式直接写盘并打印统计。
 */
async function main(): Promise<void> {
  // 与测试 beforeAll 相同的布局、相同的 23 字符临时前缀。工作区路径已不影响目录内容
  // （normalizeEnvironmentLines 会占位化），保持布局一致只为让捕获管线与快照测试可对照。
  const rawRoot = await mkdtemp(join(tmpdir(), 'pi-web-section-catalog-'))
  const root = await realpath(rawRoot)
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const piDir = join(root, 'pi')
  await mkdir(workspace)
  await mkdir(piDir)
  await writeFile(join(piDir, 'settings.json'), '{}')
  await writeFile(join(workspace, 'AGENTS.md'), '# Project rules\n- Use pnpm for scripts.\n')
  resolveMemoryRoot({ dataDir, workspacePath: workspace })

  const captured: Captured[] = []
  const runtime: Runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
  const unobserve = observeDemoRequests((request) => {
    const messages = normalizeContext(request).messages
    const user = [...messages].reverse().find(message => message.role === 'user')
    const text = user?.role === 'user' ? textOfUser(user.content) : ''
    if (!text.includes(PROBE) && !text.includes(CHILD_MARKER)) return
    captured.push({ user: text, sections: sectionsOf(messages) })
  })

  /** 提交一条探测消息并等待 assistant 回合收尾；返回按标记定位到的捕获请求。 */
  async function probe(id: string, label: string): Promise<Captured> {
    const marker = `${PROBE} ${label}`
    const count = (await runtime.detail(id)).messages.length
    await runtime.submit(id, { text: marker, requestId: randomUUID() })
    await settle(id, count)
    const request = captured.findLast(item => item.user.includes(marker))
    if (request === undefined) throw new Error(`No provider request for ${marker}`)
    return request
  }

  /** 提交委派触发消息并定位捕获到的子会话请求（其任务文本携带 CHILD_MARKER）。 */
  async function probeChild(id: string, trigger: string, label: string): Promise<Captured> {
    // 与测试一致：从提交前的捕获索引开始切片，避免上一个变体的子请求被误匹配。
    const first = captured.length
    const count = (await runtime.detail(id)).messages.length
    await runtime.submit(id, { text: trigger, requestId: randomUUID() })
    const deadline = Date.now() + DEADLINE_MS
    while (Date.now() < deadline) {
      const request = captured.slice(first).find(item => item.user.includes(CHILD_MARKER))
      if (request !== undefined) {
        await settle(id, count)
        return request
      }
      const detail = await runtime.detail(id)
      if (detail.error) throw new Error(detail.error)
      await delay(20)
    }
    throw new Error(`No child provider request for ${label}`)
  }

  /** 轮询等待回合收尾：非 busy 且基线之后出现完整 assistant 消息即返回，超时抛错。 */
  async function settle(id: string, count: number): Promise<void> {
    const deadline = Date.now() + DEADLINE_MS
    while (Date.now() < deadline) {
      const detail = await runtime.detail(id)
      if (detail.error) throw new Error(detail.error)
      if (!detail.conversation.busy && detail.messages.slice(count).some(message => message.role === 'assistant' && !message.streaming)) return
      await delay(20)
    }
    throw new Error(`Conversation ${id} did not settle within ${DEADLINE_MS}ms`)
  }

  // 五个变体逐一探测：default/plan/readonly 走 probe（plan 需先开启计划模式），
  // 两个 subagent 变体走 probeChild（触发委派、捕获子会话请求）。
  const sectionsByVariant: Record<Variant, Record<string, string>> = { default: {}, plan: {}, readonly: {}, 'subagent-general': {}, 'subagent-explore': {} }
  try {
    const created = async (title: string, accessMode: 'fullAccess' | 'readOnly' = 'fullAccess'): Promise<string> =>
      (await runtime.create({ title, accessMode })).conversation.id

    sectionsByVariant.default = (await probe(await created('Section catalog default'), 'default')).sections
    const planId = await created('Section catalog plan')
    await runtime.setPlan(planId, true)
    sectionsByVariant.plan = (await probe(planId, 'plan')).sections
    sectionsByVariant.readonly = (await probe(await created('Section catalog readonly', 'readOnly'), 'readonly')).sections
    sectionsByVariant['subagent-general'] = (await probeChild(await created('Section catalog subagent'), '[subagent]', 'subagent-general')).sections
    sectionsByVariant['subagent-explore'] = (await probeChild(await created('Section catalog subagent explore'), '[subagent-explore]', 'subagent-explore')).sections
  } finally {
    unobserve()
    await runtime.close()
    await rm(rawRoot, { recursive: true, force: true })
  }

  // 守卫：runtime 真实注入的每个 section 都必须有来源映射与说明——缺失的 key 逐条报错并以 1 退出。
  const union = VARIANT_ORDER.flatMap(name => Object.keys(sectionsByVariant[name]))
  const missing = [...new Set(union)].filter(key => SECTION_SOURCES[key] === undefined || SECTION_NOTES[key] === undefined)
  if (missing.length > 0) {
    for (const key of missing) {
      console.error(`[gen-section-catalog] unmapped section "${key}": add it to SECTION_SOURCES and SECTION_NOTES in scripts/gen-section-catalog.ts`)
    }
    process.exitCode = 1
    return
  }

  const document = render(sectionsByVariant)

  if (CHECK) {
    let previous: string
    try {
      previous = await readFile(DOC_PATH, 'utf8')
    } catch {
      console.error(`[gen-section-catalog] ${DOC_PATH.pathname} does not exist yet; run without --check to generate it`)
      process.exitCode = 1
      return
    }
    if (previous !== document) {
      const expected = document.split('\n')
      const actual = previous.split('\n')
      const line = expected.findIndex((value, index) => value !== actual[index])
      console.error(`[gen-section-catalog] ${DOC_PATH.pathname} is stale (first difference at line ${line + 1})`)
      console.error(`  expected: ${JSON.stringify(expected[line] ?? '<eof>')}`)
      console.error(`  actual:   ${JSON.stringify(actual[line] ?? '<eof>')}`)
      console.error('Regenerate with: npx tsx scripts/gen-section-catalog.ts')
      process.exitCode = 1
      return
    }
    console.log(`[gen-section-catalog] ${DOC_PATH.pathname} is fresh (${document.split('\n').length} lines)`)
    return
  }

  await writeFile(DOC_PATH, document)
  const observed = new Set(union)
  const tableRows = VARIANT_ORDER.reduce((sum, name) => sum + Object.keys(sectionsByVariant[name]).length, 0)
  console.log(`[gen-section-catalog] wrote ${DOC_PATH.pathname}`)
  console.log(`[gen-section-catalog] ${VARIANT_ORDER.length} variants, ${observed.size} distinct sections, ${tableRows} observed cells; ${Object.keys(SECTION_SOURCES).length} keys documented`)
}

/**
 * 功能：确定性的行排序——default 变体的注入序优先，其余变体首次出现的 key 按序追加，
 * 已映射但本轮未注入的 key 收尾，保证任何机器上生成的行序一致。
 * @param sectionsByVariant 各变体捕获到的 sections。
 * @returns 排好序的 section key 列表。
 */
function orderedKeys(sectionsByVariant: Record<Variant, Record<string, string>>): string[] {
  const keys: string[] = []
  for (const name of VARIANT_ORDER) {
    for (const key of Object.keys(sectionsByVariant[name])) if (!keys.includes(key)) keys.push(key)
  }
  for (const key of Object.keys(SECTION_SOURCES)) if (!keys.includes(key)) keys.push(key)
  return keys
}

/** 渲染「定义处」单元格：vendor 条目原样展示，仓库路径渲染成指向源码文件的相对链接。 */
function sourceCell(key: string): string {
  const source = SECTION_SOURCES[key]!
  return source.startsWith('(vendor)') ? source : `[\`${source}\`](../${source})`
}

/**
 * 功能：把各变体 sections 渲染成完整的 Markdown 目录（总表 + 逐 section 小节 + 尾部索引）。
 * @param sectionsByVariant 各变体捕获到的 sections。
 * @returns 完整文档文本，供写盘或与磁盘逐字节比对。
 * 内部逻辑：总表按 orderedKeys 排序，✓/— 表示该变体是否注入，长度列取 default 变体归一后
 * 字符数；逐 section 小节列出注入条件与各变体实测长度；未注入 key 也保留行位以便守卫覆盖。
 */
function render(sectionsByVariant: Record<Variant, Record<string, string>>): string {
  const mark = (key: string, name: Variant): string => (sectionsByVariant[name][key] === undefined ? '—' : '✓')
  const length = (key: string, name: Variant): number | undefined => {
    const value = sectionsByVariant[name][key]
    return value === undefined ? undefined : value.length
  }

  const lines: string[] = [
    '<!-- Generated by scripts/gen-section-catalog.ts — do not edit by hand. Run `npm run gen:docs` to regenerate. -->',
    '',
    '# 提示词 section 目录',
    '',
    'sections 是每次模型请求按真实能力动态注入的提示词块：工具集、访问模式、计划模式、委派身份等决定某个 section 是否出现及其条款。本文由真实 runtime 枚举生成，作为穷举参考——目录只做索引，不复制正文。',
    '',
    '生成方式：在临时工作区起 demo runtime，对 5 个变体（default、plan、readonly、subagent-general、subagent-explore）各发一条真实请求，在 provider 边界捕获 system message 的 sections（口径与 `tests/prompt-snapshot.test.ts` 一致）。长度为 section 正文的字符数，其中环境相关行（平台/命令解释器、日期/时区、模型身份、工作区路径）按占位符归一（见 `scripts/gen-section-catalog.ts` 的 `normalizeEnvironmentLines`），因此在 macOS / Linux / Windows 任一平台重新生成都逐字节一致，`--check` 在三平台均可校验漂移。规范源在代码：改文案请去对应定义文件修改，再重新生成本目录。',
    '',
    '## 总表',
    '',
    '| section | default | plan | readonly | subagent-general | subagent-explore | 正文长度(default,字符) | 定义处 |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- |',
  ]
  for (const key of orderedKeys(sectionsByVariant)) {
    lines.push(`| ${key} | ${mark(key, 'default')} | ${mark(key, 'plan')} | ${mark(key, 'readonly')} | ${mark(key, 'subagent-general')} | ${mark(key, 'subagent-explore')} | ${length(key, 'default') ?? '—'} | ${sourceCell(key)} |`)
  }

  lines.push('', '## 逐个 section', '')
  for (const key of orderedKeys(sectionsByVariant)) {
    const lengths = VARIANT_ORDER.flatMap(name => (sectionsByVariant[name][key] === undefined ? [] : [`${name} ${length(key, name)}`]))
    lines.push(`### section ${key}`, '')
    lines.push(`- 注入条件：${SECTION_NOTES[key]!}`)
    lines.push(lengths.length === 0
      ? '- 实测长度（字符）：本轮变体未注入。'
      : `- 实测长度（字符）：${sectionsByVariant.default[key] === undefined ? 'default 不注入；' : ''}${lengths.join(' · ')}`)
    lines.push(`- 定义处：${sourceCell(key)}`)
    lines.push('')
  }

  lines.push('---', '', '变体全集（codemode-only/off、memory、team 等更多变体与完整正文）见 [tests/__snapshots__/prompt/](../tests/__snapshots__/prompt/)。', '')
  return `${lines.join('\n')}`
}

await main()
