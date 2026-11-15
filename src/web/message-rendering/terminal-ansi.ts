// 改编自 DeepSeek Harness ui-primitives/ansi.ts (687f282e86)。
// Copyright (c) 2026 DeepSeek. MIT; 许可见 third-party/dsh-terminal-parser-LICENSE.txt。
// 在解析 SGR 着色 run 之前，先剥掉 anser 不会消费的控制序列，
// 避免它们以字面字符的形式漏进 DOM。

import Anser from 'anser'
import type { CSSProperties } from 'react'

/**
 * 本模块用到的 anser JSON chunk 字段子集。anser 自己的类型把 `fg`/`bg`
 * 声明为 `string`，但它的解析器对未设颜色的 run 留的是 `null`，所以这里如实写成 null。
 */
interface AnsiChunk {
  /** run 的文本，SGR 码已被移除。 */
  content: string
  /** 前景色，`r, g, b` 三元组字符串；run 未设前景色时为 null。 */
  fg: string | null
  /** 背景色，`r, g, b` 三元组字符串；run 未设背景色时为 null。 */
  bg: string | null
  /** 该 run 生效中的 SGR 属性，按声明顺序排列。 */
  decorations: readonly string[]
}

/** 一段终端文本 run；不带任何 SGR 状态的文本 `style` 为 undefined。 */
export interface AnsiSpan {
  /** run 的纯文本，不含转义序列与换行。 */
  text: string
  /** 解析出的内联样式；run 无需包装时为 undefined。 */
  style: CSSProperties | undefined
}

/** 一行输出的全部 span，按序排列。 */
export type AnsiLine = readonly AnsiSpan[]

/**
 * ANSI 8/16 基本色映射表：键是 anser 为这些颜色输出的无空白 `r,g,b` 三元组，
 * 值是语义对应的 DSW 主题 token。黑与白都落到主标签色，保证两种主题下文字都清晰
 * 而不是隐进底色；亮黑取三级标签色（弱化灰的角色）。青色与亮青取两个静态蓝：
 * 设计系统没有青色，且 anser 的字面亮青在浅色代码底上不可读。品红没有对应 token，
 * 连同 256 色板与 truecolor 的所有取值一起，回退到 anser 的字面 rgb。
 */
const TOKEN_BY_BASIC_RGB: Record<string, string> = {
  '0,0,0': 'var(--dsw-alias-label-primary)',
  '255,255,255': 'var(--dsw-alias-label-primary)',
  '85,85,85': 'var(--dsw-alias-label-tertiary)',
  '187,0,0': 'var(--dsw-alias-state-error-primary)',
  '255,85,85': 'var(--dsw-alias-state-error-secondary)',
  '0,187,0': 'var(--dsw-alias-state-success-primary)',
  '0,255,0': 'var(--dsw-alias-state-success-secondary)',
  '187,187,0': 'var(--dsw-alias-state-warn-primary)',
  '255,255,85': 'var(--dsw-alias-state-warn-secondary)',
  '0,0,187': 'var(--dsw-alias-state-business-primary)',
  '85,85,255': 'var(--dsw-static-blue-400)',
  '0,187,187': 'var(--dsw-static-blue-600)',
  '85,255,255': 'var(--dsw-static-blue-500)',
}

/**
 * 每个 SGR 属性对应的 CSS。刻意不放 `blink`——闪烁文字不还原。
 * `reverse` 永远不会到达这里：anser 会消费它，交换 run 的前景/背景色。
 * 下划线与删除线共用 `textDecoration`，同一 run 同时声明两者时后声明者生效。
 */
const STYLE_BY_DECORATION: Record<string, CSSProperties | undefined> = {
  bold: { fontWeight: 700 },
  dim: { opacity: 0.7 },
  italic: { fontStyle: 'italic' },
  underline: { textDecoration: 'underline' },
  strikethrough: { textDecoration: 'line-through' },
  hidden: { visibility: 'hidden' },
}

/** OSC 序列（窗口标题、超链接等），带或不带终止符都匹配。 */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g

