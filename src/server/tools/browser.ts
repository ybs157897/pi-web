/**
 * A headless-Chrome tool for pi-web, driven over the Chrome DevTools Protocol.
 *
 * UI-verification tasks (rendering bugs, web consoles, visual smoke checks)
 * need a real page, which shell tools cannot provide; the trajectory of a real
 * RSI round shows the model hand-rolling exactly this harness from bash —
 * launching Chrome, writing throwaway CDP scripts, re-deriving URL tokens
 * twelve times. This tool makes that workflow one primitive: the browser
 * launches once per pi-web process with an isolated profile, tabs are reused,
 * and screenshots come back as image blocks the model can read.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable'
import { RuntimeError } from '../runtime-errors.ts'

const LAUNCH_TIMEOUT_MS = 20_000
const NAVIGATION_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 30_000
const MAX_PAGE_TEXT_CHARS = 8_000
const SCREENSHOT_MAX_BYTES = 4 * 1_024 * 1_024

export const BROWSER_TOOL_NAME = 'browser'

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested offline)                                  */
/* ------------------------------------------------------------------ */

/** Well-known Chrome/Chromium executable locations per platform, most likely first. */
export function chromeCandidates(platform: NodeJS.Platform, envPath?: string): string[] {
  const candidates: string[] = []
  if (typeof envPath === 'string' && envPath.trim() !== '') candidates.push(envPath.trim())
  if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else if (platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['LOCALAPPDATA'], 'C:\\Program Files (x86)']
    for (const root of roots) {
      if (typeof root !== 'string') continue
      candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(join(root, 'Chromium', 'Application', 'chrome.exe'))
    }
  } else {
    for (const name of ['google-chrome', 'chromium-browser', 'chromium']) {
      candidates.push(`/usr/bin/${name}`)
      candidates.push(`/usr/local/bin/${name}`)
    }
  }
  return candidates
}

/** First existing candidate, or undefined when no Chromium browser is installed. */
export function resolveChromeExecutable(
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  envPath?: string,
): string | undefined {
  return chromeCandidates(platform, envPath).find(candidate => exists(candidate))
}

/**
 * `DevToolsActivePort` layout: first line is the debug port, second the
 * browser-target path suffix. Only the port is needed here.
 */
export function parseDevToolsActivePort(text: string): number | undefined {
  const first = text.split('\n')[0]?.trim()
  const port = Number(first)
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined
}

/** One-line script that clicks the first node matching a CSS selector. */
export function clickScript(selector: string): string {
  const literal = JSON.stringify(selector)
  return `(() => {
  const el = document.querySelector(${literal});
  if (!el) throw new Error('element not found: ' + ${literal});
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
})()`
}

/**
 * Sets an input/textarea value through the native setter and fires `input` +
 * `change`, so framework listeners (React, Vue) observe the edit.
 */
export function fillScript(selector: string, value: string): string {
  const literal = JSON.stringify(selector)
  const valueLiteral = JSON.stringify(value)
  return `(() => {
  const el = document.querySelector(${literal});
  if (!el) throw new Error('element not found: ' + ${literal});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, ${valueLiteral}); else el.value = ${valueLiteral};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`
}

/* ------------------------------------------------------------------ */
/* CDP connection                                                      */
/* ------------------------------------------------------------------ */

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message: string }
  sessionId?: string
}

