---
name: hooks-creator
description: 用户要求创建或管理钩子（hooks）、在文件修改后自动检查、本轮结束后更新文档、拦截危险命令、压缩前注入摘要等事件驱动自动化时使用。指导先向用户确认超时与级别，再用 manage_hooks 一站式创建跨平台脚本钩子。普通一次性脚本执行、与事件触发无关的自动化不适用。
---

# Hooks Creator

把用户想要的「某件事发生时自动做另一件事」落地为 pi-web 钩子：事件触发 → 子进程脚本 → JSON 决策。本技能约束创建流程、事件选型、脚本规范与信任边界。

## 创建流程（硬约束）

1. **先确认，后创建。** 创建或修改钩子前，必须先用 `ask_user_question` 向用户确认两件事，未获答复不得调用 `manage_hooks` 的写操作：
   - **超时时间**：首选项「15 秒（推荐）」，另给 5 秒 / 30 秒 / 60 秒 / 自定义。超时会被杀进程树并记为 timeout，不阻断会话。
   - **级别**：个人习惯、只在本机生效 → `user`（用户级）；团队共享、随仓库走（配置在 `<仓库>/.pi-web/hooks.json`）→ `project`（项目级）。
2. **选事件与 matcher**：按下方映射表确定 event；工具类事件（PreToolUse/PostToolUse/PostToolUseFailure）用 matcher 过滤工具名。
3. **写脚本**：按下方脚本规范编写 `.mjs`，通过 `manage_hooks` 的 `script` 参数一站式落盘（不必手动写文件）。
4. **创建并验证**：调用 `manage_hooks`（action=create），向用户复述生效方式（立即生效，无需重启）与触发条件；必要时现场触发一次验证。

## 场景 → 事件映射

| 用户想要的效果 | event | matcher | 说明 |
| --- | --- | --- | --- |
| 文件修改后自动检查（lint/格式/类型） | PostToolUse | `Write\|Edit` | stdin.tool_response 是工具结果；失败不走这里 |
| 本轮改过文件后更新 docs/CHANGELOG | Stop | 缺省 | stdin.changed_files 列出本轮修改的文件；decision:block 可要求续跑一轮（上限 3 次） |
| git 操作后自动做某事 | PostToolUse | `Bash` | 脚本内自行判断 tool_input.command 是否 git 命令 |
| 拦截危险命令（rm -rf / 强推等） | PreToolUse | `Bash` | decision:block 或 exit 2 阻断调用；默认只拦模型直发，includeNested:true 才拦嵌套 |
| 工具失败后自动诊断/提示 | PostToolUseFailure | 按需 | stdin.error 是错误消息 |
| 压缩前注入保留要点/拒绝压缩 | PreCompact | 缺省 | hookSpecificOutput.summary 替代摘要；decision:block 拒绝本次压缩 |

matcher 语义：缺省/空/`*` 匹配全部；纯名称列表（`Write|Edit`）精确匹配、大小写敏感；其余按 JavaScript 正则。

## 脚本规范

- **node .mjs，三平台一致**：`type: "process"`、`command: "node"`、`args: ["<脚本路径>"]`。process 型 argv 直传不经 shell，优先于 command 型（后者 posix 走 bash、Windows 走 powershell，语法不通用）。
- **读 stdin 单行 JSON**：载荷含 `hook_event_name`、`session_id`、`cwd` 与事件专属字段（tool_name/tool_input/tool_response/error/changed_files/stop_hook_active/last_assistant_message/reason 等）。
- **退出码契约**：exit 0 成功；exit 2 阻断（PreToolUse 拦调用、Stop 要求续跑、PreCompact 拒绝压缩，stderr 作为原因）；其他非零为可恢复失败，不阻断会话。
- **stdout JSON 契约**（以 `{` 开头才解析；非 JSON 输出仅诊断）：
  - `additionalContext`：注入给模型的附加上下文（PostToolUse 追加到工具结果末尾）。
  - `decision: "block"` + `reason`：阻断/续跑请求。
  - `hookSpecificOutput`：`{ hookEventName, permissionDecision: "allow"|"deny", permissionDecisionReason, updatedInput }`（PreToolUse）；`{ hookEventName: "PreCompact", summary }`（PreCompact 替代摘要）。
  - `updatedInput`：整体替换工具调用参数（PreToolUse）。
- **禁 POSIX 专属语法**：脚本内不要依赖 bash 特性、`/tmp` 硬编码路径、`chmod` 等；路径用 `node:path`，临时目录用 `node:os` 的 tmpdir。
- 脚本要快（默认超时 15 秒）、幂等、失败时给出可读 stderr。

## 完整示例：Stop 钩子按本轮修改文件更新 docs

脚本 `update-docs.mjs`（本轮改过 src 文件时，要求续跑一轮更新文档）：

```js
let raw = ''
process.stdin.on('data', chunk => { raw += chunk })
process.stdin.on('end', () => {
  const input = JSON.parse(raw)
  const changed = Array.isArray(input.changed_files) ? input.changed_files : []
  const touchedSrc = changed.some(file => file.startsWith('src/'))
  if (!touchedSrc) process.exit(0) // 没改源码，放行结束
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `本轮修改了 ${changed.length} 个文件（含源码），请检查 docs/ 是否需要同步更新后再结束。`,
  }))
  process.exit(0)
})
```

`manage_hooks` 调用参数（超时与级别已经 ask_user_question 确认）：

```json
{
  "action": "create",
  "scope": "project",
  "event": "Stop",
  "hook": { "type": "process", "command": "node", "args": [".pi-web/hook-scripts/update-docs.mjs"], "timeoutMs": 15000 },
  "script": { "name": "update-docs.mjs", "content": "<上面的脚本内容>" }
}
```

注意：Stop 续跑有 3 次硬上限；脚本应只在确有未完成事项时 block，避免每轮都要求续跑。

## 信任边界

- **用户级**无信任门：本机自己写的配置，enabled 即执行。
- **项目级**随仓库走：外部带来的声明（如 git clone 带来的 `.pi-web/hooks.json`）默认 **pending，不执行**，须用户在设置页批准后才运行。
- 经 `manage_hooks` 创建的项目级钩子视为已获用户确认，**自动信任**；修改执行参数（命令/参数/超时等）会使信任失效、回落 pending，启停（enabled）不影响信任。
- 信任存储损坏时项目级全部拒绝执行（fail-closed）；list 中显示为 blocked。

## 边界

- 本技能不授予额外权限：只调用当前可调用的工具；canWrite 拒绝时引导用户去设置页。
- 不代替用户决定超时与级别；这两个问题必须问。
- 管理操作（update/delete/set_enabled）先用 list 拿到 index，再按序号操作；不要凭记忆猜序号。