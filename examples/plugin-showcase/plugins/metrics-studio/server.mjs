import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const tools = [{
  name: 'metrics_snapshot',
  description: 'Return the current delivery metrics snapshot',
  inputSchema: { type: 'object', properties: {} },
}]
const snapshot = {
  kpis: [
    { label: '构建成功率', value: '98.6%', delta: '+1.4%', tone: 'good' },
    { label: 'P95 延迟', value: '182ms', delta: '-12ms', tone: 'good' },
    { label: '本周发布', value: '12', delta: '+3', tone: 'neutral' },
    { label: '未关闭告警', value: '4', delta: '-2', tone: 'warn' },
  ],
  series: [
    { day: '周一', value: 62 }, { day: '周二', value: 74 }, { day: '周三', value: 58 },
    { day: '周四', value: 88 }, { day: '周五', value: 81 }, { day: '周六', value: 46 }, { day: '周日', value: 69 },
  ],
}

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Metrics Studio</title>
<style>
:root{color-scheme:light dark;--bg:#0f1320;--panel:#171d2e;--panel2:#1e263b;--ink:#eef2ff;--muted:#93a0bf;--line:rgba(255,255,255,.08);--teal:#35d0ba;--violet:#8b7bff;--rose:#ff8d9a;--amber:#ffc66d}
@media (prefers-color-scheme:light){:root{--bg:#f3f5fb;--panel:#ffffff;--panel2:#f7f9ff;--ink:#1b2336;--muted:#69748e;--line:rgba(25,35,60,.08);--teal:#0f9d8c;--violet:#6657e8;--rose:#d94f63;--amber:#c98a1a}}
*{box-sizing:border-box}body{margin:0;padding:14px;background:radial-gradient(900px 360px at 85% -10%,rgba(139,123,255,.22),transparent 60%),radial-gradient(700px 300px at 0% 110%,rgba(53,208,186,.16),transparent 55%),var(--bg);color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
.shell{max-width:1100px;margin:0 auto;background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.28)}
.hero{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 18px;border-bottom:1px solid var(--line);background:linear-gradient(120deg,rgba(139,123,255,.14),rgba(53,208,186,.08))}
.brand{display:flex;align-items:center;gap:11px}.logo{width:32px;height:32px;border-radius:10px;background:conic-gradient(from 210deg,var(--violet),var(--teal),var(--violet));display:grid;place-items:center;color:#fff;font-weight:700;font-size:12px;box-shadow:0 8px 18px rgba(102,87,232,.35)}
h1{font-size:15px;margin:0}.sub{font-size:11px;color:var(--muted);margin-top:2px}.actions{display:flex;gap:8px}
.btn{border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--ink);border-radius:9px;padding:6px 11px;font-size:12px;cursor:pointer;transition:.16s}.btn:hover{border-color:var(--violet);color:var(--violet)}
.btn.primary{background:linear-gradient(135deg,var(--violet),var(--teal));border:0;color:#fff;box-shadow:0 8px 18px rgba(102,87,232,.3)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:14px 18px 4px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:11px 12px;position:relative;overflow:hidden}.kpi::after{content:'';position:absolute;inset:auto -20px -30px auto;width:70px;height:70px;border-radius:50%;background:radial-gradient(circle,rgba(139,123,255,.22),transparent 70%)}
.kpi span{display:block;color:var(--muted);font-size:10px;letter-spacing:.2px}.kpi b{display:block;font-size:21px;letter-spacing:-.4px;margin:3px 0 2px}.kpi i{font-style:normal;font-size:10px;color:var(--teal)}.kpi[data-tone=warn] i{color:var(--amber)}
.chart{margin:12px 18px 16px;background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:12px 14px}
.chart h2{font-size:12px;margin:0 0 10px;color:var(--muted);font-weight:600;display:flex;justify-content:space-between}
.bars{display:flex;align-items:flex-end;gap:10px;height:110px;padding-top:6px}
.bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end}
.bar em{display:block;width:100%;border-radius:7px 7px 3px 3px;background:linear-gradient(180deg,var(--violet),color-mix(in srgb,var(--teal) 55%,var(--violet)));min-height:6px;transition:.2s;box-shadow:0 6px 14px rgba(102,87,232,.22)}
.bar:hover em{filter:brightness(1.15)}.bar span{font-size:9px;color:var(--muted)}
.foot{display:flex;align-items:center;justify-content:space-between;padding:10px 18px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}.pulse{width:7px;height:7px;border-radius:50%;background:var(--teal);display:inline-block;margin-right:6px;box-shadow:0 0 0 0 rgba(53,208,186,.5);animation:p 2s infinite}
@keyframes p{0%{box-shadow:0 0 0 0 rgba(53,208,186,.45)}70%{box-shadow:0 0 0 8px rgba(53,208,186,0)}100%{box-shadow:0 0 0 0 rgba(53,208,186,0)}}
@media (max-width:720px){.kpis{grid-template-columns:repeat(2,1fr)}.hero{flex-direction:column;align-items:flex-start}}
</style></head><body><div class="shell">
<div class="hero"><div class="brand"><div class="logo">MS</div><div><h1>Metrics Studio</h1><div class="sub" id="sub">正在连接指标源…</div></div></div>
<div class="actions"><button class="btn" id="refresh">刷新</button><button class="btn" id="context">写入上下文</button><button class="btn primary" id="message">生成周报</button></div></div>
<div class="kpis" id="kpis"></div>
<div class="chart"><h2><span>本周构建趋势</span><span id="range">最近 7 天</span></h2><div class="bars" id="bars"></div></div>
<div class="foot"><span><span class="pulse"></span><span id="status">等待插件桥接</span></span><span id="stamp"></span></div>
</div>
<script>
const pending=new Map();let seq=0;const el=id=>document.getElementById(id);
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')});
function setStatus(t){el('status').textContent=t}
function render(data){const kpis=el('kpis');kpis.innerHTML='';for(const k of data?.kpis??[]){const d=document.createElement('div');d.className='kpi';d.dataset.tone=k.tone;d.innerHTML='<span></span><b></b><i></i>';d.querySelector('span').textContent=k.label;d.querySelector('b').textContent=k.value;d.querySelector('i').textContent=k.delta;kpis.appendChild(d)}
 const bars=el('bars');bars.innerHTML='';const series=data?.series??[];const max=Math.max(1,...series.map(s=>s.value));for(const s of series){const b=document.createElement('div');b.className='bar';b.title=s.day+' · '+s.value;const em=document.createElement('em');em.style.height=(s.value/max*100)+'%';const label=document.createElement('span');label.textContent=s.day;b.append(em,label);bars.appendChild(b)}
 el('sub').textContent='数据已同步 · '+series.length+' 天';el('stamp').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}
async function load(){setStatus('正在同步指标…');try{const r=await rpc('tools/call',{name:'metrics_snapshot',arguments:{}});if(r?.structuredContent?.kpis){render(r.structuredContent);setStatus('指标已同步')}else setStatus('指标为空')}catch(e){setStatus('同步失败：'+e.message)}}
addEventListener('message',event=>{const m=event.data;if(!m||m.jsonrpc!=='2.0')return;if(m.method==='ui/initialize'){parent.postMessage({jsonrpc:'2.0',method:'ui/initialized'},'*');load();return}if(m.method==='ui/notifications/tool-result'){if(m.params?.structuredContent?.kpis){render(m.params.structuredContent);setStatus('指标已同步')}return}if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}});
el('refresh').onclick=load;
el('context').onclick=async()=>{try{await rpc('ui/update-model-context',{content:[{type:'text',text:'指标快照：构建成功率 98.6%，P95 延迟 182ms，本周发布 12 次，未关闭告警 4 个。'}],structuredContent:{buildSuccess:98.6,p95:182,releases:12,alerts:4}});setStatus('已写入上下文')}catch(e){setStatus('上下文失败：'+e.message)}};
el('message').onclick=async()=>{try{await rpc('ui/message',{content:[{type:'text',text:'请根据指标工作台生成一份本周交付周报。'}]});setStatus('周报请求已发送')}catch(e){setStatus('发送失败：'+e.message)}};
</script></body></html>`

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'metrics-studio', version: '1.0.0' } } }); return }
  if (message.method === 'tools/list') { send({ jsonrpc: '2.0', id: message.id, result: { tools } }); return }
  if (message.method === 'resources/list') { send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'ui://metrics/dashboard', name: 'Metrics Studio', mimeType: 'text/html' }] } }); return }
  if (message.method === 'resources/read') { send({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: 'ui://metrics/dashboard', mimeType: 'text/html', text: page }] } }); return }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: '指标已加载：构建成功率 98.6%，P95 延迟 182ms，本周发布 12 次，未关闭告警 4 个。' }],
      structuredContent: snapshot,
      _meta: { ui: { resourceUri: 'ui://metrics/dashboard', title: 'Metrics Studio', heightHint: 420, preferredDisplayMode: 'inline' } },
    } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
