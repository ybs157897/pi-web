import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime/index.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

const fixtures: Array<{ root: string; close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => {
    await fixture.close()
    await rm(fixture.root, { recursive: true, force: true })
  }))
})

async function waitUntil(runtime: Awaited<ReturnType<typeof createRuntime>>, id: string, predicate: (detail: ConversationDetail) => boolean) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (predicate(detail)) return detail
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Plan interaction did not settle')
}

function messageText(message: ConversationDetail['messages'][number]): string {
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('plan approval and access mode', () => {
  it.each(['readOnly', 'fullAccess'] as const)('keeps %s access after approving a plan', async (accessMode) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-plan-access-'))
    const dataDir = join(root, 'data')
    const workspace = join(root, 'workspace')
    const piDir = join(root, 'pi')
    await Promise.all([dataDir, workspace, piDir].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(piDir, 'settings.json'), '{}\n')
    const runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
    fixtures.push({ root, close: () => runtime.close() })
    const created = await runtime.create({ accessMode })
    const id = created.conversation.id
    await runtime.setPlan(id, true)
    await runtime.submit(id, { text: '[plan] 计划验收', requestId: randomUUID() })
    const pending = await waitUntil(runtime, id, detail => !detail.conversation.busy && detail.interactions?.some(item => item.kind === 'plan-review' && item.status === 'pending') === true)
    const review = pending.interactions!.find(item => item.kind === 'plan-review' && item.status === 'pending')!
    const label = accessMode === 'readOnly' ? '确认方案' : '同意执行'
    expect(review.approveLabel).toBe(label)
    await runtime.answerInteraction(id, review.id, [{ id: 'plan-review', selected: [label] }])
    const expectedAnswer = accessMode === 'readOnly' ? '当前会话仍为只读，未实施任何修改' : '演示执行完成'
    const settled = await waitUntil(runtime, id, detail => !detail.conversation.busy
      && detail.messages.some(message => message.role === 'user' && messageText(message).includes('"approved":true'))
      && detail.messages.some(message => message.role === 'assistant' && messageText(message).includes(expectedAnswer)))
    expect(settled.plan?.active).toBe(false)
    expect(settled.conversation.accessMode).toBe(accessMode)
    const reply = messageText(settled.messages.find(message => message.role === 'user' && messageText(message).includes('"approved":true'))!)
    if (accessMode === 'readOnly') {
      expect(reply).toContain('remains read-only')
      expect(reply).toContain('do not implement')
      expect(reply).not.toContain('execute the approved plan in this turn')
      expect(await readdir(workspace)).toEqual([])
    } else {
      expect(reply).toContain('execute the approved plan in this turn')
      expect(reply).toContain('current access permissions')
    }
  }, 30_000)
})
