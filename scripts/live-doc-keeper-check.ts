// Live acceptance for doc-keeper: check（无模型）+ refresh（真实模型）闭环 + 进程内 A2A 任务流。
// Requires real model credentials; a failure here means "not verified", never "passed".
//
// 用法（隔离数据目录 + CommandCode 示例）：
//   PI_WEB_DATA_DIR=/tmp/pi-web-bot-ui/data \
//   PI_WEB_DOC_KEEPER_MODEL='commandcode/deepseek/deepseek-v4.1-flash' \
//   npx tsx scripts/live-doc-keeper-check.ts
//
// 凭据从 PI_WEB_PI_DIR ?? PI_WEB_DATA_DIR ?? piWebHome() 读取；会话数据落在临时目录，
// 不碰用户真实数据。PI_WEB_DOC_KEEPER_MODEL 按第一个 '/' 拆分 provider/modelId
// （modelId 本身可含 '/'，如 deepseek/deepseek-v4.1-flash）。
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRuntime } from '../src/server/runtime/index.ts'
import { createDocKeeperAgent } from '../src/server/doc-keeper/a2a.ts'
import { parseFrontmatter } from '../src/server/bots/docs.ts'
import { piWebHome } from '../src/server/state/home.ts'

const run = promisify(execFile)
const log = (...parts: unknown[]) => console.log('[live-doc-keeper]', ...parts)

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} 未在 ${ms / 1000}s 内完成`)), ms).unref()),
  ])
}

const dir = await mkdtemp(join(tmpdir(), 'pi-web-live-doc-keeper-'))
// 样例项目：知识文档的描述故意落后于代码（api.ts 实际用 express，文档说 http.createServer），
// refresh 应当对照代码修正过时描述并追加 changelog。
const sampleFiles: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'sample-api', version: '0.1.0', type: 'module' }, null, 2),
  'src/server/api.ts': 'import express from "express"\nimport { load } from "./store.js"\nexport const app = express()\napp.get("/items", async (_req, res) => { res.json(await load()) })\n',
  'src/server/store.ts': 'import { readFile } from "node:fs/promises"\nexport async function load() {\n  return JSON.parse(await readFile("data/items.json", "utf8"))\n}\n',
  'README.md': '# sample-api\nA tiny demo project used to exercise doc-keeper.\n',
}
for (const [path, content] of Object.entries(sampleFiles)) {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFile(join(dir, path), content)
}
await run('git', ['init'], { cwd: dir })
await run('git', ['config', 'user.email', 'live-doc-keeper@example.com'], { cwd: dir })
await run('git', ['config', 'user.name', 'live-doc-keeper'], { cwd: dir })
await run('git', ['add', '.'], { cwd: dir })
await run('git', ['commit', '-m', 'init sample project'], { cwd: dir })
await writeFile(join(dir, 'src/server/api.ts'), 'import express from "express"\nimport { load } from "./store.js"\nexport const app = express()\napp.get("/items", async (_req, res) => { res.json(await load()) })\napp.get("/health", (_req, res) => { res.json({ ok: true }) })\n')
await run('git', ['add', '.'], { cwd: dir })
await run('git', ['commit', '-m', 'api: add /health endpoint'], { cwd: dir })

const knowledgePath = 'docs/bots/server.md'
const oldStamp = '2026-01-01T00:00:00.000Z'
const oldBody = [
  '## 职责', '', '- 负责 server 模块（关注路径：`src/**`）。', '',
  '## 关键文件', '', '- `src/server/api.ts`：用 http.createServer 起服务，只有 /items 路由。', '- `src/server/store.ts`：读取 data/items.json。', '',
  '## 已知坑', '', '- 暂无。', '',
  '## changelog', '', `- ${oldStamp} 由宿主创建骨架。`, '',
].join('\n')
await mkdir(join(dir, 'docs/bots'), { recursive: true })
await writeFile(join(dir, knowledgePath), `---\nbotId: server\nmodule: server\nglobs: ["src/**"]\nupdatedStamp: ${oldStamp}\n---\n${oldBody}`)

const piDir = process.env.PI_WEB_PI_DIR ?? process.env.PI_WEB_DATA_DIR ?? piWebHome()
const runtime = await createRuntime({ dataDir: join(dir, 'data'), workspace: dir, piDir })
try {
  const catalog = await runtime.catalog()
  const override = process.env.PI_WEB_DOC_KEEPER_MODEL
  let model = catalog.defaultModel
  if (override !== undefined && override.trim() !== '') {
    const slash = override.trim().indexOf('/')
    if (slash <= 0 || slash === override.trim().length - 1) throw new Error(`PI_WEB_DOC_KEEPER_MODEL 需要 provider/modelId 格式：${override}`)
    model = { provider: override.trim().slice(0, slash), modelId: override.trim().slice(slash + 1) }
    log('overriding default model with PI_WEB_DOC_KEEPER_MODEL:', model)
  }
  if (!model) throw new Error('当前未配置默认模型，请设置 PI_WEB_DOC_KEEPER_MODEL 或先配置模型')
  // 关掉后台记忆提取，避免额外模型调用消耗配额。
  await runtime.updateSettings({ memoryEnabled: false, defaultModel: model })
  log('model:', model)

  const globs = ['src/**']

  // S1 — check：无模型体检，应报 stale 且不改写。
  const before = await readFile(join(dir, knowledgePath), 'utf8')
  const check1 = await withTimeout(runtime.runDocKeeperMaintenance({ globs, knowledgePath, mode: 'check' }), 30_000, 'S1 check')
  if (check1.health !== 'stale') throw new Error(`S1 期望 stale，实际 ${check1.health}：${check1.detail}`)
  if (check1.commitCount < 1 || check1.updated) throw new Error(`S1 体检异常：${JSON.stringify(check1)}`)
  if (await readFile(join(dir, knowledgePath), 'utf8') !== before) throw new Error('S1 check 改写了文档')
  log(`S1 check ok: health=${check1.health}, commits=${check1.commitCount}, files=${check1.changedFiles.join(',')}`)

  // S2 — refresh：真实模型驱动五工具增量写回。
  const refresh = await withTimeout(
    runtime.runDocKeeperMaintenance({ globs, knowledgePath, mode: 'refresh', model }),
    6 * 60_000, 'S2 refresh',
  )
  if (refresh.error) throw new Error(`S2 refresh 会话错误：${refresh.error}`)
  if (!refresh.updated) throw new Error(`S2 文档未更新：health=${refresh.health}，report=${refresh.report ?? '(无)'}`)
  if (refresh.health !== 'fresh') throw new Error(`S2 刷新后应 fresh，实际 ${refresh.health}：${refresh.detail}`)
  const after = await readFile(join(dir, knowledgePath), 'utf8')
  if (!after.includes('botId: server') || !after.includes('globs: ["src/**"]')) throw new Error('S2 frontmatter 未保留')
  // 只查 frontmatter 的 updatedStamp：正文 changelog 按提示词保留历史条目，旧 stamp 可合法出现在正文。
  const afterStamp = parseFrontmatter(after)?.updatedStamp
  if (afterStamp === undefined || afterStamp === oldStamp) throw new Error(`S2 updatedStamp 未更新：${afterStamp ?? '(缺失)'}`)
  log(`S2 refresh ok: health=${refresh.health}, hash=${refresh.hash?.slice(0, 12)}…, report="${(refresh.report ?? '').slice(0, 120).replace(/\n/g, ' ')}…"`)

  // S3 — 再 check：stamp 已追上代码，应 fresh 零变更。
  const check2 = await withTimeout(runtime.runDocKeeperMaintenance({ globs, knowledgePath, mode: 'check' }), 30_000, 'S3 check')
  if (check2.health !== 'fresh' || check2.commitCount !== 0) throw new Error(`S3 期望 fresh/0，实际 ${check2.health}/${check2.commitCount}`)
  log('S3 re-check ok: fresh, 0 commits')

  // S4 — 进程内 A2A 端点：Agent Card + sendMaintenance 任务流（内置智能体，无 HTTP 监听）。
  const agent = createDocKeeperAgent({ runMaintenance: runtime.runDocKeeperMaintenance })
  const card = await agent.requestHandler.getAgentCard()
  if (card.name !== 'doc-keeper' || card.skills?.[0]?.id !== 'knowledge_doc_maintenance') throw new Error(`S4 Agent Card 内容异常：${JSON.stringify(card)}`)
  const a2aResult = await withTimeout(agent.sendMaintenance({ globs, knowledgePath, mode: 'check' }), 30_000, 'S4 a2a check')
  if (a2aResult.health !== 'fresh') throw new Error(`S4 artifact 异常：${JSON.stringify(a2aResult)}`)
  log('S4 in-process a2a ok: card discovered, sendMaintenance completed')

  const evidence = {
    verifiedAt: new Date().toISOString(),
    model,
    check1: { health: check1.health, commitCount: check1.commitCount, changedFiles: check1.changedFiles },
    refresh: { health: refresh.health, updated: refresh.updated, hash: refresh.hash, report: (refresh.report ?? '').slice(0, 600) },
    check2: { health: check2.health, commitCount: check2.commitCount },
    a2a: { url: card.supportedInterfaces[0]?.url, cardName: card.name, artifactHealth: a2aResult.health },
    result: 'passed',
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-doc-keeper.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ verifiedAt: evidence.verifiedAt, result: evidence.result, model, refreshUpdated: refresh.updated }))
} finally {
  await runtime.close()
  await rm(dir, { recursive: true, force: true })
}
