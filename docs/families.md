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

## 10. 上下文压缩（compaction）

DSH 把压缩做成 capability seam（`ctx.compaction`）：Service Definition `packages/compaction/compaction`、默认 backend `compaction-basic`、人用入口 `command-compact`。Web 默认 preset `standard` 挂载 backend + `/compact` + tool-result pruner（`packages/bundle/web-app/presets/standard.patch.yml:73-82`）；pruner 与 image-offload 的宿主行在 base bundle。

### DSH 机制（源码结论）

- **三层缩减，按顺序执行**：
  1. `tool-result-pruner`：确定性把超过 8192 字符的工具结果中间段替换为 `[... tool result middle pruned ...]`，保留头 4096 + 尾 1024（`packages/compaction/compaction-tool-result-pruner/src/config.ts:11-13`）；只改当前 surface，不调模型。
  2. `image-offload`：provider 返回 `IMAGE_OFFLOAD_REQUIRED` 时按请求顺序永久省略最老的图片、写 `image/offload` 决策并重试；摘要调用遇到同一错误也走该恢复（`packages/compaction/compaction-image-offload/src/index.ts`）。
  3. 摘要压缩：`BasicCompactionEngine`，把旧 surface 范围替换成一条摘要 user message。
- **触发点**：
  - 普通压力：`agent/pre-step`，在请求派生之前检查（`compaction-basic/src/index.ts:158`）。
  - 阈值：`thresholdTokens = floor(min(contextWindow * 0.8, contextWindow - reservedCompletionTokens - 65536))`；`retainTokens = floor((contextWindow - reservedCompletionTokens) * 0.16)`（`config.ts:20-23,75-79,191-198`）。保留比例与 headroom 都按模型可覆盖（`modelPolicies`）。
  - 压力触发时先跑 pruner 并重新计量；仍超阈值才选摘要范围。一次触发最多 `compactionRetries + 1` 次压缩（默认 `compactionRetries=1`），仍不降则报错（`index.ts:318-350`）。
  - 上下文溢出：`agent/request-error`，错误码 `CONTEXT_WINDOW_EXCEEDED_CODE`；独立预算 `maxOverflowRetries=1`，且只有 surface 真的被替换（`replaceGeneration` 前进）才 `retry`；pruner 已产生持久缩减但摘要后续失败时仍然重试（`index.ts:190-235`）。
  - 手动 `/compact`：`compactNow()` 要求 agent 空闲，成功返回压缩条数与 token 数；失败分类 `busy/cancelled/changed/summary/commit/persistence`（`command-compact/src/index.ts:24-76`）。
- **选范围**：从尾部按 token-meter 节点价累计到 `retainTokens`，再向前挪到 tool-call/result 配平的边界；system head 永不在范围内；找不到可用前缀就返回 null（`region.ts:117-157`）。
- **摘要调用**：复用会话自己的 system prompt、tool schemas 与被 shadow 的消息，最后追加 compaction instruction 作为唯一新输入，从而命中 provider 的 KV prefix cache（`summarizer.ts:27-66,120-166`；`purpose: 'compaction'`）。默认用路由模型（也可配 `summarizationProvider/Model`），`maxTokens` 默认等于 `headroomTokens=65536`。模板固定 8 节：Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context，要求保留精确路径、命令、错误串。摘要必须纯文本、不能是 tool call、不能被 max-tokens 截断，且 framed summary 的 token 数必须小于被替换范围（`region.ts:387-425`）。
- **落地与并发**：日志三事件 `compaction/start`（同时是锁）/`compaction/summary`/`compaction/end`；摘要以 replacement `user/message` 落盘（`surfaceOp: {replace,startSeq,endSeq}`，source=`compact-checkpoint` + compactionId）。旧事件保留在日志里，模型 surface 被替换；单会话同时只允许一个压缩，未配对的 start 视为孤儿锁。自动摘要要求整个 surface 未变，手动只要求选中 span 未变（允许期间注入无关 context）。
- **UI**：Chat 在 checkpoint 落点显示「上下文已压缩 · 已压缩 N 条历史记录（约 X tokens）」，可展开摘要；**被压缩的旧消息仍留在转录里**，marker 只表示模型从何处开始看不到它们（`ui-chat/src/client/chat/CompactionItem.tsx:31-75`、`ui-chat/src/client/locale.ts:140-144`）。Trajectory 另显示运行中/失败/已完成与「压缩 {seq}」分组（`ui-trajectory/src/client/layout.ts:349-398`）。

