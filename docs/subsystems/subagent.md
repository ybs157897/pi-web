# 子智能体（subagent）

> 状态：现状参考（2026-11-09 自 docs/families.md §5 抽取）。决策与验收历史见 docs/spec.md 对应日期段。

`subagent` 工具把一个自包含任务委派给在独立子会话中工作的智能体：一次调用创建一个 task-owned 子会话、等待其答案并把最终回答作为工具结果返回；失败原因走 diagnostic 通道，保持答案正文干净（[subagent.ts:109](../../src/server/tools/subagent.ts)）。子会话继承父会话的 agent 组合（工具、模型、工作目录），但不继承消息，所以任务必须自包含。工具参数：`task`（必填，≤20,000 字符）、`label`（≤60 字符，缺省取 task 首行）、`agent_type`、`model {provider, modelId}`、`run_in_background`（[subagent.ts:237](../../src/server/tools/subagent.ts)）。`replay: 'safe'`：崩溃后重放的调用按 taskId 扫描（`scanConversations({ownerTaskId})`）复用已创建的子会话，不重复委派。

## 内置 profile

两个内置委派 profile 定义在 [builtins.ts:27](../../src/server/agents/builtins.ts)，profile 的 systemPrompt 整体替换子会话复制的父指令，子会话以 profile 身份运行：

- `general-purpose`（默认）：继承父会话的工作工具面，适合实现、修复和复杂多步调研。
- `Explore`：只读检索。工具面收窄为 `EXPLORE_TOOLS`（`read / glob / grep / list_files / search_files`，[subagent-policy.ts:29](../../src/server/conversation/subagent-policy.ts)）与父工具取交集；父会话没有 `read` 路由时报错拒绝；当 `read` 只能经 codemode 路由时保留 `codemode` 本身（[subagent.ts:135](../../src/server/tools/subagent.ts)）。

所有委派子会话（无论 profile）在暴露与执行两层都被剥夺计划、问答、目标、委派与团队工具（`CHILD_FORBIDDEN_TOOLS` 加 `team_task_*` 前缀，[subagent-policy.ts:31](../../src/server/conversation/subagent-policy.ts)）——委派只有一层，子会话不能再委派。

## 委派契约与提示词裁剪

委派契约由工具描述与 `delegation-policy` section 共同表达：任务写明目标、范围、约束与授权、验收标准、只读还是允许写入、要返回的证据与格式；子会话共享工作目录，要求指定不重叠的写入范围并保留范围外的改动。`delegation-policy` 只在本请求可调用 `subagent` 或 `spawn_teammate` 时注入，委派出去的子会话自身不注入（[subagent.ts:171](../../src/server/tools/subagent.ts)，变体注入矩阵见 [section-catalog.md](../section-catalog.md)）。

子会话的提示词按身份裁剪：vendored pi-durable 的保留 `instructions` section 向委派子会话注入 profile 的 systemPrompt，主会话不含（[section-catalog.md](../section-catalog.md) 的 instructions 条目）；`work-policy` 对子会话收窄条款（去掉计划模式入口指引）；`project-instructions`（工作区 AGENTS.md）对 Explore 子智能体不注入（[work-policy.ts:119](../../src/server/conversation/work-policy.ts)）；`skills-policy` 对 Explore 不注入、`goal-policy` 对所有子会话不注入。

## 调用时模型选择

`model {provider, modelId}` 经 `createChildModelResolver` 校验：目录 `getModel` + 白名单 `modelWithinAllowlist` + 把父会话 thinking level 夹到所选模型支持的档位，越界抛 `MODEL_UNAVAILABLE`（[builtins.ts:98](../../src/server/agents/builtins.ts)）。覆盖经 `configure(tx, childId, AgentChange)` 在创建 commit 内写入——`Tx.createConversation` 只收 `{ownership}`，agent 覆盖必须走 `configure`（[subagent.ts:265](../../src/server/tools/subagent.ts)）。`delegation-policy` 的模型行列出白名单内且有凭据的模型（最多列 12 个，超出以「等 N 个」收尾），供模型给轻量任务挑更快的模型。

## 后台委派与结算

`run_in_background: true` 时调用立即返回 activation（子会话仍在运行的提示文本），子会话以独立 requestId（`subagent:<taskId>:bg`）提交，结算由 runtime 的结算器投递（[subagent.ts:295](../../src/server/tools/subagent.ts)）：

