# pi-web plugin format

## Manifest

Path: `<plugin>/.pi-plugin/plugin.json` (`.zcode-plugin` and `.claude-plugin` are also accepted). JSON only; no comments.

Minimal skill-only plugin:

```json
{
  "name": "lineup-card",
  "version": "1.0.0",
  "description": "Turn a rough roster into a match-day lineup.",
  "author": { "name": "Your name" },
  "skills": ["skills"]
}
```

With an MCP server:

```json
{
  "name": "weather-station",
  "version": "1.0.0",
  "description": "Live forecast tools.",
  "skills": ["skills"],
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server.mjs"],
      "env": {},
      "exposure": "direct"
    }
  }
}
```

With an inline/side-panel UI surface:

```json
{
  "name": "kanban-board",
  "version": "1.0.0",
  "description": "Interactive board.",
  "mcpServers": {
    "board": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server.mjs"],
      "exposure": "direct"
    }
  },
  "ui": {
    "surfaces": [
      {
        "id": "board",
        "title": "Kanban Board",
        "server": "board",
        "resourceUri": "ui://kanban/board"
      }
    ]
  }
}
```

Field rules:

- `name`: lowercase kebab-case, 1–128 chars, `^[a-z0-9][a-z0-9._-]*$`.
- `version`: free string, but it MUST equal the catalog entry version.
- `skills`: array of plugin-relative directories. Each child directory must contain `SKILL.md`. Default the directory to `skills` and declare `["skills"]`.
- `mcpServers`: map of server key → `{ command, args?, env?, exposure? }`. `${PLUGIN_ROOT}` expands to the installed plugin root; `${PLUGIN_DATA}` to its writable data directory.
- `exposure`: `direct` (model-callable tool), `codemode` (code-mode only, default), `deferred` (discoverable later), `hidden` (page-only).
- `ui.surfaces`: `server` must name an `mcpServers` key; `resourceUri` must be what the server returns from `resources/read`.
- `commands`, `agents`, `hooks`, `lspServers`, `outputStyles`, `channels` are reported as unsupported; do not use them.

## Marketplace catalog

Path: the directory the user adds in Settings, normally `plugins/marketplace.json`.

```json
{
  "name": "my-dev-plugins",
  "description": "Local plugins for this workspace.",
  "owner": { "name": "Your name" },
  "plugins": [
    {
      "name": "lineup-card",
      "version": "1.0.0",
      "description": "Turn a rough roster into a match-day lineup.",
      "category": "dev",
      "source": "./lineup-card",
      "listing": {
        "displayName": "Lineup Card",
        "displayName_i18n": { "zh-CN": "首发阵容卡" },
        "examplePrompts": ["用首发阵容卡排一套 4-3-3"]
      }
    }
  ]
}
```

- `source` is relative to the catalog file, or an object for zip/GitHub/git sources.
- The catalog entry version MUST equal the plugin manifest version.
- Keep `plugins` entries and unrelated fields intact when updating one plugin.

## Minimal stdio MCP server

No SDK is required; speak newline-delimited JSON-RPC on stdin/stdout:

```js
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const tools = [{
  name: 'hello',
  description: 'Return a greeting',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
}]

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'my-plugin', version: '1.0.0' },
    } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    const name = String(message.params?.arguments?.name ?? 'world')
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: `Hello, ${name}` }],
    } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
})
```

For a UI surface, also implement `resources/list` and `resources/read` returning the HTML in `contents[0].text`. From a tool result, add:

```js
_meta: { ui: { resourceUri: 'ui://my-plugin/panel', title: 'My Panel', preferredDisplayMode: 'inline', heightHint: 360 } }
```

The page bridge allows `tools/call`, `resources/read`, `ui/update-model-context`, `ui/message` and `ui/open-link`; unsupported methods are rejected.

## Validation checklist

- [ ] All JSON parses.
- [ ] Manifest `name` equals the directory name and passes the slug pattern.
- [ ] Manifest and catalog versions match.
- [ ] Every `skills` path exists and each child has `SKILL.md` with frontmatter.
- [ ] Every `ui.surfaces[].server` exists in `mcpServers`.
- [ ] `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are the only placeholders; no absolute machine paths.
- [ ] No symlinks, secrets, or files outside the plugin directory.
- [ ] If a server was written and Node is available: `node --check server.mjs`.
- [ ] Installation, enabling, and a live trial were actually performed before claiming they work.

## Manual install steps (tell the user, do not perform)

1. Settings → Plugins → 添加市场 / Add marketplace.
2. Enter the absolute path to the **marketplace root** (the folder containing `marketplace.json`, not the plugin subfolder).
3. Install the plugin from the new market, then enable it if needed.
4. Start a new task and test the skill/tool/UI. For updates, refresh that market and click Update.
