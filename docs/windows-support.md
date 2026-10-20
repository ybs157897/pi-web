# Windows 兼容性审计与逐项支持说明

- 审计时间：2026-10-19；2026-10-20 复核门禁并补入 Git 分支、Skills 与默认任务规划。
- 代码快照：基线 `8e73f16` + 本次未提交改动。审计期间曾有并发合入，最终门禁已按 2026-10-20 的稳定工作树复核。
- 审计范围：全部产品功能、服务端 OS 集成、浏览器前端、持久化、依赖/构建/脚本/测试与 CI。
- 审计方法：macOS + Node v24.15.0 静态代码与依赖审计；`path.win32` 路径语义与 Node 行为实验；macOS 基线测试；未使用 Windows 实机。
- **边界：本文不是 Windows 实机验收证明。** 标为「待实机」的项目必须在 Windows 10/11 + Edge/Chrome 上复测后，才能视为已验证。
- 文档关系：本文是 Windows 能力的完整清单；README 的 Windows 章节是操作入口；architecture 的 Platforms 小节是架构摘要。三处结论应保持一致。

## 审计快照门禁

以下是本次审计时的真实门禁，不把「在途代码」当成已交付能力：

- `npm run build`：通过（Vite Web 构建）。
- `npm run typecheck`：通过。
- `npx vitest run`：20 个测试文件 / 241 项全绿（2026-10-20 复核）。
- Git 分支服务端、API、`src/web/GitBranchSwitcher.tsx` 与测试已落地；Skills 与默认任务规划扩展也已接入。
- 仓库仍无 `.github/` 或任何 Windows CI，上述绿色门禁**只在 macOS 上**成立。

**因此，当前工作树可以按 macOS 基线交付审查，但不能宣称「Windows 可交付」；Windows 仍未实机验收，整体只能按本文的「有条件支持」处理。**

## 结论

**当前项目不是所有功能都原生支持 Windows，整体属于「有条件支持」。**

- Web 界面、会话/SSE/队列/停止/分叉/恢复、`node:sqlite` 持久化、模型与 Provider、Code mode/QuickJS、MCP、Skills、子代理/团队/目标/计划/待办/问答，主体是 Node + 浏览器标准能力，静态判断可跨平台使用；但仍受下方路径、IME、ACL、Git Bash 和测试缺口影响。
- 命令执行工具（`bash`）依赖 **Git for Windows** 提供的 bash；项目没有注册 Pi 的 PowerShell 工具作为 Windows 原生兜底。没有 bash 时会话仍可运行，但命令不会执行。
- `workspaceWrite` 访问模式仅 macOS `sandbox-exec` 可用；Windows 只提供 `readOnly` / `fullAccess`，这是设计限制。
- Windows 原生目录选择器（koffi + COM `IFileOpenDialog`）代码已接入，但从未在 Windows 实机验证；失败时没有可用回退，当前属于高风险路径。
- Git 分支能力要求 PATH 中同时有 `git.exe` 和兼容的 Git for Windows；它和 bash 的 `bash.exe` 是两个独立探测。
- **自动化存在跨平台计时器缺陷**：超过约 24.85 天的 `setTimeout` 会被 Node 截断为 1 ms，可能立即重复执行。
- **测试不可移植**：即使安装 Git Bash，Windows 上仍至少有 POSIX 权限断言和 Skills 路径断言会失败；符号链接测试还取决于 Windows Developer Mode/权限。

## 状态口径

| 状态 | 含义 |
| --- | --- |
| 支持 | 没有发现 OS 阻断；macOS 基线测试覆盖，大多数可在 Windows 直接运行。 |
| 有条件 | 功能存在，但依赖 Git for Windows、特定浏览器、交互桌面、文件系统或存在已确认缺陷。 |
| 待实机 | 代码已接入，但没有 Windows 实机证据；不能视为已验证。 |
| 不支持 | 当前代码明确返回 UNSUPPORTED，或缺少 Windows 实现。 |
| 门禁红 | 功能未完成，或当前快照 typecheck/test/build 未全绿，不能交付。 |

## 全功能支持矩阵