/** CSI 以外的转义序列：字符集切换、单移、重置等。 */
const NON_CSI_ESCAPE = /\u001b(?!\[)[\u0020-\u002f]*[\u0030-\u007e]?/g

/**
 * 无显示含义的 C0 控制字符。Tab、换行、退格与 ESC 保留：前两个管排版，
 * 退格参与光标重放，ESC 是 anser 切分 CSI 的依据。
 */
const INERT_CONTROL = /[\u0000-\u0007\u000b-\u001a\u001c-\u001f\u007f]/g

/**
 * 需要重放光标移动的行：含回车、退格或行内擦除。擦除分支的正则与 `replayLine`
 * 解析的 CSI 形状完全一致（参数可带 `;` 与中间字节），保证 `\x1b[1;2K`
 * 这类形式不会绕过这个守卫漏掉自己的擦除。
 */
const NEEDS_REPLAY = /\r|\u0008|\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*K/

/** 仅 SGR 序列，用于在无需重放的行上继续折叠状态。 */
const SGR_SEQUENCE = /\u001b\[([\u0030-\u003f]*)[\u0020-\u002f]*m/g

/** 终端制表位宽度；Tab 前进到下一处 8 的倍数列。 */
const TAB_WIDTH = 8

/**
 * 组合记号及其他零宽码点：终端不为它们推进列，`e` + U+0301 占一格，
 * 覆盖该格的整列重绘会连着两个码点一起覆盖。
 */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\u200b-\u200f\u2060]$/u

/**
 * 终端按两列宽推进的字符：CJK 各文字、全角形式、CJK 标点，以及带 emoji 呈现的字符。
 * 文本呈现的符号（`\u2713`、`\u26a0` 等 U+2600-U+27BF 一段）只占一列，
 * 必须排除在本集合之外。
 */
const WIDE_CHAR = new RegExp(
  '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}'
  // 仅限 emoji 呈现：U+2600-U+27BF 符号段大多是单列——`\u2713`（进度行必写的
  // 对勾，本用例也在内）只推进一列，已对照真实终端验证；若整段按宽字符处理，
  // 恰好会错位这张卡片要保真展示的输出。
  + '|\\p{Emoji_Presentation}'
  + '|[\\uff01-\\uff60\\u3000-\\u303e]',
  'u',
)

/**
 * 判断字符是否占两个终端列（CJK、全角形式、emoji）。
 * 覆盖命令输出实际会出现的区间；更保守的判断会让这张卡片要保真的列对不齐。
 * @param char 输出中的一个字符
 * @returns 终端按两列推进时返回 true
 */
function isWide(char: string): boolean {
  const code = char.codePointAt(0)
  if (code === undefined || code < 0x1100) return false
  return WIDE_CHAR.test(char)
}

/**
 * 单元格图形状态的规范化表示。用字段而不是原始序列历史来保存：终端追踪的是
 * 「当前状态」，不是流水账——累积序列曾让每个状态边界都重发整条链，不带完整
 * reset 的换色输出因此呈 O(n^2) 字符增长（3200 个这样的格子产出 25 MB 并最终
 * 抛 `RangeError`）。字段化也让 chalk 系工具都会写的属性关闭码——`39`、`49`、
 * `22`、`23`、`24`、`27`、`29`——真正关闭对应属性而不是追加。
 */
interface SgrState {
  fg: string
  bg: string
  /** 生效中的属性参数，如 `1`（粗体）或 `4`（下划线）。 */
  attrs: readonly string[]
}

/** 默认状态：无颜色、无属性。 */
const SGR_NONE: SgrState = { fg: '', bg: '', attrs: [] }

/** 属性关闭码 → 各自关闭的开启参数。 */
const ATTR_CLOSERS: Record<string, readonly string[]> = {
  22: ['1', '2'], 23: ['3'], 24: ['4'], 25: ['5', '6'], 27: ['7'], 28: ['8'], 29: ['9'],
}

/**
 * 把一条 SGR 序列的参数折叠进它产生的状态。
 * @param state 序列生效前的状态
 * @param params 序列的原始参数串（如 `31`、`1;4`、`38;5;208`）
 * @returns 序列执行后的生效状态
 */
function foldSgr(state: SgrState, params: string): SgrState {
  const codes = params === '' ? ['0'] : params.split(';')
  let next = state
  for (let index = 0; index < codes.length; index++) {
    const code = String(codes[index])
    if (code === '' || code === '0') { next = SGR_NONE; continue }
    // 扩展色：`38;5;N` / `38;2;R;G;B` 与对应的 `48` 背景版会消费自己的参数，
    // 因此整段取走。
    if (code === '38' || code === '48') {
      const kind = codes[index + 1] ?? ''
      const span = kind === '2' ? 4 : kind === '5' ? 2 : 0
      const value = codes.slice(index, index + span + 1).join(';')
      next = code === '38' ? { ...next, fg: value } : { ...next, bg: value }
      index += span
      continue
    }
    const closes = ATTR_CLOSERS[code]
    if (closes !== undefined) {
      next = { ...next, attrs: next.attrs.filter(attr => !closes.includes(attr)) }
      continue
    }
    const numeric = Number(code)
    if (code === '39') { next = { ...next, fg: '' }; continue }
    if (code === '49') { next = { ...next, bg: '' }; continue }
    if ((numeric >= 30 && numeric <= 37) || (numeric >= 90 && numeric <= 97)) { next = { ...next, fg: code }; continue }
    if ((numeric >= 40 && numeric <= 47) || (numeric >= 100 && numeric <= 107)) { next = { ...next, bg: code }; continue }
    if (!next.attrs.includes(code)) next = { ...next, attrs: [...next.attrs, code] }
  }
  return next
}

/**
 * 把状态渲染成「从默认态出发建立它」的那条唯一规范序列——无论状态经由什么
 * 路径到达，边界最多发出一段有限长度的字符串。
 * @param state 要开启的状态
 * @returns SGR 序列；默认状态返回空串
 */
function openSgr(state: SgrState): string {
  const codes = [...state.attrs]
  if (state.fg !== '') codes.push(state.fg)
  if (state.bg !== '') codes.push(state.bg)
  return codes.length === 0 ? '' : `\u001b[${codes.join(';')}m`
}

/** 判断两个状态是否相同，相同则边界不发出序列。 */
function sameSgr(a: SgrState, b: SgrState): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.attrs.length === b.attrs.length
    && a.attrs.every((attr, index) => attr === b.attrs[index])
}

