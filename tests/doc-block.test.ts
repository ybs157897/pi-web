import { describe, expect, it, vi } from 'vitest'

// 图标包在 Node 下会连带加载它自己的 CSS，单测只关心解析结果，整包换成空组件。
// `then` 必须给 undefined，否则这个代理会被当成 thenable 一直等下去。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => new Proxy({}, {
  get: (_target, key) => key === 'then' ? undefined : () => null,
  has: () => true,
  ownKeys: () => [],
  getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, writable: true, value: () => null }),
}))

import { renderToStaticMarkup } from 'react-dom/server'
import { DocBlockView, DOC_ICON_NAMES, parseDocBlock, parseDocBlockPartial } from '../src/web/DocBlock.tsx'
import { DOC_STYLE_ICONS, DOC_STYLE_INSTRUCTION, DOC_STYLE_JSON_SUFFIX } from '../src/server/doc-style-instruction.ts'

describe('doc block parsing', () => {
  it('reads the cards layout', () => {
    const parsed = parseDocBlock([
      'type: cards',
      'items:',
      '  - icon: text',
      '    title: 字重对比',
      '    body: 标题层用 Semibold，正文用常规字重。',
      '    bullets:',
      '      - 标题 600',
      '      - 正文 400',
    ].join('\n'))

    expect(parsed).toEqual({
      type: 'cards',
      items: [{
        icon: 'text',
        title: '字重对比',
        body: '标题层用 Semibold，正文用常规字重。',
        bullets: ['标题 600', '正文 400'],
      }],
    })
  })

  it('reads the compare layout with both panels', () => {
    const parsed = parseDocBlock([
      'type: compare',
      'left:',
      '  badge: cross',
      '  title: 旧方案',
      '  subtitle: 全局圆角',
      '  bullets:',
      '    - 层级不分',
      '  footer: 不推荐',
      'right:',
      '  badge: check',
      '  title: 新方案',
      '  bullets:',
      '    - 层级清晰',
    ].join('\n'))

    expect(parsed).toEqual({
      type: 'compare',
      left: { badge: 'cross', title: '旧方案', subtitle: '全局圆角', bullets: ['层级不分'], footer: '不推荐' },
      right: { badge: 'check', title: '新方案', subtitle: undefined, bullets: ['层级清晰'], footer: undefined },
    })
  })

  it('reads the note layout', () => {
    const parsed = parseDocBlock([
      'type: note',
      'icon: warn',
      'title: 注意',
      'body: 圆角只用于容器。',
      'code: "border-radius: 12px;"',
      'label: CSS',
    ].join('\n'))

    expect(parsed).toEqual({
      type: 'note',
      icon: 'warn',
      title: '注意',
      body: '圆角只用于容器。',
      code: 'border-radius: 12px;',
      label: 'CSS',
    })
  })

  it('reads the verification checklist', () => {
    const parsed = parseDocBlock([
      'type: checks',
      'items:',
      '  - status: pass',
      '    label: 构建',
      '    detail: npm run build 通过（3.17s）',
      '  - status: skip',
      '    label: 类型检查',
    ].join('\n'))

    expect(parsed).toEqual({
      type: 'checks',
      items: [
        { status: 'pass', label: '构建', detail: 'npm run build 通过（3.17s）' },
        { status: 'skip', label: '类型检查', detail: undefined },
      ],
    })
  })

  it('reads the changed-file list', () => {
    const parsed = parseDocBlock([
      'type: changes',
      'items:',
      '  - path: src/server/shell-tools.ts',
      '    summary: 新增原生 Windows PowerShell 工具',
      '    stats: +120 −0',
      '  - path: src/web/transcript.tsx',
    ].join('\n'))

    expect(parsed).toEqual({
      type: 'changes',
      items: [
        { path: 'src/server/shell-tools.ts', summary: '新增原生 Windows PowerShell 工具', stats: '+120 −0' },
        { path: 'src/web/transcript.tsx', summary: undefined, stats: undefined },
      ],
    })
  })

  it('unwraps a path the model wrapped in backticks', () => {
    // 契约要求路径用反引号包起来；path 字段本身已经是一个路径，
    // 带着反引号去显示和点击就都点不开。
    const parsed = parseDocBlock('type: changes\nitems:\n  - path: `docs/cookbook`\n    summary: 文档目录\n')
    expect(parsed).toMatchObject({ type: 'changes', items: [{ path: 'docs/cookbook' }] })
  })

  it('defaults the bullets to an empty list and the badge to none', () => {
    const cards = parseDocBlock('type: cards\nitems:\n  - title: 只有标题\n')
    expect(cards).toEqual({ type: 'cards', items: [{ icon: undefined, title: '只有标题', body: undefined, bullets: [] }] })

    const compare = parseDocBlock('type: compare\nleft:\n  title: 左\nright:\n  title: 右\n')
    expect(compare).toMatchObject({
      left: { badge: 'none', bullets: [] },
      right: { badge: 'none', bullets: [] },
    })
  })

  it('rejects blocks that miss a required field', () => {
    expect(parseDocBlock('type: cards\n')).toBeUndefined()
    expect(parseDocBlock('type: cards\nitems: []\n')).toBeUndefined()
    expect(parseDocBlock('type: cards\nitems:\n  - body: 没有标题\n')).toBeUndefined()
    expect(parseDocBlock('type: cards\nitems:\n  - title: "  "\n')).toBeUndefined()
    expect(parseDocBlock('type: compare\nleft:\n  title: 左\n')).toBeUndefined()
    expect(parseDocBlock('type: compare\nright:\n  title: 右\n')).toBeUndefined()
    expect(parseDocBlock('type: checks\nitems:\n  - label: 构建\n')).toBeUndefined()
    expect(parseDocBlock('type: checks\nitems:\n  - status: done\n    label: 构建\n')).toBeUndefined()
    expect(parseDocBlock('type: changes\nitems:\n  - summary: 没写路径\n')).toBeUndefined()
    expect(parseDocBlock('type: compare\nleft:\n  title: 左\nright:\n  subtitle: 没有标题\n')).toBeUndefined()
    // 标题和正文都没有的提示块没有可读内容。
    expect(parseDocBlock('type: note\nicon: info\n')).toBeUndefined()
  })

  it('rejects wrong field types', () => {
    expect(parseDocBlock('type: cards\nitems:\n  - title: 标题\n    bullets: 不是数组\n')).toBeUndefined()
    expect(parseDocBlock('type: cards\nitems:\n  - title: 标题\n    bullets:\n      - 42\n')).toBeUndefined()
    expect(parseDocBlock('type: cards\nitems:\n  - title: 标题\n    icon: 42\n')).toBeUndefined()
    expect(parseDocBlock('type: compare\nleft:\n  title: 左\nright:\n  title: 右\n  badge: yes\n')).toBeUndefined()
    expect(parseDocBlock('type: note\ntitle: 标题\nbody: 正文\ncode: 42\n')).toBeUndefined()
  })

  it('rejects unknown types, broken YAML, and YAML that is not a mapping', () => {
    expect(parseDocBlock('type: unknown\nitems: []\n')).toBeUndefined()
    // 引号/方括号没闭合现在会被修复救回来，这里换成结构不合法、修不回来的形状。
    expect(parseDocBlock('type: cards\nitems: 42\n')).toBeUndefined()
    expect(parseDocBlock('type: cards\nitems:\n  - title: x\n    bullets: 7\n')).toBeUndefined()
    expect(parseDocBlock('只是一段文本')).toBeUndefined()
    expect(parseDocBlock('- 一\n- 二\n')).toBeUndefined()
    expect(parseDocBlock('')).toBeUndefined()
  })
})

