# 渲染（rendering）

> 状态：现状参考（2026-11-09 自 docs/rendering-state-machines.md 与 docs/zcode-process-rendering-gaps.md 抽取）。决策与验收历史见 docs/spec.md 对应日期段。

本页覆盖会话流（transcript）的动态渲染：durable 消息日志如何折叠成回合（run）的渲染模型，以及流式帧与落盘帧之间保持界面不跳变的机制——消息身份、块级流式状态、回答区归属、四台状态机与末尾运行指示器。完整的转移矩阵、缺陷编号（V1–V5）与 ego 验收记录留在 [rendering-state-machines.md](../history/rendering-state-machines.md)，本页只写今天成立的行为。

## 渲染模型

`buildRenderModel`（[render-model.ts:137](../../src/web/render-model.ts#L137)）把消息日志与投影后的交互记录折叠成 run 序列：带 `requestId` 的用户消息开组，run key 取 `run:${requestId ?? 消息 id}`（`stableRunKey`，[render-model.ts:251](../../src/web/render-model.ts#L251)）；`Transcript` 以 run key 作 React key 挂载 `RunTranscript`（[transcript.tsx:137](../../src/web/transcript.tsx#L137)），run 内分四区：用户气泡（users）、工作分组（process）、回答区（responses）、system 行（systemRows）。

system 行按归属两分：有 run 的行按其在日志里相对最终回答的位置分成回答前/回答后两段（[render-model.ts:220](../../src/web/render-model.ts#L220)）；无主 system 行按「跟在已开始的最后一个 run 之后」锚进 timeline（`buildTimeline`，[render-model.ts:232](../../src/web/render-model.ts#L232)），历史被替换时行留在替换内容之上。

## 消息身份：流式与落盘同一节点

assistant 消息 id 是 `assistant:${byTaskId}:${timestamp}`（`assistantMessageId`，[projection.ts:228](../../src/server/conversation/projection.ts#L228)）。Pi Durable 给 generation task 写的每个 entry 盖上该 task 的 id（`EntryRecord.byTaskId`），live run 携带同一个 id，partial 与最终 message 时间戳相同，因此落盘帧（[projection.ts:254](../../src/server/conversation/projection.ts#L254)）与流式帧（[projection.ts:973](../../src/server/conversation/projection.ts#L973)）算出同一 id——生成结束时消息节点不重挂载，整棵子树保持 DOM。重试写下的两条 entry 靠时间戳区分；没有 task scope 的 entry（调度器 fault 路径）退回 entry id，它没有流式对应体需要保持一致（[projection.ts:252](../../src/server/conversation/projection.ts#L252)）。

## 块级流式状态

块身份用模型 content 数组里的位置 `slot`：投影层给每个块盖上写入时的下标并保留空块（`assistantBlocks`，[projection.ts:209](../../src/server/conversation/projection.ts#L209)）——删掉空块会移动后续块的 slot；空块的过滤下放到渲染层（`blockCarriesContent`，[render-model.ts:466](../../src/web/render-model.ts#L466)）。React key 用 slot 拼接（如 `${message.id}:process:${slot}`，[render-model.ts:366](../../src/web/render-model.ts#L366)），不随「空块变非空」漂移。

流式尾巴按块判定：只有消息里最后一个有内容的块处于流式（`liveTailIndex` 与 `streaming` 传递，[render-model.ts:363](../../src/web/render-model.ts#L363)、[render-model.ts:477](../../src/web/render-model.ts#L477)），对齐 DSH `AssistantMarkdown.tsx:103` 的 `running={streaming && i === last}` 语义——正文出现的那一帧，思考行立即停止流式指示。

## 回答区归属与 pending 交互屏障

回答区（`responses`）同一时刻只归一条 assistant 消息：候选 = run.messages 切去回复屏障；流式中的消息优先（`isLiveAnswer`，[render-model.ts:453](../../src/web/render-model.ts#L453)），它写出自己的正文前，上一条已结算回答降级为过程内容以保持时间线时序；无流式消息时归 `finalResponseOf`——屏障后最后一条有内容（text/image/file）且不带 toolCall 的 assistant 消息（[render-model.ts:420](../../src/web/render-model.ts#L420)）。

pending 交互屏障：run 里存在待答交互（question / plan-review）时屏障取 `messages.length`，无候选、答案区恒空，模型在提问旁写的过渡文从首帧起就渲染在过程区（[render-model.ts:341](../../src/web/render-model.ts#L341)、[render-model.ts:345](../../src/web/render-model.ts#L345)）。pending 判定读投影后的 `interactions` 记录（`hasPendingInteractionCall`，[render-model.ts:433](../../src/web/render-model.ts#L433)）——durable 工具结果的 `details.status` 冻结在写入时，作答以独立 reply entry 落库，工具结果本体不改写。

屏障解除点是日志里最后一条交互回复 payload（`answer_to_pending_question` 与两种 dismissed kind，[interaction-payload.ts:13](../../src/web/interaction-payload.ts#L13)）之后：只有其后的消息参与归属（`lastInteractionReplyIndex`，[render-model.ts:440](../../src/web/render-model.ts#L440)），「已答复」与续写首 token 之间的 gap 帧不得把过渡文复活回答案区。不变量：一条消息若曾在答案区出现，其后每一帧都留在答案区；run 结算后的最终归属是屏障后最后一条有内容的 assistant 消息。

## 状态机一：交互卡片生命周期（S1）

Composer 上方的浮动卡片（`QuestionComposer`，不属于 transcript）只渲染「最新的 pending 交互」：`newest()` 只筛 `status === 'pending'` 的 question / plan-review，按 `createdAt` 取最新（[QuestionComposer.tsx:37](../../src/web/QuestionComposer.tsx#L37)）。已结算状态（`InteractionStatus`：answered / cancelled / expired / continued，[types.ts:766](../../src/shared/types.ts#L766)）一律不渲染卡片；问答记录归还 transcript 的工具行与回复气泡。`continued` 是被新输入取代（superseded）的计划审批的 wire 状态，「没有人在等它」（[projection.ts:659](../../src/server/conversation/projection.ts#L659)）。

提交成功后本地瞬态 `answeredLocally` 立即藏卡防提交闪烁，且只允许触发「不可见」，不得触发只读记录渲染（[QuestionComposer.tsx:95](../../src/web/QuestionComposer.tsx#L95)）；卡片以 interaction id 为身份，换题整卡重置（[QuestionComposer.tsx:85](../../src/web/QuestionComposer.tsx#L85)）。wire 状态由 `foldInteractions` 从 durable 交互记录折叠：工具结果带答案即 answered，errored 即 expired，无 reply 即 pending（[interactions.ts:54](../../src/server/conversation/interactions.ts#L54)）。

## 状态机二：工作分组开合（S2）

`ProcessGroup` 的开合是 `manualOpen ?? autoOpen`，run 内插有用户输入时强制展开并禁用开关（[transcript.tsx:368](../../src/web/transcript.tsx#L368)）。自动值只在边界上转移，其余帧（defaultOpen 重算、latest 变化、重投影）一律保持原值，SSE 帧间抖动不会折起/展开分组（[transcript.tsx:360](../../src/web/transcript.tsx#L360)）：

| 边界（`processGroupBoundary`） | 含义 | autoOpen 转移 |
|---|---|---|
| live-start | 本 run 变为 live | true（live 组恒开） |
| live-end | live 消失 | `defaultProcessOpen(policy, latest, live=false, hasInterleavedUser)` |
| demote | 非 live 的 run 失去 latest | 同 live-end |
| none | 其余任意帧 | 保持原值 |

转移函数 `processGroupAutoOpen`（[process-presentation.ts:30](../../src/web/process-presentation.ts#L30)）；`defaultProcessOpen` 由展示策略、是否最新回合、是否有插间用户输入共同决定（[process-presentation.ts:6](../../src/web/process-presentation.ts#L6)）。挂载时以 `defaultProcessOpen(当前 props)` 初始化（[transcript.tsx:358](../../src/web/transcript.tsx#L358)）；`manualOpen` 一经设置，自动因子不再改写开合，直到组件随 run key 变化重挂载。

## 状态机三：工具行 live→settled 身份（S3）

工具行的 React key 决定 DOM 复用。有 call block 的行 key 取 `tool:${block.id}`；live 阶段先到的无主 tool result（其 `toolCallId` 尚无配对 call block）同样以 `tool:${toolCallId}` 为 key，call block 落盘配对后 key 不变、整行不重挂载（[render-model.ts:284](../../src/web/render-model.ts#L284)、[render-model.ts:289](../../src/web/render-model.ts#L289)）。两个无主 result 重复携带同一 callId 时，第一个占住 key，第二个起退回 `tool-result:${message.id}`（`claimedCallIds` 防重）；配对成功的 result 走 callItems 分支，两种来源不会在同一 callId 上共存。

## 状态机四：子智能体答案归属（S4）

面板行的 `answer` 由 `latestOwnAnswer` 裁定（[subagent-answer.ts:11](../../src/server/conversation/subagent-answer.ts#L11)）：fork 型成员（存在 `team-spawn:` 用户输入）只取 spawn 边界之后的 assistant 文本——边界之前是 Lead 的话音；`status=error` / `isError` 的文本跳过——错误文本不是回答；没有自己答案的成员 answer 为空串，不回填 Lead 文本。消费方是团队名册行（[team.ts:225](../../src/server/runtime/team.ts#L225)，渲染于 [SubagentPanel.tsx:296](../../src/web/SubagentPanel.tsx#L296)），行为由 [subagent-answer.test.ts](../../tests/subagent-answer.test.ts) 锁定。

工具行 summary 的 `label · 任务：<task>` 是父会话写的委派回执（有意设计，不是子 agent 输出，「任务：」前缀作区分，[ToolCard.tsx:135](../../src/web/ToolCard.tsx#L135)）；SubagentPane（Inspector 只读 tab）渲染子会话自身的消息流，天然隔离。

## 末尾运行指示器

transcript 尾部的 spinner（`TurnRunningIndicator`，[transcript.tsx:183](../../src/web/transcript.tsx#L183)）是否可见由 `turnChatLoadingVisible` 裁定（[render-model.ts:677](../../src/web/render-model.ts#L677)）：busy 事实取会话级 `conversation.busy`（[App.tsx:2138](../../src/web/App.tsx#L2138)），不是最后一个 run 的 status——run status 由已记录消息推导，两个工具轮之间会落回 completed，按它显示会让 spinner 在未停止的回合里闪烁。

busy 期间指示器被两类事让位：pending 交互（任何 kind 都阻塞，`interactionBlocksTurnLoading`，[render-model.ts:688](../../src/web/render-model.ts#L688)）与压缩等维护任务（`compactionRunning`）——此时提示本身已是进度信号。无防抖：running 是权威事实，加安静期会在每次投影更新时重启可见性判断、落后于真实状态（[render-model.ts:666](../../src/web/render-model.ts#L666) 注释）。

## 工作步骤组与压缩标记的位置编排

process 排序后，「连续 2 个及以上」的同类工具行折成 UI 合成父行（`groupProcessParts`，[process-grouping.ts:48](../../src/web/process-grouping.ts#L48)）：只读探查（read / grep / glob / web_fetch 及只读 shell 白名单）折 `toolGroup(explore)`「查阅」，可执行 shell 折 `toolGroup(execute)`「终端」；写命令与重定向留在终端，单个不聚合，reasoning / user / content 打断分组。只读 shell 白名单与写操作判定见 `toolGroupKind`（[process-grouping.ts:22](../../src/web/process-grouping.ts#L22)）。

压缩标记：压缩运行期间，旧的已完成 compaction system 行整体隐藏（`visibleTranscriptMessages`，[render-model.ts:650](../../src/web/render-model.ts#L650)），「正在进行上下文压缩」行挂在正在压缩的 run 末尾（[transcript.tsx:277](../../src/web/transcript.tsx#L277)）；尚无 run 时落 transcript 顶层（[transcript.tsx:147](../../src/web/transcript.tsx#L147)）。连续的 subagent 调用在进入分组前先折成正文条带（`groupSubagentRuns` 接线于 [transcript.tsx:386](../../src/web/transcript.tsx#L386)，模型见 [subagent-run-model.ts](../../src/web/subagent-run-model.ts)）。

## 已知限制

- 陈旧 live slot：上一 run 遗留的 running tool slot 可能挂到新 run 的分组里，依赖 harness 投影原子性兜底，低概率未修（[rendering-state-machines.md](../history/rendering-state-machines.md) S3 尾注）。
- 思考摘要行是 140ms 的单次进入动画，不是 ZCode 的排队 enter/exit（[ReasoningBlock.module.css:5](../../src/web/message-rendering/ReasoningBlock.module.css#L5)）。
- 失败状态词带 title tooltip，但没有 ZCode 的 tooltip 内复制按钮（[ToolCard.tsx:197](../../src/web/ToolCard.tsx#L197)）；`list_files` 摘要按用户要求明示（「搜索列表」），有意偏离 ZCode。两者均见 [zcode-process-rendering-gaps.md](../history/zcode-process-rendering-gaps.md) 的「仍保留的部分对齐」。
- 工作区的目标 / 终端 / 工作流分区未实现，目标分区只渲染当前目标与轮次预算（[spec.md](../spec.md) 2026-10-31 段未决）。
