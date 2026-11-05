// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider } from '../src/web/ui-preferences.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

const FAMILY_VARIABLES = ['--dsh-font-family-text', '--dsh-font-family-code', '--dsh-font-family-terminal']

beforeEach(() => { setupRenderingDom() })
afterEach(() => {
  cleanup()
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

  it('removes the property when a list is cleared back to the built-in stack', () => {
    const { rerender } = render(<UiPreferencesProvider value={{ ...DEFAULT_UI_SETTINGS, textFontFamily: '"Inter"' }}><div /></UiPreferencesProvider>)
    expect(document.documentElement.style.getPropertyValue('--dsh-font-family-text')).toBe('"Inter"')
    rerender(<UiPreferencesProvider value={{ ...DEFAULT_UI_SETTINGS }}><div /></UiPreferencesProvider>)
    expect(document.documentElement.style.getPropertyValue('--dsh-font-family-text')).toBe('')
  })
})