- 工具 `api` 派生的一切 handle（含 `child.submit` 返回的 submission）都绑定工具 invocation、随调用结束失效，因此结算完全经 `harness()` 重解析并以 `conversation.watch` 观察子会话（[subagent-settle.ts:106](../../src/server/runtime/subagent-settle.ts)）。
- 子会话 run 结束后，向父会话注入带幂等 requestId（`subagent-settle:<toolTaskId>`）的 `[subagent-settlement]` 消息，entry kind 为 `pi-web.subagent-settlement`，`whenBusy: 'followUp'`；requestReceipts 幂等检查保证重试/重放/重启不重复注入（[subagent-settle.ts:52](../../src/server/runtime/subagent-settle.ts)）。父会话计划模式仍开启时在结算消息尾部附注「把结论并入计划，不要开始实施」。
- 崩溃丢失的结算在启动时由 `reconcileBackgroundDelegations` 扫描全部未投递的 background 委派记录补投一次（[subagent-settle.ts:165](../../src/server/runtime/subagent-settle.ts)）；runtime 关闭前 `drain` 有界等待 60s。

## 委派路由规则

独立并行的一次性子任务——哪怕大量并行、哪怕互相交叉校验——一律路由到 `subagent`，结论直接随工具结果回传；`spawn_teammate` 只用于需要共享任务板或成员间持续消息往来的长时协作（队友结论文本不会自动回流）。该取舍写在 `spawn_teammate` 工具描述与 `delegation-policy` 文案里（[subagent.ts:193](../../src/server/tools/subagent.ts)），见 [team.md](team.md)。

## 投影与一行条 UI

每个子会话的 `pi-web.subagent` 文档（`Subagents`，conversation 作用域）记录身份：`label / createdAt / profile / delegation`（[subagent-policy.ts:20](../../src/server/conversation/subagent-policy.ts)）。投影层把它与 live 状态合成 `ConversationDetail.subagents`（`SubagentSummary`：`status` 只有 `running | inactive`，没有 failed——失败要靠工具结果判断，[types.ts:673](../../src/shared/types.ts)）；HTTP 侧有 `GET /api/conversations/:id/children` 与 `POST .../children/:childId/messages|stop`（[app.ts:526](../../src/server/app.ts)）。子会话因 owner 边界不进侧栏，由会话头触发器与卡片进入。

转录正文的一行条（`SubagentRunStrip`）规则（[subagent-run-model.ts:41](../../src/web/subagent-run-model.ts)）：

- 同一回合 ≥2 个连续顶层 `subagent` 调用折成一条横向条带；单个顶层调用保留 ZCode 风格单行 `ToolCard`。
- codemode 脚本里的嵌套 `tools.subagent` 调用 1 个也折（`source: 'codemode'`，置于脚本卡之前）——`ToolCard`/`CodemodeBody` 已隐藏这些嵌套行，条带与过滤互为一对。
- 每个子会话一个稳定颜色（6 色循环，按 `subagents` 列表下标，未匹配时按 id 哈希兜底）；状态为创建中/运行中/已完成/失败，失败从工具结果 isError 或 call.status 推导；label 匹配走精确 → 前缀 → 已完成调用按最新子会话顺序兜底，创建中的调用不得抢占已有子会话。
- 抬头在运行中显示 `{已结束}/{总数} 结束`，全部完成后显示「N 个子智能体已完成」，有失败显示「N 个已完成 · M 个失败」；运行中有子会话时前端 1.5s 轮询 `listChildren`（[transcript.tsx:162](../../src/web/transcript.tsx)）。
- 点 chip 在右侧 Inspector 打开该子会话的只读转录 tab（`SubagentPane`，`openSubagentTab`），同一 childId 只开一个 tab，不替换主列会话（[App.tsx:1618](../../src/web/App.tsx)）。右侧状态卡「已结束的智能」页脚行打开子智能体目录（`SubagentDirectory`，按正在运行/已结束分组）。

## 已知限制

- 委派限制为一层：子会话不能再委派（[subagent-policy.ts:38](../../src/server/conversation/subagent-policy.ts)，spec 2026-11-04 段的执行层收口）。
- `SubagentSummary.status` 无 failed 语义，失败态只能从工具结果推导；条带的失败态由纯函数单测锁定。
- 「创建中」瞬态在真实运行里往往过快不可见，由 `tests/subagent-run-model.test.ts` 锁定状态文案（spec 2026-10-28 段）。
- codemode 嵌套调用未启动时不在 `item.children` 里，条带先少一个、启动后补齐——渐进渲染，不是数据丢失。
- 单个顶层调用仍走单行 `ToolCard`，其状态词是「运行中/已完成」，不显示「创建中」（有意保留的已验收交互）。
