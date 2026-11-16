import { describe, expect, it } from 'vitest'
import { displayUrl, isLocalUrl, normalizeLocalUrl } from '../src/web/browser-url.ts'

/**
 * 浏览器地址栏 URL 归一化测试。
 *
 * 关键契约（三组纯函数）：
 * - normalizeLocalUrl 只接受本机地址（localhost 及其子域、127/8 全段、方括号 IPv6 回环），裸主机补 http://
 *   与显式端口，完整 http(s) URL 原样通过；非本机主机/协议/畸形输入返回 null；
 * - isLocalUrl 对同样的本机形态返回 true，外部或解析失败返回 false；
 * - displayUrl 去掉默认端口与根路径斜杠，非默认端口与路径保留，非 URL 原样返回。
 */

/** normalizeLocalUrl 契约：本机地址白名单、补全协议端口、拒绝一切非本机输入。 */
describe('normalizeLocalUrl', () => {
  // 裸主机自动补 http:// 协议；带端口保留端口；带路径保留路径。
  it('prepends http and keeps an explicit port for bare hosts', () => {
    expect(normalizeLocalUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeLocalUrl('localhost')).toBe('http://localhost/')
    expect(normalizeLocalUrl('localhost:5173/app')).toBe('http://localhost:5173/app')
  })

  // localhost 的任意层级子域（sub.localhost、a.b.localhost）都算本机地址。
  it('accepts localhost subdomains', () => {
    expect(normalizeLocalUrl('sub.localhost:8080')).toBe('http://sub.localhost:8080/')
    expect(normalizeLocalUrl('a.b.localhost')).toBe('http://a.b.localhost/')
  })

  // 整个 127/8 网段都算本机（不止 127.0.0.1），端口可选。
  it('accepts the 127/8 range with optional ports', () => {
    expect(normalizeLocalUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(normalizeLocalUrl('127.9.9.9')).toBe('http://127.9.9.9/')
  })

  // 方括号包裹的 IPv6 回环地址 [::1] 支持，端口与路径均可保留。
  it('accepts bracketed IPv6 loopback', () => {
    expect(normalizeLocalUrl('[::1]:5173')).toBe('http://[::1]:5173/')
    expect(normalizeLocalUrl('[::1]/app')).toBe('http://[::1]/app')
  })

  // 已经是完整 http(s) URL 的本机地址原样透传，不做改写。
  it('passes full http(s) URLs through unchanged', () => {
    expect(normalizeLocalUrl('https://localhost:3000/x?y=1')).toBe('https://localhost:3000/x?y=1')
    expect(normalizeLocalUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/')
  })

  // 非本机主机（公网域名、内网 IP 如 192.168.x.x）与非 http(s) 协议（ftp）一律拒绝返回 null。
  it('rejects non-local hosts and protocols', () => {
    expect(normalizeLocalUrl('example.com')).toBeNull()
    expect(normalizeLocalUrl('example.com:80')).toBeNull()
    expect(normalizeLocalUrl('http://example.com')).toBeNull()
    expect(normalizeLocalUrl('https://sub.example.com/a')).toBeNull()
    expect(normalizeLocalUrl('192.168.1.1:3000')).toBeNull()
    expect(normalizeLocalUrl('ftp://localhost')).toBeNull()
  })

  // 空串、纯空白、非 URL 文本、非法 IP 段（127.999）都返回 null。
  it('rejects empty and malformed input', () => {
    expect(normalizeLocalUrl('')).toBeNull()
    expect(normalizeLocalUrl('   ')).toBeNull()
    expect(normalizeLocalUrl('not a url')).toBeNull()
    expect(normalizeLocalUrl('127.999.0.1')).toBeNull()
  })

  // 输入首尾空白被修剪，主机名大小写不敏感（LOCALHOST 等价 localhost）。
  it('trims surrounding whitespace and ignores host case', () => {
    expect(normalizeLocalUrl('  LOCALHOST:3000  ')).toBe('http://localhost:3000/')
  })
})

/** isLocalUrl 契约：布尔判定与 normalizeLocalUrl 的白名单保持一致。 */
describe('isLocalUrl', () => {
  // 全部本机形态（localhost、子域、https、127/8、IPv6 回环）都判定为 true。
  it('returns true for every local shape', () => {
    expect(isLocalUrl('http://localhost:3000/')).toBe(true)
    expect(isLocalUrl('http://sub.localhost/')).toBe(true)
    expect(isLocalUrl('https://127.0.0.1/x')).toBe(true)
    expect(isLocalUrl('http://127.1.2.3/')).toBe(true)
    expect(isLocalUrl('http://[::1]:5173/')).toBe(true)
  })

  // 外部域名与解析失败（畸形/空串）的输入判定为 false，不抛异常。
  it('returns false for external or unparsable values', () => {
    expect(isLocalUrl('http://example.com/')).toBe(false)
    expect(isLocalUrl('https://sub.example.com/a')).toBe(false)
    expect(isLocalUrl('not a url')).toBe(false)
    expect(isLocalUrl('')).toBe(false)
  })
})

/** displayUrl 契约：面向展示的最短形式，非默认端口与路径保留。 */
describe('displayUrl', () => {
  // 默认端口（http 80 / https 443）与根路径斜杠不展示。
  it('drops default ports and the root path slash', () => {
    expect(displayUrl('http://localhost:80/')).toBe('http://localhost')
    expect(displayUrl('https://localhost:443/')).toBe('https://localhost')
  })

  // 非默认端口、路径与查询串原样保留。
  it('keeps non-default ports and paths', () => {
    expect(displayUrl('http://localhost:3000/app')).toBe('http://localhost:3000/app')
    expect(displayUrl('http://127.0.0.1:8080/a/b?c=1')).toBe('http://127.0.0.1:8080/a/b?c=1')
  })

  // 不是合法 URL 的输入原样返回，不做任何加工。
  it('returns the input as-is when it is not a URL', () => {
    expect(displayUrl('nope')).toBe('nope')
  })
})
