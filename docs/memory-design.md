# 项目记忆系统落地设计（逐行对照 ZCode 实现）

状态：已实施（2026-10-26，Phase 1–3）。落地代码：`src/server/memory.ts`、`src/server/memory-policy.ts`、`src/server/memory-extraction.ts`，以及 `runtime.ts` / `execution-env.ts` / `execution-policy.ts` 的装配；测试见 `tests/memory*.test.ts`、`tests/runtime-policy.test.ts`、`tests/execution-policy.test.ts`。本文保留设计时的行号引用，代码位置以文件为准；实现中与本文的差异：① 索引读取复用有界读取；② 提取快照会剥掉主会话的 system 消息（否则会带上主会话的工具目录）；③ 提取指令改为末尾 user 消息（真实模型验收发现 system-only 指令会被模型视为对话已结束，返回空文本）；④ workspaceWrite 的可写根会按真实路径规范化，避免 macOS `/var` 符号链接下的嵌套目录误拒。

参照系文件（ZCode 仓内，下文以 `core/` = `apps/zcode-cli/packages/core/src/`）：

| 职责 | 文件 |
| --- | --- |
| 纯逻辑（root/路径安全/盖章/索引规范化/调度/受限循环） | `core/src/memory/`（9 文件 + `recall/` 5 文件，约 1300 行） |
| system 注入 | `core/src/context/sections/memory.ts`、`context/builder.ts:152-161` |
| 索引注入（`# agentsMd` 块） | `core/src/context/sections/request-user-context.ts`、`runtime/methods/context.ts:187-216` |
| 前台写入放行 | `core/src/tool/executor/memory-file-permission.ts`、`tool/executor/permission-flow.ts:113-120` |
| 盖章 | `core/src/memory/origin-session.ts`、`tool/handlers/write.ts:118-137`、`edit.ts:501-520` |
| 提取调度 | `core/src/runtime/methods/turn.ts:947-953`、`runtime/helpers/project-memory-extraction.ts:32-169`、`memory/extraction.ts` |
| 会话关停 | `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts:288-333`、`core/src/runtime/agent-runtime.ts:387-396` |
| 行为合同 | `apps/zcode-cli/docs/design/v2/memory/README.md`（spec）、`docs/analysis/zcode-memory-system-implementation.md` |

---

## 1. ZCode 机制地图（逐行分析结论汇总）

### 1.1 存储与身份

- root = `<cliStorageRoot>/memories/projects/<slug>-<hash16>/memory`（`core/src/memory/project-root.ts:10-24`）。
  - keySource = `workspaceIdentity?.trim()` 或（win32 下先转小写的）`resolve(workspacePath)`；
  - `hash16 = sha256(keySource).hex.slice(0,16)`；slug = identity 时恒 `"project"`，否则 `sanitizeProjectSlug(basename(path))`：小写 → 非 `[a-z0-9._-]` 连续段折叠为 `-` → 去首尾 `-` → 截 48 字符 → 空则 `"project"`（`:26-33`）。
- 目录预创建 best-effort：mkdir 失败仅 debug 日志、永不阻断（`memory/directory.ts:8-26`）。
- 文件即记忆，不建表。MEMORY.md 索引无 frontmatter；事实文件 frontmatter：`name` / `description` / `metadata.type ∈ {user,feedback,project,reference}`；写入边界补 `metadata.node_type: memory`（强制 metadata 首键）+ `metadata.originSessionId`（幂等：已存在非空值则原样返回）。

### 1.2 路径安全（`core/src/memory/memory-file-path.ts`）

两级判定：

- **contained**（`resolveContainedMemoryFilePath`，`:28-42`）：`resolveWorkspacePath(operation:"write")` 归一后 `relative(rootDir, resolved)` 满足：非空、≠ `..`、不以 `../` 或 `..\` 开头、非绝对（`isContainedRelativePath`，`:69-77`，Windows 盘符场景用 `isAbsolute` 兜底）。
- **safe**（`resolveSafeMemoryFilePath`，`:44-56`）：contained 且相对路径任一段不命中敏感段。分隔符 `/`、`\` 都切（`:63-67`）。

敏感段清单（`:5-26`，20 项，逐字）：

```
.git, hooks, .husky, .githooks, node_modules, .vscode, .idea, head, config,
objects, refs, .claude, .zcode, skills, commands, agents, .cargo, .devcontainer,
.yarn, .mvn
```

段名归一化（`normalizeSensitiveSegment`，`:79-84`）：小写 → 剥 6 组不可见/方向控制字符（U+200C–200F、U+202A–202E、U+206A–206F、U+FEFF）→ 取首个 `:` 前部分（防 Windows ADS）→ 剥尾部 `.` 与空格（防 Windows 尾缀等价）。

### 1.3 索引规范化（`core/src/memory/index-content.ts`）

- 管线：剥文件头 frontmatter（`/^---\s*\n[\s\S]*?---\s*\n?/u`）→ 剥 **顶层** HTML 注释（marked Lexer 只删顶层 `html` token，代码块/引用块内的保留，`gfm: false`）→ trim → 截断。
- 截断阈值（严格大于判定）：**200 行 / 25,000 个 JS 字符**；先按行截，仍超字符则取 `lastIndexOf("\n", 25000)` 的最后一个完整换行切。
- WARNING 尾注固定句式：`> WARNING: MEMORY.md is <sizeDescription>. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`（sizeDescription 三形态：仅字符超 / 仅行超 / 双超）。

### 1.4 注入

- **`# Memory` system section**（`context/sections/memory.ts:29-61`）：启用即恒注入（目录空也在），位于 Session Guidance 之后、EnvInfo 之前的 dynamic system block；文案含 root 声明（"directory already exists — write directly, do not mkdir"）、frontmatter 模板、四类型定义、`[[name]]` 悬空链接合法、default-index 分支追加 MEMORY.md 指针行维护指令、"不该存"清单、`<system-reminder>` 召回内容定位。
- **MEMORY.md 索引**（`request-user-context.ts:37-86`）：default-index 分支、会话初始化读一次并**冻结**（`runtime/methods/context.ts:44` 的一次性守卫 + `rebuildContextPrefix` 复用缓存），非空（规范化后）才注入；注入到首条 user message 前的 `# agentsMd` 聚合块（`Contents of <root>/MEMORY.md (user's auto-memory, persists across conversations):`），provider 投影为 `<system-reminder>` user 消息并计入缓存前缀。
- **readFileState 种子**（`context.ts:187-216`）：索引注入时把 MEMORY.md 以"严格全量读"条目种进 readFileState；被截断的索引标记 `isPartialView: true`——截断索引不满足 read-before-write，模型必须先 Read 才能改写 MEMORY.md。

### 1.5 写入放行（`tool/executor/memory-file-permission.ts`，86 行）

- 位置：权限链尾部（`permission-flow.ts:113-120`），在规则引擎与 PreToolUse hook 决策**之后**、allow/deny/ask 分派之前。
- 判定：工具名 ∈ {Write, Edit} + `file_path` 非空 + contained + `.md` 结尾 + 无敏感段。
- 改写：`{...decision, allowed: true, decision: "allow", escalated: false, reason: "Memory Markdown writes are allowed", ruleId: "memory.file.markdown"}`。
- **保留分支**（`preservesExistingPermissionDecision`）：显式 deny 保留——**唯一例外 `ruleId === "mode.plan.nonReadOnly"`（plan 模式拒绝被 memory 放行凿穿，即"合格 Memory 写入先于 plan-mode block"）**；`alwaysAsk` 恒保留；`rule.project.ask` / `hook.PreToolUse.ask` 的 ask 保留；其余 ask 被改写为 allow。

### 1.6 盖章（`core/src/memory/origin-session.ts:8-51`）

纯字符串变换（无 IO）：frontmatter 正则（BOM 可选 + `---` + 捕获行尾风格）→ `yaml` 的 `parseDocument`（AST 保注释/顺序，语法错原样返回）→ `metadata` 缺则建、非 map 原样返回 → 已有非空 `originSessionId` 原样返回（幂等）→ `delete("node_type")` + `unshift` 到 metadata 首位 + `set("originSessionId", sessionId)` → 序列化后按 opening 的 CRLF/LF 还原行尾，正文 `content.slice(match[0].length)` 原样拼回。调用点在 write/edit handler 落盘前（`write.ts:118-137`、`edit.ts:501-520`）。

### 1.7 后台提取（`memory/extraction.ts` 301 行 + `runtime/helpers/project-memory-extraction.ts`）

