/**
 * pi-web 的无头 Chrome 工具，经 Chrome DevTools Protocol（CDP）驱动。
 *
 * 界面验证类任务（渲染缺陷、网页控制台、可视化冒烟检查）需要真实页面，shell 工具给
 * 不了；一次真实 RSI 轮次的轨迹显示模型会用 bash 手搓这套装置——启动 Chrome、写一次性
 * CDP 脚本、反复重取 URL token。本工具把这一流程收拢成一个原语：浏览器在 pi-web 进程
 * 内只启动一次并使用隔离配置目录，标签页跨调用复用，截图以模型可读的图像块返回。
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

/** 浏览器启动（含等待 DevTools 端口）的超时毫秒数。 */
const LAUNCH_TIMEOUT_MS = 20_000
/** 单次页面导航的超时毫秒数。 */
const NAVIGATION_TIMEOUT_MS = 20_000
/** 单条 CDP 命令的超时毫秒数。 */
const COMMAND_TIMEOUT_MS = 30_000
/** 返回给模型的页面文本上限（超出截断）。 */
const MAX_PAGE_TEXT_CHARS = 8_000
/** 截图输出的字节上限。 */
const SCREENSHOT_MAX_BYTES = 4 * 1_024 * 1_024

/** 工具名：`browser`。 */
export const BROWSER_TOOL_NAME = 'browser'

/* ------------------------------------------------------------------ */
/* 纯辅助函数（可离线单元测试）                                        */
/* ------------------------------------------------------------------ */

/**
 * 功能：按平台枚举 Chrome/Chromium 可执行文件的常见位置，可能性高的排前面。
 * @param platform 目标平台。
 * @param envPath 环境变量 PI_WEB_BROWSER_PATH 指定的优先路径。
 * @returns 候选路径数组（不检查存在性）。
 */
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

/**
 * 功能：返回第一个存在的候选可执行文件路径。
 * @param platform 目标平台。
 * @param exists 存在性检查函数（注入以便测试）。
 * @param envPath 优先路径。
 * @returns 可执行文件路径；未安装任何 Chromium 系浏览器时 undefined。
 */
export function resolveChromeExecutable(
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  envPath?: string,
): string | undefined {
  return chromeCandidates(platform, envPath).find(candidate => exists(candidate))
}

/**
 * 功能：解析 `DevToolsActivePort` 文件。布局：首行是调试端口，次行是 browser-target
 * 路径后缀；这里只需要端口。
 * @param text 文件内容。
 * @returns 合法端口号（1–65534 的整数）；不合法时 undefined。
 */
export function parseDevToolsActivePort(text: string): number | undefined {
  const first = text.split('\n')[0]?.trim()
  const port = Number(first)
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined
}

/** 生成一段单行页面脚本：点击第一个匹配 CSS 选择器的节点。 */
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
 * 功能：生成一段页面脚本：经原生 value setter 设置 input/textarea 的值并触发
 * `input` + `change` 事件，让框架监听器（React、Vue）感知这次编辑。
 * @param selector 目标元素的 CSS 选择器。
 * @param value 要填入的值。
 * @returns 可在页面内执行的脚本文本。
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
/* CDP 连接                                                            */
/* ------------------------------------------------------------------ */

/** 一条 CDP 消息（请求/响应/事件）的最小形状。 */
interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message: string }
  sessionId?: string
}