| 功能 | 结论 | Windows 说明 |
| --- | --- | --- |
| 安装、`npm ci`、dev/build/start | 有条件 | Node ≥ 22.19（推荐 24），npm ≥ 8（Rollup 要求，lockfile v3）；`npm ci` 用默认参数，不要 `--omit=optional`，否则 koffi/esbuild/Rollup 的 win32 optional 包都会缺失；`npm run build` 在当前快照通过。Windows 实机启动待验。 |
| npm 脚本 | 有条件 | `dev/build/start/typecheck/test` 本身是跨平台命令；`check` 使用 `&&`，默认 cmd 可用；若把 npm `script-shell` 改成 PowerShell 5.1，`&&` 会失败。 |
| 环境变量启动 | 支持 | cmd 用 `set NAME=value`；PowerShell 用 `$env:NAME='value'`；Git Bash 用 POSIX 写法。 |
| Web UI 基础/主题/字体 | 有条件 | 无 Electron/macOS API；字体栈含 Segoe UI、微软雅黑、Consolas；依赖 `:has`、`color-mix`、`@container`、`100dvh` 等现代 CSS，建议当前稳定版 Edge/Chrome，实机未验。 |
| 会话、SSE、队列、停止、分叉、刷新/重启恢复 | 支持 | 纯 HTTP + SSE + SQLite；Windows 无需额外适配；长连接休眠/VPN 切换/WAL 强杀恢复待实机。 |
| 模型目录、Provider、凭据 | 有条件（安全弱化） | 只读导入 `%USERPROFILE%\.pi\agent\{settings,models,auth}.json`；应用自己的 Provider/凭据写入数据目录 `providers.json`。Windows `chmod 0600/0700` 只切换只读位，不建立 ACL；凭据、app-state、SQLite 会话和附件都依赖用户目录默认 ACL。 |
| 设置、主题、字号、语言、发送模式 | 支持 | 原生 React 表单/状态；注意快捷键编辑当前必失败（X1）。 |
| 快捷键编辑/恢复默认 | **不支持（现有回归）** | 客户端发送 10 个快捷键，服务端 strict schema 只接受 7 个，`rename/fork/archive` 触发 400。 |
| 工作区添加（原生选择器） | 有条件/高风险 | Win32 koffi + COM 已接入但无 Windows 实机；失败映射 500 且前端无回退；返回 `C:\...` 后前端用 `/` 取名，长路径会添加失败。 |
| 内置目录浏览器 | 有条件/当前不可达 | 仅在 picker 错误文案包含中文「原生目录选择器」时打开，Windows 实际错误是 `Internal server error`；即使打开也拒绝 UNC/`\\?\`、没有盘符入口。 |
| 工作区文件浏览、@ 引用、搜索、Inspector | 有条件 | 工作区相对路径统一用 `/`，正常浏览可用；工具产生的 `C:\...`、`src\foo` 或临时绝对路径点击打开会被服务端拒绝；路径行会显示 `C:\root/sub` 混合分隔符。 |
| 附件、拖拽、粘贴、缩略图 | 有条件 | File API 跨平台；AVIF 前端可添加但服务端拒绝；拖放可能双触发；Windows 非法文件名/ADS/保留设备名未完整过滤；附件非原子落盘。 |
| `read`/`write`/`edit` 工具 | 支持（静态） | Pi `NodeExecutionEnv` 使用 Node fs；edit 处理 CRLF/BOM；Windows ACL/只读属性错误待实机。 |
| `bash` 工具 | 有条件（Git for Windows） | Pi 在 win32 先查 `ProgramFiles\Git\bin\bash.exe`、`ProgramFiles(x86)\Git\bin\bash.exe`，再执行 `where bash.exe`；接受 PATH 上任意 bash，只有 legacy WSL System32 bash 走特殊 stdin 参数。没有 bash 返回 `shell_unavailable`。 |
| PowerShell 工具 | 未接入 | Pi 1.3.0 提供 `createPowerShellTool()`，本项目只注册 `CodingTools`（read/write/edit/bash）；无 Git Bash 时没有原生 shell 兜底。 |
| `workspaceWrite` 访问模式 | 不支持（设计限制） | 仅 macOS `sandbox-exec`；Windows capabilities 正确降级为 readOnly/fullAccess。旧数据中的 default/session/preset 值需迁移。 |
| Code mode/QuickJS | 支持（静态） | QuickJS-WASI + worker_threads，无 Windows 原生扩展；脚本里的 `tools.bash` 同样依赖 Git Bash。 |
| MCP（stdio / Streamable HTTP） | 有条件 | pi-mcp 的 stdio 使用 cross-spawn（支持 `.cmd`/PATHEXT），关闭时用 `taskkill /T /F`；HTTP 使用全局 fetch。代理/TLS、`npx` shim、强杀残留待实机。 |
| 待办（todo） | 支持 | 纯进程内 doc/工具/面板，无 OS 依赖。 |
| 计划模式（plan） | 支持 | 纯进程内 doc/section/交互卡；无 OS 依赖。 |
| 目标（goal） | 支持 | 纯进程内 doc + onYield；无 OS 依赖。 |
| 默认任务规划/进度 | 支持（静态） | `runtime-policy` 启动时读取 `src/server/prompts/runtime-core.md`，并按真实 todo/codemode 路由生成 section；无 OS API。Windows 需验证发布包内提示词文件存在。 |
| 问答（ask_user_question） | 有条件 | 主流程无 OS 依赖；Enter/Escape 的 IME 组合态保护不完整，微软拼音可能误提交/误关闭。 |
| 子代理（subagent） | 有条件 | 会话/投影/轮询无 OS 依赖；跟进输入和面板 Escape 的 IME 保护不完整。 |
| 智能体团队（team） | 支持（静态） | 共享任务板、成员、wait_agent 均为进程内实现；无 OS API。 |
| 自动化（automation） | **部分不支持（跨平台缺陷）** | schema 允许 365 天，但 `setTimeout` 只接受 32 位毫秒；超过约 24.85 天会 clamp 到 1 ms，导致立即/反复执行。 |
| Skills（技能） | 有条件/待实机 | 服务端路径校验显式处理 Windows 保留名、反斜杠、盘符和 UNC；frontmatter 支持 BOM/CRLF；保存使用同目录 rename。测试本身有 `/` 与 symlink 权限假设；Windows 实机未验。 |
| Git 分支（列表/切换/新建并切换） | 有条件/待实机 | 服务端/API/UI 已完成，macOS 单测与 demo 浏览器已验；要求 PATH 有 `git.exe`；Git 不存在与「不是仓库」当前返回同一 issue；无 Windows/Git 集成测试。 |
| 反馈、Session 日志下载 | 有条件 | 浏览器 Blob 下载跨平台；导出名过滤 `\/:*?"<>|`，但未处理 `CON/PRN/AUX/NUL/COM1/LPT1` 等 Windows 保留设备名。 |
| Agent Preset | 有条件 | app-state 持久化正常；旧数据中的 `workspaceWrite` preset 在 Windows 无法保存，Presets 下拉也没有该选项，迁移说明需点名。 |
| 打开配置文件 | 有条件/待实机 | Win32 使用 `cmd /c start "" <path>`；路径含 `%`、`&`、`^` 等 cmd 元字符时可能失败或被解释。 |
| 优雅关闭 | 有条件 | 只监听 SIGINT/SIGTERM；Windows 不投递 SIGTERM，关闭控制台/任务管理器/`taskkill` 不走 `app.shutdown()`/`runtime.close()`，MCP/bash 子进程可能残留。Ctrl+C 正常。 |
| `node:sqlite` 持久化 | 有条件 | Node 22.19 Windows 版自带 `node:sqlite`；NTFS WAL、Defender、OneDrive、强制结束后的恢复需实机验证。 |
| Host/Origin 本地安全 | 支持（静态） | 仅允许 localhost/127.0.0.1/::1，并校验 Origin 与 Sec-Fetch-Site；未见 Windows 特有错误。 |
| `npm run typecheck` | 支持（macOS 基线） | 纯 tsc；2026-10-20 复核通过。Windows 仍需实机跑一次（理论上跨平台）。 |
| `npm test` | 有条件/预计失败 | macOS 基线 241/241 通过；Windows 上至少会因 POSIX mode 和 Skills 路径分隔符断言失败，symlink/Git 用例还取决于权限和 PATH。 |
| `test:smoke` | 有条件 | 硬前置是先 `npm run build`；demo 会话会尝试调用 bash，但脚本不把 bash 成功作为硬断言。脚本用 SIGTERM 做优雅关闭断言，在 Windows 上不成立/会假绿。 |
| `test:live` | 支持（需真实模型） | 无 OS 假设，但需要可用凭据与网络。 |
| `test:live:tools` / `test:live:codemode` | **不支持** | 写死 `accessMode: 'workspaceWrite'`，Windows create 即 UNSUPPORTED；只能改用 fullAccess 手动验收或平台化脚本。 |
| `test:live:skills` | 有条件/待实机 | 使用 `fullAccess`，理论上 Windows 可跑；但仍要求真实 DeepSeek 模型、网络和凭据，且没有 Windows 实机证据。 |
| `test:live:workflow` | 有条件/待实机 | 按平台动态选择 workspaceWrite/fullAccess，Windows 会走 fullAccess；需要真实 DeepSeek、Git Bash 和 Node `--test`，无 Windows 实机记录。 |
| `scripts/render-fixture.ts` | 有条件 | 不是 npm script，用 `npx tsx scripts/render-fixture.ts` 运行；demo 模型依赖 bash 的 `cat`/`base64 -d`，需要 Git Bash。 |
| Windows CI | 缺失 | 仓库无 CI；原生 picker、Git 分支、Skills、WAL 与脚本均无 Windows 自动门禁。 |

