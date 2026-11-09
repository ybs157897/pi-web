# Architecture

The browser renders host DTOs with ZCode-aligned message components and a shell using the pinned DSH theme. The HTTP server owns input validation and streaming transport. The runtime owns Pi Durable, its SQLite session, provider configuration, and conversation metadata.

## 组成

产品分三层：浏览器前端 `src/web/` 渲染 host DTO 与应用壳；HTTP 服务器（[app.ts](../src/server/app.ts)）把 HTTP 映射到 [contracts.ts](../src/server/contracts.ts) 定义的 `Runtime` 接口，负责输入校验与流式传输；runtime 由 [runtime/index.ts](../src/server/runtime/index.ts) 的 `createRuntime` 装配，持有 Pi Durable、SQLite 会话、provider 配置与会话元数据。数据归属见 Data ownership，服务端各目录的一句话职责见 Server layout，一条用户消息的端到端路径见请求循环。

## Data ownership

A UI conversation maps to a Pi `Conversation`, not its storage-level `Session`. Entries and Pi documents own messages, active generation, tools, inbox, agent configuration, and usage. Application metadata owns titles, pinning, and archiving. Browser storage owns drafts and display preferences.

`src/shared/types.ts` is the browser protocol. It contains no credentials and imports no server runtime. Tool calls and results correlate by tool call ID. Submission request IDs provide retry idempotency; a network failure does not authorize creating a second input.

## Streaming

The server projects Pi state into complete `ConversationDetail` snapshots. A stream attaches with an initial snapshot, then publishes fresh views. Reconnection obtains a new baseline; it does not claim durable cursor replay. Slow or disconnected browser subscribers release their runtime watch. Stable message identity keeps Markdown caches and disclosure state attached to the same content.

## UI integration

`AnswerMarkdown` owns assistant Markdown rendering through Streamdown. Stable component functions read host capabilities through React context, so changes to file handlers do not replace every code block. `src/web/message-rendering` owns code (@pierre/diffs), table export/scrolling, image and diagram previews, and reasoning presentation. `ProcessTerminal` owns its command/output scrollports; it does not query inside a third-party terminal component. Work and tool expansion state is scoped to the current conversation.

The output components use scoped `--message-*` variables derived from ZCode and retain user font/theme preferences. DSH primitives still serve the application shell, settings, inspector and domain-specific interactions; their CSS does not style the inside of the new code viewer. File access, permissions, tool execution, questions and child-session actions remain host-owned. See [the rendering plan and acceptance record](zcode-markdown-rendering-plan.md).

The floating status card mirrors ZCode's `ConversationStatusPanel`: it sits in the conversation's right margin, collapses when that column is too narrow, and reserves horizontal room only while visible. Git data comes from bounded `git` reads (`workspace/git/worktree.ts`), not from the model transcript; the card also projects the conversation's Todo snapshot and live child sessions. Commit/push are explicit user actions over HTTP, and a failed Git command is reported inline instead of interrupting the chat stream. The commit dialog can draft a message from the selected diff with the conversation model, and the agent section keeps finished children behind a separate fold so long histories do not crowd the card.

## Model configuration

The runtime imports existing Pi configuration read-only and keeps project-specific overrides in its own data directory. Provider credentials are write-only through HTTP and are omitted from catalog responses. Deterministic demo models require explicit startup configuration and are never an error fallback.

## Server layout

`src/server/index.ts` starts the process, `app.ts` maps HTTP onto the `Runtime` interface in `contracts.ts`; the rest of the top level is a few cross-cutting modules (`codemode-policy.ts`, `runtime-errors.ts`) plus the feature directories:

