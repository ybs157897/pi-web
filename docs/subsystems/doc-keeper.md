# 内置 doc-keeper 智能体（进程内 A2A）

> 状态：现状参考（2026-11-12 由独立 HTTP 服务改为内置智能体）。设计取向见 [spec.md](../spec.md) 2026-11-12 段。与 [bots.md](bots.md) 的分工：bots 是常设模块知识值守团队，参与协作时增量回写自己的知识文档；doc-keeper 是专职把一份知识文档与其代码保持同步的内置维护智能体，watchdog 巡检判 stale 后经进程内 A2A 委派它刷新。

## 定位与协议

doc-keeper 是内置智能体，不独立监听端口。交互协议是 A2A（`@a2a-js/sdk`），但传输是进程内函数调用而非 HTTP：SDK 的 `DefaultRequestHandler` 本身传输无关，`sendMessage(params, context)` 直接在进程内驱动 executor 并返回终态 `Task`，无需 JSON-RPC/HTTP 壳。协议核心三件：[agent-card.ts](../../src/server/doc-keeper/agent-card.ts)（Agent Card，象征性接口地址 `in-process://doc-keeper`）、[executor.ts](../../src/server/doc-keeper/executor.ts)（`DocKeeperExecutor`，A2A `AgentExecutor`，把维护结果译为 task 生命周期事件 + `maintenance-result` artifact）、[a2a.ts](../../src/server/doc-keeper/a2a.ts)（`createDocKeeperAgent` 装配 `DefaultRequestHandler` + `InMemoryTaskStore`）。

`DocKeeperAgent` 暴露三个成员：`agentCard`（能力描述）、`requestHandler`（传输无关的 A2A 请求处理器，需要原生流式语义的调用方可直接 `sendMessage`/`sendMessageStream`）、`sendMaintenance(input)`（进程内客户端：构造 data part 消息 → `sendMessage` → 解析 `maintenance-result` artifact 为 `DocKeeperRunResult`；任务无 artifact（如输入校验失败）则抛 `RuntimeError`）。维护任务参数 `{repo?, globs[], knowledgePath, mode:"check"|"refresh", model?}` 由 data part 或 JSON 文本 part 携带，executor 的 `parseInput` 解析。

## 维护能力（knowledge/）

[service.ts](../../src/server/knowledge/service.ts) 的 `createDocKeeperService` 是能力后端：`check` 无模型（`inspectDoc` + `detectChanges`，绝不改写）；`refresh` 建 kind `docKeeper` 的 ownerless 会话，提交 `docKeeperSubmission`，`waitForIdle` 后读最后一条 assistant 文本作报告，比对前后 hash 判 `updated`。[extension.ts](../../src/server/knowledge/extension.ts) 注册五个工具 `detect_changes`/`read_knowledge`/`git_diff`/`read_code`/`write_knowledge`，write/edit wrap 钉死 `knowledgePath`；扩展经 `AGENT_EXCLUDED_EXTENSIONS` 从默认 agent 组合剔除，普通会话与 prompt 快照结构性零变化，doc-keeper 会话建会话时显式 opt-in。[core.ts](../../src/server/knowledge/core.ts) 是纯函数后端（git 变更检测、bounded diff/code 读取、文档体检），不依赖 bot 名册。[prompt.ts](../../src/server/knowledge/prompt.ts) 持身份系统提示词与任务提交文本，硬约束含保留 frontmatter/章节结构、正文 ≤8000 字符、只改 `docPath`、`<!-- manual -->` 段落保留不改。

## 装配与内部交互

[runtime/index.ts](../../src/server/runtime/index.ts) 先 `createDocKeeperService` 再 `createDocKeeperAgent({ runMaintenance })`；`Runtime` 契约（[contracts.ts](../../src/server/contracts.ts)）暴露 `runDocKeeperMaintenance`（低层能力后端，executor 与服务单测用）与 `docKeeper`（进程内 A2A 端点，内置智能体经此委派）。bots watchdog 的 `refreshStale` 对每个 stale bot 经 late-bound `deps.maintainKnowledge`（接到 `docKeeperAgent.sendMaintenance`，mode 固定 `refresh`）fire-and-forget 委派刷新，不阻塞 watchdog 报告返回；单个失败不影响其余 stale bot。服务跟踪在途维护 promise，`runtime.close()` 在 `harness.close` 前 `drain`（30s 上限），避免后台维护与 shutdown 竞态。

## 边界

只允许修改 `knowledgePath` 这一个文件；`check` 不改写；`refresh` 无变更报 `fresh` 不重写。无 HTTP 对外 surface，外部触发（如 git post-commit）未提供——需要时再引入可选传输，不影响进程内主路径。`docKeeper` 会话与 bot/botRoom/watchdog/botInit 一样被 `isHiddenConversationKind` 排除在侧栏外（[helpers.ts](../../src/server/runtime/helpers.ts)）。
