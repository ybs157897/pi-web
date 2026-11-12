---
botId: shared-bot
module: shared
globs: ["src/shared/**"]
updatedStamp: 2026-11-12T05:26:14.608Z
---
# shared-bot（shared）知识文档

> 负责 src/shared 前后端共享类型与协议契约的模块知识与协作。

## 职责

- 负责 `shared` 模块（关注路径：`src/shared/**`）。
- 参与群聊协作后，把新得出的模块知识增量写回本文档。

## 关键文件

- `src/shared/` 共 6 个文件，全部是前后端共享的纯类型/契约，无运行时逻辑。
- `src/shared/types.ts` — 核心协议类型：`ModelRef`/`ModelOption`/`ProviderSummary`（模型与 provider 概览）、`ThinkingLevel`、`AccessMode`、`MessageStatus`、`SHORTCUT_COMMANDS` 快捷键命令表。文件头注释即硬约束：provider 凭据绝不进浏览器协议，`envVars`/`envConfigured` 只存变量名与是否配置，不存值。
- `src/shared/skills.ts` — 技能契约：`SkillSummary`/`SkillCatalog`/`SkillContent`，`source` 枚举区分 `builtin`/`global`/`user-agents`（共享用户级 `~/.agents/skills`）/`agents`（工作区 `.agents`）/`pi`/`plugin`，`version` 是 SKILL.md 字节的 SHA-256（乐观更新用）。
- `src/shared/plugins.ts` — 插件市场契约：`PluginStoreItem`（id 形如 `name@marketplace`，`sourceType: directory|zip|github|git|unsupported`）、`PluginCapabilities`（skills 为 `<pluginId>:<skillName>`，MCP server 名带 `plugin_<name>_<server>` 命名空间）。
- `src/shared/plugin-ui.ts` — 插件 UI 契约。
- `src/shared/automation-timing.ts` — 定时任务时间语义契约。
- `src/shared/fonts.ts` — 字体配置契约。

## 已知坑

- server（`src/server/contracts.ts`）与 web 改接口字段时必须同步 src/shared 的类型，shared 是两端契约的唯一定义点。
- `source` 语义易混淆：`user-agents` 是用户级共享技能根（`~/.agents/skills`），`agents` 才是工作区 `.agents`（见 `src/shared/skills.ts` 内注释）。

## changelog

- 2026-11-12T05:26:14.608Z 由宿主创建骨架。
