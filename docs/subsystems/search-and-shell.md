# 检索与 Shell（search-and-shell）

> 状态：现状参考（2026-11-09 自 docs/native-search-and-shell.md 抽取，对照 src/server/tools/research.ts、src/server/tools/search/、src/server/tools/shell/ 源码复核）；实施背景与测试清单见 [native-search-and-shell.md](../native-search-and-shell.md)，决策记录见 [spec.md](../spec.md)。

## 四个检索工具

[research.ts](../../src/server/tools/research.ts) 的 `research-tools` 扩展注册四个只读工具，全部以会话绑定的工作区根（`api.env.cwd` 的 `realpath`，须为真实目录）为边界，不落 shell：

| 工具 | 语义 | 默认与上限 |
| --- | --- | --- |
| `list_files` | 列工作区相对路径（文件/目录） | `recursive` 默认 false；`maxEntries` 1–100，默认 100；扫描预算 2000 节点 |
| `search_files` | 字面量子串搜索 | 默认递归、大小写不敏感；`query` 单行 1–200 字符；`maxResults` 1–50，默认 50 |
| `glob` | 按 glob 模式匹配文件路径，mtime 新到旧返回 | 无 `/` 的模式匹配任意深度的 basename；`maxResults` 1–100，默认 100；扫描预算 5000 节点 |
| `grep` | 正则搜索，先原生 ripgrep、失败自动 JS 回退 | `pattern` 单行 ≤1024 字符；`maxResults` 1–50，默认 50；`include` 按 glob 过滤文件 |