- **触发**：成功 Main turn 收尾（`turn.ts:947-953`），fire-and-forget；前置守卫顺序：`shuttingDown` → `memory.extractionEnabled === false` → root 未启用 → remote workspace → 缺 sessionStore/fileSystemPort → 无 boundary message id。
- **快照**：调度瞬间冻结（provider entries + durable messages 切到 boundary，含活跃分支筛选）；boundary 被 revert 掉 → acquisition error，静默放弃。
- **调度器**（`extraction.ts:85-179`）：单 running 槽 + 单 latestPending 槽（覆盖式 coalescing，schedule 到置位 running 无 await、无竞态窗口）；cursor 为内存中的 durable message UUID——**success / no-op / skip 推进，error / aborted / execute 抛异常不推进**（at-least-once）；shutdown 丢 pending + abort 在飞的。
- **运行决策**（`:68-83`，skip 条件按优先级）：
  1. direct-memory-write：cursor 之后 assistant 消息的 Write/Edit tool part（**不看执行成败、不要求 .md、只要求 contained**）→ skip（cursor 丢失时不回扫）；
  2. no-user-prose：无非 synthetic、非 model-only user 消息的独立 text block 且 `split(/\s+/).filter(Boolean).length >= 3`（`MINIMUM_USER_WORDS = 3`）→ skip（cursor 丢失时回扫全史——两者不对称是刻意的）。
- **执行**：`runMemoryAgentLoop`（`memory-agent-loop.ts`）——冻结上下文 + Main 完整工具目录（权限只在执行边界收窄），每轮请求前 abort 检查 + 媒体投影重放；工具策略判定顺序：catalog miss（`<tool_use_error>Error: No such tool available: <name></tool_use_error>`）→ Agent/`mcp__*`/network 边界拒 → Write/Edit（.md + safe）→ Bash（只读分类器 或 窄化 rm：恰一条命令、`argv[0]==="rm"`、无重定向/env 前缀、无 `-r/-R/--recursive`、无通配符、绝对路径 .md、contained、路径数>0）→ Read/Grep/Glob 白名单 → 兜底拒；拒绝以 `isError` tool result 回流下一轮（固定文案：Bash 版 `Only read-only shell commands and rm with all paths inside <rootDir> are permitted in this context (...)`；通用版 `only Read, Grep, Glob, read-only Bash, and Edit/Write within <rootDir> are allowed`）。轮次上限 `EXTRACTION_MAX_TURNS = 5`（第 5 轮 toolCalls 仍执行，不发第 6 次请求）。
- **提取 prompt**（`extraction.ts:42-66`）：开头 `You are now acting as the memory extraction subagent. Analyze the most recent ~N messages above...`；可用工具清单；两轮并行读写策略；"必须只用最近 ~N 条消息、禁止再验证"；manifest 段（非空时 `## Existing memory files` + `- [type] filename (ISO8601): description` 行 + "Check this list before writing..."）；`If nothing is worth saving, output only 'Nothing to save.' Do not explain why.`；用户显式要求记/忘 → 立即保存/删除；"格式见上下文中的 Memory 节"。**"Nothing to save." 是逐字合同，scheduler 不解析它推导状态。**
- **manifest**（`recall/manifest.ts`）：递归扫 root 下小写 `.md`、排除 `MEMORY.md`、每文件只读前 30 行取 frontmatter（description / metadata.type，YAML 错误按无 metadata 处理）、mtime 降序、上限 200 文件。
- **辅助模型档位**（`model/auxiliary-model-options.ts:3-13`）：所有 memory agent 调用统一 `reasoningLevel = 模型最低公开档`、`maxOutputTokens = min(5000, 模型上限)`。
- **关停**：`beginShutdown()`（拒新调度 + `scheduler.shutdown()` abort）→ `drainMemoryExtractions(60_000)` 有界等待 → 关 session 资源。

### 1.8 检索分支与其余（pi-web v1 不做，仅备查）

`default-index` 为编译期常量激活的唯一分支（`project-memory-retrieval-branch.ts:4` 恒 `false`）；semantic-recall（selector ≤5 文件 / 单文件 200 行 4096 字节 / 会话 61,440 字符预算）与 Dream（24h/10min/5-transcript 三重门 + mtime+PID 锁）、`memory_update`、custom agent 三 scope 全部代码在但未激活/未接线。Settings viewer（只读三级导航、单文件 5 MiB 上限、错误码 `PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED` / `PROJECT_MEMORY_FILE_CHANGED`）已实现，属 Phase 4。

---

## 2. pi-web 挂点事实（逐行核对结论）

### 2.1 扩展体系（pi-durable 1.3.0）

- Extension 形状（`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:304-314`）：`{ name, tools?, sections?, hooks?, wraps?, tasks? }`；`section(key, render)` 的 render 返回 `undefined` 即省略（transcript 里该 key 曾 shown 时产生 `sections:{key:null}` 删除 patch；文本稳定则零 entry，最小 patch机制）；section key 校验 `/^[a-z][a-z0-9_-]*$/` 且 `instructions` 保留。
- **wrap 叠加顺序**（`dist/harness/agent.js:160-264` 的 `resolveAgent` + `applyWrap`）：按 agent.extensions 顺序逐个应用到共享 map——**排前面的扩展 wrap 先应用（内层），排后面的 wrap 在外层（调用时先执行）**；wrap 函数抛错或改名 → 该工具/section 被整体移除并上报；目标不存在时 no-op。
- 工具执行 API（`types.d.ts:153-233`）：`execute(args, api, context)`；`api.env` 是会话 ExecutionEnv；`api.snapshot(DOC, id, ctx)` 读会话文档。**pi-durable 没有任何权限/审批链**（`executionMode` 仅 parallel/sequential）——这一点决定了 §3.2 的"放行"改写。
- 主工具是原生 CodingTools：`write` 参数 **`{path, content}`**、`edit` 参数 **`{path, edits: [{oldText, newText}]}`**（`dist/tools/write.d.ts`、`edit.d.ts`；注意字段名与 ZCode 的 `file_path` 不同）。

### 2.2 装配与顺序（`src/server/runtime.ts`）

- registry 安装序列 `runtime.ts:536-582`：work-policy(537) → compaction(538) → CodingTools(539) → ResearchTools(540) → … → **`createExecutionPolicyExtension(registry.snapshot().installed())`(582，最后)**——它枚举当时已安装的全部工具名与 section key 生成 wraps。**memory 扩展必须插在 582 之前安装**，其 section 才会被 execution-policy 的 plan 过滤自动覆盖。
- `ensureRuntimePolicy`（`:159-175`）：必选扩展 `[WORK_POLICY, COMPACTION, EXECUTION_POLICY]` 注入 `pi.agent.extensions`，新会话（`conversationCreated`，`:618`）与存量会话启动补装（`:2287-2292`）两条路径。
- `buildAgentChange`（`:908-989`）：`extensionNames = [WORK_POLICY, COMPACTION, EXECUTION_POLICY, ...(preset ? preset.extensions : installed.map(e => e.name))]`（`:920`）——**必选三件套排在最前**，决定 wrap 内外层顺序；`readOnly` 按 `READ_ONLY_TOOLS`（`:156-157`）裁工具（write/edit 不在集合内 → readOnly 会话**物理上没有** write/edit）。
- 会话 env：`Harness.open({ env: async target => createExecutionEnv(selectedWorkspace.path, selectedMode) })`（`:611-616`）——env.cwd 即会话工作区 canonical path。
- 提交链路：`submitWithReferences`（`:1134-1180`）→ `conversation.submit({type:'input',...})` 持久接纳，HTTP 202 即返；`request.wait(CTX)` 的返回是 `SettledSubmissionRecord`（`done | unanswered`）。
- transcript 读取：`conversation.context(CTX)` → `ContextView { head, entries, contributions, messages }`；entries 为 EntryRecord[]（有 id），messages 为 pi-ai Message[]（user / assistant（含 toolCall block）/ toolResult 独立 role）。
- 后台生成两个现成范式：会话标题（`scheduleTitleRevision`，`:1195-1233`——fire-and-forget + per-conversation AbortController + `modelRuntime.models.completeSimple` + 独立 sessionId + 静默失败）；compaction（`beforeCompact` hook 内 `api.models.completeSimple` + memo 失败缓存 + UsageDoc best-effort 记账 + 严格输出校验，`src/server/compaction.ts:643-710`）。
- 关停：`runtime.close()`（`:2365-2386`）先同步关 automationScheduler，再 `harness.close(CTX)` → `Promise.allSettled([...automationTasks])` → codemode/mcp。
- 设置：`appState.snapshot().settings` 五处联动（`app-state.ts:21-41` schema + `:163-181` 默认值、`src/shared/types.ts:94-125`、`app.ts:109-119` PATCH schema、`runtime.ts:1696-1747` updateSettings、`SettingsDialog.tsx` SettingRow）。

