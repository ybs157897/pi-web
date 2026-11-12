// Live acceptance for the module-bot team prototype: model-driven init, room
// delegation with knowledge-doc write-back, and a watchdog pass. Requires real
// model credentials; a failure here means "not verified", never "passed".
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'

const run = promisify(execFile)
const log = (...parts: unknown[]) => console.log('[live-bots]', ...parts)

const dir = await mkdtemp(join(tmpdir(), 'pi-web-live-bots-'))
// A small sample project so the orchestrator has real directories to split into
// modules and the watchdog has a git history to compare stamps against.
const sampleFiles: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'sample-cli', version: '0.1.0', bin: { sample: './cli/main.js' } }, null, 2),
  'cli/main.js': '#!/usr/bin/env node\nimport { load } from "../store/index.js"\nimport { render } from "../lib/render.js"\nconst data = load(process.argv[2] ?? "default")\nrender(data)\n',
  'cli/args.js': 'export function parseArgs(argv) {\n  const [command, ...rest] = argv\n  return { command, flags: rest }\n}\n',
  'store/index.js': 'import { readFileSync } from "node:fs"\nexport function load(name) {\n  return JSON.parse(readFileSync(`data/${name}.json`, "utf8"))\n}\n',
  'store/format.js': 'export function normalize(record) {\n  return { ...record, loadedAt: new Date().toISOString() }\n}\n',
  'lib/render.js': 'export function render(data) {\n  console.log("== sample ==");\n  for (const [key, value] of Object.entries(data)) console.log(`${key}: ${value}`)\n}\n',
  'lib/theme.js': 'export const theme = { width: 40, marker: "-" }\n',
  'README.md': '# sample-cli\nA tiny demo project used to exercise module splitting.\n',
}
for (const [path, content] of Object.entries(sampleFiles)) {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFile(join(dir, path), content)
}
await run('git', ['init'], { cwd: dir })
await run('git', ['add', '.'], { cwd: dir })
await run('git', ['-c', 'user.name=live-bots', '-c', 'user.email=live-bots@example.com', 'commit', '-m', 'init sample project'], { cwd: dir })

const runtime = await createRuntime({ dataDir: join(dir, 'data'), workspace: dir, piDir: piWebHome() })
try {
  const catalog = await runtime.catalog()
  if (!catalog.defaultModel) throw new Error('当前 Pi 未配置默认模型，请先配置模型后重试')
  // PI_WEB_BOTS_MODEL=provider/modelId overrides the default model, e.g. to dodge a
  // rate-limited provider without touching global settings.
  const override = process.env.PI_WEB_BOTS_MODEL
  let model = catalog.defaultModel
  if (override !== undefined && override.trim() !== '') {
    const [provider, modelId] = override.trim().split('/', 2)
    if (provider === undefined || modelId === undefined) throw new Error(`PI_WEB_BOTS_MODEL 需要 provider/modelId 格式：${override}`)
    model = { provider, modelId }
    await runtime.updateSettings({ defaultModel: model })
    log('overriding default model with PI_WEB_BOTS_MODEL:', model)
  }
  log('default model:', model)

  // S1 — orchestrator init: model-driven module split, one bot + knowledge doc each.
  await runtime.initBots({ mode: 'orchestrator' })
  const initDeadline = Date.now() + 8 * 60_000
  let overview = await runtime.bots()
  while (overview.init.running && Date.now() < initDeadline) {
    await delay(3000)
    overview = await runtime.bots()
  }
  if (overview.init.running) throw new Error('orchestrator init 未在 8 分钟内完成')
  if (overview.init.error) throw new Error(`orchestrator init 失败：${overview.init.error}`)
  const bots = overview.bots
  if (bots.length < 2 || bots.length > 6) throw new Error(`orchestrator 应切出 2-6 个模块 bot，实际 ${bots.length}`)
  const docsOnDisk = await readdir(join(dir, 'docs', 'bots')).catch(() => [])
  if (docsOnDisk.length < bots.length) throw new Error(`知识文档缺失：期望 >=${bots.length} 个，实际 ${docsOnDisk.join(', ') || '(none)'}`)
  log(`S1 init ok: ${bots.length} bots (${bots.map(bot => `${bot.name}:${bot.module}`).join(', ')}), docs: ${docsOnDisk.join(', ')}`)

  // S2 — room delegation: @ a bot, wait for its reply in the room log and the
  // knowledge-doc write-back to settle as complied.
  const target = bots[0]
  let room = overview.rooms[0]
  if (!room) {
    const created = await runtime.createBotRoom({ name: '全队', memberIds: bots.map(bot => bot.id) })
    room = created.room
  }
  const question = `@${target.name} 请用两三句话介绍你负责的模块（${target.module}）的职责和关键文件。`
  const posted = await runtime.postBotRoom(room.id, { text: question })
  if (!posted.mentioned.includes(target.name)) throw new Error(`@提及未解析到 ${target.name}：${JSON.stringify(posted)}`)
  const replyDeadline = Date.now() + 5 * 60_000
  let replyText: string | undefined
  while (Date.now() < replyDeadline) {
    const frames = await runtime.botRoomLog(room.id)
    const reply = frames.find(frame => frame.sender.kind === 'bot' && frame.sender.name === target.name && frame.text.trim() !== '')
    if (reply) { replyText = reply.text; break }
    await delay(3000)
  }
  if (!replyText) throw new Error(`${target.name} 未在 5 分钟内于 room 回复`)
  if (/^\s*[\[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(replyText.trim())) throw new Error(`回复是 [PASS]：${replyText}`)
  let compliance = ''
  const settleDeadline = Date.now() + 90_000
  while (Date.now() < settleDeadline) {
    const current = (await runtime.bots()).bots.find(bot => bot.id === target.id)
    if (current?.compliance === 'complied') { compliance = current.compliance; break }
    if (current?.compliance === 'stalled') throw new Error(`${target.name} 回复后未回写知识文档（stalled）`)
    await delay(3000)
  }
  if (!compliance) throw new Error(`${target.name} compliance 未在 90 秒内结算`)
  log(`S2 room ok: reply "${replyText.slice(0, 80).replace(/\n/g, ' ')}…", compliance=${compliance}`)

  // S3 — watchdog: one manual pass must cover the whole roster.
  const { report } = await runtime.runBotWatchdog({})
  if (report.entries.length < bots.length) throw new Error(`watchdog 覆盖不全：${report.entries.length}/${bots.length}`)
  const healths = report.entries.map(entry => `${entry.botName}:${entry.health}`).join(', ')
  log(`S3 watchdog ok: ${healths}`)

  const evidence = {
    verifiedAt: new Date().toISOString(),
    model,
    init: { mode: 'orchestrator', bots: bots.map(bot => ({ name: bot.name, module: bot.module, globs: bot.globs, docs: docsOnDisk })) },
    room: { id: room.id, question, reply: replyText.slice(0, 400), compliance },
    watchdog: { runAt: report.runAt, healths },
    result: 'passed',
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-bots.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ verifiedAt: evidence.verifiedAt, result: evidence.result, bots: bots.length, healths }))
} finally {
  await runtime.close()
  await rm(dir, { recursive: true, force: true })
}
