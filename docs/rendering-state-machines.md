# 动态渲染生命周期状态机与转移矩阵

针对会话流动态渲染的三类缺陷（问题卡片残留、工作区开合抖动、子智能体输出归属），把渲染生命周期
建模为四台显式状态机，列出转移矩阵，标注非法转移（即缺陷），并给出修复后的不变量。每台状态机
都有对应的穷举矩阵测试（`tests/rendering-state-matrix.test.ts`）与真实模型 ego 验收判据。

复现与验收记录：2026-10-28，真实模型 `opencode-go/deepseek-v4.1-flash`，ego 浏览器采样。

---

## S1 交互卡片（QuestionComposer）生命周期

浮动卡片挂在 Composer 上方（不属于 transcript）。服务端权威状态存在
`pi-web.interactions` 文档里（`StoredInteraction.status`），wire 状态由
`foldInteractions`（`src/server/interactions.ts`）折叠。

```
状态：absent → pending → answered | cancelled | expired | continued
卡片可见性（修复后）：仅 pending 可见；其余状态一律 absent
```

### 转移矩阵（事件 × 状态 → 下一状态 + 卡片可见性）

| 事件 \ 状态 | absent | pending | answered | cancelled | expired |
|---|---|---|---|---|---|
| ask_user_question 落库 | **pending / 可见** | pending / 可见 | — | — | — |
| 提交回答（含逐题跳过后提交） | — | **answered / 不可见** | answered / 不可见 | cancelled 拒答（CONFLICT） | — |
| 放弃整组（cancel） | — | **cancelled / 不可见** | answered 幂等 | cancelled 幂等 | — |
| 会话继续推进（steer/新输入） | — | continued / 可见（仍可答） | — | — | — |
| 工具结果 errored | — | expired / 不可见 | — | — | — |

### 非法转移（缺陷，已修复）

- **V1.1** `answered/cancelled → 可见`：修复前 `newest(interactions, 'settled')` 兜底把已结算
  交互渲染成只读「问答记录」卡，跳过后卡片永久停在 Composer 上方
  （`QuestionComposer.tsx:92` + `:194-214`）。真实模型复现截图
  `real-before-3-after-skip.png`。修复：卡片只认 pending；记录职责归还 transcript
  （工具行 `QuestionRecord` + `QuestionReplyRow` 气泡已覆盖）。
- **V1.2** `answered` 状态在 SSE 尚未到达时由 `answeredLocally` 本地合成——保留（防提交后
  闪烁），但它只允许触发「不可见」，不得触发只读记录渲染。

### 不变量

- I1.1 任一时刻至多一张卡片可见，且其状态必须是 `pending`（或本地 answered 瞬态）。
- I1.2 卡片消失后，会话流中必须仍能读到该次问答的完整记录（工具行 verdict + 回复气泡）。

---

## S2 工作区分组开合（ProcessGroup open）

一个 run 的分组开合由三个因子决定：策略（`ChatPresentationPolicy`）、live（会话级 busy 且
该 run 是最后一个 run）、手动覆盖。修复前 `defaultOpen` 每帧从 props 重算，`live`/`latest`
在 SSE 帧间抖动时组会自行折起/展开（「一会显示，一会折叠」）；且 `manualOpen` 是无主
useState，run 子树重挂载（run key 迁移）时静默丢失。

```
状态：AUTO_OPEN | AUTO_CLOSED | MANUAL_OPEN | MANUAL_CLOSED
事件：LIVE_START（本 run 变为 live）、LIVE_END（live 消失）、MANUAL_TOGGLE
```

### 转移矩阵（修复后，`processGroupAutoOpen`）

| 事件 \ 状态 | AUTO_OPEN | AUTO_CLOSED | MANUAL_OPEN | MANUAL_CLOSED |
|---|---|---|---|---|
| LIVE_START | AUTO_OPEN | **AUTO_OPEN** | MANUAL_OPEN | MANUAL_CLOSED |
| LIVE_END | policy(defaultOpen)，仅一次 | AUTO_CLOSED | MANUAL_OPEN | MANUAL_CLOSED |
| MANUAL_TOGGLE | MANUAL_CLOSED | MANUAL_OPEN | MANUAL_CLOSED | MANUAL_OPEN |
| 其他任意帧（defaultOpen 重算、latest 变化、重投影） | 不变 | 不变 | 不变 | 不变 |

- `policy(defaultOpen)` = `defaultProcessOpen(policy, latest, live=false, hasInterleavedUser)`：
  compact/standard + completion 折起；detailed（history）保持最新回合展开。
- 挂载初始化：`defaultProcessOpen(当前 props)`（历史 run 按策略，live run 恒开）。

### 非法转移（缺陷类，已修复）

- **V2.1** 非 live 边界帧上 `defaultOpen` 重算直接改写开合——每帧都可能发生，产生抖动。
  修复后非边界帧是 no-op（矩阵「其他任意帧」行）。
- **V2.2** `manualOpen` 随重挂载丢失。属于 S4 的 run key 稳定性问题，F4 修复 key 迁移后
  重挂载源消除。

### 不变量

- I2.1 AUTO 态的开合值只能在 live 边界（false→true、true→false）变化，一个生命周期至多
  一次自动折叠。