### 2.3 执行环境（`src/server/execution-env.ts`，本次设计的关键约束）

- `fullAccess` → `NodeExecutionEnv`：写无限制。
- **`workspaceWrite` → `WorkspaceWriteExecutionEnv`（`:40-110`）：`writeDenied` 只放行 workspace root 内的写**（`(allow file-write* (subpath root))` 沙盒 + 逐段 lstat 拒符号链接）。**记忆目录在 dataDir（`~/.pi-web/memories/...`）之下，处于工作区之外——不改造 env，workspaceWrite 会话的记忆写入会被 `permission_denied` 拒绝。**
- `readOnly` → 工具面无 write/edit（§2.2）。

### 2.4 生成 API（pi-ai 1.3.0）

- `Models.complete(model, context: {systemPrompt?, messages, tools?}, options?)`（`dist/models.d.ts:184`）**原生支持工具目录**；options 含 `maxTokens`、`sessionId`、`signal`、`timeoutMs`、`samplingParams`（`types.d.ts` 的 StreamOptions/ProviderRequestOptions）。
- 消息形状：`UserMessage {role:'user', content: string | (TextContent|ImageContent)[], timestamp}`；`AssistantMessage.content` 为 `(TextContent|ThinkingContent|ToolCall)[]`，`ToolCall {type:'toolCall', id, name, arguments: JsonObject}`；`ToolResultMessage {role:'toolResult', toolCallId, toolName, content}`。
- demo 模型（`src/server/demo-model.ts`）：fauxProvider 按请求内容分派脚本化响应（如 `demoCompactionResponse` 以 system 含 `'context compaction engine'` 识别摘要请求，`:228-235`）；`observeDemoRequests`（`:30-33`）注册即收每个到达 demo provider 的原始请求——**后台生成请求同样被捕获**，且 fauxProvider 可返回 toolCall 序列（write→read→bash 默认脚本即证）。
- 依赖：`yaml@2.9.1` 已有（盖章可直接移植）；`marked` 无（剥顶层 HTML 注释改用本仓已有的 `mdast-util-from-markdown` 生态）。

---

## 3. 语义映射与关键决策

### 3.1 挂点映射总表

| ZCode 挂点 | pi-web 对应 | 形态差异 |
| --- | --- | --- |
| `# Memory` system section（context builder） | memory extension 的 `section('memory', …)` | pi 的 section 渲染进 tagged system 块 `<memory>…</memory>`；每请求重渲染（文本稳定则零开销） |
| MEMORY.md 索引 → 首条 user message `# agentsMd` 块 | `section('memory-index', …)` | **独立 section，不复制 `# agentsMd` 聚合语义**（pi-web 的 AGENTS.md 本就是独立 section `project-instructions`）；**每请求重读文件**（照抄 `projectInstructionsSection` 模式，`work-policy.ts:59-61`），不是 ZCode 的会话冻结——中途提取写入的索引下一请求即可见（有意差异，见 §8-D3） |
| 前台写入放行（permission 链尾部改写 decision） | ① execution-policy 的 plan 例外谓词；② execution-env 的 extraWriteRoots；③ readOnly 靠工具面自然排除 | pi-web **没有权限审批链**，"放行"拆成三件事（§3.2） |
| originSessionId 盖章（write/edit handler 落盘前） | memory extension 对 write/edit 的 wrap：write 预变换 content；edit 成功后按需补章 | pi 原生工具内部不可侵入，write 可等价预变换，edit 只能后置（§3.3） |
| readFileState 种子 | 不移植（D4，见 memory-plan.md） | pi 无 read-before-write 硬校验，用提示词约束"改 MEMORY.md 前先 read" |
| 成功 turn 后调度提取（`turn.ts:947`） | `submitWithReferences` 内 fire-and-forget `request.wait(CTX)`，settled.status === 'done' 时调度 | pi-web 以 submission/run 为界，比 ZCode 的 message UUID cursor 简单 |
| session close 终止提取 | `runtime.close()` 里 shutdown + 有界 drain | 单进程单 Host，无 ZCode 的"单会话关闭进程存活"长尾 |
| 提取受限执行（冻结快照 + 受限 loop + 独立 executor） | runtime 层自建 loop：`modelRuntime.models.complete` + 自建工具 executor，**不向主 conversation submit** | 同 D3 |

### 3.2 决策 A："放行"在 pi-web 的三重含义

ZCode 的一条 permission 改写，在 pi-web 拆成三件事：

1. **plan 模式例外**（对应 ZCode "合格 Memory 写入先于 plan-mode block"）。pi-web 的 plan 拦截在 `execution-policy.ts:60-63`（execute wrap 内非 `PLAN_TOOLS` 即 throw）。**方案：给 `createExecutionPolicyExtension` 注入一个异步例外谓词**（单一事实源留在 execution-policy，这是 memory-plan.md D2 预留的兜底路径）：

   ```ts
   export function createExecutionPolicyExtension(
     installed: readonly Extension[],
     options?: { isPlanException?: (toolName: string, args: unknown, env: ExecutionEnv | undefined) => Promise<boolean> },
   ): Extension
   ```

   wrap 内改为：

   ```ts
   if (!PLAN_TOOLS.has(tool.name)) {
     if (options?.isPlanException !== undefined && await options.isPlanException(tool.name, args, api.env)) {
       return tool.execute(args, api, context)   // memory .md 写入凿穿 plan 拦截
     }
     throw new Error(`Plan mode blocks ${tool.name}. ...`)
   }
   ```

   谓词由 runtime 装配时注入（`(name, args, env) => name 谓 write/edit && memoryEnabled && safeMemoryTarget(argumentPath(args), resolveMemoryRoot(dataDir, env?.cwd))`）。**不选**"memory wrap 外层短路调原始 execute"的替代方案：需要捕获原始工具引用、绕过所有中间 wrap，且引入 wrap 顺序依赖。
2. **workspaceWrite 沙盒扩展**（ZCode 无此问题——其 FileSystemPort 不受工作区边界约束）。`execution-env.ts` 的 `createExecutionEnv` 增加第三参：

   ```ts
   export async function createExecutionEnv(
     cwd: string, mode: AccessMode, extraWriteRoots: readonly string[] = [],
   ): Promise<ExecutionEnv>
   ```

   `WorkspaceWriteExecutionEnv` 构造时保存 `[workspaceRoot, ...extraWriteRoots]`；沙盒 profile 每个根一行 `(allow file-write* (subpath root))`；`writeDenied`（`:89-109`）改为"落在**任一**允许根内即放行"，符号链接逐段检查按所属根判定。fullAccess/readOnly 忽略该参数。runtime.ts 的 env 回调在 `memoryEnabled` 时传入 `[resolveMemoryRoot(dataDir, workspace.path)]`。
3. **readOnly 排除**（D1）：readOnly 会话工具面无 write/edit（`READ_ONLY_TOOLS`，`runtime.ts:156-157`），wrap 与 plan 例外都不会命中；section 侧按 §4.2 的 plan/readOnly 判定降级渲染。**不把 write/edit 加进 READ_ONLY_TOOLS**（守住 windows-support.md 的"只读会话零写面"承诺）。

### 3.3 决策 B：盖章边界

pi 原生 write/edit 的落盘在工具内部，wrap 无法像 ZCode 那样在 `writeTextFile` 前介入：

- **write**：wrap 内调用原 execute **之前**对 `args.content` 做 `stampOriginSessionId(content, path, root, sessionId)`——write 的 content 即全文，预变换与 ZCode 的落盘前变换完全等价（盖章是幂等纯函数，多套一层无副作用）。
- **edit**：`args.edits` 无法在不重放编辑逻辑的情况下得到终稿。**后置补章**：wrap 先读目标文件判定"是否需要章"（有 frontmatter 匹配且 `originSessionId` 缺失）；需要则原 execute 成功返回后再读-章-原子写回（best-effort，失败仅日志、不影响工具结果）。MEMORY.md 无 frontmatter，自然两步都跳过——与 ZCode 语义一致。竞态面：与提取任务并发写同一文件时可能双写，但盖章幂等（已盖章即原样返回），最坏结果是 mtime 多变一次。
- **提取任务自身**的 write/edit 是自建 executor（§5.4），落盘前直接调用同一盖章函数——与主会话走同一份代码。
- `sessionId` 用 `String(conversationId)`（pi-web 无独立 session id 概念，conversation id 即稳定标识）。

