---
botId: server-bot
module: server
globs: ["src/server/**"]
updatedStamp: 2026-11-12T05:26:14.588Z
---
# server-bot（server）知识文档

> 负责 src/server 服务端（runtime、工具、HTTP、自动化）的模块知识与协作。

## 职责

- 负责 `server` 模块（关注路径：`src/server/**`）。
- 参与群聊协作后，把新得出的模块知识增量写回本文档。

## 关键文件

- `src/server/index.ts` — 进程入口：端口（PI_WEB_PORT，默认 4317）、数据目录迁移装配。
- `src/server/app.ts` — HTTP 应用与路由（含 `/api/bots`、`/api/bots/rooms` 于 898–909 行）。
- `src/server/runtime/index.ts` — 运行时装配：工具注册、bots 扩展安装。
- `src/server/contracts.ts` — 前后端共享契约（runtime 接口与类型汇聚点）。
- `src/server/bots/service.ts` — 模块 bot 框架核心：bot/room 记录、投递（deliverToBot/postToRoom/postAsBot/directMessage）、群聊帧与 PASS 判定。
- `src/server/bots/extension.ts` — 面向 bot 会话的工具扩展（post_to_room / bot_message / read_room）。
- `src/server/bots/identity.ts` — BotIdentity 文档（botId/name/depth）。
- `src/server/conversation/` — 提示词与上下文压缩；`src/server/tools/` 工具扩展；`src/server/model/` 模型目录；`src/server/automation/` 定时任务。
- `src/server/state/app-state.ts` — 应用状态持久化与 schema（含 botTeamStateSchema，bots 缺省为空团队）。

## 已知坑

- 群聊帧头只带房间名不带 id：`roomDeliveryFrame` 输出 `[ROOM:<roomName> FROM:...]`（service.ts:123），而本仓源码的 `requireRoom` 只按 UUID id 匹配（service.ts:207-212），bot 也没有群聊列表工具。实测同名 post_to_room 先失败两次（报「群聊不存在」）后，同样参数第三次成功——运行时行为与源码不一致（宿主可能有 name 回退或状态延迟装载），遇到该报错先重试再下结论，不要仅凭源码断言死路。
- bot 的 id 就是 name（createBot `id: name`，service.ts:263），所以 bot_message/提及用名字即可；room 的 id 是 randomUUID，两者不一致是上面坑的根源。
- `[PASS]` 静默判定（isPassReply，service.ts:100）先于房间校验短路：正文是 PASS 时传错 roomId 也返回成功静默。
- 投递深度两跳封顶：用户投递 depth=1，bot 转提及 depth+1，达到 MAX_DELIVERY_DEPTH 不再投递；深度存 BotIdentity 文档，跨崩溃保留。
- bots/rooms 状态持久化在 `PI_WEB_HOME`（默认 `~/.pi-web`）的 app-state.json；旧项目本地 `.data` 有一次性迁移（state/home.ts migrateGlobalHome）；文件缺 `bots` 键时 zod default 读作空团队，不能拿磁盘文件断言运行时无 bot。
- 群聊本体是一个 ownerless conversation（metadata.title=`room:<name>`，kind=botRoom），日志条目 kind 为 ROOM_ENTRY_KIND，按会话 entries 存储。

## changelog

- 2026-11-12T05:26:14.588Z 由宿主创建骨架。