## 新增功能逐项补充

### Skills（技能目录、加载、保存、校验）

- 服务端 `src/server/skills.ts` 从仓库内置 `skills/`、当前工作区 `.agents/skills/` 和 `.pi/skills/` 读取技能；`skill_list`、`skill_load`、`skill_save`、`skill_validate` 构成生命周期。设置页只读展示目录、正文、资源与校验结果。
- Windows 相关静态结论：
  - 所有路径用 `node:path` 与 `realpath`/`lstat` 处理，不硬编码 `/` 作为文件系统分隔符；HTTP 协议里的资源路径则明确要求 `/`，并拒绝 `\`、盘符、UNC、`..`。
  - 技能名按小写 kebab-case 校验，同时显式拒绝 `con/prn/aux/nul/com1..9/lpt1..9` 等 Windows 保留设备名。
  - frontmatter 支持 UTF-8 BOM 与 CRLF；`skill_save` 使用同目录临时文件 + `rename`，理论上可替换已有文件。
  - 拒绝符号链接；junction/reparse point 的识别和越界保护需 Windows 实机确认。
  - `chmod 0600` 不提供 Windows ACL 隔离，技能文件与工作区其它文件一样依赖用户目录/工作区 ACL。
- 测试与验收：
  - `tests/skills.test.ts:69` 断言诊断路径包含 `/broken-skill/SKILL.md`，Windows 的 `path.join` 会生成 `\`，该断言预计失败。
  - `tests/skills.test.ts:130,132` 主动创建 symlink；普通 Windows 用户未开启 Developer Mode 或无 SeCreateSymbolicLinkPrivilege 时会 EPERM，不能把整套测试当成无条件通过。
  - `test:live:skills` 未写死 `workspaceWrite`，但使用真实模型和 fullAccess；当前只能标「待 Windows 实机」。
- 结论：服务端代码已考虑 Windows 路径安全，但**Windows 可交付状态 = 有条件/待实机**。

### Git 分支（本地分支列表、切换、新建并切换）

- 服务端 `src/server/git-branches.ts` 通过 `execFile('git', ...)` 调用系统 Git，提供快照、`git switch --no-guess`、`git switch --no-guess -c`，并将阻塞原因归一为结构化 issue。
- Windows 要求：
  - PATH 上必须有 `git.exe`。仅安装 Git for Windows 并让 bash 工具可用，不等于 `git.exe` 一定在 Web 服务进程的 PATH；这会影响分支功能。
  - `git switch` 需要 Git ≥ 2.23；测试里的 `git init -b` 需要 Git ≥ 2.28。建议使用当前 Git for Windows。
- Windows 静态行为：
  - `execFile` 带 `windowsHide: true`，避免弹出控制台窗口。
  - `for-each-ref` 输出按 CRLF 归一化，分支记录用 NUL 分隔，适合空格和中文分支名。
  - issue 的阻塞路径把 `\` 归一为 `/`，符合前端展示约定。
  - Git 不存在（ENOENT）和「目录不是仓库」目前都会返回 `not-a-repository`，提示不准确，Windows 用户可能误以为路径问题。
- 当前实现：`src/web/GitBranchSwitcher.tsx`、服务端/API 与 `tests/git-branches.test.ts` 已落地，macOS 单测和 demo 浏览器流程通过。
- 仍缺 Windows 实机/Git 集成验证；因此结论是「有条件/待实机」，不是原生验证通过。

### 默认任务规划与运行时核心提示词

- `src/server/work-policy.ts` 在服务模块加载时用 `readFileSync(new URL('./prompts/runtime-core.md', import.meta.url))` 读取核心提示词；`node:fs` 的 file URL 读取在 Windows 上可用，无 shell 依赖。
- `runtime-policy` 扩展本身不贡献工具；它按实际 `todo_write`/`codemode` 路由生成待办指导，并按 Plan/Goal 状态生成限制。属于进程内 section，不依赖 OS。
- `test:live:workflow` 使用真实 DeepSeek 执行多步开发样例，并用宿主侧 Node `--test` 独立核验产物；Windows 上还需要 Git Bash，因为模型通常会调用 `bash` 运行验证。

### Code mode 与 MCP

- Code mode 的 QuickJS 运行在 WASI/worker 中，不依赖 Windows 原生扩展；脚本内调用 `tools.bash` 时仍受 Git Bash 限制。
- MCP stdio 通过 cross-spawn 调取 Windows `.cmd`/PATHEXT 程序；进程树关闭使用 `taskkill /T /F`，比直接 kill 更适合 Windows。HTTP transport 使用全局 fetch。
- 仍待实机：企业代理/自定义 CA、`npx` shim、带空格/中文的 server command、强制关闭后 MCP 子进程是否残留。需要令牌的 MCP 服务器仍用 headers/本地 stdio；OAuth 未接入。

### 子代理、团队、目标、计划、待办、问答

- 这些能力都是进程内 doc/工具/投影/React UI，未发现 Windows 专属 API。静态矩阵判为支持。
- 但交互输入仍有 IME 风险：重命名、新建文件夹、目标编辑、问答自定义答案、子代理跟进输入等在微软拼音选词时可能误提交；具体见 X2。
- 团队共享看板与 `wait_agent` 有界等待不依赖 OS；计划/目标/待办只写 Pi doc。

### 自动化

- 调度器在 `src/server/runtime.ts:550-559` 直接使用 `setTimeout(delay)`。Node 24 实测：`setTimeout(..., 31536000000)` 打印 `TimeoutOverflowWarning` 并约 2 ms 后触发。
- UI/schema 允许最长 365 天（`src/server/app.ts` 的 automation schema），因此超过 2^31-1 ms（约 24.85 天）的间隔会失控。该缺陷不是 Windows 专属，但在 Windows 长时间运行/开机自启场景更容易暴露。
- 当前建议：Windows 上只使用 ≤24 天的 interval，或等平台化修复。

### 反馈、Session 导出、Preset 与旧数据迁移

- Session 导出使用浏览器 Blob，跨平台可用；文件名已过滤 `\/:*?"<>|`，但还需处理 Windows 保留设备名（如 `CON.jsonl`）和控制字符。
- Agent Preset 中的 `workspaceWrite`：
  - 旧 `.data` 从 macOS/Linux 迁到 Windows 后，默认 accessMode、每个会话的 metadata、每个 Agent Preset 都可能仍是 `workspaceWrite`。
  - Windows capability 和无 OS 沙盒的保存校验都会拒绝它；Presets 下拉只提供 readOnly/fullAccess。仅改默认会话设置不够，必须逐个修正 preset 和已存在会话。
