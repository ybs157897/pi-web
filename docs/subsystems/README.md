# subsystems 索引

本目录是 [docs/AGENTS.md](../AGENTS.md) 定义的现状参考层：每个主题一页，只写今天成立的机制（类型、语义、行为、边界）。

| 页 | 覆盖 |
|---|---|
| [tasks.md](tasks.md) | 单入口与任务：主会话座位、任务会话创建、状态投影、任务列表 API 与前端 |
| [todo.md](todo.md) | 待办清单：`todo_write` 工具、`pi-web.todos` 文档、清空时机与投影 |
| [plan-mode.md](plan-mode.md) | 计划模式：`pi-web.plan`、`enter/exit_plan_mode`、`plan-policy` section、执行边界与审批 |
| [interactions.md](interactions.md) | 统一交互协议：`ask_user_question`、plan-review、回答/放弃路由与三源投影 |
| [goal.md](goal.md) | 目标：`pi-web.goal`、CAS 与权限分界、`onYield` 自动续跑 |
| [subagent.md](subagent.md) | 子智能体与委派：双 profile、委派契约、子会话裁剪、后台结算、一行条 UI |
| [team.md](team.md) | 团队与共享任务板：Lead/成员、任务 CAS、send/wait 语义、写域约定 |
| [compaction.md](compaction.md) | 上下文压缩：压力裁剪、预算触发、缓存感知摘要与系统行编排 |
| [trajectory.md](trajectory.md) | 轨迹采集与导出：三钩子、JSONL 行类型、导出 API 与 Inspector tab |
| [rendering.md](rendering.md) | 渲染状态机：消息身份、块级流式、四台状态机、pending 交互屏障 |
| [memory.md](memory.md) | 工作区记忆：存储布局、注入与省略条件、写入放行、后台提取 |
| [personalization.md](personalization.md) | 个性化指令：用户级 AGENTS.md 的存储与上限、注入顺序、设置页与 API |
| [plugins.md](plugins.md) | 插件市场：来源与安装事务、插件技能/MCP/UI、引用注入 |
| [search-and-shell.md](search-and-shell.md) | 搜索与 shell 工具面：四个检索工具、原生 grep 回退、平台二选一 |
| [automations.md](automations.md) | 自动化任务：RRULE 规则与迁移、三态与 target 投递、运行记录、四个模型工具与 `schedule-policy` |

提示词体系的现状参考在 [docs/prompts/runtime-system.md](../prompts/runtime-system.md) 与生成的 [section-catalog](../section-catalog.md)。

本层只写现状；决策历史在 [spec.md](../spec.md)，实施史在 history/。
