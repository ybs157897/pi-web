# 单入口与任务（tasks）

> 状态：现状参考（2026-11-10 自 feat/single-session-task-view 抽取）。决策与验收历史见 [spec.md 2026-11-10](../spec.md#2026-11-10)。

产品只有一个任务入口：用户描述要做的事，服务端创建一个任务会话并在其中执行；界面按任务维度展示，不再提供多会话列表。

## 领域

| 概念 | 承载 | 规则 |
|---|---|---|
| 主会话（main） | `kind === 'main'` 的 ownerless 会话 | 启动时 `ensureMain` 幂等创建，零工作区也能建；本身不跑模型回合，只作为任务的所有者 |
| 任务（task） | `kind === 'task'` 的 ownerless 会话 + `pi-durable-web.task` 记录 | 每个任务独立上下文、独立 busy，可并行；`parentId` 回指主会话；结算/重试计数落在独立记录 |
| 执行（run） | Pi 会话自身的回合 | 展示状态从投影读出；终态另写一次性结算到任务记录与主会话收件箱 |

任务在 Pi 存储层是 ownerless 会话，不在主会话的 owner 子树里：主会话的 abort、idle 等待与级联不会波及任务。与 DSH Super-agent 的对应关系：Main Session ≈ 主会话，Ticket ≈ 任务，Assignment ≈ 任务的 run，Report ≈ 任务投影状态；Source / Trigger / Eval / Mandate 不在本层。

## 创建与提交

`POST /api/tasks`（[app.ts:352](../../src/server/app.ts#L352)，schema 见 [app.ts:87](../../src/server/app.ts#L87)）接受 `CreateTaskInput`：`text` 与 `requestId` 必填，可选模型、思考等级、工作区、访问模式、图片与附件。

`createTask`（[tasks.ts:115](../../src/server/runtime/tasks.ts#L115)）按序执行：

1. `ensureMain()` 解析主会话 id；
2. 复用会话引擎 `create`（工作区校验、访问模式、agent 配置、metadata 写入）；
3. 同 commit 在 `conversation-kind` 写 `kind = 'task'` 与 `parentId`，并在 `pi-durable-web.task` 写 `originRequestId` 与 `attempt = 1`；
4. 复用会话提交路径投递首条输入（requestId 幂等、附件保存、标题回退都在那里）；
5. 返回完整 `ConversationDetail`。

任务内追问直接走既有 `POST /api/conversations/:id/messages`；停止、中断、计划模式、问答卡片沿用会话路由，不改语义。

## 状态投影

`taskStatusOf`（[tasks.ts:27](../../src/server/runtime/tasks.ts#L27)）是纯函数，判定顺序即优先级；前端 `taskFromDetail` 与服务端保持同一顺序：

| 优先级 | 条件 | 状态 |
|---|---|---|
| 1 | `interactions` 中存在 `status === 'pending'` | `waiting` 等待回答 |
| 2 | `conversation.busy` | `running` 运行中 |
| 3 | `queue.length > 0` | `queued` 排队中 |
| 4 | `conversation.status === 'error'` / `'cancelled'` / `'completed'` | `failed` / `cancelled` / `completed` |
| 5 | 其余 | `idle` 空闲 |

`TaskSummary` 其余字段：`preview` 取最后一条 assistant 文本块压成单行截 120 字符；`attention` 是「为什么需要人」——waiting 取待答问题、failed 取错误、cancelled 取「已停止」，截 80 字符；`turns` 统计 user 消息条数；`runStartedAt` / `durationMs` / `unread` / `model` / `thinkingLevel` / `workspaceId` 直接来自 `ConversationSummary`。

## 任务列表

`GET /api/tasks`（[app.ts:351](../../src/server/app.ts#L351)）→ `{ tasks: TaskSummary[] }`，按 `updatedAt` 倒序。

`list`（[tasks.ts:136](../../src/server/runtime/tasks.ts#L136)）分三步：扫描全部 ownerless 会话 → 读 `conversation-kind` 只留 `kind === 'task'` → 对每个任务做完整 `ConversationDetail` 投影再降维成 `TaskSummary`。未标 kind 的历史会话不出现在列表里，但仍可按 id 打开详情、提交与停止。

## 任务记录与结算

任务不只靠投影：每个任务有一份 `pi-durable-web.task` 记录（[helpers.ts](../../src/server/runtime/helpers.ts)），字段 `originRequestId` / `attempt` / `settledAt` / `deletedAt` / `settlement`。`deletedAt` 已预留，删除逻辑尚未实现。

- **结算（settle）**：任务进入 completed/failed/cancelled 且 `settledAt` 未置时，写 `settledAt` 与 `settlement = {status, summary, at}`，并向主会话的 `pi-durable-web.task-inbox` unshift 一条 `{taskId, title, status, summary, at}`，截断到 50 条。幂等：commit 前后各查一次 `settledAt`，重复 list 不重复追加。
- **读路径补结算**：`list` 投影后对终态任务逐个 settle（各自独立 commit）。
- **启动扫描（reconcile）**：`ensureMain` 之后扫描全部 task 会话；无 user 消息的是 createTask 提交首条消息失败留下的孤儿，标 `settlement = {status:'failed', summary:'创建后未提交首条消息'}`（不删会话、不进收件箱）；其余终态走 settle，非终态不动。

收件箱目前只落记录，入口页汇总 UI 尚未消费它。

## 前端

| 位置 | 行为 |
|---|---|
| 侧栏三段式（[App.tsx](../../src/web/App.tsx)） | 「需要你」（waiting/failed/cancelled，带计数 badge，仅 >0 渲染）→「进行中」（running/queued）→「已完成」（completed/idle，默认折叠带计数）；段内按 updatedAt 倒序 |
| 任务行 `TaskRow` | 状态点/转圈、标题、副标题（需要你显示 `attention`、进行中显示 preview 或「运行中」、已完成显示 preview）、未读点、「等待回答」标签、相对时间 |
| 入口页 | 未选中任务时展示欢迎区与 Composer；提交调 `api.createTask`，成功后写入任务行并切到新任务 |
| 任务头 + 三视图 | topbar 下方任务头显示状态徽标 + 当前动作 + 「过程 / 变更 / 总结」tab（[TaskViews.tsx](../../src/web/TaskViews.tsx)）。过程＝既有对话流；变更＝聚合 messages 的 write/edit 产物按 path 去重，点击开 diff；总结＝最后回答 + 轮数/时长/Tokens/改动文件/子智能体统计 |
| 视图默认与自动切换 | 选中任务时 completed 落总结、否则落过程；同一任务从非 completed 变 completed 且用户未手动切换 → 自动切总结；手动切换后不再强制 |
| 刷新 | 每 2 秒 `api.listTasks()`；当前任务 `detail` 变化时用 `taskFromDetail` 原位替换该行，不重建列表 |
| 已移除 | 工作区分组、会话行与搜索、归档、重命名、分叉、导出日志等会话管理入口；`SHORTCUT_COMMANDS` 同步收窄为仍有处理器的命令 |

## 边界

- 删除、重试、归档尚无 UI；`TASK` 记录已预留 `deletedAt` / `attempt` 作为落点。列表随会话数量线性增长。
- 孤儿任务（创建后首条消息提交失败）由启动 reconcile 标 failed 结算，不删会话；运行中任务的重启恢复依赖 Pi 会话自身的 resume，任务层不另做租约。
- `listTasks` 每个任务一次完整详情投影，任务多时是 O(n) 成本。
- 主会话只占位并持有结算收件箱，不承担派发、评估或汇总的模型回合。
- Automations / Wetrack 的深链 `onOpenConversation` 仍可打开非任务会话，这些会话不进入任务列表。
- 子智能体与团队成员的会话按 owner 边界本就不进顶层列表；任务内委派沿用 [subagent.md](subagent.md) 与 [team.md](team.md)。