### pi-web 现状（Pi Durable 1.3.0）

- 旧状态（本次改动前）：策略固定、不可配，`enabled=true / reserveTokens=16384 / keepRecentTokens=20000 / backgroundTokens=32768`（`node_modules/@earendil-works/pi-durable/dist/harness/agent.js:12-17`）；`Harness.open` 没有传 `settings.compaction`。
- 触发在 generation 准备阶段：`> window - 16384` 阻塞、`> window - 49152` 后台；provider 溢出压缩后重试一次（`dist/harness/generation.js:219-233,371-395`）。
- 摘要用独立 summarizer system prompt + 把旧消息序列化成纯文本（工具结果截 2000 字符），`cacheRetention: "none"`，`maxTokens≈13107`，模板 6 节（Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context）（`dist/harness/compaction.js:12-47,103-160,294-337`）。
- 落地为 `pi.compaction` entry（`head=firstKept`，内容是一条 framed summary user message），旧 entry 留在 SQLite 但离开 active view；旧状态：前端只显示一条「较早的上下文已压缩」系统行，无条数/token/展开/运行态（`src/server/projection.ts:743,814-815`）。
- `/compact` 走 `App.tsx:749-755 → POST /api/conversations/:id/compact`（`app.ts:481`）→ `conversation.compact(undefined, CTX)`（`runtime.ts:1522-1526`）；202 立即返回，不能带指示、不能取消、失败后只有 toast/`ConversationDetail.error`（且该字段前端未渲染）。

### 并排差异（2026-10-20 核对）

| 维度 | DSH | pi-web | 定性 |
|---|---|---|---|
| 压缩前确定性缩减 | tool-result pruner（8k/4k/1k）+ image offload | 无；2000 字符截断只作用于摘要输入 | 待修（pi 无对应 seam，可在 runtime 里做 surface 前置裁剪） |
| 阈值模型 | 比例 0.8 + 64k headroom，按模型覆盖 | 固定 16k reserve / 32k background | 待修（策略硬编码在 Pi Durable） |
| 保留尾部 | 窗口的 16%（按保留预算） | 固定 20k token | 待修（同为近似语义，量纲不同） |
| 摘要模型输入 | 复用会话 prefix + 末尾追加指令（KV cache 命中） | 独立 summarizer prompt + 纯文本序列化（显式 `cacheRetention:none`） | 有意差异（底座不同）；成本/延迟更高 |
| 摘要输出上限 | 默认 65536 | min(0.8×16384, 模型上限) ≈ 13107 | 待修（长会话摘要信息量更少） |
| 模板 | 8 节工程检查点，强调精确路径/命令/错误 | 6 节通用检查点 | 待修（可对齐文案） |
| 存储与转录 | 日志事件 + surface replace；旧消息仍显示 | `pi.compaction` entry + head；旧消息离开 active view | 有意差异（Pi active view 语义）；UI 影响可见 |
| 运行/结果 UI | marker 带条数/token/可展开摘要；Trajectory 有运行态 | 仅一条系统行 | 待修（优先补 `compaction/summary` 等价信息） |
| 手动入口 | 同步、要求 idle、返回计数、错误分类 | 202 异步、无结果/错误分类、不可取消 | 待修（Pi 侧协议限制；可至少回读任务结果） |
| 重试 | compactionRetries=1 + overflowRetries=1 | 仅 overflow 重试一次 | 待修（低优先级） |

### 若要补齐 pi-web（按优先级）

