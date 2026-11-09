# AGENTS.md — pi-web 仓库常驻指令

pi-web（包名 `pi-durable-web`）：基于 Pi Durable 内核的 Web Agent 界面，以 DSH Web 为视觉与交互基准、ZCode 为部分交互参照。改代码前先读 [docs/architecture.md](docs/architecture.md)。

## 布局

- `src/server/` — 服务端：`runtime/`（装配）、`conversation/`（提示词与压缩）、`tools/`（工具扩展）、`model/`（模型目录）、`memory/`、`mcp/`、`automation/`
- `src/web/` — 前端（React + antd）；`src/shared/` — 前后端共享类型
- `tests/` — vitest；`tests/__snapshots__/prompt/` 是提示词完整请求快照（评审门）
- `scripts/` — tsx 顶层 await 风格脚本（live 验收与文档门）
- `docs/` — 文档体系，层级与规则见 [docs/AGENTS.md](docs/AGENTS.md)
- `skills/`、`plugins/` — 内置技能与 WeTrack 插件
- `workspace/`、`.data/` — 运行时目录（gitignored），不属于源码

## 命令

- `npm run check` — typecheck + vitest + build + doc:check，改动后的最低门槛
- `npm run test:live:*` — 真实模型验收（需有效凭据；失败记「未执行」，不算通过）
- `npm run gen:docs` / `npm run verify:docs` — 生成 / 校验 tool-catalog 与 section-catalog

## 约定

- 改提示词（`src/server/conversation/prompts/` 或任何 section/工具描述）后：`npx vitest run tests/prompt-snapshot.test.ts -u` 刷新快照并逐份审 diff，再跑 `check`；涉及行为的改动另跑对应 live 场景（[理由](docs/defensive-patterns/prompt-changes.md)）。
- `runtime-core` 正文 ≤ 3,300 字符由 `tests/prompt-snapshot.test.ts:152` 把守；加规则先想删什么。
- 改文档后跑 `npm run doc:check`；层级归属和写作规则见 [docs/AGENTS.md](docs/AGENTS.md)。
- Windows 是有条件支持：shell 相关改动不能只在 macOS 验证（[边界](docs/windows-support.md)）。
- 仓库根的 `AGENTS.md`（本文件）面向开发者与开发 agent；运行时读取的是 workspace 根的 `AGENTS.md`（`src/server/workspace/instructions.ts:6`），两者互不相干。
- 凭据与用户配置只存在服务端数据目录，不进仓库、不进日志、不进提示词。

## 编辑本文件

每条指令自包含、1–3 行、链接理由归属地；新增指令先确认没有更合适的层（[文档标准](docs/AGENTS.md)）。字数上限由 `scripts/doc-budgets.manifest.json` 把守。
