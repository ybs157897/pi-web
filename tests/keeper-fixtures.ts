// doc-keeper 测试共享 fixture：脚本化 OpenAI provider + git 工作区 + 真实 runtime 装配。
// service 单测与 A2A 集成测试共用；每个测试文件在 afterEach 调 cleanupKeeperFixtures()。
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const { createRuntime } = await import('../src/server/runtime/index.ts')

export type Runtime = Awaited<ReturnType<typeof createRuntime>>

const cleanups: Array<() => Promise<void>> = []

/** 登记一次性清理（临时目录、服务器等），由 cleanupKeeperFixtures 逆序执行。 */
export function registerKeeperCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

export async function cleanupKeeperFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

/** One scripted assistant turn piece in the OpenAI-compatible chunk format. */
function event(choice: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'chat_keeper', object: 'chat.completion.chunk', created: 1, model: 'repro-model', choices: [choice] })}\n\n`
}

export function textTurn(text: string): string[] {
  return [
    event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }),
    event({ index: 0, delta: { content: text }, finish_reason: null }),
    event({ index: 0, delta: {}, finish_reason: 'stop' }),
    'data: [DONE]\n\n',
  ]
}

export function toolTurn(name: string, args: Record<string, unknown>): string[] {
  return [
    event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }),
    event({
      index: 0,
      delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: null,
    }),
    event({ index: 0, delta: {}, finish_reason: 'tool_calls' }),
    'data: [DONE]\n\n',
  ]
}

export type ProviderScript = { turn(userText: string, toolCount: number): string[] }

/** A scripted OpenAI-compatible provider whose script is swapped per test. */
export async function scriptedProvider(script: ProviderScript): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }
      const messages = payload.messages ?? []
      let lastUser = -1
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'user') { lastUser = index; break }
      }
      const latest = messages[lastUser]
      const userText = latest === undefined ? '' : typeof latest.content === 'string'
        ? latest.content
        : Array.isArray(latest.content)
          ? latest.content.flatMap(part => typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text' ? [(part as { text?: string }).text ?? ''] : []).join('\n')
          : ''
      const toolCount = messages.slice(lastUser + 1).filter(message => message.role === 'tool').length
      let chunks: string[]
      try {
        chunks = script.turn(userText, toolCount)
      } catch (error) {
        chunks = textTurn(`SCRIPT_ERROR: ${error instanceof Error ? error.message : String(error)}`)
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(chunks.join(''))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind a TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

export function git(repo: string, args: string[], env?: Record<string, string>) {
  return execFileAsync('git', ['-C', repo, ...args], env === undefined ? {} : { env: { ...process.env, ...env } })
}

export async function write(repo: string, rel: string, content: string): Promise<void> {
  await mkdir(join(repo, rel, '..'), { recursive: true })
  await writeFile(join(repo, rel), content)
}

export const DOC_PATH = 'docs/bots/atlas.md'
export const OLD_STAMP = '2026-06-01T00:00:00.000Z'

export function docContent(updatedStamp: string, body: string): string {
  return `---\nbotId: atlas\nmodule: server\nglobs: ["src/**"]\nupdatedStamp: ${updatedStamp}\n---\n${body}`
}

/** git 仓 + 知识文档：init 在 2026-01，一次 src 变更在 2026-07，stamp 2026-06 → stale。 */
export async function gitWorkspace(root: string): Promise<string> {
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await git(workspace, ['init'])
  await git(workspace, ['config', 'user.email', 'keeper@test.local'])
  await git(workspace, ['config', 'user.name', 'Keeper Test'])
  await write(workspace, 'src/a.ts', 'export const a = 1\n')
  await git(workspace, ['add', '.'])
  await git(workspace, ['commit', '-m', 'init'], { GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00' })
  await write(workspace, 'src/a.ts', 'export const a = 2\n')
  await git(workspace, ['add', '.'])
  await git(workspace, ['commit', '-m', 'a becomes 2'], { GIT_AUTHOR_DATE: '2026-07-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-07-01T00:00:00+00:00' })
  await write(workspace, DOC_PATH, docContent(OLD_STAMP, '## 职责\n\n- 旧描述：a=1。\n'))
  return workspace
}

export type KeeperFixture = { runtime: Runtime; workspace: string; dataDir: string }

export async function keeperFixture(script: ProviderScript, options: { stamp?: string } = {}): Promise<KeeperFixture> {
  const provider = await scriptedProvider(script)
  const root = await mkdtemp(join(tmpdir(), 'pi-doc-keeper-'))
  const dataDir = join(root, 'data')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}\n')
  await writeFile(join(piDir, 'models.json'), JSON.stringify({
    providers: {
      repro: {
        name: 'Repro provider', baseUrl: `${provider.origin}/v1`, api: 'openai-completions', apiKey: 'test-key',
        models: [{ id: 'repro-model', name: 'Repro model', contextWindow: 200_000 }],
      },
    },
  }))
  const workspace = await gitWorkspace(root)
  if (options.stamp !== undefined) {
    await write(workspace, DOC_PATH, docContent(options.stamp, '## 职责\n\n- 旧描述：a=1。\n'))
  }
  const runtime = await createRuntime({ dataDir, workspace, piDir })
  // 关掉后台记忆提取，避免脚本 provider 收到旁路请求；默认模型指向脚本 provider。
  await runtime.updateSettings({ memoryEnabled: false, defaultModel: { provider: 'repro', modelId: 'repro-model' } })
  cleanups.push(async () => {
    await runtime.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  return { runtime, workspace, dataDir }
}
