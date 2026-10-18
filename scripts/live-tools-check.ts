import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/server/runtime.ts'

const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-tools-'))
const workspace = join(directory, 'workspace')
const runtime = await createRuntime({ dataDir: join(directory, 'data'), workspace })
try {
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure a default Pi model before running the real tool check')
  const conversation = await runtime.create({ title: 'Real tool verification', model: catalog.defaultModel, accessMode: 'workspaceWrite' })
  await runtime.submit(conversation.conversation.id, {
    requestId: randomUUID(),
    text: '执行一个小型工具验证，必须按顺序分别调用 write、read、edit、bash 四个工具，每一步成功后再做下一步：1. write 创建 verification.txt，内容为 alpha\\n；2. read 读取该文件；3. edit 将 alpha 替换为 PI_WEB_TOOLS_READY；4. bash 执行 cat verification.txt。不要只描述操作，不要用 bash 代替前面三个工具。完成后简短回复即可。',
  })
  const deadline = Date.now() + 150_000
  let detail = await runtime.detail(conversation.conversation.id)
  while (Date.now() < deadline) {
    detail = await runtime.detail(conversation.conversation.id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) break
    await delay(200)
  }
  assert.equal(detail.conversation.busy, false, 'The configured model did not finish the tool sequence')
  const results = detail.messages.filter(message => message.role === 'tool')
  for (const name of ['write', 'read', 'edit', 'bash']) {
    assert.ok(results.some(message => message.toolName === name && !message.isError), `No successful ${name} tool result`)
  }
  const contents = await readFile(join(workspace, 'verification.txt'), 'utf8')
  assert.ok(contents.includes('PI_WEB_TOOLS_READY'))
  assert.ok(results.some(message => message.toolName === 'bash' && message.blocks.some(block => block.type === 'text' && block.text.includes('PI_WEB_TOOLS_READY'))))
  const evidence = {
    result: 'passed', verifiedAt: new Date().toISOString(), model: catalog.defaultModel,
    fileContents: contents, tools: results.map(message => ({ name: message.toolName, isError: message.isError, status: message.status })),
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-tools-check.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await runtime.close()
  await rm(directory, { recursive: true, force: true })
}
