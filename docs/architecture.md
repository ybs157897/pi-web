# Architecture

The browser renders host DTOs with ZCode-aligned message components and a shell using the pinned DSH theme. The HTTP server owns input validation and streaming transport. The runtime owns Pi Durable, its SQLite session, provider configuration, and conversation metadata.

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

`src/server/index.ts` starts the process, `app.ts` maps HTTP onto the `Runtime` interface in `contracts.ts`, and everything else is a feature directory:

| Directory | Owns |
| --- | --- |
| `runtime/` | `createRuntime` as a composition root plus the feature modules it assembles: `conversations`, `queue`, `interactions`, `team`, `automations`, `workspaces`, `presets`, `settings`, `plugins`, with `core.ts` (metadata/detail/model policy) and `helpers.ts` (pure primitives) shared underneath |
| `conversation/` | Projection, compaction, execution/plan policy, work policy and its prompt asset, session titles, execution environment |
| `tools/` | Agent tool extensions (`shell/`, `search/`, `todo`, `goal`, `plan`, `research`, `skill`, `subagent`, `team`) |
| `model/` | Provider catalog, model allowlist, deterministic demo model |
| `plugins/` | Marketplace manifest/source/store, plugin reference injection, page host bridge |
| `skills/`, `memory/`, `workspace/`, `mcp/`, `automation/`, `platform/` | The feature named by the directory (`workspace/git/` holds branches/worktree/commit-message) |
| `state/` | Global home, one-time migration, `app-state.json` |

Features receive their dependencies as arguments and never import the composition root. `runtime/index.ts` only wires state: it opens stores and the harness, installs tool extensions, creates each feature and returns the `Runtime`; cross-feature cycles (detail projection ↔ team catalog) are resolved with late-bound callbacks rather than module-level singletons.

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

