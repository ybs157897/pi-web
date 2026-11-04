import { describe, expect, it } from 'vitest'

const { chromeCandidates, clickScript, fillScript, parseDevToolsActivePort, resolveChromeExecutable } =
  await import('../src/server/tools/browser.ts')
const { BrowserTools } = await import('../src/server/tools/browser.ts')

describe('browser tool helpers', () => {
  it('prefers the env-provided executable over platform defaults', () => {
    const platform = 'darwin' as NodeJS.Platform
    const exists = (path: string) => path === '/opt/chrome'
    expect(resolveChromeExecutable(platform, exists, '/opt/chrome')).toBe('/opt/chrome')
    expect(resolveChromeExecutable(platform, exists, '/missing')).toBeUndefined()
  })

  it('lists platform-specific candidates with the env path first', () => {
    const mac = chromeCandidates('darwin', '/custom')
    expect(mac[0]).toBe('/custom')
    expect(mac.some(path => path.includes('Google Chrome.app'))).toBe(true)
    const linux = chromeCandidates('linux')
    expect(linux.some(path => path === '/usr/bin/google-chrome')).toBe(true)
    const win = chromeCandidates('win32')
    expect(win.some(path => path.endsWith('chrome.exe'))).toBe(true)
  })

  it('parses the DevToolsActivePort file', () => {
    expect(parseDevToolsActivePort('39517\n/devtools/browser/x')).toBe(39_517)
    expect(parseDevToolsActivePort('0\n')).toBeUndefined()
    expect(parseDevToolsActivePort('not-a-port\n')).toBeUndefined()
    expect(parseDevToolsActivePort('')).toBeUndefined()
  })

  it('builds page scripts with JSON-escaped selectors and values', () => {
    const selector = 'button[data-x="a\'b"]'
    expect(clickScript(selector)).toContain(JSON.stringify(selector))
    expect(fillScript(selector, 'value\nwith "quotes"')).toContain(JSON.stringify('value\nwith "quotes"'))
    expect(fillScript('input', 'v')).toContain("new Event('input', { bubbles: true })")
  })
})

describe('browser tool registration', () => {
  it('registers a single browser tool with a bounded action set', () => {
    const tools = (BrowserTools as unknown as { tools: Array<{ name: string; description: string; parameters: unknown }> }).tools
    expect(tools.map(tool => tool.name)).toEqual(['browser'])
    expect(tools[0]?.description).toContain('Chrome DevTools Protocol')
    expect(JSON.stringify(tools[0]?.parameters)).toContain('"open"')
    expect(JSON.stringify(tools[0]?.parameters)).toContain('"screenshot"')
  })
})
