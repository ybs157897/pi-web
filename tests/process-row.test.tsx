import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProcessRow } from '../src/web/ProcessRow.tsx'

describe('process row interaction contract', () => {
  it('announces expansion state and keeps an independent action outside the toggle', () => {
    const html = renderToStaticMarkup(<ProcessRow icon="T" title="终端" open={false} expandable onToggle={() => {}}
      summary={<span>printf example</span>} accessory={<button type="button">查看计划</button>}>output</ProcessRow>)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('printf example')
    expect(html).not.toContain('output')
    expect(html).toMatch(/<\/button><button type="button">查看计划<\/button>/u)
  })
  it('shows details when expanded and removes the collapsed summary', () => {
    const html = renderToStaticMarkup(<ProcessRow icon="T" title="终端" open expandable onToggle={() => {}}
      summary="summary">terminal output</ProcessRow>)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('terminal output')
    expect(html).not.toContain('summary')
  })
})
