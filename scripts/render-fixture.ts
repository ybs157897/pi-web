import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime/index.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
const defaultRoot = resolve('artifacts', `render-fixture-${timestamp}`)
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

function option(name: string): string | undefined {
  const equals = process.argv.find(value => value.startsWith(`${name}=`))
  if (equals !== undefined) return equals.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function createPreviewFiles(): Record<string, string | Buffer> {
  return {
    'render-preview.html': '<!doctype html><html><head><meta charset="utf-8"><title>Render preview</title><style>body{font:16px system-ui;padding:24px;color:#19324a}h1{color:#1474cc}</style></head><body><h1>Sandboxed HTML preview</h1><p>Inline style and content render inside the isolated inspector.</p><script>document.body.dataset.preview = "ready"</script></body></html>',
    'render-preview.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="20" fill="#e8f2ff"/><circle cx="84" cy="80" r="42" fill="#3986df"/><path d="M64 81l14 14 29-32" fill="none" stroke="white" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><text x="145" y="88" font-family="sans-serif" font-size="22" fill="#183b63">SVG preview</text></svg>',
    'render-preview.pdf': createPdfFixture(),
  }
}

function fileMime(name: string): string {
  if (name.endsWith('.html')) return 'text/html'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

function onePixelPng(): string {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
}

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
