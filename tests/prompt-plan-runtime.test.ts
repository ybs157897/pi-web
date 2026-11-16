/**
 * 计划审批与访问模式（live 端到端）测试。
 *
 * 用真实 runtime + demo 模型跑通完整计划流程：开启计划模式提交任务 → 等待 plan-review
 * 交互卡 pending → 按访问模式对应的按钮文案批准 → 等待会话落定。
 * 关键契约：批准后 plan.active 关闭；readOnly 会话审批按钮为"确认方案"、批准回复强调
 * "仍为只读/不要实施改动"且 workspace 保持为空（未实施）；fullAccess 会话按钮为"同意执行"、
 * 回复含"在本轮按当前访问权限执行获批计划"。
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime/index.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

/** 本文件创建的 runtime fixture 列表，afterEach 统一关闭并删除临时目录。 */
const fixtures: Array<{ root: string; close: () => Promise<void> }> = []

/** 清理所有 runtime（close 停止后台任务）并递归删除其临时根目录。 */
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => {
    await fixture.close()
    await rm(fixture.root, { recursive: true, force: true })
  }))
})

/**
 * 轮询会话详情直到谓词满足（或 20 秒超时抛错），用于等待异步 agent 流程落定。
 * @param runtime 目标运行时
 * @param id 会话 id
 * @param predicate 满足即返回的判定函数
 * @returns 满足谓词时的会话详情
 */
async function waitUntil(runtime: Awaited<ReturnType<typeof createRuntime>>, id: string, predicate: (detail: ConversationDetail) => boolean) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (predicate(detail)) return detail
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Plan interaction did not settle')
}

/** 把一条消息里所有 text 块的文本拼接成单个字符串（换行连接）。 */
function messageText(message: ConversationDetail['messages'][number]): string {
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** 计划批准后访问模式保持不变、回复文案随模式区分的端到端验证。 */
describe('plan approval and access mode', () => {
  // 参数化两种访问模式：readOnly 与 fullAccess 各自批准计划后，
  // 断言按钮文案、批准后 assistant 回复关键词、plan 状态与（只读时）workspace 未被写入。
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
      expect(reply).toContain('仍为只读')
      expect(reply).toContain('不要实施改动')
      expect(reply).not.toContain('在本轮按当前访问权限执行获批计划')
      expect(await readdir(workspace)).toEqual([])
    } else {
      expect(reply).toContain('在本轮按当前访问权限执行获批计划')
      expect(reply).toContain('当前访问权限')
    }
  }, 30_000)
})