/** Minimal JSON-RPC multiplexer over the DevTools WebSocket. */
class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly handlers: Array<(method: string, message: CdpMessage) => void> = []
  private closedByUs = false

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', event => {
      const data = (event as MessageEvent).data
      if (typeof data !== 'string') return
      let message: CdpMessage
      try {
        message = JSON.parse(data) as CdpMessage
      } catch {
        return
      }
      if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result)
        return
      }
      if (typeof message.method === 'string') {
        for (const handler of this.handlers) handler(message.method, message)
      }
    })
    ws.addEventListener('close', () => {
      for (const [, entry] of this.pending) entry.reject(new Error('DevTools connection closed'))
      this.pending.clear()
    })
  }

  static async connect(url: string): Promise<CdpConnection> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeError('UNSUPPORTED', 'DevTools WebSocket 连接超时')), LAUNCH_TIMEOUT_MS)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new RuntimeError('UNSUPPORTED', 'DevTools WebSocket 连接失败')) }, { once: true })
    })
    return new CdpConnection(ws)
  }

  onEvent(handler: (method: string, message: CdpMessage) => void): () => void {
    this.handlers.push(handler)
    return () => {
      const index = this.handlers.indexOf(handler)
      if (index >= 0) this.handlers.splice(index, 1)
    }
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId += 1
    const payload = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new RuntimeError('UNSUPPORTED', `CDP 命令超时：${method}`))
      }, timeoutMs)
    })
    this.ws.send(payload)
    return await result
  }

  get alive(): boolean {
    return !this.closedByUs && this.ws.readyState === WebSocket.OPEN
  }

  close(): void {
    this.closedByUs = true
    try {
      this.ws.close()
    } catch {
      // Already closing; the browser kill path handles the rest.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Browser lifecycle                                                   */
/* ------------------------------------------------------------------ */

interface BrowserState {
  chrome: ChildProcess
  profileDir: string
  cdp: CdpConnection
  targetId: string
  sessionId: string
}

let state: BrowserState | undefined
let launching: Promise<BrowserState> | undefined

function profileDirPath(): string {
  return join(tmpdir(), 'pi-web-browser-profile')
}

async function waitForDevToolsPort(profileDir: string): Promise<number> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
  try {
    const port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
    if (port !== undefined) return port
  } catch {
    // The file appears once Chrome's DevTools server is listening; keep polling.
  }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new RuntimeError('UNSUPPORTED', `Chrome 未在 ${LAUNCH_TIMEOUT_MS / 1000}s 内输出 DevToolsActivePort`)
}

async function launchBrowser(freshProfile: boolean): Promise<BrowserState> {
  const executable = resolveChromeExecutable(process.platform, existsSync, process.env['PI_WEB_BROWSER_PATH'])
  if (executable === undefined) {
    throw new RuntimeError('UNSUPPORTED', '未找到 Chrome/Chromium 可执行文件；可用环境变量 PI_WEB_BROWSER_PATH 指定路径。')
  }
  const profileDir = profileDirPath()
  if (freshProfile) await rm(profileDir, { recursive: true, force: true })
  const chrome = spawn(executable, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' })
  chrome.once('exit', () => {
    if (state?.chrome === chrome) state = undefined
  })
  const port = await waitForDevToolsPort(profileDir)
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json() as Promise<{ webSocketDebuggerUrl?: string }>)
  const wsUrl = version.webSocketDebuggerUrl?.replace('localhost', '127.0.0.1')
  if (typeof wsUrl !== 'string' || wsUrl === '') throw new RuntimeError('UNSUPPORTED', 'DevTools 未提供 browser WebSocket 地址')
  const cdp = await CdpConnection.connect(wsUrl)
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
  const attach = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId: string }
  await cdp.send('Page.enable', {}, attach.sessionId)
  return { chrome, profileDir, cdp, targetId: target.targetId, sessionId: attach.sessionId }
}

async function ensureBrowser(freshProfile: boolean): Promise<BrowserState> {
  if (state?.cdp.alive === true && state.chrome.exitCode === null) return state
  if (launching === undefined) {
    launching = launchBrowser(freshProfile)
      .then(async fresh => {
        state = fresh
        return fresh
      })
      .finally(() => {
        launching = undefined
      })
  }
  return await launching
}

function killBrowser(): void {
  const current = state
  state = undefined
  if (current === undefined) return
  current.cdp.close()
  if (current.chrome.exitCode === null) current.chrome.kill()
}

if (typeof process !== 'undefined') {
  process.once('exit', () => {
    if (state?.chrome.exitCode === null) state.chrome.kill()
  })
}

