// Live acceptance for memory governance: a real model extracts a fact and stamps textHash,
// then the dedup and non-resurrection gates hold on that real extracted fact.
// Requires real model credentials; a failure here means "not verified", never "passed".
//
// 用法（隔离数据目录 + CommandCode 示例）：
//   PI_WEB_DATA_DIR=/tmp/pi-web-bot-ui/data \
//   PI_WEB_MEMORY_MODEL='commandcode/deepseek/deepseek-v4.1-flash' \
//   npx tsx scripts/live-memory-check.ts
//
// 凭据从 PI_WEB_PI_DIR ?? PI_WEB_DATA_DIR ?? piWebHome() 读取；会话与记忆落在临时目录，
// 不碰用户真实数据。PI_WEB_MEMORY_MODEL 按第一个 '/' 拆分 provider/modelId。
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import { resolveMemoryRoot, readMemoryFile } from '../src/server/memory/store.ts'
import { scanMemoryManifest } from '../src/server/memory/extraction.ts'
import { gateWrite, recordDelete, memoryTextHash, readGovernanceLedger } from '../src/server/memory/governance.ts'

const log = (...parts: unknown[]) => console.log('[live-memory]', ...parts)

const dir = await mkdtemp(join(tmpdir(), 'pi-web-live-memory-'))
await writeFile(join(dir, 'README.md'), '# memory live sample\n')

const piDir = process.env.PI_WEB_PI_DIR ?? process.env.PI_WEB_DATA_DIR ?? piWebHome()
const dataDir = join(dir, 'data')
const runtime = await createRuntime({ dataDir, workspace: dir, piDir })
try {
  const catalog = await runtime.catalog()
  if (!catalog.defaultModel) throw new Error('当前未配置默认模型，请设置 PI_WEB_MEMORY_MODEL 或先配置模型')
  const override = process.env.PI_WEB_MEMORY_MODEL
  let model = catalog.defaultModel
  if (override !== undefined && override.trim() !== '') {
    const slash = override.trim().indexOf('/')
    if (slash <= 0 || slash === override.trim().length - 1) throw new Error(`PI_WEB_MEMORY_MODEL 需要 provider/modelId 格式：${override}`)
    model = { provider: override.trim().slice(0, slash), modelId: override.trim().slice(slash + 1) }
  }
  await runtime.updateSettings({ memoryEnabled: true, defaultModel: model })
  log('model:', model)

  // S1 — 真实模型把一条Distinctive事实存进持久记忆（直接写或后台提取），并盖 textHash。
  const created = await runtime.create({ model, thinkingLevel: 'off', accessMode: 'fullAccess' })
  const id = created.conversation.id
  const fact = '本项目的内部发布代号是 Phoenix-42，仅用于团队口头沟通，不要写进任何代码或文档。'
  await runtime.submit(id, { text: `请记住一个项目事实：${fact} 请把这条事实存进你的持久记忆。`, requestId: randomUUID() })
  const runDeadline = Date.now() + 3 * 60_000
  let busy = true
  while (Date.now() < runDeadline) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(`会话错误：${detail.error}`)
    busy = detail.conversation.busy
    if (!busy) break
    await delay(1000)
  }
  if (busy) throw new Error('真实模型未在 3 分钟内完成回合')

  const root = resolveMemoryRoot({ dataDir, workspacePath: created.conversation.cwd ?? dir })
  const extractDeadline = Date.now() + 3 * 60_000
  let manifest = await scanMemoryManifest(root)
  while (manifest.length === 0 && Date.now() < extractDeadline) {
    await delay(2000)
    manifest = await scanMemoryManifest(root)
  }
  if (manifest.length === 0) throw new Error('真实模型未在限时内存入任何记忆事实')
  // 模型输出非确定：可能写多个事实或个别 frontmatter 不可解析（治理 fail-open 不盖章）。
  // 选取一个已盖 textHash 的真实事实验证闸门，而非脆性要求最新一条。
  let factPath: string | undefined
  let factContent: string | undefined
  let hash: string | undefined
  let factFile: string | undefined
  for (const entry of manifest) {
    const path = join(root, entry.file)
    const record = await readMemoryFile(path)
    if (record.status !== 'loaded') continue
    const candidate = memoryTextHash(record.content)
    if (record.content.includes(candidate)) {
      factPath = path
      factContent = record.content
      hash = candidate
      factFile = entry.file
      break
    }
  }
  if (factPath === undefined || factContent === undefined || hash === undefined || factFile === undefined) {
    throw new Error(`真实模型存入的 ${manifest.length} 个事实均未盖 textHash：${manifest.map(entry => entry.file).join(', ')}`)
  }
  log(`S1 extract ok: ${manifest.length} fact(s), stamped ${factFile} textHash=${hash.slice(0, 12)}…`)

  // S2 — 去重门：同一正文写到另一路径应 dedup 到已有事实。
  const dup = await gateWrite(root, join(root, 'dup-check.md'), factContent)
  if (dup.action !== 'dedup') throw new Error(`去重门未命中：${JSON.stringify(dup)}`)
  log('S2 dedup ok:', dup.file)

  // S3 — 非复活门：墓碑后再写同一正文应被拒绝并回显删除者/原因。
  await recordDelete(root, factPath, 'live-memory-check', 'live 验收删除')
  const resurrect = await gateWrite(root, factPath, factContent)
  if (resurrect.action !== 'reject') throw new Error(`非复活门未拒绝：${JSON.stringify(resurrect)}`)
  const ledger = await readGovernanceLedger(root)
  if (!ledger.tombstones.some(tombstone => tombstone.hash === hash)) throw new Error('治理台账未记录墓碑')
  log('S3 non-resurrection ok:', resurrect.reason)

  const evidence = {
    verifiedAt: new Date().toISOString(),
    model,
    fact: factFile,
    textHash: hash,
    dedup: dup.action,
    resurrect: resurrect.action,
    result: 'passed',
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-memory.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ verifiedAt: evidence.verifiedAt, result: evidence.result, model, fact: factFile }))
} finally {
  await runtime.close()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
