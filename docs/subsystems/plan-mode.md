# 计划模式（plan mode）

> 状态：现状参考（2026-11-09 自 docs/families.md §2 抽取）。决策与验收历史见 [docs/spec.md](../spec.md) 对应日期段。

## 状态与语义

计划模式是 conversation doc `pi-web.plan` 里的一个布尔（`{ active, updatedAt }`，[plan.ts:16](../../src/server/tools/plan.ts#L16)）。Pi 每次请求前重渲染全部 section，运行中改 doc 即在下一次请求生效——DSH 的「pending 计划模式」语义由此天然成立，无需额外状态。投影读为 `ConversationDetail.plan.active`（非显式 `true` 一律视为关，[projection.ts:480](../../src/server/conversation/projection.ts#L480)）。

## 进入、提交与退出

- 用户侧：`POST /api/conversations/:id/plan`（[app.ts:515](../../src/server/app.ts#L515)）走 `setPlan`；开启时递归把全部 task-owned 子会话一并置为计划模式，已创建的 worker 不能带着更宽的模式继续跑（[conversations.ts:360](../../src/server/runtime/conversations.ts#L360)）。
- 模型侧：`enter_plan_mode` 自行进入、无权限弹窗（[plan.ts:255](../../src/server/tools/plan.ts#L255)）；目标处于 active 时拒绝（计划与目标互斥），本请求没有可调用的 `exit_plan_mode` 时也拒绝。
- 提交：`exit_plan_mode` 要求计划模式已激活（提交事务内对已提交文档二次复核），计划为非空 Markdown 且第一行是一级标题（[plan.ts:55](../../src/server/tools/plan.ts#L55)）；它把一条 plan-review 记录写进交互表并立即返回「待审」，同时把此前仍 pending 的旧 review 置为 `superseded`（[plan.ts:201](../../src/server/tools/plan.ts#L201)）。研究型任务不提交计划、直接回答（工具描述约定）。

## 执行边界

`execution-policy` 扩展在执行层兜底（[execution-policy.ts:48](../../src/server/conversation/execution-policy.ts#L48)）：计划模式激活时，不在 `PLAN_TOOLS` 白名单（只读检索、问答、计划提交、`get_goal`、codemode、委派类）的工具调用直接抛错（[execution-policy.ts:68](../../src/server/conversation/execution-policy.ts#L68)）；`beforeRequest` 对重放历史中已被裁剪的工具补发 `toolsRemoved` system 消息（[execution-policy.ts:97](../../src/server/conversation/execution-policy.ts#L97)）。记忆写入无例外——plan 拦截无条件拒绝，保存协议 section 一并省略（[spec.md 2026-11-03](../spec.md) f0106a6）。工具面现状见 [tool-catalog](../tool-catalog.md)：plan 变体只剩只读与计划/问答/委派类工具。

## 提示词注入

`plan-policy` section 仅在 `Plans.active` 时注入（[plan.ts:134](../../src/server/tools/plan.ts#L134)）：只研究不实施、对话中的同意不结束计划模式、必须经 `exit_plan_mode` 提交、不用 `todo_write` 跟踪计划阶段、计划写成一级标题开头的 Markdown；委派子会话收到只含只读调研条款的子版本。`work-policy` 在计划模式下收窄为会话事实加计划模式约束（[work-policy.ts:133](../../src/server/conversation/work-policy.ts#L133)）。注入条件总表见 [section-catalog](../section-catalog.md)。

## 审批

审批走统一交互协议的 `plan-review` 通道（语义与路由详见 [interactions.md](interactions.md)）：批准（勾选「实施计划」或空回答都算批准）关闭计划模式并指示按权限执行；纯文字反馈按修改意见回传、计划模式保持开启；「忽略」dismiss 落 `cancelled`、计划模式保持开启（[runtime/interactions.ts:130](../../src/server/runtime/interactions.ts#L130)）。批准不提升权限：只读会话的审批按钮是「确认方案」，批准后的指令要求模型说明执行需要写权限（[runtime/interactions.ts:90](../../src/server/runtime/interactions.ts#L90)）。

## UI

Composer 的 `/plan` 命令与计划 chip 切换（[Composer.tsx:230](../../src/web/Composer.tsx#L230)）；`PlanPreview` 渲染计划 Markdown；状态卡「计划」分区由 `sessionPlans()` 汇总转录里每个 `exit_plan_mode` 调用并与 plan-review 交互按时间合并去重（调用被压缩掉时交互记录兜底），最新且待批的带「待批」徽标（[plan-preview.ts:29](../../src/web/plan-preview.ts#L29)）。

## 已知限制

- 提示词顺从度（模型是否自觉进入计划阶段、遵守只读约束）是模型边界（[spec.md 2026-10-28](../spec.md) S3/S4）。
- 与 ZCode 的计划行为对跑受缺失构建入口阻塞（[spec.md 2026-11-04](../spec.md) 未决条目）。
