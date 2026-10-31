import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const UI_DIR = resolve(ROOT, 'ui')
const UI_URI = 'ui://wetrack/board'
const MAX_REPORT_DEPTH = 5
const MAX_REPORT_NODES = 200
const CLI_TIMEOUT_MS = 45_000
// `.bat`/`.cmd` 不能直接 spawn：要么经 cmd.exe，要么被 Node 的 CVE-2024-27980 加固直接拒绝。
const WINDOWS_BATCH_FILE = /\.(?:bat|cmd)$/iu

// SurveyJS 发行产物保存在 ui/vendor/，启动时内联进 board.html 的标记位。
// 插件宿主的 CSP 只允许内联脚本/样式且禁止外链，页面必须自包含。
function replaceOnce(html, marker, content) {
  if (!html.includes(marker)) throw new Error(`board.html 缺少标记 ${marker}`)
  return html.replace(marker, () => content)
}

const uiHtml = await (async () => {
  let html = await readFile(resolve(UI_DIR, 'board.html'), 'utf8')
  const vendor = name => readFile(resolve(UI_DIR, 'vendor', name), 'utf8')
  html = replaceOnce(html, '/*__SURVEY_CSS__*/', await vendor('survey-core.min.css'))
  html = replaceOnce(html, '/*__SURVEY_CORE__*/', await vendor('survey.core.min.js'))
  html = replaceOnce(html, '/*__SURVEY_UI__*/', await vendor('survey-js-ui.min.js'))
  html = replaceOnce(html, '/*__SURVEY_I18N__*/', await vendor('survey-i18n-zh-cn.min.js'))
  html = replaceOnce(html, '/*__SURVEY_THEMES__*/', `${await vendor('survey-theme-default-light.min.js')}\n${await vendor('survey-theme-default-dark.min.js')}`)
  return html
})()

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function nowText() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function configError() {
  return [
    'WeTrack CLI 未配置。请给插件进程设置以下任一环境变量：',
    '1. WETRACK_CLI_JSON：JSON 数组，例如 ["python","C:\\\\tools\\\\wetrack.py"] 或 ["rd-cli"]',
    '2. WETRACK_SCRIPT：wetrack.py 的绝对路径（可选 WETRACK_PYTHON，默认 python）',
    '3. WETRACK_CLI：单个可执行文件或完整路径（例如 rd-cli，按 PATH/PATHEXT 查找）',
    '4. WETRACK_FIXTURE：本地 JSON 夹具路径（仅用于离线演示）',
  ].join('\n')
}

function commandBase() {
  const json = process.env.WETRACK_CLI_JSON
  if (json !== undefined && json.trim() !== '') {
    let parsed
    try { parsed = JSON.parse(json) } catch { throw new Error('WETRACK_CLI_JSON 不是合法 JSON 数组') }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== 'string' || item === '')) {
      throw new Error('WETRACK_CLI_JSON 必须是非空字符串数组')
    }
    return parsed
  }
  if (process.env.WETRACK_SCRIPT) return [process.env.WETRACK_PYTHON || 'python', process.env.WETRACK_SCRIPT]
  if (process.env.WETRACK_CLI) return [process.env.WETRACK_CLI]
  return ['rd-cli']
}

/** rd-cli 把 WeTrack 命令收在 `wetrack` 命名空间下；wetrack.py 直接收命令。 */
function isRdcli(base) {
  if ((process.env.WETRACK_SCRIPT || '').trim() !== '') return false
  return /^rd-cli(?:\.(?:exe|cmd|bat))?$/iu.test(basename(base[0]))
}

/** 命名空间紧跟程序名且只补一次：base 里已经写了 wetrack 就不再插。 */
function cliArgs(base, args) {
  const tail = [...base.slice(1), ...args]
  if (!isRdcli(base) || tail.includes('wetrack')) return tail
  return ['wetrack', ...tail]
}

