# 目标（goal）

> 状态：现状参考（2026-11-09 自 docs/families.md §4 抽取）。决策与验收历史见 [docs/spec.md](../spec.md) 对应日期段。

## 状态与生命周期

目标是 conversation doc `pi-web.goal` 里的单例（[goal.ts:58](../../src/server/tools/goal.ts#L58)）：`GoalState` 含 id、revision、objective、phase、maxGoalRounds、roundsStarted、可选 blockedReason（[goal.ts:24](../../src/server/tools/goal.ts#L24)）。phase 取 `active / paused / blocked / complete`；投影读为 `ConversationDetail.goal`（[projection.ts:453](../../src/server/conversation/projection.ts#L453)），complete 后 UI 隐藏目标条。同一会话同时最多一个未完成目标：存在未完成目标时 `create_goal` 拒绝，目标不能被悄悄替换（[goal.ts:117](../../src/server/tools/goal.ts#L117)）。计划模式与目标互斥：计划模式激活时不能创建目标（[goal.ts:426](../../src/server/tools/goal.ts#L426)），目标 active 时 `enter_plan_mode` 拒绝。

## 权限分界与 CAS

每次被接受的内容变更都递增 `revision`（CAS 令牌，模型必须从当前 goal 上下文原样回传，过期即拒）；自动续跑的轮计数不是内容变更、不递增 revision。动作分两类（[goal.ts:150](../../src/server/tools/goal.ts#L150)）：`complete / blocked` 只有模型可报告（blocked 必须给出 blocked_reason，且要陈述具体阻塞条件而非「困难」）；`edit / pause / resume / clear` 是人类请求，走 `POST /api/conversations/:id/goal`（[app.ts:509](../../src/server/app.ts#L509)，actor=human，服务端用当前 revision 免回传）。模型发起 clear 被拒绝；complete 要求目标达成且要求的验证已通过，并有具体证据。

## 自动续跑

`onYield` hook 在最终回答后决定是否续跑（[goal.ts:353](../../src/server/tools/goal.ts#L353)）：仅当目标 active、`roundsStarted < maxGoalRounds`（默认 10、上限 50）、计划模式未激活、没有 pending 交互（`awaitingUser`，[goal.ts:245](../../src/server/tools/goal.ts#L245)）、且 `canContinue` 门放行时，在同一个 commit 里递增 `roundsStarted` 并返回 `{continue: <续跑提示>}`，在同一 run 内再开一轮 generation；轮计数与续跑决定同事务落盘，两次 generation 不会重复计数，暂停/清除若在快照后落盘则以提交事务内的复核为准。runtime 供的两道门（[runtime/index.ts:207](../../src/server/runtime/index.ts#L207)）：`canCreate` 要求会话是顶层会话（owner 未定义，子智能体会话不建目标）；`canContinue` 要求当前 agent 工具面里有 `get_goal` 与 `update_goal`（直接可用或经 codemode callable），无工具时状态保留但不续跑。

## 提示词注入

`goal-policy` section 每请求按当前工具路由渲染（[goal.ts:275](../../src/server/tools/goal.ts#L275)）：无目标时给创建判据（跨多轮的人类直接请求即算，不必说出「目标」一词；琐碎单轮工作不建）；有目标时带 id/revision/objective 与轮次进度——active 时附 update 规则与「重大分歧用 `ask_user_question`、续跑等答案」的指引，paused/blocked 时说明续跑不会启动、等用户恢复；计划模式下只保留禁止条款。子智能体变体不注入。注入条件与实测长度见 [section-catalog](../section-catalog.md)，工具面见 [tool-catalog](../tool-catalog.md)。

## UI

[GoalBar.tsx](../../src/web/GoalBar.tsx) 挂在输入卡上方（[App.tsx:2169](../../src/web/App.tsx#L2169)）：phase、截断 objective、轮次预算，发起 pause/resume/edit/clear 交给 goal 路由。右侧状态卡「目标」分区（`data-status-section="goal"`）显示三态、受阻原因与暂停/恢复；完成的目标既不出分区也不出胶囊，胶囊链里「目标」排在 Todo 与待处理项之后。

## 已知限制

- 状态卡只渲染当前目标与轮次预算；ZCode 式逐迭代列表与验证结果需要新增迭代记录（[spec.md 2026-10-30](../spec.md) 未决条目）。
- 多个进程共享 dataDir 时的 CAS 未做防护，目标的并发修改以单进程为前提（[spec.md 2026-11-04](../spec.md) 未决条目）。
