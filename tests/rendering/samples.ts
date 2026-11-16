/**
 * 渲染对照 fixture 的样本数据：覆盖正文排版、代码/图表、表格、媒体与安全样例，
 * 以及"思考与工具"流式场景的消息构造器。
 */
import type { ChatMessage } from '../../src/shared/types.ts'
/** 正文样本：中英混排、列表、引用、表格、代码块与公式，末尾带 RENDER-COMPLETE 结束标记。 */
export const prose = `# 正文渲染对照

这是中文正文：当 **重点文字紧挨中文**，以及英文、数字 123 和 \`inline_code\` 混排时，观察字距与换行。第二句提供足够长度，检查行宽和段落间距。

## 列表与引用

- 第一项：普通文字和 **强调内容**。
- 第二项：包含 \`npm run build\` 和 [示例链接](https://example.com)。
  - 嵌套项目：状态已完成。

> 这里是一段引用，包含中文标点、英文 words 和行内 \`code\`。

## 对照表

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 标题 | 完成 | 测试层级与间距 |
| 流式 | 进行中 | 保持布局稳定 |
| 表格 | 待确认 | 包含较长的一段中文内容，用于观察换行和横向滚动 |

## 代码与公式

\`\`\`python
def greet(name: str) -> str:
    return f"你好，{name}!"

print(greet("World"))
\`\`\`

行内公式 $E = mc^2$；块级公式：

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

最后一段：验证中文**加粗**与普通文本、\`inline code\` 以及链接在同一行的基线。结束标记：RENDER-COMPLETE。`
/** 代码样本：长行（换行/滚动）、mermaid 图、未知语言与非法 mermaid 语法。 */
export const code = `## 代码与图表

\`\`\`typescript
const greeting: string = "这是一条较长的代码行，用于验证默认水平滚动，点击换行后保持文字、主题和复制内容不变。abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
console.log(greeting);
\`\`\`

\`\`\`mermaid
flowchart LR
  A[开始] --> B[渲染正文]
  B --> C[完成]
\`\`\`

\`\`\`unknown_language
unknown syntax <safe> & preserved
\`\`\`

\`\`\`mermaid
not-a-diagram ???
\`\`\``
/** 表格样本：小表、需要横向滚动的宽表（含特殊字符单元格）、三种列对齐。 */
export const table = `## 小表

| A | B |
| --- | --- |
| 1 | 2 |

## 宽表

| 标题一长列 | 标题二长列 | 标题三长列 | 标题四长列 | 标题五长列 | 标题六长列 | 标题七长列 | 标题八长列 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 中文测试内容很长 | 一二三四五六七八 | 测试单元格很宽 | 横向滚动测试 | 文本不会被裁切 | 宽表数据内容 | 第七列测试内容 | 第八列测试内容 |
| =1+2 | +SUM(A1) | -3 | @user | a,b | a"b | 换行测试 | 结束 |

## 对齐

| 左侧 | 中间 | 右侧 |
| :--- | :---: | ---: |
| one | two | three |`
/** 媒体与安全样本：文件链接（含 Windows 路径）、图片（含链接图片/缺失图片）、XSS 探测、编号列表与波浪线。 */
export const media = `## 文件和图片

[查看 README](README.md#L2) 与 \`src/example.ts\`，以及 [Windows 文件](C:\\work\\.config\\test.ts#L3)。

![测试图片](/fixture-image.svg)

![第二张图片](/fixture-image-two.svg)

[![带链接的图片](/fixture-image.svg)](https://example.com)

![不存在的图片](/missing-image.png)

## 安全与数学

<script>window.fixtureInjected = true</script>

[不可执行](javascript:alert(1)) 和 $E=mc^2$。

## 编号和长段落

100. 第一个编号应完整显示。
101. 第二个编号应完整显示。

中文**强调**紧挨标点，~单波浪线~保持原样。`
/** 思考样本文本：24 行逐步推理，流式阶段按比例截断展示。 */
export const thought = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行：确认用户意图，检查现有工具结果，再给出准确的总结。`).join('\n')
/** 终端样本命令：两行输出。 */
export const command = 'printf "ZCODE_RENDER_TEST\\n第2行输出\\n"'
/** 多行命令样本：8 段 printf 拼接，覆盖命令换行显示。 */
export const longCommand = Array.from({ length: 8 }, (_, i) => `printf "命令第${i + 1}行\\n"`).join('\n')
/**
 * 构造简单问答会话：一句用户提问 + 一条 assistant 回答。
 * @param text 回答正文（Markdown 样本）
 * @param streaming 是否处于流式运行状态
 * @returns 两消息的 ChatMessage 数组
 */
export function answerMessages(text: string, streaming = false): ChatMessage[] {
  return [
    { id: 'u', role: 'user', requestId: 'req', timestamp: 1000, blocks: [{ type: 'text', text: '请展示同一组对照内容。' }] },
    { id: 'answer', role: 'assistant', runId: 'run', timestamp: 2000, status: streaming ? 'running' : 'completed', streaming, durationMs: 7000, blocks: [{ type: 'text', text }] },
  ]
}
/**
 * 构造"思考与工具"多阶段会话：stage 0 思考流式 → stage 1 终端输出流式 →
 * stage 2 回答流式 → stage 3 全部完成（含 read/edit/失败 bash/停止 bash 各状态的结果）。
 * @param stage 当前阶段（0-3），默认 3（完整完成态）
 * @param amount 阶段内流式进度（0-1），决定思考行数/输出行数/回答长度
 * @returns ChatMessage 数组
 */
export function processMessages(stage = 3, amount = 1): ChatMessage[] {
  const messages: ChatMessage[] = [{ id: 'u-work', role: 'user', requestId: 'req-work', timestamp: 1000, blocks: [{ type: 'text', text: '运行只读终端检查，然后查看并说明文件差异。' }] }]
  messages.push({ id: 'assistant-work', role: 'assistant', runId: 'work', timestamp: 1500, status: stage === 0 ? 'running' : 'completed', streaming: stage === 0, blocks: [
    { type: 'thinking', text: stage === 0 ? thought.slice(0, Math.max(1, Math.floor(thought.length * amount))) : thought },
    ...(stage === 0 ? [] : [{ type: 'toolCall' as const, id: 'bash-1', name: 'bash', arguments: { command: longCommand } }]),
  ] })
  if (stage === 0) return messages
  messages.push({ id: 'bash-output', role: 'tool', runId: 'work', toolCallId: 'bash-1', toolName: 'bash', timestamp: 3000, status: stage === 1 ? 'running' : 'completed', streaming: stage === 1, blocks: [{ type: 'text', text: Array.from({ length: stage === 1 ? Math.max(1, Math.floor(30 * amount)) : 30 }, (_, i) => `输出第 ${i + 1} 行：没有修改文件。`).join('\n') }], details: { command: longCommand, exitCode: 0 } })
  if (stage === 1) return messages
  messages.push({ id: 'file-calls', role: 'assistant', runId: 'work', timestamp: 4000, status: 'completed', blocks: [
    { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/example.ts' } },
    { type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'src/example.ts', oldText: 'const count = 1\n', newText: 'const count = 2\n' } },
    { type: 'toolCall', id: 'bash-error', name: 'bash', arguments: { command: 'printf "expected failure\\n"; exit 7' } },
    { type: 'toolCall', id: 'bash-stop', name: 'bash', arguments: { command: 'sleep 30' } },
  ] })
  messages.push({ id: 'read-result', role: 'tool', runId: 'work', toolName: 'read', toolCallId: 'read-1', timestamp: 4100, blocks: [{ type: 'text', text: 'const count = 1\n' }], details: { path: 'src/example.ts', lines: [{ number: 1, text: 'const count = 1' }], totalLines: 1 } })
  messages.push({ id: 'edit-result', role: 'tool', runId: 'work', toolName: 'edit', toolCallId: 'edit-1', timestamp: 4200, blocks: [{ type: 'text', text: 'updated' }], artifacts: [{ kind: 'edit', path: 'src/example.ts', before: 'const count = 1\n', after: 'const count = 2\n' }] })
  messages.push({ id: 'error-result', role: 'tool', runId: 'work', toolName: 'bash', toolCallId: 'bash-error', timestamp: 4300, isError: true, status: 'error', details: { command: 'printf "expected failure\\n"; exit 7', exitCode: 7 }, blocks: [{ type: 'text', text: 'expected failure\n' }] })
  messages.push({ id: 'stop-result', role: 'tool', runId: 'work', toolName: 'bash', toolCallId: 'bash-stop', timestamp: 4400, status: 'cancelled', blocks: [{ type: 'text', text: '命令已停止' }] })
  messages.push({ id: 'work-answer', role: 'assistant', runId: 'work', timestamp: 5000, status: stage === 2 ? 'running' : 'completed', streaming: stage === 2, durationMs: 11000, blocks: [{ type: 'text', text: stage === 2 ? prose.slice(0, Math.max(1, Math.floor(prose.length * amount))) : '命令输出与文件差异已显示。成功、失败和停止状态来自各自的工具记录。' }] })
  return messages
}