/** DevTools WebSocket 之上的极简 JSON-RPC 多路复用器。 */
class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly handlers: Array<(method: string, message: CdpMessage) => void> = []
  private closedByUs = false

  /**
   * 私有构造：挂接消息与关闭事件。带 id 的消息分派给 pending 的等待者（出错 reject、
   * 成功 resolve）；带 method 的事件广播给所有事件处理器；连接关闭时拒绝全部等待者。
   */
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

  /**
   * 功能：建立到 DevTools WebSocket 的连接。
   * 边界：连接受 LAUNCH_TIMEOUT_MS 超时约束，超时或出错抛 RuntimeError。
   * @param DevTools 的 ws:// 地址。
   * @returns 已就绪的 CdpConnection 实例。
   */
  static async connect(url: string): Promise<CdpConnection> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeError('UNSUPPORTED', 'DevTools WebSocket 连接超时')), LAUNCH_TIMEOUT_MS)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new RuntimeError('UNSUPPORTED', 'DevTools WebSocket 连接失败')) }, { once: true })
    })
    return new CdpConnection(ws)
  }

  /**
   * 功能：注册 CDP 事件处理器。
   * @param handler 收到事件时的回调（方法名 + 消息）。
   * @returns 取消注册的函数。
   */
  onEvent(handler: (method: string, message: CdpMessage) => void): () => void {
    this.handlers.push(handler)
    return () => {
      const index = this.handlers.indexOf(handler)
      if (index >= 0) this.handlers.splice(index, 1)
    }
  }

  /**
   * 功能：发送一条 CDP 命令并等待响应。
   * 边界：每条命令有 timeoutMs 超时（默认 COMMAND_TIMEOUT_MS），到点 reject；
   * 响应按自增 id 配对。
   * @param method CDP 方法名。
   * @param params 方法参数。
   * @param sessionId 目标会话（browser 级命令可省略）。
   * @param timeoutMs 超时毫秒数。
   * @returns 命令的 result 字段。
   */
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

  /** 连接是否仍可用：不是我们主动关闭的，且 WebSocket 处于 OPEN 状态。 */
  get alive(): boolean {
    return !this.closedByUs && this.ws.readyState === WebSocket.OPEN
  }

  /** 主动关闭连接；已在关闭中时静默忽略，剩余清理由浏览器 kill 路径负责。 */
  close(): void {
    this.closedByUs = true
    try {
      this.ws.close()
    } catch {
      // 可能已在关闭中；浏览器 kill 路径处理剩下的部分。
    }
  }
}

/* ------------------------------------------------------------------ */
/* 浏览器生命周期                                                      */
/* ------------------------------------------------------------------ */

/** 一个存活浏览器实例的状态：进程、配置目录、CDP 连接与已附着的页面目标。 */
interface BrowserState {
  chrome: ChildProcess
  profileDir: string
  cdp: CdpConnection
  targetId: string
  sessionId: string
}

/** 模块级单例：当前浏览器状态与进行中的启动 promise（并发调用共用同一次启动）。 */
let state: BrowserState | undefined
let launching: Promise<BrowserState> | undefined

/** 浏览器隔离配置目录：系统临时目录下的 pi-web-browser-profile。 */
function profileDirPath(): string {
  return join(tmpdir(), 'pi-web-browser-profile')
}

/**
 * 功能：轮询等待 Chrome 写出 DevToolsActivePort 文件并解析端口。
 * 边界：DevTools 服务器开始监听后文件才出现，轮询间隔 200ms；超过 LAUNCH_TIMEOUT_MS
 * 抛 RuntimeError。
 * @param profileDir 配置目录。
 * @returns 调试端口号。
 */
async function waitForDevToolsPort(profileDir: string): Promise<number> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
  try {
    const port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
    if (port !== undefined) return port
  } catch {
    // Chrome 的 DevTools 服务器开始监听后文件才会出现；继续轮询。
  }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new RuntimeError('UNSUPPORTED', `Chrome 未在 ${LAUNCH_TIMEOUT_MS / 1000}s 内输出 DevToolsActivePort`)
}

/**
 * 功能：启动无头 Chrome 并完成 CDP 握手。
 * 内部逻辑：解析可执行文件（找不到抛 UNSUPPORTED）；freshProfile 时先删旧配置目录；
 * 以 `--remote-debugging-port=0` 随机端口启动；进程退出时清空单例；等端口文件后取
 * browser WebSocket 地址并连接；创建 about:blank 目标、附着会话并启用 Page 域。
 * @param freshProfile 是否清空配置目录后启动。
 * @returns 就绪的浏览器状态。
 */
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

/**
 * 功能：获取可用的浏览器状态（复用或启动）。
 * 内部逻辑：现有状态健康（CDP 存活且进程未退出）时直接复用；否则启动一次——并发
 * 调用共享同一个 launching promise，避免重复拉起。
 * @param freshProfile 启动新实例时是否清空配置目录。
 * @returns 就绪的浏览器状态。
 */
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

/** 关闭浏览器：断开 CDP 并 kill 进程（若尚未退出），清空单例。 */
function killBrowser(): void {
  const current = state
  state = undefined
  if (current === undefined) return
  current.cdp.close()
  if (current.chrome.exitCode === null) current.chrome.kill()
}

// 进程退出兜底：杀掉仍在运行的 Chrome，避免残留进程。
if (typeof process !== 'undefined') {
  process.once('exit', () => {
    if (state?.chrome.exitCode === null) state.chrome.kill()
  })
}

/* ------------------------------------------------------------------ */
/* 页面操作                                                            */
/* ------------------------------------------------------------------ */