describe('partial blocks while streaming', () => {
  it('renders the entries that are already complete', () => {
    const source = [
      'type: cards',
      'items:',
      '  - icon: api',
      '    title: 架构',
      '  - icon: layers',
      '    title: 通道',
    ].join('\n')
    expect(parseDocBlockPartial(source)).toMatchObject({
      type: 'cards',
      items: [{ title: '架构' }, { title: '通道' }],
    })
  })

  it('drops a trailing entry whose title has not arrived yet', () => {
    const source = ['type: cards', 'items:', '  - icon: api', '    title: 架构', '  - icon: layers'].join('\n')
    expect(parseDocBlockPartial(source)).toMatchObject({ type: 'cards', items: [{ title: '架构' }] })
  })

  it('returns nothing before the first complete entry', () => {
    expect(parseDocBlockPartial('type: cards\nitems:\n  - icon: api')).toBeUndefined()
    expect(parseDocBlockPartial('type: car')).toBeUndefined()
  })

  it('renders partial cards and hides a block that has not formed yet', () => {
    // 流式中且没成形：先不显示，避免闪一坨原始 YAML。
    expect(DocBlockView({ source: 'type: cards\nitems:\n  - icon: api', partial: true, streaming: true })).toBeNull()
    // 已成形：带 data-doc-partial 渲染卡片。
    const html = renderToStaticMarkup(DocBlockView({ source: 'type: cards\nitems:\n  - title: 架构', partial: true, streaming: true })!)
    expect(html).toContain('data-doc-partial')
    expect(html).toContain('架构')
    // 流式结束、围栏始终没闭合：退回原文兜底，内容不丢。
    const settled = renderToStaticMarkup(DocBlockView({ source: 'type: cards\nitems:\n  - icon: api', partial: true, streaming: false })!)
    expect(settled).toContain('data-doc-block="invalid"')
  })

  it('renders the finished entries of a JSON payload while it is still streaming', () => {
    // 结构化输出的模型一行写完 JSON，没有「按行往回退」可退。
    const source = '{"type":"cards","items":[{"icon":"text","title":"字重对比"},{"icon":"code","title":"代码'
    expect(parseDocBlockPartial(source)).toMatchObject({
      type: 'cards',
      items: [{ title: '字重对比' }],
    })
  })

  it('drops the entry a JSON payload has not finished writing', () => {
    const source = '{"type":"checks","items":[{"status":"pass","label":"全局态清单"},{"status":"skip","label":"团'
    expect(parseDocBlockPartial(source)).toMatchObject({
      type: 'checks',
      items: [{ label: '全局态清单' }],
    })
  })

  it('returns nothing before a JSON payload has a finished entry', () => {
    expect(parseDocBlockPartial('{"type":"cards","items":[{"icon":"te')).toBeUndefined()
    expect(parseDocBlockPartial('{"type":"car')).toBeUndefined()
  })
})

