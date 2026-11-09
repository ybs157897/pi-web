# 智能体团队（agent team）

> 状态：现状参考（2026-11-09 自 docs/families.md §6 抽取）。决策与验收历史见 docs/spec.md 对应日期段。

团队 = Lead 会话 + 若干 task-owned 子会话。Lead 会话的 `pi-web.team` 文档持有全部持久状态：`members`（名册）与 `tasks`（共享任务板）两个数组（[team.ts:92](../../src/server/tools/team.ts)）；每个队友会话上的 `pi-web.team-member` 文档（`TeamLink`）回指 Lead 与自己的成员名，队友的团队工具据此解析 Lead 的任务板而不是另建一个空团队（[team.ts:105](../../src/server/tools/team.ts)、[team.ts:699](../../src/server/tools/team.ts)）。成员即子会话：与 [subagent.md](subagent.md) 同一接缝，继承 Lead 的 agent 组合，因 owner 边界不进侧栏。

队友会话挂在一个常驻后台 anchor 任务下（`pi-web.team-anchor`，Lead 会话一个，复用或按需创建，[team.ts:130](../../src/server/tools/team.ts)、[team.ts:1485](../../src/server/tools/team.ts)）：后台任务是边界，成员的 run 不占 Lead 的 busy、不随 Lead abort 级联，`interrupt_agent` 仍可直接中止成员。

## Lead 与成员角色

`lead` 是保留名，永不可用作队友名，也永不复用（[team.ts:62](../../src/server/tools/team.ts)）。`spawn_teammate` 与 `interrupt_agent` 仅 Lead 可调用（`lead-required`）；任务板变更（claim/release/edit/set_dependencies/complete/reopen/delete）要求「owner 或 Lead」，`reassign` 仅 Lead。队友名必须是 lower-kebab-case、≤64 字符；名册上限 16 名成员、任务板上限 256 条活跃任务（[team.ts:51](../../src/server/tools/team.ts)）。`team-policy` section 按 TeamLink 身份分别注入 Lead 与队友条款，普通会话不注入（[team.ts:947](../../src/server/tools/team.ts)）。

## spawn：fresh / fork

`spawn_teammate` 创建一个具名、持久、后台运行的队友，调用不等待其回答（[team.ts:1055](../../src/server/tools/team.ts)）：

- 名字是幂等键：重放的调用按 `planSpawnReplay` 找到已记录的行并复用其子会话；名字已被用过（含创建失败）即 `member-name-taken`，永不复用（[team.ts:745](../../src/server/tools/team.ts)）。
- `context: 'fresh'`（默认）建空子会话；`context: 'fork'` 以 Lead 最后一个已完成回合为边界分叉（`lastCompletedTurnEntry` 扫描 stopReason 为 `stop`/`length` 的 assistant 消息，进行中回合与其中 steering 不进入种子，[team.ts:1516](../../src/server/tools/team.ts)）。fork 上下文拒绝另行指定模型（保持前缀缓存复用），fresh 可选 `model {provider, modelId}`（与 subagent 共用 `createChildModelResolver` 校验，只覆盖 model/thinkingLevel，不改工具与指令）。
- 创建流程：先落 `provisioning` 名册行 → 一个 commit 内建子会话 + TeamLink + anchor → 以稳定 requestId（`team-spawn:<leadId>:<name>`）投递初始 prompt（不等待）→ 名册行转 `active`；任一步失败把行标 `failed` 带原因。崩溃遗留的 `provisioning` 行由 `reconcileProvisioning` 按「子会话存在且 link 仍指回本成员、初始 prompt 未被拒」收敛（[team.ts:564](../../src/server/tools/team.ts)）。

## 共享任务板（CAS）

`TeamTaskRecord`：`id`（`task-N` 递增）、`revision`、`subject`、`description`、`status`（pending/in_progress/completed/deleted）、`owner`、`blockedBy`、`writeScopes`、时间戳。`team_task_update` 以 `expected_revision` 做比较-交换：revision 不符即 `stale-revision` 拒绝，重读后用当前 revision 重试；每次成功变更 revision +1（[team.ts:383](../../src/server/tools/team.ts)）。动作集 claim / release / edit / set_dependencies / complete / reopen / reassign / delete（[team.ts:1400](../../src/server/tools/team.ts)）：