- 迁移前请停止旧服务并备份 `.data`；复制后重新添加工作区，修正 `defaultWorkspaceId`、旧会话 `workspaceId`、accessMode 与 preset。

## 一、Windows 专属缺陷与限制

### W1（高）原生目录选择器失败后没有兜底，也没有前端取消

- Windows driver 在 worker 失败时抛普通 `Error`（`src/server/win32-dialog.ts:139,154`），服务端统一映射为 500 `Internal server error`（`src/server/app.ts:191`）。
- 前端只有在错误文案包含中文「原生目录选择器」时才打开内置浏览器（`src/web/App.tsx:1077`）；Windows 错误除非巧合，否则永远不会触发。
- `WorkspaceDialog` 手动输入路径的入口实际不可达：`workspaceDialogOpen` 只有 setter 调用成 false 的地方，全仓库没有 `setWorkspaceDialogOpen(true)`。
- Win32 选择器没有总超时，前端 picker 请求也没有 AbortController；koffi 缺失、COM 初始化失败、worker 启动失败、非交互桌面或对话框卡住时，用户可能只看到 500/toast，无法添加工作区。
- 这是当前最高优先级的 Windows 可用性缺陷。

### W2（高）原生选择器返回 `C:\...` 后，工作区名解析错误

- `src/web/App.tsx:1069,1621` 使用 `path.replace(/\/+$/u, '').split('/').pop()`。
- `path.win32` 实验：`C:\Users\alice\project` 得到整条 `C:\Users\alice\project`，而不是 `project`。
- 短路径会显示成重复的整条路径；名称超过 120 字符时服务端以「工作区名称长度」拒绝（`src/server/app.ts:120`、`src/server/workspace-files.ts:105`），直接导致添加失败。
- 修复方向：用服务端 `basename` 或 `path.win32.basename` 统一取名，并校验尾部斜杠、UNC 和长路径。

### W3（高）bash 依赖 Git for Windows，且无 PowerShell 兜底

- 项目只安装 `CodingTools`（`src/server/runtime.ts:505`，含 read/write/edit/bash），未注册 Pi 的 `createPowerShellTool()`。
- Pi 在 Windows 上优先找 Program Files 下的 Git Bash，再执行 `where bash.exe`；无 bash 返回 `shell_unavailable`。
- 没有 Git Bash 时：会话可创建、模型可回复，但 bash 及 Code mode 内 `tools.bash` 全部失败；demo、smoke、依赖 bash 的测试也失败。
- 安装时选“Git from the command line and also from 3rd-party software”通常保证 `git.exe` 在 PATH，但不一定保证 `bash.exe` 在 PATH；只把 `C:\Program Files\Git\bin` 加 PATH 更稳妥。per-user 安装的 `%LOCALAPPDATA%\Programs\Git\bin` 不在默认候选，需要额外加入 PATH。

### W4（中）内置目录浏览器拒绝 UNC/`\\?\`，且没有盘符入口

