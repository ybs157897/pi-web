import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const columns = [
  { id: 'todo', title: '待办', color: '#7c8cf8', tasks: [
    { id: 'T-101', title: '支付回调重试策略', owner: '林舟', tag: '后端' },
    { id: 'T-102', title: '空态插画补齐', owner: '周末', tag: '设计' },
  ] },
  { id: 'doing', title: '进行中', color: '#f0a35e', tasks: [
    { id: 'T-103', title: '灰度发布看板', owner: '陈一', tag: '前端' },
  ] },
  { id: 'done', title: '已完成', color: '#5fbf8f', tasks: [
    { id: 'T-104', title: '指标快照接口', owner: '小满', tag: '后端' },
    { id: 'T-105', title: '发布演练脚本', owner: '阿岚', tag: 'SRE' },
  ] },
]
const tools = [
  { name: 'board_snapshot', description: 'Return the current kanban board', inputSchema: { type: 'object', properties: {} } },
  { name: 'move_task', description: 'Move a task to another column', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, toColumn: { type: 'string' } }, required: ['taskId', 'toColumn'] } },
]

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Kanban Board</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7fb;--panel:#fff;--ink:#1d2433;--muted:#6b7488;--line:#e7eaf2;--accent:#5b6cff;--accent2:#8f7bff;--shadow:0 12px 30px rgba(28,36,64,.12)}
@media (prefers-color-scheme:dark){:root{--bg:#11151f;--panel:#1a2030;--ink:#eef1f8;--muted:#9aa4bb;--line:#2a3246;--shadow:0 12px 30px rgba(0,0,0,.35)}}
*{box-sizing:border-box}body{margin:0;padding:14px;background:radial-gradient(1200px 400px at 15% -10%,rgba(91,108,255,.18),transparent 60%),var(--bg);color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
.shell{max-width:1100px;margin:0 auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.hero{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;background:linear-gradient(120deg,rgba(91,108,255,.16),rgba(143,123,255,.08));border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px}.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;box-shadow:0 6px 14px rgba(91,108,255,.32)}
h1{font-size:15px;margin:0;letter-spacing:.2px}.sub{font-size:11px;color:var(--muted);margin-top:2px}
.actions{display:flex;gap:8px}.btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:9px;padding:6px 11px;font-size:12px;cursor:pointer;transition:.16s}
.btn:hover{border-color:var(--accent);color:var(--accent)}.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border:0;color:#fff;box-shadow:0 6px 14px rgba(91,108,255,.25)}
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:14px 18px 16px}
.col{background:color-mix(in srgb,var(--bg) 70%,var(--panel));border:1px solid var(--line);border-radius:13px;padding:11px;min-height:120px}
.col h2{display:flex;align-items:center;justify-content:space-between;font-size:12px;margin:0 0 9px;color:var(--muted);font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px}.count{font-size:10px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:1px 7px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:9px 10px;margin-bottom:8px;box-shadow:0 2px 6px rgba(20,28,50,.05);transition:.16s}
.card:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.card b{display:block;font-size:12px;font-weight:600;margin-bottom:5px}.meta{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px}
.tag{background:rgba(91,108,255,.1);color:var(--accent);border-radius:5px;padding:1px 6px;font-size:10px}.foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 18px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
.status{display:flex;align-items:center;gap:6px}.pulse{width:7px;height:7px;border-radius:50%;background:#5fbf8f;box-shadow:0 0 0 0 rgba(95,191,143,.5);animation:p 2s infinite}
@keyframes p{0%{box-shadow:0 0 0 0 rgba(95,191,143,.45)}70%{box-shadow:0 0 0 8px rgba(95,191,143,0)}100%{box-shadow:0 0 0 0 rgba(95,191,143,0)}}
@media (max-width:720px){.board{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="shell">
<div class="hero"><div class="brand"><div class="logo">KB</div><div><h1>交付看板</h1><div class="sub" id="sub">连接中…</div></div></div>
<div class="actions"><button class="btn" id="refresh">刷新</button><button class="btn" id="context">写入上下文</button><button class="btn primary" id="message">发送摘要</button></div></div>
<div class="board" id="board"></div>
<div class="foot"><span class="status"><span class="pulse"></span><span id="status">等待插件桥接</span></span><span id="stamp"></span></div>
</div>
<script>
const pending=new Map();let seq=0;
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')});
const el=id=>document.getElementById(id);
function setStatus(text){el('status').textContent=text}
function render(board){const root=el('board');root.innerHTML='';const cols=board?.columns??[];
 for(const col of cols){const sec=document.createElement('section');sec.className='col';
  const h=document.createElement('h2');h.innerHTML='<span><span class="dot" style="background:'+col.color+'"></span>'+col.title+'</span><span class="count">'+col.tasks.length+'</span>';sec.appendChild(h);
  for(const task of col.tasks){const card=document.createElement('div');card.className='card';card.innerHTML='<b></b><div class="meta"><span class="tag"></span><span class="owner"></span><span>'+task.id+'</span></div>';card.querySelector('b').textContent=task.title;card.querySelector('.tag').textContent=task.tag;card.querySelector('.owner').textContent=task.owner;sec.appendChild(card)}
  root.appendChild(sec)}
 el('sub').textContent=(board?.columns??[]).reduce((n,c)=>n+c.tasks.length,0)+' 个任务 · 实时同步';el('stamp').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}
async function load(){setStatus('正在同步看板…');try{const result=await rpc('tools/call',{name:'board_snapshot',arguments:{}});const structured=result?.structuredContent;if(structured?.columns){render(structured);setStatus('看板已同步')}else setStatus('工具返回了空看板')}catch(e){setStatus('同步失败：'+e.message)}}
addEventListener('message',event=>{const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
 if(m.method==='ui/initialize'){parent.postMessage({jsonrpc:'2.0',method:'ui/initialized'},'*');load();return}
 if(m.method==='ui/notifications/tool-result'){const structured=m.params?.structuredContent;if(structured?.columns){render(structured);setStatus('看板已同步')}return}
 if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
el('refresh').onclick=load;
el('context').onclick=async()=>{try{await rpc('ui/update-model-context',{content:[{type:'text',text:'看板当前 5 个任务：待办 2、进行中 1、已完成 2。'}],structuredContent:{column:'kanban-board',tasks:5}});setStatus('已写入上下文')}catch(e){setStatus('上下文失败：'+e.message)}};
el('message').onclick=async()=>{try{await rpc('ui/message',{content:[{type:'text',text:'请根据看板帮我总结当前交付风险。'}]});setStatus('摘要请求已发送')}catch(e){setStatus('发送失败：'+e.message)}};
</script></body></html>`

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'kanban-board', version: '1.0.0' } } })
    return
  }
  if (message.method === 'tools/list') { send({ jsonrpc: '2.0', id: message.id, result: { tools } }); return }
  if (message.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'ui://kanban/board', name: 'Kanban Board', mimeType: 'text/html' }] } })
    return
  }
  if (message.method === 'resources/read') {
    send({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: 'ui://kanban/board', mimeType: 'text/html', text: page }] } })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    if (name === 'move_task') {
      const to = String(message.params?.arguments?.toColumn ?? 'doing')
      const id = String(message.params?.arguments?.taskId ?? '')
      const from = columns.find(c => c.tasks.some(t => t.id === id))
      const target = columns.find(c => c.id === to)
      if (from && target) { const task = from.tasks.splice(from.tasks.findIndex(t => t.id === id), 1)[0]; target.tasks.push(task) }
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `任务 ${id} 已移动到 ${target?.title ?? to}` }], structuredContent: { columns } } })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: '看板已加载：5 个任务，2 个待办、1 个进行中、2 个已完成。' }],
      structuredContent: { columns },
      _meta: { ui: { resourceUri: 'ui://kanban/board', title: 'Kanban Board', heightHint: 430, preferredDisplayMode: 'inline' } },
    } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
