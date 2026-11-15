/**
 * 渲染验收 fixture 生成器：以 demo 模式起 runtime，创建会话并提交一条携带图片、HTML/SVG/PDF
 * 预览文件的复合消息，驱动 demo 工具链实际执行（write/edit/read/shell、PNG 以 image 块返回、
 * 回答含表格/代码/公式/引用）。用于人工核对前端各渲染面（DSH 基准）的确定性素材。
 * 失败条件：demo fixture 未执行全部预期工具、PNG 未以 image 块渲染、回答缺预期 Markdown 内容、
 * 或 45 秒内未完成。CLI 参数：--data-dir / --workspace 指定目录（默认 artifacts 下的时间戳目录）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime/index.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
const defaultRoot = resolve('artifacts', `render-fixture-${timestamp}`)
// 数据目录与工作区可用 CLI 参数指定；未指定时落在 artifacts/render-fixture-<时间戳>/ 下。
const dataDir = resolve(option('--data-dir') ?? join(defaultRoot, 'data'))
const workspace = resolve(option('--workspace') ?? join(defaultRoot, 'workspace'))
const previewFiles = createPreviewFiles()

await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(workspace, { recursive: true }),
])
await Promise.all(Object.entries(previewFiles).map(([name, content]) => writeFile(join(workspace, name), content)))

const runtime = await createRuntime({ dataDir, workspace, demo: true })
try {
  // 主流程：写预览文件 → 建会话 → 提交带图片与三种预览文件的复合消息 → 等待完成 → 校验。
  const conversation = await runtime.create({ title: 'DSH 渲染验收 fixture' })
  const image = onePixelPng()
  const requestId = randomUUID()
  const input = {
    requestId,
    text: [
      '[render-fixture] 请完成确定性演示，然后保留并总结下面所有 Markdown 内容。',
      '',
      '预览文件：',
      '- [HTML 预览](render-preview.html)',
      '- [SVG 图片](render-preview.svg)',
      '- [PDF 预览](render-preview.pdf)',
      '- ![SVG 图片预览](render-preview.svg)',
    ].join('\n'),
    images: [{ data: image, mimeType: 'image/png' }],
    files: Object.entries(previewFiles).map(([name, content]) => ({
      name,
      mimeType: fileMime(name),
      data: Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content).toString('base64'),
    })),
  }
  await runtime.submit(conversation.conversation.id, input)
  // 校验阶段：工具链确实执行过（四个工具都出现）、PNG 读结果以 image 块渲染、
  // 最终回答包含表格/代码/公式/引用四类 Markdown 内容；任一缺失即抛错。
  const detail = await waitForCompletedRun(runtime, conversation.conversation.id)
  const toolNames = detail.messages.flatMap(message => message.role === 'tool' && message.toolName !== undefined ? [message.toolName] : [])
  const toolImages = detail.messages.flatMap(message => message.role === 'tool'
    ? message.blocks.filter(block => block.type === 'image').map(block => block.mimeType) : [])
  const expectedTools = ['write', 'edit', 'read', SHELL_TOOL]
  const missingTools = expectedTools.filter(name => !toolNames.includes(name))
  if (missingTools.length > 0) throw new Error(`Demo fixture did not execute tools: ${missingTools.join(', ')}`)
  if (toolImages.length === 0) throw new Error('Demo fixture did not render the PNG read result as an image block')
  const answer = detail.messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.blocks.filter(block => block.type === 'text').map(block => block.text)).join('\n')
  const expectedContent = ['| Surface | Result |', 'const rendered = true', 'x^2 + y^2 = z^2', 'citation']
  const missingContent = expectedContent.filter(value => !answer.includes(value))
  if (missingContent.length > 0) throw new Error(`Demo fixture omitted Markdown content: ${missingContent.join(', ')}`)

  console.log(JSON.stringify({
    result: 'ready',
    conversationId: detail.conversation.id,
    title: detail.conversation.title,
    dataDir,
    workspace,
    requestId,
    messageCount: detail.messages.length,
    userImages: detail.messages.flatMap(message => message.role === 'user'
      ? message.blocks.filter(block => block.type === 'image').map(block => block.mimeType) : []),
    fileBlocks: detail.messages.flatMap(message => message.role === 'user'
      ? message.blocks.filter(block => block.type === 'file').map(block => ({ name: block.name, path: block.path, mimeType: block.mimeType })) : []),
    toolNames,
    toolImages,
    artifactCount: detail.messages.reduce((count, message) => count + (message.artifacts?.length ?? 0), 0),
    finalAnswer: answer,
  }, null, 2))
} finally {
  await runtime.close()
}

/**
 * 功能：轮询等待 demo 会话完成——非 busy 且最终回答包含 fixture 结束标记（`# Render fixture`）。
 * @param runtime demo runtime 实例。
 * @param conversationId 会话 id。
 * @returns 完成后的会话详情。
 * @throws 会话出错、或 45 秒内未出现完成标记。
 */
