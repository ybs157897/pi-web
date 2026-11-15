# pi-web pwsh 会话化改造 — Windows 实机验收报告

- 验收时间：2026-11-15，Windows 10 Pro x64（10.0.26200），Node v24.18.0，npm 11.16.0
- 代码基线：`e4f6e7b`（feat(shell): codex-style command sessions replace 15s auto-backgrounding），`src/server/tools/shell/session.ts` 存在
- 实机环境要点：**未安装 pwsh.exe（PowerShell 7）**，工具探测走 `where.exe pwsh.exe` 失败 → System32 `powershell.exe` 兜底，全程工作正常
- 模型：`commandcode / deepseek/deepseek-v4.1-flash`（OpenAI 兼容网关，`reasoning_content` thinking），隔离实例 `PI_WEB_PORT=4321`、`PI_WEB_DATA_DIR=%TEMP%\pi-web-pwsh-session`、`PI_WEB_WORKSPACE=pi-web 仓库`、未设 PI_WEB_DEMO
- 工具面（场景 G）证据取自真实请求的 catalog 记录；A–E 用直驱 harness（`.acceptance/scenarios-a-e.ts`，复用测试的 mock api 模式）；F 用 ego-browser 驱动 UI + trajectory API

## 一、场景 A–G 结果表

| 场景 | 结论 | 实测现象 |
| --- | --- | --- |
| A. yield 触发 | **通过** | 10312ms 返回；`status:"running"` + `sessionId:"sh_649b0caa"`（形如 sh_xxxxxxxx）+ `fullOutputPath`；诊断 `session_started`；输出为「[Command still running after 10s; promoted to session …]」，无旧「转入后台」文案 |
| B. 增量轮询 + 终态 | **通过** | `shell_session({yieldTimeMs:20000})` 10471ms 返回：`exited`/`exitCode:0`、增量含 `done-after-sleep`、`session_reclaimed` 诊断；同 sessionId 再轮询 → NOT_FOUND（会话已回收） |
| C. 消费游标 | **通过** | 文档原命令（1..3 × 4s）：3 个 tick 全部落在 promote 前，轮询返回空增量 + 终态，无重复；扩展命令（1..5 × 4s）：promote 含 tick-1..3 → 轮询1 只含 tick-4（running）→ 轮询2 只含 tick-5（exited/0）→ 三读后 NOT_FOUND。游标逐次消费、不重复 |
| D. stdin 写入 | **通过** | `$line=[Console]::In.ReadLine()` 在 `-NonInteractive` 下**正常阻塞等 stdin**，promote 后 `shell_session({stdin:"hello-stdin\n"})` → 终态增量含 `got:hello-stdin`。文档担心的 -NonInteractive 拦截**未发生**（-NonInteractive 只影响 host Prompt/Read-Host，不影响 .NET Console 管道读） |
| E. timeout 硬上限 | **通过（文档场景写法需修正，见 3.2）** | 文档原样（timeout:5 < 默认 yield 10s）：**不会发生 promote**，5055ms 前台直接超时返回 `exitCode:-1` + `isError:true` + `timeout` 诊断；变体（timeout:20 > yieldTimeMs:3）：promote 后 20s 进程被 taskkill，轮询得 `exited/-1/isError/timeout` 诊断，spill 文件含 `[timed out after 20s]`，随后 NOT_FOUND |
| F. 真实模型端到端 | **发现真 bug → 本机已修 → 复验通过** | 详见第二节 |
| G. 工具面检查 | **通过** | 真实请求 catalog：40 个工具中 coding-tools 恰好 5 个且顺序为 `read/write/edit/pwsh/shell_session`（无 bash）；pwsh 描述含「命令默认等待 10 秒（yieldTimeMs 可调整）…用 shell_session 读取增量输出或写入 stdin。timeout 是总时限」，无旧后台化文案；shell_session 描述完整（sessionId/纯轮询/增量/回收/fullOutputPath 兜底） |

A–E 共 24 项实质断言全部通过；harness 自身一项断言（E2.5）把 `[timed out]` 标记错放在增量里，实际该标记按设计只写 spill 文件，已对 spill 文件验证通过（详见 3.3）。

## 二、场景 F：真实模型端到端

