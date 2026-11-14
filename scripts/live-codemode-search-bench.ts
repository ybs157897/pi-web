import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createRuntime } from '../src/server/runtime/index.ts'

/**
 * Real-model search benchmark: does code mode help file/code search, and does a search
 * handbook Skill close the gap?
 *
 * Groups:
 *   on        — codemode plus the normal tools; the model chooses per task.
 *   only      — only codemode is offered; every search goes through a script.
 *   only-skill— same as only, plus a search handbook Skill in a private global root.
 *
 * Usage:
 *   tsx scripts/live-codemode-search-bench.ts            # all groups, all tasks
 *   tsx scripts/live-codemode-search-bench.ts --tasks=3  # first three tasks (smoke)
 *   tsx scripts/live-codemode-search-bench.ts --group=only --tasks=1
 *
 * The isolation contract: `dataDir` holds app state, `piDir` holds model credentials and the
 * private skill root. Neither touches `~/.pi-web`, so a run can never disturb the user's own
 * conversations or global Skills.
 */

/**
 * Model presets. `cmdc` is the commandcode deepseek route through the local proxy; `zai` is
 * the GLM fallback used when that key or its quota is unavailable. A preset carries its own
 * credential source, so a run never reads a provider the user has not configured.
 */
interface ModelPreset {
  id: string
  baseUrl: string
  modelId: string
  name: string
  /** Where the API key comes from: a JSON file plus the path to the string inside it. */
  credential: { file: string; path: string[] }
  compat: Record<string, unknown>
  contextWindow: number
  maxTokens: number
}