/**
 * 功能：导航到指定 URL 并返回页面摘要。
 * 边界：导航与加载各有 NAVIGATION_TIMEOUT_MS 超时；导航返回 errorText 抛 INVALID_INPUT；
 * abort 时立即中止。加载完成后再等 250ms 让动态内容稳定，然后读取页面摘要。
 * @param session 浏览器状态。
 * @param url 要打开的绝对 URL。
 * @param context 执行上下文（提供 abortSignal）。
 * @returns 标题/URL/页面文本组成的摘要。
 */
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

/**
 * 功能：读取当前页面的摘要（标题、URL、正文文本）。
 * 边界：正文经 Runtime.evaluate 取 innerText，超过 MAX_PAGE_TEXT_CHARS 时截断并标注
 * 总长度。
 * @param session 浏览器状态。
 * @returns 多行摘要文本。
 */
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

/**
 * 功能：在页面内执行 JS 表达式并返回结果文本。
 * 边界：脚本抛异常时抛 INVALID_INPUT（带异常描述）；结果值优先原样字符串，其余
 * JSON 序列化；无值时回落到运行时类型描述。
 * @param session 浏览器状态。
 * @param expression 页面内执行的 JavaScript 表达式。
 * @returns 结果的字符串表示。
 */
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

/**
 * 功能：截取当前页面 PNG，并附带标题/URL 说明文本。
 * 边界：Chrome 未返回截图数据抛 UNSUPPORTED；整页模式带 captureBeyondViewport；
 * 命令超时为 COMMAND_TIMEOUT_MS。
 * @param session 浏览器状态。
 * @param fullPage 是否截取视口之外的整页。
 * @returns base64 PNG 数据与说明文本。
 */
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
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

/** `browser` 工具：六种 action 操作无头 Chromium；边界见 execute 注释。 */
const browserTool = defineTool({
  name: BROWSER_TOOL_NAME,
  description: `通过 Chrome DevTools Protocol 操作无头 Chromium，用于 shell 工具无法完成的界面验证和页面检查（渲染缺陷、网页控制台、可视化冒烟检查）。action："open" 导航并返回标题、URL 和页面文本（必填 url）；"evaluate" 在页面运行 JS 表达式（必填 expression）；"click" 点击首个匹配 CSS 选择器的元素（必填 selector）；"fill" 设置 input/textarea 的值并触发 input/change 事件（必填 selector 和 value）；"screenshot" 以图像块返回 PNG（可选 fullPage）；"close" 关闭浏览器。每个 pi-web 进程仅启动一次浏览器，使用隔离的配置目录，调用间复用标签页；启动时传 freshProfile 可清空配置。截图成本较高，evaluate 或文本断言足够时优先使用它们。`,
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal('open'),
      Type.Literal('evaluate'),
      Type.Literal('click'),
      Type.Literal('fill'),
      Type.Literal('screenshot'),
      Type.Literal('close'),
    ], { description: '要执行的操作。' }),
    url: Type.Optional(Type.String({ description: 'open 操作的绝对 URL（http、https 或 file）。' })),
    expression: Type.Optional(Type.String({ description: 'evaluate 操作的 JavaScript 表达式。' })),
    selector: Type.Optional(Type.String({ description: 'click/fill 操作的 CSS 选择器。' })),
    value: Type.Optional(Type.String({ description: 'fill 操作要填写的值。' })),
    fullPage: Type.Optional(Type.Boolean({ description: 'screenshot 操作是否截取视口之外的整页。' })),
    freshProfile: Type.Optional(Type.Boolean({ description: '启动前清空浏览器配置目录（open 操作）。' })),
  }),
  outputLimits: { maxBytes: SCREENSHOT_MAX_BYTES },
  /**
   * 功能：按 action 分派浏览器操作（open/evaluate/click/fill/screenshot/close）。
   * 输入校验：先检查中止信号；open 要求 http(s)/file:// 绝对 URL；evaluate 要求非空
   * expression；click/fill 要求非空 selector（fill 还要求 value）；未识别的 action 落入
   * screenshot 分支前已穷尽枚举。
   * 边界：close 直接杀进程；浏览器进程内只启动一次并复用（freshProfile 可清空配置）；
   * 截图输出受 SCREENSHOT_MAX_BYTES 限制；导航/命令各有超时。
   */
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

/** browser 工具扩展：只贡献 `browser` 一个工具，不贡献 section。 */
export const BrowserTools: Extension = defineExtension({
  name: 'browser-tools',
  tools: [browserTool],
})
