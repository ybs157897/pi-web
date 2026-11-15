// A/B 对照实验：个性化指令把 reasoning 固定为中文 vs 英文 vs 不加指令。
// 每组一个隔离 dataDir（写入 <dataDir>/AGENTS.md 个性化文件），组内每题独立会话，
// 模型与 thinkingLevel 固定，判分全部本地程序化，指标含 thinking 语言占比与 token 用量。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'

// 思考档位（--thinking 可指定）；实验里各档固定，组间唯一变量是个性化指令内容。
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ---- 任务集：全部有唯一客观答案，可本地判分 ----

/** 单个实验任务：题面 prompt + 本地判分函数 judge（从最终回答文本或抽取的代码块判定）。 */
interface Task {
  id: string
  prompt: string
  judge: (text: string, code: string) => { pass: boolean; note: string }
}

/**
 * 从回答文本里抽出最后一个可解析的 JSON 对象。
 * @param text 模型最终回答全文。
 * @returns 最后一个能 JSON.parse 成功的 `{...}` 片段；一个都解析不了时返回 undefined。
 * 内部逻辑：正则抓所有不含嵌套花括号的 `{...}` 片段，从后往前逐个尝试解析——模型常先输出格式示例
 * 再输出真答案，取最后一个可解析的更贴近真实答案。
 */
function lastJson(text: string): Record<string, unknown> | undefined {
  const matches = text.match(/\{[^{}]*\}/g) ?? []
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i]) as Record<string, unknown>
    } catch {
      // 继续向前找
    }
  }
  return undefined
}

/**
 * 抽取回答里最后一个「答案：<数字>」的数值（t1 数学题专用）。
 * @param text 模型最终回答全文。
 * @returns 最后一个匹配的数字；没有匹配时返回 undefined（判为不通过）。
 * 内部逻辑：matchAll 找所有 `答案[：:]\s*([0-9.]+)`，取最后一个的捕获组转 Number。
 */
function lastNumberAfterAnswer(text: string): number | undefined {
  const matches = [...text.matchAll(/答案[：:]\s*([0-9.]+)/g)]
  const last = matches.at(-1)?.[1]
  return last === undefined ? undefined : Number(last)
}