/**
 * 把一行的光标移动按终端绘制方式重放进一个「列缓冲」。回车与退格只移动光标——
 * 什么都不擦除——所以读者看到的是每一列最后被写入的内容。用缓冲而非字符串手术
 * 正是为了保住这个区别：`100%\rOK` 显示为 `OK0%`（重绘比底下的帧短），行尾的
 * `abc\b` 仍显示 `abc`（`c` 从未被覆盖）。
 *
 * CSI 序列不占列；它改变的是后续写入打上的状态戳——终端正是这样按格存色的。
 * 因此 `red bad` 加三次退格再加 `ok` 显示为红色的 `okd`：`ok` 覆盖了前两格，
 * 第三格保留写入时的状态。列按 run 重新发出，anser 看到的样式与终端一致。
 * @param line 一行输出，仍携带 CSI 序列
 * @param entrySgr 行首生效的 SGR 状态（换行不重置它）
 * @returns 终端重放完所有移动后的行文本，以及行尾 SGR 状态（供下一行进场用）
 */
function replayLine(line: string, entrySgr: SgrState): { text: string; sgr: SgrState } {
  // 与 anser 切分用的形状一致，保证一个序列在这里也是一个完整单元。
  const csi = /\u001b\[([\u0030-\u003f]*)[\u0020-\u002f]*([\u0040-\u007e])/g
  /** 每列：写入时生效的状态与字符。 */
  const columns: (Cell | undefined)[] = []
  let cursor = 0
  // 状态追踪方式与终端完全一致：每格打上写入那一刻生效的状态戳，后续重绘
  // 无法改变它没覆盖到的格子。进场携带上一行的状态，因为换行不重置状态。
  let sgr = entrySgr
  let at = 0

  /** 清除一格；宽字符对则连同伙伴格一起清（终端会两个都擦）。 */
  const clear = (index: number, fill: string): void => {
    const cell = columns[index]
    if (cell?.spacer === true && index > 0) columns[index - 1] = { sgr, char: fill }
    else if (cell !== undefined && isWide(cell.char) && columns[index + 1]?.spacer === true) {
      columns[index + 1] = { sgr, char: fill }
    }
    columns[index] = { sgr, char: fill }
  }

  const consume = (chunk: string): void => {
    for (const char of chunk) {
      if (char === '\r') { cursor = 0; continue }
      if (char === '\u0008') { cursor = Math.max(0, cursor - 1); continue }
      if (char === '\t') {
        // Tab 前进到下一个 8 列制表位，跳过的格子保持原样——重绘才可能留下
        // 制表位上的旧内容。列对齐正是这张卡片存在的意义。
        const stop = cursor + TAB_WIDTH - (cursor % TAB_WIDTH)
        for (; cursor < stop; cursor++) columns[cursor] ??= { sgr, char: ' ' }
        continue
      }
      if (ZERO_WIDTH.test(char)) {
        // 不占自己的列：附着到已写好的格子上，覆盖那格的重绘会连记号一起覆盖。
        // 无格可附着时（行首、或刚重绘回列 0）终端什么都不显示，而不是出现孤立的重音。
        const base = cursor > 0 ? columns[cursor - 1] : undefined
        if (base !== undefined) columns[cursor - 1] = { sgr: base.sgr, char: base.char + char }
        continue
      }
      // 覆盖宽字符对的任一半都会清空另一半：终端不会让两格字形只剩一格。
      clear(cursor, ' ')
      columns[cursor] = { sgr, char }
      cursor++
      // 宽字符占两列；尾格是 spacer，标记它的意义是：重写主导格后留下一个空白，
      // 而不是把缺口合上、让后面所有内容左移一列。
      if (isWide(char)) { columns[cursor] = { sgr, char: '', spacer: true }; cursor++ }
    }
  }

  for (const match of line.matchAll(csi)) {
    consume(line.slice(at, match.index))
    at = match.index + match[0].length
    // Both groups are mandatory in the pattern, so destructuring types them as
    // strings without a fallback that could never run.
    const params = String(match[1])
    const final = String(match[2])
    if (final === 'K') {
      // 行内擦除：所有 spinner 与进度条里 `\r` 的固定搭档。没有它，更短的重绘
      // 会留下上一帧的尾巴——那是终端从未显示过的文字。`1` 把行首到光标列
      // （含，按 CSI 规范）置空而不是删除这些格子，因为光标不动，后续写入仍可
      // 落到它们之外。只有第一个参数选择模式，其余参数终端一律忽略（`1;2K`
      // 的擦除行为与 `1K` 完全相同）。
      const mode = String(params.split(';')[0])
      if (mode === '1') for (let index = 0; index <= cursor; index++) clear(index, ' ')
      else columns.length = mode === '2' ? 0 : cursor
      continue
    }
    // 只有 SGR 携带图形状态；其余 final byte 都是光标或擦除动作，不能影响格子样式。
    if (final !== 'm') continue
    sgr = foldSgr(sgr, params)
  }
  consume(line.slice(at))

  // 重发各列，仅在状态变化处开启新 run，让 anser 看到与终端一致的样式。
  // 每个边界只发出「开启该状态」的一条规范序列——这正是输出长度与格子数
  // 保持线性、与状态到达路径无关的原因。
  let out = ''
  let active = entrySgr
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index] ?? { sgr: SGR_NONE, char: ' ' }
    if (!sameSgr(column.sgr, active)) {
      if (!sameSgr(active, SGR_NONE)) out += '\u001b[0m'
      out += openSgr(column.sgr)
      active = column.sgr
    }
    // spacer 仍占着自己的列。主导格还在时宽字形跨两格，spacer 不发出内容；
    // 后续写入替换主导格后，终端会用空白填补 spacer 而不是合上缺口——此时
    // 若不发出空格，后面所有内容会整体左移一列。
    const leadIntact = index > 0 && isWide(columns[index - 1]?.char ?? '')
    out += column.spacer === true && !leadIntact ? ' ' : column.char
  }
  // 收敛到「扫描结束时」的状态，而不是最后被写格子上的状态：最后一次写入之后
  // 的序列（收尾着色行的 `\x1b[0m`）不改变任何格子，却结束了 run，它必须同时
  // 传递给 DOM 与下一行。否则以 reset 结尾的行会把颜色泄漏给后续行。
  if (!sameSgr(active, sgr)) {
    if (!sameSgr(active, SGR_NONE)) out += '\u001b[0m'
    out += openSgr(sgr)
  }
  return { text: out, sgr }
}