### 第一轮（e4f6e7b 原始代码）

指令：「用一条 pwsh 命令跑 npm run check（约 30 秒以上），跑完告诉我结果」

工具调用序列原文（trajectory）：

```text
1. pwsh {"command":"npm run check","workdir":"E:\\ai\\code\\pi-web","yieldTimeMs":30000,"timeout":1200}
   → 30268ms promote：status running + sh_20305caa + fullOutputPath（模型按工具描述自主选择了 30s yield）
2. shell_session {"sessionId":"sh_20305caa","yieldTimeMs":30000}
   → 19088ms：exited，exitCode 1（npm run check 因本机 18 个 Windows 平台测试失败而真实失败，非机制问题），诊断 exit_code + session_reclaimed
3-6. pwsh ×4：按工具描述经 fullOutputPath 读 spill 文件拿完整失败明细（163222 字节/2412 行，grep FAIL 行）
7. pwsh git status --porcelain; git log --oneline -3
8-13. pwsh/read：复跑单项 vitest、读测试源码与 docs/windows-support.md 做失败归因
```

**机制面全部正确**：pwsh 到 yield 提升 → `shell_session` 轮询 → 终态 + 回收；全程无 `read` 轮询 `$env:TEMP\pi-web-shell\*.log` 的旧反模式（终态后为恢复被截断的完整输出而读一次 spill 文件，是工具描述明示的兜底路径）、无自发 Start-Sleep 轮询。

**发现的真 bug（跨平台，非 Windows 独有）**：轮询的**增量输出为空** —— 模型拿不到 `beat/tick/vitest` 增量，只能靠 fullOutputPath 自救。根因：pi-durable 契约是「模型只读 `output`（由 `api.output()` 留存），`structuredOutput` 只给 codemode 程序」（`pi-durable/dist/harness/tool.js` finalResult / structuredOutputError），而 `session.ts` 的 `execute()` 把 delta 只放进 `structuredOutput`，从不调 `api.output(delta)`；对比 pi-durable 自家 bash 工具是 `onOutput: text => api.output(text)`。直驱 harness（A–E）拿的是 structuredOutput，所以 macOS 验收没有暴露——只有真模型场景 F 能暴露。

### 修复（本机）

1. `src/server/tools/shell/session.ts`：轮询/终态的 delta 非空时 `api.output(delta)`（带 try/catch），使模型经 retained output 拿到增量；大增量沿用 50KB/2000 行 tail 截断 + spill 文件兜底，与 pwsh 前台一致。
2. 同文件：模型同样看不见 `structuredOutput.exitCode` —— 把退出码放进 reclaim 诊断：`Session sh_x is complete and reclaimed (exit code 0).`

### 复验（修复后，真模型两轮）

- 轮 1（`1..6 × 3s`，模型自选 yieldTimeMs:5000）：promote 时前台含 beat-1/2；`shell_session` 结果文本 = `beat-3..beat-6`，模型原样引用 ✓
- 轮 2（`1..4 × 3s`，默认 10s yield）：tick 全在前台，轮询增量空（游标语义正确），reclaim 诊断带 `(exit code 0)`，模型正确报告 exitCode `0` ✓

UI 截图（`.acceptance/screenshots/`）：
- `f-inprogress-1.png` / `f-inprogress-2.png`：进行中会话，可见 pwsh「终端」行与 `shell_session`「工具调用 <harness>」行（含执行失败红色标记 = 如实上报 exit 1），无读日志终端行
- `f-final-fixed.png`：修复后终态，模型回答含增量原文代码块与 exitCode=0

## 三、与 macOS 行为不一致 / 文档偏差（单独列出）