const TASKS: Task[] = [
  // t1：两位数方程组（唯一答案 3168），从「答案：<数字>」行判分。
  {
    id: 't1-math',
    prompt: [
      '某仓库有 A、B 两种货箱共 156 个。A 箱每箱装 24 件货，B 箱每箱装 18 件货。',
      '已知 A 箱数量的 2 倍比 B 箱数量多 24。',
      '问：所有货箱一共装了多少件货？请给出推理过程，最后一行输出「答案：<数字>」。',
      '不要调用任何工具，直接用文字推理作答。',
    ].join('\n'),
    judge: text => {
      const n = lastNumberAfterAnswer(text)
      return { pass: n === 3168, note: `answer=${n ?? 'none'} expected=3168` }
    },
  },
  // t2：四人四城市逻辑推理（唯一解），从最后一个可解析 JSON 判分。
  {
    id: 't2-logic',
    prompt: [
      '林、周、吴、郑四个人，每人恰好去了成都、杭州、西安、武汉四个城市中的一个，且互不相同。',
      '已知：',
      '1. 林没去武汉，也没去西安。',
      '2. 周既没去杭州，也没去成都。',
      '3. 去西安的人是吴或郑。',
      '4. 吴没去杭州。',
      '5. 郑没去武汉，也没去成都。',
      '6. 吴的行程里包含参观兵马俑（兵马俑位于西安）。',
      '请推理每人去了哪个城市，最后一行输出 JSON，格式如 {"林":"城市","周":"城市","吴":"城市","郑":"城市"}。',
      '不要调用任何工具，直接用文字推理作答。',
    ].join('\n'),
    judge: text => {
      const j = lastJson(text)
      const expected = { 林: '成都', 周: '武汉', 吴: '西安', 郑: '杭州' }
      if (!j) return { pass: false, note: 'no-json' }
      const got = ['林', '周', '吴', '郑'].map(k => `${k}=${j[k] ?? '?'}`).join(' ')
      const pass = ['林', '周', '吴', '郑'].every(k => j[k] === expected[k as keyof typeof expected])
      return { pass, note: `${got} expected=林成都 周武汉 吴西安 郑杭州` }
    },
  },
  // t3：括号平衡（含 * 通配）算法题——抽出 ```javascript 代码块，spawnSync 用 node 实际运行
  // 10 组用例的 harness，以退出码判分；无代码块直接判不通过。
  {
    id: 't3-code',
    prompt: [
      '实现一个 JavaScript 函数 countBalanced(s)：s 仅由字符 ( ) * 组成，* 可以充当 ( 、) 或空字符串。',
      '若 s 能被解析为平衡的括号串则返回 true，否则返回 false。',
      '只输出一个 ```javascript 代码块（函数定义），不要输出解释文字，不要调用任何工具。',
    ].join('\n'),
    judge: (_text, code) => {
      if (!code) return { pass: false, note: 'no-code-block' }
      const cases: Array<[string, boolean]> = [
        ['', true],
        ['(*)', true],
        ['(*))', true],
        [')(', false],
        ['(*)*', true],
        ['(((*)', false],
        ['*(', false],
        ['**)(', false],
        ['*(**)*', true],
        ['(*)(', false],
      ]
      const harness = `${code}\n;const cases=${JSON.stringify(cases)};const fails=[];for(const [s,ex] of cases){let got;try{got=countBalanced(s)}catch(e){got='ERR:'+e.message}if(got!==ex)fails.push(s+'=>'+got+' expected:'+ex)};console.log(fails.length===0?'ALL_PASS':fails.join('|'));process.exit(fails.length===0?0:1)`
      const r = spawnSync('node', ['-e', harness], { encoding: 'utf8', timeout: 15_000 })
      const out = (r.stdout + r.stderr).trim().slice(0, 200)
      return { pass: r.status === 0, note: out || `exit=${r.status}` }
    },
  },
  // t4：数「的」字次数与总字数（唯一答案 de=3、total=59），从 JSON 判分。
  {
    id: 't4-count',
    prompt: [
      '仔细数一数下面这段话里「的」字出现的次数，以及总字数（包含标点符号）：',
      '「我们在湖边散步时，看见远处的山峦在夕阳的余晖里渐渐变得模糊，水面上倒映的树影也随着微风轻轻晃动，让人不由得放慢了脚步。」',
      '最后一行输出 JSON，格式如 {"de": 次数, "total": 总字数}。',
      '不要调用任何工具，直接数。',
    ].join('\n'),
    judge: text => {
      const j = lastJson(text)
      if (!j) return { pass: false, note: 'no-json' }
      const pass = j.de === 3 && j.total === 59
      return { pass, note: `de=${j.de} total=${j.total} expected de=3 total=59` }
    },
  },
  // t5：五会议排程约束满足（唯一可行安排），从 JSON 判分。
  {
    id: 't5-schedule',
    prompt: [
      '周五要安排 5 场会议 A、B、C、D、E，时间槽按顺序编号 1-5：1=09:00-10:00、2=10:30-11:30、3=13:00-14:00、4=14:30-15:30、5=16:00-17:00，每槽恰好一场。',
      '约束：',
      '1. A 必须安排在上午（槽 1 或槽 2）。',
      '2. B 必须紧接在 A 之后的下一个槽。',
      '3. C 必须用上午槽（槽 1 或槽 2）。',
      '4. D 不能用上午槽。',
      '5. E 必须用最后一槽（槽 5）。',
      '求唯一可行安排。最后一行输出 JSON，格式如 {"A":槽号,"B":槽号,"C":槽号,"D":槽号,"E":槽号}。',
      '不要调用任何工具，直接用文字推理作答。',
    ].join('\n'),
    judge: text => {
      const j = lastJson(text) as Record<string, unknown> | undefined
      const expected: Record<string, number> = { A: 2, B: 3, C: 1, D: 4, E: 5 }
      if (!j) return { pass: false, note: 'no-json' }
      const pass = Object.keys(expected).every(k => j[k] === expected[k])
      const got = Object.keys(expected).map(k => `${k}=${j[k] ?? '?'}`).join(' ')
      return { pass, note: `${got} expected=A2 B3 C1 D4 E5` }
    },
  },
]

// ---- 分组 ----