| Directory | Owns |
| --- | --- |
| `runtime/` | `createRuntime` as a composition root plus the feature modules it assembles: `conversations`, `queue`, `interactions`, `team`, `automations`, `workspaces`, `presets`, `settings`, `plugins`, `subagent-settle` (settlement of background subagent delegations), with `core.ts` (metadata/detail/model policy) and `helpers.ts` (pure primitives) shared underneath |
| `conversation/` | Projection, compaction, execution/plan policy, work policy and its prompt asset, session titles, execution environment, per-conversation JSONL trajectory capture (every outbound request with first-token latency, plus side-call records) |
| `tools/` | Agent tool extensions (`shell/`, `search/`, `todo`, `goal`, `plan`, `research`, `skill`, `subagent`, `team`, `interaction`, `wetrack-analysis`), with `shared/` (shell output decoding) underneath |
| `agents/` | Built-in delegation profiles (`general-purpose`, the read-only `Explore`) and the child-model resolver the delegation tools share |
| `model/` | Provider catalog, model allowlist, deterministic demo model |
| `plugins/` | Marketplace manifest/source/store, plugin reference injection, page host bridge |
| `skills/` | `SkillStore` 与 `skills` 扩展：五个技能根的扫描、目录诊断与 `skill_save` 写边界 |
| `memory/` | 工作区记忆：section 策略（`policy.ts`）、纯文件协议存储（`store.ts`）与后台提取（`extraction.ts`） |
| `workspace/` | 工作区文件与根 AGENTS.md 指令读取；`git/` 持有分支/worktree/commit message |
| `mcp/` | `McpRegistry`：用户级 `mcp.json` 只读导入、连接管理与 `mcp__<server>__<tool>` 工具注册 |
| `automation/` | `automations` runtime 功能背后的日历对齐 recurrence 与调度器，每次 run 存入有上限、最新在前的历史 |
| `platform/` | 平台差异面（目录选择器等宿主集成） |
| `state/` | Global home, one-time migration, `app-state.json` |

Features receive their dependencies as arguments and never import the composition root. `runtime/index.ts` only wires state: it opens stores and the harness, installs tool extensions, creates each feature and returns the `Runtime`; cross-feature cycles (detail projection ↔ team catalog) are resolved with late-bound callbacks rather than module-level singletons.

## 请求循环

一条用户消息的端到端路径：浏览器带幂等 request id 提交 → `app.ts` 校验后调 `Runtime.submit`（[contracts.ts](../src/server/contracts.ts)）→ [runtime/conversations.ts](../src/server/runtime/conversations.ts) 经队列语义把输入交给 Pi conversation（[runtime/queue.ts](../src/server/runtime/queue.ts)：对排队中消息的编辑先 abort 原提交、再以派生 request id 重提，重试不会产生第二条输入）→ 每个请求由已安装扩展组装 section：`runtime-policy`（[work-policy.ts](../src/server/conversation/work-policy.ts)）注入 [runtime-core.md](../src/server/conversation/prompts/runtime-core.md) 行为政策、工作区根 AGENTS.md 与工作策略，memory、skills、plan、goal 等扩展各自贡献（安装顺序见 [runtime/index.ts](../src/server/runtime/index.ts)）→ 模型经 `model/` 目录与允许列表解析后流式调用（轨迹扩展同步把每次外发请求连同首 token 延迟记入会话内 JSONL，[trajectory.ts](../src/server/conversation/trajectory.ts)）→ 模型发出的工具调用经执行环境（[execution-env.ts](../src/server/conversation/execution-env.ts)：`NodeExecutionEnv`，macOS `workspaceWrite` 另包 `sandbox-exec`）与 `execution-policy` 的 plan/访问检查后执行，工具结果成为新条目 → `detailFromView`（[runtime/conversations.ts](../src/server/runtime/conversations.ts)）把 Pi 状态投影成完整 `ConversationDetail` 快照 → watch 监听器推送新快照，`app.ts` 的 SSE `/api/conversations/:id/events` 分帧下发 → 浏览器按稳定消息身份流式渲染（见 Streaming 与 UI integration）。

## Default runtime policy

The tool-free `runtime-policy` extension reads `src/server/conversation/prompts/runtime-core.md` once when the server module loads. Its `runtime-core` section is the stable behavior policy; `work-policy` adds the Host workspace and instructions for the actual direct or codemode-callable todo route. `goal-policy` is also rendered before a goal exists, so long-running human objectives can be recognized without requiring a magic word. The policy documentation links to the canonical runtime file instead of carrying a second copy.

