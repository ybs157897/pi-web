import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const tools = [{
  name: 'forecast',
  description: 'Return a compact three-hour forecast for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}]

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'weather-station', version: '1.1.0' } } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    const city = String(message.params?.arguments?.city ?? '上海')
    const structured = { city, rain: 72, wind: '东南风 3 级', visibility: '8 km', window: '未来 3 小时' }
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: `${city}：${structured.window}降雨概率 ${structured.rain}%，${structured.wind}，能见度 ${structured.visibility}。` }],
      structuredContent: structured,
    } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
