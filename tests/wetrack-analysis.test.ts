import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  analysisPath,
  deleteWetrackAnalysis,
  listWetrackAnalyses,
  readWetrackAnalysis,
  writeWetrackAnalysis,
} from '../src/server/automation/wetrack-analysis.ts'
import { createWetrackAnalysisExtension } from '../src/server/tools/wetrack-analysis.ts'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-analysis-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('wetrack analysis store', () => {
  it('writes one record and reads it back with the body unchanged', async () => {
    const markdown = '## 根因\n\n`canTransferApply` 用 `orgSource == 0` 判断归属。\n\n```java\nif (a) return false;\n```\n'
    const written = await writeWetrackAnalysis(dataDir, {
      defectNumber: 'DTS006761203', markdown, status: 'analyzed', title: '移交按钮误显示', summary: 'orgSource 判据失效',
    }, { conversationId: 'conv-1' })
    expect(written).toMatchObject({ defectNumber: 'DTS006761203', status: 'analyzed', conversationId: 'conv-1' })
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)

    const read = await readWetrackAnalysis(dataDir, 'DTS006761203')
    // The page renders this verbatim, so trimming or re-escaping would change the answer.
    expect(read?.markdown).toBe(markdown)
    expect(read?.title).toBe('移交按钮误显示')
  })

  it('overwrites instead of appending when the same defect is analyzed again', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '第一版结论', status: 'analyzing' })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '第二版结论', status: 'fixed' })
    const record = await readWetrackAnalysis(dataDir, 'DTS006761203')
    expect(record).toMatchObject({ markdown: '第二版结论', status: 'fixed' })
    // A title is never left blank: the list badge always has something to show.
    expect(record?.title).toBe('DTS006761203 分析')
  })

  it('rejects a bad defect number and an empty body', async () => {
    await expect(writeWetrackAnalysis(dataDir, { defectNumber: '../escape', markdown: 'x' })).rejects.toThrow(/DTS/u)
    await expect(writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '   ' })).rejects.toThrow(/markdown/u)
    expect(analysisPath(dataDir, 'DTS006761203').endsWith('DTS006761203.json')).toBe(true)
    await expect(Promise.resolve().then(() => analysisPath(dataDir, 'DTS006761203/../x'))).rejects.toThrow(/不合法/u)
  })

  it('lists summaries newest first without the bodies', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '较早', status: 'analyzed' })
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761142', markdown: '较新', status: 'fixed' })
    const summaries = await listWetrackAnalyses(dataDir)
    expect(summaries.map(summary => summary.defectNumber)).toEqual(['DTS006761142', 'DTS006761203'])
    expect(summaries[0]).not.toHaveProperty('markdown')
  })

  it('treats a missing, corrupt or foreign file as "not analyzed"', async () => {
    expect(await readWetrackAnalysis(dataDir, 'DTS000000001')).toBeUndefined()
    expect(await listWetrackAnalyses(dataDir)).toEqual([])

    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '正文' })
    await writeFile(analysisPath(dataDir, 'DTS006761203'), '{ not json', 'utf8')
    // A half-written record must not break the page; it just reads as unanalyzed.
    expect(await readWetrackAnalysis(dataDir, 'DTS006761203')).toBeUndefined()
    expect(await listWetrackAnalyses(dataDir)).toEqual([])
  })

  it('drops records whose body is missing so the page never renders a blank answer', async () => {
    const target = analysisPath(dataDir, 'DTS006761203')
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '正文' })
    const record = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
    await writeFile(target, JSON.stringify({ ...record, markdown: '' }), 'utf8')
    expect(await readWetrackAnalysis(dataDir, 'DTS006761203')).toBeUndefined()
  })

  it('deletes one record and refuses an invalid key', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '正文' })
    expect(await deleteWetrackAnalysis(dataDir, 'DTS006761203')).toBe(true)
    expect(await readWetrackAnalysis(dataDir, 'DTS006761203')).toBeUndefined()
    expect(await deleteWetrackAnalysis(dataDir, '../../etc/passwd')).toBe(false)
  })

  it('reads defect details on demand without HTML payloads or sensitive fields', async () => {
    const extension = createWetrackAnalysisExtension({
      dataDir,
      readDefect: async defectNumber => ({
        defectNumber,
        description: `<p>复现步骤 &amp; 预期结果</p><img src="data:image/png;base64,${'A'.repeat(80_000)}">`,
        downloadUrl: 'not-for-the-model',
      }),
    })
    const tool = extension.tools?.find(item => item.name === 'wetrack_analysis_detail')!
    const result = await tool.execute({ defectNumber: 'DTS006761203' }, {} as never, {} as never)
    const body = result.output?.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n') ?? ''
    const parsed = JSON.parse(body) as { defect: { description: string; downloadUrl?: string } }
    expect(parsed.defect.description).toBe('复现步骤 & 预期结果\n[图片]')
    expect(parsed.defect.downloadUrl).toBeUndefined()
    expect(body).not.toContain('base64')
    expect(body.length).toBeLessThan(500)
  })
})