/* ------------------------------------------------------------------ */
/* Page operations                                                     */
/* ------------------------------------------------------------------ */

async function navigate(session: BrowserState, url: string, context: Context): Promise<string> {
  context.abortSignal?.throwIfAborted()
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RuntimeError('UNSUPPORTED', `页面加载超时（${NAVIGATION_TIMEOUT_MS / 1000}s）：${url}`)), NAVIGATION_TIMEOUT_MS)
    const unsubscribe = session.cdp.onEvent((method, message) => {
      if (method === 'Page.loadEventFired' && message.sessionId === session.sessionId) {
        unsubscribe()
        clearTimeout(timer)
        resolve()
      }
    })
  })
  const navigation = await session.cdp.send('Page.navigate', { url }, session.sessionId, NAVIGATION_TIMEOUT_MS) as { errorText?: string }
  if (typeof navigation.errorText === 'string') throw new RuntimeError('INVALID_INPUT', `页面打开失败：${navigation.errorText}`)
  await loaded
  await new Promise(resolve => setTimeout(resolve, 250))
  return await readPageSummary(session)
}

async function readPageSummary(session: BrowserState): Promise<string> {
  const evaluation = await session.cdp.send('Runtime.evaluate', {
    expression: `(() => ({ title: document.title, url: location.href, text: document.body ? document.body.innerText : '' }))()`,
    returnByValue: true,
  }, session.sessionId) as { result?: { value?: { title?: string; url?: string; text?: string } } }
  const value = evaluation.result?.value ?? {}
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  const clipped = text.length > MAX_PAGE_TEXT_CHARS ? `${text.slice(0, MAX_PAGE_TEXT_CHARS)}…[TRUNCATED ${text.length} chars]` : text
  const lines = [
    `页面已打开：${typeof value.title === 'string' && value.title !== '' ? value.title : '(无标题)'}`,
    `URL：${typeof value.url === 'string' ? value.url : 'unknown'}`,
  ]
  if (clipped !== '') lines.push(`页面文本（前 ${Math.min(text.length, MAX_PAGE_TEXT_CHARS)} 字符）：`, clipped)
  return lines.join('\n')
}

async function evaluateInPage(session: BrowserState, expression: string): Promise<string> {
  const evaluation = await session.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session.sessionId) as {
    result?: { value?: unknown; type?: string; description?: string }
    exceptionDetails?: { exception?: { description?: string }; text?: string }
  }
  if (evaluation.exceptionDetails !== undefined) {
    throw new RuntimeError('INVALID_INPUT', `页面脚本执行失败：${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`)
  }
  const value = evaluation.result
  if (value?.value !== undefined) return typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
  return value?.description ?? String(value?.type ?? 'undefined')
}

async function screenshotInPage(session: BrowserState, fullPage: boolean): Promise<{ data: string; text: string }> {
  const capture = await session.cdp.send('Page.captureScreenshot', { format: 'png', ...(fullPage ? { captureBeyondViewport: true } : {}) }, session.sessionId, COMMAND_TIMEOUT_MS) as { data?: string }
  if (typeof capture.data !== 'string' || capture.data === '') throw new RuntimeError('UNSUPPORTED', 'Chrome 未返回截图数据')
  const summary = await session.cdp.send('Runtime.evaluate', {
    expression: '(() => ({ url: location.href, title: document.title }))()',
    returnByValue: true,
  }, session.sessionId) as { result?: { value?: { url?: string; title?: string } } }
  const value = summary.result?.value ?? {}
  return {
    data: capture.data,
    text: `截图完成（${fullPage ? '整页' : '当前视口'}）：${typeof value.title === 'string' ? value.title : ''} ${typeof value.url === 'string' ? value.url : ''}`.trim(),
  }
}

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

