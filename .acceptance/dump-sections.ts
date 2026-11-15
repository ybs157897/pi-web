/** 一次性诊断：dump default 变体各 section 原文到 %TEMP%，用于跨平台对齐分析。 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getCurrentSystemMessage, normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createRuntime } from '../src/server/runtime/index.ts'
import { observeDemoRequests } from '../src/server/model/demo.ts'
import type { Runtime } from '../src/server/contracts.ts'

const rawRoot = await mkdtemp(join(tmpdir(), 'pi-web-section-dump-'))
const root = await realpath(rawRoot)
const workspace = join(root, 'workspace')
const dataDir = join(root, 'data')
const piDir = join(root, 'pi')
await mkdir(workspace)
await mkdir(piDir)
await writeFile(join(piDir, 'settings.json'), '{}')
await writeFile(join(workspace, 'AGENTS.md'), '# Project rules\n- Use pnpm for scripts.\n')

const captured: { sections: Record<string, string> }[] = []
const runtime: Runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
const unobserve = observeDemoRequests((request) => {
  const messages = normalizeContext(request).messages
  const user = [...messages].reverse().find(message => message.role === 'user')
  const text = typeof user?.content === 'string' ? user.content : ''
  if (!text.includes('[prompt-probe]')) return
  const system = getCurrentSystemMessage(messages)
  if (system?.sections) captured.push({ sections: Object.fromEntries(Object.entries(system.sections).flatMap(([k, v]) => typeof v === 'string' ? [[k, v]] : [])) })
})

const id = (await runtime.create({ title: 'dump' })).conversation.id
const count = (await runtime.detail(id)).messages.length
await runtime.submit(id, { text: '[prompt-probe] dump', requestId: randomUUID() })
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  const detail = await runtime.detail(id)
  if (!detail.error && !detail.conversation.busy && captured.length > 0) break
  await new Promise(r => setTimeout(r, 50))
}
unobserve()
await runtime.close()
await rm(rawRoot, { recursive: true, force: true })

const out = join(process.env.TEMP ?? '.', 'sections-win.json')
await writeFile(out, JSON.stringify(captured[0]?.sections ?? {}, null, 1))
console.log('wrote', out, '| sections:', Object.keys(captured[0]?.sections ?? {}).join(','))
