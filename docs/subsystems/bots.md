# 模块 bot 团队（module bot team）

> 状态：现状参考（feat/module-bot-team 原型分支，2026-11-12 落地）。设计取向与验收历史见 docs/spec.md 对应日期段。与 [team.md](team.md) 的区别：team 是会话内 Lead 临时招募的协作成员；bots 是按模块常设的知识值守团队，每个 bot 绑定一份模块知识文档并受 watchdog 巡检。

## 实体与存储

名册/群聊/配置/巡检报告存 `app-state.json` 的 `bots` 块（`BotTeamState`，[app-state.ts:147](../../src/server/state/app-state.ts)）：`bots`（BotRecord：id/name/module/globs/description/knowledgePath/model/conversationId/status/knowledgeHealth/compliance/knowledgeHash）、`rooms`、`config.watchdogIntervalMs`（0=定时关）、`watchdog`（最近一次报告）、`init`（running/conversationId/error）。会话侧：每个 bot 一个 ownerless 持久会话（kind `bot`）、每个 room 一个 ownerless 纯日志会话（kind `botRoom`），kind 标签在 [helpers.ts](../../src/server/runtime/helpers.ts) 的 CONVERSATION_KIND doc 上，`scanConversations` 与前端都把这四种 kind（bot/botRoom/watchdog/botInit）排除在侧栏外（[conversations.ts:75](../../src/server/runtime/conversations.ts)）。bot 会话身份在 `pi-web.bot` 身份 doc（botId/name/depth，[identity.ts:17](../../src/server/bots/identity.ts)）。

## 知识文档与写回约束

知识文档是 `docs/bots/<botId>.md`（workspace 相对路径），frontmatter 持 botId/module/globs/updatedStamp，正文骨架为职责/关键文件/已知坑/changelog（[docs.ts](../../src/server/bots/docs.ts)，创建 bot 时写骨架并记 hash）。约束三层：

- bot 会话 profile（systemPrompt 整体替换，[service.ts:125](../../src/server/bots/service.ts)）写明「参与后必须增量写回知识文档；本会话 write/edit 只允许这一个文件」。
- write/edit wrap 结构性放行：非 knowledgePath 的写请求直接拒绝（[extension.ts:77](../../src/server/bots/extension.ts)）。
- `bot-policy` section 注入知识文档全文（8k 字符截断）与团队路由表（[extension.ts:218](../../src/server/bots/extension.ts)）。

run 结束（idle 边沿）后宿主重算文档 hash 与 roster 比对：变→`complied`，没变→`stalled`；结算幂等，崩溃残留只对 `status==='busy'` 的边沿补算（[service.ts:342](../../src/server/bots/service.ts)）。

## 群聊协议

room 会话绝不 submit——消息是宿主写入的 passive entry（kind `pi-web.bot-room-message`，[identity.ts:27](../../src/server/bots/identity.ts)），因此不触发任何模型调用；passive entry 不进会话 detail 投影，唯一的读取缝是 `botRoomLog` 解析帧（[service.ts:427](../../src/server/bots/service.ts)）经 `GET /api/bots/rooms/:roomId/log` 暴露，前端以 2s 轮询消费。投递目标的解析按 id 或名称（`requireRoom`，[service.ts:211](../../src/server/bots/service.ts)）——投递帧只带 room 名，按名解析是 bot 侧工具可用的前提。

- 用户发言（POST `/api/bots/rooms/:roomId/posts`）：追加 `[USER]` 帧 → 解析 `@name`/`@all`（无提及=全体，[service.ts:88](../../src/server/bots/service.ts)）→ 逐目标 bot 会话 submit 群聊帧：`[ROOM:<room> FROM:<sender>]` + room tail（≤12 条、4k 字符）+ 协议指令（[service.ts:120](../../src/server/bots/service.ts)）。
- bot 发言唯一通道是 `post_to_room`：直接文本回复不会被投递（提示词硬规则）。命中 PASS 正则（DS-Bot 同款 `/^\s*[\[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i`，[service.ts:98](../../src/server/bots/service.ts)）则静默——不进 room、不投递他人。
- 投递深度记在身份 doc 的 `depth`：用户发起写 1，bot 转提及写 2，depth 2 的 bot 不再外投，两跳封顶防环（[service.ts:459](../../src/server/bots/service.ts)）；busy 目标走 `followUp` 排队不丢消息。
- 与 DS-Bot 的有意差异：无自动空闲续轮（被 @ 才响应）、无 idle ack 循环暂停——原型以可控与省调用为先。

