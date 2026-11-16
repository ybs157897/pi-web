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

/**
 * WeTrack 分析存储（analysis store）契约测试：按缺陷号读写分析结论、
 * 修订并发控制（expectedRevision）、受阻尝试不覆盖既有结论、损坏记录防御、
 * 列表摘要与详情工具的数据卫生（无 HTML/base64/敏感字段泄漏）。
 */
let dataDir: string

/** 每个用例一个全新的临时数据目录，互不共享记录。 */
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pi-web-wetrack-analysis-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('wetrack analysis store', () => {
  // 基本读写往返：markdown 正文（含中文标题、代码块）必须原样往返，
  // 页面按原文渲染，任何 trim 或再转义都会改变答案。
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

  // 同一缺陷再次分析时整条覆盖而非追加；未提供标题时回退为「<缺陷号> 分析」。
  it('overwrites instead of appending when the same defect is analyzed again', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '第一版结论', status: 'analyzing' })
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '第二版结论', status: 'fixed' })
    const record = await readWetrackAnalysis(dataDir, 'DTS006761203')
    expect(record).toMatchObject({ markdown: '第二版结论', status: 'fixed' })
    // A title is never left blank: the list badge always has something to show.
    expect(record?.title).toBe('DTS006761203 分析')
  })

  // 核心契约：后一次 blocked 尝试不得抹掉之前的 fixed 结论——正文与 status 保持
  // 旧结论，受阻信息记入 latestAttempt；修订号递增且从磁盘重读结果一致。
  it('preserves a reliable conclusion when a later attempt is blocked, including across restart reads', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '有证据的结论', status: 'fixed' }, { conversationId: 'old', expectedRevision: 0 })
    const saved = await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '权限不足，无法核对', status: 'blocked', blockedReason: 'access' }, { conversationId: 'new', expectedRevision: 1 })
    expect(saved).toMatchObject({ status: 'fixed', markdown: '有证据的结论', revision: 2, latestAttempt: { status: 'blocked', blockedReason: 'access', conversationId: 'new' } })
    expect(await readWetrackAnalysis(dataDir, 'DTS006761203')).toEqual(saved)
  })

  // 同理：analyzing（进行中/未核实）尝试也不得降级已核实的 analyzed 结论。
  it('does not replace a verified conclusion with an unverified attempt', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '已核实', status: 'analyzed' }, { expectedRevision: 0 })
    const saved = await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '有待核实', status: 'analyzing' }, { expectedRevision: 1 })
    expect(saved).toMatchObject({ status: 'analyzed', markdown: '已核实', latestAttempt: { status: 'analyzing', markdown: '有待核实' } })
  })

  // 损坏防御：磁盘记录损坏时拒绝写入（报「损坏」）且读取工具同样报错、原字节不动，
  // 避免 expectedRevision=0 的盲目覆盖把坏数据悄悄替换掉。
  it('refuses to overwrite a corrupt existing record even when the expected version is zero', async () => {
    const path = analysisPath(dataDir, 'DTS006761203')
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '原文' })
    await writeFile(path, '{ corrupt', 'utf8')
    await expect(writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '新文' }, { expectedRevision: 0 })).rejects.toThrow('损坏')
    const tool = createWetrackAnalysisExtension({ dataDir }).tools?.find(item => item.name === 'wetrack_analysis_get')!
    await expect(tool.execute({ defectNumber: 'DTS006761203' }, {} as never, {} as never)).rejects.toThrow('损坏')
    expect(await readFile(path, 'utf8')).toBe('{ corrupt')
  })

  // 并发与幂等：同修订号并发保存只允许一个成功；陈旧版本被拒；
  // 带相同修订号的精确重试成功且不重复记 attempt（attempts 仍为 1）；
  // 修订推进后旧任务重试被新数据覆盖（revision 2、attempts 2）。
  it('serializes concurrent saves, rejects stale versions, and accepts an exact retry', async () => {
    const input = { defectNumber: 'DTS006761203', markdown: '首次结论', status: 'analyzed' as const }
    const [first, second] = await Promise.allSettled([
      writeWetrackAnalysis(dataDir, input, { conversationId: 'first', expectedRevision: 0 }),
      writeWetrackAnalysis(dataDir, { ...input, markdown: '旧任务的结论' }, { conversationId: 'stale', expectedRevision: 0 }),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    const retry = await writeWetrackAnalysis(dataDir, input, { conversationId: 'first', expectedRevision: 0 })
    expect(retry).toMatchObject({ markdown: '首次结论', revision: 1 })
    expect(retry.attempts).toHaveLength(1)
    await writeWetrackAnalysis(dataDir, { ...input, markdown: '第二次结论' }, { conversationId: 'second', expectedRevision: 1 })
    const delayedRetry = await writeWetrackAnalysis(dataDir, input, { conversationId: 'first', expectedRevision: 0 })
    expect(delayedRetry).toMatchObject({ markdown: '第二次结论', revision: 2 })
    expect(delayedRetry.attempts).toHaveLength(2)
  })

  // 保留策略：attempts 封顶 5 条，但最新一条必须始终在列。
  it('caps the retained saved attempts while preserving the latest one', async () => {
    for (let i = 0; i < 8; i += 1) {
      await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: `尝试 ${i}`, status: 'blocked', blockedReason: 'budget-exhausted' }, { conversationId: `run-${i}`, expectedRevision: i })
    }
    const saved = await readWetrackAnalysis(dataDir, 'DTS006761203')
    expect(saved?.attempts).toHaveLength(5)
    expect(saved?.latestAttempt).toMatchObject({ markdown: '尝试 7', blockedReason: 'budget-exhausted' })
  })

  // 列表工具边界：集成未配置时以报错形式给出指引；51 条待办分页时
  // 第一页带 nextOffset=50，最后一页 nextOffset 为 null。
  it('reports an unconfigured integration and pages the complete pending list', async () => {
    const unconfigured = createWetrackAnalysisExtension({ dataDir, readDefects: async () => ({ configured: false, source: 'pending', generatedAt: '', count: 0, items: [], notice: '未配置' }) })
    const tool = unconfigured.tools?.find(item => item.name === 'wetrack_analysis_list')!
    await expect(tool.execute({}, {} as never, {} as never)).rejects.toThrow('未配置')
    const items = Array.from({ length: 51 }, (_, i) => ({ defectNumber: `DTS${String(i).padStart(9, '0')}`, simpleDesc: `item ${i}` }))
    const configured = createWetrackAnalysisExtension({ dataDir, readDefects: async () => ({ configured: true, source: 'pending', generatedAt: '', count: items.length, items }) })
    const list = configured.tools?.find(item => item.name === 'wetrack_analysis_list')!
    const first = await list.execute({}, {} as never, {} as never)
    const last = await list.execute({ offset: 50 }, {} as never, {} as never)
    expect(first.details).toMatchObject({ total: 51, nextOffset: 50 })
    expect(last.details).toMatchObject({ total: 51, nextOffset: null, items: [{ defectNumber: 'DTS000000050' }] })
  })

  // 输入校验：缺陷号必须匹配 DTS 格式（拒绝路径穿越）、正文不得为空白；
  // 合法号生成的文件路径固定为 <缺陷号>.json，带路径的号报「不合法」。
  it('rejects a bad defect number and an empty body', async () => {
    await expect(writeWetrackAnalysis(dataDir, { defectNumber: '../escape', markdown: 'x' })).rejects.toThrow(/DTS/u)
    await expect(writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '   ' })).rejects.toThrow(/markdown/u)
    expect(analysisPath(dataDir, 'DTS006761203').endsWith('DTS006761203.json')).toBe(true)
    await expect(Promise.resolve().then(() => analysisPath(dataDir, 'DTS006761203/../x'))).rejects.toThrow(/不合法/u)
  })

  // 列表契约：按更新时间新→旧排序，摘要不含 markdown 正文（省传输量）。
  // 等待 1.1 秒让两条记录的秒级时间戳可区分。
  it('lists summaries newest first without the bodies', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '较早', status: 'analyzed' })
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761142', markdown: '较新', status: 'fixed' })
    const summaries = await listWetrackAnalyses(dataDir)
    expect(summaries.map(summary => summary.defectNumber)).toEqual(['DTS006761142', 'DTS006761203'])
    expect(summaries[0]).not.toHaveProperty('markdown')
  })

  // 容错边界：文件缺失或损坏都读作「未分析」而非报错——半截记录不能打挂页面。
  it('treats a missing, corrupt or foreign file as "not analyzed"', async () => {
    expect(await readWetrackAnalysis(dataDir, 'DTS000000001')).toBeUndefined()
    expect(await listWetrackAnalyses(dataDir)).toEqual([])

    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '正文' })
    await writeFile(analysisPath(dataDir, 'DTS006761203'), '{ not json', 'utf8')
    // A half-written record must not break the page; it just reads as unanalyzed.
    expect(await readWetrackAnalysis(dataDir, 'DTS006761203')).toBeUndefined()
    expect(await listWetrackAnalyses(dataDir)).toEqual([])
  })

  // 数据卫生：正文为空的记录按「未分析」丢弃，页面永远不会渲染出空白答案。
  it('drops records whose body is missing so the page never renders a blank answer', async () => {
    const target = analysisPath(dataDir, 'DTS006761203')
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '正文' })
    const record = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
    await writeFile(target, JSON.stringify({ ...record, markdown: '' }), 'utf8')
    expect(await readWetrackAnalysis(dataDir, 'DTS006761203')).toBeUndefined()
  })

  // 删除契约：合法缺陷号删除返回 true 并消失；非法键（路径穿越）返回 false 不动文件。
  it('deletes one record and refuses an invalid key', async () => {
    await writeWetrackAnalysis(dataDir, { defectNumber: 'DTS006761203', markdown: '正文' })
    expect(await deleteWetrackAnalysis(dataDir, 'DTS006761203')).toBe(true)
    expect(await readWetrackAnalysis(dataDir, 'DTS006761203')).toBeUndefined()
    expect(await deleteWetrackAnalysis(dataDir, '../../etc/passwd')).toBe(false)
  })

  // 详情工具的数据卫生：描述 HTML 剥为纯文本（图片折叠为 [图片]）、
  // downloadUrl 等敏感/无意义字段不进模型、base64 载荷与超长响应都要剔除。
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