- I2.2 MANUAL 态一经进入，自动因子（live/latest/重投影）不得改写，直到重挂载。
- I2.3 live 组在 AUTO 态恒开。

---

## S3 工具行 live→settled 身份（tool row key）

一个工具行的 React key 决定 DOM 复用。live 阶段消息 id 是 `live-tool:<callId>`，落定后
换成持久化 message id；修复前无主 tool result 的 key 用 message id 拼接
（`render-model.ts:277`），live→settled 边界上 key 必变 → 整行重挂载（展开态/滚动/动画丢失）。

```
帧型：LIVE_ONLY（只有 live tool 消息，call block 未落盘）
      SETTLED（call block + 结果消息齐备，归入 callItems）
```

### 转移矩阵

| 帧型 \ key 方案 | 修复前 | 修复后 |
|---|---|---|
| LIVE_ONLY | `tool-result:live-tool:<callId>` | `tool:<callId>` |
| SETTLED | `tool:<callId>` | `tool:<callId>` |
| LIVE_ONLY → SETTLED | **key 变 → 重挂载（V3.1）** | key 不变 → DOM 复用 |

- 修复点：`buildRenderModel` 里无主 tool result（其 `toolCallId` 没有配对 call block）的
  key 改为 `tool:<toolCallId>`；有 call block 的项本来就用 `tool:<block.id>`，两者在同一
  callId 上不会共存（配对成功即进入 callItems 分支）。
- 陈旧 live slot（上一 run 遗留的 running slot 挂到新 run 组）仍依赖 harness 原子性，
  记为已知边界（低概率，未修）。

### 不变量

- I3.1 同一 callId 的工具行在 live→settled 全程持有同一个 key。
- I3.2 DOM 标记（dataset）跨边界存活（ego 判据：`rowMark === 'kept'`）。

---

## S4 子智能体输出归属（subagent answer ownership)

子会话是独立 conversation，展示面有三处，数据源与归属规则：

| 展示面 | 数据源 | 归属规则 |
|---|---|---|
| 工具行 summary | 父会话 toolCall args + details | `label · task`——父写的委派回执（有意设计，非子 agent 输出） |
| SubagentPanel/StatusPanel 行 answer | `latestAnswer(detail.messages)` | **只允许显示 spawn 边界之后、且非错误消息的 assistant 文本** |
| SubagentPane（Inspector 只读 tab） | 子会话自身 detail | 天然隔离（独立会话流） |

### 转移/判定矩阵（`latestOwnAnswer`，修复后）

| 消息位置 \ 消息形态 | 正常 assistant 文本 | status=error / isError 文本 | spawn 边界之前的 assistant 文本 |
|---|---|---|---|
| fork 型成员（存在 `team-spawn:` 用户输入） | **采纳** | 跳过 | **跳过（V4.1：Lead 的答案）** |
| subagent 委派子会话（全新） | **采纳** | 跳过（V4.2：错误文本当答案） | —（无边界前缀） |

### 非法转移（缺陷，已修复）

- **V4.1** fork 型 teammate 的 `answer` 显示 Lead 的最后一条答案（fork 前缀未剔除）。
- **V4.2** `stopReason='error'` 的错误文本被当作答案展示（面板与委派 output 两处）。
- 已核实干净的部分：SubagentPane 按会话隔离、不串流；工具行 `label · task` 是父回执不是
  子输出（UI 文案已用「任务」前缀区分，见 F5）；SSE 快照按会话原子推送，无跨 agent 泄漏。

### 不变量

- I4.1 面板 `answer` 若非空，必须是 spawn 边界之后该子会话自己的非错误 assistant 文本。
- I4.2 没有自己答案的 fork 型成员，`answer` 为空串，不得回填 Lead 文本。

---

## ego 验收判据（真实模型）

复测时间 2026-10-28 23:07，`opencode-go/deepseek-v4.1-flash`，与修复前同一 ego 任务空间、同一脚本骨架。

| 判据 | 修复前 | 修复后实测 |
|---|---|---|
| 跳过/提交后 `[data-question-card]` | present, status=answered（截图 real-before-3） | **null**（waitForFunction 12s 内确认消失，结算后保持消失；记录在工具行「提问 0/2 · 已回答」与回复气泡中完整保留） |
| 分组模式组开合序列（跳过窗口 12s 采样） | open→fold→(新组)open，开合值随帧可被重算改写（帧序依赖抖动） | **open → fold(一次) → 新组 open → 最新组保持 open**；边界间全部噪声帧零改动 |
| verbose 平铺消息层转移 | 0 次（实测，无缺陷） | 0 次 |
| 工具行 dataset 标记跨 live→settled | 未测（修复前标记时机晚于结算） | **kept，REMOUNT_EVENTS=0**（live 标记 → 已完成，DOM 节点存续） |
| 面板 fork 成员 answer | 含 Lead 文本（代码路径确认） | 空串（单测锁死 `tests/subagent-answer.test.ts`；fork 场景为确定性单测覆盖） |
| 工具行任务文本归属 | `label · <task>` 与子输出无法区分 | `label · 任务：<task>`（前缀区分父回执与子输出） |