const PRESETS: Record<string, ModelPreset> = {
  cmdc: {
    id: 'cmdc',
    baseUrl: 'http://127.0.0.1:3050/v1',
    modelId: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash (cmdc)',
    credential: { file: join(homedir(), '.commandcode', 'auth.json'), path: ['apiKey'] },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  zai: {
    id: 'zai-coding-cn',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    modelId: 'glm-5.3',
    name: 'GLM-5.3 (zai)',
    credential: { file: join(homedir(), '.pi-web', 'auth.json'), path: ['zai-coding-cn', 'key'] },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  'zai-flash': {
    id: 'zai-coding-cn',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    modelId: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash (zai)',
    credential: { file: join(homedir(), '.pi-web', 'auth.json'), path: ['zai-coding-cn', 'key'] },
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
}

const THINKING_LEVEL = 'max'
const TURN_DEADLINE_MS = 180_000
const MAX_TOOL_ROUNDS = 40

type GroupName = 'on' | 'only' | 'only-skill'

/** One search task: a question a developer would plausibly ask about this repository. */
interface Task {
  id: string
  /** What the user says. Kept free of tool names so it works the same in every group. */
  prompt: string
  /** Files that answer the question. The run counts as correct when at least one is found. */
  golden: string[]
  /**
   * For a task whose answer is "this does not exist": the run is correct when the answer says so.
   * Checked on the final answer text, because there is no file to locate.
   */
  expectedAbsent?: RegExp
}

const TASKS: Task[] = [
  {
    id: 'symbol-constant',
    prompt: '这个仓库里 CODEMODE_INLINE_BUDGET 这个常量定义在哪个文件？值是多少？',
    golden: ['src/server/codemode-policy.ts'],
  },
  {
    id: 'cross-file-trace',
    prompt: '设置里的 codemodeMode 从后端存储到运行时装配要经过哪些文件？把完整链路列出来。',
    golden: [
      'src/server/state/app-state.ts',
      'src/server/runtime/core.ts',
      'src/shared/types.ts',
      'src/server/runtime/settings.ts',
    ],
  },
  {
    id: 'concept-search',
    prompt: '这个仓库的 grep 工具有哪些硬性限制（结果条数、输出字节、跳过哪些文件）？给出依据文件。',
    golden: ['src/server/tools/research.ts', 'src/server/tools/search/format.ts'],
  },
  {
    id: 'large-file-window',
    prompt: 'src/server/tools/research.ts 里 grep 工具的 execute 是怎么把原生 ripgrep 结果交给输出格式化的？说明关键分支。',
    golden: ['src/server/tools/research.ts'],
  },
  {
    id: 'multi-keyword',
    prompt: '找出这个仓库里所有跟「工作区路径校验」相关的位置（越界检查、符号链接拒绝、路径规范化），按文件归类。',
    golden: [
      'src/server/workspace/instructions.ts',
      'src/server/tools/research.ts',
      'src/server/runtime/helpers.ts',
    ],
  },
  {
    id: 'no-result-fallback',
    prompt: '这个仓库有没有实现向量检索或 embedding 索引？如果没有，说明你查过哪些线索。',
    golden: [],
    expectedAbsent: /没有|不存在|未实现|无相关|not implemented|no such/i,
  },
]

/** The search handbook injected as a Skill for the `only-skill` group. */
const HANDBOOK = `---
name: codemode-search
description: Search handbook for code mode. Read before searching files or code with codemode.
---

# Searching with codemode

## Route first

- A path you already know: \`await tools.read({ path })\`. Do not write a search script.
- One keyword, few expected hits: one \`tools.grep\` call is cheaper than a script.
- Several keywords, or you expect more than ~15 hits: write a script.

## Never return raw tool output

\`tools.grep\` returns formatted text, not an array. Its matches look like:

\`\`\`
- "src/server/runtime/core.ts":213: export function ...
\`\`\`

Parse it, aggregate it, and return a decision-shaped result:

\`\`\`js
const text = await tools.grep({ pattern: "codemodeMode", maxResults: 50 })
const rows = text.split("\\n")
  .map(line => line.match(/^- "(.+)":(\\d+): (.*)$/))
  .filter(Boolean)
  .map(m => ({ path: m[1], line: Number(m[2]), excerpt: m[3] }))

const byFile = new Map()
for (const row of rows) {
  const entry = byFile.get(row.path) ?? { path: row.path, hits: 0, samples: [] }
  entry.hits += 1
  if (entry.samples.length < 2) entry.samples.push(row.line + ": " + row.excerpt)
  byFile.set(row.path, entry)
}
return [...byFile.values()].sort((a, b) => b.hits - a.hits).slice(0, 10)
\`\`\`

## Read narrow, not wide

\`tools.read\` on a large file spends most of the output budget on lines nobody asked about.
Read the file once, then keep only the window around each hit:

\`\`\`js
const source = await tools.read({ path })
const lines = source.split("\\n")
const window = lines.slice(Math.max(0, line - 8), line + 8).join("\\n")
\`\`\`

Only do this for the top three to five candidates. Reading fifty files exhausts the 256 MB
sandbox and there are no timers to pace it.

## Fan out when words are guesses

When you are unsure which word the codebase uses, run every candidate at once:

\`\`\`js
const patterns = ["retry", "backoff", "maxAttempts", "again"]
const texts = await Promise.all(patterns.map(pattern => tools.grep({ pattern, maxResults: 30 })))
\`\`\`

## Report what you searched

When nothing matches, return the attempts so the next turn does not repeat them:

\`\`\`js
return { tried: patterns, hits: counts, next: ["vector", "embedding", "index"] }
\`\`\`

## Limits you must respect

- A script fails when its output exceeds 10000 tokens; write the first line
  \`// @options: {"max_output_tokens": 2000}\` when you return many rows.
- Tool calls reject on failure. Wrap independent work in \`Promise.allSettled()\`.
- Nested failures are real: they already happened and are not rolled back.
`

interface RunMetrics {
  group: GroupName
  task: string
  ok: boolean
  correct: boolean
  /** Model-facing tokens reported by the provider, summed over every assistant message. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Bytes of tool output the model actually had to read. */
  toolOutputChars: number
  toolCalls: number
  toolNames: Record<string, number>
  rounds: number
  durationMs: number
  /** True when the run produced no successful tool result at all. */
  noTools: boolean
  error?: string
  finalAnswer: string
}

function parseArgs(): { tasks: number; groups: GroupName[]; preset: ModelPreset } {
  let tasks = TASKS.length
  let groups: GroupName[] = ['on', 'only', 'only-skill']
  let presetName = 'cmdc'
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--tasks=')) tasks = Math.max(1, Math.min(TASKS.length, Number(arg.slice(8))))
    if (arg.startsWith('--model=')) presetName = arg.slice(8)
    if (arg.startsWith('--group=')) {
      const requested = arg.slice(8).split(',') as GroupName[]
      groups = requested.filter(group => ['on', 'only', 'only-skill'].includes(group))
    }
  }
  const preset = PRESETS[presetName]
  if (!preset) throw new Error(`Unknown model preset "${presetName}". Known: ${Object.keys(PRESETS).join(', ')}`)
  return { tasks, groups, preset }
}

/** Read the API key from a credential file, following the preset's path. */
async function readApiKey(preset: ModelPreset): Promise<string> {
  const raw = JSON.parse(await readFile(preset.credential.file, 'utf8')) as Record<string, unknown>
  let value: unknown = raw
  for (const segment of preset.credential.path) {
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[segment] : undefined
  }
  if (typeof value !== 'string' || value === '') {
    throw new Error(`No credential at ${preset.credential.file}#${preset.credential.path.join('.')}`)
  }
  return value
}

/**
 * Write the private credential home: the chosen provider plus a per-group skill root.
 *
 * The handbook must land where `SkillStore` actually reads user Skills. Production anchors that
 * at `piWebHome()`, which is `PI_WEB_HOME ?? ~/.pi-web`, so the caller points `PI_WEB_HOME` at the
 * isolated directory before `createRuntime`. Writing into `piDir` alone would silently load
 * nothing and make the `only-skill` group a false measurement.
 */
async function preparePiDir(root: string, withHandbook: boolean, preset: ModelPreset): Promise<string> {
  const apiKey = await readApiKey(preset)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'models.json'), JSON.stringify({
    providers: {
      [preset.id]: {
        baseUrl: preset.baseUrl,
        api: 'openai-completions',
        apiKey,
        compat: preset.compat,
        models: [{
          id: preset.modelId,
          name: preset.name,
          reasoning: true,
          input: ['text'],
          contextWindow: preset.contextWindow,
          maxTokens: preset.maxTokens,
          thinkingLevelMap: { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' },
        }],
      },
    },
  }, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(root, 'settings.json'), JSON.stringify({
    defaultProvider: preset.id,
    defaultModel: preset.modelId,
    defaultThinkingLevel: THINKING_LEVEL,
  }, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(root, 'auth.json'), JSON.stringify({ [preset.id]: { type: 'apiKey', key: apiKey } }, null, 2) + '\n', { mode: 0o600 })
  if (withHandbook) {
    await mkdir(join(root, 'skills', 'codemode-search'), { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'skills', 'codemode-search', 'SKILL.md'), HANDBOOK, { mode: 0o600 })
  }
  return root
}

function textOf(message: { blocks?: { type: string; text?: string }[] }): string {
  return (message.blocks ?? []).flatMap(block => (block.type === 'text' && block.text ? [block.text] : [])).join('\n')
}

async function runOne(group: GroupName, task: Task, preset: ModelPreset): Promise<RunMetrics> {
  const directory = await mkdtemp(join(tmpdir(), `pi-web-bench-${group}-`))
  const piDir = await preparePiDir(join(directory, 'pi'), group === 'only-skill', preset)
  // `SkillStore` reads its global root from `piWebHome()`, so isolating the Skill root means
  // pointing the app home at this run's directory. Set before the runtime is created.
  const previousHome = process.env.PI_WEB_HOME
  process.env.PI_WEB_HOME = piDir
  const runtime = await createRuntime({ dataDir: piDir, workspace: process.cwd(), piDir })
  const started = Date.now()
  try {
    // Code mode is a global setting, so every run gets its own runtime and its own dataDir.
    await runtime.updateSettings({ codemodeMode: group === 'on' ? 'on' : 'only' } as never)
    const catalog = await runtime.catalog()
    if (!catalog.defaultModel) throw new Error('The isolated model catalog has no default model')
    const conversation = await runtime.create({
      title: `bench ${group} ${task.id}`,
      model: catalog.defaultModel,
      // Read-only keeps every search tool plus codemode and blocks all writes to this repository.
      accessMode: 'readOnly',
    })
    const conversationId = conversation.conversation.id
    // Fail loudly when the handbook is not where the Skill store looks: a silently missing
    // Skill would turn `only-skill` into a duplicate of `only` plus a wasted lookup.
    if (group === 'only-skill') {
      const workspaceId = conversation.conversation.workspaceId
      if (workspaceId === undefined) throw new Error('The conversation has no workspace, so Skills cannot be listed')
      const catalogSkills = await runtime.skills(workspaceId)
      if (!catalogSkills.skills.some(skill => skill.name === 'codemode-search')) {
        throw new Error('The codemode-search handbook was not discovered by the Skill store')
      }
    }
    // A handbook group reads the Skill first, exactly like a user asking the model to follow it.
    const text = group === 'only-skill'
      ? `先用 skill_load 读取 codemode-search 这个技能并遵守它，然后回答下面的问题。\n\n${task.prompt}`
      : task.prompt
    await runtime.submit(conversationId, { requestId: randomUUID(), text })

    const deadline = Date.now() + TURN_DEADLINE_MS
    let detail = await runtime.detail(conversationId)
    while (Date.now() < deadline) {
      detail = await runtime.detail(conversationId)
      if (detail.error) throw new Error(detail.error)
      if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) break
      await delay(250)
    }

    const toolResults = detail.messages.filter(message => message.role === 'tool')
    const toolNames: Record<string, number> = {}
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let toolOutputChars = 0
    let rounds = 0
    const readPaths = new Set<string>()
    for (const message of detail.messages) {
      if (message.role === 'assistant') {
        rounds += 1
        inputTokens += message.usage?.input ?? 0
        outputTokens += message.usage?.output ?? 0
        cacheReadTokens += message.usage?.cacheRead ?? 0
        for (const block of message.blocks ?? []) {
          if (block.type !== 'toolCall') continue
          toolNames[block.name] = (toolNames[block.name] ?? 0) + 1
          // A script may open a file through a nested call, so the script source counts too.
          if (block.name === 'read') {
            const path = (block.arguments as { path?: unknown }).path
            if (typeof path === 'string') readPaths.add(path)
          }
          if (block.name === 'codemode') {
            const code = (block.arguments as { code?: unknown }).code
            if (typeof code === 'string') {
              for (const match of code.matchAll(/tools\.read\(\s*\{\s*path:\s*["'`]([^"'`]+)["'`]/g)) readPaths.add(match[1])
            }
          }
        }
      }
      if (message.role === 'tool') {
        toolOutputChars += (message.blocks ?? []).reduce((sum, block) => sum + (block.type === 'text' && block.text ? block.text.length : 0), 0)
        if (message.details) {
          const nested = (message.details as { calls?: { name?: string; path?: string }[] }).calls
          if (Array.isArray(nested)) {
            for (const call of nested) {
              if (call.name) toolNames[`codemode>${call.name}`] = (toolNames[`codemode>${call.name}`] ?? 0) + 1
            }
          }
        }
      }
    }

    const answers = detail.messages.filter(message => message.role === 'assistant' && !message.streaming)
    const finalAnswer = answers.length === 0 ? '' : textOf(answers[answers.length - 1]!)
    // "Located the file" counts either as having opened it or as naming it in the answer; a
    // correct answer that never needed the file body is still a correct search result.
    const normalized = [...readPaths].map(path => path.replace(/^\.\//, ''))
    const located = (golden: string) => normalized.some(path => path.endsWith(golden)) || finalAnswer.includes(golden)
    const correct = task.expectedAbsent !== undefined
      ? task.expectedAbsent.test(finalAnswer)
      : task.golden.length === 0 || task.golden.some(located)
    const ok = !detail.conversation.busy && answers.length > 0
    return {
      group, task: task.id, ok, correct,
      inputTokens, outputTokens, cacheReadTokens, toolOutputChars,
      toolCalls: toolResults.length,
      toolNames, rounds,
      durationMs: Date.now() - started,
      noTools: toolResults.length === 0,
      finalAnswer: finalAnswer.slice(0, 1_200),
    }
  } catch (error) {
    return {
      group, task: task.id, ok: false, correct: false,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, toolOutputChars: 0,
      toolCalls: 0, toolNames: {}, rounds: 0,
      durationMs: Date.now() - started,
      noTools: true,
      error: error instanceof Error ? error.message : String(error),
      finalAnswer: '',
    }
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.PI_WEB_HOME
    else process.env.PI_WEB_HOME = previousHome
  }
}

function summarize(runs: RunMetrics[]) {
  const groups = [...new Set(runs.map(run => run.group))]
  return groups.map(group => {
    const rows = runs.filter(run => run.group === group)
    const sum = (pick: (run: RunMetrics) => number) => rows.reduce((total, run) => total + pick(run), 0)
    return {
      group,
      runs: rows.length,
      completed: rows.filter(run => run.ok).length,
      correct: rows.filter(run => run.correct).length,
      /** Net prompt tokens after subtracting cache reads; the billed-at-full-price part. */
      totalInputTokens: sum(run => run.inputTokens),
      /** Cached prompt tokens; billed at the cache rate and not comparable across runs. */
      totalCacheRead: sum(run => run.cacheReadTokens),
      /**
       * Prompt size the model actually processed. This is the number to compare groups on:
       * `input` alone swings with cache hits the harness cannot control.
       */
      totalPromptTokens: sum(run => run.inputTokens + run.cacheReadTokens),
      totalOutputTokens: sum(run => run.outputTokens),
      totalToolOutputChars: sum(run => run.toolOutputChars),
      totalToolCalls: sum(run => run.toolCalls),
      totalRounds: sum(run => run.rounds),
      totalDurationMs: sum(run => run.durationMs),
      failed: rows.filter(run => run.error !== undefined).map(run => `${run.task}: ${run.error}`),
    }
  })
}

const { tasks, groups, preset } = parseArgs()
const runs: RunMetrics[] = []
for (const group of groups) {
  for (const task of TASKS.slice(0, tasks)) {
    process.stderr.write(`[${group}] ${task.id} … `)
    const metrics = await runOne(group, task, preset)
    process.stderr.write(`${metrics.ok ? 'ok' : 'FAIL'} correct=${metrics.correct} in=${metrics.inputTokens} out=${metrics.outputTokens} tools=${metrics.toolCalls}\n`)
    runs.push(metrics)
  }
}

const summary = summarize(runs)
await mkdir('artifacts', { recursive: true })
const payload = { ranAt: new Date().toISOString(), model: `${preset.id}/${preset.modelId}`, tasks: TASKS.slice(0, tasks).map(task => task.id), summary, runs }
await writeFile('artifacts/live-codemode-search-bench.json', JSON.stringify(payload, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
