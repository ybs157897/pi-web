# docs 索引

本仓库文档的层级、写作规则与字数预算由 [AGENTS.md](AGENTS.md)（宪法）定义；一个事实只有一个家。想找什么，按下表路由：

| 想找 | 去哪 |
|---|---|
| 改代码前先读的架构地图 | [architecture.md](architecture.md) |
| 某个机制今天怎么工作（todo / 计划 / 交互 / goal / 子智能体 / 团队 / 压缩 / 轨迹 / 渲染 / 记忆 / 插件 / 检索与 shell） | [subsystems/](subsystems/README.md) |
| 某个工具的描述与参数 schema | [tool-catalog.md](tool-catalog.md)（生成，勿手编） |
| 提示词有哪些 section、何时注入 | [section-catalog.md](section-catalog.md)（生成）与 [prompts/runtime-system.md](prompts/runtime-system.md) |
| 某个决策是何时定的、判据是什么、还欠什么 | [spec.md](spec.md)（顶部有未决汇总）与 [.agents/notes/](../.agents/notes/README.md) |
| 与 DSH / ZCode 的逐项对照和有意差异 | [parity.md](parity.md) |
| Windows 支持边界 | [windows-support.md](windows-support.md) |
| 怎么加一个工具 / section / 预设 / 技能 | [cookbook/](cookbook/README.md) |
| 评审时要强制执行的规则 | [defensive-patterns/](defensive-patterns/README.md) |
| 逃逸缺陷的复盘 | [postmortem/](postmortem/README.md) |
| 已完结批次的计划、审计、设计原稿 | [history/](history/README.md)（冻结，非现状权威） |

维护规则速记：改工具描述或 section 文案后跑 `npm run gen:docs`；文档改动跑 `npm run doc:check`；新增常驻文档在 `scripts/doc-budgets.manifest.json` 登记预算。
