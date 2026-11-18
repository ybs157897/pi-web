import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerMarkdown } from '../src/web/AnswerMarkdown.tsx'
import { parseAnswerFileLink, safeAnswerUrl, tableCsv, tableMarkdown, normalizeImageParagraphs, resolvedImageSource } from '../src/web/answer-markdown-model.ts'
import { markdownLabels } from '../src/web/render-labels.ts'

const t = (zh: string) => zh
const labels = markdownLabels(t)

/**
 * 答案区 Markdown 渲染契约测试。
 *
 * 覆盖 AnswerMarkdown 及 answer-markdown-model 的关键约定：
 * - 文件行号链接解析只接受安全、无歧义的目标，外链须经 safeAnswerUrl 白名单校验；
 * - 本地图片资源只解析一次，且保留文件名中的转义字符；
 * - 表格导出产出合法 Markdown 与 Excel 安全的 CSV（公式注入加前缀、BOM 头）；
 * - 流式渲染阶段链接/图片能力保持惰性，落定后才启用；
 * - 引用式链接可跨段落解析，Windows 路径可用，隐藏目录除外；
 * - 单波浪号按字面保留、中文强调正常加粗，图片段落合并不碰围栏代码块示例；
 * - 表格/代码/公式正常渲染，javascript: 与 <script> 等不安全标记保持惰性。
 */