Successful runs schedule extraction through `src/server/memory/extraction.ts` after `submission.wait()` settles as `done`; disabled memory and read-only conversations never schedule. Each conversation has one running and one newest-pending slot. The snapshot is the active transcript after an in-memory `EntryRecord.id` cursor with system messages removed (the main session's tool catalog must not leak into extraction) and token-trimmed to half the context window. Two ZCode skips run first: an assistant that already wrote inside the memory root, and a run without at least three words of user prose. The remaining run is a host-owned `Models.complete` loop of at most five turns with its own five-tool catalog (`read`, `list_files`, `search_files`, `write`, `edit`), a policy check before execution, the existing manifest, and the verbatim `Nothing to save.` contract. The extraction instruction is appended as the final user message, not folded into the system prompt: a real-model check with DeepSeek showed that a system-only instruction after an assistant tail is treated as a completed conversation and produces empty text. It never submits to the conversation; usage is accounted best-effort, failures leave the cursor unchanged, and `runtime.close()` aborts and drains bounded work. Set `PI_WEB_MEMORY_DEBUG=1` to log scheduling, skip reasons, each extraction turn, and tool outcomes.

## Stop semantics

The public stop operation uses Pi's native abort for the running turn and preserves queued input. The UI names this effect, and the runtime test asserts the remaining queue survives stop.

## Code mode and MCP

Pi 1.3.0 capabilities are composed when the runtime is created. `createCodemodeExtension` plus `CodemodeSandbox` registers the `codemode` tool and its prompt section; `McpRegistry` imports the user-level Pi `mcp.json` read-only, connects enabled servers, and registers their tools on a synthetic `mcp` extension as `mcp__<server>__<tool>`.

The settings' code mode (`off` / `on` / `only`) is applied per conversation: Pi stores the selected extensions and tools in each conversation's agent, so the runtime recomputes idle ownerless conversations on startup and after an explicit switch. `only` writes `modelTools` so the model sees just `codemode`; nested script calls resolve among the enabled tools.

MCP credentials stay on the server: the browser protocol carries `McpView` (connection state, tool catalog, diagnostics) and never `env` or `headers`. Configuration changes take effect on restart; there is no live reload path. A broken file or a failed server is reported in the view and never blocks startup.

## Skills

`SkillStore` reads bundled `skills/` plus the selected workspace's `.agents/skills/` and `.pi-web/skills/`. Files are authoritative; the catalog contains source-qualified IDs and SHA-256 versions. Invalid documents become catalog diagnostics without preventing other skills from loading. Skill names and supporting-resource paths are bounded and checked for traversal and symlinks.

The `skills` extension adds `skill_list`, `skill_load`, `skill_save`, and `skill_validate`. Its section renders bounded metadata from the actual direct/codemode-callable tool set before each request. Loading returns the body only on demand; a bounded conversation document stores loaded references, so compaction/restart can direct a fresh load instead of relying on old transcript text. New skills are visible on the next request without restarting the service.

Saves are confined to workspace `.agents/skills/`, serialize per target, require an expected content hash for changed existing files, and replace only `SKILL.md` atomically. Optional resources are handled by existing filesystem tools. Writes retain Pi's unsafe replay policy: after an interrupted call, inspect the file/version before deciding whether to retry. Both runtime tool selection and an execution-time access/plan check guard `skill_save`; Preset allowlists are not widened. Catalog/read/validation HTTP endpoints only operate on known workspaces and do not expose a write API.

## Plugins

The plugin market is an application-owned store under `<dataDir>/plugins/`, separate from `app-state.json`: `marketplaces.json` plus a normalized catalog cache per marketplace, `installed.json`, immutable package copies under `cache/<marketplace>/<name>/<version>`, per-plugin private data, and a staging area. `src/server/plugins/manifest.ts` accepts the `.pi-plugin` / `.zcode-plugin` / `.claude-plugin` manifest subset; `plugins/source.ts` materializes a marketplace-relative directory, a checksummed HTTPS zip, a GitHub zipball, or an HTTPS `git clone --depth 1` (with a built-in safe ZIP reader); `plugins/store.ts` serializes all mutations, stages every package, activates with rename plus a backup per plugin, writes `installed.json` once after the whole dependency closure succeeds, and rolls back otherwise. Install and update run in the background and appear in `overview().operations`; `GET /api/plugins/events` pushes a fresh overview after every mutation, and the settings panel keeps a slow poll as a fallback.

Enabled plugins project two capabilities. Skills become read-only `SkillStore` roots with ids `<pluginId>:<skillName>` and `source: 'plugin'`; they are re-read on each catalog request. MCP servers are merged into `McpRegistry` beside the user-level `mcp.json`, named `plugin_<plugin>_<server>`, with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expanded, the plugin directory as `cwd`, and `codemode` exposure unless the manifest says otherwise. Every capability-changing mutation calls `PluginStore`'s change listener: the runtime awaits `McpRegistry.reload()`, then reinstalls the `codemode` namespaces, `mcp` tools, `tool_search` (only when a deferred tool exists), and finally `execution-policy`, which must always capture the latest tool snapshot. Old MCP connections stay open for a 10s grace period so in-flight calls finish; failures isolate to one server's `status: 'error'`. `ui.surfaces` are validated and shown but not rendered until P2. Plugin packages never execute JavaScript in the host: the only execution surface is the declared MCP subprocess.

## Platforms

The server runs on macOS, Linux and Windows. The platform-sensitive surface is deliberately small and split by capability; the complete Windows matrix and machine-check list live in [docs/windows-support.md](windows-support.md).

- **Access modes.** `workspaceWrite` is macOS-only (`sandbox-exec` with a per-workspace profile); elsewhere `createExecutionEnv` rejects it and `capabilities()` advertises only `readOnly` and `fullAccess`, which both use Pi's `NodeExecutionEnv` directly. Stored conversations, defaults and Agent Presets brought over from macOS with `accessMode: workspaceWrite` must be changed before use on Windows.
- **Command execution.** Pi's `NodeExecutionEnv` runs commands through a shell; on Windows it first looks for Git Bash under `ProgramFiles\Git\bin\bash.exe` and `ProgramFiles(x86)\Git\bin\bash.exe`, then accepts any `bash.exe` found by `where`. It reports `shell_unavailable` when none exists. The project registers Pi's `CodingTools` (`read`, `write`, `edit`, `bash`) and does not register `createPowerShellTool()`, so Windows has no native-shell fallback.
- **Git branches.** The server shells out to `git.exe` with `execFile` for local branch listing, `git switch --no-guess` and `git switch --no-guess -c`; stdout is CRLF-normalized and branch rows are NUL-delimited. The browser switcher and the macOS test/demo flow are implemented. Windows requires `git.exe` on the server process PATH; a working Git Bash for the `bash` tool does not imply that. Git being absent and a directory not being a repository currently map to the same `not-a-repository` issue.
- **Directory picker.** macOS uses the JXA `NSOpenPanel` script, Linux tries `zenity` then `kdialog`, and Windows runs a koffi-backed `IFileOpenDialog` in a child process so a COM fault cannot take the host down. The in-app directory browser is the intended fallback, but the Windows error currently maps to a generic 500 and does not trigger the fallback; the in-app browser itself rejects UNC/extended paths and has no drive entry. The Windows picker path is not covered by Windows automation.
- **Skills and prompt assets.** `SkillStore` resolves the bundled `skills/` directory and workspace `.agents/skills/` and `.pi-web/skills/` through `node:path`, `realpath` and `lstat`. Its HTTP resource protocol uses `/` and rejects backslashes, drive letters, UNC and traversal; skill names reject Windows reserved device names, and frontmatter accepts BOM/CRLF. Writes use a same-directory temporary file and `rename`; Windows ACL/symlink-reparse behavior still needs real-machine verification. The default `runtime-policy` reads `src/server/conversation/prompts/runtime-core.md` from a file URL at module load, so packaged distributions must ship that prompt next to the server module.
- **Desktop integration.** "Open config file" uses `open`, `xdg-open`, or `cmd /c start` by platform; the Windows `cmd` path can mis-handle `%`, `&` or `^` in the path. Graceful shutdown listens for SIGINT and SIGTERM: Ctrl+C works on Windows, while closing the console or `taskkill` terminates the process without running `app.shutdown()`/`runtime.close()`; SQLite recovers from its WAL on the next start.
- **Verification.** The 2026-10-20 macOS baseline passes `npm run typecheck`, 20 test files / 241 Vitest cases and `npm run build`. That is not Windows evidence. Windows toolchain prerequisites (Node, Git for Windows, optional native packages, `node:sqlite`), limitations (no `workspaceWrite`, incomplete graceful shutdown, ACL-only security gap, non-portable tests and known path defects) and the Windows machine-check list live in [docs/windows-support.md](windows-support.md).