`buildAgentChange` includes the policy for every Preset without changing its tool selection or replacing its instructions. `conversationCreated` ensures it is present after normal creation, child creation and a historical fork. Startup upgrades stored extension selections before `harness.resume()`, including children; a request checkpoint already prepared before an interruption retains its original model-visible data, and the next preparation uses the new sections. The resolved request and section changes remain recorded in Pi's system entries.

Goal creation is restricted to ownerless conversations; automatic continuation also requires callable goal read/update tools. The model-facing update schema exposes only completion and blocking; editing, pausing and resuming belong to the UI API. Plan narrows provider tools and the nested catalog, and checks current mode again at each executable tool boundary, including durable replay. Workspace mutation, arbitrary shell and external MCP calls are denied. Native bounded `list_files` and `search_files` retain read-only research. Entering Plan constrains existing owned descendants; child creation and reuse inherit the constraint. Leaving a parent does not automatically widen an existing child's own Plan mode, and already-running external effects are not rolled back. Read-only access and Plan remain separate policies.

The core policy also defines a code-investigation strategy: identify the target sub-repository from the defect's project/module, check `git log --grep` / `git log -S` as a change index before broad searches, trace from the entry point, grep signatures for line numbers, read narrow ranges, and stop when evidence is sufficient. It explicitly forbids substituting a tool-call retrospective for the defect analysis.

The core policy also teaches plugin creation: check the workspace's `plugins/` and catalog, load `builtin:plugin-creator`, write only source plus the local marketplace, and leave market registration/install/trial to the user. It states the Skill/Preset/Plugin distinction so a skill-only request is not silently upgraded to a plugin.

The runtime policy loads only the bound workspace's root `AGENTS.md` on each request, with source, scope, a content hash and a 32 KiB limit. Parent-directory instructions are not read, and nested instructions must be inspected for the file's scope. Code mode references directly offered schemas instead of duplicating them, budgets nested declarations at 1,200 SDK-estimated tokens and retains tool discovery. Compaction uses the same source/authorization rules for cached and serialized requests and validates the complete checkpoint structure before accepting it.

## Workspace memory

The `pi-web-memory` extension (`src/server/memory/policy.ts`) is part of the required policy set, installed before `execution-policy`. Its two sections self-disable while `settings.memoryEnabled` is false: `memory` teaches the file protocol only when the request offers `write`/`edit` (or Plan is active), and `memory-index` re-reads `MEMORY.md` on every request through the same bounded, no-follow, re-checked reader as the workspace root instructions. An index entry written by background extraction is therefore visible on the next request without a restart.

`src/server/memory/store.ts` owns the pure file protocol: the per-workspace root (`<dataDir>/memories/projects/<slug>-<hash16>/memory`), containment plus the 20 protected path segments, frontmatter/HTML-comment normalization with the 200-line / 25,000-character bound, and idempotent `originSessionId` stamping. Memory writes are not a second permission system. A qualified write/edit is allowed through Plan by the execution policy's exception predicate, through the `workspaceWrite` sandbox by an additional write root, and is absent entirely from read-only conversations because those have no `write`/`edit` tools. The extension's write/edit wraps stamp `node_type: memory` and `originSessionId`; `write` is stamped before execution, `edit` after a successful call (stamping is idempotent, so the read-back cannot corrupt a concurrent write).