过滤规则分两套（[research.ts:25](../../src/server/tools/research.ts#L25)）：`list_files`/`search_files`/`grep` 走 `isRestrictedName`，排除隐藏路径（`.` 开头）、`.git`/`node_modules`/`.data` 目录与敏感文件（`credentials`/`secrets`/`tokens`/`private[-_]key` 的 json/yaml/toml/txt、`id_rsa`/`id_ed25519`，及 `.pem`/`.key`/`.p12`/`.pfx`/`.keystore` 扩展名）；`glob` 走 [isGlobExcluded](../../src/server/tools/research.ts#L69)，包含隐藏路径，但排除 VCS 元数据（`.git`/`.svn`/`.hg`/`.bzr`/`.jj`/`.sl`）、`node_modules`、`dist`、`.data` 与同一套敏感文件名。

路径安全：入参须是 ≤1024 字符的工作区相对路径，拒绝 `..`、绝对路径、反斜杠、盘符与 NUL（[research.ts:49](../../src/server/tools/research.ts#L49)）；[checkedPath](../../src/server/tools/research.ts#L160) 对路径每个分量 `lstat`，任一分量是符号链接即拒绝；遍历与读取后都做 `realpath` 包含性复检，符号链接在遍历中跳过、在请求路径上拒绝。读取侧：单文件 ≤512 KiB，超出按 oversize 跳过；内容含 NUL 判为 binary；JS 回退路径另受每次调用 4 MiB 总读取预算约束；文件以 `O_NOFOLLOW` 打开并核对 dev/ino（[research.ts:293](../../src/server/tools/research.ts#L293)）。输出统一经 [format.ts](../../src/server/tools/search/format.ts) 的 `boundedSearch` 压进 48 KiB：条目从尾部丢弃、结果标 `TRUNCATED`，excerpt ≤200 字符。

## 原生 grep 与 JS 回退

`grep` 先走原生 ripgrep（[native.ts:200](../../src/server/tools/search/native.ts#L200)）。可执行文件解析顺序（[native.ts:33](../../src/server/tools/search/native.ts#L33)）：`PI_WEB_RG_PATH`（须存在）→ 可选依赖 `@vscode/ripgrep` 的内置二进制（包缺失不影响安装，离线退到下一级）→ `PATH` 上的 `rg`，解析结果缓存。原生调用（[native.ts:88](../../src/server/tools/search/native.ts#L88)）以 `--json --stats` 流式解析，`--max-columns 500`、`--max-filesize 512K`，目录排除与敏感文件名各下发生 `--glob` 否定规则；rg 默认遵守 `.gitignore` 且不搜隐藏文件。stdout 缓冲上限 8 MiB（超出即 kill、按已读内容返回并标 truncated）、stderr 64 KiB、超时 30 秒。命中数达到 `maxResults` 后继续读完以保留 stats 的检索文件数，但结果标 truncated；命中路径再过一道工作区包含性与敏感文件后过滤（[native.ts:73](../../src/server/tools/search/native.ts#L73)）。

模式串原样交给 rg。退出码 0/1 视为完成；ENOENT 归为不可用（静默回退），退出码 2、超时、spawn 失败等归为失败（回退前补一条 `native_search_fallback` info 诊断）。回退目标是 [research.ts](../../src/server/tools/research.ts) 的 JS walker：模式按 JS `RegExp` 重新编译（ripgrep 拒绝而 JS 接受的 lookahead 由此可用；`(?P<name>...)` 等 rg 专有语法只在原生路径可用），受单文件 512 KiB、总读取 4 MiB 与 2000 节点扫描预算约束。

## Shell 工具：平台二选一

[tools.ts:40](../../src/server/tools/shell/tools.ts#L40) 的 `coding-tools` 扩展在 Pi 的 `read`/`write`/`edit` 之外按平台注册恰好一个 shell 工具：Windows 只装 `pwsh`，其他平台只装 `bash`。两个工具参数一致（`command`/`description`/`workdir`/`timeout`）；`workdir` 默认会话工作区、相对路径对其解析、须真实存在且留在工作区内（[common.ts:23](../../src/server/tools/shell/common.ts#L23)）；远程或非 `node:local` 执行环境回退 Pi 平台工具的执行模型（外层 `cd`/`Set-Location` 前缀）。macOS `workspaceWrite` 的 `sandbox-exec` 档案对前台与后台命令同样生效：后台命令经 [execution-env.ts:146](../../src/server/conversation/execution-env.ts#L146) 的 `localShellSpawn` 以同一档案的分离进程运行，输出文件由父进程而非沙箱子进程写入，写沙箱不被凿穿。

## 共享 runner 契约

本地执行统一走 [runner.ts:59](../../src/server/tools/shell/runner.ts#L59) 的 `runShellCommand`。输出：stdout/stderr 流式解码（UTF-8 有效则按 UTF-8，失效后切换平台 legacy 编码）进保留尾部（50 KiB / 2000 行），同时全量追加到 OS 临时目录 `pi-web-shell/` 下的 0600 日志文件；输出被裁剪时以 `full_output` info 诊断给出完整日志路径，未被裁剪则删除日志。后台化：前台预算 15 秒，超时（默认 300 秒，[common.ts:6](../../src/server/tools/shell/common.ts#L6)）大于 15 秒的命令到点自动转后台，立即返回 `background: true` 结构化输出与日志路径，进程树继续跑到显式超时为止，模型用 `read` 轮询该文件看进度；转后台的命令脱离会话 abort 信号并登记进后台表，`runtime.close()` 时由 `disposeBackgroundShells()` 统一击杀（[runner.ts:28](../../src/server/tools/shell/runner.ts#L28)，[runtime/index.ts:693](../../src/server/runtime/index.ts#L693)）。

退出语义对检索友好（[common.ts:98](../../src/server/tools/shell/common.ts#L98)）：`grep`/`egrep`/`fgrep`/`rg`/`findstr`/`git grep` 的退出码 1 归一为成功的「No matches found.」info 诊断，其余非零退出保留 `exit_code` error 诊断。进程树击杀按平台分派：POSIX 以分离进程组运行、`kill(-pid, SIGKILL)`；Windows 用 `taskkill /F /T`。

平台差异集中在编码与拦截。POSIX 侧（[posix.ts](../../src/server/tools/shell/posix.ts)）：shell 解析为 `/bin/bash` → `$SHELL` → `/bin/sh`；继承的 `C`/`POSIX` 或空 `LANG`/`LC_CTYPE`/`LC_ALL` 替换为 `en_US.UTF-8`（macOS）或 `C.UTF-8`（Linux），非 UTF-8 locale codeset（如 `zh_CN.GB18030`）保留为解码回退，并注入 `PYTHONIOENCODING=utf-8`/`PYTHONUTF8=1`。Windows 侧（[windows.ts](../../src/server/tools/shell/windows.ts)）：`pwsh` 解析为 `PI_WEB_PWSH_PATH` → `where.exe pwsh.exe` → 系统 Windows PowerShell；包装脚本强制 `[Console]::OutputEncoding`/`$OutputEncoding` UTF-8、`chcp.com 65001` 并传播 `LASTEXITCODE`；legacy 编码按 `PI_WEB_WINDOWS_OUTPUT_ENCODING` → `chcp` 活动代码页（`cp<N>`）→ locale 启发式（zh→gb18030、ja→cp932、ko→cp949、ru→cp866、否则 cp437）解析。

两平台都在 spawn 前拦截绕过检索工具的递归搜索并把错误指向 `grep` 工具：POSIX 拒绝 `rg`/`rgrep`、带递归标志的 `grep`/`egrep`/`fgrep`、`find -exec grep` 与 `xargs grep`（引号内的提及不拦）（[posix.ts:40](../../src/server/tools/shell/posix.ts#L40)）；Windows 拒绝 `Get-ChildItem … -Recurse` 管入 `Select-String`（[windows.ts:40](../../src/server/tools/shell/windows.ts#L40)）。两个工具的描述文本同样禁止用 shell 做工作区级搜索。

## 敏感文件规则差异

检索工具在工具层过滤敏感文件与 VCS 元数据；shell 工具不做任何此类过滤，能够读写 `.env`、凭据等检索工具跳过的文件。系统提示词为此配有对应条款（[runtime-core.md:36](../../src/server/conversation/prompts/runtime-core.md#L36)）：shell 不做这些过滤，不得用 shell 读取、复制或外发敏感文件，除非用户明确要求。

## 已知限制

- 后台命令完成只能靠 `read` 轮询日志文件，没有自动通知；终端与工作流分区未实现（shell runner 尚缺 workId/标题/开始时间与取消接口），见 [spec.md 2026-10-31 未决](../spec.md#2026-10-31)。
- 后台命令在服务器关闭时被统一终止，不跨重启存活。
- POSIX 递归搜索拦截是启发式：`sh -c` 收到引号包裹的脚本可绕过；系统提示词与 bash 工具描述承担兜底约束。
- 原生 grep 的 Rust 正则语法窄于 JS，不支持的语法自动回退 JS walker；且回退路径不读 `.gitignore`（原生路径遵守），两条路径对 gitignore 文件的覆盖不一致。
- ripgrep 依赖可选包 `@vscode/ripgrep`：离线安装缺该包时只剩 `PATH` 上的 `rg` 或 JS walker 两条路。