/**
 * 三组实验配置：注入的个性化文件内容即组间唯一变量。
 * zh——中文思考指令；en——语义对齐的英文指令；control——不写个性化文件（模型默认行为）。
 * 值为 undefined 的组不写 <dataDir>/AGENTS.md，renderPersonalization 对缺失文件贡献零字节。
 */
const GROUPS = {
  zh: '思考（reasoning）全程使用中文；代码标识符、文件路径、命令、专有名词保留原文。',
  en: 'Your reasoning (thinking) must be written entirely in English. Keep code identifiers, file paths, commands, and proper nouns unchanged.',
  control: undefined, // 不写个性化文件
} as const

type GroupId = keyof typeof GROUPS

// ---- 指标 ----

/**
 * 统计思考文本的语言构成。
 * @param text thinking 块全文。
 * @returns han——汉字（\\p{Script=Han}）数量；nonSpace——去空白后的总字符数；ratio——汉字占比。
 * 内部逻辑：占比以「去空白字符」为分母，数学符号/英文标记会稀释 ratio，解读时结合 preview 判断。
 */
function zhStats(text: string): { han: number; nonSpace: number; ratio: number } {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  const nonSpace = text.replace(/\s+/g, '').length
  return { han, nonSpace, ratio: nonSpace === 0 ? 0 : han / nonSpace }
}

// ---- 主流程 ----

/**
 * 读取命令行参数值。
 * @param name 形如 `--runs` 的参数名。
 * @returns 其后的值；未提供时返回 undefined（由调用方给默认值）。
 */
function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const groupArg = argOf('--groups')
const taskArg = argOf('--tasks')
const runsArg = Number(argOf('--runs') ?? '2')
const groups = (groupArg ? (groupArg.split(',') as GroupId[]) : Object.keys(GROUPS) as GroupId[])
const tasks = taskArg ? taskArg.split(',') : TASKS.map(t => t.id)
const modelOverride = argOf('--model')
const thinkingLevel = (argOf('--thinking') ?? 'max') as ThinkingLevel

// 全部运行结果行：每行是一次「组×题×轮」的完整观测，finally 后按组汇总并落盘 artifacts。
const rows: Array<Record<string, unknown>> = []

