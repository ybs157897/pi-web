/**
 * 基础工具链的真实模型验收：要求模型按顺序依次调用 write、read、edit、shell 四个工具，
 * 对 verification.txt 完成创建→读取→替换→shell 复读的完整闭环。逐项断言每个工具都有
 * 成功结果、文件最终内容含标记、shell 输出也带标记。证据写入 artifacts/live-tools-check.json。
 * 失败条件：未配置默认模型、150 秒内未完成、任一工具缺成功结果、文件内容或 shell 输出缺标记。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'

// shell 工具名随平台变化（win32 是 pwsh），与快照测试的跳过口径一致。
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-tools-'))
const workspace = join(directory, 'workspace')
const runtime = await createRuntime({ dataDir: join(directory, 'data'), workspace, piDir: piWebHome() })
try {
  // 阶段一：校验默认模型，创建 workspaceWrite 会话并提交顺序化的四步工具任务。
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure a default Pi model before running the real tool check')
  const conversation = await runtime.create({ title: 'Real tool verification', model: catalog.defaultModel, accessMode: 'workspaceWrite' })
  await runtime.submit(conversation.conversation.id, {
    requestId: randomUUID(),
    text: `执行一个小型工具验证，必须按顺序分别调用 write、read、edit、${SHELL_TOOL} 四个工具，每一步成功后再做下一步：1. write 创建 verification.txt，内容为 alpha\\n；2. read 读取该文件；3. edit 将 alpha 替换为 PI_WEB_TOOLS_READY；4. ${SHELL_TOOL} 读取 verification.txt（bash 用 cat，PowerShell 用 Get-Content）。不要只描述操作，不要用 ${SHELL_TOOL} 代替前面三个工具。完成后简短回复即可。`,
  })
  // 阶段二：轮询直到回合结束（150 秒超时）。
  const deadline = Date.now() + 150_000
  let detail = await runtime.detail(conversation.conversation.id)
  while (Date.now() < deadline) {
    detail = await runtime.detail(conversation.conversation.id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) break
    await delay(200)
  }
  // 阶段三：判分——四个工具各自都要出现成功的 tool 结果；再核验文件最终内容与 shell 输出都含标记。
  assert.equal(detail.conversation.busy, false, 'The configured model did not finish the tool sequence')
  const results = detail.messages.filter(message => message.role === 'tool')
  for (const name of ['write', 'read', 'edit', SHELL_TOOL]) {
    assert.ok(results.some(message => message.toolName === name && !message.isError), `No successful ${name} tool result`)
  }
  const contents = await readFile(join(workspace, 'verification.txt'), 'utf8')
  assert.ok(contents.includes('PI_WEB_TOOLS_READY'))
  assert.ok(results.some(message => message.toolName === SHELL_TOOL && message.blocks.some(block => block.type === 'text' && block.text.includes('PI_WEB_TOOLS_READY'))))
  // 阶段四：写证据文件并打印；finally 中关闭 runtime 并清理临时目录。
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
