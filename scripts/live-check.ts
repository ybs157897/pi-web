import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'

const dir = await mkdtemp(join(tmpdir(), 'pi-web-live-'))
const runtime = await createRuntime({ dataDir: join(dir, 'data'), workspace: dir, piDir: piWebHome() })
try {
  const catalog = await runtime.catalog()
  if (!catalog.defaultModel) throw new Error('当前 Pi 未配置默认模型，请先配置模型后重试')
  const created = await runtime.create({ model: catalog.defaultModel, thinkingLevel: 'off' })
  await runtime.submit(created.conversation.id, { text: '只回复 PI_WEB_LIVE_OK，不调用任何工具。', requestId: randomUUID() })
  const deadline = Date.now() + 60_000
  let answer = ''
  while (Date.now() < deadline) {
    const detail = await runtime.detail(created.conversation.id)
    if (detail.error) throw new Error(detail.error)
    const message = detail.messages.filter(message => message.role === 'assistant' && !message.streaming).at(-1)
    if (message && !detail.conversation.busy) {
      answer = message.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
      break
    }
    await delay(200)
  }
  if (!answer.includes('PI_WEB_LIVE_OK')) throw new Error(answer ? `真实模型返回了非预期内容：${answer.slice(0, 200)}` : '真实模型未在 60 秒内完成')
  const evidence = { verifiedAt: new Date().toISOString(), model: catalog.defaultModel, answer, result: 'passed' }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-check.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  await runtime.close()
  await rm(dir, { recursive: true, force: true })
}