### 3.4 决策 C：提示词中文化

memory-plan.md 已定"文案中文化，结构对齐 ZCode"。中文定稿见 §4.2/§5.5；字段名（`name`/`description`/`metadata.type`）、类型枚举值（user/feedback/project/reference）、no-op 合同记号 **`Nothing to save.`**（逐字，英文，便于测试断言与模型稳定输出）、MEMORY.md 一行指针格式 `- [标题](文件.md) — 钩子` 保持原文形态。**模型被教的 frontmatter 不含 `node_type`/`originSessionId`**——这两个字段由写入边界盖章（ZCode 刻意为之，防止模型伪造溯源）。

---

## 4. Phase 1：存储 + 注入

### 4.1 `src/server/memory.ts`（纯函数层，全部可单测）

#### 4.1.1 root 计算

```ts
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

export interface MemoryRootInput { dataDir: string; workspacePath: string }

export function resolveMemoryRoot(input: MemoryRootInput): string {
  const normalized = resolve(input.workspacePath)
  const keySource = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const hash = createHash('sha256').update(keySource).digest('hex').slice(0, 16)
  const slug = sanitizeProjectSlug(basename(normalized) || 'project')
  return join(input.dataDir, 'memories', 'projects', `${slug}-${hash}`, 'memory')
}

function sanitizeProjectSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug.length > 0 ? slug : 'project'
}
```

与 ZCode `project-root.ts:10-33` 逐行对齐，去掉 `workspaceIdentity` 分支（memory-plan.md 非目标：pi-web workspace 无独立 identity，`app-state.json` 存 id + path，v1 用 path 规范化绝对路径为隔离键；目录名已预留 hash 段，未来切 identity 只改此函数）。Windows 参与散列前转小写。

#### 4.1.2 路径安全（逐字移植，唯一改动：`resolveWorkspacePath` 换成 `resolve`）

```ts
export const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([...20 项，逐字同 §1.2...])

/** contained：解析后落在 memory root 内（用于提取的 direct-write 判定）。 */
export function isContainedMemoryPath(filePath: string, rootDir: string): boolean

/** safe：contained 且无敏感段（用于写入放行与提取白名单）。返回归一化后的绝对路径或 undefined。 */
export function resolveSafeMemoryPath(filePath: string, rootDir: string): string | undefined
```

ZCode 版（`memory-file-path.ts:28-56`）第一步经其 `resolveWorkspacePath({operation:"write"})` 受工作区写策略约束；pi-web 对应物就是 `path.resolve`（工作区边界由 env 沙盒负责，memory 判定只管 root 包含性），相对路径基于 `process.cwd()` 解析即可（模型给的 memory 路径几乎总是绝对的——`# 记忆` section 里声明了绝对 root）。其余逐行移植：

- `isContainedRelativePath` 五条件（非空、≠`..`、不 `../`、不 `..\`、非绝对）；
- `containsSensitiveMemoryPathSegment`：`split(/[\\/]+/u)` 切段；
- `normalizeSensitiveSegment`：小写 → 剥 `\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff` → `split(":",1)[0]` → 剥尾部 `[. ]+`。

#### 4.1.3 索引规范化

- 阈值常量：`MEMORY_INDEX_LINE_LIMIT = 200`、`MEMORY_INDEX_CHARACTER_LIMIT = 25_000`（严格大于判定，同 ZCode `index-content.ts:3-4`）。
- `formatMemoryIndex(content: string): string`：剥 leading frontmatter → 剥顶层 HTML 注释 → `formatIndexBody`。
- **顶层 HTML 注释剥离用 mdast 替代 marked**（本仓无 marked）：

  ```ts
  import { fromMarkdown } from 'mdast-util-from-markdown'

  function stripTopLevelHtmlComments(content: string): string {
    if (!content.includes('<!--')) return content
    const tree = fromMarkdown(content)
    let out = ''
    let last = 0
    for (const node of tree.children) {
      if (node.type === 'html' && node.value.trimStart().startsWith('<!--') && node.value.includes('-->')) continue
      // 用 position 偏移从原文切回，保留未处理区间的原始字节
      out += content.slice(last, node.position!.end.offset!)
      last = node.position!.end.offset!
    }
    return out + content.slice(last)
  }
  ```

  mdast 的顶层 `html` 节点即 ZCode marked Lexer 顶层 html token 的等价物；代码块/引用块内的注释不是顶层节点，天然保留——与 ZCode `:49-67` 的注释约束一致（"只删 lexer 识别到的顶层 HTML comment，容器内的必须保持 provider-visible"）。
- `formatIndexBody`：trim → 超 200 行或 25,000 字符则截断（先按行，再取 `lastIndexOf("\n", 25000)` 完整换行）→ 追加 WARNING（中文版）：`> 警告：MEMORY.md ${sizeDescription}，仅加载了部分内容。索引行保持一行 ~200 字符以内，细节移入主题文件。`（sizeDescription 三形态对齐 ZCode：仅字符超（附 `（上限 X）——索引行过长`）/ 仅行超 / 双超）。

#### 4.1.4 MEMORY.md 稳定读取

照抄 `project-instructions.ts` 的防线全套（`:85-218`），差异只有三点：

| 参数 | project-instructions | memory-index |
| --- | --- | --- |
| 目标 | `<workspaceRoot>/AGENTS.md` | `<memoryRoot>/MEMORY.md` |
| 大小上限 | 32 KiB（`source-too-large` 拒绝） | **256 KiB**（索引字符截断阈值 25,000 之外留出余量；超限按 error 处理而非截断——截断由 4.1.3 负责，读取层只管有界与防篡改） |
| workspace 前置校验 | workspace 本身不得是/含符号链接、必须 canonical | **不做**——memory root 在 dataDir 下由本系统自管，只保留源文件级防线：O_NOFOLLOW 打开、Windows 无 O_NOFOLLOW 时 lstat+sameFile 复检、读前读后 stat/lstat triple 复检（size/mtime/ctime 一致）、fatal UTF-8、拒 `\0`、返回 `{status:'loaded'|'missing'|'error', content?, bytes, sha256}` |

`missing` 是合法状态（首次使用无 MEMORY.md）→ section 返回 undefined。

#### 4.1.5 目录预创建

`ensureMemoryDirectory(root: string): Promise<void>`：`mkdir(root, {recursive:true})`，catch 后 `console.warn` 级别日志即返回（ZCode `directory.ts` 语义：预创建失败不阻断，真实错误面留给后续写工具）。进程内按 root 记忆化（Set），每 root 只试一次。

### 4.2 `src/server/memory-policy.ts`（extension 层）

```ts
import { defineExtension, section, type Extension, type PromptInput } from '@earendil-works/pi-durable'
import { Plans } from './plan-tools.ts'
import { formatMemoryIndex, loadMemoryIndex, resolveMemoryRoot } from './memory.ts'

export const MEMORY_EXTENSION_NAME = 'pi-web-memory'

export interface MemoryPolicyOptions {
  dataDir: string
  memoryEnabled: () => boolean          // () => appState.snapshot().settings.memoryEnabled
}

export function createMemoryExtension(options: MemoryPolicyOptions): Extension
```

#### 4.2.1 `section('memory', …)`——保存规则（中文定稿）

render 逻辑：

```ts
const memorySection = section('memory', async (input, context) => {
  if (!options.memoryEnabled()) return undefined
  const root = resolveMemoryRoot({ dataDir: options.dataDir, workspacePath: input.env?.cwd ?? '' })
  if (!input.env?.cwd) return undefined
  const plan = await input.read.snapshot(Plans, input.conversationId, context)
  const canWrite = input.agent.tools.some(tool => tool.name === 'write' || tool.name === 'edit') || plan?.active === true
  if (!canWrite) return undefined       // readOnly 会话（无 write/edit 且未开 plan）不教"怎么写"
  return memoryInstructions(root)       // 静态文本（给定 root），stable → 零 pi.system entry
})
```

`canWrite` 判定的闭环（§2.3 的 readOnly/plan 区分难题）：plan 激活时 execution-policy 的 section wrap 会把 `input.agent.tools` 换成 planAgent 过滤版（`execution-policy.ts:72-81`），write/edit 从 tools 里消失——但此时 `plan.active === true`，`||` 右侧救回 → plan 模式照常渲染写指令（D2：plan 下可写记忆）；readOnly 会话 tools 无 write/edit 且 plan 未激活 → 省略（D1）。preset 窄化掉 write/edit 的情形同样省略，语义正确。

文案（`memoryInstructions(root)` 返回值，中文定稿；结构逐段对齐 ZCode `context/sections/memory.ts:29-61`，pi-web 处于 default-index 分支故指针行恒在）：

```markdown
# 记忆