1. **UI 可见性**：把 `live.compactions` / `live.compactionFailure` 接进 `ConversationDetail`，在转录末尾渲染「已压缩 N 条 · 约 X tokens」+ 可展开摘要（摘要文本可从 `pi.compaction` entry 的 framed user message 中解析，或另存 doc）；失败要有明确提示。
2. **手动压缩体验**：`compact` 接受可选 instructions（Pi 已支持 `compact(instructions, ctx)`）并回传任务结果；至少把 202 之后的后台结果/失败通过 SSE 反映出来。
3. **策略可配**：给 `Harness.open` 传 `settings.compaction`，来源可以是应用设置（enabled / reserveTokens / keepRecentTokens / backgroundTokens）。
4. **前置缩减**：在压缩前对超长 tool result 做确定性裁剪（对应 DSH pruner），必要时再做图片 offload；这层能显著推迟摘要。

### 可行性结论（2026-10-20，只核 seam，未实现）

结论：**行为上可对齐约 80–90%**；完全逐项一致需要改 Pi Durable 上游。

| DSH 能力 | Pi 可用 seam | 可行度 |
|---|---|---|
| 运行态 / 失败 / 完成 marker、条数与摘要展开 | `LiveDoc.compactions` / `compactionFailure` 已存在于 `dist/harness/live.d.ts:104-110`；`pi.compaction` entry 的 framed summary 可解析 | ✅ 完全可做（纯投影 + UI） |
| 手动 `/compact` 结果与错误分类 | `conversation.compact(instructions, ctx)` 返回 task id（`dist/harness/types.d.ts:455-461`），现被 runtime 丢弃；可 `waitForTask` 或随 SSE 推结果 | ✅ 可做 |
| 阈值设置（enabled / reserve / keepRecent / background） | `HarnessOptions.settings.compaction`（`types.d.ts:476-497,519-523`），4 个绝对值 | ✅ 可做；但 **全局、无 per-model 覆盖** |
| DSH 比例阈值（0.8 / 16% / 64k headroom）与逐模型策略 | 同上，只有绝对值 | ⚠️ 只能按主模型换算成一组绝对值，或改上游 |
| 前置 tool-result 裁剪（8192/4096/1024） | `beforeRequest` hook 可改本次请求的 messages（`types.d.ts:690-694`、`generation.js:117-123`） | ✅ 模型侧效果可做；❌ 不是 durable surface 替换，转录/重启后仍显示原文 |
| 图片 offload | 同上，可在 `beforeRequest` 把旧 image block 换成占位；provider 错误码恢复需自己记录 | ⚠️ 近似可做，非 replay-safe |
| 自定义摘要模板 / 摘要模型 / maxTokens | `beforeCompact` hook 可 `decline` 或直接给 `{summary}`（`types.d.ts:722-739`），hook 内可 `api.models.completeSimple` | ✅ 可做；⚠️ 拿不到当前请求完整 tools/system，KV prefix cache 无法保证 |
| 摘要复用会话 prefix（cache 命中） | Pi 内置摘要固定独立 system prompt + `cacheRetention:"none"`（`dist/harness/compaction.js:103-126`） | ❌ 公开 seam 下只能接近，不能完全一致 |
| 旧消息仍留在转录 | Pi active view 从 `head` 开始；被 shadow 的 entry 不在 `view.entries` | ⚠️ 需前端另存历史或上游暴露 shadowed entries |
| 压缩重试（compactionRetries） | Pi 内建策略固定；可在外层手动重试 | ⚠️ 近似；完全一致需上游 |

建议节奏：先做 UI 可见性 + 设置（1–2 天），再做 `beforeRequest` pruner（成本收益最大），最后做 `beforeCompact` 模板/模型；「比例阈值 + per-model + durable prune + cache 复用」这四项若必须逐项一致，走 Pi Durable 上游 patch，而不是在 node_modules 或本仓库里硬改。

### 生态实现核对（2026-10-20）