// 主循环：按组遍历。每组一个独立 tmpdir（dataDir 隔离 + 写入该组的个性化文件）和一个完整
// createRuntime；piDir 显式指向全局 home，凭据从 ~/.pi-web 读取（隔离 dataDir 自身没有凭据）。
// 组内每题每轮一个全新会话，保证上下文互不污染。
for (const group of groups) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-lang-ab-'))
  const dataDir = join(dir, 'data')
  const workspace = join(dir, 'ws')
  await mkdir(dataDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  if (GROUPS[group] !== undefined) {
    await writeFile(join(dataDir, 'AGENTS.md'), GROUPS[group], { encoding: 'utf8' })
  }
  const runtime = await createRuntime({ dataDir, workspace, piDir: piWebHome() })
  try {
    const catalog = await runtime.catalog()
    if (!catalog.defaultModel) throw new Error('未配置默认模型')
    const defaultRef = catalog.defaultModel as { provider: string; modelId: string }
    const model = modelOverride
      ? (() => {
          // modelId 本身可能含斜杠（如 deepseek/deepseek-v4.1-flash），只切第一个分隔符
          const slash = modelOverride.indexOf('/')
          if (slash <= 0) throw new Error('--model 需要 provider/modelId 格式')
          return { provider: modelOverride.slice(0, slash), modelId: modelOverride.slice(slash + 1) }
        })()
      : defaultRef
    for (const task of TASKS.filter(t => tasks.includes(t.id))) {
      for (let run = 1; run <= runsArg; run++) {
        const created = await runtime.create({ model, thinkingLevel })
        const started = Date.now()
        await runtime.submit(created.conversation.id, { text: task.prompt, requestId: randomUUID() })
        const deadline = Date.now() + 300_000
        let answerText = ''
        let thinkingText = ''
        let usage: { input: number; output: number } | undefined
        let durationMs: number | undefined
        let requestDurationMs: number | undefined
        let error: string | undefined
        let toolCalls = 0
        while (Date.now() < deadline) {
          const detail = await runtime.detail(created.conversation.id)
          if (detail.error) { error = detail.error; break }
          // busy 为 false 表示本轮生成结束：取最后一条 assistant 消息的文本/thinking/usage。
          // host DTO 的 assistant 消息 requestId 为 null，多轮下只能按「最后一条」定位。
          if (!detail.conversation.busy) {
            const assistant = detail.messages.filter(m => m.role === 'assistant').at(-1)
            if (assistant) {
              answerText = assistant.blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
              thinkingText = assistant.blocks.filter(b => b.type === 'thinking').map(b => (b as { text: string }).text).join('')
              usage = assistant.usage ? { input: assistant.usage.input, output: assistant.usage.output } : undefined
              durationMs = assistant.durationMs
              requestDurationMs = assistant.requestDurationMs
            }
            toolCalls = detail.messages.filter(m => m.role === 'tool' || m.blocks?.some(b => b.type === 'toolCall')).length
            break
          }
          await delay(300)
        }
        if (!error && !answerText) error = 'timeout-300s'
        // 代码题抽代码块
        let code = ''
        const codeMatch = answerText.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/)
        if (codeMatch) code = codeMatch[1]
        const verdict = error ? { pass: false, note: error } : task.judge(answerText, code)
        const zh = zhStats(thinkingText)
        const row = {
          group,
          task: task.id,
          run,
          model: typeof model === 'string' ? model : `${model.provider}/${model.modelId}`,
          thinkingLevel,
          pass: verdict.pass,
          note: verdict.note,
          thinkingHanRatio: Number(zh.ratio.toFixed(3)),
          thinkingHan: zh.han,
          thinkingChars: zh.nonSpace,
          thinkingPreview: thinkingText.slice(0, 220),
          answerPreview: answerText.slice(0, 600),
          answerChars: answerText.length,
          inputTokens: usage?.input,
          outputTokens: usage?.output,
          durationMs,
          ttftMs: durationMs !== undefined && requestDurationMs !== undefined ? durationMs - requestDurationMs : undefined,
          toolCalls,
          wallMs: Date.now() - started,
        }
        rows.push(row)
        console.log(JSON.stringify(row))
      }
    }
  } finally {
    await runtime.close()
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 汇总一组（或一题）的运行结果。
 * @param subset 同组（或同题）的行集合。
 * @returns n——样本数；passRate——判分通过率；medianOutputTokens / medianDurationMs /
 * medianThinkingRatio——三个指标的中位数（排序取中点，不剔除离群值）。
 */
const summarize = (subset: typeof rows) => {
  const passes = subset.filter(r => r.pass === true).length
  const tok = subset.filter(r => typeof r.outputTokens === 'number')
  const dur = subset.filter(r => typeof r.durationMs === 'number')
  return {
    n: subset.length,
    passRate: subset.length ? Number((passes / subset.length).toFixed(3)) : 0,
    medianOutputTokens: tok.length ? [...tok].sort((a, b) => (a.outputTokens as number) - (b.outputTokens as number))[Math.floor(tok.length / 2)].outputTokens : undefined,
    medianDurationMs: dur.length ? [...dur].sort((a, b) => (a.durationMs as number) - (b.durationMs as number))[Math.floor(dur.length / 2)].durationMs : undefined,
    medianThinkingRatio: subset.length ? [...subset].sort((a, b) => (a.thinkingHanRatio as number) - (b.thinkingHanRatio as number))[Math.floor(subset.length / 2)].thinkingHanRatio : undefined,
  }
}
console.log('--- summary ---')
for (const group of groups) {
  const subset = rows.filter(r => r.group === group)
  console.log(JSON.stringify({ group, overall: summarize(subset), byTask: Object.fromEntries([...new Set(subset.map(r => r.task))].map(t => [t, summarize(subset.filter(r => r.task === t))])) }))
}

await mkdir('artifacts', { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await writeFile(`artifacts/reasoning-lang-ab-${stamp}.json`, JSON.stringify({ groups, tasks, thinkingLevel, rows, summary: groups.map(group => ({ group, overall: summarize(rows.filter(r => r.group === group)) })) }, null, 2) + '\n')
console.log(`saved artifacts/reasoning-lang-ab-${stamp}.json`)
