# 加一个内置工具

把一个新的模型可调用工具（或对既有工具的参数 / 描述扩展）接入内置工具面，并让它通过目录生成、权限过滤与提示词快照的全部守卫。

前置条件：先读 [architecture.md](../architecture.md) 的「扩展点阅读顺序」与生成的 [tool-catalog.md](../tool-catalog.md)（现有工具面与五个变体的差异）；检索 / shell 类工具另读 [subsystems/search-and-shell.md](../subsystems/search-and-shell.md)。

## 步骤

1. 定义工具：在 [src/server/tools/](../../src/server/tools/) 下新建扩展文件，或在既有扩展里追加一个 `defineTool`。给出 `name`（snake_case）、`parameters`（`@earendil-works/pi-ai` 的 TypeBox `Type.Object`）与 `description`——description 是写给模型看的英文使用契约（何时用、何时不用、边界与输出约定），参照 [todo.ts](../../src/server/tools/todo.ts) 的 `todo_write`。
2. 注册扩展：在 [src/server/runtime/index.ts](../../src/server/runtime/index.ts) 的 `registry.install` 静态序列里安装（`CodingTools`、`TodoTools` 那一段）。安装序即注册序，目录 default 变体按它排序；新扩展必须装在 `refreshMcpExtensions()` 首次调用之前——执行策略扩展在那时捕获已安装工具快照，并给每个工具包上计划模式守卫。
3. 补来源映射：在 [gen-tool-catalog.ts](../../scripts/gen-tool-catalog.ts) 顶部的 `TOOL_SOURCES`（[gen-tool-catalog.ts:44](../../scripts/gen-tool-catalog.ts#L44)）加 `name → 源文件路径`。完整性守卫双向咬合：`src/server/tools` 下扫到的每个 `name: '…'` 字面量必须出现在某个 runtime 变体；每个变体工具必须有映射；每条映射必须指向存在的文件。守卫不过，`npm run gen:docs` 与 `--check` 门直接失败。
4. 按工具类别决定权限面登记（写工具什么都不用登记）：
   - 只读工具（不写任何状态）：把名字加进 `READ_ONLY_TOOLS`（[helpers.ts:87](../../src/server/runtime/helpers.ts#L87)），只读会话才会保留它。
   - 交互工具（问用户、不触碰工作区）：除 `READ_ONLY_TOOLS` 外，同时加进 `PLAN_TOOLS`（[execution-policy.ts:18](../../src/server/conversation/execution-policy.ts#L18)）与镜像的 `PLUGIN_UI_PLAN_TOOLS`（[helpers.ts:92](../../src/server/runtime/helpers.ts#L92)），计划模式与插件页面调用面才继续放行。
   - 写工具：不在 `PLAN_TOOLS` 里就会被计划模式的执行守卫自动拦截，不在 `READ_ONLY_TOOLS` 里就会被只读会话自动剔除，无需登记。
5. 刷新快照：`npx vitest run tests/prompt-snapshot.test.ts -u` 更新 [tests/__snapshots__/prompt/](../../tests/__snapshots__/prompt/)，然后逐份 `git diff` 审阅——每个变体头部的 `tools (N; …)` 行应出现（或按权限面不出现）新工具，default 变体另含它的 description 与参数 JSON。
6. 重新生成目录：`npm run gen:docs` 重写 `docs/tool-catalog.md`。
7. 全量验证：`npm run check`。

## 验证

1. `npx tsx scripts/gen-tool-catalog.ts --check` 通过——新工具已进目录且 `TOOL_SOURCES` 映射完整。
2. `npx vitest run tests/prompt-snapshot.test.ts` 通过——快照与真实工具面一致。
3. `git diff tests/__snapshots__/prompt/` 中新工具的出现范围与权限面匹配：写工具不出现在 plan、readonly 变体，也不出现在只读的 subagent-explore 子智能体变体。
4. `npm run check` 通过。

设计理由：提示词快照成为改动评审门的由来见 [spec.md 2026-10-28 段](../spec.md)；工具路由按当前能力复核（计划 / 只读 / 子会话裁剪）见 [spec.md 2026-11-04 段](../spec.md)。
