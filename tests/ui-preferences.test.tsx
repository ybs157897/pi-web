// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider } from '../src/web/ui-preferences.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** UiPreferencesProvider 把用户字体配置发布到 document root CSS 变量的契约测试（jsdom 环境）。 */
const FAMILY_VARIABLES = ['--dsh-font-family-text', '--dsh-font-family-code', '--dsh-font-family-terminal']

beforeEach(() => { setupRenderingDom() })
afterEach(() => {
  cleanup()
  // 手动清掉 provider 写入的 CSS 变量，避免跨用例泄漏到 document root。
  for (const name of FAMILY_VARIABLES) document.documentElement.style.removeProperty(name)
})

describe('UiPreferencesProvider font lists', () => {
  it('publishes user font lists on the document root', () => {
    render(<UiPreferencesProvider value={{
      ...DEFAULT_UI_SETTINGS,
      textFontFamily: '"Inter"',
      codeFontFamily: '"JetBrains Mono"',
      terminalFontFamily: '"Cascadia Mono"',
    }}><div /></UiPreferencesProvider>)
    expect(document.documentElement.style.getPropertyValue('--dsh-font-family-text')).toBe('"Inter"')
    expect(document.documentElement.style.getPropertyValue('--dsh-font-family-code')).toBe('"JetBrains Mono"')
    expect(document.documentElement.style.getPropertyValue('--dsh-font-family-terminal')).toBe('"Cascadia Mono"')
  })

  // 边界：用户清空自定义字体（回到内置字体栈）时，变量应被移除而非写成空值，
  // 保证 CSS 回退到 :root 默认定义。
  it('removes the property when a list is cleared back to the built-in stack', () => {
    const { rerender } = render(<UiPreferencesProvider value={{ ...DEFAULT_UI_SETTINGS, textFontFamily: '"Inter"' }}><div /></UiPreferencesProvider>)
    expect(document.documentElement.style.getPropertyValue('--dsh-font-family-text')).toBe('"Inter"')
    rerender(<UiPreferencesProvider value={{ ...DEFAULT_UI_SETTINGS }}><div /></UiPreferencesProvider>)
    expect(document.documentElement.style.getPropertyValue('--dsh-font-family-text')).toBe('')
  })
})
