import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  builtinFixturePath, readWetrackDefect, readWetrackDefects, readWetrackReport, wetrackConfigured, wetrackReportDir,
} from '../src/server/automation/wetrack.ts'

/**
 * WeTrack 自动化数据源契约测试：缺陷列表/详情的读取链路（fixture → CLI → rd-cli 信封）、
 * 数据归一化、配置探测与报告目录解析。
 */
const DEMO_FIXTURE = resolve('plugins/wetrack-defects/fixtures/demo.json')
/** 真实抓包样本不进 git；探针目录存在时按原字节回放。 */
const PROBE_SAMPLES = resolve('artifacts/wetrack-probe/samples')
const hasProbe = existsSync(PROBE_SAMPLES)
/** 无 fixture 且无可用 CLI：路由必须报「未配置」而不是编造行。 */
const UNCONFIGURED = { ...process.env, WETRACK_FIXTURE: '', WETRACK_CLI_JSON: '', WETRACK_SCRIPT: '', WETRACK_CLI: 'pi-web-no-such-wetrack-cli' }
/** rd-cli 替身：验证 `wetrack` 命名空间的添加方式，并回显收到的 argv。 */
const RDCLI_STUB = [
  '#!/usr/bin/env node',
  'process.stdout.write(JSON.stringify({ success: true, data: { items: [{ defectNumber: "DTS000000555", argv: process.argv.slice(2).join("|") }] } }))',
].join('\n')

/**
 * 构造以「node -e 脚本」为 CLI 后端的环境变量。
 * @param script CLI 被调用时执行的 Node 脚本（通常输出固定 JSON）
 * @returns 清空 fixture/script/CLI 配置、只留 WETRACK_CLI_JSON 的环境
 */
function nodeCli(script: string): NodeJS.ProcessEnv {
  return { ...process.env, WETRACK_FIXTURE: '', WETRACK_CLI: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: JSON.stringify([process.execPath, '-e', script]) }
}

/**
 * 用抓包样本按原字节回放，走真实的 spawn/解析路径。
 * @param name artifacts/wetrack-probe/samples 下的样本文件名
 * @param exitCode 附加给 CLI 的退出码（模拟业务失败）
 * @returns 带对应 nodeCli 环境的 Promise
 */
async function replayCli(name: string, exitCode = 0): Promise<NodeJS.ProcessEnv> {
  const text = await readFile(join(PROBE_SAMPLES, name), 'utf8')
  return nodeCli(`process.stdout.write(${JSON.stringify(text)})${exitCode === 0 ? '' : `;process.exitCode=${exitCode}`}`)
}