你在 `<root>/` 有一个基于文件的持久记忆。该目录已存在——直接用 write 工具写入（不要 mkdir，也不要检查它是否存在）。每条记忆是一个只保存一个事实的独立文件，带 frontmatter：

```markdown
---
name: <短-kebab-case-标识>
description: <一行摘要——召回时用于判断相关性>
metadata:
  type: user | feedback | project | reference
---

<事实正文；feedback/project 类型在其后跟 **Why:** 与 **How to apply:** 行。用 [[对方-name]] 关联相关记忆。>
```

正文中可以用 `[[name]]` 链接其他记忆，`name` 是对方 frontmatter 里的 `name:` 标识。放心链接——`[[name]]` 暂时对不上现有记忆不是错误，它标记的是值得将来写入的内容。

`user`——用户是谁（角色、专长、偏好）。`feedback`——用户对你工作方式的指导，包括纠正与已确认可行的做法；要写明原因。`project`——进行中的工作、目标或约束，且无法从代码或 git 历史推导出来；相对日期写入时转为绝对日期。`reference`——外部资源的指针（URL、看板、工单）。

写完文件后，在 `MEMORY.md` 里加一行指针（`- [标题](文件.md) — 钩子`）。`MEMORY.md` 是每个会话都加载进上下文的索引——每条记忆一行，没有 frontmatter，永远不要把记忆正文写进去。修改 `MEMORY.md` 前先 read 它。

保存前先查有没有已有文件覆盖了同一事实——更新那个文件而不是新建重复；发现某条记忆错了就删掉。不要保存仓库本身已记录的内容（代码结构、历史修复、git 历史、AGENTS.md），也不要保存只对本次对话有意义的内容；用户明确要求记其中一类时，先追问其中非显而易见的部分，保存那部分。
```

末行"修改 `MEMORY.md` 前先 read 它"是 D4 的 prompt 级替代（pi 无 readFileState 硬校验，ZCode 靠种子条目实现的东西这里靠指令）。

#### 4.2.2 `section('memory-index', …)`——索引注入（每请求重读）

```ts
const memoryIndexSection = section('memory-index', async (input) => {
  if (!options.memoryEnabled()) return undefined
  const root = resolveMemoryRoot({ dataDir: options.dataDir, workspacePath: input.env?.cwd ?? '' })
  if (!input.env?.cwd) return undefined
  const record = await loadMemoryIndex(join(root, 'MEMORY.md'))   // §4.1.4 稳定读取
  if (record.status !== 'loaded') return undefined                // missing/error 一律省略（不重试、不降级）
  const formatted = formatMemoryIndex(record.content)
  if (formatted === '') return undefined
  return [
    `\`${join(root, 'MEMORY.md')}\` 的内容（用户自动记忆，跨会话持久保留）：`,
    '',
    formatted,
  ].join('\n')
})
```

与 ZCode 的差异（有意）：ZCode 会话初始化读一次并冻结、注入到首条 user message 的 `<system-reminder>`；pi-web 每请求重读、注入为 tagged system section（与 `project-instructions` 同层同模式）。意义：中途提取写入的新索引行**下一请求即可见**（ZCode 要下一会话）；代价：每请求一次带复检的文件读（AGENTS.md 已有同量级先例）+ 索引变更时一条 `pi.system` patch entry。

#### 4.2.3 装配

```ts
export function createMemoryExtension(options: MemoryPolicyOptions): Extension {
  return defineExtension({
    name: MEMORY_EXTENSION_NAME,
    sections: [memorySection, memoryIndexSection],
    // Phase 2 追加 wraps（write/edit 盖章），Phase 3 追加提取调度入口（不在 extension 内）
  })
}
```

### 4.3 runtime.ts 装配改动（Phase 1 部分）

1. **安装位置**：`runtime.ts:537`（work-policy）之后、`:582`（execution-policy）之前插入：

   ```ts
   const memoryExtension = createMemoryExtension({
     dataDir,
     memoryEnabled: () => appState.snapshot().settings.memoryEnabled,
   })
   registry.install(memoryExtension)
   ```

   在 582 之前安装 ⇒ execution-policy 枚举 section 时含 `memory`/`memory-index` ⇒ plan 过滤自动覆盖它们（§4.2.1 的 `plan.active` 读取与该过滤叠加，行为正确）。
2. **必选集合**：`ensureRuntimePolicy` 的 `required`（`runtime.ts:164`）改为 `[WORK_POLICY_EXTENSION_NAME, COMPACTION_EXTENSION_NAME, MEMORY_EXTENSION_NAME, EXECUTION_POLICY_EXTENSION_NAME]`；`buildAgentChange` 的种子列表（`:920`）同样在 `EXECUTION_POLICY` 之前插入 `MEMORY_EXTENSION_NAME`。记忆是平台能力不是 Preset 选项，关闭靠 `memoryEnabled`（extension 内部自禁用：section 返回 undefined、wrap 直通、提取门早退）——**无需 codemodeMode 那样的 syncCodemodeAgents 存量传播**，开关"下一请求生效"天然成立。wrap 顺序说明：memory 在 execution-policy 之前 ⇒ memory 的 write/edit wrap 在内层，plan 检查（外层）先执行——plan 例外谓词（§3.2）看到的正是未盖章的原始 args，仅判 `args.path`，无影响。
3. **env 回调**（`:611-616`）：

   ```ts
   env: async (target) => {
     const metadata = await harness.snapshot(META, target.conversationId, CTX)
     const selectedWorkspace = workspaceFiles.workspace(metadata?.workspaceId ?? defaultWorkspace.id)
     const selectedMode = metadata?.accessMode ?? appState.snapshot().settings.defaultAccessMode
     const extraWriteRoots = appState.snapshot().settings.memoryEnabled && selectedMode === 'workspaceWrite'
       ? [resolveMemoryRoot({ dataDir, workspacePath: selectedWorkspace.path })]
       : []
     if (extraWriteRoots.length > 0) void ensureMemoryDirectory(extraWriteRoots[0])   // best-effort，不 await
     return createExecutionEnv(selectedWorkspace.path, selectedMode, extraWriteRoots)
   },
   ```

### 4.4 设置开关（五处联动，全列）

| 位置 | 改动 |
| --- | --- |
| `src/shared/types.ts`（AppSettings，`:94-119`） | 加 `memoryEnabled: boolean`（必填字段，与 `codingViews` 同型）；`UpdateAppSettingsInput` 经 `Omit<Partial<AppSettings>...>` 自动获得 |
| `src/server/app-state.ts` `settingsSchema`（`:21-41`） | `memoryEnabled: z.boolean().default(false)`（**必须带 default**：旧 app-state.json 缺字段读作 false，对齐 codemodeMode 注释先例 `:37`） |
| `src/server/app-state.ts` `defaultSettings()`（`:163-181`） | `memoryEnabled: false` |
| `src/server/app.ts` `settingsSchema`（`:109-119`） | 同步加 `memoryEnabled`（PATCH 校验） |
| `src/server/runtime.ts` `updateSettings`（`:1719-1743`） | `if (input.memoryEnabled !== undefined) state.settings.memoryEnabled = input.memoryEnabled`（无存量会话同步需求，见 §4.3-2） |
| `src/web/SettingsDialog.tsx` general tab | `SettingRow` + `Toggle`（照 `codingViews`，`:136-138`），标题"工作区记忆"，描述含用量提示（对齐 ZCode 文案）："开启后，系统会自动提取和注入长期记忆，可能产生额外的模型请求与 Token 用量。" |

### 4.5 Phase 1 验收（对齐 memory-plan.md §7）

- `PI_WEB_DEMO=1` fixture：开启开关新建会话，`observeDemoRequests` 断言请求 system 含 `<memory>` 节（含正确 root 绝对路径）与 `<memory-index>` 节；手工放置 MEMORY.md + 事实文件后，跨会话、`restart()`（同 dataDir 重开）、compact 后注入仍在；关闭开关后两节消失且零文件读取。
- 边界：空 MEMORY.md、超 200 行（断言 WARNING 中文文案与截断位置）、非法 UTF-8、符号链接、超 256 KiB。
- root 计算单测：中文目录名 slug 回退、Windows 小写散列（模拟 `process.platform`）、hash 16 位、48 字符截断。

---

## 5. Phase 2：写入放行 + 盖章

### 5.1 execution-policy 例外谓词

§3.2-1 的签名与 wrap 改动；runtime 装配（`:582`）改为：

```ts
registry.install(createExecutionPolicyExtension(registry.snapshot().installed(), {
  isPlanException: async (toolName, args, env) => {
    if (toolName !== 'write' && toolName !== 'edit') return false
    if (!appState.snapshot().settings.memoryEnabled) return false
    if (!env?.cwd) return false
    const root = resolveMemoryRoot({ dataDir, workspacePath: env.cwd })
    const path = argumentPath(args)                  // 复用 compaction.ts:222-230 的兼容取参（'path' 优先）
    return path !== undefined && resolveSafeMemoryPath(path, root) !== undefined
  },
}))
```

注意：谓词只认**本仓 write/edit 工具**（工具名小写）；codemode 脚本嵌套调用的 write 也会经过此 wrap（`api.agent` 链），同样适用——行为一致即正确。

### 5.2 execution-env 扩展

§3.2-2 的 `extraWriteRoots`。要点：

- `WorkspaceWriteExecutionEnv` 保存 `#roots: string[]`；沙盒 profile 对每个 root 输出一行 `(allow file-write* (subpath <root>))`；
- `writeDenied`：候选路径"不在任何 root 内"才拒绝；逐段 lstat/realpath 检查以**所属 root**为界（memory root 内同样拒符号链接逃逸——`resolveSafeMemoryPath` 的 containment 判定基于 `resolve()`，不解析符号链接，最后一道防线在这里）；
- `workspaceWriteSupported` 探测（`:29-38`）保持只测 workspace root（memory root 由同一机制覆盖，无需二次探测）。