## 工具面与 scope 限定

bots 扩展（[extension.ts](../../src/server/bots/extension.ts)）注册六个工具：bot 会话的 `post_to_room`/`bot_message`/`read_room`，编排会话的 `bot_create`/`bot_update`/`finish_init`。scope 限定不是全局过滤而是**按会话 opt-in**：`AGENT_EXCLUDED_EXTENSIONS` 把扩展从默认 agent 组合剔除（[runtime/core.ts](../../src/server/runtime/core.ts)），bot/botInit 会话创建时经 per-conversation `extensions add` 显式挂上（[service.ts:227](../../src/server/bots/service.ts)），普通会话（含全部 prompt 快照变体）结构性看不到；工具 execute 内再按身份 doc 重查授权。工具目录生成不受影响（tool-catalog 保持 39 工具）。

## 初始化

`POST /api/bots/init`：roster 非空时幂等返回不重建（[service.ts:721](../../src/server/bots/service.ts)）。

- `preset`：不跑模型，固定 server/web/shared 三 bot + 「全队」room，测试与演示用。
- `orchestrator`：建临时 botInit 会话（workspaceWrite，`docs/bots` 加 extraWriteRoots），提交编排指令（侦察→3-6 模块切分→逐模块 bot_create+写知识文档→finish_init）。**run 结束 ≠ 成功**：结束时 roster 仍为空则把会话 error（如 provider 429）或固定文案写入 `init.error`，UI 可跳转 init.conversationId 查看过程（[service.ts:748](../../src/server/bots/service.ts)）。进行中重复 init 返回 409。

## watchdog

手动 `POST /api/bots/watchdog/run` 或 `config.watchdogIntervalMs>0` 时的进程内定时链（[service.ts:697](../../src/server/bots/service.ts)）。逐 bot 检查知识文档（[service.ts:575](../../src/server/bots/service.ts)）：缺失/无 frontmatter→`unknown`；结构坏→`drift`；去 frontmatter 正文 >8k→`over-limit`；git 仓内 `git log --since=<updatedStamp> -- <globs>`（`:(glob)` pathspec）提交数 ≥1→`stale`（detail 带计数与最近提交），=0→`fresh`；非 git 目录用结构检查兜底。报告落 `<dataDir>/bot-watchdog/report.json` 与 roster 的 knowledgeHealth。`refreshStale` 对 stale bot 的自身会话 submit 刷新指令（带 git log 摘要与现文档全文，[service.ts:160](../../src/server/bots/service.ts)）。

## API 与前端

九条路由（[app.ts:898](../../src/server/app.ts)）：roster CRUD（GET/POST/PATCH `/api/bots`，config 路由先于 `:botId` 注册）、init、rooms（GET 语义并入 overview；POST 建 room）、`rooms/:roomId/posts`、watchdog run/report。前端 `BotsPage`（lazy antd chunk）：名册卡（健康/合规徽标）、群聊交错流（帧头解析与 @提及 chip 在 [bots-view.ts](../../src/web/bots-view.ts)）、watchdog 报告抽屉、初始化进度；overview 轮询 2s，room 消息复用会话 SSE。

## 已知限制

- bot 绑定默认工作区，无 per-bot workspace/model 字段（model 字段已预留未接线）。
- orchestrator 崩溃恢复统一记 `init.error`，不做会话续跑；投递无跨重启欠账恢复。
- room 消息无独立分页 API，前端按会话消息全量读取（原型规模可接受）。
- watchdog 的 `drift` 判据较窄（frontmatter 存在但缺 botId/module）。