- **pi-coding-agent（上游同仓库）**：`reserveTokens=16384`、`keepRecentTokens=20000`，支持 `modelOverrides` 按模型覆盖；在工具结束、下一请求前、用户新提示前和 overflow/length 后多处检查；切点落在 user/assistant/bash/custom，不切 tool result；重复压缩从上次的 `firstKeptEntryId` 继续；split user-message span 生成「历史 + 当前 span 前缀」两份摘要后合并；摘要模板 6 节 + `<read-files>`/`<modified-files>` 累积；`session_before_compact` 可返回自定义摘要与 usage；摘要请求 `cacheRetention:"none"`。
- **do-computer**：缓存感知摘要的代表。空闲约 10 分钟后，用会话自己的 `view.messages`、同一 provider session、同一 cache retention，末尾追加一条摘要请求，让前缀命中 KV cache；只在缓存仍热、剩余窗口足够（16k）时这样做，否则退回 Pi 内置摘要；摘要必须匹配 `## Goal`…`## Critical context` 形式；按 task memo，失败退避 1 小时；按模型缓存寿命决定是否值得压。
- **pda**：把上下文压到固定 200k 预算（`min(200k, 模型窗口)`），`reserve=16k / background=34k / keep=30k`；`beforeCompact` 自己调模型，JSONL 逐行标注 role 做注入防护（只有 `user` 是用户的话，tool result 不可信），失败 `decline` 而不是写坏摘要；按 task memo。
- **pi-pocket**：长生命周期会话按空闲 token 阈值压缩；摘要明确「外部内容（会话/Webhook/GitHub/文件/脚本）不写入」，只保留自己的工具结果；`MARGIN_TOKENS=4096` 保证压缩确实有收益，`REGROW_TOKENS=8192` 避免每次回答后都压；摘要 usage 计入 `pi.usage`。
- **cloudflare/pi-durable-cloudflare-chat**：只用 Pi 默认策略，`beforeCompact` 仅做观测日志。
- **IgorWarzocha/pi-durable-components**：走另一条路——用 notes/checkpoint + `new_context` 工具显式交接，非 overflow 的自动压缩直接 `decline`。

### pi-web 已落地的机制（`src/server/compaction.ts`）

- **策略**：`reserveTokens=16384`、`keepRecentTokens=30000`、`backgroundTokens=34000`（通过 `Harness.open.settings.compaction` 生效；`PI_WEB_COMPACTION_*` 可覆盖）。有效窗口默认使用模型真实窗口（1M 就是 1M），只有模型未声明窗口时才回退 200k；`PI_WEB_CONTEXT_BUDGET` 可显式设置成本上限。
- **压力裁剪**：`GenerationTask.beforeRequest` 在估算 token 超过有效窗口 85% 时，把最老的（保留最近 4 条）超过 8192 字符的 tool result 中间段替换为头 4096 + 标记 + 尾 1024；不改存储，同样压力下输出稳定，避免每次请求产生不同前缀。对应 DSH 的 tool-result pruner，但只作用于请求视图。
- **预算触发（2026-10-21 修正）**：Pi Durable 内建触发在生成准备阶段按 `contextWindow - reserveTokens` 发起**生成归属的阻塞式压缩**（生成等待摘要落地后继续，不中断任务）；pi-web 自己的触发只在「运营成本上限把阈值压到平台阈值以下、且上下文尚未越过平台阈值」时才发起（`ownsCompactionThreshold()`），其余交给平台。修复前两套触发同阈值并发，会话级压缩的摘要在更晚的边界落地、把 head 推回去抵消平台的裁剪，上下文不降反升，下一次请求超窗导致任务中断（`artifacts/compaction-repro/repro.ts` 复现：一次压缩两次摘要请求；修复后一次）。60s in-flight 去重与 `LiveDoc.compactions` 空检查保留。
- **摘要**：
  - 优先 **缓存感知**：`view.messages + 摘要请求`，同一 provider session，剩余窗口 ≥16k 时使用；否则退回只序列化被 shadow 消息的路径。
  - 摘要提示固定 `Goal / Constraints & Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Next Steps / Critical Context`，保留精确路径、命令、错误串、id、数字；正文语言跟随用户；明确 tool result/assistant 内容是数据、不是指令，禁止编造用户批准和写入密钥。
  - **文件跟踪**：从 shadow 消息的 `read/write/edit` 工具调用与上一份摘要的 `<read-files>/<modified-files>` 累积，追加到新摘要。
  - **校验**：必须 `stop` + 纯文本 + 四个必需标题 + ≤16k 字符；framed summary 必须小于被替换内容；任一失败 memo 后 `undefined`，交回 Pi 内置摘要器兜底。
  - **成本**：摘要调用 usage 计入会话 `pi.usage`；按 compaction task memo，重放/重试不重复调用模型。