### 5.3 memory-policy 的 write/edit wraps（盖章）

```ts
function stampWraps(options: MemoryPolicyOptions & { stampRoot: (env: ExecutionEnv | undefined) => string | undefined }): Wrap[] {
  const stamp = (tool: T) => ({
    ...tool,
    execute: async (args: any, api: ToolExecutionApi, context: Context) => {
      if (!options.memoryEnabled()) return tool.execute(args, api, context)
      const root = stampRoot(api.env)
      const target = root !== undefined && typeof args?.path === 'string' ? args.path : undefined
      const safe = target !== undefined ? resolveSafeMemoryPath(target, root!) : undefined
      if (safe === undefined) return tool.execute(args, api, context)      // 非 memory 目标直通
      if (tool.name === 'write') {
        const content = typeof args.content === 'string' ? stampOriginSessionId(args.content, safe, root!, String(api.conversationId)) : args.content
        return tool.execute({ ...args, content }, api, context)
      }
      // edit：先探测是否需要补章，成功后读-章-写回
      const needs = await fileNeedsOriginStamp(safe)                       // 读文件（不存在→false；frontmatter 匹配且 origin 缺失→true）
      const result = await tool.execute(args, api, context)
      if (needs && !isToolError(result)) await stampExistingFile(safe, root!, String(api.conversationId)).catch(() => undefined)
      return result
    },
  })
  return [{ tool: 'write', wrap: stamp }, { tool: 'edit', wrap: stamp }]
}
```

- `stampOriginSessionId`：§1.6 的逐行移植（本仓 `yaml@2.9.1` 已有 `parseDocument/isMap`，API 兼容）。放在 `memory.ts`。
- `fileNeedsOriginStamp` / `stampExistingFile`：前者复用 §4.1.4 风格的有界读 + frontmatter 正则 + YAML 检查；后者 `stampOriginSessionId` 后 tmp+rename 原子写回。
- wrap 内**只做盖章，不做放行**（放行在 §5.1/§5.2），也不得抛错（pi 的 applyWrap 对抛错的 wrap 会移除整个工具，`agent.js:250-262`）——所有异常路径都退回直通或吞掉。

### 5.4 Phase 2 验收

- fullAccess：模型 write 记忆文件 → 落盘内容含 `node_type: memory`（metadata 首键）+ `originSessionId: <conversationId>`；再次 edit 同文件 → origin 不被覆盖（幂等）。
- plan 模式激活：write 普通工作区文件被拦（错误文案不变），write 记忆目录 `.md` 成功；敏感段路径（如 `<root>/.git/x.md`）与 root 外路径、非 `.md` 后缀走原拦截。
- workspaceWrite：开启 memory 后写 `<root>/x.md` 成功（沙盒放行），写 dataDir 其他位置仍拒。
- readOnly：无 write/edit 工具面，`<memory>` section 不渲染（§4.2.1）。
- CRLF 文件、BOM、frontmatter 语法错、无 frontmatter（MEMORY.md）、metadata 非 map——全部原样返回不破坏。

---

## 6. Phase 3：后台提取

### 6.1 新文件 `src/server/memory-extraction.ts`

结构（对齐 ZCode `extraction.ts` 的三层，但适配 pi-web 的 run 粒度）：

```ts
export interface MemoryExtractionDeps {
  harness: () => Harness                 // 惰性（同 compaction 的 harness: () => harness）
  models: () => Models                   // modelRuntime.models
  dataDir: string
  memoryEnabled: () => boolean
  usageAccounting: (conversationId: ConversationId, model: ModelRef, usage: Usage) => Promise<void>  // best-effort
}

export function createMemoryExtraction(deps: MemoryExtractionDeps): {
  scheduleAfterSubmission(conversation: Conversation, submission: Submission): void
  shutdown(): void
  drain(timeoutMs: number): Promise<void>
}
```

### 6.2 触发链（runtime.ts 挂点）

`submitWithReferences`（`:1134-1180`）在 `return { submissionId }` 前加一行：

```ts
memoryExtraction.scheduleAfterSubmission(conversation, request)
```

`scheduleAfterSubmission` 内部 fire-and-forget（对齐 D3 与标题调度模式，`runtime.ts:1195` 先例）：

```ts
void submission.wait(CTX).then(async settled => {
  if (settled.status !== 'done') return                    // 仅成功 run；unanswered/aborted 不调度
  if (!deps.memoryEnabled()) return
  const metadata = await harness().snapshot(META, conversation.id, CTX)
  if (metadata?.accessMode === 'readOnly') return          // 只读会话零提取（D1 对称）
  schedulerFor(conversation.id).schedule(() => buildSnapshot(conversation))
}).catch(() => undefined)                                   // 任何失败静默（后台任务不上抛）
```

排队输入（whenBusy: followUp）每个 submission 各自 settle、各自 schedule——调度器 coalescing 吸收。幂等重放路径（requestId 复用返回旧 submissionId）不触发（早退在 `existing` 分支之前）。

### 6.3 调度器（单 running + latest pending，逐行对齐 ZCode `extraction.ts:85-179`）

per-conversation 实例（`Map<ConversationId, Scheduler>`；ZCode 是 per-runtime 单例，pi-web 单 Host 多会话，按会话分槽避免互相延迟）：

- `schedule(acquisition: () => Promise<Snapshot | undefined>)`：running 存在 → 覆盖 latestPending；否则启动 run 循环。schedule 到置位 running 无 await（原子区间，无双 runner）。
- run 循环：逐个消费 acquisition → snapshot → 运行决策 → 执行；`current = latestPending; latestPending = undefined`。
- **cursor**：per-conversation 内存 `lastProcessedEntryId: string | undefined`（ZCode 用 durable message UUID；pi-web 对应 ContextView.entries 的 EntryRecord.id）。snapshot = `conversation.context(CTX)` 的 entries 中该 id 之后的全部（首个 snapshot 为全量，按 token 预算从尾部裁剪，见 §6.5）。**success / no-op / skip 推进；error / aborted / 异常不推进**（at-least-once）。进程重启丢失 cursor → 重启后首个 run 全量重看一次，可接受（同 ZCode 内存态语义）。
- shutdown：置 shuttingDown、清 pending、abort 单一 `AbortController`（贯穿生成请求与工具执行）；drain 有界等待（`Promise.race` 60s，对齐 ZCode `drainMemoryExtractions`）。

### 6.4 运行决策（ZCode `extraction.ts:68-83` 的 pi-ai 适配）

对 snapshot 的 messages（cursor 之后）：

