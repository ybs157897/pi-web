# 项目记忆系统实施方案（参照 ZCode Memory）

状态：已实施（2026-10-26，Phase 1–3）。代码级设计见 [memory-design.md](./memory-design.md)；`docs/spec.md` 记录了落地范围与验收判据，`docs/architecture.md` 的「Workspace memory」小节记录了最终挂点。Phase 4（只读查看 UI、语义召回、Dream、custom agent 记忆）仍未开始。

> 代码级落地设计见 [memory-design.md](./memory-design.md)（基于 ZCode memory 全部源码与 pi-web 挂点的逐行对照分析，含每个函数的行为设计、中文提示词定稿、wrap/沙盒/提取循环的代码骨架与测试矩阵）。本文保留决策记录角色；两文冲突时以 memory-design.md 为准。

参照系：[zai-org/ZCode](https://github.com/zai-org/ZCode) 开源仓库的 Memory 设计 v4（ZCode 仓 `apps/zcode-cli/docs/design/v2/memory/README.md`）及其实现详解（ZCode 仓 `docs/analysis/zcode-memory-system-implementation.md`）。ZCode 的行为合同以那份 spec 为准；本文只搬运与 pi-web 架构兼容的部分，并明确列出取舍。

## 1. 目标

为 pi-web 增加**跨会话的项目记忆**：每个工作区一份持久记忆目录，会话内自动注入索引、自动放行记忆写入、成功回合后后台提取新事实。与 compaction 的分工沿用 ZCode 的边界——compaction 维持当前会话连续性，memory 保存跨会话可复用事实；两者互不读写对方状态。

ZCode 的五个能力中，v1 落地前三个，后两个后置：

| ZCode 能力 | v1 决策 |
| --- | --- |
| 1. Memory 文件协议 + provider-visible system section | **做** |
| 2. retrieval 双分支 | 只做 `default-index`（MEMORY.md 索引注入）；`semantic-recall` 整体后置（ZCode 自己也默认关闭该分支） |
| 3. 成功回合后的后台 Extraction | **做** |
| 4. Dream 整合与 `memory_update` | 后置（ZCode 当前也未接线自动触发） |
| 5. custom agent 三 scope 记忆 | 后置 |

## 2. 存储与身份

```
<pi-web 数据目录>/memories/projects/<slug>-<hash16>/memory/
  MEMORY.md          # 短索引，一行 "- [Title](file.md) — hook"，无 frontmatter
  <fact-name>.md     # 每个事实一个独立小写 .md 文件
```

- 数据目录即现有 `dataDir`（`src/server/index.ts:58`，默认 `~/.pi-web`，`PI_WEB_DATA_DIR` 可覆盖）。SQLite 继续只在 `pi-durable.sqlite`，记忆是纯文件——与 ZCode 一致：**文件即记忆，不建表**。
- 隔离键：pi-web 的 workspace 没有独立 identity（`app-state.json` 存 id + path），v1 用 `workspace.path` 规范化绝对路径（Windows 参与散列前转小写）。`<slug>-<hash16>` = `sanitize(basename) + sha256(key).slice(0,16)`，照搬 ZCode `resolveProjectMemoryRoot`（`core/src/memory/project-root.ts:10-33`）。
- 事实文件 frontmatter 协议照搬 ZCode：`name` / `description` / `metadata.node_type: memory` / `metadata.type: user|feedback|project|reference` / `metadata.originSessionId`；feedback/project 正文含 `**Why:**` 与 `**How to apply:**`；`[[name]]` 双链允许悬空。
- 路径安全照搬 ZCode `memory-file-path.ts`：containment 判定 + 20 项敏感段列表（`.git`、`node_modules`、`skills`、`agents` 等）+ 段名归一（零宽字符 / Windows ADS / 尾部点空格）。这一层是纯函数，可直接移植测试。

## 3. 挂点映射（ZCode → pi-web）

| ZCode 挂点 | ZCode 位置 | pi-web 对应 |
| --- | --- | --- |
| `# Memory` system 节 | `context/builder.ts:152` + `context/sections/memory.ts` | memory extension 的 `section("memory", ...)` |
| MEMORY.md 索引 → 首条 user message `# agentsMd` 块 | `context/sections/request-user-context.ts` | memory extension 的 `section("memory-index", ...)`，**每请求渲染**，模式照抄 `projectInstructionsSection`（`src/server/work-policy.ts:130-132`） |
| 前台 memory 写入放行 | `tool/executor/memory-file-permission.ts`（权限链尾部改写 decision） | wrap `write`/`edit` 的 `execute`（`createExecutionPolicyExtension` 的 wraps 模式，`src/server/execution-policy.ts:44-66`） |
| originSessionId 盖章 | Write/Edit handler 落盘前（`tool/handlers/write.ts:118`） | 同上：wrap 内在调用原 `execute` 前改写 `content` 参数 |
| 成功 Main turn 后调度提取 | `runtime/methods/turn.ts:947` | runtime 层 `submission.wait()` settled 且 `done` 后 fire-and-forget（见 §6） |
| session close 终止提取 | `beginShutdown` + drain（`session-facade.ts:289`） | `app.shutdown()`（`src/server/index.ts`）中 abort 提取任务 |
| readFileState 种子（索引先读后写） | `runtime/methods/context.ts:187` | 无对应硬机制：pi 的 write/edit freshness 靠 prompt 约定。v1 用 prompt 约束（见 §5 决策 D4），不移植 |

两条注入链路的形态差异要明示：ZCode 把 MEMORY.md 塞进首条 user message 的 `# agentsMd` 块是为了与 AGENTS.md 共用一条 instruction source；pi-web 的 sections 体系里 AGENTS.md 本来就是独立 section（`project-instructions`），所以 MEMORY.md 做成**独立 section** 是自然映射，不复制 `# agentsMd` 聚合语义。

## 4. 开关

单一开关：`settings.json` 增加 `memoryEnabled`（默认 `false`），随现有 `appState` 设置读写与设置页暴露。

- 关闭时：不注册 memory extension 的 section 与 wrap（或安装 extension 但 section 返回 `undefined`——pi 的 section 返回 `undefined` 即省略），不创建记忆目录，不调度提取，wrap 不放行任何路径。
- 生效边界：pi-web 是单进程单 Host，没有 ZCode 的三层冻结问题；但 sections 每请求渲染、agent 选择 per-conversation 存储，行为天然是"下一请求生效"。唯一需要显式对齐的是 `buildAgentChange`（`src/server/runtime.ts:909`）——memory extension 名要加进 `extensionNames` 的必选集合（`:921`，与 `WORK_POLICY`/`COMPACTION`/`EXECUTION_POLICY` 并列）还是走默认全选，取决于是否希望 Preset 能排除它；建议进必选集合（记忆是平台能力，不是 Preset 选项），关闭靠 `memoryEnabled` 过滤。
- 关闭态不等于删除：已写入的记忆文件保留，重新开启后继续可用（同 ZCode Settings viewer 语义）。

## 5. 关键设计决策

- **D1 只读模式不放行记忆写入。** ZCode 在 readOnly（其权限模式）下仍放行 memory 写；pi-web 的 `readOnly` 是工具面级裁剪（`buildAgentChange`，`src/server/runtime.ts:935` 的 `READ_ONLY_TOOLS` 直接不注册 write/edit），保持"只读会话零写面"更符合 pi-web 现有语义（`windows-support.md` 对 readOnly 的承诺也是工具面级的）。记忆写入只在 `fullAccess` / `workspaceWrite` 提供。
- **D2 Plan 模式放行记忆写入。** ZCode 明确"合格 Memory 写入先于 plan-mode block"。pi-web 需要处理与 `execution-policy` 的叠加：plan 激活时其 wrap 会拦一切非 `PLAN_TOOLS` 工具（`src/server/execution-policy.ts:18-28`）。做法：把 memory 放行判断做在 execution-policy 的 plan 检查**之前**——在 memory wrap 内先判定"目标是安全记忆 .md"则直接放行；wrap 叠加顺序要在 extension 安装顺序上保证 memory 在 execution-policy 内层（实施时验证 pi 的 wraps 合成顺序，若顺序不可控则把例外并入 execution-policy 的 plan 判定，保持单一事实源）。
- **D3 后台提取不进主 conversation。** ZCode 的 Extraction 是冻结快照 + 受限 loop 的独立执行体（不产生 UI 事件、`skipTranscript`）。pi-web 对应用法：在 runtime 层用 pi-ai 直接发一次受限生成请求（白名单工具 + 自建 executor），**不**向主 conversation submit——避免污染 transcript、触发投影流与用量归属混乱。上下文取该 settled run 的 transcript 尾部（`getCurrentTools` 同源的 transcript 读取 API），等价于 ZCode 的"冻结快照"。
- **D4 不移植 readFileState。** ZCode 的索引 read-state 种子服务于其 read-before-write 硬校验；pi 的 write/edit 无此硬机制（`work-policy` 的"改文件前先 read"是 prompt 约定）。v1 接受这一点，在提取 prompt 与 `# Memory` section 中显式要求"改 MEMORY.md 前先 read"。
- **D5 提取模型与预算。** 沿用会话当前模型（pi-web 无独立辅助模型配置），thinking 取该模型最低档；提取请求 maxTokens 保守设置。ZCode 的 selector/extraction 共用 `auxiliaryModelOptions`（≤5000 tokens、最低推理档）可作默认值参考。

## 6. 后台提取设计

> 落地差异（2026-10-26）：实现以 [memory-design.md](./memory-design.md) §6 为准——调度器有 per-conversation cursor（`EntryRecord.id`；success/skip 推进，error/abort 不推进），工具白名单是 `read` / `list_files` / `search_files` / `write` / `edit`（不提供 bash），快照会剥掉主会话的 system 消息以免把主会话工具目录带进提取请求。

触发链（对应 ZCode `turn.ts:947` → `scheduleProjectMemoryExtraction`）：

```text
sendInput（src/server/runtime.ts:1164 conversation.submit）
  └ fire-and-forget: submission.wait(CTX)          // 不阻塞 HTTP 响应
       └ settled.status === 'done' 且 memoryEnabled 且会话非只读
            └ scheduleExtraction(conversationId)    // one-running + latest-pending
                 ├ 运行决策（ZCode extraction.ts:68-83 的直接移植）：
                 │   本 run transcript 内已有 write/edit 落进 memory root → skip
                 │   无任一 ≥3 words 的真实用户文本 → skip
                 ├ buildExtractionPrompt（含 manifest 与 "Nothing to save." 合同）
                 └ 受限执行（最多 5 个模型轮次）：
                     工具白名单：read/glob/grep 只读；write/edit 仅 memory root 内安全 .md；
                                 bash 不提供（v1 收紧——ZCode 允许只读 bash 与受限 rm，pi-web 的 bash 无只读分类器可复用，先不给）
                     拒绝以 tool result 回流模型（文案照搬 ZCode memory-agent-loop.ts:279-298）
```

- 调度器语义照搬 ZCode：单 running 槽 + 最新 pending 槽（coalescing），无队列无持久化；skip 也推进（这里是 run 粒度，无 cursor——pi-web 的提交天然以 run 为界，比 ZCode 的 message UUID cursor 简单）。
- 关闭链：`app.shutdown()` 中 abort 提取（单一 AbortController 贯穿生成请求与工具执行），丢弃 pending；pi-web 是进程退出场景，无需 ZCode 的"单会话关闭后进程存活"长尾，但有 automation-scheduler 等长生命周期，提取任务必须挂在可关停的注册表上。
- 幂等与安全：提取自身不写 transcript、不计入会话用量展示；写记忆文件经与前台相同的 wrap（盖章 originSessionId = 主会话 conversationId）。

## 7. 分阶段实施

### Phase 1：存储 + 注入（纯增量，可独立合入）

- 新增 `src/server/memory.ts`：root/key 计算、路径安全、索引规范化（剥 frontmatter/顶层 HTML 注释、200 行 / 25,000 字符截断 + warning）、`MEMORY.md` 读取（复用 `project-instructions.ts` 的稳定读取模式：O_NOFOLLOW、size/mtime 复检——它的实现就是现成模板）。
- 新增 memory extension（`src/server/memory-policy.ts`，命名对齐 `work-policy.ts`）：`section("memory", ...)` 渲染保存规则（文案中文化，结构对齐 ZCode `context/sections/memory.ts`：root 声明、frontmatter 模板、四类型、"不该存"清单）；`section("memory-index", ...)` 每请求读 `MEMORY.md` 渲染索引（空/缺失返回 `undefined` 省略）。
- `settings.json` + 设置页 `memoryEnabled` 开关（默认关）；`runtime.ts` 装配接入。
- 验收：开启后新建会话，模型请求的 system prompt 含两个 section；手工放入 `MEMORY.md` 与事实文件后，跨会话、重启、compact 后注入仍在；关闭后 section 消失且无文件读取；`tests/memory.test.ts` 覆盖 root 计算、截断、边界（空/超限/非法 UTF-8/symlink）。

### Phase 2：写入放行 + 盖章

- memory extension 增加 wraps：`write`/`edit` 执行前判定 memory root 内安全 `.md` → 放行（覆盖 plan 拦截，见 D2）并在参数上盖章（`stampOriginSessionId` 逻辑照搬 ZCode `origin-session.ts:8-51`：仅在 `originSessionId` 缺失时补，`node_type` 强制首键，YAML AST 保格式，行尾保真）。
- readOnly 会话不注册（D1）；fullAccess/workspaceWrite 下 plan 激活时验证仍可写记忆。
- 验收：plan 模式与正常模式下模型可通过 write/edit 写入记忆目录且自动盖章；root 外与非 `.md` 走原权限；敏感段路径被拒；`tests/` 增 wrap 判定与盖章单测（含已有 origin 不覆盖）。

### Phase 3：后台提取

- `src/server/memory-extraction.ts`：调度器 + 运行决策 + 受限生成执行（D3/D5）。
- `sendInput` 挂 `submission.wait()`；`app.shutdown()` 关停。
- 验收：demo 模型（`PI_WEB_DEMO=1`）下端到端——对话中出现稳定事实 → settled 后（显式 drain，不靠 sleep）记忆目录出现带盖章的事实文件且 `MEMORY.md` 增加指针；直接写过记忆的 run 不再提取；无用户长文本的 run 跳过；关闭开关后零提取请求（以 demo 模型的请求记录断言）；stop/重启不产生半写文件。

### Phase 4（后置，不在本方案承诺内）

只读查看 UI（设置页项目列表 → 文件 → 正文，5 MiB 上限，复用 ZCode `IMemoryService` 的错误码语义）、semantic-recall 选择器、Dream、custom agent 记忆。任何一项启动前先修订本文。

## 8. 非目标（v1 明确不做）

- 记忆的编辑/删除/搜索/导出 UI；跨机器同步。
- 语义召回、关键词打分、任何检索模型调用（default-index 之外的一切 retrieval）。
- Dream/自动整合、`memory_update` 注入。
- 旧数据迁移（pi-web 此前无记忆系统，无迁移源）。
- `workspaceIdentity` 独立身份（沿用 path；若未来 workspace 增加稳定 identity 再切换隔离键，目录格式已预留 hash 段）。
- ZCode 的 provider-visible fixture 逐字冻结验收——pi-web 没有等价的 golden 测试体系，文案以本仓 section 单测锚定；引入 fixture 体系待规模需要时再议。
