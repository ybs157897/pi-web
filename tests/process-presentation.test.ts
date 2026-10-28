import { describe, expect, it } from 'vitest'
import { defaultProcessOpen, latestReasoningLine, workGroupTitle } from '../src/web/process-presentation.ts'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'

const zh = (s: string) => s

describe('work and thought presentation', () => {
  it('follows the latest nonempty streamed line without waiting for a paragraph', () => {
    expect(latestReasoningLine('前一句\n\n  正在处理')).toBe('正在处理')
    expect(latestReasoningLine('前一句\r\n\r\n')).toBe('前一句')
    expect(latestReasoningLine('  ')).toBe('')
  })
  it('shows recorded duration and retains error and stop states', () => {
    expect(workGroupTitle({ status: 'completed', durationMs: 63_100 }, zh)).toBe('已工作 1 分 3 秒')
    expect(workGroupTitle({ status: 'running' }, zh)).toBe('工作中')
    expect(workGroupTitle({ status: 'completed', durationMs: 63_100 }, zh, true)).toBe('工作中')
    expect(workGroupTitle({ status: 'completed' }, zh)).toBe('已工作')
    expect(workGroupTitle({ status: 'error', durationMs: 1000 }, zh)).toBe('处理失败')
    expect(workGroupTitle({ status: 'cancelled' }, zh)).toBe('已停止')
  })
  it('preserves live work, interleaved user input, and detailed or deferred collapse', () => {
    const compact = presentationPolicyFor('compact')
    expect(defaultProcessOpen(compact, true, true, false)).toBe(true)
    expect(defaultProcessOpen(compact, true, false, false)).toBe(false)
    expect(defaultProcessOpen(compact, true, false, true)).toBe(true)
    expect(defaultProcessOpen(presentationPolicyFor('detailed'), true, false, false)).toBe(true)
    expect(defaultProcessOpen(presentationPolicyFor('detailed'), false, false, false)).toBe(false)
    expect(defaultProcessOpen(presentationPolicyFor('standard', 'next-input'), true, false, false)).toBe(true)
  })
})