const browserTool = defineTool({
  name: BROWSER_TOOL_NAME,
  description: `Drive a headless Chromium browser over the Chrome DevTools Protocol — for UI verification and page checks that shell tools cannot do (rendering bugs, web consoles, visual smoke checks). Actions: "open" navigates (url required) and returns title/URL/page text; "evaluate" runs a JS expression in the page (expression required); "click" clicks the first CSS-selector match (selector required); "fill" sets an input/textarea value and fires input/change events (selector + value required); "screenshot" returns a PNG as an image block (fullPage optional); "close" shuts the browser down. The browser launches once per pi-web process with an isolated profile and tabs are reused across calls; pass freshProfile to wipe the profile on launch. Screenshots are expensive — prefer evaluate/text assertions when they suffice.`,
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal('open'),
      Type.Literal('evaluate'),
      Type.Literal('click'),
      Type.Literal('fill'),
      Type.Literal('screenshot'),
      Type.Literal('close'),
    ], { description: 'Operation to perform.' }),
    url: Type.Optional(Type.String({ description: 'Absolute URL for the open action (http, https or file).' })),
    expression: Type.Optional(Type.String({ description: 'JavaScript expression for the evaluate action.' })),
    selector: Type.Optional(Type.String({ description: 'CSS selector for the click/fill actions.' })),
    value: Type.Optional(Type.String({ description: 'Value for the fill action.' })),
    fullPage: Type.Optional(Type.Boolean({ description: 'Capture beyond the viewport for the screenshot action.' })),
    freshProfile: Type.Optional(Type.Boolean({ description: 'Wipe the browser profile before launching (open action).' })),
  }),
  outputLimits: { maxBytes: SCREENSHOT_MAX_BYTES },
  execute: async (args, _api, context) => {
    context.abortSignal?.throwIfAborted()
    if (args.action === 'close') {
      killBrowser()
      return { output: [{ type: 'text' as const, text: '浏览器已关闭。' }] }
    }
    if (args.action === 'open') {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!/^https?:\/\//.test(url) && !/^file:\/\//.test(url)) {
        throw new RuntimeError('INVALID_INPUT', 'open 需要一个 http(s) 或 file:// 的绝对 URL。')
      }
      const session = await ensureBrowser(args.freshProfile === true)
      const summary = await navigate(session, url, context)
      return { output: [{ type: 'text' as const, text: summary }] }
    }
    const session = await ensureBrowser(false)
    context.abortSignal?.throwIfAborted()
    if (args.action === 'evaluate') {
      if (typeof args.expression !== 'string' || args.expression.trim() === '') {
        throw new RuntimeError('INVALID_INPUT', 'evaluate 需要非空的 expression。')
      }
      const result = await evaluateInPage(session, args.expression)
      return { output: [{ type: 'text' as const, text: result }] }
    }
    if (args.action === 'click') {
      if (typeof args.selector !== 'string' || args.selector.trim() === '') {
        throw new RuntimeError('INVALID_INPUT', 'click 需要非空的 selector。')
      }
      await evaluateInPage(session, clickScript(args.selector))
      await new Promise(resolve => setTimeout(resolve, 150))
      const summary = await readPageSummary(session)
      return { output: [{ type: 'text' as const, text: `已点击 ${JSON.stringify(args.selector)}。\n${summary}` }] }
    }
    if (args.action === 'fill') {
      if (typeof args.selector !== 'string' || args.selector.trim() === '' || typeof args.value !== 'string') {
        throw new RuntimeError('INVALID_INPUT', 'fill 需要非空的 selector 和 value。')
      }
      const applied = await evaluateInPage(session, fillScript(args.selector, args.value))
      return { output: [{ type: 'text' as const, text: `已填入 ${JSON.stringify(args.selector)}，当前值：${JSON.stringify(applied)}` }] }
    }
    const shot = await screenshotInPage(session, args.fullPage === true)
    return {
      output: [
        { type: 'text' as const, text: shot.text },
        { type: 'image' as const, data: shot.data, mimeType: 'image/png' },
      ],
    }
  },
})

export const BrowserTools: Extension = defineExtension({
  name: 'browser-tools',
  tools: [browserTool],
})
