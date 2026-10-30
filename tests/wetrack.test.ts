import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinFixturePath, readWetrackDefects, wetrackConfigured } from '../src/server/automation/wetrack.ts'

const DEMO_FIXTURE = resolve('plugins/wetrack-defects/fixtures/demo.json')
/** No fixture and no working CLI: the route must report "not configured" instead of inventing rows. */
const UNCONFIGURED = { ...process.env, WETRACK_FIXTURE: '', WETRACK_CLI_JSON: '', WETRACK_SCRIPT: '', WETRACK_CLI: 'pi-web-no-such-wetrack-cli' }

function nodeCli(script: string): NodeJS.ProcessEnv {
  return { ...process.env, WETRACK_FIXTURE: '', WETRACK_CLI: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: JSON.stringify([process.execPath, '-e', script]) }
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
})