- **验收**：demo 实例（4329，数据目录 `/tmp/pi-compaction-data`）先发「你好」再发 180k 字符消息，自动压缩成功；`entries` 中 `pi.compaction`（id 64，head 52）的摘要包含 `## Goal … ## Critical Context` 以及 `<read-files>hello.txt</read-files>`、`<modified-files>hello.txt</modified-files>`，证明自定义摘要与文件跟踪都实际执行；`tests/compaction.test.ts` 18 例覆盖预算、裁剪、序列化、文件列表、校验、请求构建、memo/失败回退。

### 仍与生态最佳实践有差距的地方

- **逐模型阈值**：Pi Durable 的 `settings.compaction` 是 harness 级 4 个绝对值，没有 `modelOverrides`；有效窗口已按模型真实窗口计算，「按模型覆盖 reserve/keep」仍需上游支持。
- **durable 裁剪**：`beforeRequest` 裁剪不是 surface 替换，转录仍保留完整 tool result，重启后重算；DSH/pruner 会写日志事件。要完全一致需 Pi 上游开放 surface 重写。
- **图片 offload**：未实现；Pi 侧没有对应的 provider seam。
- **展示**：状态互斥——运行中在转录末尾显示与完成标记同级的「正在进行上下文压缩」系统行（旧的完成标记隐藏、不弹 toast），完成后只显示「已完成上下文压缩」；条数/token/摘要展开仍未做。2026-10-21 起系统行按消息流位置编排（`render-model.ts` 的 `timeline`）：压缩条目替换的是它上面的历史，标记留在被替换内容的位置，不再一律贴在最底部。
- **真实模型验收**：opencode-go key 仍为 `401 api_key_expired`，本轮用确定性 demo 模型验证机制接线，未声称真实模型压缩质量。

### 真实模型与 UI 验收（2026-10-20）

- **1M 窗口不再被 200k 硬压**：`compactionBudget()` 默认返回模型真实窗口（1M 就是 1M）；只有模型未声明窗口时回退 200k。`PI_WEB_CONTEXT_BUDGET` 可显式设置成本上限；`PI_WEB_COMPACTION_{RESERVE,KEEP_RECENT,BACKGROUND}_TOKENS` 可覆盖策略。
- **真实 provider**：opencode-go（`https://opencode.ai/zen/go/v1`，`anthropic-messages`），模型 `opencode-go/deepseek-v4.1-flash`（1M window）。`POST /api/providers/opencode-go/test` 返回 `connected`；真实对话完成 3 轮后手动压缩成功，`pi.compaction` entry 24 / head 19，摘要 980 字符，包含完整 6 节标题与 `<read-files>/private/tmp/pi-real-compaction-workspace/seed.txt</read-files>`，证明自定义摘要、文件跟踪和落盘路径在真实模型上生效。测试用 `PI_WEB_CONTEXT_BUDGET=60000`、`keepRecent=2000` 降低触发成本，生产默认按模型窗口。
- **UI 运行态**：`LiveDoc.compactions` 投影为 `ConversationDetail.compaction`；转录末尾显示与完成标记同级的系统行（12px、tertiary、居中，带小 spinner）；运行期间旧的「已完成上下文压缩」标记被隐藏，且不再弹 toast。完成后系统行变为「已完成上下文压缩」；失败显示「上下文压缩失败」+ 原因。压缩运行中再次 `/compact` 直接忽略，不重复提交。ego + 真实 `opencode-go/deepseek-v4.1-flash` 验收：`artifacts/ego-compaction/07-level-running.png`（只有运行系统行，无 toast/胶囊/完成标记）、`08-level-completed.png`（只有完成标记）。
- **测试**：`tests/compaction.test.ts` 18 例 + projection compaction 1 例；全量 263 例。
