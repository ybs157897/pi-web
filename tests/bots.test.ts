import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { BotRecord, BotRoomFrame, BotTeamOverview, ConversationDetail } from '../src/shared/types.ts'

const execFileAsync = promisify(execFile)

const { createRuntime } = await import('../src/server/runtime/index.ts')
const { createApp } = await import('../src/server/app.ts')

type Runtime = Awaited<ReturnType<typeof createRuntime>>

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** One scripted assistant turn piece in the OpenAI-compatible chunk format. */
function event(choice: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'chat_bots', object: 'chat.completion.chunk', created: 1, model: 'repro-model', choices: [choice] })}\n\n`
}

function textTurn(text: string): string[] {
  return [
    event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }),
    event({ index: 0, delta: { content: text }, finish_reason: null }),
    event({ index: 0, delta: {}, finish_reason: 'stop' }),
    'data: [DONE]\n\n',
  ]
}

function toolTurn(name: string, args: Record<string, unknown>): string[] {
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

type ProviderScript = {
  /** Decide the next turn from the latest user text and how many tool results already landed. */
  turn(userText: string, toolCount: number): string[]
}

/** A scripted OpenAI-compatible provider whose script is swapped per test. */
async function scriptedProvider(script: ProviderScript): Promise<{ origin: string; close: () => Promise<void> }> {
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

type BotFixture = {
  runtime: Runtime
  workspace: string
  dataDir: string
  app: ReturnType<typeof createApp>
}

/** A runtime fixture on a scripted provider; `git: true` also turns the workspace into a repo. */
async function botFixture(script: ProviderScript, options: { git?: boolean } = {}): Promise<BotFixture> {
  const provider = await scriptedProvider(script)
  const root = await mkdtemp(join(tmpdir(), 'pi-web-bots-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}\n')
  await writeFile(join(piDir, 'models.json'), JSON.stringify({
    providers: {
      repro: {
        name: 'Repro provider', baseUrl: `${provider.origin}/v1`, api: 'openai-completions', apiKey: 'test-key',
        models: [{ id: 'repro-model', name: 'Repro model', contextWindow: 200_000 }],
      },
    },
  }))
  if (options.git === true) {
    const git = (...args: string[]) => execFileAsync('git', ['-C', workspace, ...args])
    await git('init')
    await git('config', 'user.email', 'bots@test.local')
    await git('config', 'user.name', 'Bots Test')
    await writeFile(join(workspace, 'README.md'), '# fixture\n')
    await git('add', '.')
    await git('commit', '-m', 'initial fixture')
  }
  const runtime = await createRuntime({ dataDir, workspace, piDir })
  const app = createApp(runtime)
  cleanups.push(async () => {
    await runtime.close()
    await provider.close()
    await rm(root, { recursive: true, force: true })
  })
  return { runtime, workspace, dataDir, app }
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('condition not reached before timeout')
    await new Promise(resolve => setTimeout(resolve, 120))
  }
}

async function overview(runtime: Runtime): Promise<BotTeamOverview> {
  return await runtime.bots()
}

const botByName = async (runtime: Runtime, name: string): Promise<BotRecord> => {
  const state = await overview(runtime)
  const bot = state.bots.find(candidate => candidate.name === name)
  if (bot === undefined) throw new Error(`bot ${name} missing from roster`)
  return bot
}

/** The parsed room log frames of the (single, named) room. */
async function roomFrames(runtime: Runtime, roomName: string): Promise<BotRoomFrame[]> {
  const state = await overview(runtime)
  const room = state.rooms.find(candidate => candidate.name === roomName)
  if (room === undefined) throw new Error(`room ${roomName} missing`)
  return await runtime.botRoomLog(room.id)
}

/** The joined user-message text of one conversation, the way delivery frames arrive. */
async function userTextOf(runtime: Runtime, conversationId: string): Promise<string> {
  const detail = await runtime.detail(conversationId) as ConversationDetail
  return detail.messages.filter(message => message.role === 'user')
    .map(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    .join('\n')
}

async function postJson(app: BotFixture['app'], path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patchJson(app: BotFixture['app'], path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('module bot team', () => {
  it('preset init builds the three-bot roster, the default room and knowledge skeletons, idempotently', async () => {
    const { runtime, workspace, app } = await botFixture({ turn: () => textTurn('不该被调用') })
    const first = await postJson(app, '/api/bots/init', { mode: 'preset' })
    expect(first.status).toBe(200)
    const state = await overview(runtime)
    expect(state.bots.map(bot => bot.name).toSorted()).toEqual(['server-bot', 'shared-bot', 'web-bot'])
    expect(state.rooms).toHaveLength(1)
    expect(state.rooms[0]!.name).toBe('全队')
    expect(state.rooms[0]!.memberIds.toSorted()).toEqual(['server-bot', 'shared-bot', 'web-bot'])
    expect(state.init.running).toBe(false)
    for (const bot of state.bots) {
      expect(bot.conversationId).not.toBe('')
      expect(bot.knowledgeHealth).toBe('unknown')
      expect(bot.compliance).toBe('pending')
      expect(bot.status).toBe('idle')
      const content = await readFile(join(workspace, bot.knowledgePath), 'utf8')
      expect(content).toContain(`botId: ${bot.id}`)
      expect(content).toContain('updatedStamp: ')
      expect(content).toContain('## 职责')
      expect(content).toContain('## 关键文件')
      expect(content).toContain('## 已知坑')
      expect(content).toContain('## changelog')
    }
    // Idempotent: a second preset over a non-empty roster returns without rebuilding.
    const second = await postJson(app, '/api/bots/init', { mode: 'preset' })
    expect(second.status).toBe(200)
    expect((await overview(runtime)).bots).toHaveLength(3)
    // Bot and room conversations stay out of the ordinary sidebar.
    const conversations = await runtime.list()
    expect(conversations.filter(item => item.title.startsWith('bot:') || item.title.startsWith('room:'))).toEqual([])
  }, 40_000)

  it('creates and updates bots over HTTP and keeps knowledge frontmatter in sync', async () => {
    const { runtime, workspace, app } = await botFixture({ turn: () => textTurn('ok') })
    const created = await postJson(app, '/api/bots', {
      name: 'tools-bot', module: 'tools', globs: ['src/server/tools/**'], description: '工具扩展模块',
    })
    expect(created.status).toBe(201)
    const { bot } = await created.json() as { bot: BotRecord }
    expect(bot.knowledgePath).toBe('docs/bots/tools-bot.md')
    // Duplicate names conflict.
    expect((await postJson(app, '/api/bots', {
      name: 'tools-bot', module: 'tools', globs: ['x/**'], description: 'again',
    })).status).toBe(409)
    // Invalid names are rejected.
    expect((await postJson(app, '/api/bots', {
      name: 'Bad Name', module: 'tools', globs: ['x/**'], description: 'nope',
    })).status).toBe(400)
    const updated = await patchJson(app, `/api/bots/${bot.id}`, { module: 'tools-v2', globs: ['src/server/tools/**', 'src/server/bots/**'] })
    expect(updated.status).toBe(200)
    const { bot: patched } = await updated.json() as { bot: BotRecord }
    expect(patched.module).toBe('tools-v2')
    const content = await readFile(join(workspace, patched.knowledgePath), 'utf8')
    expect(content).toContain('module: tools-v2')
    expect(content).toContain(JSON.stringify(['src/server/tools/**', 'src/server/bots/**']))
    expect((await patchJson(app, '/api/bots/missing-bot', { description: 'x' })).status).toBe(404)
    expect((await patchJson(app, `/api/bots/${bot.id}`, {})).status).toBe(400)
    expect((await overview(runtime)).bots).toHaveLength(1)
  }, 40_000)

  it('delivers a user mention into the bot conversation and lands the bot reply in the room log', async () => {
    let roomIdCache = ''
    const { runtime, app } = await botFixture({
      turn: (userText, toolCount) => {
        if (!userText.includes('[ROOM:')) return textTurn('直接文本不会被投递')
        if (toolCount === 0) return toolTurn('post_to_room', { roomId: roomIdCache, text: '正文直接进群聊，无提及' })
        return textTurn('已回应群聊。')
      },
    })
    await postJson(app, '/api/bots/init', { mode: 'preset' })
    roomIdCache = (await overview(runtime)).rooms[0]!.id
    const serverBot = await botByName(runtime, 'server-bot')
    const posted = await postJson(app, `/api/bots/rooms/${roomIdCache}/posts`, { text: '@server-bot 服务端最近有什么值得注意的变更？' })
    expect(posted.status).toBe(202)
    const { mentioned } = await posted.json() as { mentioned: string[] }
    expect(mentioned).toEqual(['server-bot'])
    // The framed message reached the bot conversation.
    const frames = await until(async () => {
      const text = await userTextOf(runtime, serverBot.conversationId)
      return text.includes('[ROOM:全队 FROM:user]') && text.includes('@server-bot') ? text : undefined
    })
    expect(frames).toContain('以上是群聊最近消息，你被提及')
    // The bot's reply lands in the room log with its frame header; the user line too.
    const lines = await until(async () => {
      const entries = await roomFrames(runtime, '全队')
      return entries.some(frame => frame.sender.kind === 'bot' && frame.sender.name === 'server-bot') ? entries : undefined
    })
    expect(lines[0]?.sender.kind).toBe('user')
    // The participation settles compliance: the document did not change, so the bot stalled.
    const settled = await until(async () => {
      const bot = await botByName(runtime, 'server-bot')
      return bot.status === 'idle' && bot.compliance === 'stalled' ? bot : undefined
    })
    expect(settled.lastActiveAt).toBeDefined()
  }, 40_000)

  it('resolves post_to_room by room name, the only identifier a bot sees in a delivery frame', async () => {
    const { runtime, app } = await botFixture({
      turn: userText => {
        if (!userText.includes('[ROOM:')) return textTurn('ok')
        // The frame header carries the room *name*, not the UUID id — mimic the model.
        return toolTurn('post_to_room', { roomId: '全队', text: '按名字落群聊成功' })
      },
    })
    await postJson(app, '/api/bots/init', { mode: 'preset' })
    await postJson(app, `/api/bots/rooms/${(await overview(runtime)).rooms[0]!.id}/posts`, { text: '@server-bot 任意问题' })
    const entries = await until(async () => {
      const frames = await roomFrames(runtime, '全队')
      return frames.some(frame => frame.sender.kind === 'bot' && frame.text === '按名字落群聊成功') ? frames : undefined
    })
    expect(entries.some(frame => frame.sender.name === 'server-bot')).toBe(true)
  }, 40_000)

  it('keeps PASS replies silent and out of the room log', async () => {
    let roomIdCache = ''
    const { runtime, app } = await botFixture({
      turn: (userText, toolCount) => {
        if (!userText.includes('[ROOM:')) return textTurn('ok')
        if (toolCount === 0) return toolTurn('post_to_room', { roomId: roomIdCache, text: '[PASS]' })
        return textTurn('已静默收尾。')
      },
    })
    await postJson(app, '/api/bots/init', { mode: 'preset' })
    roomIdCache = (await overview(runtime)).rooms[0]!.id
    const posted = await postJson(app, `/api/bots/rooms/${roomIdCache}/posts`, { text: '@shared-bot 收到请回复 PASS' })
    expect(posted.status).toBe(202)
    await until(async () => {
      const bot = await botByName(runtime, 'shared-bot')
      return bot.status === 'idle' && bot.compliance !== 'pending' ? bot : undefined
    })
    const entries = await roomFrames(runtime, '全队')
    expect(entries.filter(frame => frame.sender.kind === 'bot')).toEqual([])
    expect(entries.some(frame => frame.sender.kind === 'user')).toBe(true)
  }, 40_000)

  it('pins write/edit to the bot knowledge document and marks a stalled participation', async () => {
    let roomIdCache = ''
    const { runtime, workspace, app } = await botFixture({
      turn: (userText, toolCount) => {
        if (!userText.includes('[ROOM:')) return textTurn('ok')
        if (toolCount === 0) return toolTurn('write', { path: 'escape.txt', content: 'should be denied' })
        if (toolCount === 1) return toolTurn('post_to_room', { roomId: roomIdCache, text: '本轮只做了无效写入' })
        return textTurn('done')
      },
    })
    await postJson(app, '/api/bots/init', { mode: 'preset' })
    roomIdCache = (await overview(runtime)).rooms[0]!.id
    await postJson(app, `/api/bots/rooms/${roomIdCache}/posts`, { text: '@web-bot 刷新你的知识文档' })
    const bot = await until(async () => {
      const current = await botByName(runtime, 'web-bot')
      return current.status === 'idle' && current.compliance !== 'pending' ? current : undefined
    })
    // The wrap denied the escape write, the knowledge document never changed, so stalled.
    expect(bot.compliance).toBe('stalled')
    await expect(readFile(join(workspace, 'escape.txt'), 'utf8')).rejects.toThrow()
    const entries = await roomFrames(runtime, '全队')
    expect(entries.some(frame => frame.sender.kind === 'bot' && frame.sender.name === 'web-bot')).toBe(true)
  }, 40_000)

  it('marks a compliant participation when the bot updates its document during the run', async () => {
    let roomIdCache = ''
    const { runtime, workspace, app } = await botFixture({
      turn: (userText, toolCount) => {
        if (!userText.includes('[ROOM:')) return textTurn('ok')
        if (toolCount === 0) {
          return toolTurn('write', {
            path: 'docs/bots/web-bot.md',
            content: '---\nbotId: web-bot\nmodule: web\nglobs: ["src/web/**"]\nupdatedStamp: 2026-11-12T00:00:00.000Z\n---\n\n# web-bot 知识文档\n\n## 职责\n\n- 已在本轮更新。\n\n## 关键文件\n\n- src/web/App.tsx\n\n## 已知坑\n\n- (none)\n\n## changelog\n\n- 2026-11-12 参与群聊后更新。\n',
          })
        }
        if (toolCount === 1) return toolTurn('post_to_room', { roomId: roomIdCache, text: '文档已更新' })
        return textTurn('done')
      },
    })
    await postJson(app, '/api/bots/init', { mode: 'preset' })
    roomIdCache = (await overview(runtime)).rooms[0]!.id
    await postJson(app, `/api/bots/rooms/${roomIdCache}/posts`, { text: '@web-bot 记录一下这次结论' })
    const bot = await until(async () => {
      const current = await botByName(runtime, 'web-bot')
      return current.status === 'idle' && current.compliance === 'complied' ? current : undefined
    })
    expect(bot.knowledgeHash).toBeDefined()
    const content = await readFile(join(workspace, 'docs/bots/web-bot.md'), 'utf8')
    expect(content).toContain('已在本轮更新')
  }, 40_000)

  it('delivers direct messages and stops the relay chain at two hops', async () => {
    let roomIdCache = ''
    const { runtime, app } = await botFixture({
      turn: (userText, toolCount) => {
        if (userText.includes('[DIRECT FROM:alpha-bot]')) {
          // beta-bot was woken at hop 2: its re-mention must not relay further.
          return toolCount === 0
            ? toolTurn('bot_message', { toBotName: 'gamma-bot', text: '转提及：请确认' })
            : textTurn('已尝试转投递。')
        }
        if (userText.includes('[ROOM:') && toolCount === 0) {
          // alpha relays a mention: beta is woken at hop 2 and its re-mention must stop there.
          return toolTurn('post_to_room', { roomId: roomIdCache, text: '@beta-bot 请确认一下' })
        }
        return textTurn('ok')
      },
    })
    await postJson(app, '/api/bots', { name: 'alpha-bot', module: 'a', globs: ['a/**'], description: 'A' })
    await postJson(app, '/api/bots', { name: 'beta-bot', module: 'b', globs: ['b/**'], description: 'B' })
    await postJson(app, '/api/bots', { name: 'gamma-bot', module: 'c', globs: ['c/**'], description: 'C' })
    const room = await postJson(app, '/api/bots/rooms', { name: 'chain', memberIds: ['alpha-bot', 'beta-bot', 'gamma-bot'] })
    expect(room.status).toBe(201)
    roomIdCache = ((await room.json()) as { room: { id: string } }).room.id
    // User post wakes alpha at hop 1; alpha's mention wakes beta at hop 2.
    const posted = await postJson(app, `/api/bots/rooms/${roomIdCache}/posts`, { text: '@alpha-bot 开始链式协作' })
    const { mentioned } = await posted.json() as { mentioned: string[] }
    expect(mentioned).toEqual(['alpha-bot'])
    // beta receives the room relay frame carrying the bot sender header.
    const beta = await botByName(runtime, 'beta-bot')
    await until(async () => {
      const text = await userTextOf(runtime, beta.conversationId)
      return text.includes('[ROOM:chain FROM:alpha-bot]') && text.includes('@beta-bot') ? text : undefined
    })
    // beta's re-mention of gamma must not deliver: gamma never wakes up.
    await until(async () => {
      const current = await botByName(runtime, 'beta-bot')
      return current.status === 'idle' && current.compliance === 'stalled' ? current : undefined
    })
    await new Promise(resolve => setTimeout(resolve, 600))
    const gamma = await botByName(runtime, 'gamma-bot')
    expect(await userTextOf(runtime, gamma.conversationId)).toBe('')
  }, 40_000)

  it('delivers direct bot_message frames and stops the relay chain at two hops', async () => {
    const { runtime, app } = await botFixture({
      turn: (userText, toolCount) => {
        if (userText.includes('[DIRECT FROM:alpha-bot]')) {
          // beta was woken at hop 2: its direct re-message must not relay further.
          return toolCount === 0
            ? toolTurn('bot_message', { toBotName: 'gamma-bot', text: '转投递：请确认' })
            : textTurn('已尝试转投递。')
        }
        if (userText.includes('[ROOM:') && toolCount === 0) {
          return toolTurn('bot_message', { toBotName: 'beta-bot', text: '请确认一下' })
        }
        return textTurn('ok')
      },
    })
    await postJson(app, '/api/bots', { name: 'alpha-bot', module: 'a', globs: ['a/**'], description: 'A' })
    await postJson(app, '/api/bots', { name: 'beta-bot', module: 'b', globs: ['b/**'], description: 'B' })
    await postJson(app, '/api/bots', { name: 'gamma-bot', module: 'c', globs: ['c/**'], description: 'C' })
    const room = await postJson(app, '/api/bots/rooms', { name: 'direct-chain', memberIds: ['alpha-bot', 'beta-bot', 'gamma-bot'] })
    const roomId = ((await room.json()) as { room: { id: string } }).room.id
    const posted = await postJson(app, `/api/bots/rooms/${roomId}/posts`, { text: '@alpha-bot 开始' })
    const { mentioned } = await posted.json() as { mentioned: string[] }
    expect(mentioned).toEqual(['alpha-bot'])
    // beta receives the direct frame carrying the sender header.
    const beta = await botByName(runtime, 'beta-bot')
    await until(async () => {
      const text = await userTextOf(runtime, beta.conversationId)
      return text.includes('[DIRECT FROM:alpha-bot]') && text.includes('请确认一下') ? text : undefined
    })
    await until(async () => {
      const current = await botByName(runtime, 'beta-bot')
      return current.status === 'idle' && current.compliance === 'stalled' ? current : undefined
    })
    await new Promise(resolve => setTimeout(resolve, 600))
    const gamma = await botByName(runtime, 'gamma-bot')
    expect(await userTextOf(runtime, gamma.conversationId)).toBe('')
  }, 40_000)

  it('runs the watchdog: unknown, over-limit and stale on a real git workspace, then refreshes', async () => {
    const { runtime, workspace, dataDir, app } = await botFixture(
      { turn: userText => userText.includes('[watchdog-refresh:') ? textTurn('刷新完成') : textTurn('ok') },
      { git: true },
    )
    await postJson(app, '/api/bots/init', { mode: 'preset' })
    // A baseline commit after the skeletons so later module commits count since updatedStamp.
    const git = (...args: string[]) => execFileAsync('git', ['-C', workspace, ...args])
    await git('add', '.')
    await git('commit', '-m', 'bot skeletons', '--allow-empty')
    // over-limit: blow one document past the body bound (checked before the git freshness step)
    const overBot = await botByName(runtime, 'web-bot')
    const original = await readFile(join(workspace, overBot.knowledgePath), 'utf8')
    await writeFile(join(workspace, overBot.knowledgePath), `${original}${'很长的一行。'.repeat(1_500)}\n`)
    // unknown: delete another document entirely
    const unknownBot = await botByName(runtime, 'shared-bot')
    await rm(join(workspace, unknownBot.knowledgePath))
    // a server-module commit after the skeletons makes the server bot stale
    await mkdir(join(workspace, 'src/server/extra'), { recursive: true })
    await writeFile(join(workspace, 'src/server/extra/new.ts'), 'export {}\n')
    await git('add', 'src/server/extra')
    await git('commit', '-m', 'feat(server): add extra module')
    const run = await postJson(app, '/api/bots/watchdog/run', {})
    expect(run.status).toBe(200)
    const { report } = await run.json() as { report: { runAt: string; entries: Array<{ botId: string; health: string; detail: string; suggestion?: string }> } }
    const byId = new Map(report.entries.map(entry => [entry.botId, entry]))
    expect(byId.get(overBot.id)?.health).toBe('over-limit')
    expect(byId.get(unknownBot.id)?.health).toBe('unknown')
    expect(byId.get('server-bot')?.health).toBe('stale')
    expect(byId.get('server-bot')?.detail).toContain('1 条新提交')
    expect(byId.get('server-bot')?.detail).toContain('feat(server): add extra module')
    expect(byId.get('server-bot')?.suggestion).toContain('git log')
    // app state picked the healths up, and the report file landed under the data dir.
    const state = await overview(runtime)
    expect(state.watchdog.lastRunAt).toBe(report.runAt)
    expect(state.bots.find(bot => bot.id === 'server-bot')?.knowledgeHealth).toBe('stale')
    expect(JSON.parse(await readFile(join(dataDir, 'bot-watchdog', 'report.json'), 'utf8'))).toMatchObject({ runAt: report.runAt })
    // The report endpoint answers from the stored block.
    const stored = await (await app.request('/api/bots/watchdog/report')).json() as { lastRunAt?: string; report?: { runAt: string } }
    expect(stored.lastRunAt).toBe(report.runAt)
    expect(stored.report?.runAt).toBe(report.runAt)
    // refreshStale submits the refresh instruction into the stale bot's own conversation.
    const refreshed = await postJson(app, '/api/bots/watchdog/run', { refreshStale: true })
    expect(refreshed.status).toBe(200)
    const staleBot = await botByName(runtime, 'server-bot')
    await until(async () => {
      const text = await userTextOf(runtime, staleBot.conversationId)
      return text.includes('[watchdog-refresh:server-bot]') && text.includes('feat(server): add extra module') ? text : undefined
    })
  }, 40_000)

  it('reports fresh structural health outside git workspaces and rejects bad room inputs', async () => {
    const { runtime, app } = await botFixture({ turn: () => textTurn('ok') })
    await postJson(app, '/api/bots', { name: 'solo-bot', module: 's', globs: ['s/**'], description: 'S' })
    const run = await postJson(app, '/api/bots/watchdog/run', { refreshStale: true })
    expect(run.status).toBe(200)
    const { report } = await run.json() as { report: { entries: Array<{ health: string; detail: string }> } }
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]!.health).toBe('fresh')
    expect(report.entries[0]!.detail).toContain('不是 git 仓库')
    expect((await postJson(app, '/api/bots/rooms', { name: 'empty', memberIds: ['nobody'] })).status).toBe(400)
    expect((await postJson(app, '/api/bots/rooms/missing-room/posts', { text: 'hi' })).status).toBe(404)
    expect((await patchJson(app, '/api/bots/config', { watchdogIntervalMs: 60_000 })).status).toBe(200)
    const state = await overview(runtime)
    expect(state).toBeDefined()
  }, 40_000)

  it('completes an orchestrator init with bot_create, knowledge write and finish_init', async () => {
    const { runtime, workspace, app } = await botFixture({
      turn: (userText, toolCount) => {
        if (!userText.includes('[bot-init]')) return textTurn('ok')
        switch (toolCount) {
          case 0:
            return toolTurn('bot_create', { name: 'orch-bot', module: 'orch', globs: ['src/**'], description: '编排创建的模块' })
          case 1:
            return toolTurn('write', {
              path: 'docs/bots/orch-bot.md',
              content: '---\nbotId: orch-bot\nmodule: orch\nglobs: ["src/**"]\nupdatedStamp: 2026-11-12T00:00:00.000Z\n---\n\n# orch-bot\n\n## 职责\n\n- 编排初始化时写入的初版内容。\n',
            })
          case 2:
            return toolTurn('finish_init', { summary: '创建了 1 个模块 bot。' })
          default:
            return textTurn('初始化完成。')
        }
      },
    })
    const started = await postJson(app, '/api/bots/init', {})
    expect(started.status).toBe(200)
    const state = await until(async () => {
      const current = await overview(runtime)
      return current.init.running === false && current.init.conversationId !== undefined && current.bots.length > 0 ? current : undefined
    })
    expect(state.init.error).toBeUndefined()
    expect(state.bots.map(bot => bot.name)).toEqual(['orch-bot'])
    const content = await readFile(join(workspace, 'docs/bots/orch-bot.md'), 'utf8')
    expect(content).toContain('编排初始化时写入的初版内容')
    const bot = state.bots[0]!
    const detail = await runtime.detail(bot.conversationId) as ConversationDetail
    expect(detail.conversation.title).toBe('bot:orch-bot')
    // The init conversation itself is host-managed and stays out of the sidebar.
    const conversations = await runtime.list()
    expect(conversations.map(item => item.title)).not.toContain('Bot 团队初始化')
  }, 40_000)
})