async function waitForCompletedRun(runtime: Awaited<ReturnType<typeof createRuntime>>, conversationId: string) {
  const deadline = Date.now() + 45_000
  let latest = await runtime.detail(conversationId)
  while (Date.now() < deadline) {
    if (latest.error !== undefined) throw new Error(latest.error)
    const finalText = latest.messages.some(message => message.role === 'assistant' && !message.streaming
      && message.blocks.some(block => block.type === 'text' && block.text.includes('# Render fixture')))
    if (!latest.conversation.busy && finalText) return latest
    await delay(80)
    latest = await runtime.detail(conversationId)
  }
  throw new Error(`Demo fixture did not finish within 45 seconds; conversation=${conversationId}`)
}

/**
 * 功能：读取 CLI 参数值，支持 `--name=value` 与 `--name value` 两种写法。
 * @param name 形如 `--data-dir` 的参数名。
 * @returns 参数值；未提供时返回 undefined（由调用方回退默认值）。
 */
function option(name: string): string | undefined {
  const equals = process.argv.find(value => value.startsWith(`${name}=`))
  if (equals !== undefined) return equals.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * 功能：生成写入工作区的三份预览文件（内联脚本 HTML、SVG 图标、手工构造的最小 PDF）。
 * @returns 文件名 → 内容（HTML/SVG 为字符串，PDF 为 Buffer）。
 */
function createPreviewFiles(): Record<string, string | Buffer> {
  return {
    'render-preview.html': '<!doctype html><html><head><meta charset="utf-8"><title>Render preview</title><style>body{font:16px system-ui;padding:24px;color:#19324a}h1{color:#1474cc}</style></head><body><h1>Sandboxed HTML preview</h1><p>Inline style and content render inside the isolated inspector.</p><script>document.body.dataset.preview = "ready"</script></body></html>',
    'render-preview.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="20" fill="#e8f2ff"/><circle cx="84" cy="80" r="42" fill="#3986df"/><path d="M64 81l14 14 29-32" fill="none" stroke="white" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><text x="145" y="88" font-family="sans-serif" font-size="22" fill="#183b63">SVG preview</text></svg>',
    'render-preview.pdf': createPdfFixture(),
  }
}

/** 按文件扩展名推断 MIME 类型；未知扩展名回退 application/octet-stream。 */
function fileMime(name: string): string {
  if (name.endsWith('.html')) return 'text/html'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

/** 返回 1x1 透明 PNG 的 base64（固定字节），作为提交消息携带的用户图片。 */
function onePixelPng(): string {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
}

/**
 * 功能：手工构造一份最小合法 PDF（含目录/页面/字体/内容流与 xref 表）。
 * @returns PDF 文件字节。
 * 内部逻辑：内容流只画一行 Helvetica 文本；逐对象记录偏移写入 xref，结尾带 trailer 与 %%EOF。
 */
function createPdfFixture(): Buffer {
  const stream = 'BT /F1 20 Tf 72 720 Td (Pi Durable PDF preview) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, 'ascii'))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(document, 'ascii')
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(document, 'ascii')
}
