# 待办清单（todo）

> 状态：现状参考（2026-11-09 自 docs/families.md §1 抽取）。决策与验收历史见 [docs/spec.md](../spec.md) 对应日期段。

## 机制总览

待办是会话级的执行步骤清单：模型通过 `todo_write` 工具全量替换清单，快照落在 conversation doc `pi-web.todos`（`{ items, updatedAt }`，[todo.ts:15](../../src/server/tools/todo.ts#L15)），投影把它读进 `ConversationDetail.todos` 并丢弃畸形条目（[projection.ts:558](../../src/server/conversation/projection.ts#L558)）。工具面与 section 注入现状以 [tool-catalog](../tool-catalog.md)（`todo_write` 在 plan 变体被排除）与 [section-catalog](../section-catalog.md) 为准。

## 工具契约

`todo_write` 一次调用替换整份清单，省略的条目即删除。约束在工具内强制（[todo.ts:51](../../src/server/tools/todo.ts#L51)）：每条 content trim 后非空、内容全局唯一、清单上限 100 条（`MAX_TODO_ITEMS`），status 取 `pending / in_progress / completed`；返回文本给三态计数，`details` 通道携带清单与计数供 UI 使用。计划模式激活时调用直接报错（提交事务内对已提交文档二次复核，[todo.ts:52](../../src/server/tools/todo.ts#L52)）——待办跟踪批准后的实施步骤，不属于计划阶段，`execution-policy` 的工具白名单在执行层同样拦它（见 [plan-mode.md](plan-mode.md)）。

## 提示词注入

`work-policy` section 按当前工具路由渲染待办约定（[work-policy.ts:159](../../src/server/conversation/work-policy.ts#L159)）：`todo_write` 直接可用时给出完整步骤规则（非平凡多步工作先列步骤与必要验证、串行只标一个 `in_progress`、完成即更新、没有证据不得把实现或验证标为完成）；只能经 `codemode` 调用时改口为脚本内 `await tools.todo_write(...)`；完全不可用时明确告知本请求没有待办工具、不要编造调用。计划模式与委派子会话的 `work-policy` 变体不含待办条款。

## 生命周期

新用户输入被 place 时清单在同一提交事务里清空（queued 输入稍后才 place，其回合保留这份清单，[conversations.ts:228](../../src/server/runtime/conversations.ts#L228)）——一次新回合不带旧清单。持久状态放 conversation doc 而非从 tool call 参数推导，因此压缩（compaction）把旧 assistant entry 移出 active view 后清单仍在。

## UI

[TodoPanel.tsx](../../src/web/TodoPanel.tsx) 挂在输入卡上方（[App.tsx:2170](../../src/web/App.tsx#L2170)，右侧状态卡占用时让位）：默认折叠、头部按状态计数、每条一行，空清单不渲染。右侧状态卡的胶囊优先级链以 Todo 为第一优先，Mini 态也能经胶囊回到待办。

## 已知限制

- 提示词顺从度是模型边界而非机制保证：验收里 S3/S4 类「模型不自愿遵守协议」的场景记为顺从度边界（[spec.md 2026-10-28](../spec.md) 段）。
- 写工具移除后的 todo 提醒、强制待办阈值与冲突状态规则被有意否掉，不做这类扩展（[spec.md 2026-11-05](../spec.md) 段）。