1. **direct-memory-write**：存在 `role === 'assistant'` 消息，其 content 数组中有 `type === 'toolCall'` 且 `name ∈ {'write','edit'}` 的 block，`arguments.path`（兼容 `argumentPath`）`isContainMemoryPath` 于该会话 root → skip（不看执行成败、不要求 .md——逐条对齐 ZCode `:228-255`）。
2. **no-user-prose**：不存在 `role === 'user'` 消息的 text 内容（string content 或 TextContent block）`split(/\s+/).filter(Boolean).length >= 3` → skip。pi-ai 的 toolResult 是独立 role，天然排除；`<system-reminder>` 类注入内容在 pi-web 属 system section，不在 user 消息里，无需 ZCode 的 meta 过滤。
3. 否则 run。

skip 也推进 cursor（同 ZCode）。

### 6.5 上下文构造与请求

- **messages**：cursor 之后的原始 pi-ai Message[]（user/assistant/toolResult 原样保留）。预算：估算 token（沿用 compaction 的 `estimateMessagesTokens` 同源做法）超过 `model.contextWindow / 2` 时从最旧丢弃，且若截断后开头是 toolResult 消息则继续丢到开头为 user/assistant（避免无主工具结果）。
- **systemPrompt**：只放 `memoryInstructions(root)`（与主会话同一份中文文案，§4.2.1）。
- **提取指令**：提取 prompt（中文定稿，§6.6）+ manifest 段作为**最后一条 user 消息**追加在快照之后，而不是并入 systemPrompt。真实模型验收发现：只放在 system prompt、且快照以 assistant 回答结尾时，DeepSeek 会把对话视为已结束，返回空文本并 `stopReason: stop`，提取被误判为成功且游标推进，事实永久丢失。压缩（`buildSummaryRequest`）同样用末尾 user 指令，这是本仓已验证的范式。
- **manifest**：移植 ZCode `recall/manifest.ts` 的扫描（递归、小写 `.md`、排除 `MEMORY.md`、每文件前 30 行 frontmatter、mtime 降序、≤200 文件、`- [type] filename (ISO8601): description` 行格式）——pi-web 用 `readdir` 递归实现（不跟目录符号链接），单文件读取复用 §4.1.4 的有界读（limit 30 行）。
- **tools**：自建目录（§6.7），`Models.complete(model, {systemPrompt, messages, tools}, {maxTokens, signal, sessionId: `memory-${conversationId}`, timeoutMs: 120_000})`。
- **模型与档位**：会话当前模型（`conversation.agent(CTX).model` → `models.getModel`；缺省回落 `modelRuntime.defaultModel`）；`maxTokens: Math.min(5000, model.maxTokens)`（ZCode `auxiliaryModelOptions` 数值）；思考档取该模型最低支持档（`modelRuntime.supportedThinkingLevels` 的最小项；ZCode 同语义）。

### 6.6 提取 prompt（中文定稿，逐段对齐 ZCode `extraction.ts:42-66`）

```markdown
# 记忆提取

你现在是记忆提取子代理。分析上面最近约 <N> 条消息，并用它们更新你的持久记忆系统。

可用工具：read、list_files、search_files（只读），以及仅限记忆目录 <root>/ 内 .md 路径的 write/edit。其余工具一律会被拒绝。

你的轮次预算有限（5 轮）。edit 的 oldText 必须与文件当前内容完全一致，所以高效策略是：第 1 轮——并行发出所有可能要更新的文件的 read；第 2 轮——并行发出所有 write/edit。不要把读和写交错到多轮。

你必须只使用最近约 <N> 条消息的内容来更新持久记忆。不要浪费任何轮次去调查或验证这些内容——不要 grep 源码、不要读代码确认某个模式存在、不要执行 git 命令。

## 已有记忆文件

<manifest 行>

写入前先查这份清单——更新已有文件，而不是新建重复。

如果没有值得保存的内容，只输出「Nothing to save.」，不要解释原因。

如果用户明确要求记住某件事，立即按最合适的类型保存。如果用户要求忘掉某件事，找到并删除相关条目。

记忆类型、不该保存的判据与 frontmatter 格式，以系统提示中的记忆节为准——它已在你的上下文里。
```

- `<N>` 为 cursor 之后消息数（同 ZCode 的 `~N` 模糊表述）；manifest 为空时整段 `## 已有记忆文件` 连同"写入前先查"句省略。
- `Nothing to save.` 保持英文逐字（合同记号；循环侧不解析它推导状态，仅终止条件自然成立——无 toolCall 即结束）。
- demo 识别标记：systemPrompt 含固定短语 `记忆提取子代理`（demo-model 脚本以此分派，对齐 `demoCompactionResponse` 以 `'context compaction engine'` 识别的先例）。

### 6.7 受限执行循环（自建，不向主 conversation submit）

```ts
const EXTRACTION_MAX_TURNS = 5

async function runExtractionLoop(model, request: {systemPrompt, messages}, tools, exec: (call: ToolCall, signal) => Promise<{content: string, isError: boolean}>, signal): Promise<{turns: number}>
```

逐轮（对齐 ZCode `memory-agent-loop.ts:43-125` 的骨架，去掉媒体投影——提取请求无图片）：

1. `signal.throwIfAborted()`；
2. `answer = await models.complete(model, {...request, messages}, {maxTokens, signal, sessionId, timeoutMs})`；
3. `toolCalls = answer.content.filter(b => b.type === 'toolCall')`；无 toolCall → push assistant 消息、结束；
4. `Promise.all` 执行每个 toolCall：**先过策略判定**（见下），拒绝 → 直接构造 `{role:'toolResult', toolCallId, toolName, content: <拒绝文案>, isError: true}` 不调 executor（ZCode 合同："精确拒绝文案且不调 executor"）；允许 → executor 执行 → toolResult 消息；
5. push assistant + toolResult 消息进 request.messages，下一轮；`turns >= 5` 时第 5 轮的 toolCalls **仍执行**，但不再发起第 6 次请求（ZCode 语义）。

**工具策略**（白名单在执行侧收窄，目录全量给模型——本 v1 目录本身就只含白名单工具，判定仍是第二道防线）：

| 调用 | 判定 | 拒绝文案（中文定稿，作为 toolResult isError 回流） |
| --- | --- | --- |
| `read`/`list_files`/`search_files` | 目录内即允许（execute 内部自带边界：只读、限工作区 + memory root） | —— |
| `write`/`edit` | `resolveSafeMemoryPath(args.path, root) !== undefined`（.md + contained + 无敏感段） | `此上下文只允许 read、list_files、search_files，以及 <root> 内 .md 的 write/edit` |
| 其他（catalog miss） | 目录里没有的名字 | `Error: No such tool available: <name>` |

**自建工具 executor**（不经 harness 工具面、不经 env 沙盒——提取是宿主侧行为，落盘前统一过 §4.1.2 判定 + 盖章）：

- `read {path}`：§4.1.4 风格有界读（上限 256 KiB），允许读工作区任意文件与 memory root（prompt 已禁止拿它验证，但不物理剥夺——ZCode 同样给了 Read/Grep/Glob）；
- `list_files {path?}`：`readdir` 递归列目录（根默认工作区 root），上限 2000 项，返回相对路径列表；
- `search_files {pattern, path?}`：大小写不敏感子串匹配，逐文本文件（≤1 MiB）扫行，上限 200 个匹配行；
- `write {path, content}`：safe 判定 → `stampOriginSessionId(content, path, root, conversationId)` → `ensureMemoryDirectory` → tmp+rename 原子写；
- `edit {path, edits: [{oldText, newText}]}`：safe 判定 → 读 → 顺序应用（每个 oldText 必须在当前内容中恰好出现一次，否则整单失败报错）→ 盖章 → 原子写。

工具 schema 用 typebox 定义、`name/description/parameters` 形状与主会话工具一致（模型已熟悉 `{path, content}` / `{path, edits}` 接口）。所有 execute 前置 `signal.throwIfAborted()`。

### 6.8 记账、错误、关停

- **记账**：每轮 `answer.usage` 累加，循环结束 best-effort 写 UsageDoc（对齐 compaction `:681-694`："Accounting is best effort; it must not turn a usable summary into a failed compaction"——提取同理，记账失败绝不让提取报错）。
- **失败语义**：模型请求异常 → 该 snapshot 记 error、不推进 cursor（下个 run 重看）；abort → aborted、不推进；正常结束（无论是否写了文件）→ success 推进。不重试（ZCode 合同）。
- **关停**（`runtime.close()`，`:2365-2386`）：同步段加 `memoryExtraction.shutdown()`（在 `automationScheduler.close()` 旁）；closePromise 内 `harness.close` 之前 `await memoryExtraction.drain(60_000)`。SIGINT/SIGTERM → index.ts 的 close()（`:163-170`）自然覆盖。