- `src/server/directory-picker.ts:121-129` 在 win32 上把 `\\server\share`、`\\?\C:\...` 也当成「无盘符根路径」拒绝。
- 起始位置只有 `homedir()`；UI 没有「此电脑」、盘符列表或 UNC 输入。
- 内置浏览器目前又因 W1 不可达；即使修通回退，这些限制仍会阻止网络共享、长路径工作区。

### W5（中）新建文件夹可用反斜杠越出所选父目录

- `src/server/directory-picker.ts:177-190` 只拒绝 `/`，没有拒绝 `\`、`..\`、盘符或 UNC。
- `path.win32.join('C:\\ws', '..\\evil')` 实测为 **`C:\evil`**，不是 `C:\ws\evil`。因此在 Windows 上可直接在父目录/更上层创建目录。
- 当前受 W1 影响 UI 不可达，但直接 API 或未来修通回退后会暴露。本地单用户、非远程提权，但仍应修复名称校验。

### W6（中）SIGTERM/关控制台不走优雅关闭

- `src/server/index.ts:157-158` 只监听 SIGINT/SIGTERM。Windows 不投递 SIGTERM；关闭控制台、任务管理器结束或 `taskkill` 不会运行 `app.shutdown()`/`runtime.close()`。
- 后果：SQLite WAL 下次启动可恢复，但 MCP/bash 子进程可能残留；automation 的 running 记录要等下次启动修复。
- `scripts/smoke-check.ts` 用 SIGTERM 验证优雅关闭；在 Windows 上该断言会假绿。Ctrl+C 是当前唯一可靠的手动优雅关闭方式。

### W7（低）Windows 隐藏属性不被识别

- `src/server/directory-picker.ts:169` 仅用 `startsWith('.')` 判断隐藏；`DirectoryBrowser.tsx` 默认隐藏这些项。
- Windows 的隐藏属性目录（AppData、`$Recycle.Bin` 等）不会隐藏；点号目录反而被隐藏。这是语义差异，不阻断核心功能。

### W8（中低）附件名与 Windows 文件系统语义不一致

- API `src/server/app.ts:55` 允许名称最长 255，但 `src/server/workspace-files.ts:33-39` 的 `safeFileName` 超过 200 直接拒绝；201–255 大小的合法文件名会到发送后才 400。
- `safeFileName` 只过滤控制字符；没有拒绝 `<>:"|?*`、尾部点、尾随空格或 Windows 保留设备名。`:stream` 可能被 NTFS 解释为备用数据流，尾部点/空格可能被系统改写，导致记录路径与实际文件不一致。
- 附件直接写最终路径（`workspace-files.ts:202-213`），不是临时文件 + rename；崩溃留下半文件后，同 requestId 重试可能返回 CONFLICT。
- 注意：`trim()` 会去掉两端空格；存储名前缀（`<hash>-<index>-...`）也让独立 `CON` 文件名不再直接命中保留设备名。仍需处理真正影响路径一致性的字符和长度上限。

### W9（低，待实机）打开配置文件存在 cmd 元字符风险

- `src/server/runtime.ts:244-249` 使用 `execFile('cmd', ['/c', 'start', '', path])`。路径含 `%` 时 cmd 可能展开环境变量；无空格且含 `&` 时可能被当作命令分隔符；`^`、`"` 也需实测。
- 仅影响「打开配置文件」按钮；错误会以 toast 显示。

### W10（中低）工具产生的绝对/临时/反斜杠路径无法在 Inspector 打开