describe('format contract', () => {
  it('every example in the instruction parses as a block', () => {
    // 模型会照抄示例；示例写错就等于把错误示范发给模型。
    const blocks = [...DOC_STYLE_INSTRUCTION.matchAll(/```doc\n([\s\S]*?)```/gu)].map(match => match[1])
    expect(blocks.length).toBeGreaterThanOrEqual(6)
    for (const block of blocks) expect(parseDocBlock(block)).toBeDefined()
  })

  it('covers the developer blocks in the complete example', () => {
    expect(DOC_STYLE_INSTRUCTION).toContain('type: changes')
    expect(DOC_STYLE_INSTRUCTION).toContain('type: checks')
  })

  it('offers exactly the icons the contract allows', () => {
    // 契约里写了图标名，渲染器却没有对应组件，模型就会拿到一个画不出来的名字。
    expect([...DOC_ICON_NAMES].sort()).toEqual([...DOC_STYLE_ICONS].sort())
  })
})

describe('doc block rendering', () => {
  it('marks the root element so the transcript can find the block', () => {
    const html = renderToStaticMarkup(DocBlockView({ source: 'type: note\ntitle: 注意\nbody: 正文\n' })!)

    expect(html).toContain('data-doc-block="note"')
    expect(html).toContain('注意')
  })

  it('keeps the authored text when the source cannot be rescued', () => {
    // 结构不合法（items 不是数组）没法靠引号修复；整块消失会悄悄删掉一节回答。
    const broken = 'type: cards\nitems: 42\n'
    const html = renderToStaticMarkup(DocBlockView({ source: broken })!)
    expect(html).toContain('data-doc-block="invalid"')
    expect(html).toContain('items: 42')
  })
})

