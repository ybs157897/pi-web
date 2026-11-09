# 轨迹采集与导出（trajectory）

> 状态：现状参考（2026-11-09 自 docs/families.md §11 抽取）。决策与验收历史见 docs/spec.md 对应日期段。

目标是把完整 agent 轨迹数据采集完整，供 AI 离线分析调优（human-in-the-loop RSI）。Pi Durable 的 sqlite 已持久化转录（entries，含 content blocks、token/cost、stopReason、diagnostics）与逐调用计时（tasks 的 startedAt/endedAt）；采集扩展补上事后无法重建的部分——实发请求形态（经压缩裁剪、shadow、codemode 包装后）、TTFT、旁路模型调用与工具目录快照。

## 三钩子采集

`pi-web-trajectory` 扩展（[trajectory.ts:161](../../src/server/conversation/trajectory.ts)）挂在 `GenerationTask` 的三个钩子上，按会话追加写 `<dataDir>/trajectories/<conversationId>.jsonl`：

- `beforeRequest`：每次请求尝试前落 `request` 行（编号自增，配对用），并在 model+thinkingLevel+tools 的 sha1 前 12 位变化时落一行 `catalog`（含全部工具的 name/description/parameters，[trajectory.ts:202](../../src/server/conversation/trajectory.ts)）。
- `afterResponse`：每条终态 provider 消息落 `response` 行（含失败尝试），按 task/request 编号与请求配对，携带完整 `AssistantMessage`（含 `ttftMs`，[trajectory.ts:252](../../src/server/conversation/trajectory.ts)）。
- `afterTools`：round 边界落 `tools` 行（assistant entry id 与各工具结果 entry id）。

写入 fire-and-forget：经串行队列落盘，写失败告警一次并对该文件停采，绝不阻塞模型调用（[trajectory.ts:64](../../src/server/conversation/trajectory.ts)）。扩展注册顺序钉在 compaction 之后（[index.ts:182](../../src/server/runtime/index.ts)），捕获到的就是裁剪后的真实 payload。

`request` 行默认记逐消息大纲而非全文：每条消息一行（role、system section 键、内容形状与尺寸），只有末尾 3 条消息保留截断预览（1,500 字符；toolCall 参数预览 300 字符）——历史已在 entries 里持久化，逐字重录只增大体积；`PI_WEB_TRAJECTORY_FULL_REQUEST=1` 可切换为全文 payload（一个长会话实测全文 614MB vs 大纲 0.7MB，[trajectory.ts:44](../../src/server/conversation/trajectory.ts)、[trajectory.ts:90](../../src/server/conversation/trajectory.ts)）。

## TTFT 与旁路调用

- TTFT：`wrapModelsWithTrajectory` 用 Proxy 包住传给 `Harness.open` 的 models 目录，只拦 `streamSimple`——透传事件流，从流开始到首个可见 content 计时，`ttftMs` 戳在最终消息上（经 `result()` 进入 durable entry 与 response 行；无内容则缺省不编造，[trajectory.ts:294](../../src/server/conversation/trajectory.ts)、[index.ts:337](../../src/server/runtime/index.ts)）。
- 旁路调用：`captureSideCall(purpose, ...)` 记 `sidecall` 行（input/answer/options/耗时，错误记录后原样重抛），四个调用点——会话标题 `session-title`（[conversations.ts:282](../../src/server/runtime/conversations.ts)）、压缩摘要 `compaction-summary`（[compaction.ts:711](../../src/server/conversation/compaction.ts)）、AI commit message `commit-message`（[workspaces.ts:126](../../src/server/runtime/workspaces.ts)，无会话时跳过）、记忆提取每轮 `memory-extraction`（[extraction.ts:761](../../src/server/memory/extraction.ts)）。provider 连通性测试无所属会话，不采集。

## 开关

`PI_WEB_TRAJECTORY=0` 关采集不关导出（导出仍有 entry/task 行，只是没有 request/response/catalog/sidecall 行）；没有按会话开关——轨迹的价值在无差别沉淀（[index.ts:186](../../src/server/runtime/index.ts)）。

## 导出 API

`GET /api/conversations/:id/trajectory`（[app.ts:550](../../src/server/app.ts)）→ `assembleTrajectory()`（[trajectory.ts:437](../../src/server/conversation/trajectory.ts)）：用 node:sqlite 只读（与 pi-durable 同驱动）把 conversation 记录、entries、tasks 与采集文件合并成单一时间序 JSONL——首行 `conversation`，其余行按 `ts` 稳定排序（同戳保持 entries→tasks→采集行顺序）；行类型 `conversation / entry / task / request / response / tools / catalog / sidecall`，每行带 `ts`。存量历史会话没有采集文件也能导（entry+task 仍在）；采集文件末行撕裂（崩溃中写）不毒化整个导出。

## Inspector trajectory tab

`TrajectoryPane` 消费导出 NDJSON，按模型调用逐 call 展开成可展开卡片（request 与 response 按 task/request 编号配对，sidecall 单独成卡），带头部汇总、子串过滤与全部展开（[TrajectoryPane.tsx](../../src/web/TrajectoryPane.tsx)、配对逻辑在 [trajectory-view.ts](../../src/web/trajectory-view.ts)）。入口在 Inspector 的 `trajectory` 标签页（[Inspector.tsx:554](../../src/web/Inspector.tsx)），经 `openTrajectoryPane` 打开（[App.tsx:1687](../../src/web/App.tsx)）。

## 已知限制

- provider 连通性测试调用不采集（无所属会话，属运维诊断，spec 2026-10-31 段未决）。
- `streamOptions`（maxTokens 等）不经 `beforeRequest` 暴露，catalog 行只有 model/thinkingLevel/tools；catalog 的 tools 口径是 `agent.tools`（模型被提供的），deferred 未加载工具不计入、`tool_search` 加载后体现为下一次目录变更。
- 全文请求 payload 默认关闭（体积），大纲只在末尾 3 条消息保留预览。
- 摘要侧路（`compaction-summary`）依赖 [compaction.md](compaction.md) 的 beforeCompact 钩子实际执行；Pi 内置摘要器兜底的调用不经 `captureSideCall`。
