# 整族功能：DSH 机制 → Pi Durable 落点

基准：DSH `687f282e86`（0.2.1-rc.2）对照 Pi Durable 1.3.0 与本仓库 `src/server/runtime.ts` / `projection.ts` / `shared/types.ts`。
本文件是实施蓝图：每族写清「DSH 机制 → Pi 等价物 → pi-web 最小切片」，与 `docs/parity.md` 的状态表配套。

## 贯穿全局的三条事实

1. **读方向不需要新协议**：pi-web 的会话流是「整份 `ConversationDetail` 快照 + SSE」。只要 `projection.ts` 多投影字段，前端自动收到；只有**写方向**（回答、切换模式、spawn/控制子代理）要加 HTTP 路由。
2. **扩展是 runtime.ts 里的闭包**：`createRuntime()` 能同时拿到 `harness`、`registry`、`appState`、`META`。Pi 工具 API 未暴露的能力（abort、watchDoc、taskGraph）可直接用 `harness` 补齐。
3. **持久状态放 doc，不要用 tool call 参数推导**：compaction 会让旧 assistant entry 离开 active view，推导会丢；`defineDoc` 的 conversation doc 不受影响（pi-web 的 `META` 已是范例）。

## 1. 待办清单（todo）

- **DSH**：`todo_write` 工具（`todos: [{content,status}]` 全量替换，内容唯一、trim 非空；`in_progress` 并行与否由部署配置）；日志事件 `todo/write`；projection 是纯 fold，`turn/start` 清空；UI 面板空列表不渲染、按状态计数、可折叠；diff 由客户端以 content 为键比对上一次已加载的调用。
- **Pi**：`defineTool` + `defineDoc`（`pi-web.todos`，`scope:'conversation'`）；结果的 `details` 通道供 UI；「新用户输入被 place 时清空」挂在 pi-web 现有的提交事务里（steer 不清空，与 DSH 一致）。
- **pi-web 切片**：runtime 注册 `TodoTools`；projection 增 `ConversationDetail.todos`；新增 `TodoPanel` 挂在输入卡上方；`ToolCard` 对 `todo_write` 特判 diff 摘要（可选）。
- **坑（必须先改）**：`buildAgentChange` 的 readOnly 白名单目前只放行 `read`，会把交互/计划类工具一起滤掉 → 改为「只读工具 + 无副作用交互工具」白名单。

## 2. 计划模式（plan）+ 计划待审

- **DSH**：`plan/mode` 会话事件 + projection `{active,pending}`；运行中切换挂起到下一个 pre-step；`section('plan:policy')` 只在 active 时注入准则；`/plan` 命令；`exit_plan_mode` 工具始终注册、以 user-questions 通道做 plan-review（Approve / Keep planning / 面板关闭＝结束本 turn）；UI chip 显示折叠后的目标态、turn 尾部计划卡、预览 tab。
- **Pi**：状态进 conversation doc（`pi-web.plan`）；**pending 天然成立**——Pi 的 section 每次请求前重新渲染，运行中改 doc 即"下一次请求生效"；工具 `exit_plan_mode` 复用第 3 节的交互协议（`kind:'plan-review'`）。
- **pi-web 切片**：`PlanTools` 扩展（工具 + section + doc）；`setPlan` runtime 方法 + `POST /api/conversations/:id/plan`；projection 增 `plan`；Composer 加计划 chip；transcript 对 `exit_plan_mode` 调用特判渲染计划 markdown。

## 3. 问答（ask_user_question）与统一交互协议

- **DSH**：请求 `AskUserQuestionItem{id,question,header?,options?,multiSelect?,intent?}`、应答 `{answers:[{id,selected[],custom?}]}`；阻塞与 timed 两条通道；timed 超时返回 `{pending:true,callId}` 并让问题转 continued，迟到回答以一条带 `answer_to_pending_question` JSON 的 steer 用户消息送回、投影据此结算；关闭面板 ≠ 跳过。
- **Pi**：没有内建人机 seam。用「立即 pending + steer 回答 + 投影配对」自建，与 DSH 的 timed 路径同构；工具内**阻塞等待**要等假设 A1/A2 的结论再决定是否启用（一期不做）。
- **统一协议（pi-web 自己定义，供 question / plan-review / approval 三用）**：
  ```ts
  InteractionRequest = {
    id: string                 // = tool callId，幂等键
    kind: 'question' | 'plan-review' | 'approval'
    status: 'pending' | 'continued' | 'answered' | 'expired' | 'cancelled'
    questions?: AskUserQuestionItem[]
    detail?: string            // plan markdown / 审批正文
    approveLabel?: string
    answer?: { answers: AskUserQuestionAnswerItem[] }
    createdAt: number; answeredAt?: number
  }
  ```