1. **无行为级差异**：A–E 全部语义（promote、游标、stdin、timeout、回收、spill）在 Windows 实机与 macOS 语义一致；`-NonInteractive` 对 `[Console]::In.ReadLine()` 无拦截（文档预设的风险未发生）。
2. **文档场景 E 写法与实现不符**：`timeout:5` + 默认 `yieldTimeMs:10000` 时 runner 因 `timeoutMs > yieldTimeMs` 不设 yield 定时器 → 根本不会 promote，而是 5s 前台超时（行为本身正确且对模型更省一轮）。文档「promote 后等 6 秒再轮询」按此参数不可能发生。建议：文档改为 `Start-Sleep -Seconds 120 + timeout: 20 + yieldTimeMs: 3000`，或明确「timeout < yield 时直接前台超时」。
3. **会话终止标记只进 spill 文件**（跨平台一致设计，非 Windows 差异）：`[exited with code N]` / `[timed out after Ns]` 写 spill 不进会话 buffer，轮询增量不含终止标记；修复后模型经诊断与 output 已有等价信息。
4. **Windows 特有环境项**：无 pwsh.exe 时 System32 `powershell.exe` 兜底正常；timeout 杀进程用 `taskkill /F /T`，验证后无残留 powershell 进程。

## 四、门禁基线与本机修复

### `npm run check`（e4f6e7b 原始代码，Windows 实机）

| 门 | 结果 |
| --- | --- |
| typecheck | 通过 |
| vitest | **17–18 failed / 1047–1048 passed / 41 skipped**（失败集与文档 T2/X8 预测同类且更大，见带回清单；无一涉及 shell/session；修复前后对比无新增失败） |
| build | 通过（26.99s，仅 chunk 体积警告） |
| doc:check | **6/6 失败**，其中全部 6 个门实为 `spawnSync('npx')` Windows ENOENT 启动失败（0.0s 即败），掩盖了真实门状态 |

### 本机已修（重跑验证通过）

