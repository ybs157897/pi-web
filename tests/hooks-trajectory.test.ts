import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createHookCapture, drainTrajectoryCapture } from '../src/server/conversation/trajectory.ts'
import type { HookRunRecord } from '../src/server/hooks/schema.ts'

/**
 * hooks 可观测通道测试：createHookCapture 与轨迹共用 JSONL 通道，
 * fire-and-forget、故障静默停写，绝不把采集异常抛进会话。
 */

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-hook-capture-'))
  tempDirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

const record: HookRunRecord = {
  ts: 1_700_000_000_000,
  conversationId: '42',
  event: 'PostToolUse',
  source: 'user',
  matcher: 'Write|Edit',
  command: 'node',
  outcome: 'success',
  durationMs: 12,
  exitCode: 0,
}

describe('createHookCapture', () => {
  // 写入 type:'hook' 行，字段完整；多次写入追加；目录自动创建。
  it('appends hook lines to the conversation JSONL and creates the dir', async () => {
    const dir = join(await tempDir(), 'nested', 'trajectories')
    const capture = createHookCapture(dir)
    capture(record)
    capture({ ...record, ts: record.ts + 1, outcome: 'blocked', exitCode: 2, error: '禁止' })
    await drainTrajectoryCapture()
    const lines = (await readFile(join(dir, '42.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0].type).toBe('hook')
    expect(lines[0].event).toBe('PostToolUse')
    expect(lines[0].conversationId).toBe('42')
    expect(lines[1].outcome).toBe('blocked')
    expect(lines[1].error).toBe('禁止')
  })

  // 写入失败（dir 是文件而非目录）不抛异常，静默停写。
  it('never throws when the capture target is unwritable', async () => {
    const dir = await tempDir()
    const blocker = join(dir, 'not-a-dir')
    await writeFile(blocker, 'x', 'utf8')
    const capture = createHookCapture(blocker)
    expect(() => capture(record)).not.toThrow()
    await drainTrajectoryCapture()
    // 再次写入也不抛（故障禁用后直接跳过）。
    expect(() => capture(record)).not.toThrow()
    await drainTrajectoryCapture()
  })
})