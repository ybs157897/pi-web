import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/server/runtime.ts'

/**
 * Real-model acceptance for Pi code mode: the configured default model must call the
 * `codemode` tool, whose QuickJS script calls bash, and the script's output must reach
 * the transcript. Direct bash is refused in the prompt so the evidence stays specific.
 */
const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-codemode-'))
const workspace = join(directory, 'workspace')
const runtime = await createRuntime({ dataDir: join(directory, 'data'), workspace })
try {
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure a default Pi model before running the real code mode check')
  const conversation = await runtime.create({ title: 'Real code mode verification', model: catalog.defaultModel, accessMode: 'workspaceWrite' })
  await runtime.submit(conversation.conversation.id, {
    requestId: randomUUID(),
    text: [
      '请只使用 codemode 工具完成这次验证，不要直接调用 bash 工具。',
      '用 codemode 写一段 JavaScript 脚本：在脚本里调用 tools.bash({ command: "printf PI_WEB_CODEMODE_READY" })，',
      '把 bash 输出的文本 return 出来。脚本执行完后简短回复即可。',
    ].join('\n'),
  })
  const deadline = Date.now() + 150_000
  let detail = await runtime.detail(conversation.conversation.id)
  while (Date.now() < deadline) {
    detail = await runtime.detail(conversation.conversation.id)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) break
    await delay(200)
  }
  assert.equal(detail.conversation.busy, false, 'The configured model did not finish the code mode turn')
  const results = detail.messages.filter(message => message.role === 'tool')
  const codemode = results.find(message => message.toolName === 'codemode' && !message.isError)
  assert.ok(codemode, 'The model did not produce a successful codemode tool result')
  const codemodeText = (codemode.blocks ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  assert.ok(codemodeText.includes('PI_WEB_CODEMODE_READY'), 'The script output did not reach the codemode result')
  assert.ok(JSON.stringify(codemode.details).includes('bash'), 'The codemode details do not list the nested bash call')
  assert.ok(!results.some(message => message.toolName === 'bash'), 'The model called bash directly instead of through codemode')
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
