// @vitest-environment jsdom
/**
 * 插件 UI 页面在会话记录（Transcript）中的固定（pinning）行为测试。
 *
 * 关键契约：插件 MCP 工具调用完成后，工作组折叠但其插件 UI 页面
 * （data-pinned-plugin-ui）保持可见、不被折叠进 collapsed body；
 * 仅当该工具结果仍在运行（streaming）时页面不固定，留在工作组内部正常展示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ChatMessage, ContentBlock } from '../src/shared/types.ts'
import Transcript from '../src/web/transcript.tsx'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/** 每个用例前补齐 jsdom 缺失的浏览器 API；结束后卸载组件并清理 stub。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 插件 MCP 工具调用的名称（excalidraw 画布的 create_view）。 */
const callName = 'mcp__plugin_excalidraw_canvas__create_view'
/** 工具结果 details 中的 ui 元数据，标识插件、服务器与页面标题。 */
const details = {
  ui: {
    pluginId: 'excalidraw@market',
    serverName: 'plugin_excalidraw_canvas',
    resourceUri: 'ui://canvas',
    title: 'Excalidraw',
  },
}

/**
 * 构造一段完整会话：用户提问 → assistant 调用 bash + 插件 MCP 工具 →
 * 两个工具结果（bash 与插件画布）→ assistant 9 秒正文总结。
 * @returns 五条消息的 ChatMessage 数组
 */
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

/** 插件 UI 页面的固定/取消固定时机测试。 */
describe('plugin UI pinning', () => {
  // 验证完成后工作组折叠（aria-expanded=false），但插件 UI 卡片仍固定在折叠体之外可见，
  // 且卡片渲染位置在 assistant 正文总结之前（正文不会把页面挤走）。
  it('keeps an inline page visible when the completed work group is folded', () => {
    render(<Transcript messages={conversation()} conversationId="conv-plugin" policy={presentationPolicyFor('standard')} />)

    // 工作组在完成时折叠，但插件页面位于折叠体之外。标题拆成「已工作」+「9 秒」两段。
    expect(screen.getByText(/^已工作/).closest('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-pinned-plugin-ui]')).not.toBeNull()
    expect(document.querySelector('[data-plugin-ui-card]')).not.toBeNull()
    expect(screen.getByText('Excalidraw')).toBeTruthy()
    const card = document.querySelector('[data-plugin-ui-card]') as HTMLElement
    const answer = screen.getByText('这里是正文总结，可能会淹没页面。')
    expect(card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // 验证运行中状态（工具结果 streaming、会话 running）下页面不固定（无 data-pinned-plugin-ui），
  // 固定只发生在工具结果完成后。
  it('leaves the page unpinned only while its tool result is still running', () => {
    const messages = conversation()
    messages[3] = { ...messages[3]!, streaming: true, status: 'running' }
    render(<Transcript messages={messages} conversationId="conv-plugin" running policy={presentationPolicyFor('standard')} />)
    expect(document.querySelector('[data-pinned-plugin-ui]')).toBeNull()
  })
})