- claim 要求任务 ready（所有 blocker 已 completed）且未被他人持有；complete 只允许 in_progress；reopen 把 completed 退回无主 pending；delete 拒绝仍被其他活跃任务依赖的任务（`has-dependents`）。
- 依赖校验：拒绝自环、重复 blocker、指向缺失或已删除任务；每次变更后整板做环检测（`detectCycle`，[team.ts:272](../../src/server/tools/team.ts)）。
- `team_task_list` 支持按 status/owner/ready 过滤与 cursor/limit 分页（limit 1–100，默认 50），返回中带 ready/blocked 标志与写域重叠警告。

写域（`writeScopes`）是 advisory 不是锁：工作区相对路径前缀，归一化时拒绝绝对路径、盘符、空段与 `..` 逃逸（[team.ts:206](../../src/server/tools/team.ts)）；与其他 in_progress 任务的写域重叠只产生 `taskView` 里的警告行，靠提示词要求协调串行（[team.ts:237](../../src/server/tools/team.ts)）。

## send / wait 语义

- `send_message`（[team.ts:1214](../../src/server/tools/team.ts)）：向成员或 `lead` 发一条消息（不能发给自己）；运行中的目标在最近的步骤边界收到（`whenBusy: 'steer'`），非运行中的目标开始/恢复一个回合；消息加 `Team message from <sender>:` 前缀，上限 65,536 字节。发送成功只表示收件箱接受，不是对方的回答。
- `wait_agent`（[team.ts:1277](../../src/server/tools/team.ts)）：有界等待（10s–1h，默认 30s），观察任务板文档变更与成员 busy 转换（`watchDoc` + runtime 的 `watchMembers`），随调用 abort 一起中止（[team.ts:855](../../src/server/tools/team.ts)）；永不唤醒非运行中的成员。没有其他成员在运行或 provisioning 时立即返回 `noProgress`（`no-active-peer`）。
- `wait_agent` 的结果总是携带队友名册（`teamRosterWithAnswers`）：每人 status，已结束的附最近一条 assistant 文本预览（截 2,000 字符）与 `answerStatus`（available / truncated / not_found_in_recent_entries / read_failed）、来源会话与 entry id（[team.ts:802](../../src/server/tools/team.ts)）；`conversationPath` 是给宿主/用户的定位符，不是可调用工具。超时分支同样带名册。
- `interrupt_agent`：Lead 专属，中止某成员当前回合，保留其待处理收件箱（[team.ts:1307](../../src/server/tools/team.ts)）。

## 路由边界与投影

独立并行的一次性子任务路由到 `subagent`（其工具结果直接带回答案）；队友的最终文本不会自动回流 Lead，须经任务板、消息或文件收集——该取舍写在 `spawn_teammate` 工具描述里（[team.ts:1057](../../src/server/tools/team.ts)）。投影：runtime 的 team service 以 `projectTeam` 合成 `TeamView`（[runtime/team.ts:18](../../src/server/runtime/team.ts)），经投影落入 `ConversationDetail.team`；任务板的 CAS/依赖/环/授权是 [team.ts](../../src/server/tools/team.ts) 里的纯函数，可独立单测。工具面矩阵见 [tool-catalog.md](../tool-catalog.md)：计划模式下 `send_message / team_task_create / team_task_update` 被过滤，只读任务板读取保留。

## 已知限制

- 写域是 advisory：任务板层不做文件系统级强制，重叠只产生警告，依赖提示词协调。
- `wait_agent` 的回答预览可能被截断或属于更早的回合（`answerStatus` 区分）；名册的 inactive 表示无回合在跑，不是任务完成。
- 队友整体交互向用户转接（teammate 消息/结果直接呈给最终用户）未做，属 spec 2026-11-04 段未决项。
- fork 上下文不能另选模型（保持 KV 前缀复用，有意取舍，见 [team.ts:1084](../../src/server/tools/team.ts)）。
