/**
 * 损坏会话的隔离：一条无法重放的历史不得让整个会话列表消失。
 *
 * 会话视图由「检查点 base + 增量 delta」重放得到。delta 的路径若在当前上下文里无法解析
 * （内核报 `PathError: unresolvable path`），`conversation.watch()` 会抛错，而列举、订阅、
 * 停止都会走到这一步。本测试直接向存储写入这样一条 delta，然后断言：
 * - 列举仍然成功，损坏会话以占位摘要出现并带 `corrupt` 标记；
 * - 健康会话的摘要完全不受影响；
 * - 打开损坏会话返回可识别的 `conversation_corrupt`，而不是笼统的 500。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime/index.ts'
import { isCorruptConversationError } from '../src/server/runtime/corrupt-conversation.ts'

/**
 * 功能：在指定数据目录的 SQLite 库里，给某会话的 `pi.live` 文档追加一条路径不可解析的 delta。
 * @param dataDir 运行时数据目录（含 pi-durable.sqlite）。
 * @param conversationId 目标会话 ID（文档 owner_id）。
 * @returns true 表示已写入；该会话没有 `pi.live` 文档时返回 false。
 * 内部逻辑：读取该文档当前最大 seq，插入 `["s", ["tools", 0, "output"], "x"]`——在 base 里
 * 已无 tools 的情况下，重放该路径必然失败，与线上观测到的损坏形态一致。
 */
function corruptLiveDoc(dataDir: string, conversationId: number): boolean {
  const db = new DatabaseSync(join(dataDir, 'pi-durable.sqlite'))
  try {
    // kind 列存的是 JSON 编码的字符串，库里带引号。
    const row = db.prepare(`select id from documents where kind = json_quote('pi.live') and scope_kind = 'conversation' and owner_id = ? and retired_at is null limit 1`)
      .get(conversationId) as { id: number } | undefined
    if (row === undefined) return false
    const max = db.prepare('select coalesce(max(seq), 0) as seq, count(*) as n from document_revisions where document_id = ?')
      .get(row.id) as { seq: number; n: number }
    if (max.n === 0) return false
    db.prepare('insert into document_revisions (document_id, seq, kind, version, content) values (?, ?, ?, ?, ?)')
      .run(row.id, max.seq + 1, 'delta', 1, JSON.stringify([['s', ['tools', 0, 'output'], 'boom']]))
    return true
  } finally {
    db.close()
  }
}

/** 建立一个含若干会话的临时运行时；`demo: true` 让模型与凭据都不必真实。 */
async function withRuntime(run: (context: {
  runtime: Awaited<ReturnType<typeof createRuntime>>
  dataDir: string
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-corrupt-'))
  const workspace = join(root, 'project')
  const dataDir = join(root, 'data')
  await mkdir(workspace)
  const runtime = await createRuntime({ workspace, dataDir, piDir: join(root, 'pi'), demo: true })
  try {
    await run({ runtime, dataDir })
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('损坏会话的隔离', () => {
  it('单条历史无法重放时，列表仍返回其余会话', async () => {
    await withRuntime(async ({ runtime, dataDir }) => {
      const healthy = await runtime.create({ title: 'healthy-one' })
      const victim = await runtime.create({ title: 'victim' })
      await runtime.create({ title: 'healthy-two' })

      // 先让被损坏的会话产生一次 pi.live 写入，再追加不可解析的 delta。
      expect(corruptLiveDoc(dataDir, Number(victim.conversation.id))).toBe(true)

      // 重开运行时，让视图从存储重新重放。
      await runtime.close()
      const reopened = await createRuntime({ workspace: join(dataDir, '..', 'project'), dataDir, piDir: join(dataDir, '..', 'pi'), demo: true })
      try {
        const summaries = await reopened.list()
        const ids = summaries.map(item => item.id)
        expect(ids).toContain(healthy.conversation.id)
        expect(ids).toContain(victim.conversation.id)

        const corrupt = summaries.find(item => item.id === victim.conversation.id)
        expect(corrupt?.corrupt).toBeDefined()
        expect(corrupt?.title).toBe('victim')

        // 健康会话的摘要保持完整。
        const intact = summaries.find(item => item.id === healthy.conversation.id)
        expect(intact?.corrupt).toBeUndefined()
      } finally {
        await reopened.close()
      }
    })
  }, 60_000)

  it('打开损坏会话返回可识别的损坏错误', async () => {
    await withRuntime(async ({ runtime, dataDir }) => {
      const victim = await runtime.create({ title: 'victim-open' })
      expect(corruptLiveDoc(dataDir, Number(victim.conversation.id))).toBe(true)
      await runtime.close()
      const reopened = await createRuntime({ workspace: join(dataDir, '..', 'project'), dataDir, piDir: join(dataDir, '..', 'pi'), demo: true })
      try {
        const error = await reopened.detail(victim.conversation.id).then(() => undefined, (cause: unknown) => cause)
        expect(error).toBeDefined()
        expect(isCorruptConversationError(error)).toBe(true)
      } finally {
        await reopened.close()
      }
    })
  }, 60_000)
})
