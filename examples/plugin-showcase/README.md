# Pi Web Plugin Showcase

A local marketplace that exercises every plugin state and capability type.

Add this directory as a marketplace in **Settings → Plugins**:

```text
examples/plugin-showcase
```

A second, tiny marketplace lives in `extra-market/`; install `archive-vault` from it, then remove that marketplace to see the “市场来源已移除” state.

## Status matrix

| Plugin | Type | Suggested state |
| --- | --- | --- |
| `kanban-board` | MCP + UI | Installed + enabled; tool result renders an interactive kanban inline |
| `metrics-studio` | MCP + UI | Installed + enabled; tool result renders a KPI dashboard inline |
| `weather-station` | Skill + MCP | Installed at 1.1.0 with the market at 1.2.0 → update available |
| `terminal-lab` | MCP only | Installed, then disabled → skills/MCP disappear |
| `pdf-notes` | Skill + unsupported commands/hooks/agents | Installed + enabled → unsupported diagnostics |
| `broken-bridge` | MCP only, missing server file | Installed → MCP server status `error` |
| `lineup-card` | Skill only | Left uninstalled → “可安装” |
| `archive-vault` (extra market) | Skill only | Installed, then remove `Archive Market` → source removed |

## Plugin UI bridge

Both UI plugins speak the host JSON-RPC bridge:

- `tools/call` refreshes the page data;
- `ui/update-model-context` writes a Composer chip;
- `ui/message` submits a follow-up message.

The pages use inline CSS only and adapt to light/dark.
