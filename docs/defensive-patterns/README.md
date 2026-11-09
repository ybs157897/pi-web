# defensive-patterns 索引

本目录是 [docs/AGENTS.md](../AGENTS.md) 定义的防御规则层：评审时逐条强制执行的规则，按改动对象分页；每条规则 = **加粗规则名** + 为什么 + 违例后果或真实案例锚点。机制「今天怎么工作」看 [subsystems/](../subsystems/README.md)，不在这里复述。

| 改动对象 | 先读 |
|---|---|
| 提示词 section、工具描述、runtime-core、提示词快照 | [prompt-changes.md](prompt-changes.md) |
| `src/web` 渲染模型与状态机（render-model / transcript / 交互卡片） | [rendering-state-machines.md](rendering-state-machines.md) |
| shell 工具、CLI spawn、Windows 路径处理 | [windows-shell.md](windows-shell.md) |

与相邻层的分界：决策理由（定了 / 判据 / 未决）归 [spec.md](../spec.md)，逃逸缺陷的复盘归 postmortem 层（层级表见 [docs/AGENTS.md](../AGENTS.md)），一次性教训不留在本目录——本目录只放跨改动反复适用的强制规则，理由与案例链接到归属层。