- Code mode 的 `details.fullOutputPath` 来自 OS 临时目录；Windows 下通常是 `C:\Users\...\AppData\Local\Temp\...`。
- 工具卡把它直接交给工作区文件 API，而服务端 `safeRelativePath` 明确拒绝 `\`、盘符、UNC 和绝对路径，必然 400。
- 模型自然输出的 `src\foo`、`C:/foo` 也有同类问题；本地绝对图片、UNC Markdown 链接不能渲染/打开。

### W11（低）路径展示和快捷键标签不统一

- 工作区文件页显示 `C:\root/sub`（`src/web/WorkspaceBrowserPage.tsx:50`），UI 混用分隔符。
- 工作区手动路径占位符仍是 `/Users/you/project`。
- `shortcutKeyLabels` 在 Windows 上显示 `Win`，但 Settings 的 `displayShortcut` 对 Meta 显示 `Meta`；默认 `Alt+Mod+n` 显示为 `Alt Ctrl N`，顺序不是 Windows 常见的 `Ctrl+Alt+N`；Shift 始终显示 `⇧`。

### W12（中）旧数据迁移说明不完整，不能只改 accessMode

- 从 macOS/Linux 复制 `.data` 后，旧工作区绝对路径、`settings.defaultWorkspaceId`、每个会话 metadata 的 `workspaceId`、Agent Preset 的 accessMode 都可能失效。
- 启动时 runtime 会优先沿用旧 `defaultWorkspaceId`；仅重新添加工作区不足以保证会话绑定正确。
- 必须在停服、备份后：重新添加工作区 → 修正默认工作区 → 重绑/清理旧会话 → 把 default/session/preset 的 `workspaceWrite` 改成 readOnly/fullAccess。

### W13（中低）chmod 不是 Windows ACL

- `src/server/app-state.ts:183-192`、`src/server/models.ts:300-309,368,379` 使用 `0600/0700`。Windows 下 chmod 只切换只读位，不会建立用户/组 ACL。
- API key、Provider 凭据、app-state、feedback、SQLite 会话内容和附件都依赖用户目录默认继承 ACL。若用户把数据目录放在共享盘/OneDrive/权限宽松目录，敏感内容可能被同机其他用户读取。
- 文档不能把「0600」写成 Windows 的安全保证；建议用 `icacls` 在 Windows 实机验证预期 ACL。

### W14（低）JSON 配置文件带 UTF-8 BOM 会启动失败

- `src/server/app-state.ts:218`、`src/server/models.ts:63`、`src/server/mcp-config.ts:99` 直接 `JSON.parse`；Node 不接受 BOM。Windows 编辑器可能默认写 BOM。
- 失败会表现为「无法读取有效的应用配置/模型配置」或 MCP 配置错误。CRLF 本身可正常解析。
- 首次迁移或手工编辑配置时请保存为无 BOM UTF-8。

### W15（低，待实机）启动守卫与工作区大小写

- `src/server/index.ts` 用 `resolve(process.argv[1]) === fileURLToPath(import.meta.url)` 判断是否直接启动；Windows 路径大小写/别名/短路径下可能静默不启动。
- 工作区去重和会话归属用字符串精确比较（如 `path === canonical`）；若 `realpath` 未统一大小写，`C:\Work\x` 与 `c:\work\x` 可能被视为两个工作区。
- 这两项需 Windows 实机确认；建议统一用 `realpath` + Windows 文件系统大小写不敏感比较。

## 二、跨平台但会直接卡住 Windows 使用的现有缺陷

### X1（高）快捷键编辑/恢复默认必失败

- 客户端 `src/web/SettingsDialog.tsx:182-192` 发送 10 个键；服务端 strict schema 只认 7 个（`src/server/app.ts:108`），共享类型也只有 7 个（`src/shared/types.ts:99`）。
- `PATCH /api/settings` 收到 `rename/fork/archive` 时返回 400 `invalid_body`。Windows 用户无法重绑 Ctrl+K、恢复默认或保存任何快捷键修改。

### X2（中）IME Enter/Escape 保护不完整

已确认缺少 `isComposing`/`keyCode 229` 的路径至少包括：

- 会话重命名：`src/web/App.tsx:1686-1688`
- 新建文件夹：`src/web/DirectoryBrowser.tsx:78`
- 目标编辑：`src/web/GoalBar.tsx:73-75`
- 问答自定义答案：`src/web/QuestionComposer.tsx:227-238,274-284`
- 子代理跟进输入：`src/web/SubagentPanel.tsx:334-340`
- 移动侧栏/子代理面板的 Escape 处理也需要同类保护。

对照 Composer 已使用 `isComposing`。微软拼音按 Enter 选词时可能误保存/误建目录/误提交问题；按 Escape 可能误关面板。

### X3（中）Ctrl+K 在输入框聚焦时不会进入应用搜索

- 默认搜索键是 `Mod+k`（`src/web/keyboard.ts:2`）。
- 全局处理器在所有 `input/textarea/select/contentEditable` 聚焦时直接 return（`src/web/App.tsx:1157-1159`）。
- Composer 自己的键盘处理只负责发送、换行和 alternate send，不处理搜索。
- 用户通常在 Composer 输入框内，因此 Ctrl+K 不会进入应用逻辑，而是交给浏览器地址栏/网页搜索。是否被 Chrome/Edge 抢占需 Windows 实机确认。

### X4（中）AVIF 前端接受、服务端拒绝

- 前端图片 MIME 白名单含 `image/avif`（`src/web/App.tsx:57-60`）；服务端 `src/server/app.ts:17,54` 的 `IMAGE_TYPES` 只有 png/jpeg/webp/gif。
- AVIF 附件看似可添加，发送时必然 400。`docs/parity.md` 的 AVIF「已修」只覆盖了前端识别，不是端到端修复。
- Windows 10/11 的 Edge/Chromium 对 AVIF 支持较好，这个差异更容易暴露。

### X5（中）文件拖放可能双触发

- `Composer.tsx` 的 document 级 `drop` 监听会调用 `onAddImages`（约 `:117-127`）。
- Composer 卡片自身也有 `onDrop` 并再次调用 `onAddImages`（约 `:310`），没有 `stopPropagation()`，document 监听也没有检查 `defaultPrevented`。
- 从 Windows 资源管理器拖入卡片时可能重复添加，批量文件还可能触发「超过 4 张/8 个」的假错误。

### X6（中）自动化长间隔计时器溢出（已用 Node 24 复现）

- `src/server/runtime.ts:550-559` 直接把任意 `intervalMs` 传给 `setTimeout`。Node 超过 2^31-1 ms 会 clamp 到 1 ms，并打印 `TimeoutOverflowWarning`。
- UI/schema 最长允许 365 天，因此超过约 24.85 天会在保存/启动后立即反复触发。
- 这不仅影响 Windows，也会消耗真实模型费用，应优先修复。

### X7（中）旧 workspaceWrite preset 迁移会报错

- 旧 preset 的 accessMode 可能仍是 `workspaceWrite`；Presets 面板下拉只有 readOnly/fullAccess（`src/web/PresetsPanel.tsx:156-157`）。
- runtime 保存 preset 时在非 macOS 返回 UNSUPPORTED（`src/server/runtime.ts:1722` 附近）。迁移文档必须明确逐个修正 preset，而不能只提默认/会话。

### X8（中低）测试按 POSIX 语义写死

- `tests/runtime.test.ts:451-452` 断言 `0o600/0o700`；Windows 文件/目录 mode 与 POSIX 不同，必失败。
- `tests/skills.test.ts:69` 断言路径含 `/broken-skill/SKILL.md`；Windows `join` 产生 `\`，必失败。
- `tests/skills.test.ts:130,132` 的 symlink 在普通 Windows 用户下可能 EPERM。
- `tests/git-branches.test.ts` 依赖系统 `git`；macOS 基线已通过，但没有 `git` 的 Windows 机器会整组失败。
- 因此 README 中「装 Git Bash 后仅 1 项失败」必须删除或改写。

## 三、测试、验收与工程缺口

- **T1（已通过，macOS 基线）**：2026-10-20 复核 `npm run typecheck`、20 文件 / 241 项 vitest 与 `npm run build` 全部通过。该结果不是 Windows 实机结论。
- **T2（高）`npm test` 在 Windows 上不能全绿**：至少两项确定性失败（POSIX mode、Skills 路径分隔符），symlink 和 Git 相关测试还可能失败。需平台化断言/跳过或使用 Windows 专用 fixture。
- **T3（高）live 工具验收不可用**：`scripts/live-tools-check.ts` 和 `scripts/live-codemode-check.ts` 写死 `workspaceWrite`，Windows 首步 UNSUPPORTED。应改用 `fullAccess` 或按平台选择，并增加 Windows 实机记录。
- **T4（中）smoke 与 render-fixture 的前置不同**：`test:smoke` 的硬前置是先 `npm run build`；demo 会话会尝试 bash，但脚本不硬断言 bash 成功，Windows 上真正不成立的是 SIGTERM 优雅关闭断言。`scripts/render-fixture.ts` 才因 `cat`/`base64 -d` 和图片读取在无 Git Bash 时失败，且它不是 npm script，需用 `npx tsx scripts/render-fixture.ts`。
- **T5（中）test:live:skills 未实机验证**：脚本使用 fullAccess 和真实 DeepSeek 模型；macOS 上已有 `artifacts/live-skills-check.json` 证据（若凭据可用），Windows 仍需单独跑。
- **T6（中）无 CI/Windows 门禁**：仓库没有 `.github`；原生 picker、Git 分支、Skills、WAL、PowerShell cmd 元字符、IME 和 Windows ACL 都没有自动覆盖。
- **T7（中）Win32 picker 测试覆盖不足**：`tests/win32-dialog-logic.test.ts` 只测纯 COM 时序；driver/abort、koffi/COM bindings、worker IPC 和真实 IFileOpenDialog 无 Windows 测试。该 worker 注释引用的 `built-worker.e2e.ts` 在仓库不存在。
- **T8（低）当前文档数字容易过期**：本报告同时记录文件名和本次门禁数字；后续提交前重新跑 `npm run check` 并更新本节。

## 四、Windows 从零跑通前提

1. Windows 10/11 x64 或 arm64；项目、数据目录和 Git 仓库放本地 NTFS；尽量避免 OneDrive、网络盘和杀毒软件实时扫描目录。
2. Node.js ≥ 22.19（推荐 24；`node:sqlite` 在该版本范围可用）。
3. `npm ci` 用默认参数，**不要 `--omit=optional`**。koffi、esbuild、Rollup 都依赖 win32 optional 预编译包；省略可能导致原生选择器回退到 CMake/MSVC 源码编译，或让 `npm run build` 直接缺少 Rollup 原生模块。正常默认安装不需要 Visual Studio/CMake/Python；若 Rollup 报 DLL 加载失败，再安装 Microsoft Visual C++ Redistributable。
4. 使用 Node 官方安装包自带的 npm（Rollup 要求 npm ≥ 8；lockfile 为 v3）。
5. 安装 **Git for Windows**：
   - 给 bash 工具用：确保 `bash.exe` 存在，优先 `C:\Program Files\Git\bin\bash.exe`/`C:\Program Files (x86)\Git\bin\bash.exe`，或把 `...\Git\bin` 加入 PATH。
   - 给 Git 分支功能用：确保 `git.exe` 在服务进程 PATH 上。仅能在 Git Bash 内运行不等于 Web 服务能 spawn 到 git。
6. 以交互式桌面用户会话运行（koffi/COM picker 和打开配置文件需要窗口站）。
7. 使用当前稳定版 Edge 或 Chrome；项目依赖较新的 CSS 特性，未承诺 IE/旧 Edge。
8. 真实模型：准备 `%USERPROFILE%\.pi\agent\{settings.json,models.json,auth.json}`，或使用 `PI_WEB_DEMO=1`。配置建议保存为无 BOM UTF-8。
9. 启动（cmd）：

   ```bat
   set PI_WEB_DEMO=1
   set PI_WEB_PORT=4318
   set PI_WEB_DATA_DIR=.data\demo
   npm run dev
   ```

   PowerShell：

   ```powershell
   $env:PI_WEB_DEMO = '1'
   $env:PI_WEB_PORT = '4318'
   $env:PI_WEB_DATA_DIR = '.data\demo'
   npm run dev
   ```

   Git Bash 可用 POSIX 写法；生产模式先 `npm run build`，再 `npm start`。
10. 访问模式只能用 `fullAccess`（默认）/`readOnly`；`workspaceWrite` 不可用。
11. 从 macOS/Linux 迁移 `.data` 前：停止旧服务、备份 `.data`；复制后重新添加工作区，修正默认工作区、旧会话 workspaceId、preset 和所有 accessMode，再启动 Windows 服务。
12. 预期门禁：macOS 基线当前为 typecheck/build 通过、241/241 测试通过；Windows 的 `npm test` 仍需按 T2 平台化后才可能全绿；`test:live:tools`/`test:live:codemode` 不可用，`test:live:skills` 与 `test:live:workflow` 需真实模型、Git Bash 与实机记录。

## 五、建议修复优先级

### P0（Windows 可用性）

1. 原生选择器失败时返回稳定的错误码，前端按错误码打开内置目录浏览器；同时打通手动输入工作区路径的入口，并给 Win32 picker 加总超时/取消。
2. 工作区取名改用路径 basename（服务端或 `path.win32`），覆盖 `C:\`、UNC、`\\?\` 和尾部斜杠。
3. 快捷键 schema/共享类型补齐 10 个键，或客户端 PATCH 前裁剪；补保存/恢复默认回归测试。
4. 明确 Windows 支持前提为 Git for Windows，并二选一/同时接入 `createPowerShellTool()` 作为无 bash 兜底。
5. 平台化 Windows 测试：mode 断言按平台判断，Skills 路径断言用 `path.join`，symlink 测试在权限不足时跳过并记录；移除/改写“仅 1 项失败”的文档。
6. 补 Git 分支的 Windows 实机/Git 集成测试，并把「Git 不存在」与「目录不是仓库」拆成不同诊断。

### P1（正确性/安全/体验）

1. 修 `createDirectory` 名称校验：拒绝反斜杠、盘符、UNC、`<>:"|?*`、尾部点/空格和保留设备名。
2. 修工具绝对/临时路径打开逻辑：支持工作区外只读预览或明确提示，而不是一律 400。
3. 修自动化长间隔：将大 interval 分片/封顶/改用基于 `nextRunAt` 的周期检查。
4. 修 AVIF 服务端白名单、拖放双触发和附件名/大小上限一致性；附件改为临时文件 + 原子 rename。
5. 补 IME 保护：重命名、新建文件夹、目标、问答、子代理跟进及 Escape 路径。
6. 迁移文档补充 preset、defaultWorkspaceId、旧会话 workspaceId；帮助用户处理 `workspaceWrite`。
7. JSON 配置读取支持 UTF-8 BOM；Windows ACL 用 `icacls` 验证而不是依赖 chmod。
8. Git 分支把 Git 不存在与不是仓库分开报错；补 Git Bash 与 Git.exe 两条前提的独立诊断。

