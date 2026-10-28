import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerMarkdown } from '../src/web/AnswerMarkdown.tsx'
import { parseAnswerFileLink, safeAnswerUrl, tableCsv, tableMarkdown, normalizeImageParagraphs, resolvedImageSource } from '../src/web/answer-markdown-model.ts'
import { markdownLabels } from '../src/web/render-labels.ts'

const t = (zh: string) => zh
const labels = markdownLabels(t)

describe('answer markdown contracts', () => {
  it('keeps file line references and rejects unsafe or ambiguous destinations', () => {
    expect(parseAnswerFileLink('src/a%20b.ts#L12-L18')).toEqual({ path: 'src/a b.ts', line: 12 })
    for (const value of ['javascript:alert(1)', '//evil.test/a', 'a.ts#L3-L2', 'a.ts?x=1', 'a%zz']) expect(parseAnswerFileLink(value)).toBeUndefined()
    expect(safeAnswerUrl('https://example.com')).toBe(true)
    expect(safeAnswerUrl('data:text/html,hello')).toBe(false)
  })
  it('resolves local media once, preserving escaped filename characters', () => {
    let requested = ''
    const resolve = (value: string) => { requested = value; return '/api/workspaces/test/asset?path=ok' }
    expect(resolvedImageSource('image%2520.png?width=400#preview', resolve)).toContain('/api/workspaces/test/asset')
    expect(requested).toBe('image%2520.png')
    expect(resolvedImageSource('javascript:alert(1)', resolve)).toBeUndefined()
  })
  it('exports valid Markdown and spreadsheet-safe CSV', () => {
    const rows = [['A', 'B'], ['a|b', '=2+2'], ['line\nnext', '"quoted"']]
    expect(tableMarkdown(rows)).toBe('| A | B |\n| --- | --- |\n| a\\|b | =2+2 |\n| line<br>next | "quoted" |')
    expect(tableCsv(rows)).toBe('\uFEFF"A","B"\r\n"a|b","\'=2+2"\r\n"line\nnext","""quoted"""')
    expect(tableCsv([[' \t+SUM(A1)', '@user', '-2', '\tvalue']])).toContain('"\' \t+SUM(A1)","\'@user","\'-2","\'\tvalue"')
  })
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
  it('resolves reference links across blocks and Windows workspace paths', () => {
    const text = '[reference][doc] and [Windows](C:\\work\\file.ts#L3)\n\nA later paragraph.\n\n[doc]: ./src/file.ts#L7'
    const html = renderToStaticMarkup(<AnswerMarkdown text={text} labels={labels} t={t} onOpenFile={() => {}} />)
    expect(html).toContain('title="./src/file.ts"')
    expect(html).toContain(String.raw`title="C:\work\file.ts"`)
    const hidden = renderToStaticMarkup(<AnswerMarkdown text={String.raw`[hidden](C:\work\.config\a.ts#L4)`} labels={labels} t={t} onOpenFile={() => {}} />)
    expect(hidden).toContain(String.raw`title="C:\work\.config\a.ts"`)
  })
  it('preserves single tildes and parses Chinese emphasis', () => {
    const html = renderToStaticMarkup(<AnswerMarkdown text={'中文**重点**文本和 ~普通~。'} labels={labels} t={t} />)
    expect(html).toMatch(/<strong\b[^>]*>重点<\/strong>/u)
    expect(html).toContain('~普通~')
    expect(html).not.toContain('<del>')
  })
  it('groups image paragraphs without rewriting fenced examples', () => {
    const outside = '![one](/one.png)\n\n![two](/two.png)'
    expect(normalizeImageParagraphs(outside)).toBe('![one](/one.png)\n![two](/two.png)')
    const fenced = '```markdown\n' + outside + '\n```'
    expect(normalizeImageParagraphs(fenced)).toBe(fenced)
  })
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