describe('wetrack list contract', () => {
  // 归一化契约：demo fixture 读取为 configured 列表，行只保留标量字段，
  // generatedAt 为本地时间格式。
  it('normalizes the bundled demo fixture and keeps scalar fields', async () => {
    const list = await readWetrackDefects({ env: UNCONFIGURED, fixture: DEMO_FIXTURE })
    expect(list.configured).toBe(true)
    expect(list.source).toBe('fixture')
    expect(list.count).toBe(2)
    expect(list.items.map(item => item.defectNumber)).toEqual(['DTS006749813', 'DTS006744740'])
    expect(list.items[1]).toMatchObject({
      defectStatusName: '待开发自验',
      severityName: '严重',
      projectName: 'Pro 融合 V2.0.0',
      submitTime: '2026-10-27 16:04:22',
    })
    expect(list.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)
  })

  // 内置 fixture 路径解析到插件目录旁的 demo.json，且可被读取。
  it('resolves the demo fixture path shipped beside the plugin', async () => {
    expect(builtinFixturePath()).toBe(DEMO_FIXTURE)
    const list = await readWetrackDefects({ env: UNCONFIGURED, fixture: builtinFixturePath() })
    expect(list.count).toBe(2)
  })

  // 载荷形状兼容：顶层数组、{pending:[...]}、{items:[...]} 都接受；
  // 缺缺陷号的行直接丢弃。
  it('accepts array, pending-array and items-only payloads and drops rows without a number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-'))
    try {
      const cases: Array<[string, unknown, number]> = [
        ['array.json', [{ defectNumber: 'DTS1' }, { defectNumber: 'DTS2' }], 2],
        ['pending-array.json', { pending: [{ defectNumber: 'DTS3' }] }, 1],
        ['items.json', { items: [{ defectNumber: 'DTS4' }, { simpleDesc: 'no number' }] }, 1],
        ['empty.json', {}, 0],
      ]
      for (const [name, payload, count] of cases) {
        const path = join(dir, name)
        await writeFile(path, JSON.stringify(payload), 'utf8')
        const list = await readWetrackDefects({ env: UNCONFIGURED, fixture: path })
        expect(list.count, name).toBe(count)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 行结构扁平化：详情形状的嵌套载荷（attachments/images 数组）不得进入表格行，
  // 只留标量字段 + 补空的 simpleDesc。
  it('keeps list rows flat: nested detail payloads never reach the table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-'))
    try {
      const path = join(dir, 'detail.json')
      await writeFile(path, JSON.stringify([{
        defectNumber: 'DTS5',
        severityName: '一般',
        attachments: [{ fileName: 'log.txt' }],
        images: ['C:\\tmp\\1.jpg'],
        score: 3,
      }]), 'utf8')
      const list = await readWetrackDefects({ env: UNCONFIGURED, fixture: path })
      expect(list.items[0]).toEqual({ defectNumber: 'DTS5', severityName: '一般', score: 3, simpleDesc: '' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 优先级：显式 WETRACK_FIXTURE 优先于内置兜底 fixture。
  it('prefers WETRACK_FIXTURE over the bundled fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-'))
    try {
      const path = join(dir, 'alternate.json')
      await writeFile(path, JSON.stringify([{ defectNumber: 'DTS9' }]), 'utf8')
      const list = await readWetrackDefects({ env: { ...process.env, WETRACK_FIXTURE: path }, fixture: DEMO_FIXTURE })
      expect(list.items.map(item => item.defectNumber)).toEqual(['DTS9'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 未配置体验：返回 configured:false + 空列表 + 配置指引（含各环境变量名），
  // 页面照常渲染而不是报错。
  it('reports an unconfigured service with setup guidance instead of failing the page', async () => {
    const list = await readWetrackDefects({ env: UNCONFIGURED })
    expect(list).toMatchObject({ configured: false, count: 0, items: [] })
    expect(list.notice).toContain('WETRACK_CLI_JSON')
    expect(list.notice).toContain('WETRACK_FIXTURE')
  })

  // 噪声容忍：CLI 输出前面带日志行时，解析器要能从中提取合法 JSON。
  it('runs the configured CLI and parses JSON wrapped in log noise', async () => {
    const script = 'process.stdout.write("starting\\n" + JSON.stringify({pending:{items:[{defectNumber:"DTS000000777",severityName:"严重"}]}}))'
    const list = await readWetrackDefects({ env: nodeCli(script) })
    expect(list).toMatchObject({ configured: true, source: 'pending', count: 1 })
    expect(list.items[0]).toEqual({ defectNumber: 'DTS000000777', severityName: '严重', simpleDesc: '' })
  })

  // rd-cli 信封三态：success 解包 data；空结果集仍是「已配置」来源；
  // 业务失败（stdout JSON + 非零退出）转为带「code：message（recover_hint）」的错误。
  it('unwraps the rd-cli success envelope and keeps the CLI error code and message', async () => {
    const wrapped = 'process.stdout.write(JSON.stringify({success:true,data:{items:[{defectNumber:"DTS000000888",severityName:"严重"}]}}))'
    const list = await readWetrackDefects({ env: nodeCli(wrapped) })
    expect(list).toMatchObject({ configured: true, source: 'pending', count: 1 })
    expect(list.items[0]).toEqual({ defectNumber: 'DTS000000888', severityName: '严重', simpleDesc: '' })

    // An empty result set is still a configured source, not a missing one.
    const empty = 'process.stdout.write(JSON.stringify({success:true,data:{items:[]}}))'
    expect(await readWetrackDefects({ env: nodeCli(empty) })).toMatchObject({ configured: true, count: 0, items: [] })

    // Business failures arrive as JSON on stdout with a non-zero exit code.
    const missing = 'process.stdout.write(JSON.stringify({success:false,error:{code:"BIZ_404",message:"问题单不存在",stage:"api"}}));process.exitCode=1'
    await expect(readWetrackDefects({ env: nodeCli(missing) })).rejects.toThrow(/BIZ_404：问题单不存在/u)

    const unauthorized = 'process.stdout.write(JSON.stringify({success:false,error:{code:"API_KEY_INVALID",message:"API Key 无效或已吊销",stage:"auth",recover_hint:"请检查 API Key 配置"}}));process.exitCode=3'
    await expect(readWetrackDefects({ env: nodeCli(unauthorized) })).rejects.toThrow(/API_KEY_INVALID：API Key 无效或已吊销（请检查 API Key 配置）/u)
  })

  // stderr 容错：CLI 不产 JSON 而往 stderr 打用法错误时，错误信息要透传。
  it('reports usage errors from stderr when the CLI prints no JSON', async () => {
    const script = 'process.stderr.write("Error: unknown flag: --project\\n");process.exitCode=1'
    await expect(readWetrackDefects({ env: nodeCli(script) })).rejects.toThrow(/unknown flag: --project/u)
  })

  // 参数传递契约：每个参数只出现一次且保持独立 argv 项（不受 shell 分词影响）。
  it('passes each argument once and keeps it a separate argv entry', async () => {
    const script = 'process.stdout.write(JSON.stringify({pending:{items:[{defectNumber:"DTS1",argv:process.argv.slice(1).join("|")}]}}))'
    const list = await readWetrackDefects({ env: nodeCli(script) })
    expect(list.items[0]?.argv).toBe('pending|--json')
  })

  // 命名空间规则：rd-cli 直调时补一次 `wetrack`；基命令里已带命名空间则不重复；
  // 脚本模式（wetrack.py 直收命令）不加命名空间。
  it.skipIf(process.platform === 'win32')('adds the wetrack namespace once, and only for rd-cli', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi web wetrack-'))
    try {
      const cli = join(dir, 'rd-cli')
      await writeFile(cli, RDCLI_STUB, 'utf8')
      await chmod(cli, 0o755)
      const base = { ...process.env, WETRACK_FIXTURE: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: '' }

      const direct = await readWetrackDefects({ env: { ...base, WETRACK_CLI: cli } })
      expect(direct.items[0]?.argv).toBe('wetrack|pending|--json')

      // 基命令里已显式带命名空间时保持原样，不二次追加。
      const explicit = await readWetrackDefects({ env: { ...base, WETRACK_CLI_JSON: JSON.stringify([cli, 'wetrack']) } })
      expect(explicit.items[0]?.argv).toBe('wetrack|pending|--json')

      // Python 脚本直接接收命令，命名空间不应出现。
      const scripted = await readWetrackDefects({ env: { ...base, WETRACK_SCRIPT: cli, WETRACK_PYTHON: process.execPath } })
      expect(scripted.items[0]?.argv).toBe('pending|--json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 仅 Windows：路径含空格的 .cmd 垫片能被正确 spawn，且命名空间与参数齐全。
  it.skipIf(process.platform !== 'win32')('runs a .cmd shim whose path contains spaces', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi web wetrack-'))
    try {
      const shim = join(dir, 'rd-cli.cmd')
      await writeFile(shim, '@echo off\r\necho {"success":true,"data":{"items":[{"defectNumber":"DTS000000999","argv":"%~1 %~2 %~3"}]}}\r\n', 'utf8')
      const list = await readWetrackDefects({ env: { ...process.env, WETRACK_FIXTURE: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: '', WETRACK_CLI: shim } })
      expect(list.count).toBe(1)
      expect(list.items[0]?.argv).toBe('wetrack pending --json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 失败面：非法 JSON、超时（60ms 上限）、CLI_JSON 配置形状错误都要报可读错误。
  it('surfaces CLI failures and timeouts as errors', async () => {
    await expect(readWetrackDefects({ env: nodeCli('process.stdout.write("not json")') })).rejects.toThrow(/合法 JSON/u)
    await expect(readWetrackDefects({ env: nodeCli('setTimeout(() => {}, 5000)'), timeoutMs: 60 })).rejects.toThrow(/秒未返回/u)
    await expect(readWetrackDefects({ env: { ...process.env, WETRACK_CLI: '', WETRACK_FIXTURE: '', WETRACK_CLI_JSON: '{"bad":true}' } })).rejects.toThrow(/字符串数组/u)
  })

  // 配置探测：四种来源（CLI/fixture/script/CLI_JSON）任一存在即视为已配置。
  it('detects whether any source is configured', () => {
    expect(wetrackConfigured({})).toBe(false)
    expect(wetrackConfigured({ WETRACK_CLI: 'rd-cli' })).toBe(true)
    expect(wetrackConfigured({ WETRACK_FIXTURE: 'fixtures/demo.json' })).toBe(true)
    expect(wetrackConfigured({ WETRACK_SCRIPT: '/tmp/wetrack.py' })).toBe(true)
    expect(wetrackConfigured({ WETRACK_CLI_JSON: '["python"]' })).toBe(true)
  })

  // 探针回放（需本地样本）：真实抓包的 pending/空列表/鉴权失败/详情 404 四种响应
  // 走真实 spawn/解析路径，验证对生产数据的兼容与错误映射。
  it.skipIf(!hasProbe)('replays the captured rd-cli responses', async () => {
    const pending = await readWetrackDefects({ env: await replayCli('pending.json') })
    expect(pending).toMatchObject({ configured: true, source: 'pending', count: 12 })
    expect(pending.items.every(item => /^DTS\d+$/u.test(item.defectNumber))).toBe(true)
    expect(typeof pending.items[0]?.simpleDesc).toBe('string')

    const empty = await readWetrackDefects({ env: await replayCli('advanced-query-empty.json') })
    expect(empty).toMatchObject({ configured: true, count: 0, items: [] })

    await expect(readWetrackDefects({ env: await replayCli('auth-failure.json', 3) })).rejects.toThrow(/API_KEY_INVALID/u)
    await expect(readWetrackDefects({ env: await replayCli('detail-not-found.json', 1) })).rejects.toThrow(/BIZ_404/u)
  })
})

describe('wetrack detail and report', () => {
  // 详情链路：CLI success 信封解包出缺陷与处理历史；业务失败（BIZ_404）保留原文。
  it('reads a defect detail from the CLI and keeps the business error', async () => {
    const script = 'process.stdout.write(JSON.stringify({success:true,data:{defectNumber:"DTS006744740",simpleDesc:"x",processHistories:[{createTime:"2026-10-30 15:29:39",remark:"批准"}]}}))'
    const detail = await readWetrackDefect('DTS006744740', { env: nodeCli(script) })
    expect(detail).toMatchObject({ configured: true })
    expect(detail.defect?.defectNumber).toBe('DTS006744740')
    expect(detail.defect?.processHistories?.[0]?.remark).toBe('批准')

    const missing = 'process.stdout.write(JSON.stringify({success:false,error:{code:"BIZ_404",message:"问题单不存在",stage:"api"}}));process.exitCode=1'
    await expect(readWetrackDefect('DTS000000000', { env: nodeCli(missing) })).rejects.toThrow(/BIZ_404：问题单不存在/u)
  })

  // fixture 详情：demo 里存在的号可读；不存在的号报「夹具中没有」；格式非法号直接拒绝。
  it('reads the demo fixture detail and refuses unknown numbers', async () => {
    const detail = await readWetrackDefect('DTS006744740', { env: UNCONFIGURED, fixture: DEMO_FIXTURE })
    expect(detail).toMatchObject({ configured: true })
    expect(detail.defect?.defectNumber).toBe('DTS006744740')
    await expect(readWetrackDefect('DTS000000000', { env: UNCONFIGURED, fixture: DEMO_FIXTURE })).rejects.toThrow(/夹具中没有/u)
    await expect(readWetrackDefect('not-a-defect', { env: UNCONFIGURED })).rejects.toThrow(/DTS/u)
  })

  // 详情参数形态：rd-cli 用 `--defect-number` 旗标；脚本模式用位置参数；
  // 两者都以 `--json` 收尾。
  it('passes --defect-number to rd-cli and a positional argument to wetrack.py', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'pi web wetrack-'))
    try {
      const cli = join(dir, 'rd-cli')
      await writeFile(cli, [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({ success: true, data: { defectNumber: "DTS006744740", argv: process.argv.slice(2).join("|") } }))',
      ].join('\n'), 'utf8')
      await chmod(cli, 0o755)
      const base = { ...process.env, WETRACK_FIXTURE: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: '' }

      const rdcli = await readWetrackDefect('DTS006744740', { env: { ...base, WETRACK_CLI: cli } })
      expect(rdcli.defect?.argv).toBe('wetrack|detail|--defect-number|DTS006744740|--json')

      const scripted = await readWetrackDefect('DTS006744740', { env: { ...base, WETRACK_CLI: '', WETRACK_SCRIPT: cli, WETRACK_PYTHON: process.execPath } })
      expect(scripted.defect?.argv).toBe('detail|DTS006744740|--json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 报告读取：WETRACK_REPORT_DIR 下按「<缺陷号>.md」查找，返回正文与更新时间；
  // 缺失文件返回 available:false 而非报错。
  it('reads an analysis document from the report directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-report-'))
    try {
      await writeFile(join(dir, 'DTS006761203.md'), '# 结论\n\n根因一句话', 'utf8')
      const found = await readWetrackReport('DTS006761203', { env: { ...process.env, WETRACK_REPORT_DIR: dir } })
      expect(found).toMatchObject({ available: true, directory: dir, file: 'DTS006761203.md' })
      expect(found.markdown).toContain('根因一句话')
      expect(found.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)

      const missing = await readWetrackReport('DTS000000000', { env: { ...process.env, WETRACK_REPORT_DIR: dir } })
      expect(missing).toMatchObject({ available: false, directory: dir, file: 'DTS000000000.md' })
      expect(missing.markdown).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 报告目录解析：环境变量为空时回退到数据目录下的 wetrack-reports；
  // 非法缺陷号在读取前即被拒绝。
  it('defaults the report directory under the data dir and rejects bad numbers', async () => {
    expect(wetrackReportDir({ WETRACK_REPORT_DIR: '' }, '/tmp/pi-web-data')).toBe(join('/tmp/pi-web-data', 'wetrack-reports'))
    expect(wetrackReportDir({ WETRACK_REPORT_DIR: '/tmp/reports' }, '/tmp/pi-web-data')).toBe('/tmp/reports')
    await expect(readWetrackReport('not-a-defect')).rejects.toThrow(/DTS/u)
  })
})