/** 回答区 Markdown 契约：链接安全、导出格式、流式惰性与富内容渲染。 */
describe('answer markdown contracts', () => {
  it('reveals live prose while leaving code, settled answers and replayed history intact', () => {
    const text = '价格规则\n\nSee `pricing.ts`'
    const live = renderToStaticMarkup(<AnswerMarkdown text={text} t={t} streaming />)
    expect(live).toContain('data-sd-animate')
    expect(live).toMatch(/<code[^>]*>pricing\.ts<\/code>/)
    expect(renderToStaticMarkup(<AnswerMarkdown text={text} t={t} />)).not.toContain('data-sd-animate')
    const history = '一段已存在的历史记录。\n\n'.repeat(70)
    expect(renderToStaticMarkup(<AnswerMarkdown text={history} t={t} streaming />)).not.toContain('data-sd-animate')
  })

  // 文件行号链接解析成功路径（含 URL 编码文件名、行区间取起始行），并拒绝 javascript:/协议相对/倒序区间/带查询/非法编码等目标。
  it('keeps file line references and rejects unsafe or ambiguous destinations', () => {
    expect(parseAnswerFileLink('src/a%20b.ts#L12-L18')).toEqual({ path: 'src/a b.ts', line: 12 })
    for (const value of ['javascript:alert(1)', '//evil.test/a', 'a.ts#L3-L2', 'a.ts?x=1', 'a%zz']) expect(parseAnswerFileLink(value)).toBeUndefined()
    expect(safeAnswerUrl('https://example.com')).toBe(true)
    expect(safeAnswerUrl('data:text/html,hello')).toBe(false)
  })
  // 本地图片经 resolve 回调只请求一次，路径保留 %25 等转义序列不做二次解码；非安全协议直接不解析。
  it('resolves local media once, preserving escaped filename characters', () => {
    let requested = ''
    const resolve = (value: string) => { requested = value; return '/api/workspaces/test/asset?path=ok' }
    expect(resolvedImageSource('image%2520.png?width=400#preview', resolve)).toContain('/api/workspaces/test/asset')
    expect(requested).toBe('image%2520.png')
    expect(resolvedImageSource('javascript:alert(1)', resolve)).toBeUndefined()
  })
  // 表格导出：Markdown 管道符需转义、换行折成 <br>；CSV 带 BOM、CRLF，且对公式字符（=、+、-、@、Tab 开头）加单引号前缀防注入。
  it('exports valid Markdown and spreadsheet-safe CSV', () => {
    const rows = [['A', 'B'], ['a|b', '=2+2'], ['line\nnext', '"quoted"']]
    expect(tableMarkdown(rows)).toBe('| A | B |\n| --- | --- |\n| a\\|b | =2+2 |\n| line<br>next | "quoted" |')
    expect(tableCsv(rows)).toBe('\uFEFF"A","B"\r\n"a|b","\'=2+2"\r\n"line\nnext","""quoted"""')
    expect(tableCsv([[' \t+SUM(A1)', '@user', '-2', '\tvalue']])).toContain('"\' \t+SUM(A1)","\'@user","\'-2","\'\tvalue"')
  })
  // 落定文本渲染文件链接 title 与已解析图片 src；streaming 模式下两者必须保持惰性不出现。
  it('preserves settled file and image capabilities while streaming stays inert', () => {
    const text = '[source](src/a.ts#L9) ![picture](/tmp/picture.png)'
    const pathImages = { resolve: (path: string) => path === '/tmp/picture.png' ? 'https://local.test/image.png' : undefined }
    const settled = renderToStaticMarkup(<AnswerMarkdown text={text} labels={labels} t={t} onOpenFile={() => {}} pathImages={pathImages} />)
    expect(settled).toContain('title="src/a.ts"')
    expect(settled).toContain('src="https://local.test/image.png"')
    const streaming = renderToStaticMarkup(<AnswerMarkdown text={text} labels={labels} t={t} streaming onOpenFile={() => {}} pathImages={pathImages} />)
    expect(streaming).not.toContain('title="src/a.ts"')
    expect(streaming).not.toContain('src="https://local.test/image.png"')
  })
  // 引用式链接定义可出现在后文段落，解析仍生效；Windows 盘符路径（含隐藏目录 .config）可作为链接目标。
  it('resolves reference links across blocks and Windows workspace paths', () => {
    const text = '[reference][doc] and [Windows](C:\\work\\file.ts#L3)\n\nA later paragraph.\n\n[doc]: ./src/file.ts#L7'
    const html = renderToStaticMarkup(<AnswerMarkdown text={text} labels={labels} t={t} onOpenFile={() => {}} />)
    expect(html).toContain('title="./src/file.ts"')
    expect(html).toContain(String.raw`title="C:\work\file.ts"`)
    const hidden = renderToStaticMarkup(<AnswerMarkdown text={String.raw`[hidden](C:\work\.config\a.ts#L4)`} labels={labels} t={t} onOpenFile={() => {}} />)
    expect(hidden).toContain(String.raw`title="C:\work\.config\a.ts"`)
  })
  // 单个波浪号按字面输出不生成删除线；中文语境的 **强调** 正常渲染为 <strong>。
  it('preserves single tildes and parses Chinese emphasis', () => {
    const html = renderToStaticMarkup(<AnswerMarkdown text={'中文**重点**文本和 ~普通~。'} labels={labels} t={t} />)
    expect(html).toMatch(/<strong\b[^>]*>重点<\/strong>/u)
    expect(html).toContain('~普通~')
    expect(html).not.toContain('<del>')
  })
  // 相邻独立图片段落合并为一个段落；围栏代码块内的图片示例原样保留不被改写。
  it('groups image paragraphs without rewriting fenced examples', () => {
    const outside = '![one](/one.png)\n\n![two](/two.png)'
    expect(normalizeImageParagraphs(outside)).toBe('![one](/one.png)\n![two](/two.png)')
    const fenced = '```markdown\n' + outside + '\n```'
    expect(normalizeImageParagraphs(fenced)).toBe(fenced)
  })
  // 综合渲染：表格工具条（预览表格）、文件链接、代码复制按钮、KaTeX 公式均出现；<script> 与 javascript: 链接不得进入输出。
  it('renders tables, links, code and math while keeping unsafe markup inert', () => {
    const text = '# 标题\n\n中文**强调** [文件](src/a.ts#L2) [坏链接](javascript:alert(1))\n\n| A | B |\n|---|---|\n|1|2|\n\n```ts\nconst a = 1\n```\n\n$E=mc^2$\n\n<script>alert(1)</script>'
    const html = renderToStaticMarkup(<AnswerMarkdown text={text} labels={labels} t={t} onOpenFile={() => {}} />)
    expect(html).toContain('预览表格')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('复制代码')
    expect(html).toContain('katex')
    expect(html).not.toMatch(/<script\b/u)
    expect(html).not.toMatch(/href="javascript:/u)
  })
})
