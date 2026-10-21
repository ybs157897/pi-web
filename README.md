# Pi Durable Web

一个独立的 Pi Durable Web 入口。React 正文直接使用 DSH 的 Markdown、代码、终端和 Diff 展示组件，主题使用固定版本的 DSH 设计变量。执行、消息、工具和恢复由 Pi Durable 1.3.0 与 SQLite 承担。

## 启动

需要 Node.js 22.19+，推荐 Node.js 24。Windows 另有 Git for Windows 等前提，见 [Windows](#windows)。

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:4317。全局配置位于 `~/.pi-web/`：默认模型从 `settings.json` 读取，Provider 与认证直接读写 `models.json` 和 `auth.json`。设置页的修改会直接写入这些全局文件；项目本地 `.data` 不再使用，首次启动会把旧 `.data` 和 `~/.pi/agent` 一次性迁移到 `~/.pi-web`。

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
npm start
```

生产模式先构建，再运行 `npm start`。服务默认只监听本机，前端与 API 使用同一端口。

## Windows

Windows 10/11 属于「有条件支持」，**不是所有功能都已在 Windows 实机验证**。完整审计、逐项矩阵、证据与待实测清单见 [docs/windows-support.md](docs/windows-support.md)。

### 前提

- Node.js 22.19+（推荐 24），使用官方安装包自带的 npm（Rollup 要求 npm ≥ 8；本仓库为 lockfile v3）。
- **Git for Windows**，且区分两个独立要求：
  - Windows 使用原生 `pwsh` 工具（Pi `createPowerShellTool()`，依次尝试 PowerShell 7 `pwsh` 与 Windows PowerShell），不依赖 Git Bash；`bash` 工具只在 macOS/Linux 注册。
  - Git 分支功能直接执行 `git.exe`，要求 Web 服务进程的 PATH 能找到 Git；仅在 Git Bash 内可用不够。
- `npm ci` 使用默认参数，**不要加 `--omit=optional`**：除 Windows 原生目录选择器依赖 koffi 的预编译 optionalDependencies 外，Vite/Rollup 和 esbuild 也依赖平台 optional 包；省略时可能回退到需要 CMake/MSVC 的源码编译，或直接让 `npm run build` 报缺少 Rollup 原生模块。默认预编译方案不需要额外 Visual Studio/CMake；若 Rollup 报 DLL 加载失败，再安装 Microsoft Visual C++ Redistributable。
- 以交互式桌面用户会话运行（原生目录选择器/打开配置文件需要窗口站）。项目、数据和 Git 仓库放本地 NTFS，避免 OneDrive/网络盘；配置建议保存为无 BOM UTF-8。
- 建议使用当前稳定版 Edge/Chrome；界面依赖较新的 CSS 特性。真实模型读取 `%USERPROFILE%\.pi-web\{settings.json,models.json,auth.json}`，也可用 demo 模式。

### 启动（cmd / PowerShell）

cmd：

```bat
set PI_WEB_DEMO=1
set PI_WEB_PORT=4318
set PI_WEB_DATA_DIR=%TEMP%\pi-web-demo
npm run dev
```

PowerShell：

```powershell
$env:PI_WEB_DEMO = '1'
$env:PI_WEB_PORT = '4318'
$env:PI_WEB_DATA_DIR = "$env:TEMP\pi-web-demo"
npm run dev
```

Git Bash 中可直接使用上文的 POSIX 写法。生产模式同样是 `npm run build` 后 `npm start`。

### 与 macOS/Linux 的差异

- **访问模式**：`workspaceWrite`（工作区内修改）只有 macOS `sandbox-exec` 实现，Windows 上不可用；设置与输入区只提供 `readOnly` / `fullAccess`（默认），没有 OS 级写沙盒替代。
- **命令执行**：Windows 只注册 `pwsh`（Pi 的 `createPowerShellTool()`，依次尝试 PowerShell 7 `pwsh` 与 Windows PowerShell），与 DSH 的 Windows 组合一致；`bash` 不在 Windows 注册。`pwsh` 支持 `workdir`/`description`，提示词直接给出平台/shell 事实。Code mode 里的 `tools.pwsh` 可用，`tools.bash` 只在 macOS/Linux 可用。
- **Git 分支**：服务端/API/UI 已完成，但需要 PATH 上的 `git.exe`；Windows 实机与 Git 集成流程尚未验证。仅能在 Git Bash 内运行不等于 Web 服务能 spawn 到 git。
- **原生目录选择器**：Windows 使用 koffi + `IFileOpenDialog`，代码已接入但无 Windows 实机验证；选择器失败时目前不会自动回退内置目录浏览器，也没有总超时/前端取消。
- **Skills**：目录、加载、保存、校验使用跨平台路径 API，并显式拒绝反斜杠、盘符、UNC 和 Windows 保留设备名；但符号链接/ACL/原子 rename 需 Windows 实机验证，测试本身也有 `/` 和 symlink 权限假设。
- **MCP / Code mode**：MCP stdio 通过 cross-spawn 支持 `.cmd`/PATHEXT，关闭时用 `taskkill /T /F`；QuickJS 使用 WASI/worker。企业代理、TLS、强杀残留和嵌套 shell 仍需实机。
- **打开配置文件**：Windows 使用 `cmd /c start`；路径含 `%`、`&`、`^` 等 cmd 元字符时可能失败。
- **关闭**：Ctrl+C 走正常关闭；关闭控制台窗口、任务管理器结束或 `taskkill` 不会执行优雅关闭——SQLite 数据可恢复，但正在运行的 MCP/shell 子进程可能残留。
- **旧数据迁移**：从 macOS/Linux 复制 `~/.pi-web` 前先停旧服务并备份。迁移后需重新添加工作区，修正默认工作区（`defaultWorkspaceId`）、旧会话 `workspaceId`、Agent Preset，并把默认/会话/preset 的 `accessMode` 从 `workspaceWrite` 改为 `readOnly` 或 `fullAccess`；只改默认会话设置不够。旧版项目内 `.data` 会在首次启动时自动导入一次到 `%USERPROFILE%\.pi-web`。

### 已知问题与限制

以下是审计确认、与 Windows 使用直接相关的现有问题（详细证据与修复建议见 [docs/windows-support.md](docs/windows-support.md)）：

- 原生选择器返回 `C:\...` 后，界面用 `/` 取名：工作区名会变成整条路径，路径超过 120 字符时添加工作区失败。
- 原生选择器失败时只显示「Internal server error」，不会回退内置目录浏览器；手输工作区路径的对话框实际不可达。
- 内置目录浏览器拒绝网络共享/UNC/`\\?\` 路径、没有盘符入口，且只按 `.` 前缀判断隐藏文件（Windows 隐藏属性不生效）。
- 内置浏览器的「新建文件夹」只过滤 `/`，输入 `..\x` 之类反斜杠路径可越出当前目录。
- Composer 输入框聚焦时 Ctrl+K 不会进入应用搜索；快捷键标签在 Windows 上格式不统一。
- 工具产出的绝对路径（盘符路径如 `D:\2026\dolynk\docs\a.md`、POSIX 绝对路径）落在工作区内时，服务端会归一化成工作区相对路径再打开；工作区外的路径仍以「工作区路径无效」拒绝。AVIF 前端可添加但服务端会拒绝。
- 文件拖放到 Composer 卡片可能被 document 级监听重复处理；微软拼音在重命名/目标/问答/子代理跟进等输入框按 Enter 可能误提交。
- chmod `0600/0700` 在 Windows 不建立 ACL；凭据、app-state、SQLite 会话和附件依赖用户目录继承权限。

### 自动化与模型设置

- 长间隔自动化会按绝对到期时间分段等待；删除仍被自动化引用的工作区或 preset 会返回 `CONFLICT`，需先修改或删除自动化任务。
- Provider 有未保存的连接配置更改时，测试连接和获取模型会禁用并提示先保存；保存后使用已保存配置进行验证。

### Windows 上的验证

- macOS 已通过 `npm run check` 与 HTTP smoke；该结果**不是 Windows 实机结论**，Windows 仍须按实机清单复测。
- Windows 的 `npm test` **不是只有 1 项失败**：`tests/runtime.test.ts` 的 POSIX mode 断言和 `tests/skills.test.ts` 的 `/` 路径断言会失败；skills 的 symlink 测试还取决于 Developer Mode/权限，Git 相关测试依赖系统 Git。
- `test:live:tools` 与 `test:live:codemode` 写死 `workspaceWrite`，Windows 上不可用；真实工具的 Windows 验证请改用 `fullAccess` 手动执行，或先平台化脚本。
- `test:live:skills` 使用 `fullAccess`，理论上可运行，但仍要求真实 DeepSeek 模型、凭据、网络和 Windows 实机记录。`test:live:workflow` 会在 Windows 动态改用 `fullAccess`，但需要 Git Bash、Node `--test` 和真实 DeepSeek，同样未实机验证。
- `test:smoke` 的硬前置是先 `npm run build`；其 demo 会话会调用平台 shell（Windows 为 `pwsh`），但脚本不把 shell 成功作为硬断言，Windows 上的 SIGTERM 优雅关闭断言则不成立。`scripts/render-fixture.ts` 由 `npx tsx scripts/render-fixture.ts` 手动运行；demo 在 Windows 用 PowerShell 的 `[Convert]::FromBase64String` 生成图片，不依赖 Git Bash。
- 最小 Windows 冒烟顺序见 [docs/windows-support.md](docs/windows-support.md)。

## 全局目录与独立数据

默认全局目录是 `~/.pi-web`（Windows 为 `%USERPROFILE%\.pi-web`）。它同时保存模型配置、应用状态和会话数据库：

| 文件 | 用途 |
| --- | --- |
| `settings.json` | 默认 Provider/模型、思考等级等 Pi 全局设置 |
| `models.json` | Provider 与模型目录；设置页保存时直接修改此文件 |
| `auth.json` | Provider 凭据；设置页填写 API key 时直接修改此文件 |
| `mcp.json` | MCP 服务器配置（只读导入，修改后重启生效） |
| `app-state.json` | 界面偏好、工作区、Preset、自动化任务 |
| `pi-durable.sqlite` | Pi Durable 的会话、消息和工具执行记录 |

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PI_WEB_PORT` | `4317` | HTTP 端口 |
| `PI_WEB_HOME` | `~/.pi-web` | 全局配置与会话数据的根目录 |
| `PI_WEB_DATA_DIR` | `PI_WEB_HOME` | 覆盖数据目录；设置后不再自动迁移旧项目 `.data`，模型配置也从该目录读取 |
| `PI_WEB_WORKSPACE` | `workspace` | Agent 文件与命令工作的目录 |
| `PI_WEB_MCP_CONFIG` | 未设置 | 覆盖导入的 MCP 配置文件；未设置时读 `PI_WEB_HOME/mcp.json`（demo 模式读 `<数据目录>/mcp.json`） |
| `PI_WEB_DEMO` | 未设置 | 设为 `1` 使用明确标识的脚本化验收模型，不调用真实模型 |

首次以默认目录启动时，会把 `~/.pi/agent/{settings,models,auth,mcp}.json` 和旧项目 `.data/{providers,app-state}.json`、SQLite 一次性导入 `~/.pi-web`，并写入 `.migrated` 标记。旧目录不会被删除；确认迁移结果后可自行备份并删除项目 `.data`。需要重新导入时删除 `~/.pi-web/.migrated` 后再启动。

Windows 上这些变量用 `set NAME=value`（cmd）或 `$env:NAME='value'`（PowerShell）设置；Git Bash 可直接使用 POSIX 写法。

真实服务不会因认证失败自动切换到演示模型。模型凭据只在服务端使用，接口不返回密钥值。

## 对话

会话支持标题、置顶和归档。模型和思考等级按会话选择；运行时发送可选择排队或插入。Pi 的插入消息会在当前工具轮结束后参与正在进行的任务。

停止使用 Pi 原生中止语义：停止当前普通工作并保留排队输入，发送下一条消息后继续处理。队列的移除按钮只撤回尚未被接纳的输入；已开始执行时返回明确错误。历史编辑可通过分叉继续，不覆盖已有 Entry。

刷新和断线恢复会读取完整会话快照。浏览器草稿、当前会话和显示主题与服务端的持久会话分开保存。

同一个回合里的多次 `subagent` 调用在转录里收成一行彩色胶囊：每个子会话一个固定颜色，刚创建时显示转圈与「创建中」，运行中显示「已结束/总数」，完成后显示 tokens，失败标红；点任意胶囊打开该子会话的「对话」界面（执行过程就在里面），父会话标题在会话头面包屑里可以返回。代码模式脚本里通过 `tools.subagent` 发起的嵌套调用也会提成同一行，脚本卡不再重复列这些调用。会话头右上角的「{n} 个子智能体」面板保持不变，仍可停止、跟进和查看最近回答。demo 模式用 `[subagents]` 可以复现三个并行子智能体。注意：`spawn_teammate` 创建的团队成员属于「智能体团队」面板，不在 `subagent` 条带里。

## 默认任务规划与进度

应用现在默认加载项目内的 [运行时核心提示词](src/server/prompts/runtime-core.md)，无需复制到 Agent Preset。普通多步任务会在开始前拆出具体步骤和验证，再用 `todo_write` 更新进行中与完成状态；用户只要计划/方案时，步骤是“调研→形成计划→等待确认”，不擅自实施。单步小任务跳过正式清单。阶段完成、遇到阻塞或调整计划时，模型应简短汇报已完成、当前和下一步。

模型会先判断用户话语的请求类型：问句、评估、排查原因默认只读诊断；明确要求修改、修复、实现才实施；要计划/方案则只读研究后给计划。“这个/它/刚才那个”绑定当前对话中最近明确提到的对象，有多个候选时列出并问；“今天/昨天/前两天/上周”按当前日期和时区解释。用户说“可以/行/好的”只确认被问到的具体事项，不会自动扩大到提交、推送、发布或删除。

长期目标可从用户的直接请求中识别并调用 `create_goal`，无需用户额外输入“goal”；本项目只允许顶层会话创建目标。Goal 保留有限轮次续跑、完成证据和具体阻塞原因的要求。只读模式允许管理目标这类会话元数据，不开放文件写入；自定义 Preset 仍需显式开放对应工具。

Plan 模式只做只读研究和计划审阅。命令式语言要求实施时，只表示把实施写进计划；对话中的同意或对某个问题的确认不结束 Plan，必须通过 `exit_plan_mode` 提交并获用户批准。宿主同时收窄模型工具列表、代码模式目录，并在每次实际执行（含恢复重放）时拒绝文件写入、通用 shell、外部 MCP、执行待办与目标写入。`glob` 按路径模式找文件（包含隐藏路径，按修改时间排序），`grep` 按正则搜索内容并可用 `include` 过滤；`list_files` 和 `search_files` 保留为有界目录与字面文本搜索。它们都不经过 shell。Plan、Goal、Team 指导按实际直接或嵌套路由生成；没有计划提交工具时，模型用最终文本给出计划，不假称已提交。

进入 Plan 会同时约束已有的任务子会话，新建和恢复复用的子会话也继承限制；已经开始执行的外部操作不会因此撤销。离开父会话 Plan 不会自动放宽已有子会话自己的 Plan 状态，需要在对应子会话的控件中离开。缺少目标完成工具的 Preset 不会继续空转目标；模型的 `update_goal` 只接受完成或受阻，编辑、暂停、恢复仍由用户控件处理。

每次请求自动加载绑定工作区根目录的 `AGENTS.md`，附来源、作用域与内容哈希，最多 32 KiB；缺失、过大、符号链接或读取异常会明确记录，不静默截取规则。不会加载工作区上级指令，也不会递归扫描全仓库。模型处理子目录文件时，只在该目录及其父目录按需读取实际存在的 `AGENTS.md`，不要求递归发现全仓库规则。项目规则和 Preset 不能扩大用户授权或宿主权限。

核心规则由不带工具的 `runtime-policy` 扩展提供，执行守卫由强制装配的 `execution-policy` 扩展提供，保留 Preset 自定义 instructions 和工具白名单。启动时为历史会话补齐扩展，分叉和子会话也会获得它们；核心文本在下一次请求准备时生效，执行权限在调用时重新检查。编辑运行时核心或代码后需重启服务，已有会话无需重建；工作区根 `AGENTS.md` 则每请求重读。

`tests/runtime-policy.test.ts` 检查实际到达 Pi 模型适配器的请求，并主动尝试 Plan 下的直接写入、嵌套命令与子会话写入。`npm run test:live:workflow` 默认保留代码模式开启，用真实 DeepSeek 完成只读调查、项目指令遵循、多步开发和简单问答，再由宿主运行独立 oracle，并验证生成的测试能检出数量计算、零数量和缺少输入校验这三类缺陷。可用 `PI_WEB_WORKFLOW_MODE=only` 验证仅脚本模式，`off` 验证直接工具模式；报告按模式保存。脚本化测试通过不等于真实模型行为通过。

## 代码模式与 MCP

Pi Durable 1.3.0 的 code mode 与 MCP 客户端已在本项目中开启：

- **代码模式**：设置 → 通用 → 代码模式，三态可选，默认「开启」。
  - 开启：模型多一个 `codemode` 工具，用 QuickJS 沙箱执行它写的 JavaScript；脚本里的工具调用是 Pi 的嵌套工具调用，运行中显示为子行，结束后从结果的 `details.calls` 展示。
  - 仅脚本：模型只看到 `codemode`，其余工具（读写、平台 shell、待办、团队等）都从脚本里调用，对应 Pi 的 `codemode.mode: only`。
  - 关闭：不提供代码工具，与旧行为一致。
  - 切换立即应用到空闲会话；正在运行的会话会跳过本次重配置，在下次切换或重启服务时应用。
  - 直接工具已有 schema 时，代码模式只引用其名称与发现入口，避免重复展开；仅嵌套工具的内联说明预算为 1,200 个 SDK 估算 token，未列出的完整声明可用 `searchTools()` / `describeTool()` 查到。该预算不限制实际可调用工具。
- **MCP**：只读导入全局 `~/.pi-web/mcp.json`（demo 模式读 `<数据目录>/mcp.json`，可用 `PI_WEB_MCP_CONFIG` 覆盖），支持 stdio 与 Streamable HTTP。
  - 工具名 `mcp__<server>__<tool>`；`exposure` 支持 `codemode`（默认，脚本可调）、`deferred`（`tool_search` 加载给模型）、`direct`（直接给模型）与 `hidden`，`toolExposure` 支持精确名与 `*` 模式。
  - 设置 → MCP 显示每个服务器的连接状态、工具清单和错误，不会返回 `env`/`headers`。修改 `mcp.json` 后重启服务生效；OAuth 流程暂未接入，需要令牌的服务器请用 `headers` 或本地 stdio。

## Skills 与内置创建器

设置 → 技能可以选择工作区、刷新目录、查看正文和资源，以及校验格式与本地引用。随项目提供的 `builtin:skill-creator` 适配了 ZCode 的技能创作流程，来源说明见 [skills/skill-creator/ORIGIN.md](skills/skill-creator/ORIGIN.md)。

在普通会话中输入“帮我创建一个用于……的技能”，Agent 可通过 `skill_list`、`skill_load`、`skill_save`、`skill_validate` 完成创建与检查。创建器正文按需加载，不常驻整段系统提示词。

- 新技能保存到当前工作区 `.agents/skills/<name>/SKILL.md`；也发现 `.pi-web/skills/` 中的已有技能。首版不扫描或改写用户全局技能目录。
- 来源 ID 为 `builtin:<name>`、`agents:<name>`、`pi:<name>`；同名项保留独立来源，裸名称歧义时要求使用完整 ID。
- `skill_save` 只原子保存 `SKILL.md`；更新需要加载时的 `version` 作为 `expectedVersion`。相同内容重试视为已保存，不重复覆盖；版本冲突不覆盖。可选 scripts/references/assets 使用已有文件工具管理；校验不会执行脚本。
- 每次模型请求重新读取精简目录，新保存的技能在下一次请求可见；重启从文件恢复。`SKILL.md` 单次读取上限 512 KiB、普通技能资源上限 2 MiB；拒绝路径越界与符号链接。
- 无 Preset 的会话默认包含 `skills` 扩展；自定义 Preset 需显式加入扩展 `skills` 和需要的上述工具。只读会话保留列举、读取和校验，禁止保存；计划模式也禁止 `skill_save`。Code mode 嵌套调用遵守相同检查。

可在演示模式发送 `[skills-create]` 验证实际文件/工具链，再用 `[skills-use]` 读取产物；它们是脚本化验收，不是真实模型证明。`npm run test:live:skills` 使用当前配置的 DeepSeek 模型，在临时工作区验证内置创建器加载、保存/校验、重启后新只读会话发现并使用技能，结果保存在 `artifacts/live-skills-check.json`。

## 验证

自动化测试使用真实 Pi Durable/SQLite 与可控模型，验证持久化、幂等发送、队列、流式视图和恢复；HTTP 测试验证请求校验与订阅清理。可控模型验证不等于真实供应商调用通过。代码模式用真实 QuickJS 沙箱执行脚本并调用真实平台 shell；MCP 用内存传输与真实 stdio 子进程夹具覆盖连接、工具注册与失败隔离。

```sh
PI_WEB_DEMO=1 PI_WEB_PORT=4318 PI_WEB_DATA_DIR="${TMPDIR:-/tmp}/pi-web-demo" npm run dev
npm run test:live
npm run test:live:tools
npm run test:live:codemode
npm run test:live:skills
npm run test:live:workflow
npx tsx scripts/render-fixture.ts
```

`test:live` 使用临时数据库、当前配置的默认真实模型和一个最小文本请求；`test:live:tools` 与 `test:live:codemode` 分别验证真实模型的直接工具调用和 `codemode` 脚本调用；`test:live:skills` 验证 Skills 的创建、校验、重启后发现与使用；`test:live:workflow` 验证默认任务规划与多步开发闭环，并由宿主独立运行产物测试。它们都不会修改已有会话或静默更换模型。最后的 `render-fixture.ts` 不是 npm script，会写入 `artifacts/render-fixture-*`，用于确定性 Markdown/工具渲染 fixture，Windows 上使用 `pwsh`。供应商授权失败单独报告（本轮 opencode-go key 过期时的 401 已按该规则保留）。

Windows 上跑验证前先看 [Windows](#windows)：shell 相关验证走 `pwsh`；`npm test` 仍有 POSIX mode、Skills 路径分隔符及可能的 symlink 条件性失败；`test:live:tools` 与 `test:live:codemode` 依赖 Windows 不支持的 `workspaceWrite`；`test:live:skills` 与 `test:live:workflow` 需真实模型与 Windows 实机记录。

## UI 来源

- DSH 展示组件：`@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2`。
- 主题来源：DSH `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 许可和来源见 [vendor/README.md](vendor/README.md)。
- 数据与组件衔接见 [docs/architecture.md](docs/architecture.md)。