/** Windows 上 spawn 只给裸命令名补 `.exe`，`.cmd`/`.bat` 垫片要自己按 PATHEXT 找。 */
function findOnPath(program) {
  if (process.platform !== 'win32') return undefined
  if (program === '' || /[\\/]/u.test(program) || /\.[^.\\/]+$/u.test(program)) return undefined
  const searchPath = process.env.PATH ?? process.env.Path ?? ''
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(extension => extension !== '')
  for (const directory of searchPath.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${program}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function resolveCommand(base) {
  const program = findOnPath(base[0]) ?? base[0]
  if (!WINDOWS_BATCH_FILE.test(program)) return { command: program, prefix: [], program, verbatim: false }
  const comspec = (process.env.ComSpec || '').trim()
  return { command: comspec === '' ? 'cmd.exe' : comspec, prefix: ['/d', '/s', '/c'], program, verbatim: true }
}

/** `/s` 会剥掉一层外层引号，所以整行和每一项都要预先加引号。 */
function batchCommandLine(program, args) {
  const parts = [program, ...args].map(value => `"${value.replaceAll('"', '\\"')}"`)
  return `"${parts.join(' ')}"`
}

function runCli(base, args) {
  const resolved = resolveCommand(base)
  const argv = cliArgs(base, args)
  const commandArgs = resolved.verbatim
    ? [...resolved.prefix, batchCommandLine(resolved.program, argv)]
    : [...resolved.prefix, ...argv]
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(resolved.command, commandArgs, {
      cwd: process.env.WETRACK_CWD || ROOT,
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectRun(error)
      else resolveRun(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`WeTrack CLI 超过 ${CLI_TIMEOUT_MS / 1000} 秒未返回`))
    }, CLI_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      finish(error.code === 'ENOENT' ? new Error(configError()) : error)
    })
    child.on('close', code => {
      // 业务失败是 stdout 上的 `{ success: false, error }` + 退出码 1/3；参数错误才是 stderr，
      // 所以先尝试解析 stdout，再决定要不要拿退出码当结论。
      let payload
      try { payload = parseJsonOutput(stdout) } catch (error) {
        if (code !== 0) {
          finish(new Error((stderr.trim() || `WeTrack CLI 退出码 ${code}`).slice(0, 4000)))
          return
        }
        finish(new Error(`WeTrack CLI 没有返回合法 JSON：${error instanceof Error ? error.message : String(error)}`))
        return
      }
      try {
        const value = unwrapEnvelope(payload)
        if (code === 0) {
          finish(null, value)
          return
        }
        finish(new Error((stderr.trim() || `WeTrack CLI 退出码 ${code}`).slice(0, 4000)))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

function parseJsonOutput(text) {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('输出为空')
  try { return JSON.parse(trimmed) } catch { /* try the first JSON value below */ }
  const objectStart = trimmed.indexOf('{')
  const arrayStart = trimmed.indexOf('[')
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart)
  if (start < 0) throw new Error('找不到 JSON')
  const end = trimmed[start] === '{' ? trimmed.lastIndexOf('}') : trimmed.lastIndexOf(']')
  if (end <= start) throw new Error('JSON 不完整')
  return JSON.parse(trimmed.slice(start, end + 1))
}

async function loadFixture() {
  const path = process.env.WETRACK_FIXTURE
  if (!path) return null
  const absolute = resolve(ROOT, path)
  const data = JSON.parse(await readFile(absolute, 'utf8'))
  if (typeof data !== 'object' || data === null) throw new Error('WETRACK_FIXTURE 必须是 JSON 对象')
  return data
}

/** rd-cli 的每条回复都包在 `{ success, data }` 里；wetrack.py 和夹具是平铺的。 */
function unwrapEnvelope(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('success' in payload)) return payload
  if (payload.success === false) {
    const failure = payload.error && typeof payload.error === 'object' ? payload.error : {}
    const code = typeof failure.code === 'string' ? failure.code : ''
    const message = typeof failure.message === 'string' ? failure.message : (typeof payload.message === 'string' ? payload.message : '')
    const hint = typeof failure.recover_hint === 'string' ? failure.recover_hint : ''
    const head = [code, message].filter(part => part !== '').join('：') || '未给出原因'
    throw new Error(`WeTrack CLI 返回失败：${head}${hint === '' ? '' : `（${hint}）`}`)
  }
  return 'data' in payload ? payload.data : payload
}

/** `{ pending: { items } }`、`{ pending: [] }`、`{ items: [] }` 和裸数组都可能出现。 */
function listItems(payload) {
  if (Array.isArray(payload)) return payload
  if (typeof payload !== 'object' || payload === null) return []
  const pending = payload.pending
  if (Array.isArray(pending)) return pending
  if (pending && typeof pending === 'object' && Array.isArray(pending.items)) return pending.items
  if (Array.isArray(payload.items)) return payload.items
  return []
}

function matches(value, needle) {
  return typeof value === 'string' && value.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
}

function filterFixtureItems(items, args) {
  return items.filter(item => {
    if (args.project && !matches(item.projectName, args.project) && !matches(item.projectNumber, args.project)) return false
    if (args.owner && !matches(item.creatorName, args.owner) && !matches(item.owner, args.owner)) return false
    if (args.status && !matches(item.defectStatusName, args.status) && !matches(item.defectStep, args.status)) return false
    return true
  })
}

function normalizeList(source, payload) {
  const items = listItems(unwrapEnvelope(payload))
  return {
    source,
    generatedAt: nowText(),
    count: items.length,
    items: items.map(item => ({ simpleDesc: '', ...item })),
  }
}

/** rd-cli 没有 `query`：过滤查询走 `advanced-query`，且参数名与 wetrack.py 完全不同。 */
function listArgs(args, rdcli) {
  const parts = [rdcli ? 'advanced-query' : 'query']
  if (args.project) parts.push(rdcli ? '--project-num' : '--project', String(args.project))
  if (args.owner) parts.push(rdcli ? '--cur-user-name' : '--owner', String(args.owner))
  if (args.status) parts.push(rdcli ? '--defect-status' : '--status', String(args.status))
  parts.push('--json')
  return parts
}

async function pending(args) {
  const fixture = await loadFixture()
  if (fixture) {
    const items = filterFixtureItems(listItems(fixture), args)
    return normalizeList(args.project || args.owner || args.status ? 'query' : 'pending', items)
  }
  const base = commandBase()
  if (!args.project && !args.owner && !args.status) return normalizeList('pending', await runCli(base, ['pending', '--json']))
  const rdcli = isRdcli(base)
  // advanced-query 要求项目编号/产品线/问题单号/需求编号至少填一项，只按负责人或状态过滤会 BIZ_400。
  if (rdcli && !args.project) throw new Error('rd-cli 的 advanced-query 至少要一个项目编号：请填写 project（--project-num）；只按负责人或状态过滤请改用 wetrack.py')
  return normalizeList('query', await runCli(base, listArgs(args, rdcli)))
}

async function detail(args) {
  const defectNumber = String(args.defectNumber || '').trim()
  if (!/^DTS\d{3,16}$/u.test(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字')
  const fixture = await loadFixture()
  if (fixture) {
    const details = fixture.details && typeof fixture.details === 'object' ? fixture.details : {}
    const found = details[defectNumber] ?? (fixture.detail && fixture.detail.defectNumber === defectNumber ? fixture.detail : undefined)
    if (!found) throw new Error(`夹具中没有 ${defectNumber}`)
    return { simpleDesc: '', ...found, defectNumber }
  }
  const base = commandBase()
  const parts = isRdcli(base) ? ['detail', '--defect-number', defectNumber, '--json'] : ['detail', defectNumber, '--json']
  return unwrapEnvelope(await runCli(base, parts))
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalizeNode(value, depth, counter) {
  if (depth > MAX_REPORT_DEPTH) throw new Error(`报告层级超过 ${MAX_REPORT_DEPTH} 层`)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('报告节点必须是对象')
  counter.count += 1
  if (counter.count > MAX_REPORT_NODES) throw new Error(`报告节点超过 ${MAX_REPORT_NODES} 个`)
  const title = cleanText(value.title, 300)
  if (title === '') throw new Error('报告节点必须有 title')
  const detail = cleanText(value.detail, 8000)
  const items = Array.isArray(value.items)
    ? value.items.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, 80).map(item => item.trim().slice(0, 4000))
    : []
  const children = Array.isArray(value.children)
    ? value.children.slice(0, 40).map(child => normalizeNode(child, depth + 1, counter))
    : []
  return { title, ...(detail === '' ? {} : { detail }), ...(items.length === 0 ? {} : { items }), ...(children.length === 0 ? {} : { children }) }
}

function normalizeReport(args) {
  const title = cleanText(args.title, 300)
  const conclusion = cleanText(args.conclusion, 8000)
  if (title === '' || conclusion === '') throw new Error('报告需要 title 和 conclusion')
  const defectNumber = cleanText(args.defectNumber, 64)
  if (defectNumber !== '' && !/^DTS\d{3,16}$/u.test(defectNumber)) throw new Error('defectNumber 格式不正确')
  if (!Array.isArray(args.sections)) throw new Error('报告需要 sections 数组')
  const counter = { count: 0 }
  return {
    kind: 'report',
    title,
    ...(defectNumber === '' ? {} : { defectNumber }),
    conclusion,
    generatedAt: nowText(),
    sections: args.sections.slice(0, 40).map(section => normalizeNode(section, 1, counter)),
  }
}

function uiResult(structured, summary) {
  // The model never sees structuredContent in this host; keep the full payload in text so
  // detail/process notes do not require a second CLI call or a temporary file.
  const body = JSON.stringify(structured)
  return {
    content: [{ type: 'text', text: `${summary}\n\n${body}` }],
    structuredContent: structured,
    _meta: {
      ui: {
        resourceUri: UI_URI,
        title: 'WeTrack 缺陷',
        heightHint: 680,
        preferredDisplayMode: 'fullscreen',
        // All WeTrack tool results share one side-pane tab; the page updates in place.
        toolCallId: 'wetrack-board',
      },
    },
  }
}

function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function listSummary(list) {
  const first = list.items.slice(0, 5).map(item => item.defectNumber).filter(Boolean).join('、')
  return `WeTrack ${list.source === 'query' ? '查询' : '待办'}：${list.count} 条${first ? `（${first}${list.count > 5 ? '…' : ''}）` : ''}`
}

function detailSummary(value) {
  return `${value.defectNumber ?? '缺陷'}：${value.defectStatusName ?? '状态未知'} · ${value.severityName ?? '严重程度未知'} · ${value.simpleDesc ?? ''}`.slice(0, 500)
}

const tools = [
  {
    name: 'wetrack_pending',
    description: '列出当前用户的 WeTrack 待办缺陷，或按 project/owner/status 组合查询。返回列表数据并渲染看板。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目编号，例如 DH3.RDA000902（rd-cli 只接受编号）' },
        owner: { type: 'string', description: '当前责任人工号，例如 340188' },
        status: { type: 'string', description: '状态编码，例如 205=待开发解决问题（rd-cli 只接受编码，wetrack.py 也接受名称）' },
      },
    },
  },
  {
    name: 'wetrack_detail',
    description: '读取一个 WeTrack 缺陷的完整详情（描述、人员、项目、附件、内嵌图片路径）并渲染详情。',
    inputSchema: {
      type: 'object',
      properties: { defectNumber: { type: 'string', description: 'DTS 编号，例如 DTS006744740' } },
      required: ['defectNumber'],
    },
  },
  {
    name: 'wetrack_report',
    description: '把对缺陷的代码分析整理成层级报告并渲染。必须先阅读相关代码和证据，再调用；不要编造未验证的结论。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '报告标题' },
        defectNumber: { type: 'string', description: '关联的 DTS 编号，可选' },
        conclusion: { type: 'string', description: '先给结论：是否能定位、根因、风险' },
        sections: {
          type: 'array',
          description: '报告章节树；每节有 title，可选 detail、items、children',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              items: { type: 'array', items: { type: 'string' } },
              children: { type: 'array', items: { type: 'object' } },
            },
            required: ['title'],
          },
        },
      },
      required: ['title', 'conclusion', 'sections'],
    },
  },
]