- **写路由**：`POST /api/conversations/:id/interactions/:id/answer`（校验「每题恰好一次、选项来自题干」），服务端把回答作为 steer 用户消息提交（entry kind `pi-web.user-question-reply`，data 带 callId/answers），并写 doc 结算。
- **投影**：三源配对 —— 工具调用参数（题目）、工具结果（pending/答案）、reply entry（迟到回答）→ `ConversationDetail.interactions`。
- **pi-web 切片**：`src/server/interactions.ts`（服务 + 状态机纯函数）、runtime 注册 `AskTools`、`src/web/QuestionComposer.tsx`（多题导航、选项/推荐、自定义、跳过、只读记录）、`tests/interactions.test.ts`（状态机）+ http 路由测试。

## 4. 目标（goal）

- **DSH**：`goal/change` 全量快照（phase/CAS revision/maxGoalRounds/blockedReason）；`goal-round-driver` 在 idle 时 followup 续跑、超限 block(`round-limit`)；pause/resume 要求人类请求，complete/blocked 可由模型发起（blocked 有连续轮数阈值）。
- **Pi**：doc `pi-web.goal`；**自动续跑用原生 `hook(GenerationTask, { onYield })` 返回 `{continue}`**（同一 run 内再开一轮），比从 idle 外部 submit 更少竞态；上限 + phase 检查防死循环；`roundsStarted` 从带 `pi-web.goal-round` kind 的用户输入数出来，避免双写。
- **pi-web 切片**：`GoalTools`（create/get/update）+ section；projection `goal`；`GoalBar`（phase、round x/y、暂停/恢复/编辑/清除）；`POST /api/conversations/:id/goal`；测试：onYield 处理函数单测（伪造依赖）+ 投影计数。

## 5. 子智能体（subagent）

- **DSH**：provider seam + `subagent` 工具「启动即返回 activation」，结果由 runtime 通知父会话；`output / structured / diagnostic` 三通道分开呈现；控制工具 send/interrupt/list；UI 有计数触发器、层级目录、子会话只读转录。
- **Pi 原生**：工具内 `api.commit(tx => tx.createConversation({ ownership:{kind:'task', taskId: api.taskId} }))` 建子会话（默认继承父 agent 组合），`api.details({conversationId})` 让 UI 挂上去，`submit().wait()` 取结果；`replay:'safe'` + `scanConversations({ownerTaskId})` 支持崩溃重放复用。后台常驻版用 `{background:true}` anchor task + reporter。
- **pi-web 切片**：`SubagentTools`（先做前台一次性）；`children(id)` runtime 方法 + `GET /api/conversations/:id/children`、`POST .../children/:childId/messages|stop`；projection `subagents`；子会话不进侧栏（`list()` 已过滤 `owner === undefined`），由会话头触发器/卡片进入。

## 6. 团队（agent team）

- **DSH**：`team/member` + `team/task` 全量快照（revision CAS、依赖 ready、写范围 advisory、环校验）；工具 `spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent / team_task_*`；面板显示成员与共享看板。
- **Pi**：Team = 顶层会话 + 其 task-owned 子会话树；共享看板放 Lead 会话的 conversation doc（照抄 `TeamTaskSnapshot`）；`wait_agent` 用 `watchDoc` + 有界等待实现（无活跃成员立即返回 noProgress）；成员即子会话（复用第 5 节）。
- **pi-web 切片**：最后做。先落「共享任务看板 + send_message + wait_agent」，成员管理复用第 5 节；看板纯函数（CAS/依赖/环/授权）先单测再接线。

## 7. 实现顺序

1. ~~**todo**~~ —— **已实现并验证**：`src/server/todo-tools.ts`（工具 + doc）、`projection` 的 `todos` 字段、`src/web/TodoPanel.tsx`；runtime 已注册并支持新用户输入清空、readOnly 白名单放行；测试覆盖投影与端到端（demo `[todo]` 脚本），ego 复核收起/展开/清空。
2. ~~**交互协议 + ask_user_question**~~ —— **已实现并验证**（`interaction-tools.ts` + doc + `POST .../interactions/:callId/answer` + 三源配对投影 + `QuestionComposer`；78 用例与 ego 端到端含跳过/400/404）
3. ~~**plan mode + exit_plan_mode**~~ —— **已实现并验证**（`plan-tools.ts`：doc + `plan-policy` section + `exit_plan_mode`；`setPlan` 路由、投影 `plan`、Composer chip、待审卡；A11 的「下一次请求生效」即 pending 语义；86 用例 + ego 全流程）
4. ~~**goal**~~ —— **已实现并验证**（`goal-tools.ts`：doc + 3 工具 + CAS + `onYield` 续跑 hook（上界 `maxGoalRounds`）；runtime/投影/路由/`GoalBar` 已接线；demo 实测自动续跑 3/3 轮、暂停生效；79 测试通过）
5. ~~**subagent（前台一次性）**~~ —— **已实现并验证**（`subagent-tools.ts` + children API + 会话头面板；DeepSeek 真实模型复跑：委派「17*23」→ 子会话返回 391）
6. ~~**team**~~ —— **已实现并验证**（`team-tools.ts`：9 工具 + 看板 CAS/依赖/环/写范围 + `wait_agent` 有界等待；`TeamPanel`；demo 与 4317/3080 两侧 DeepSeek 同题复跑结果一致）

