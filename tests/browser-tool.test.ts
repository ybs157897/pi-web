import { describe, expect, it } from 'vitest'

// browser.ts 含 SideEffect 导入，须动态加载以便在导入期不拉起真实浏览器依赖。
const { chromeCandidates, clickScript, fillScript, parseDevToolsActivePort, resolveChromeExecutable } =
  await import('../src/server/tools/browser.ts')
const { BrowserTools } = await import('../src/server/tools/browser.ts')

/**
 * 浏览器工具的纯辅助函数测试。
 *
 * 关键契约：
 * - Chrome 可执行文件解析：环境变量提供的路径优先于平台默认，且必须真实存在；
 * - 候选清单按平台给出（mac 的 .app 路径、linux 的 /usr/bin、windows 的 chrome.exe），env 路径排最前；
 * - DevToolsActivePort 文件解析出端口号，0/非数字/空内容视为无效；
 * - 注入页面的点击/填充脚本用 JSON.stringify 转义选择器与值，填充后派发 input 事件。
 */
describe('browser tool helpers', () => {
  // env 指定的可执行文件优先于平台默认值；路径不存在时返回 undefined 而不是回退默认值。
  it('prefers the env-provided executable over platform defaults', () => {
    const platform = 'darwin' as NodeJS.Platform
    const exists = (path: string) => path === '/opt/chrome'
    expect(resolveChromeExecutable(platform, exists, '/opt/chrome')).toBe('/opt/chrome')
    expect(resolveChromeExecutable(platform, exists, '/missing')).toBeUndefined()
  })

  // 候选清单按平台区分：macOS 含 Google Chrome.app、Linux 含 /usr/bin/google-chrome、Windows 含 chrome.exe；env 路径始终排第一。
  it('lists platform-specific candidates with the env path first', () => {
    const mac = chromeCandidates('darwin', '/custom')
    expect(mac[0]).toBe('/custom')
    expect(mac.some(path => path.includes('Google Chrome.app'))).toBe(true)
    const linux = chromeCandidates('linux')
    expect(linux.some(path => path === '/usr/bin/google-chrome')).toBe(true)
    const win = chromeCandidates('win32')
    expect(win.some(path => path.endsWith('chrome.exe'))).toBe(true)
  })

  // DevToolsActivePort 文件首行为端口：正常数字解析成功；0、非数字、空文件都视为无效返回 undefined。
  it('parses the DevToolsActivePort file', () => {
    expect(parseDevToolsActivePort('39517\n/devtools/browser/x')).toBe(39_517)
    expect(parseDevToolsActivePort('0\n')).toBeUndefined()
    expect(parseDevToolsActivePort('not-a-port\n')).toBeUndefined()
    expect(parseDevToolsActivePort('')).toBeUndefined()
  })

  // 注入脚本对选择器与填充值做 JSON 转义（含引号/换行安全）；填充后必须派发 input 事件触发框架监听。
  it('builds page scripts with JSON-escaped selectors and values', () => {
    const selector = 'button[data-x="a\'b"]'
    expect(clickScript(selector)).toContain(JSON.stringify(selector))
    expect(fillScript(selector, 'value\nwith "quotes"')).toContain(JSON.stringify('value\nwith "quotes"'))
    expect(fillScript('input', 'v')).toContain("new Event('input', { bubbles: true })")
  })
})

/** 浏览器工具注册契约：只注册一个名为 browser 的工具，动作集有界且带截图能力。 */
describe('browser tool registration', () => {
  // BrowserTools 只暴露单个 browser 工具，描述提及 Chrome DevTools Protocol，参数枚举包含 open 与 screenshot 动作。
  it('registers a single browser tool with a bounded action set', () => {
    const tools = (BrowserTools as unknown as { tools: Array<{ name: string; description: string; parameters: unknown }> }).tools
    expect(tools.map(tool => tool.name)).toEqual(['browser'])
    expect(tools[0]?.description).toContain('Chrome DevTools Protocol')
    expect(JSON.stringify(tools[0]?.parameters)).toContain('"open"')
    expect(JSON.stringify(tools[0]?.parameters)).toContain('"screenshot"')
  })
})
