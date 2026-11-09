# 问答与统一交互协议（interactions）

> 状态：现状参考（2026-11-09 自 docs/families.md §3 抽取）。决策与验收历史见 [docs/spec.md](../spec.md) 对应日期段。

## 协议与存储

人机交互统一存放在 conversation doc `pi-web.interactions`：以工具 callId 为键的请求表（[interaction.ts:26](../../src/server/tools/interaction.ts#L26)），同一张表有两种记录形态——问题组（`ask_user_question` 写入）与计划审批（`exit_plan_mode` 写入的 plan-review，[plan.ts:32](../../src/server/tools/plan.ts#L32)）。callId 同时是应答路由的幂等键。答案要比发起它的 assistant entry 活得久（压缩会把后者移出 active view），所以请求与结算放 doc，而非从 tool call 参数推导。

## 提问（pending 形态，不阻塞）

`ask_user_question` 一次最多 8 题、每题至多 12 个选项，参数在工具内做严格校验（未知字段、重复 id/选项、长度上限，[interaction.ts:52](../../src/server/tools/interaction.ts#L52)），随后把请求写入 doc 并立即返回「问题已 pending、答案将以后续用户消息到达」（[interaction.ts:128](../../src/server/tools/interaction.ts#L128)）。工具内从不阻塞等待——Pi 里裸 await 不会被 abort 打断（abort 是 join 语义），阻塞通道是明确不做的取舍。工具描述同时约束：pending 不是许可，未答/超时不构成同意；pending 期间不重复提问。

## 回答与放弃（写路由）

- `POST /api/conversations/:id/interactions/:callId/answer`（[app.ts:498](../../src/server/app.ts#L498)）先校验「每题恰好回答一次、选项来自题干、非多选只准单选」，空回答按显式跳过放行（[conversation/interactions.ts:26](../../src/server/conversation/interactions.ts#L26)）；再把回答作为 steer 用户消息提交（entry kind `pi-web.user-question-reply`，data 带 requestId/callId/answers），提交成功后才把 doc 结算为 answered——提交被拒时问题仍可回答（[runtime/interactions.ts:162](../../src/server/runtime/interactions.ts#L162)）。requestId 由 callId 派生（`question-reply:<callId>`），重启后重试不会把消息注入两次。
- `POST /api/conversations/:id/interactions/:callId/cancel`（[app.ts:504](../../src/server/app.ts#L504)）整组放弃：先 steer 一条 dismissal（`pi-web.user-question-dismissed`，指示模型不要再问），再结算为 `cancelled`（[runtime/interactions.ts:217](../../src/server/runtime/interactions.ts#L217)）。关闭面板不等于跳过——dismiss 是显式取消；已回答的问题再取消返回冲突。
- plan-review 复用同两条路由：批准、按反馈修改、忽略（`cancelled` 但计划模式保持开启）的判定在 [runtime/interactions.ts:65](../../src/server/runtime/interactions.ts#L65)，语义详见 [plan-mode.md](plan-mode.md)。

## 投影与渲染

投影合并三源：转录里的工具调用参数（题目）、工具结果（pending）、reply entry（迟到回答与放弃），再叠加 doc 里的权威记录（含 plan-review，`superseded` 映射为 wire 状态 `continued`；[projection.ts:939](../../src/server/conversation/projection.ts#L939)）。交互答复并入提问调用的那个 run（含 legacy callId 回退与 compaction 安全回退），一问一答不把回合切成两段（[projection.ts:690](../../src/server/conversation/projection.ts#L690)）。渲染层：question/plan-review 待答期间，该 run 的后续正文不进回答区，过渡文留在工作分组，屏障解除点是最后一条交互回复 payload 之后（[render-model.ts:336](../../src/web/render-model.ts#L336)；状态机记录见 [rendering-state-machines.md](../rendering-state-machines.md) S5）。目标自动续跑在存在 pending 交互时不启动（[goal.ts:360](../../src/server/tools/goal.ts#L360)）。

## UI

[QuestionComposer.tsx](../../src/web/QuestionComposer.tsx) 承载问答：多题导航、选项与「(Recommended)」标记、自定义输入、跳过；已结算的交互以只读记录呈现，pending 之外的卡片不可再操作。计划审批按 ZCode 重做为计划摘录卡加权限卡（[PlanExcerptCard.tsx](../../src/web/PlanExcerptCard.tsx)）。转录中的 `ask_user_question` 行按「正在询问/已询问 · N 个问题」摘要，展开后是问题与回答的竖线列表，未回答显示「未提供回答」。

## 已知限制

- teammate 场景的交互整体转接（把等待用户的交互交给队友接管）仍未接线（[spec.md 2026-11-04](../spec.md) 未决条目）。
- 多个进程共享 dataDir 时的 CAS 防护未做，交互结算的幂等以单进程为前提（[spec.md 2026-11-04](../spec.md) 未决条目）。
