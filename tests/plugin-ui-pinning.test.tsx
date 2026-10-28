// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ChatMessage, ContentBlock } from '../src/shared/types.ts'
import Transcript from '../src/web/transcript.tsx'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const callName = 'mcp__plugin_excalidraw_canvas__create_view'
const details = {
  ui: {
    pluginId: 'excalidraw@market',
    serverName: 'plugin_excalidraw_canvas',
    resourceUri: 'ui://canvas',
    title: 'Excalidraw',
  },
}

function conversation(): ChatMessage[] {
  const call: ContentBlock = { type: 'toolCall', id: 'call-1', name: callName, arguments: {} }
  const bash: ContentBlock = { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'ls' } }
  return [
    { id: 'user-1', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: '画一张图' }] },
    { id: 'assistant-call', role: 'assistant', runId: 'run-1', timestamp: 2, status: 'completed', blocks: [bash, call] },
    {
      id: 'bash-result', role: 'tool', runId: 'run-1', toolCallId: 'bash-1', toolName: 'bash',
      timestamp: 3, status: 'completed', blocks: [{ type: 'text', text: 'a.ts' }], details: { command: 'ls', exitCode: 0 },
    },
    {
      id: 'tool-result', role: 'tool', runId: 'run-1', toolCallId: 'call-1', toolName: callName,
      timestamp: 4, status: 'completed', blocks: [{ type: 'text', text: '画布已生成' }], details,
    },
    {
      id: 'assistant-answer', role: 'assistant', runId: 'run-1', timestamp: 5, status: 'completed', durationMs: 9_000,
      blocks: [{ type: 'text', text: '这里是正文总结，可能会淹没页面。' }],
    },
  ]
}

describe('plugin UI pinning', () => {
  it('keeps an inline page visible when the completed work group is folded', () => {
    render(<Transcript messages={conversation()} conversationId="conv-plugin" policy={presentationPolicyFor('standard')} />)

    // The work group folds on completion, but the page lives outside that collapsed body.
    expect(screen.getByText('已工作 9 秒').closest('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-pinned-plugin-ui]')).not.toBeNull()
    expect(document.querySelector('[data-plugin-ui-card]')).not.toBeNull()
    expect(screen.getByText('Excalidraw')).toBeTruthy()
    const card = document.querySelector('[data-plugin-ui-card]') as HTMLElement
    const answer = screen.getByText('这里是正文总结，可能会淹没页面。')
    expect(card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves the page unpinned only while its tool result is still running', () => {
    const messages = conversation()
    messages[3] = { ...messages[3]!, streaming: true, status: 'running' }
    render(<Transcript messages={messages} conversationId="conv-plugin" running policy={presentationPolicyFor('standard')} />)
    expect(document.querySelector('[data-pinned-plugin-ui]')).toBeNull()
  })
})
