/**
 * Pi code mode 的真实模型验收：已配置的默认模型必须调用 codemode 工具，其 QuickJS 脚本
 * 再调用 bash/pwsh，脚本输出要能回到会话记录。提示词明确禁止直接调 shell 工具，
 * 保证证据指向「经 codemode 路由」而非绕过。证据写入 artifacts/live-codemode-check.json。
 * 失败条件：未配置默认模型、回合未在 150 秒内结束、没有成功的 codemode 结果、
 * 脚本输出未包含标记、details 未记录嵌套 shell 调用、或模型直接调了 shell。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'

// 平台差异收敛：shell 工具名与探针命令按 win32/posix 分开（catalog 与快照同口径跳过 win32 shell 面）。
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SHELL_COMMAND = process.platform === 'win32' ? 'Write-Output PI_WEB_CODEMODE_READY' : 'printf PI_WEB_CODEMODE_READY'
const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-codemode-'))
const workspace = join(directory, 'workspace')
const runtime = await createRuntime({ dataDir: join(directory, 'data'), workspace, piDir: piWebHome() })
try {
  // 阶段一：校验默认模型，创建 workspaceWrite 会话并提交探针任务（要求脚本内嵌套调用 shell 并 return 输出）。
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure a default Pi model before running the real code mode check')
  const conversation = await runtime.create({ title: 'Real code mode verification', model: catalog.defaultModel, accessMode: 'workspaceWrite' })
  await runtime.submit(conversation.conversation.id, {
    requestId: randomUUID(),
    text: [
      `请只使用 codemode 工具完成这次验证，不要直接调用 ${SHELL_TOOL} 工具。`,
      `用 codemode 写一段 JavaScript 脚本：在脚本里调用 tools.${SHELL_TOOL}({ command: ${JSON.stringify(SHELL_COMMAND)} })，`,
      `把 ${SHELL_TOOL} 输出的文本 return 出来。脚本执行完后简短回复即可。`,
    ].join('\n'),
  })
  // 阶段二：轮询直到回合结束（150 秒超时），超时视为模型未完成 code mode 回合。
  const deadline = Date.now() + 150_000
  let detail = await runtime.detail(conversation.conversation.id)
  while (Date.now() < deadline) {
    detail = await runtime.detail(conversation.conversation.id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) break
    await delay(200)
  }
  // 阶段三：判分。四条硬断言：回合确实结束；存在成功的 codemode 结果；脚本输出到达结果文本；
  // details 里能看到嵌套 shell 调用；且全程没有对 shell 工具的直接调用。
  assert.equal(detail.conversation.busy, false, 'The configured model did not finish the code mode turn')
  const results = detail.messages.filter(message => message.role === 'tool')
  const codemode = results.find(message => message.toolName === 'codemode' && !message.isError)
  assert.ok(codemode, 'The model did not produce a successful codemode tool result')
  const codemodeText = (codemode.blocks ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  assert.ok(codemodeText.includes('PI_WEB_CODEMODE_READY'), 'The script output did not reach the codemode result')
  assert.ok(JSON.stringify(codemode.details).includes(SHELL_TOOL), `The codemode details do not list the nested ${SHELL_TOOL} call`)
  assert.ok(!results.some(message => message.toolName === SHELL_TOOL), `The model called ${SHELL_TOOL} directly instead of through codemode`)
  // 阶段四：写证据文件并打印；finally 中关闭 runtime 并清理临时目录。
  const evidence = {
    result: 'passed',
    verifiedAt: new Date().toISOString(),
    model: catalog.defaultModel,
    scriptOutput: codemodeText.slice(0, 2_000),
    calls: (codemode.details as { calls?: unknown } | undefined)?.calls,
    tools: results.map(message => ({ name: message.toolName, isError: message.isError, status: message.status })),
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-codemode-check.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await runtime.close()
  await rm(directory, { recursive: true, force: true })
}
