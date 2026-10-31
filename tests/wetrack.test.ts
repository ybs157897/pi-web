import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  builtinFixturePath, readWetrackDefect, readWetrackDefects, readWetrackReport, wetrackConfigured, wetrackReportDir,
} from '../src/server/automation/wetrack.ts'

const DEMO_FIXTURE = resolve('plugins/wetrack-defects/fixtures/demo.json')
/** Real captures stay out of git; when the probe folder is present its bytes are replayed as-is. */
const PROBE_SAMPLES = resolve('artifacts/wetrack-probe/samples')
const hasProbe = existsSync(PROBE_SAMPLES)
/** No fixture and no working CLI: the route must report "not configured" instead of inventing rows. */
const UNCONFIGURED = { ...process.env, WETRACK_FIXTURE: '', WETRACK_CLI_JSON: '', WETRACK_SCRIPT: '', WETRACK_CLI: 'pi-web-no-such-wetrack-cli' }
/** A stand-in for rd-cli: swings the `wetrack` namespace question and echoes the argv it received. */
const RDCLI_STUB = [
  '#!/usr/bin/env node',
  'process.stdout.write(JSON.stringify({ success: true, data: { items: [{ defectNumber: "DTS000000555", argv: process.argv.slice(2).join("|") }] } }))',
].join('\n')

function nodeCli(script: string): NodeJS.ProcessEnv {
  return { ...process.env, WETRACK_FIXTURE: '', WETRACK_CLI: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: JSON.stringify([process.execPath, '-e', script]) }
}

/** Replays a captured stdout byte-for-byte through the real spawn/parse path. */
async function replayCli(name: string, exitCode = 0): Promise<NodeJS.ProcessEnv> {
  const text = await readFile(join(PROBE_SAMPLES, name), 'utf8')
  return nodeCli(`process.stdout.write(${JSON.stringify(text)})${exitCode === 0 ? '' : `;process.exitCode=${exitCode}`}`)
}

