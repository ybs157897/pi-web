import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getCurrentSystemMessage, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime/index.ts'
import { observeDemoRequests } from '../src/server/model/demo.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'
import type { Runtime } from '../src/server/contracts.ts'

/**
 * Generate docs/section-catalog.md from a real runtime: one demo-provider request per variant,
 * captured at the provider boundary, enumerating every prompt section actually injected.
 *
 * Usage:
 *   npx tsx scripts/gen-section-catalog.ts           # write docs/section-catalog.md
 *   npx tsx scripts/gen-section-catalog.ts --check   # regenerate in memory, byte-compare with disk
 *
 * The enumeration pipeline mirrors tests/prompt-snapshot.test.ts: same temp-root layout, same
 * probe markers, same section extraction via getCurrentSystemMessage. Section lengths are the raw
 * `.length` of each section value (the snapshot files' convention), so the temp root prefix must
 * stay exactly as long as the test's (`pi-web-prompt-snapshot-`, 23 chars incl. trailing dash)
 * for the numbers to line up with tests/__snapshots__/prompt/.
 */

const DOC_PATH = new URL('../docs/section-catalog.md', import.meta.url)
const CHECK = process.argv.includes('--check')
const PROBE = '[prompt-probe]'
const CHILD_MARKER = '[subagent-child]'
const DEADLINE_MS = 30_000

/** The five variants rendered in the summary table, in column order. */
const VARIANT_ORDER = ['default', 'plan', 'readonly', 'subagent-general', 'subagent-explore'] as const
type Variant = typeof VARIANT_ORDER[number]

/**
 * Where each section key is registered. The guard below fails when the runtime union contains a
 * key missing here or from SECTION_NOTES: a new section must add both before the catalog regenerates.
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

/** One-line injection condition per section, summarized from each registration's render logic. */
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

type Captured = { user: string; sections: Record<string, string> }

function textOfUser(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

function sectionsOf(messages: Parameters<typeof getCurrentSystemMessage>[0]): Record<string, string> {
  const system = getCurrentSystemMessage(messages)
  return Object.fromEntries(
    Object.entries(system?.sections ?? {}).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value] as const] : [])),
  )
}

async function main(): Promise<void> {
  // Same layout as the test's beforeAll, including the 23-char temp prefix: raw section lengths
  // (the snapshot convention) embed the workspace path, so the prefix length must not drift.
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

  /** Submit a probe message and wait for its assistant turn to settle; resolve the captured request. */
  async function probe(id: string, label: string): Promise<Captured> {
    const marker = `${PROBE} ${label}`
    const count = (await runtime.detail(id)).messages.length
    await runtime.submit(id, { text: marker, requestId: randomUUID() })
    await settle(id, count)
    const request = captured.findLast(item => item.user.includes(marker))
    if (request === undefined) throw new Error(`No provider request for ${marker}`)
    return request
  }

  /** Submit a delegation trigger and resolve the captured child request (its task text carries CHILD_MARKER). */
  async function probeChild(id: string, trigger: string, label: string): Promise<Captured> {
    // Slice from the pre-submit index, like the test: a previous variant's child capture must not match.
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

  // Guard: every section the runtime really injects must carry a source mapping and a note.
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

/** Deterministic row order: default variant's injection order, then first appearance in the other variants, then mapped-but-uninjected keys. */
function orderedKeys(sectionsByVariant: Record<Variant, Record<string, string>>): string[] {
  const keys: string[] = []
  for (const name of VARIANT_ORDER) {
    for (const key of Object.keys(sectionsByVariant[name])) if (!keys.includes(key)) keys.push(key)
  }
  for (const key of Object.keys(SECTION_SOURCES)) if (!keys.includes(key)) keys.push(key)
  return keys
}

function sourceCell(key: string): string {
  const source = SECTION_SOURCES[key]!
  return source.startsWith('(vendor)') ? source : `[\`${source}\`](../${source})`
}

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
    '生成方式：在临时工作区起 demo runtime，对 5 个变体（default、plan、readonly、subagent-general、subagent-explore）各发一条真实请求，在 provider 边界捕获 system message 的 sections（口径与 `tests/prompt-snapshot.test.ts` 一致，长度为 section 正文的字符数）。规范源在代码：改文案请去对应定义文件修改，再重新生成本目录。',
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
