# Plugin HTML UI style (WeTrack style)

Every pi-web plugin page renders inside a sandboxed iframe with a strict CSP. This guide is the
house style for plugin HTML: the design tokens, layout skeleton, runtime patterns and the
form/library integration rules. The canonical in-repo implementation is `plugins/wetrack-defects`
(`ui/board.html` + `server.mjs` + `ui/vendor/`); copy from it when in doubt.

## Host constraints (read first)

- The page is **one self-contained HTML document** returned from `resources/read`. The host adds:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; form-action 'none'; base-uri 'none'`
- Consequences: all `<style>`/`<script>` must be **inline**; no external `<script src>`/`<link>`,
  no CDN, no import maps, no fonts loaded over the network (use system font stacks); no
  `fetch`/XHR/WebSocket from the page (`connect-src 'none'`); images only `data:`/`https:`.
- The iframe is opaque-origin (`sandbox="allow-scripts"`). Everything the page needs from the
  host or the network goes through the JSON-RPC bridge over `parent.postMessage`: `tools/call`,
  `resources/read`, `ui/update-model-context`, `ui/message`, `ui/open-link` (https only).
  One message ≤ 256 KiB; `tools/call` arguments ≤ 256 KiB.
- Container: Inspector sidebar is 280–760 px wide (default 360, user-resizable); a fullscreen
  right-pane tab is full height; inline cards are 320–640 px high. The page must look right at
  ~360 px and adapt up to 760 px.

## Design tokens

Put these at the top of the single `<style>` block. Never hardcode colors in components; use the
variables so light/dark follows the OS automatically (`color-scheme` + `prefers-color-scheme`).

```css
:root{color-scheme:light dark;--bg:#f4f6fb;--panel:#fff;--panel-2:#f8f9fd;--ink:#1c2434;--muted:#6b7488;--line:#e4e8f1;--accent:#4f6ef7;--accent-2:#7c5cf0;--good:#1a9b6c;--warn:#c9821f;--bad:#d34545}
@media (prefers-color-scheme:dark){:root{--bg:#10141e;--panel:#181e2b;--panel-2:#1e2534;--ink:#eef2fb;--muted:#9aa5bb;--line:#2a3346;--accent:#8ea2ff;--accent-2:#b49bff;--good:#5bd3a5;--warn:#f0b45c;--bad:#ff8a8a}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:radial-gradient(1000px 380px at 10% -10%,color-mix(in srgb,var(--accent) 12%,transparent),transparent 65%),var(--bg);color:var(--ink);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
```

Token semantics: `--bg` page background, `--panel` card/surface, `--panel-2` inset surface,
`--ink` primary text, `--muted` secondary text, `--line` borders, `--accent`/`--accent-2` brand
gradient, `--good`/`--warn`/`--bad` status colors. Compose tints with
`color-mix(in srgb, var(--accent) 12%, transparent)` instead of new literals.

## Page skeleton

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Plugin</title>
<style>/* tokens + components (below) */</style>
</head>
<body>
<div id="app">
  <header class="top">
    <div class="brand"><div class="logo">MP</div><div><h1>My Plugin</h1><div class="sub" id="sub">正在连接…</div></div></div>
    <div class="spacer"></div>
    <div class="tabs" role="tablist" aria-label="视图">
      <button type="button" role="tab" id="tabMain" aria-selected="true" data-view="main">主视图</button>
    </div>
    <button type="button" id="refresh">刷新</button>
  </header>
  <main id="main" style="flex:1;min-height:0;overflow:auto;padding:16px 20px 24px"></main>
</div>
<script>/* runtime (below) */</script>
</body>
</html>
```

Top-bar pieces:

```css
#app{display:flex;height:100%;min-height:520px;flex-direction:column}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 16px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 88%,transparent);backdrop-filter:blur(12px)}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.logo{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:800;font-size:12px}
h1{margin:0;font-size:14px;letter-spacing:.2px}.sub{font-size:11px;color:var(--muted)}
.spacer{flex:1}
.tabs{display:flex;gap:4px;padding:3px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2)}
.tabs button{border:0;background:transparent;padding:4px 10px;color:var(--muted)}
.tabs button[aria-selected=true]{background:var(--panel);color:var(--ink);box-shadow:0 1px 3px rgba(20,28,50,.08)}
```

Keep the `.sub` element as the live status line (row counts, sync time, "已把草稿发给 AI").
Narrow-width behavior (list/detail boards collapse to one column; the top bar wraps):

```css
@media(max-width:760px){.layout{grid-template-columns:1fr}.list{max-height:42vh;border-right:0;border-bottom:1px solid var(--line)}.main{padding:12px}}
@media(max-width:560px){.brand{flex:1 1 100%}.spacer{display:none}.top{padding:10px 12px}.tabs{order:2}.top > #refresh{order:2}}
```

## Component styles

```css
button{font:inherit;color:inherit;border:1px solid var(--line);background:var(--panel);border-radius:9px;padding:6px 11px;cursor:pointer;transition:border-color .16s,background .16s,color .16s;white-space:nowrap}
button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
button.primary{border:0;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;box-shadow:0 6px 14px color-mix(in srgb,var(--accent) 28%,transparent)}
button:disabled{opacity:.5;cursor:default}
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:var(--panel-2);color:var(--muted);font-size:11px;white-space:nowrap}
input,select,textarea{font:inherit;color:var(--ink);border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:7px 10px;font-size:12px;outline:none}
input:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.card{border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:0 2px 10px rgba(20,28,50,.04);margin-bottom:12px;overflow:hidden}
.card > h3{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;padding:9px 13px;border-bottom:1px solid var(--line);background:var(--panel-2);font-size:12px;color:var(--muted);font-weight:600}
.cardBody{padding:11px 13px}
.banner{margin:0 0 12px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--bad) 40%,var(--line));border-radius:10px;background:color-mix(in srgb,var(--bad) 8%,var(--panel));color:var(--bad);font-size:12px;white-space:pre-wrap}
.empty{display:flex;min-height:200px;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--muted);text-align:center}
.empty strong{color:var(--ink);font-size:14px}.empty .hint{max-width:520px;font-size:12px;line-height:1.7;white-space:pre-wrap}
.loading{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}
.spinner{width:12px;height:12px;border:1.5px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
```

Status badges color by semantic level via `data-level` instead of new color classes:

```css
.sev{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:999px;font-size:10px;border:1px solid var(--line);background:var(--panel-2)}
.sev[data-level="严重"],.sev[data-level="致命"]{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}
.sev[data-level="一般"]{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,var(--line))}
.sev[data-level="轻微"],.sev[data-level="建议"]{color:var(--good);border-color:color-mix(in srgb,var(--good) 35%,var(--line))}
```

List + detail board layout (only when the page has a master/detail split):

```css
.layout{display:grid;min-height:0;flex:1;grid-template-columns:320px minmax(0,1fr)}
.list{border-right:1px solid var(--line);background:color-mix(in srgb,var(--panel) 70%,transparent);display:flex;min-height:0;flex-direction:column}
.items{min-height:0;overflow:auto;padding:6px}
.item{display:flex;width:100%;flex-direction:column;gap:4px;margin-bottom:5px;padding:9px 10px;border:1px solid transparent;border-radius:11px;background:transparent;text-align:left;cursor:pointer}
.item:hover{background:var(--panel-2)}.item[data-selected=true]{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));background:color-mix(in srgb,var(--accent) 8%,var(--panel))}
.itemDesc{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:12px;color:var(--ink)}
.itemMeta{display:flex;gap:6px;flex-wrap:wrap;color:var(--muted);font-size:10px}
```

## Runtime patterns

Single `state` + one `render()`; escape every interpolated value; never `innerHTML` unescaped
model/CLI-provided strings (sanitize rich text through an allowlist like WeTrack's
`safeDescription()` before injecting).

```js
const state = { view: 'main', data: null, loading: false, error: '' };
const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).get('demo') === '1';
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function setSub(text) { $('sub').textContent = text; }
function render() {
  $('main').innerHTML = (state.error ? `<div class="banner" role="alert">${esc(state.error)}</div>` : '')
    + (state.loading ? '<div class="loading"><span class="spinner"></span>读取中…</div>' : '')
    + renderBody();
  setSub(state.data ? '就绪' : '正在连接…');
}
function renderBody() { return state.data ? '<section class="card"><h3>数据</h3><div class="cardBody">…</div></section>' : '<div class="empty"><strong>暂无数据</strong></div>'; }
let seq = 0; const pending = new Map();
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('插件桥接超时')); }, 45000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
}
async function callTool(name, args) {
  state.loading = true; state.error = ''; render();
  try {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result?.isError) { state.loading = false; state.error = result.content?.[0]?.text ?? '工具执行失败'; render(); return null; }
    state.loading = false;
    const content = result?.structuredContent ?? result?.result?.structuredContent;
    if (content) { state.data = content; }
    render();
    return result;
  } catch (error) {
    state.loading = false; state.error = error instanceof Error ? error.message : String(error); render(); return null;
  }
}
addEventListener('message', event => {
  const m = event.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.method === 'ui/initialize') { parent.postMessage({ jsonrpc: '2.0', method: 'ui/initialized' }, '*'); if (!demo) callTool('my_tool', {}); return; }
  if (m.method === 'ui/notifications/tool-result' || m.method === 'ui/tool-result') { /* apply pushed result, render */ return; }
  if (m.id !== undefined && pending.has(m.id)) { const e = pending.get(m.id); pending.delete(m.id); clearTimeout(e.timer); m.error ? e.reject(new Error(m.error.message ?? '桥接调用失败')) : e.resolve(m.result); }
});
if (demo) { state.data = DEMO; render(); }
else { render(); setTimeout(() => { if (state.data === null && !state.loading) { state.error = '还没有收到 Host 的桥接握手。若直接打开此页面，请加 ?demo=1。'; render(); } }, 1500); }
```

Rules that go with the skeleton:

- **Demo mode is mandatory.** `?demo=1` renders built-in `DEMO` data with no host, so the page can
  be previewed offline; without the handshake the page shows the hint banner instead of failing.
- **Tool results drive the page.** The model-visible tool `content` stays a short summary; the
  full payload goes to `structuredContent` for the page AND into `content[0].text` when the model
  needs it (the host never shows `structuredContent` to the model). Use `preferredDisplayMode:
  'fullscreen'` with a **stable `toolCallId`** so all results of the plugin share one side-pane
  tab that updates in place.
- **Never `innerHTML`-rebuild a container that hosts a third-party renderer** (survey, editor,
  chart). Reserve slot elements (`bannerSlot`, `draftSlot`, …) and update them in place; rebuild
  the page only when switching views. This bites SurveyJS's preact renderer especially hard.

## Forms

Simple 2–4 field forms: plain inputs/selects/buttons styled with the tokens above.

Schema-driven or AI-drafted forms (long field lists, validation, localized messages): vendor
SurveyJS Form Library like `plugins/wetrack-defects@1.1.0` does — MIT licensed, works without a
framework:

- Files from npm `survey-core` + `survey-js-ui` (pin the same version): `survey.core.min.js`
  (global `Survey`), `survey-js-ui.min.js` (global `SurveyUI`, vanilla renderer),
  `survey-core.min.css` (no `@font-face`, CSP-safe), `i18n/simplified-chinese.min.js` (locale
  `zh-cn`), `themes/default-light.min.js` + `themes/default-dark.min.js` (global `SurveyTheme`).
  Check the minified files contain no `</script` before inlining.
- Survey definition is a plain JSON object in the page (`title`, `elements` with
  `text/dropdown/comment`, `isRequired`, `placeholder`, `defaultValue`) — easy for the model to
  read and edit.

```js
surveyModel = new Survey.Model(FORM);
surveyModel.locale = 'zh-cn';
surveyModel.render(mountEl);
applySurveyTheme();                       // survey.applyTheme(SurveyTheme.DefaultDark / DefaultLight) on matchMedia change
```

Non-negotiables (each one was a real failure):

1. **Never complete the survey.** The completed state blanks the form area and cannot be
   recovered from (`clear()` does not restore it). Submit with your own button:
   `if (surveyModel.validateCurrentPage() === false) return;` then read `surveyModel.data`.
   Keeping the survey in `running` preserves the user's input for the next iteration.
2. **Hide the built-in navigation with CSS**: `.surveyWrap .sd-navigation{display:none}`.
   Setting `showCompleteButton` / `showNavigationButtons` at runtime does not remove the button;
   with your own submit present it would be a second, destructive entry point.
3. **Do not rebuild or move the mount's ancestors** while the form is alive (preact renderer).
4. Playwright `fill()` does not stick on these inputs (synthetic events vs preact); use
   click + real typing when writing browser acceptance tests.

## Vendor assets and server-side assembly

Anything larger than ~50 KB of third-party code goes to `ui/vendor/` as prebuilt dist files; the
HTML keeps markers and the MCP server inlines them at startup (install does not run npm/build):

```html
<style>/*__VENDOR_CSS__*/</style>
...
<script>/*__VENDOR_CORE__*/</script>
<script>/*__VENDOR_APP__*/</script>
```

```js
function replaceOnce(html, marker, content) {
  if (!html.includes(marker)) throw new Error(`page 缺少标记 ${marker}`)
  return html.replace(marker, () => content)   // replacer FUNCTION: minified JS contains $& sequences
}
const uiHtml = await (async () => {
  let html = await readFile(resolve(ROOT, 'ui/page.html'), 'utf8')
  html = replaceOnce(html, '/*__VENDOR_CSS__*/', await vendor('lib.min.css'))
  html = replaceOnce(html, '/*__VENDOR_CORE__*/', await vendor('lib.core.min.js'))
  html = replaceOnce(html, '/*__VENDOR_APP__*/', await vendor('lib.ui.min.js'))
  return html
})()
```

Guard rails: the assembled single file must stay under the host's 20 MB per-file cap (a
SurveyJS page is ~2.6 MB); keep `?demo=1` usable even when vendors only load via assembly —
feature-detect the global (`typeof Survey !== 'undefined'`) and show a hint in the affected view
instead of crashing; document the upgrade path (`ui/vendor/` files are replaced as a set).

## Acceptance

- `node --check server.mjs`.
- stdio smoke: `initialize` → `tools/list` → `resources/read`; assert the returned HTML has no
  leftover `/*__VENDOR_*__*/` markers and contains the vendor globals.
- Serve the **assembled** HTML with the exact CSP header above, open `?demo=1`, and check in a
  real browser: tabs switch, list renders, forms validate and submit, no console errors.
- Smoke tools with a fixture env var (like `WETRACK_FIXTURE`) instead of the real backend.