describe('wetrack list contract', () => {
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

  it('resolves the demo fixture path shipped beside the plugin', async () => {
    expect(builtinFixturePath()).toBe(DEMO_FIXTURE)
    const list = await readWetrackDefects({ env: UNCONFIGURED, fixture: builtinFixturePath() })
    expect(list.count).toBe(2)
  })

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

  it('reports an unconfigured service with setup guidance instead of failing the page', async () => {
    const list = await readWetrackDefects({ env: UNCONFIGURED })
    expect(list).toMatchObject({ configured: false, count: 0, items: [] })
    expect(list.notice).toContain('WETRACK_CLI_JSON')
    expect(list.notice).toContain('WETRACK_FIXTURE')
  })

  it('runs the configured CLI and parses JSON wrapped in log noise', async () => {
    const script = 'process.stdout.write("starting\\n" + JSON.stringify({pending:{items:[{defectNumber:"DTS000000777",severityName:"严重"}]}}))'
    const list = await readWetrackDefects({ env: nodeCli(script) })
    expect(list).toMatchObject({ configured: true, source: 'pending', count: 1 })
    expect(list.items[0]).toEqual({ defectNumber: 'DTS000000777', severityName: '严重', simpleDesc: '' })
  })

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

  it('reports usage errors from stderr when the CLI prints no JSON', async () => {
    const script = 'process.stderr.write("Error: unknown flag: --project\\n");process.exitCode=1'
    await expect(readWetrackDefects({ env: nodeCli(script) })).rejects.toThrow(/unknown flag: --project/u)
  })

  it('passes each argument once and keeps it a separate argv entry', async () => {
    const script = 'process.stdout.write(JSON.stringify({pending:{items:[{defectNumber:"DTS1",argv:process.argv.slice(1).join("|")}]}}))'
    const list = await readWetrackDefects({ env: nodeCli(script) })
    expect(list.items[0]?.argv).toBe('pending|--json')
  })

  it.skipIf(process.platform === 'win32')('adds the wetrack namespace once, and only for rd-cli', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi web wetrack-'))
    try {
      const cli = join(dir, 'rd-cli')
      await writeFile(cli, RDCLI_STUB, 'utf8')
      await chmod(cli, 0o755)
      const base = { ...process.env, WETRACK_FIXTURE: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: '' }

      const direct = await readWetrackDefects({ env: { ...base, WETRACK_CLI: cli } })
      expect(direct.items[0]?.argv).toBe('wetrack|pending|--json')

      // An explicit namespace in the base is honoured, not doubled.
      const explicit = await readWetrackDefects({ env: { ...base, WETRACK_CLI_JSON: JSON.stringify([cli, 'wetrack']) } })
      expect(explicit.items[0]?.argv).toBe('wetrack|pending|--json')

      // A Python script takes the command directly, so the namespace must not appear.
      const scripted = await readWetrackDefects({ env: { ...base, WETRACK_SCRIPT: cli, WETRACK_PYTHON: process.execPath } })
      expect(scripted.items[0]?.argv).toBe('pending|--json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

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

  it('surfaces CLI failures and timeouts as errors', async () => {
    await expect(readWetrackDefects({ env: nodeCli('process.stdout.write("not json")') })).rejects.toThrow(/合法 JSON/u)
    await expect(readWetrackDefects({ env: nodeCli('setTimeout(() => {}, 5000)'), timeoutMs: 60 })).rejects.toThrow(/秒未返回/u)
    await expect(readWetrackDefects({ env: { ...process.env, WETRACK_CLI: '', WETRACK_FIXTURE: '', WETRACK_CLI_JSON: '{"bad":true}' } })).rejects.toThrow(/字符串数组/u)
  })

  it('detects whether any source is configured', () => {
    expect(wetrackConfigured({})).toBe(false)
    expect(wetrackConfigured({ WETRACK_CLI: 'rd-cli' })).toBe(true)
    expect(wetrackConfigured({ WETRACK_FIXTURE: 'fixtures/demo.json' })).toBe(true)
    expect(wetrackConfigured({ WETRACK_SCRIPT: '/tmp/wetrack.py' })).toBe(true)
    expect(wetrackConfigured({ WETRACK_CLI_JSON: '["python"]' })).toBe(true)
  })

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
  it('reads a defect detail from the CLI and keeps the business error', async () => {
    const script = 'process.stdout.write(JSON.stringify({success:true,data:{defectNumber:"DTS006744740",simpleDesc:"x",processHistories:[{createTime:"2026-10-30 15:29:39",remark:"批准"}]}}))'
    const detail = await readWetrackDefect('DTS006744740', { env: nodeCli(script) })
    expect(detail).toMatchObject({ configured: true })
    expect(detail.defect?.defectNumber).toBe('DTS006744740')
    expect(detail.defect?.processHistories?.[0]?.remark).toBe('批准')

    const missing = 'process.stdout.write(JSON.stringify({success:false,error:{code:"BIZ_404",message:"问题单不存在",stage:"api"}}));process.exitCode=1'
    await expect(readWetrackDefect('DTS000000000', { env: nodeCli(missing) })).rejects.toThrow(/BIZ_404：问题单不存在/u)
  })

  it('reads the demo fixture detail and refuses unknown numbers', async () => {
    const detail = await readWetrackDefect('DTS006744740', { env: UNCONFIGURED, fixture: DEMO_FIXTURE })
    expect(detail).toMatchObject({ configured: true })
    expect(detail.defect?.defectNumber).toBe('DTS006744740')
    await expect(readWetrackDefect('DTS000000000', { env: UNCONFIGURED, fixture: DEMO_FIXTURE })).rejects.toThrow(/夹具中没有/u)
    await expect(readWetrackDefect('not-a-defect', { env: UNCONFIGURED })).rejects.toThrow(/DTS/u)
  })

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

  it('defaults the report directory under the data dir and rejects bad numbers', async () => {
    expect(wetrackReportDir({ WETRACK_REPORT_DIR: '' }, '/tmp/pi-web-data')).toBe(join('/tmp/pi-web-data', 'wetrack-reports'))
    expect(wetrackReportDir({ WETRACK_REPORT_DIR: '/tmp/reports' }, '/tmp/pi-web-data')).toBe('/tmp/reports')
    await expect(readWetrackReport('not-a-defect')).rejects.toThrow(/DTS/u)
  })
})
