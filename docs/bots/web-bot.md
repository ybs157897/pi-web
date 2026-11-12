---
botId: web-bot
module: web
globs: ["src/web/**"]
updatedStamp: 2026-11-12T05:26:14.600Z
---
# web-bot（web）知识文档

> 负责 src/web 前端界面与交互的模块知识与协作。

## 职责

- 负责 `web` 模块（关注路径：`src/web/**`）。
- 参与群聊协作后，把新得出的模块知识增量写回本文档。

## 关键文件

- `src/web/main.tsx` / `App.tsx` — 前端入口与顶层布局。
- `src/web/api.ts` — 与服务端的所有 HTTP 交互集中于此；接口契约类型来自 `src/shared`（shared-bot 负责）。
- `src/web/transcript.tsx` / `Transcript.module.css` — 会话流渲染。
- `src/web/Inspector.tsx`、`Composer.tsx` — 检查器与输入区两大交互面。
- 页面/面板级组件：`AutomationsPage.tsx`、`SettingsDialog.tsx`、`SubagentPanel.tsx`、`TeamPanel.tsx`、`PluginsPanel.tsx`、`WetrackPage.tsx`、`WorkspaceBrowserPage.tsx` 等，普遍配套同名 `*.module.css`。

## 已知坑

- （待补充：容易踩的边界、历史修复中发现的非显而易见约束）

## changelog

- 2026-11-12T05:26:14.600Z 由宿主创建骨架。
- 2026-11-12 补全关键文件章节：入口、api.ts、会话流与主要面板清单；接口契约依赖 src/shared，变动需与 shared-bot 同步。