| 文件 | 问题 → 修复 |
| --- | --- |
| `src/server/tools/shell/session.ts` | 轮询增量不进模型可见 output（F 的真 bug）→ `api.output(delta)`；exitCode 模型不可见 → reclaim 诊断携带退出码 |
| `scripts/doc-sync.ts` | `spawnSync('npx')` 在 Windows ENOENT → `spawnSync(process.execPath, [tsx cli, …])` |
| `scripts/verify-agent-note-format.ts` | `readdir {recursive}` 在 Windows 返回 `\` 分隔路径导致文件名校验误报 → `replaceAll('\\','/')` 归一 |
| `docs/section-catalog.md` | ~~e4f6e7b 提交自带过期生成文档~~ **此声明经 macOS 侧复核不成立，见第六节更正** → 真因是本机 autocrlf 把源 md（含 `runtime-core.md`）检出成 CRLF，我重新生成时把虚高字符数（2955→3010）烤进了 catalog。已在 4fb8387 以 `.gitattributes`（`*.md text eol=lf`）根治，本节不再保留该改动 |

修复后：typecheck ✓、shell 相关测试 ✓（shell-session 在 win32 按设计 skip）、A–E harness 复跑 ✓、全量 vitest 无新增失败、doc:check 6 红 → **5/6 通过**（唯一剩余见带回清单 1）。

## 五、带回清单（不能本机定，需维护者决策）

1. **`gen-tool-catalog --check` 在 win32 `process.exit(1)`**：注释说明产物以 posix（bash）为准，但这使 Windows 上 `npm run check` 永远红。建议与 `tests/prompt-snapshot.test.ts` 的做法一致：win32 跳过（exit 0 + 提示），或提供 win32 产物路径。
2. **Windows 平台测试失败集（17 个，需平台化断言）**：路径/盘符断言（memory ×3、skills、home、wetrack、plugin-store 的 `join` 混分隔符、skill-tools ×2 与 runtime-policy 的提示词正则写死 `/` 与未转义反斜杠、personalization 的长度断言受 CRLF/路径影响）；SQLite 文件锁 EBUSY（trajectory-capture ×3、compaction-flow 的临时库 unlink）；时序 flaky（runtime 的 wait_agent 超时断言）；automations-page 的 /boom/ 渲染断言。
3. **行尾策略**：全局 `core.autocrlf=true` 检出使 `*.md` 变 CRLF，生成器 `--check` 逐字节比对必炸。建议仓库加 `.gitattributes`（如 `*.md text eol=lf`）；本机验证时用 `git config --local core.autocrlf false` + 重检出绕过。
4. **生成文档提交纪律**：e4f6e7b 带着过期的 `docs/section-catalog.md` 入库（见上表），建议提交门禁强制 `gen:docs` 后无 diff。
5. **场景 E 文档参数**（见 3.2）。

## 附：验收产物

- harness：`.acceptance/scenarios-a-e.ts`、`.acceptance/grandchild-streaming.ts`（孙进程/cmd shim 链流式对照，均流式正常）、`.acceptance/repro-f-delta.ts`（F 空增量复现脚本，修复后增量 147140 字符）
- 截图：`.acceptance/screenshots/{f-inprogress-1,f-inprogress-2,f-final-fixed}.png`
- trajectory 快照：`%TEMP%\traj-final.ndjson`（F 第一轮）、`%TEMP%\traj-reverify.ndjson`（修复复验）、`%TEMP%\traj-final2.ndjson`（exitCode 终验）

## 六、合并后复核（4fb8387，Windows 实机，2026-11-15）

macOS 侧已核实本报告并入库 `4fb8387`（fix(shell): stream session polls through api.output, repair Windows doc gates）。Windows 侧已 pull、工作区归零（仅保留 `.acceptance/`），逐项复核结果：

### 6.1 对 macOS 侧核实的采纳情况

| 项 | 复核结论 |
| --- | --- |
| session.ts 增量/exitCode 修复 | ✅ 与本机修复语义一致（delta→`api.output` try/catch；reclaim 诊断格式 `(exit code: N)`），Windows 运行时复验通过（见 6.3） |
| `tests/shell-session.test.ts` 补 retained 断言 | ✅ 已读，防回归有效；注意该文件 `describe.runIf(!win32)`，断言在 macOS 侧生效，Windows 由本报告 6.3 的真模型路径覆盖 |
| doc-sync `createRequire(import.meta.url).resolve('tsx/cli')` | ✅ 在 Windows 实测生效：4 个可 spawn 的 doc 门全部真实执行并通过（此前 6 个 0.0s 假败） |
| verify-agent-note-format 反斜杠归一 | ✅ 通过 |
| **更正：section-catalog「入库即过期」声明** | ✅ **接受更正**。LF 归一后本机 `--check` 显示 runtime-core=2955 完全吻合 —— 我当时看到的 3010 是 autocrlf 检出的 CRLF 源文件造成的虚高，我的「重新生成」把虚高值写进了 catalog，属环境问题误判，已从本报告第四节撤回 |

### 6.2 合并后 Windows 门禁

- typecheck ✅ / build ✅（27.46s）
- vitest：17 failed / 1048 passed / 41 skipped —— 失败集与合并前**逐项一致**，无回归
- doc:check：**4/6 通过**（md-wrap / md-links / doc-budgets / agent-note）；2 个 catalog 门失败，性质不同：
  1. `gen-tool-catalog`：win32 显式 `exit(1)`（已知政策项）
  2. `gen-section-catalog`：**新发现** —— LF 归一后 runtime-core 已吻合，但 `project-instructions`（win32 生成 260 vs catalog 235）与 `work-policy`（722 vs 763）仍不匹配：`work-policy.ts:93,111` 的平台文案（「PowerShell（优先 pwsh，回退 Windows PowerShell）」等）使多个 section 字符数天然随平台浮动。该门与 gen-tool-catalog 同属「产物以 posix 为准」，但**没有声明 win32 守卫**，Windows 上会以「stale」误报。建议带回清单第 1 项扩展为两个 catalog 门统一处理（显式 win32 skip 或平台标注）

### 6.3 运行时复验（真模型 deepseek/deepseek-v4.1-flash，会话 189）

pwsh `1..6 × 3s`（模型自选 `yieldTimeMs: 2000` 的极端短 yield，额外覆盖）：2s promote（前台含 post-1）→ `shell_session` 增量一次性返回 `post-2..post-6` + 诊断 `(exit code: 0)` → 模型原样引用增量与退出码 ✓。A–E harness 复跑：26 PASS + 1 已知 harness 断言错位（E2.5，终止标记按设计只进 spill 文件，已单独验证）——与合并前一致，无回归。


### 6.4 后续处理（f5a733e 之后同日追加）

- 6.2 发现的 `gen-section-catalog` 隐性平台依赖已按**最小争议方案**处理：给该脚本补上与 `gen-tool-catalog` 同款的 win32 显式守卫（声明「win32 不可用，产物以 posix 为准」，exit 1，在启动重型 runtime 之前退出）。这只把仓库既有意图显式化并消除「stale 误报」，不改变任何门的语义；macOS 行为零变化。
- 「win32 --check 是否改为 skip（exit 0）以让 `npm run check` 在 Windows 全绿」仍是政策决策，未动；两个可选路径已记录：A. 对齐 prompt-snapshot 先例做声明式跳过（生成模式仍拒绝，防覆写正典）；B. 平台中立计数（把 `work-policy.ts:93` 平台文案换占位符后再统计，catalog 变全平台一致产物，届时可撤掉 skip）。B 做了之后 A 可撤。

### 6.5 行尾事故与纠正（同日）

`d7b5181`（gen-section-catalog 守卫首版）误把 `scripts/gen-section-catalog.ts` 以 CRLF blob 入库：本机 `core.autocrlf` 被我改为 false 后，`.gitattributes` 只覆盖 `*.md`，其余 ~400 个「i/lf w/crlf」文件失去归一化保护，编辑提交即整文件翻转。已纠正：恢复本地 `autocrlf=true`（`.gitattributes` 继续强制 md 为 LF，其余文件提交时归一化为 LF，与 macOS 作者行为一致），并以 LF 重提守卫。**带回清单补充**：建议维护者评估把 `.gitattributes` 扩到全仓文本（如 `* text=auto`）并一次性 renormalize，根治 Windows 工作区混行尾；在此之前，Windows 机器请保持 `core.autocrlf=true`（仓库级）。

### 6.6 B-section 落地：catalog 环境归一化（同日）

按「三平台均为正式运行环境」的前提实现 B：`gen-section-catalog.ts` 新增 `normalizeEnvironmentLines`，在捕获后、计数前把 section 正文中的环境相关内容归一为稳定占位符——

- `sessionFacts()` 四类环境行（平台/命令解释器、日期/时区、模型身份、工作区 scope 行）与 `工作区 <path>/AGENTS.md 适用于…` 行 → 按行前缀替换为 `<platform>`/`<date>`/`<model>`/`<workspace>` 占位符；
- 内置技能目录条目里的 checkout 绝对路径（`(file: <repo>/skills/…/SKILL.md)`）→ `<repo>`（native 与 `/` 两种分隔符形态都替换）；
- 顺带剥离 `\r`（防源文件 CRLF 渗入计数）。

验证（Windows 实机）：typecheck ✅；两次生成字节一致（确定性 ✅）；`TMPDIR=C:\t` 与深层用户 temp 两种临时目录形状下生成结果字节一致（路径无关性 ✅）；catalog 零环境泄漏（机器路径/时区/日期 grep 为 0）；与 macOS 生成值对比，**所有非环境 section 的数值逐字节一致**（runtime-core 2955 等），仅 3 个环境 section 按设计变为归一化值（project-instructions 175、work-policy 621、skills-policy 1065）。`doc:check` 在 Windows 升至 **5/6**：`gen-section-catalog --check` 首次在 Windows **真实通过**，win32 守卫已随之撤除（归一化后不再需要）；`gen-tool-catalog` 维持显式 win32 拒绝（工具面本身按平台不同，属产品语义）。

**新发现（带回清单补充）**：macOS 版 catalog/快照里的 `skills-policy: 1485` 包含 `builtin:browser-codemode` 技能条目，但 `skills/browser-codemode/` **从未提交进 git**（仅存在于 macOS 工作区，`git log --all` 无记录）。即已提交的 catalog/快照依赖 macOS 机器上未入库的本地文件——任何其他机器都无法复现该数值。需 macOS 侧拍板：提交该技能（随后 `npm run gen:docs` 重生成一次即三平台对齐）或明确口径后重生成。归一化已把路径差异消除，届时 skills-policy 将逐字节一致。

**遗留同源问题（独立批次）**：`tests/__snapshots__/prompt/*.txt` 快照为 macOS 原始口径（含环境行原文与 browser-codemode 条目），`prompt-snapshot.test.ts` 仅 skip win32、Linux 从未验证；`normalizeEnvironmentLines` 的思路可在该批次复用。
