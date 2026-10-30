// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '../src/shared/types.ts'
import type { ToolItem } from '../src/web/render-model.ts'
import ToolCard from '../src/web/ToolCard.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** Chinese-only translator, mirroring the app's own locale switch. */
const t = (chinese: string): string => chinese

beforeEach(() => { setupRenderingDom() })
afterEach(() => { cleanup() })

function skillCall(name: string, args: Record<string, unknown>, output: string, details?: unknown): ToolItem {
  const message: ChatMessage = {
    id: `assistant:${name}`,
    role: 'assistant',
    blocks: [{ type: 'toolCall', id: `call:${name}`, name, arguments: args }],
    timestamp: 200,
  }
  return {
    key: `tool:call:${name}`,
    message,
    call: { type: 'toolCall', id: `call:${name}`, name, arguments: args },
    result: {
      id: `result:${name}`, role: 'tool', blocks: [{ type: 'text', text: output }], timestamp: 300,
      toolCallId: `call:${name}`, toolName: name, status: 'completed',
      ...(details === undefined ? {} : { details }),
    },
    children: [],
    order: 0,
  }
}

describe('skill tool rows', () => {
  it('names the skill instead of echoing the raw result line', () => {
    const item = skillCall('skill_load', { skill: 'global:rd-cli-ops' },
      'Loaded global:rd-cli-ops (b2ac64843d4d), resource SKILL.md.')
    render(<ToolCard item={item} runRunning={false} t={t} />)

    expect(screen.getByText('技能')).toBeTruthy()
    expect(document.querySelector('[class*="skillRowName"]')?.textContent).toBe('global:rd-cli-ops')
    // The result line is the tool's prose, not the row summary.
    expect(screen.queryByText(/Loaded global:rd-cli-ops/u)).toBeNull()
  })

  it('expands into the skill card with the resource and the loaded text, without the JSON dumps', () => {
    const item = skillCall('skill_load', { skill: 'global:rd-cli-ops', resource: 'SKILL.md' },
      'Loaded global:rd-cli-ops (b2ac64843d4d), resource SKILL.md.\n\n# RD CLI ops')
    render(<ToolCard item={item} runRunning={false} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))

    expect(document.querySelector('[data-skill-card]')).toBeTruthy()
    expect(screen.getByText('global:rd-cli-ops')).toBeTruthy()
    expect(screen.getByText('资源')).toBeTruthy()
    expect(screen.getByText('SKILL.md')).toBeTruthy()
    expect(screen.getByText(/RD CLI ops/u)).toBeTruthy()
    expect(screen.queryByText('调用参数')).toBeNull()
    expect(screen.queryByText('工具详情')).toBeNull()
  })

  it('shows the running label while the body is still loading', () => {
    const message: ChatMessage = {
      id: 'assistant:skill_load',
      role: 'assistant',
      blocks: [{ type: 'toolCall', id: 'call:skill_load', name: 'skill_load', arguments: { skill: 'demo' } }],
      timestamp: 200,
    }
    const item: ToolItem = {
      key: 'tool:call:skill_load', message,
      call: { type: 'toolCall', id: 'call:skill_load', name: 'skill_load', arguments: { skill: 'demo' } },
      children: [], order: 0,
    }
    render(<ToolCard item={item} runRunning t={t} />)

    expect(screen.getByText('正在运行技能')).toBeTruthy()
    expect(document.querySelector('[class*="skillRowName"]')?.textContent).toBe('demo')
  })

  it('names each split skill tool by its operation', () => {
    render(<ToolCard item={skillCall('skill_list', {}, 'Available Skills:\n- demo (workspace, read-only): Demo.')} runRunning={false} t={t} />)
    expect(screen.getByText('技能列表')).toBeTruthy()
    cleanup()
    render(<ToolCard item={skillCall('skill_validate', { name: 'demo' }, 'OK')} runRunning={false} t={t} />)
    expect(screen.getByText('校验技能')).toBeTruthy()
  })

  // A Skill result carries its resource paths under `details.files`; the generic parser used to
  // read that array as a path search, which made the row summary-only and swallowed the card.
  it('keeps the row expandable when the result lists resource paths', () => {
    const item = skillCall('skill_load', { skill: 'agents:demo-verifier' },
      'Loaded agents:demo-verifier (d0daa59ba10a), resource SKILL.md.',
      { skill: { id: 'agents:demo-verifier' }, baseDirectory: '/tmp/skills/demo-verifier', resource: 'SKILL.md', files: ['SKILL.md', 'references/notes.md'], filesTruncated: false })
    render(<ToolCard item={item} runRunning={false} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))
    expect(document.querySelector('[data-skill-card]')).toBeTruthy()
    // No path-search block leaks out of the skill details.
    expect(screen.queryByText('references/notes.md')).toBeNull()
  })
})
