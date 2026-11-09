# 事故复盘（postmortem）

本目录是 [docs/AGENTS.md](../AGENTS.md) 定义的编号事故复盘层：收录已逃逸到真实使用或已合并的缺陷复盘，核心问题是「流程为什么放行」，不是「缺陷怎么修的」。机制现状归 [subsystems/](../subsystems/README.md)，修复决策历史归 [spec.md](../spec.md)；未上线的取舍不立篇（那是 spec 的事），复盘沉淀出的可评审强制规则移交 defensive-patterns，一次性教训留在这里。

## 写入门槛

三个条件同时成立才立篇，缺一降级为 commit message 或 defensive-patterns 条目：

- 隐蔽（subtle）：常规验证路径——单测、类型检查、代码评审——探不到的缺陷形态。
- 系统性（systemic）：不是孤例手误，而是判据或流程的结构性缺口，同类改动会再产出同类缺陷。
- 重新发现代价高（costly to rediscover）：不落盘，下一次要在同样的现象与排查路径上重付代价。

## 编号规则

文件名 `NNNN-slug.md`：`NNNN` 是四位编号，从 `0001` 起递增、只增不复用；slug 是短横线连接的小写英文短语（如 `answer-flicker`），点题缺陷现象。

## 结构模板

每篇复盘固定七节，一节一职：

- `# Post-mortem NNNN: 标题` 与 `Status:` 行（resolved / open，修复锚点链接 spec 日期段）。
- `## Executive summary`：30 秒可读——什么现象、什么根因、什么护栏。
- `## Impact`：用户可见表现，如实转述仓库记录；记录没有的写「记录未留」，不补写。
- `## Root cause`：机制因果链，以 spec 原文为准，链接归属地而不复述。
- `## Why every test missed it`：既有验证手段为何全部放行——本层的核心问题。
- `## Guardrails added`：修复同时落下的护栏，逐条锚定 spec / subsystems。
- `## Lessons`：跨缺陷可复用的教训。

## 索引

| 编号 | 现象 | 状态 |
|---|---|---|
| [0001](0001-answer-flicker.md) | 答后正文闪烁：pending 交互作答恢复时，正文短暂消失再回来 | resolved |