/** 重放后的一列：写入时生效的状态与其字符。 */
interface Cell {
  sgr: SgrState
  char: string
  /** 宽字符两列对的尾格。 */
  spacer?: boolean
}

/**
 * 重放每一行的光标移动。仅作为 CRLF 行结尾的 `\r` 先被剥掉，这些行保留原文
 * 而不是被重绘到自身上。SGR 状态跨行传递：换行不重置它，重绘前开启的 run
 * 依然会着色之后的行。
 * @param text 输出文本（已去除 OSC 与非 CSI 转义）
 * @returns 每行按终端绘制方式重放后的文本
 */
function applyCursorMovements(text: string): string {
  const replayed: string[] = []
  let sgr = SGR_NONE
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r+$/, '')
    if (NEEDS_REPLAY.test(line)) {
      const result = replayLine(line, sgr)
      replayed.push(result.text)
      sgr = result.sgr
      continue
    }
    // 无光标移动的行不需要列缓冲——为它建一个会让这张卡片从不重绘的输出
    // （`ls -R`、5k 行日志）每字符分配一格。只需折叠自身的 SGR，让后续真正
    // 要重放的行带着正确状态进场。
    replayed.push(line)
    for (const match of line.matchAll(SGR_SEQUENCE)) sgr = foldSgr(sgr, String(match[1]))
  }
  return replayed.join('\n')
}