## 8. Pi 侧假设与验证状态

| # | 假设 | 结论（脚本验证于 `/tmp/pi-assumptions`，SQLite 后端复核 A3/A6） |
|---|---|---|
| A1/A2 | 工具内阻塞等待与 abort | **有条件可行**：`context.abortSignal` 会及时触发，但裸 await 不会被打断——`conversation.abort()`/`abortTask()` 是 join 语义，会一直等到工具返回。等待必须与 `abortSignal` 竞速并清定时器；abort 后一切 `api.*` reject（视为正常取消）。 |
| A3 | 工具内写 doc 并可见 | **可行**：`api.commit(tx => tx.doc(Token, api.conversationId), context)`；但 **`view.docs` 只挂载 5 个内置 doc**，自定义 doc 必须用 `harness.snapshot/watchDoc/documentState` 读（已据此修正 todo 投影）。task 作用域 doc 随任务消亡，跨轮状态用 conversation doc。 |
| A4 | 自定义 entry 与 steer | **可行**：`entry:{kind:'pi-web.*', data}`（**kind 不能以 `pi.` 开头**）；`requestId` 会话内去重且绑定 submission 类型；忙时默认 one-at-a-time 只放 1 条。 |
| A5 | `onYield` 续跑 | **可行（有条件）**：同一 run 内开新 generation；**只有第一个非 undefined 的 continue 生效，返回 undefined 时其它 handler 会接管** → 必须确认没有第二个永远 continue 的 handler，并用 conversation doc 计数封顶（`api.memo` 不跨 generation）。续跑注入的是普通 `pi.user` entry。 |
| A6 | 子会话枚举 | **可行**：字段名就是 `ownerConversationId`；**造会话与查表必须拆成两个 `api.commit`**（同事务内读后写会报错）；拼错字段名会被静默忽略返回全部。 |
| A7 | 跨会话 submit | **可行**：`api.conversation(childId, context)` 在本次调用内可解析，`submit().wait()` 取结果（文本要自己读 `tx.entry(answer)`）；**无所有权校验**，限制要自己做；handle 随调用结束失效。 |
| A11 | section 异步读 doc | **可行**：`section(key, async (input, context) => input.read.snapshot(Token, input.conversationId, context))`；**key 只能 `[a-z][a-z0-9_-]*`**；运行中改 doc 在**下一次请求**生效（正是 DSH 的 pending 语义）。 |

### 额外教训（实现时必须遵守）

- **工具输出必须是内容数组**：`{ output: [{ type: 'text', text }] }`；返回裸字符串会让 `pi.tool` 任务静默 faulted，模型只看到 "Tool result unavailable"，而 run 依然显示成功。
- `whenBusy: 'reject'` 抛的是 `ConversationBusy`；幂等提交一律带稳定 `requestId`。
- 工具内不要用 `harness.commit`（闭包跨调用有生命周期风险），统一 `api.commit(..., context)`。


## 9. 实现与验收约束（skill）

本仓库所有 DSH 对标工作按 skill `dsh-parity`（`~/.agents/skills/dsh-parity/SKILL.md`）执行：

1. 动手前先核对 DSH 本地源码（路径/行号级证据）；
2. 实现后两侧跑同一条流程做行为对比（真实模型跑关键路径）；
3. 验收时补代码级并排分析，差异定性为「待修 / 有意 / 不适用」。

清单与状态落在 `docs/parity.md`，机制与假设落在本文件。


### 附加红线（2026-10-19）

真实模型测试**只允许 DeepSeek 系模型**（默认 `opencode-go/deepseek-v4.1-flash`，需显式在会话/请求上选择），禁止使用 GLM/Qwen/Claude 等其他模型；确定性回归用 demo/faux 模型，不消耗真实额度。
