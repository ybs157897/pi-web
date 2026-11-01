import { describe, expect, it } from 'vitest'
import { displayUrl, isLocalUrl, normalizeLocalUrl } from '../src/web/browser-url.ts'

describe('normalizeLocalUrl', () => {
  it('prepends http and keeps an explicit port for bare hosts', () => {
    expect(normalizeLocalUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeLocalUrl('localhost')).toBe('http://localhost/')
    expect(normalizeLocalUrl('localhost:5173/app')).toBe('http://localhost:5173/app')
  })

  it('accepts localhost subdomains', () => {
    expect(normalizeLocalUrl('sub.localhost:8080')).toBe('http://sub.localhost:8080/')
    expect(normalizeLocalUrl('a.b.localhost')).toBe('http://a.b.localhost/')
  })

  it('accepts the 127/8 range with optional ports', () => {
    expect(normalizeLocalUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(normalizeLocalUrl('127.9.9.9')).toBe('http://127.9.9.9/')
  })

  it('accepts bracketed IPv6 loopback', () => {
    expect(normalizeLocalUrl('[::1]:5173')).toBe('http://[::1]:5173/')
    expect(normalizeLocalUrl('[::1]/app')).toBe('http://[::1]/app')
  })

  it('passes full http(s) URLs through unchanged', () => {
    expect(normalizeLocalUrl('https://localhost:3000/x?y=1')).toBe('https://localhost:3000/x?y=1')
    expect(normalizeLocalUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/')
  })

  it('rejects non-local hosts and protocols', () => {
    expect(normalizeLocalUrl('example.com')).toBeNull()
    expect(normalizeLocalUrl('example.com:80')).toBeNull()
    expect(normalizeLocalUrl('http://example.com')).toBeNull()
    expect(normalizeLocalUrl('https://sub.example.com/a')).toBeNull()
    expect(normalizeLocalUrl('192.168.1.1:3000')).toBeNull()
    expect(normalizeLocalUrl('ftp://localhost')).toBeNull()
  })

  it('rejects empty and malformed input', () => {
    expect(normalizeLocalUrl('')).toBeNull()
    expect(normalizeLocalUrl('   ')).toBeNull()
    expect(normalizeLocalUrl('not a url')).toBeNull()
    expect(normalizeLocalUrl('127.999.0.1')).toBeNull()
  })

  it('trims surrounding whitespace and ignores host case', () => {
    expect(normalizeLocalUrl('  LOCALHOST:3000  ')).toBe('http://localhost:3000/')
  })
})

describe('isLocalUrl', () => {
  it('returns true for every local shape', () => {
    expect(isLocalUrl('http://localhost:3000/')).toBe(true)
    expect(isLocalUrl('http://sub.localhost/')).toBe(true)
    expect(isLocalUrl('https://127.0.0.1/x')).toBe(true)
    expect(isLocalUrl('http://127.1.2.3/')).toBe(true)
    expect(isLocalUrl('http://[::1]:5173/')).toBe(true)
  })

  it('returns false for external or unparsable values', () => {
    expect(isLocalUrl('http://example.com/')).toBe(false)
    expect(isLocalUrl('https://sub.example.com/a')).toBe(false)
    expect(isLocalUrl('not a url')).toBe(false)
    expect(isLocalUrl('')).toBe(false)
  })
})

describe('displayUrl', () => {
  it('drops default ports and the root path slash', () => {
    expect(displayUrl('http://localhost:80/')).toBe('http://localhost')
    expect(displayUrl('https://localhost:443/')).toBe('https://localhost')
  })

  it('keeps non-default ports and paths', () => {
    expect(displayUrl('http://localhost:3000/app')).toBe('http://localhost:3000/app')
    expect(displayUrl('http://127.0.0.1:8080/a/b?c=1')).toBe('http://127.0.0.1:8080/a/b?c=1')
  })

  it('returns the input as-is when it is not a URL', () => {
    expect(displayUrl('nope')).toBe('nope')
  })
})
