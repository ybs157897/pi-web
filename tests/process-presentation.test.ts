import { describe, expect, it } from 'vitest'
import {
  defaultProcessOpen, latestReasoningLine, processGroupAutoOpen, processGroupBoundary, workGroupTitle,
} from '../src/web/process-presentation.ts'
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

describe('work group open state machine', () => {
  /** The `previous` × `boundary` × `defaultOpen` matrix of `processGroupAutoOpen`. */
  const autoOpenMatrix = [
    { previous: true, boundary: 'live-start', defaultOpen: true, open: true },
    { previous: true, boundary: 'live-start', defaultOpen: false, open: true },
    { previous: false, boundary: 'live-start', defaultOpen: true, open: true },
    { previous: false, boundary: 'live-start', defaultOpen: false, open: true },
    { previous: true, boundary: 'live-end', defaultOpen: true, open: true },
    { previous: true, boundary: 'live-end', defaultOpen: false, open: false },
    { previous: false, boundary: 'live-end', defaultOpen: true, open: true },
    { previous: false, boundary: 'live-end', defaultOpen: false, open: false },
    { previous: true, boundary: 'demote', defaultOpen: true, open: true },
    { previous: true, boundary: 'demote', defaultOpen: false, open: false },
    { previous: false, boundary: 'demote', defaultOpen: true, open: true },
    { previous: false, boundary: 'demote', defaultOpen: false, open: false },
    { previous: true, boundary: 'none', defaultOpen: true, open: true },
    { previous: true, boundary: 'none', defaultOpen: false, open: true },
    { previous: false, boundary: 'none', defaultOpen: true, open: false },
    { previous: false, boundary: 'none', defaultOpen: false, open: false },
  ] as const

  it('moves the auto state only on a boundary, exhaustively', () => {
    for (const cell of autoOpenMatrix) {
      expect(processGroupAutoOpen(cell.previous, cell.boundary, cell.defaultOpen), `${cell.previous}/${cell.boundary}/${cell.defaultOpen}`)
        .toBe(cell.open)
    }
  })

  /** The full `was` × `now` frame matrix of `processGroupBoundary`. */
  const boundaryMatrix = [
    { was: { live: false, latest: false }, now: { live: false, latest: false }, boundary: 'none' },
    { was: { live: false, latest: false }, now: { live: false, latest: true }, boundary: 'none' },
    { was: { live: false, latest: false }, now: { live: true, latest: false }, boundary: 'live-start' },
    { was: { live: false, latest: false }, now: { live: true, latest: true }, boundary: 'live-start' },
    { was: { live: false, latest: true }, now: { live: false, latest: false }, boundary: 'demote' },
    { was: { live: false, latest: true }, now: { live: false, latest: true }, boundary: 'none' },
    { was: { live: false, latest: true }, now: { live: true, latest: false }, boundary: 'live-start' },
    { was: { live: false, latest: true }, now: { live: true, latest: true }, boundary: 'live-start' },
    { was: { live: true, latest: false }, now: { live: false, latest: false }, boundary: 'live-end' },
    { was: { live: true, latest: false }, now: { live: false, latest: true }, boundary: 'live-end' },
    { was: { live: true, latest: false }, now: { live: true, latest: false }, boundary: 'none' },
    { was: { live: true, latest: false }, now: { live: true, latest: true }, boundary: 'none' },
    { was: { live: true, latest: true }, now: { live: false, latest: false }, boundary: 'live-end' },
    { was: { live: true, latest: true }, now: { live: false, latest: true }, boundary: 'live-end' },
    { was: { live: true, latest: true }, now: { live: true, latest: false }, boundary: 'none' },
    { was: { live: true, latest: true }, now: { live: true, latest: true }, boundary: 'none' },
  ] as const

  it('derives the boundary from frame facts, exhaustively', () => {
    for (const cell of boundaryMatrix) {
      expect(processGroupBoundary(cell.was, cell.now), `${JSON.stringify(cell.was)}→${JSON.stringify(cell.now)}`)
        .toBe(cell.boundary)
    }
  })

  /** A rendered frame stream: boundary frames interleaved with arbitrary noise frames. */
  const frames = [
    { live: true, latest: true }, { live: true, latest: true }, { live: true, latest: true },
    { live: false, latest: true },
    { live: false, latest: true }, { live: false, latest: true }, { live: false, latest: true },
    { live: false, latest: false },
    { live: false, latest: false }, { live: false, latest: false },
  ]

  it('keeps a detailed-mode group open through settle and folds it exactly once on demote', () => {
    const policy = presentationPolicyFor('detailed')
    let open = defaultProcessOpen(policy, true, true, false)
    const trace = [open]
    let was = { live: true, latest: true }
    for (const frame of frames) {
      const boundary = processGroupBoundary(was, frame)
      was = frame
      open = processGroupAutoOpen(open, boundary, defaultProcessOpen(policy, frame.latest, false, false))
      trace.push(open)
    }
    // live → settle keeps the latest turn open (history policy), the newer run folds it once,
    // and the noise frames after each boundary change nothing.
    expect(trace).toEqual([true, true, true, true, true, true, true, true, false, false, false])
  })

  it('folds a compact-mode group exactly once at settle', () => {
    const policy = presentationPolicyFor('compact')
    let open = defaultProcessOpen(policy, true, true, false)
    let was = { live: true, latest: true }
    for (const frame of frames) {
      const boundary = processGroupBoundary(was, frame)
      was = frame
      open = processGroupAutoOpen(open, boundary, defaultProcessOpen(policy, frame.latest, false, false))
    }
    expect(open).toBe(false)
  })

  it('never flaps on alternating stale frames that recompute the default', () => {
    // The pre-fix hazard: a settled group whose per-frame default keeps flipping. The sticky
    // state ignores every one of these frames because none of them is a boundary.
    let open = false
    for (let index = 0; index < 20; index += 1) {
      open = processGroupAutoOpen(open, 'none', index % 2 === 0)
    }
    expect(open).toBe(false)
  })
})