### 6.9 demo 模型脚本（`src/server/demo-model.ts` 增补）

`demoMemoryExtractionResponse(request)`：最后一条 user 消息含 `'记忆提取子代理'` 时分派（插入 `scriptedResponse` 分派链，位于 compaction 识别之后）：

- 第 1 次调用（请求 messages 中 toolResult 数为 0）：返回 toolCall `write`（`<root>/user-prefers-zh.md`，content 含合法 frontmatter + 一个稳定事实）；
- 第 2 次调用：返回 toolCall `edit`（`MEMORY.md` 加一行指针——或直接 write 整个 MEMORY.md，脚本更简单）；
- 第 3 次调用：纯文本 `已保存。`（无 toolCall → 循环结束）。

skip 场景（断言不发起提取）：不需要脚本，靠 `observeDemoRequests` 断言零提取请求。

### 6.10 Phase 3 验收（对齐 memory-plan.md §7）

- demo 端到端：提交含稳定事实的对话（`[memory-demo]` 标记触发默认脚本或直接自然对话）→ 显式 drain（轮询记忆目录出现文件，**不靠 sleep**）→ 断言：事实文件带盖章 frontmatter、`MEMORY.md` 增加指针行、`observeDemoRequests` 里提取请求的 tools 恰为 `[read, list_files, search_files, write, edit]` 且 systemPrompt 含 root 与 manifest。
- skip 两分支：run 内模型直接写过记忆（demo 脚本先 write 记忆文件再结束）→ 下一 run 不发起提取；纯 `[prompt-probe]` 短文本 run → 无提取请求。
- 开关关闭：提交后零提取请求（请求记录断言）。
- stop/重启：`holdNextDemoResponse` 卡住提取请求 → `runtime.close()` → 无半写文件（原子写保证）、重开后 cursor 重置不崩溃。
- coalescing：连发 3 个提交快速 settle → 至多 1 running + 最终 1 次提取覆盖全部（请求计数断言）。

---

## 7. 测试计划（新文件与既有文件改动）

| 文件 | 覆盖 | 模式 |
| --- | --- | --- |
| `tests/memory.test.ts`（新） | root 计算（slug/hash/win32/中文回退）、contained/safe 判定（20 敏感段逐项 + 归一化变体：`head.`、`config:ads`、零宽、尾空格、`\` 分隔）、索引规范化（200/25000 边界、WARNING 三形态、mdast 注释剥离：顶层删/代码块留）、盖章（补章/幂等/CRLF/BOM/语法错/无 frontmatter/metadata 非 map/非 memory 路径直通） | 纯函数，无 fixture（照 `work-policy.test.ts` 的直调模式） |
| `tests/memory-policy.test.ts`（新） | 两个 section 的 render（fake `promptInput` + 临时目录 MEMORY.md：loaded/missing/error/空/超限；readOnly 判定：tools 无 write/edit 且 plan 未激活 → undefined；plan 激活 → 渲染） | 纯函数 + mkdtemp（照 `work-policy.test.ts:72-87`） |
| `tests/memory-extraction.test.ts`（新） | 运行决策（direct-write/prose 的消息工厂用例）、调度器（单槽合并/skip 推进/error 不推进/shutdown 丢弃——ZCode `memory-extraction.test.ts` 12 例的 pi-ai 适配版）、受限循环（拒绝文案逐字且不调 executor、5 轮上限、abort） | 消息工厂 + fake models.completeSimple/complete 计数（照 `compaction.test.ts:412-452`） |
| `tests/execution-policy.test.ts`（改） | plan 例外谓词：memory .md 凿穿、敏感段/root 外/非 write-edit 不凿穿、谓词未注入时行为不变 | 既有文件追加 |
| `tests/runtime-policy.test.ts`（改） | 端到端请求断言：`<memory>`/`<memory-index>` 节存在性与开关响应（`observeDemoRequests` + `currentRequest`） | 既有模式 |
| `tests/runtime.test.ts`（改） | demo 端到端提取（§6.10 场景矩阵）、workspaceWrite 沙盒放行、设置往返（`updateSettings({memoryEnabled:true})` 后请求形态变化） | 既有 fixture/restart 模式 |

---

## 8. 与 ZCode 的有意差异清单（全部）

| # | 差异 | 理由 |
| --- | --- | --- |
| D1 | readOnly 不放行记忆写入（ZCode 在其 readOnly 语义下仍放行） | pi-web 的 readOnly 是工具面级裁剪（物理无 write/edit），守住"只读会话零写面"承诺（memory-plan.md D1 + windows-support.md） |
| D2 | plan 放行改为 execution-policy 例外谓词（ZCode 是权限链尾部改写） | pi-web 无权限审批链；单一事实源留在 plan 拦截处（memory-plan.md D2 预留路径） |
| D3 | 索引每请求重读、独立 system section（ZCode 会话冻结 + `# agentsMd` 聚合） | pi 的 section 体系里 AGENTS.md 本就是独立节；重读模式是本仓现成先例（project-instructions），且中途提取的索引更新下一请求即可见 |
| D4 | 不移植 readFileState 种子，改提示词约束"改 MEMORY.md 前先 read" | pi 无 read-before-write 硬校验机制可挂（memory-plan.md D4） |
| D5 | 提取执行自建 `Models.complete` 循环 + 自建工具 executor（ZCode 复用 createToolExecutor + Main 工具目录 + 媒体投影） | pi-ai 无对应 executor 设施；本仓 compaction/title 已确立"宿主侧独立请求"惯例（D3）。工具目录只含白名单 5 个（ZCode 给 Main 全集、执行侧收窄）——目录即第一道防线，策略判定仍是第二道 |
| D6 | cursor 用 EntryRecord.id、per-conversation 调度器（ZCode：durable message UUID、per-runtime 单调度器） | pi-web 单 Host 多会话；run 粒度天然以 submission 为界，无 ZCode 的 rewind/branch 复杂度 |
| D7 | edit 盖章为后置补章（ZCode 在 handler 落盘前对 write/edit 统一前置盖章） | pi 原生工具内部不可侵入；write 等价前置，edit 只能后置（幂等盖章使竞态无害） |
| D8 | workspaceWrite 需扩展执行环境可写根（ZCode 无此层） | pi-web 的沙盒语义是本仓既有承诺；不扩展则 workspaceWrite 会话记忆写入被 env 拒绝 |
| D9 | 提示词中文化；`Nothing to save.` 与字段名/类型枚举保持英文 | memory-plan.md 既定决策；合同记号保持逐字便于断言 |
| D10 | 剥顶层 HTML 注释用 mdast（ZCode 用 marked Lexer） | 本仓依赖集已有 mdast 生态、无 marked |
| D11 | bash 不进提取白名单（ZCode 允许只读 bash + 窄化 rm） | 本仓 bash 无只读分类器可复用（memory-plan.md §6 既定收紧） |
| D12 | manifest 扫描不依赖 FileSystemPort 抽象（ZCode 经 port） | pi-web 宿主侧直接 node:fs，扫描器自含边界（不跟目录符号链接、30 行预览、200 上限逐项对齐） |

## 9. 非目标（v1 不做，重申）

语义召回（selector/manifest 注入只服务提取 prompt）、Dream 与 `memory_update`、custom agent 记忆、记忆查看 UI（Settings 三级导航——Phase 4，落地前先修订本文）、记忆编辑/删除/搜索/导出、跨机器同步、旧数据迁移（无迁移源）、workspaceIdentity 独立身份。

## 10. 实施顺序与规模预估

| 阶段 | 新增/改动文件 | 预估行数（新增净额） |
| --- | --- | --- |
| Phase 1 | 新 `memory.ts`、`memory-policy.ts`、`tests/memory.test.ts`、`tests/memory-policy.test.ts`；改 `runtime.ts`（装配 4 处）、`execution-env.ts`（签名兼容式扩展，Phase 2 用）、设置五处 | ~600 |
| Phase 2 | 改 `memory-policy.ts`（wraps）、`execution-policy.ts`（谓词）、`execution-env.ts`（extraWriteRoots）、`runtime.ts`（装配谓词）、两测试文件 | ~250 |
| Phase 3 | 新 `memory-extraction.ts`、`tests/memory-extraction.test.ts`；改 `runtime.ts`（submit 挂点 + close）、`demo-model.ts`（脚本）、`runtime.test.ts` | ~550 |

每阶段独立可合入、独立验收（对齐 memory-plan.md §7 的阶段边界）；Phase 2 的 execution-env 改动在 Phase 1 一并落地签名（默认空数组零行为变化），减少两阶段间的接口抖动。
