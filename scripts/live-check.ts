/**
 * 最小真实模型验收（npm run test:live:* 家族的 smoke 级）：在临时数据目录起真实 runtime，
 * 向已配置的默认模型发一条固定指令，要求它只回复 PI_WEB_LIVE_OK。回答包含该标记即通过，
 * 证据（模型、回答、时间戳）写入 artifacts/live-check.json 并打印到 stdout。
 * 失败条件：未配置默认模型、出现会话错误、60 秒内未完成、回答不含标记——均以异常退出（非零码）。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'

// 阶段一：准备一次性临时根目录并创建真实 runtime；piDir 仍指向全局 home 以复用既有凭据。
const dir = await mkdtemp(join(tmpdir(), 'pi-web-live-'))
const runtime = await createRuntime({ dataDir: join(dir, 'data'), workspace: dir, piDir: piWebHome() })
try {
  // 阶段二：校验默认模型已配置，并创建关闭思考的会话，提交固定探针消息。
  const catalog = await runtime.catalog()
  if (!catalog.defaultModel) throw new Error('当前 Pi 未配置默认模型，请先配置模型后重试')
  const created = await runtime.create({ model: catalog.defaultModel, thinkingLevel: 'off' })
  await runtime.submit(created.conversation.id, { text: '只回复 PI_WEB_LIVE_OK，不调用任何工具。', requestId: randomUUID() })
  // 阶段三：轮询会话直到非 busy 且出现完整 assistant 消息（60 秒超时），拼出最终回答文本。
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
  // 阶段四：判分——回答必须包含 PI_WEB_LIVE_OK；通过则把证据写入 artifacts/live-check.json 并打印。
  if (!answer.includes('PI_WEB_LIVE_OK')) throw new Error(answer ? `真实模型返回了非预期内容：${answer.slice(0, 200)}` : '真实模型未在 60 秒内完成')
  const evidence = { verifiedAt: new Date().toISOString(), model: catalog.defaultModel, answer, result: 'passed' }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-check.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  // 无论成败都关闭 runtime 并删除临时目录，不留运行时残留。
  await runtime.close()
  await rm(dir, { recursive: true, force: true })
}
