import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const tools = [{ name: 'probe', description: 'Report the Node version and platform', inputSchema: { type: 'object', properties: {} } }]

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'terminal-lab', version: '1.0.0' } } }); return }
  if (message.method === 'tools/list') { send({ jsonrpc: '2.0', id: message.id, result: { tools } }); return }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `node ${process.version} · ${process.platform}/${process.arch}` }] } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