/**
 * 清除所有不携带颜色的转义序列与控制字符，为 anser 保留 CSI，为排版保留
 * `\n`/`\t`。光标移动（回车、退格）先重放——它们对可见文本的效果必须先落定，
 * 之后才能丢弃表达它们的字符本身。
 * @param text 原始命令输出
 * @returns 仅剩 CSI 序列的文本
 */
function sanitize(text: string): string {
  const escaped = text.replace(OSC_SEQUENCE, '').replace(NON_CSI_ESCAPE, '')
  return applyCursorMovements(escaped).replace(INERT_CONTROL, '')
}

/**
 * 解析一个 run 的颜色与装饰属性。
 * @param chunk 待着色的 anser chunk
 * @returns 该 run 的内联样式；不带任何 SGR 状态时返回 undefined
 */
function resolveStyle(chunk: AnsiChunk): CSSProperties | undefined {
  const style: CSSProperties = {}
  const background = chunk.bg === null ? undefined : `rgb(${chunk.bg})`
  if (background !== undefined) style.backgroundColor = background
  if (chunk.fg !== null) {
    const literal = `rgb(${chunk.fg})`
    // 自带背景色的 run 保留 anser 的字面前景/背景配对，作者设定的对比度不被破坏；
    // 只有前景色的 run 映射到主题 token，随明暗两套底色自适应。
    style.color = background === undefined
      ? TOKEN_BY_BASIC_RGB[chunk.fg.replace(/\s+/g, '')] ?? literal
      : literal
  }
  for (const decoration of chunk.decorations) Object.assign(style, STYLE_BY_DECORATION[decoration])
  return Object.keys(style).length === 0 ? undefined : style
}

/**
 * 功能：把命令输出解析成按行分组的带样式 span 列表（终端卡片渲染的数据源）。
 * @param text 原始输出文本，可含 ANSI 转义序列
 * @returns 每行一个条目（至少一行，行可为空）
 * 内部逻辑：先 sanitize（剥 OSC/杂控制字符、重放光标移动），再交给 anser 切出 SGR run；chunk 内的 `\n` 切开新行；颜色经 resolveStyle 映射到主题 token 或字面 rgb。
 */
export function parseAnsiLines(text: string): AnsiLine[] {
  let current: AnsiSpan[] = []
  const lines: AnsiSpan[][] = [current]
  for (const chunk of Anser.ansiToJson(sanitize(text), { json: true, remove_empty: true })) {
    const style = resolveStyle(chunk)
    for (const [index, part] of chunk.content.split('\n').entries()) {
      if (index > 0) {
        current = []
        lines.push(current)
      }
      if (part !== '') current.push({ text: part, style })
    }
  }
  return lines
}
