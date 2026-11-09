# 演进一个预设（AgentPreset）

预设是把扩展、工具、指令、模型默认与访问模式打包命名的配置，新会话一键套用；本篇讲如何演进它的类型、校验与设置页接线（只是新建一个预设请在设置页完成，不涉及代码）。

前置条件：先读 [architecture.md](../architecture.md) 的「Default runtime policy」（预设如何收窄会话工具面与访问模式）。

## 步骤

1. 类型：预设形状是 [types.ts:301](../../src/shared/types.ts#L301) 的 `AgentPreset`（`id` / `name` / `description` / `instructions` / `extensions` / `tools` / `model` / `thinkingLevel` / `accessMode`），创建与更新输入 `CreateAgentPresetInput` / `UpdateAgentPresetInput` 同文件；加字段从这里开始。
2. 校验：`validatePreset`（[presets.ts:31](../../src/server/runtime/presets.ts#L31)）在 create 与 update 上都跑——ID 格式、名称 / 指令长度、扩展与工具不得重复、每个扩展必须已安装（`installedExtensions`）、每个工具必须属于所引扩展（[presets.ts:44](../../src/server/runtime/presets.ts#L44)）、模型须在目录且过白名单、`thinkingLevel` 合法、`workspaceWrite` 依赖沙盒可用性；改校验规则只动这里。
3. 服务接线：`createPresets` 由 [src/server/runtime/index.ts](../../src/server/runtime/index.ts) 装配，`installedExtensions` 传入 `registry.snapshot().installed()`——新扩展 / 工具装进 registry 后预设即可引用，`presets.ts` 本身不用改。
4. 设置页：预设面板 [PresetsPanel.tsx](../../src/web/PresetsPanel.tsx) 的扩展 / 工具是逗号分隔的名称输入，不逐项注册——新工具只要名字正确即可被引用与保存；HTTP 侧是 `/api/presets` 的 typed routes（用例见 [tests/http.test.ts](../../tests/http.test.ts)）。
5. 删除保护：被 automation 引用的预设拒绝删除（`assertNoAutomationReferences`，[presets.ts:74](../../src/server/runtime/presets.ts#L74)），改动预设生命周期时保持该约束。

## 验证

1. `npx vitest run tests/runtime-policy.test.ts` 通过——预设裁剪会话工具面的行为用例（Plan 只读、退出恢复等）。
2. `npx vitest run tests/models.test.ts` 通过——模型不在白名单时 `createPreset` 以 `MODEL_UNAVAILABLE` 拒绝。
3. 判据：create / update 一个引用不存在工具名的预设被拒（`INVALID_INPUT`「Preset 引用了未安装的工具」）；该校验分支目前没有专门单测，触碰校验逻辑时应随改随补。
4. `npm run check` 通过。

设计理由：presets 作为独立 runtime 功能模块的拆分见 [spec.md 2026-10-30 段](../spec.md)；用只读预设隔离后台写入的实际用法见 [spec.md 2026-10-26 段](../spec.md)。
