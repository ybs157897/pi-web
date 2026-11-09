# .agents/notes/ — 跨批次决策记录

本目录是 `docs/spec.md` 之外的补充决策通道：spec.md 是编年权威，notes 面向「一条决策一页纸」的检索与生命周期管理。层级归属见 [docs/AGENTS.md](../../docs/AGENTS.md)；本 README 本身不参与格式校验。

## 何时写一条 note

同一批次内，只为「代码、测试、现有文档都解释不了的持久决策理由」写或更新 note。机械修改、局部重命名、顺手修复等无需决策背景的改动豁免。决策已有归属文档（subsystem 页、defensive-pattern、cookbook）时更新那份文档并留链接，不在 notes 双写；`docs/spec.md` 已记录的决策不重复进 notes——notes 记 spec.md 装不下的展开版（完整备选方案、长期后果、否决理由）。

## 布局：四态 × 六分类

每个 note 落在 `{生命周期}/{分类}/` 下的一个 Markdown 文件里，分类为 feature / bug-fix / simplification / architecture / process / testing 六选一。状态迁移是移动文件（proposed → implemented 或 rejected；implemented → archived），移动时**不改文件名**。

## 命名规则

文件名 `{yyyy-mm-dd}-{topic-slug}.md`：日期是首次提出日（不随状态迁移更新），topic-slug 用小写字母、数字与连字符。示例：`2026-11-09-doc-budget-gate.md`。

## 四态含义

- `proposed/`：提案待决——已有明确方案与验收判据，等待实施或否决。
- `implemented/`：已实施——Decision 节用现在时描述今天生效的决策。
- `rejected/`：否决——决策已否决，保留否决理由与考虑过的备选方案。
- `archived/`：被取代冻结——决策被后续决策取代，只读保留，不再更新。

## 格式要求

每个 note 第一行 `# Agent Note: <标题>`，顶部附近一行 `Status: <生命周期>` 且与所在目录一致；标题骨架按生命周期而异（proposed 需 `## Proposal`、`## Acceptance criteria`、`## Risks`；implemented 需 `## Decision`、`## Consequences`；rejected 需 `## Decision`、`## Alternatives considered`；archived 只查 Status）。`scripts/verify-agent-note-format.ts` 执法，违反即红。