### P2（打磨/待实机）

1. Windows hidden 属性（AppData、$Recycle.Bin）与盘符入口。
2. Windows 路径展示统一分隔符；快捷键标签改为 `Ctrl+Alt+N`、`Shift`、`Win` 等 Windows 习惯。
3. Session 日志下载名处理 `CON` 等保留设备名。
4. `cmd /c start` 使用参数转义或 PowerShell/ShellExecute 兜底。
5. 处理 `process.argv[1]` 大小写/别名守卫和工作区大小写去重。
6. 补真实 Windows CI/手动门禁，至少覆盖安装、build、demo HTTP、picker、Git Bash、Skills、MCP stdio 和 Git branches。

## 六、Windows 实机冒烟清单（建议 45–90 分钟）

1. `npm ci`（默认）→ `npm run typecheck` → `npm test` → `npm run build`；记录基线失败并与 T1/T2 对照。
2. demo 模式启动，确认 127.0.0.1 可访问；再用真实模型启动并确认健康检查。
3. 新建、发送、流式、停止、排队、分叉、刷新、重启恢复；检查 SSE 断线重连。
4. `write/read/edit/bash` 四工具逐个执行；无 Git Bash 的机器单独确认错误文案；尝试 Code mode 内嵌 `tools.bash`。
5. 原生目录选择器：含中文/空格/深路径、UNC、`\\?\` 长路径、取消、ESC、关窗、DPI、多显示器、置顶、请求取消/超时；模拟 koffi/COM/worker 失败确认可回退。
6. 内置目录浏览器：盘符、UNC（当前预计失败）、隐藏属性、新建文件夹（含 `..\x`）、搜索与超长路径。
7. 工作区文件：正常相对路径、反斜杠/盘符/临时绝对路径、@ 引用、Inspector 打开、下载、附件拖拽/剪贴板/截图/中文名/非法字符名/201–255 字符名。
8. 设置：改快捷键、恢复默认、访问模式只显示 readOnly/fullAccess、打开配置文件、旧 workspaceWrite preset 迁移。
9. 模型：默认模型、Provider 新增/测试/发现/删除、凭据不泄漏、ACL（`icacls`）验证。
10. 新增能力：Skills 的列表/加载/保存/校验/重启复用/只读与 plan 限制；默认任务规划的 todo/目标路由；MCP stdio（含 `.cmd`/中文路径）与 HTTP；Git 分支列表/切换/新建/非法名/未提交覆盖/冲突/detached/worktree；自动化短间隔和 >24 天 interval；`test:live:workflow`。
11. 协作：子代理、团队面板、目标、计划、待办、问答；用微软拼音在各输入框按 Enter/Escape 选词，确认不误提交。
12. 浏览器：Edge/Chrome 各跑一遍，检查 Ctrl+K、Ctrl+B、Ctrl+Alt+N/A、AltGr/Win 键、缩放 125%/200%、高对比度。
13. 关闭：Ctrl+C、关控制台、任务管理器结束、`taskkill` 反复验证 WAL 恢复与残留 bash/MCP 子进程。
14. 长路径、OneDrive/Defender/网络盘、断网、企业代理/NODE_EXTRA_CA_CERTS 下的启动、模型与 MCP HTTP。

## 未实机验证清单（按影响排序）

1. koffi/COM `IFileOpenDialog` 全链路：vtable 偏移、`GetDisplayName`、`CoTaskMemFree`、跨进程 `EnumThreadWindows`、Alt 前台合成、DPI。
2. Win32 picker worker 的 `node --import tsx/esm` 启动、`abort`/kill 和 UI 请求取消。
3. Git Bash 探测：per-user Git、空格/中文用户名、MSYS/Cygwin/WSL、`where bash.exe` 输出编码、UNC/长路径 cwd。
4. `git.exe` PATH、Git for Windows 版本（`git switch`、`init -b`）、中文分支名和仅大小写不同的 branch ref。
5. `node:sqlite` WAL 在 NTFS/Defender/OneDrive/强杀后的恢复；SQLite 文件锁与 MCP/bash 残留进程。
6. chmod 后的实际 ACL、用户目录继承、`providers.json`/app-state/SQLite/附件敏感数据隔离。
7. 浏览器 Ctrl+K、Ctrl+B、AltGr/Win 键与 IME 组合态在 Edge/Chrome 的真实事件序列。
8. 文件剪贴板/拖拽：Explorer 文件粘贴、截图、AVIF、尾部点/空格、ADS、保留设备名。
9. 生产静态资源/Vite HMR、`process.argv[1]` 守卫、工作区大小写去重。
10. JSON BOM、CRLF、企业代理 TLS/证书、MCP HTTP fetch 代理。
11. `test:live:workflow` 的 Windows fullAccess、Git Bash 验证和 Node `--test` 行为。

> 本审计未修复任何业务代码；以上修复建议只在文档中列出。Windows 端最终验收应以实机记录、CI 和当前 `npm run check` 为准。