Successful runs schedule extraction through `src/server/memory/extraction.ts` after `submission.wait()` settles as `done`; disabled memory and read-only conversations never schedule. Each conversation has one running and one newest-pending slot. The snapshot is the active transcript after an in-memory `EntryRecord.id` cursor with system messages removed (the main session's tool catalog must not leak into extraction) and token-trimmed to half the context window. Two ZCode skips run first: an assistant that already wrote inside the memory root, and a run without at least three words of user prose. The remaining run is a host-owned `Models.complete` loop of at most five turns with its own six-tool catalog (`read`, `list_files`, `search_files`, `write`, `edit`, `delete`; `delete` refuses `MEMORY.md`), a policy check before execution, the existing manifest, and the verbatim `Nothing to save.` contract. The extraction instruction is appended as the final user message, not folded into the system prompt: a real-model check with DeepSeek showed that a system-only instruction after an assistant tail is treated as a completed conversation and produces empty text. It never submits to the conversation; usage is accounted best-effort, failures leave the cursor unchanged, and `runtime.close()` aborts and drains bounded work. Set `PI_WEB_MEMORY_DEBUG=1` to log scheduling, skip reasons, each extraction turn, and tool outcomes.

## Stop semantics

The public stop operation uses Pi's native abort for the running turn and preserves queued input. The UI names this effect, and the runtime test asserts the remaining queue survives stop.

## Code mode and MCP

Pi 1.4.0 capabilities are composed when the runtime is created; its `checkpointWhen` document policy is how pi-web's conversation-scoped documents keep their stored history as deltas over the fork base. `createCodemodeExtension` plus `CodemodeSandbox` registers the `codemode` tool and its prompt section; `McpRegistry` imports the user-level Pi `mcp.json` read-only, connects enabled servers, and registers their tools on a synthetic `mcp` extension as `mcp__<server>__<tool>`.

The settings' code mode (`off` / `on` / `only`) is applied per conversation: Pi stores the selected extensions and tools in each conversation's agent, so the runtime recomputes idle ownerless conversations on startup and after an explicit switch. `only` writes `modelTools` so the model sees just `codemode`; nested script calls resolve among the enabled tools.

MCP credentials stay on the server: the browser protocol carries `McpView` (connection state, tool catalog, diagnostics) and never `env` or `headers`. Configuration changes take effect on restart; there is no live reload path. A broken file or a failed server is reported in the view and never blocks startup.

## Skills

`SkillStore` reads bundled `skills/`, the user-level `~/.pi-web/skills/` and `~/.agents/skills/` roots (read-only; the second is the cross-agent convention ZCode, pi and opencode also scan), enabled plugins that declare skill packages, and the selected workspace's `.pi-web/skills/` then `.agents/skills/` up to its repository root. The bundled tree ships `plugin-creator`, `skill-creator` and `statechart`. Files are authoritative; the catalog contains source-qualified IDs and SHA-256 versions. Invalid documents become catalog diagnostics without preventing other skills from loading. Skill names and requested resource paths are bounded and checked for traversal (`..`, drive letters, UNC). Skill roots, skill directories, `SKILL.md` files and supporting resources all follow symlinks, matching ZCode/pi/opencode, so a dotfiles repo or app bundle can be linked in; the accepted trade-off is that a skill's own links can point outside its tree. `skill_save` remains strict: it never writes through a symlinked directory or `SKILL.md`.

The `skills` extension adds `skill_list`, `skill_load`, `skill_save`, and `skill_validate`. Its section renders bounded metadata from the actual direct/codemode-callable tool set before each request, ZCode-shaped as `- <id>: <description> - <when_to_use> (file: <path>)`; past a 20 000-character budget each line degrades to id plus path. Loading returns the body only on demand; a bounded conversation document stores loaded references, so compaction/restart can direct a fresh load instead of relying on old transcript text. New skills are visible on the next request without restarting the service, and the section names any Skill that appeared after the text the model already received.

Saves are confined to workspace `.agents/skills/`, serialize per target, require an expected content hash for changed existing files, and replace only `SKILL.md` atomically. Optional resources are handled by existing filesystem tools. Writes retain Pi's unsafe replay policy: after an interrupted call, inspect the file/version before deciding whether to retry. Both runtime tool selection and an execution-time access/plan check guard `skill_save`; Preset allowlists are not widened. Catalog/read/validation HTTP endpoints only operate on known workspaces and do not expose a write API.

## Plugins

The plugin market is an application-owned store under `<dataDir>/plugins/`, separate from `app-state.json`: `marketplaces.json` plus a normalized catalog cache per marketplace, `installed.json`, immutable package copies under `cache/<marketplace>/<name>/<version>`, per-plugin private data, and a staging area. `src/server/plugins/manifest.ts` accepts the `.pi-plugin` / `.zcode-plugin` / `.claude-plugin` manifest subset; `plugins/source.ts` materializes a marketplace-relative directory, a checksummed HTTPS zip, a GitHub zipball, or an HTTPS `git clone --depth 1` (with a built-in safe ZIP reader); `plugins/store.ts` serializes all mutations, stages every package, activates with rename plus a backup per plugin, writes `installed.json` once after the whole dependency closure succeeds, and rolls back otherwise. Install and update run in the background and appear in `overview().operations`; `GET /api/plugins/events` pushes a fresh overview after every mutation, and the settings panel keeps a slow poll as a fallback.

Enabled plugins project two capabilities. Skills become read-only `SkillStore` roots with ids `<pluginId>:<skillName>` and `source: 'plugin'`; they are re-read on each catalog request. MCP servers are merged into `McpRegistry` beside the user-level `mcp.json`, named `plugin_<plugin>_<server>`, with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expanded, the plugin directory as `cwd`, and `codemode` exposure unless the manifest says otherwise. Every capability-changing mutation calls `PluginStore`'s change listener: the runtime awaits `McpRegistry.reload()`, then reinstalls the `codemode` namespaces, `mcp` tools, `tool_search` (only when a deferred tool exists), and finally `execution-policy`, which must always capture the latest tool snapshot. Old MCP connections stay open for a 10s grace period so in-flight calls finish; failures isolate to one server's `status: 'error'`. `ui.surfaces` are validated and shown but not rendered until P2. Plugin packages never execute JavaScript in the host: the only execution surface is the declared MCP subprocess.

## 接缝

扩展沿两条缝接入会话：扩展注册与 section/工具注册。扩展注册集中在 [runtime/index.ts](../src/server/runtime/index.ts) 的 registry——按固定顺序 `install` 工具扩展（`coding-tools`、`research-tools`、todo/goal/plan/skill/subagent/team/interaction 等）与 section 型扩展（`runtime-policy`、memory、compaction），`execution-policy` 必须最后安装以捕获最新工具快照，MCP 工具集每次变更后整组重装（机制见 Code mode and MCP）。section 是提示词侧的缝：每个扩展按请求渲染自己的 section（清单与注入条件见 [section-catalog.md](section-catalog.md)），工具目录同理见 [tool-catalog.md](tool-catalog.md)。插件是应用层的缝：技能包成为只读 `SkillStore` 根、MCP server 并入 `McpRegistry`（见 Plugins）。技能根的扫描顺序与写边界见 Skills。执行层还有一条环境缝：远程或非 `node:local` 环境下 shell/pwsh 回退 Pi 平台工具模型（见 Platforms 与检索与 Shell 子系统页）。

## Platforms

The server runs on macOS, Linux and Windows. The platform-sensitive surface is deliberately small and split by capability; the complete Windows matrix and machine-check list live in [docs/windows-support.md](windows-support.md).

- **Access modes.** `workspaceWrite` is macOS-only (`sandbox-exec` with a per-workspace profile); elsewhere `createExecutionEnv` rejects it and `capabilities()` advertises only `readOnly` and `fullAccess`, which both use Pi's `NodeExecutionEnv` directly. Stored conversations, defaults and Agent Presets brought over from macOS with `accessMode: workspaceWrite` must be changed before use on Windows.
- **Command execution.** Pi's `NodeExecutionEnv` runs commands through a shell; on Windows it first looks for Git Bash under `ProgramFiles\Git\bin\bash.exe` and `ProgramFiles(x86)\Git\bin\bash.exe`, then accepts any `bash.exe` found by `where`. It reports `shell_unavailable` when none exists. The project registers its own `coding-tools` extension rather than Pi's `CodingTools`: `read`, `write` and `edit` are Pi's, and the shell tool is platform-split — `bash` elsewhere, a native `pwsh` tool on Windows. The `pwsh` tool keeps Pi's `createPowerShellTool` execution model for remote or otherwise non-local environments, while local Windows commands run through the project's shared shell runner with forced UTF-8 output, legacy code-page decoding, output bounds and automatic backgrounding.
- **Git branches.** The server shells out to `git.exe` with `execFile` for local branch listing, `git switch --no-guess` and `git switch --no-guess -c`; stdout is CRLF-normalized and branch rows are NUL-delimited. The browser switcher and the macOS test/demo flow are implemented. Windows requires `git.exe` on the server process PATH; a working Git Bash for the `bash` tool does not imply that. Git being absent and a directory not being a repository currently map to the same `not-a-repository` issue.
- **Directory picker.** macOS uses the JXA `NSOpenPanel` script, Linux tries `zenity` then `kdialog`, and Windows runs a koffi-backed `IFileOpenDialog` in a child process so a COM fault cannot take the host down. The in-app directory browser is the intended fallback, but the Windows error currently maps to a generic 500 and does not trigger the fallback; the in-app browser itself rejects UNC/extended paths and has no drive entry. The Windows picker path is not covered by Windows automation.
- **Skills and prompt assets.** `SkillStore` resolves the bundled `skills/` directory, user-level `~/.pi-web/skills/` and `~/.agents/skills/`, and workspace `.agents/skills/` and `.pi-web/skills/` through `node:path`, `realpath` and `stat`/`lstat`; directories follow symlinks while files stay symlink-free. Its HTTP resource protocol uses `/` and rejects backslashes, drive letters, UNC and traversal; skill names reject Windows reserved device names, and frontmatter accepts BOM/CRLF. Writes use a same-directory temporary file and `rename`; Windows ACL/symlink-reparse behavior still needs real-machine verification. The default `runtime-policy` reads `src/server/conversation/prompts/runtime-core.md` from a file URL at module load, so packaged distributions must ship that prompt next to the server module.
- **Desktop integration.** "Open config file" uses `open`, `xdg-open`, or `cmd /c start` by platform; the Windows `cmd` path can mis-handle `%`, `&` or `^` in the path. Graceful shutdown listens for SIGINT and SIGTERM: Ctrl+C works on Windows, while closing the console or `taskkill` terminates the process without running `app.shutdown()`/`runtime.close()`; SQLite recovers from its WAL on the next start.
- **Verification.** The 2026-10-20 macOS baseline passes `npm run typecheck`, 20 test files / 241 Vitest cases and `npm run build`. That is not Windows evidence. Windows toolchain prerequisites (Node, Git for Windows, optional native packages, `node:sqlite`), limitations (no `workspaceWrite`, incomplete graceful shutdown, ACL-only security gap, non-portable tests and known path defects) and the Windows machine-check list live in [docs/windows-support.md](windows-support.md).

## 扩展点阅读顺序

改不同对象前先读对应的 subsystems 现状页（`docs/subsystems/`，一主题一页），再动 `src/`：

- todo 工具与任务提醒 → [todo](subsystems/todo.md)
- 计划模式的工具收窄与拦截 → [plan-mode](subsystems/plan-mode.md)
- 提问/等待类交互（ask user question、等待应答） → [interactions](subsystems/interactions.md)
- goal 的创建约束与自动续跑 → [goal](subsystems/goal.md)
- 子智能体委派、内置档案与结算 → [subagent](subsystems/subagent.md)
- team 会话与子会话目录 → [team](subsystems/team.md)
- 上下文压缩三层策略 → [compaction](subsystems/compaction.md)
- 请求轨迹与旁路调用采集 → [trajectory](subsystems/trajectory.md)
- 前端消息渲染与状态机 → [rendering](subsystems/rendering.md)
- 工作区记忆协议与后台提取 → [memory](subsystems/memory.md)
- 插件市场、MCP 合并与技能根投影 → [plugins](subsystems/plugins.md)
- 检索/shell 工具语义与过滤规则 → [search-and-shell](subsystems/search-and-shell.md)

决策理由与未决项在 [spec.md](spec.md)；评审时强制执行的规则在 `docs/defensive-patterns/`；操作指南在 `docs/cookbook/`。
