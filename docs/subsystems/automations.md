# 自动化任务（automations）

> 状态：现状参考（2026-11-10 自 RRULE 改造后抽取）。决策与验收历史见 [docs/spec.md](../spec.md) 对应日期段。

## 状态与生命周期

任务存在应用级 `app-state.json` 的 `automations` 数组里，不挂在会话上；`Automation` 含 id、name、prompt、`status`、可选 `rrule` 与 `timeZone`、`target`、可选 `sessionId`、`nextRunAt`、`lastRun` 与 `runs[]`（[types.ts:334](../../src/shared/types.ts#L334)）。`status` 取 `active / paused / ended` 三态：`active ⇄ paused` 由人切换（UI 或模型经 `schedule_edit` 的 `active`），`ended` 是规则再无未来触发点时的终态，不是人手动设的。没有 `rrule` 的任务是「手动」任务：永不自动触发，只能是 `paused`，创建或更新成 `active` 会被服务端拒绝（[automations.ts:162](../../src/server/runtime/automations.ts#L162)）。

`runs[]` 是尾部表，最多 50 条，`lastRun` 始终指向最新一条；重启时 `running` 记录改成 `interrupted` 并保留错误说明（[automations.ts:494](../../src/server/runtime/automations.ts#L494)）。`purgeEnded` 删除全部 `ended` 任务并返回数量（[automations.ts:304](../../src/server/runtime/automations.ts#L304)）。

## 时间规则

规则是两行 RFC 5545 文本：一行 `DTSTART`（`Z` 或 `TZID=<IANA 区>`）加一行 `RRULE`（[recurrence.ts:139](../../src/server/automation/recurrence.ts#L139)）。共享层 `src/shared/automation-timing.ts` 负责把编辑器里的重复选项编译成规则、把规则反解回选项、生成中文描述；它不引复发引擎，所以浏览器包保持轻量。服务端引擎 `recurrence.ts` 基于 `rrule@2.8.1`，但自己完成墙钟与 UTC 的换算：规则按「把本地墙钟标注为 UTC」的伪时钟迭代，每个候选再换算成真实瞬间（[recurrence.ts:155](../../src/server/automation/recurrence.ts#L155)）。因此 09:00 的规则跨夏令时仍落在当地 09:00；不存在的本地时间跳过，重复出现的本地时间取较早瞬间。

接受的有界子集：禁 `SECONDLY`；`BYSECOND` 至多一个值；`COUNT ≤ 1000`；`MINUTELY/HOURLY` 不接受任何 `BY*`（钟点写在 DTSTART 里）；`BYMONTHDAY` 与序数 `BYDAY` 要求 `MONTHLY/YEARLY`；`BYYEARDAY/BYWEEKNO` 要求 `YEARLY`；序数 `BYDAY` 不能与 `BYWEEKNO` 同用；`UNTIL` 必须是 UTC 瞬间。`BYMONTHDAY=31` 在短月**跳过**而不是夹到月末——这是 RFC 语义，也是相对旧四单位模型的有意差异。

## 触发与投递

每个 `active` 任务在 `AutomationScheduler` 里挂一个绝对到期定时器（unref，超过 Node 上限自动重分段，[scheduler.ts](../../src/server/automation/scheduler.ts)）。停机期间错过的触发只补最近一次：每个任务只存一个 `nextRunAt`，重启后过期就立即跑一次再重算，不重放 backlog。

`target` 决定一次触发去哪（[automations.ts:373](../../src/server/runtime/automations.ts#L373)）：

| target | 行为 | 记录 |
|---|---|---|
| `new` | 每次新建会话，`whenBusy: 'reject'` | 等会话 idle 后按 `detail.error` 记 `completed / failed` |
| `new_once` | 首次新建并落 `sessionId`，之后复用该会话；会话被删则新建一个 | 同上 |
| `session` | 向既有会话 `submit(..., whenBusy: 'followUp')`，忙时排到当前轮之后 | 只记 `delivered`——到达即结果 |

投递文本带固定头，模型据此区分「系统定时投递」与「用户刚说」：`[SCHEDULE REMINDER]`、`This is a scheduled message from the user`、`schedule_id_json`、`occurrence_at`、`reminder_prompt_json`（[automations.ts:54](../../src/server/runtime/automations.ts#L54)）。多任务同一瞬间合并成 BATCH 的形态未实现：pi-web 是每任务独立定时器，不会自然产生同刻多条。

## 运行记录

每条记录含 `plannedAt`（本该触发的时刻，旧记录可能缺失）、`startedAt`、`finishedAt`、`conversationId` 与可选 `error`。状态枚举为 `running / completed / failed / interrupted / delivered`：前四者描述运行结果，`delivered` 专给 `session` 投递。UI 按 `automation.timeZone` 格式化 `plannedAt`；`runs` 分页读取（默认 20，`GET /api/automations/:id/runs?limit&offset`），下拉「加载更多」。

## 旧记录迁移

`recoverAutomations()` 在挂任何定时器之前逐条迁移旧形态（[automations.ts:105](../../src/server/runtime/automations.ts#L105)）：`enabled` → `status`；`intervalMs` → `FREQ=MINUTELY;INTERVAL=N`；四单位 `schedule` → `HOURLY / DAILY / WEEKLY;BYDAY / MONTHLY;BYMONTHDAY`；既无 schedule 也无 intervalMs → 无规则 + `paused`；全部旧任务 `target` 记为 `new`。迁移幂等，重复执行结果相同。迁移后仍解析失败的规则把任务置为 `paused`，不阻塞启动。

## 模型工具与提示词

四个工具在 `createScheduleExtension` 里定义（[schedule.ts:100](../../src/server/tools/schedule.ts#L100)）：`schedule_create`（title/prompt/rrule/target）、`schedule_edit`（update/delete；`active:true` 要求有未来触发点；`expectedUpdatedAt` 做乐观并发）、`schedule_list`（active 三态 + limit/offset）、`schedule_view`。`target` 的 `this_session` 映射为 `{target:'session', sessionId: 当前会话}`；写库时 `timeZone` 取自规则 DTSTART 的 TZID。工具描述是英文，与其余工具一致；`rrule` 描述按上述子集裁剪。

`schedule-policy` section 只在 `schedule_create` 或 `schedule_edit` 对当前请求可见（直接或经 codemode）时注入，文案一句授权约束；只有 list/view 可见时不注入（[schedule.ts:247](../../src/server/tools/schedule.ts#L247)）。四个工具名都在 `CHILD_FORBIDDEN_TOOLS` 里，子智能体会话既看不到也调不动（[subagent-policy.ts:35](../../src/server/conversation/subagent-policy.ts#L35)）。

这四个工具对所有会话可见。`READ_ONLY_TOOLS`、`PLAN_TOOLS` 都不含它们，只读会话与计划模式调不到。

## UI

[AutomationsPage.tsx](../../src/web/AutomationsPage.tsx) 是主从布局：左侧列表（状态 tab「已开启/已暂停/已结束/全部」、搜索、下次计划时间的绝对+相对显示、选中高亮），右侧详情（「规则 / 任务运行记录」双 tab、内联编辑、暂停/恢复、更多菜单里的立即执行与删除）。「新建」是拆分按钮：主按钮走「在会话中创建」（开一个新会话，不注入提示词），下拉另一项「手动创建」打开右侧创建面板（[AutomationCreatePanel.tsx](../../src/web/AutomationCreatePanel.tsx)）。创建面板字段对齐 DSH：名称、内容、执行位置（新建会话并复用 / 每次新建会话）、关联工作区、重复（每周、周一至周五、每天、每 N 小时、每 N 分钟、每月、仅一次、自定义，外加 pi-web 保留的「手动」）、间隔、周几、日期、时间、时区（系统区置顶，`Intl.supportedValuesOf` 兜底，最近五个存 localStorage，[time-zones.ts](../../src/web/time-zones.ts)）。列表头「更多」提供清除全部已结束任务。

## 已知限制

- `session` 投递用 `whenBusy: 'followUp'` 排队，不实现 DSH 的「等到上一轮结束再投最新一次」的严格合并；连续错过时可能排队多条。
- 只有 `COUNT/UNTIL` 耗尽才会进入 `ended`；没有「连续失败 N 次自动停」的策略。
- 无 per-task ACL：任何能调用这四个工具的会话可读写 Host 上全部任务，授权只靠提示词约束。
- 任务归属单进程的 `app-state.json`，多进程共享 dataDir 的并发写没有防护。