describe('reserved-character repair', () => {
  it('reads a bullet that starts with an inline-code backtick', () => {
    const parsed = parseDocBlock([
      'type: cards',
      'items:',
      '  - icon: doc',
      '    title: 架构',
      '    bullets:',
      '      - `messagepush-design.md` (12 KB, 设计评审稿)',
    ].join('\n'))
    expect(parsed).toEqual({
      type: 'cards',
      items: [{ icon: 'doc', title: '架构', body: undefined, bullets: ['`messagepush-design.md` (12 KB, 设计评审稿)'] }],
    })
  })

  it('reads a value that starts with an inline-code backtick', () => {
    const parsed = parseDocBlock('type: note\ntitle: 验证\nbody: `npm test` 通过\n')
    expect(parsed).toEqual({ type: 'note', icon: undefined, title: '验证', body: '`npm test` 通过', code: undefined, label: undefined })
  })

  it('still rejects a block that the repair cannot rescue', () => {
    expect(parseDocBlock('type: cards\nitems: 42\n')).toBeUndefined()
    expect(parseDocBlock('type: checks\nitems:\n  - label: 构建\n')).toBeUndefined()
  })

  it('keeps a hash inside a value instead of letting YAML truncate it', () => {
    // `title: 修复 #123` 是合法 YAML：解析成功，但值是「修复」——唯一会静默少内容的写法。
    const parsed = parseDocBlock('type: note\ntitle: 修复 #123\nbody: 说明\n')
    expect(parsed).toMatchObject({ type: 'note', title: '修复 #123' })
  })

  it('keeps a bullet that starts with bold or a hash', () => {
    const parsed = parseDocBlock([
      'type: cards',
      'items:',
      '  - title: 要点',
      '    bullets:',
      '      - **重要**：先跑测试',
      '      - #123 已修复',
    ].join('\n'))
    expect(parsed).toMatchObject({ type: 'cards', items: [{ bullets: ['**重要**：先跑测试', '#123 已修复'] }] })
  })

  it('repairs a value with a colon and a tab-indented block', () => {
    expect(parseDocBlock("type: note\ntitle: 落地\nbody: 说明\ncode: const s = create({ tab: 'x' })\n"))
      .toMatchObject({ code: "const s = create({ tab: 'x' })" })

    const tabbed = 'type: cards\nitems:\n\t- title: 制表符\n'
    expect(parseDocBlock(tabbed)).toMatchObject({ type: 'cards', items: [{ title: '制表符' }] })
  })

  it('closes an unclosed quote at the end of a line', () => {
    expect(parseDocBlock("type: note\ntitle: '没闭合\nbody: 说明\n")).toMatchObject({ title: '没闭合' })
  })

  it('leaves the content of a block scalar alone', () => {
    const source = 'type: note\ntitle: 命令\nbody: 说明\ncode: |\n  - `npm test`\n'
    expect(parseDocBlock(source)).toMatchObject({ code: '- `npm test`' })
  })
})

describe('card badges', () => {
  it('keeps the badge slot when a card has no icon', () => {
    const html = renderToStaticMarkup(DocBlockView({ source: 'type: cards\nitems:\n  - title: 没有图标\n' })!)
    expect(html).toContain('badgeDot')
  })

  it('keeps the badge slot when the icon name is not in the map', () => {
    const html = renderToStaticMarkup(DocBlockView({ source: 'type: cards\nitems:\n  - icon: no-such-icon\n    title: 表外图标\n' })!)
    expect(html).toContain('badgeDot')
  })
})

describe('JSON payloads', () => {
  it('reads a JSON cards payload inside the fence', () => {
    const source = '{"type":"cards","items":[{"icon":"text","title":"字重对比","bullets":["标题 700"]}]}'
    expect(parseDocBlock(source)).toEqual({
      type: 'cards',
      items: [{ icon: 'text', title: '字重对比', body: undefined, bullets: ['标题 700'] }],
    })
  })

  it('reads a JSON payload with inline code kept as text', () => {
    const source = '{"type":"checks","items":[{"status":"pass","label":"构建","detail":"`npm run build` 通过"}]}'
    expect(parseDocBlock(source)).toMatchObject({
      type: 'checks',
      items: [{ status: 'pass', label: '构建', detail: '`npm run build` 通过' }],
    })
  })

  it('falls back to YAML when the payload is not JSON', () => {
    expect(parseDocBlock('type: note\ntitle: 提示\nbody: 正文\n')).toMatchObject({ type: 'note', title: '提示' })
  })

  it('every JSON example in the structured-output suffix parses', () => {
    const blocks = [...DOC_STYLE_JSON_SUFFIX.matchAll(/```doc\n([\s\S]*?)```/gu)].map(match => match[1])
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    for (const block of blocks) expect(parseDocBlock(block)).toBeDefined()
  })

  it('rescues a payload the model closed one brace too many', () => {
    // 真实模型实测：结尾多写一个 `}`，整块直接退回原文兜底。
    const source = '{"type":"note","icon":"check","title":"推荐","body":"选 DB 扫描","label":"选型"}}'
    expect(parseDocBlock(source)).toMatchObject({ type: 'note', title: '推荐', body: '选 DB 扫描' })
  })

  it('rescues a payload with a trailing comma', () => {
    const source = '{"type":"cards","items":[{"icon":"text","title":"字重对比",}],}'
    expect(parseDocBlock(source)).toMatchObject({ type: 'cards', items: [{ title: '字重对比' }] })
  })

  it('does not rescue a truncated payload or a second object', () => {
    // 截断的载荷留给流式渐进路径；两个对象说明围栏里根本不是一个载荷。
    expect(parseDocBlock('{"type":"cards","items":[{"icon":"text"')).toBeUndefined()
    expect(parseDocBlock('{"type":"note","title":"甲"}{"type":"note","title":"乙"}')).toBeUndefined()
  })
})
