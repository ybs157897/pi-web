// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { networkFailureMessage, request } from '../src/web/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * 网络层异常必须换成可操作的中文提示。
 * 浏览器原文（Failed to fetch / Load failed）对用户没有意义，直接透出会让界面
 * 停在一条英文报错上（2026-11-20 工作台实际反馈的错误）。
 */
it('turns a browser network failure into an actionable message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  await expect(request('/api/anything')).rejects.toThrow('连不上服务：请确认后端进程仍在运行，或刷新页面重试。')
})

it('reports an aborted request as cancelled rather than as an English error', () => {
  const aborted = new DOMException('The operation was aborted.', 'AbortError')
  expect(networkFailureMessage(aborted)).toBe('请求已取消')
  const safariAborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
  expect(networkFailureMessage(safariAborted)).toBe('请求已取消')
})

it('keeps the server-provided message for HTTP failures', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '工作项不存在', code: 'NOT_FOUND' }), {
    status: 404, headers: { 'Content-Type': 'application/json' },
  })))
  await expect(request('/api/workbench/x')).rejects.toThrow('工作项不存在')
})

it('falls back to a readable message when the response body is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })))
  await expect(request('/api/workbench/x')).rejects.toThrow('请求失败（502）')
})