async function callTool(name, args) {
  if (name === 'wetrack_pending') {
    const list = await pending(args || {})
    return uiResult({ kind: 'pending', ...list }, listSummary(list))
  }
  if (name === 'wetrack_detail') {
    const value = await detail(args || {})
    return uiResult({ kind: 'detail', ...value }, detailSummary(value))
  }
  if (name === 'wetrack_report') {
    const report = normalizeReport(args || {})
    return uiResult(report, `已生成报告：${report.title}`)
  }
  return null
}

const resources = [{
  uri: UI_URI,
  name: 'WeTrack 缺陷看板',
  mimeType: 'text/html',
}]

createInterface({ input: process.stdin }).on('line', async line => {
  if (line.trim() === '') return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  try {
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'wetrack-defects', version: '1.1.0' },
      } })
      return
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools } })
      return
    }
    if (message.method === 'resources/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { resources } })
      return
    }
    if (message.method === 'resources/read') {
      const uri = message.params?.uri
      if (uri !== UI_URI) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown resource: ${uri}` } })
        return
      }
      send({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: UI_URI, mimeType: 'text/html', text: uiHtml }] } })
      return
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name
      const args = message.params?.arguments
      const result = await callTool(name, args && typeof args === 'object' ? args : {})
      if (result === null) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown tool: ${name}` } })
        return
      }
      send({ jsonrpc: '2.0', id: message.id, result })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    send({ jsonrpc: '2.0', id: message.id, result: errorResult(text) })
  }
})
