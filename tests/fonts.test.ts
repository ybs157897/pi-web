import { describe, expect, it } from 'vitest'
import { normalizeFontFamily } from '../src/shared/fonts.ts'

/**
 * 字体族列表归一化（normalizeFontFamily）测试。
 *
 * 关键契约：
 * - 已安装字体名加引号，通用族（system-ui、sans-serif、ui-monospace 等）与 -apple-system/
 *   BlinkMacSystemFont 前缀保持不引号；
 * - 剥掉用户输入中的引号/反斜杠/尖括号/控制字符，防止 CSS 注入；
 * - 折叠空白、跳过空项；归一化幂等，重复处理结果不变。
 */
describe('normalizeFontFamily', () => {
  // 普通字体名加双引号；通用族 system-ui 保持裸写；-apple-system/BlinkMacSystemFont 前缀不加引号。
  it('quotes installed family names and keeps generic families unquoted', () => {
    expect(normalizeFontFamily('Inter, system-ui, SF Pro Text'))
      .toBe('"Inter", system-ui, "SF Pro Text"')
    expect(normalizeFontFamily('-apple-system, BlinkMacSystemFont, sans-serif'))
      .toBe('-apple-system, BlinkMacSystemFont, sans-serif')
  })

  // 输入中的引号、反斜杠、尖括号（如 <script>）被剥掉后再加引号输出，杜绝 CSS/HTML 注入。
  it('drops quotes, backslashes, angle brackets and control characters', () => {
    expect(normalizeFontFamily('"JetBrains Mono", <script>, back\\slash'))
      .toBe('"JetBrains Mono", "script", "backslash"')
  })

  // 多余空白折叠为单空格；空项（连续逗号）跳过；只剩空白或空串时返回空串。
  it('collapses whitespace and skips empty entries', () => {
    expect(normalizeFontFamily('  Fira   Code  ,, ,  ')).toBe('"Fira Code"')
    expect(normalizeFontFamily('   ')).toBe('')
    expect(normalizeFontFamily('')).toBe('')
  })

  // 幂等性：对归一化结果再次归一化，输出与第一次完全相同。
  it('is idempotent', () => {
    const once = normalizeFontFamily('Inter, ui-monospace, "Microsoft YaHei UI"')
    expect(normalizeFontFamily(once)).toBe(once)
  })
})
