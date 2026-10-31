---
name: rd-cli-ops
description: >
  WeTrack 缺陷单业务操作与代码分析。用户要求分析、排查、定位 bug 单、缺陷单、
  问题单，或提供 DTS 编号并要求结合代码找原因时，必须加载；也适用于 WeTrack
  待办、详情、查询、保存、提交、附件和 rd-cli 操作。仅查询详情时不必改代码；
  只有用户明确要求修复、提交缺陷单时才进入修改和提交流程，普通分析保持只读。
  优先使用宿主提供的只读缺陷查询和分析保存工具，避免重复执行 rd-cli；
  无宿主工具时按本 Skill 的 CLI 流程获取信息。
---

# rd-cli 业务操作

通过 rd-cli 调用 mate-proxy 下发的业务命令，主要覆盖 WeTrack 缺陷管理全流程。

## 前置条件

- Python 3.8+ 已安装（否则走 `python-setup`；脚本纯标准库，无需 pip 装包）
- rd-cli 已安装（否则走 `rd-cli-setup`）
- 已认证登录（否则走 `rd-cli-auth`）

## 全局选项

| 选项 | 效果 |
|------|------|
| `--json` | JSON 格式输出，供 AI Agent 解析 |
| `--dry-run` | 预演模式，拦截 write 操作不实际变更数据 |

## 禁止事项

- 缺陷排查与代码分析所需信息仅通过 rd-cli 与当前工作空间代码获取；确需日志时，由用户自行提供或明确授权后再执行。

## 优先使用包装脚本

`scripts/wetrack.py`（Python 单文件脚本，纯标准库、无第三方依赖，位于本技能目录的 `scripts/` 下）封装了 WeTrack 最常用流程，
内置环境检查、元数据缓存、枚举校验、approver 推断、dry-run 前置和提交后验证。

**调用形式（PowerShell，必须显式用 python 调用）：**

```powershell
python "<baseDirectory>\scripts\wetrack.py" <子命令>
```

其中 `<baseDirectory>` 是 `skill_load` 返回的本技能目录绝对路径，实际调用时替换为真实值。

- `python` 不可用时改用 `py`（Python Launcher，参数相同）；两者都没有则需先装 Python（见 agent 主文档「工具可用性兜底」Level 1）
- 下文示例中的 **`wetrack.py <子命令>`** 一律指代上面这条完整命令

```powershell
wetrack.py pending                         # 待办列表（同时写 _list\list.json）
wetrack.py detail <DTS编号>                # 详情
wetrack.py flow-options <DTS编号>          # 当前环节可执行流转（权威）
wetrack.py query --project <项目> [--owner <工号>] [--status <状态码>]   # 组合查询（同时写 _list\list.json）
wetrack.py meta <项目编号> [--refresh]     # 元数据枚举（带缓存）
wetrack.py save <DTS编号> --modify-content "..." ...
wetrack.py submit <DTS编号> <nextStep> --yes <参数...>
```

**PowerShell 调用语法**：路径用 `$env:USERPROFILE` 展开。Git Bash 的 `"$HOME/..."` 写法在 PowerShell 下会解析失败，禁止使用。命令实际在 PowerShell 中执行（CodeBuddy 的 execute_command）。

**写操作标准流程**：`save`/`submit` 先加 `--dry-run`（只做校验与预演，不执行写操作），确认无误后去掉 `--dry-run` 加 `--yes` 实际执行。

工具约束：`submit` 提交类流转前会自动查 `defect-flow-options` 校验 nextStep、
自动推断 approver（缺陷创建者）、自动比对 metadata 枚举；不通过会拦截并列出可选项。
脚本仅支持 step=105/106 的提交类流转；其余环节用下方原生 `defect-flow` 命令。

**输出与临时目录（重要）**：

- 临时根目录 `%TEMP%\wetrack\`，**按问题单号分目录**：`%TEMP%\wetrack\<单号>\` 下放该单的截图（`images\N.jpg`）、工单附件原件（`attachments\`）与 `--out` 落盘文件；`_list\` 放列表类查询的统一落盘文件；`_meta\` 放项目元数据缓存
- **列表类命令（`pending` / `query`）每跑一次，结果都会写入同一个文件 `%TEMP%\wetrack\_list\list.json`**（无需加参数，上次内容被覆盖，目录下永远只有这一个文件）：结构 `{source, generatedAt, count, items}`；**时间倒序、最新在最上**（query 按 `submitTime`；pending 无时间字段按单号倒序）；每条含 `simpleDesc`，默认不含 `description`；`--json` 输出与文件同构
- **约定：终端回显是摘要，落盘文件是完整明细**。终端表格描述会被截断（`…`），要全量数据直接读 `_list\list.json`，不依赖终端回显
- `--out`：终端只回一行「列表已写入: …」（文件内容不变）；`--out-file <路径>`：写到指定路径且**不更新** list.json；`--full`：items 保留原始完整字段（含 `description`/base64，仅建议落盘后读文件）
- `detail --json` 默认：base64 截图转存为文件、description 中替换为路径标注、附 `images` 字段；**工单附件（attachments）自动下载到 `<单号>/attachments/`，`attachmentFiles` 字段给出本地路径（下载失败则在同字段带 `error`）**；需要原始完整 JSON（含 base64/downloadUrl，不下载附件）加 `--full`。`detail` 的 `--out` 行为不变（落盘不截断）
- `detail --del-images`：输出完毕后删除本次落盘的**截图与附件**（读完即删）
- 输出较长时不要依赖 `>` 重定向（PowerShell 默认 UTF-16 会把 JSON 读坏）；`detail`/`flow-options` 等单号类命令要落盘用 `--out` / `--out-file`
- 单号处理完毕：`wetrack.py clean --defect <单号>` 删除该单整个临时目录；`wetrack.py clean --all` 全清；脚本每次运行自动清理 7 天前旧文件

## 降级：脚本或 Python 不可用时回退 rd-cli 原生模式

Python 未安装、脚本文件缺失（如 skill 未随包部署、py 被误删）时，**放弃包装脚本，直接用下方 rd-cli 原生命令**完成同等操作。降级模式下必须人工补上包装脚本内置的校验：

- nextStep 以 `defect-flow-options` 实时查询为准，不凭记忆硬编码
- approver 推断：106 提交类取缺陷创建者工号（detail 的 `creatorName` 括号内数字）；105 提交类与驳回类取当前登录人工号
- 名称类参数必须与 `project-metadata` 枚举精确匹配
- 所有写操作先 `--dry-run` 验证再实际执行

以下为 rd-cli 原生命令参考，供脚本未覆盖的场景使用。

---

## 命令发现

```bash
rd-cli help        # 所有可用业务命令（以实际输出为准）
rd-cli refresh     # 新命令未出现时强制刷新工具列表（admin reload 已废弃）
```

业务系统分组：wetrack（缺陷）、weor（需求）、vmp（版本）、wetest（测试）、weci（CI）、weapi、wetask、plm、gdp。

## WeTrack 命令清单

| 命令 | 类型 | 说明 |
|------|------|------|
| `wetrack pending` | read | 当前用户待办列表（含 defectStep 环节编码） |
| `wetrack detail --defect-number <编号>` | read | 缺陷完整详情 |
| `wetrack advanced-query` | read | 多维度组合查询（项目/责任人/状态/日期等） |
| `wetrack project-metadata --project-number <项目>` | read | 项目元数据枚举 |
| `wetrack save --defect-number <编号> --step <105/106> ...` | low-risk-write | 保存内容，不流转 |
| `wetrack submit --defect-number <编号> ...` | write | 保存并触发流转（105/106） |
| `wetrack defect-flow-options --defect-number <编号>` | read | 查询当前环节可执行的流转操作（nextStep 权威来源） |
| `wetrack defect-flow` | write | 缺陷流转（101~110 全环节，审批/驳回/强制流转） |
| `wetrack defect-submit` | write | 创建新缺陷（doApprove=false 草稿 / true 提交） |
| `wetrack template-list` / `template-detail` | read | 缺陷模版（创建缺陷用） |
| `wetrack query-values` | read | 按项目与测试领域查可选项 |
| `wetrack attachment-upload` / `image-upload` | write | 上传附件/图片（上限 15MB） |

## 关键命令详解

### 3.1 待办列表

```bash
rd-cli --json wetrack pending
```

关键字段：`defectNumber`（编号）、`defectStep`（环节编码，判断下一步的关键）、`defectStatusName`、`projectNumber`、`severityName`、`simpleDesc`。

### 3.2 缺陷详情

```bash
rd-cli --json wetrack detail --defect-number <DTS编号>
```

DTS 编号直接传入即可。返回中**没有** `defectStep` 字段——当前环节从 `pending` 列表读取或用 `defect-flow-options` 确认。可推断参数的字段：`issueVerName`（问题版本→修复版本）、`fieldName`（测试领域→一级大类）、`moduleName`（功能模块→二级模块）、`creatorName`（创建人姓名(工号)→approver）。

### 3.3 流转可选项（nextStep 权威来源）

```bash
rd-cli --json wetrack defect-flow-options --defect-number <编号>
```

返回当前环节所有可执行流转：`nextStep` 编码、`description` 中文说明、`actionType`（审批/驳回）。**提交前必查，不要依赖硬编码的 nextStep 表**。

示例输出（step=105 环节）：5001 提交转测自验、5002 提交CCB审核、5003~5006 各级驳回、5007 提交复现、5008 问题修改关闭、5009 非问题关闭。

### 3.4 项目元数据

⚠️ 输出数据量大，终端会截断，必须落盘后读取：

```bash
rd-cli --json wetrack project-metadata --project-number <项目编号> > _meta.json
```

或用包装脚本（自动缓存 1 小时）：`python "<baseDirectory>\scripts\wetrack.py" meta <项目编号>`。

枚举用途：`modifyTypes` 修复方式、`modifyVersions` 修复版本、`oneLevelCategories` 一级大类、`twoLevelModules` 二级模块、`twoLevelCauses` 问题根因、`selfTestVersions` 自验版本。名称类参数必须与枚举精确匹配。

**枚举业务规则**：一级大类 ↔ 二级模块 **联动**（模块必须属于所选大类）；问题根因 **独立**（不与其他字段联动）；名称类字段无对应值时**默认回退「其他」**（模块回退时本大类无「其他」则整体回退 其他/其他；版本类无「其他」选项，保持严格报错）。包装工具已内置该规则并在回退时打印提示。

⚠️ **结构注意**：原生返回中 `twoLevelModules` 是 **dict**（key=一级大类 id，value=该大类下模块列表），与 `oneLevelCategories`（[{id,name}] 列表）需**按 id 关联**才能取到某个大类下的合法模块。包装工具的 `meta` 已按"大类 → 模块"分组输出可直接使用；手工解析原生 JSON 时注意别把 dict 的 key 当候选值。

### 3.5 高级查询

```bash
rd-cli --json wetrack advanced-query --project-num <项目> --cur-user-name <工号> \
  --defect-status 205 --page 1 --rows 10
```

常用状态码：205=待开发解决问题、207=待开发自验、208=待测试经理组织回归、209=待测试回归。测试领域取值：软件;需求订单;硬件;生产-整机;生产-单板;产品运维。完整参数见 `rd-cli wetrack advanced-query --help`。

### 3.6 保存（save）

```bash
rd-cli --dry-run --json wetrack save --defect-number <编号> --step <105/106> \
  --modify-content "<用户提供的修改说明>" \
  --modify-type-name "<metadata 枚举值>" \
  --modify-version-name "<metadata 枚举值>" \
  --one-level-category-name "<枚举值>" --two-level-module-name "<枚举值>" \
  --two-level-cause-name "<枚举值>" --three-level-cause "<用户提供的分析>" \
  --svn-git "GIT"
```

保存不触发流转。step=105 或 106。**内容类字段（modify-content、three-level-cause）必须来自真实信息，禁止用"已修复"等占位文案默认填充。** 常规场景由用户提供；走「全自动托管模式」时由本次实际代码改动摘要自动生成，**不向用户索取、不因此中断**。

### 3.7 提交流转（submit，105/106）

**必填（始终）**：`--defect-number`、`--step`、`--next-step`、`--approver`（下一审批人工号，CLI help 未标注但 tools.json required 中必填，缺失时静默失败 exit 1）。

**条件必填：**

| 流转 | 需要的参数 |
|------|-----------|
| step=105 提交类（nextStep 经 flow-options 确认） | 3.6 全部内容参数 |
| step=106 提交类 | `--self-test-describe`、`--self-test-ver-name` |
| 驳回类 | `--comment`（驳回理由） |

**approver 默认规则：** 105 提交类用当前登录人工号；106 提交类用缺陷创建者工号（detail 的 `creatorName` 格式 `姓名(工号)` 取括号内数字）。

**标准流程：** `defect-flow-options` 确认 nextStep → 组参数 → `--dry-run` 验证 → 实际执行 → `pending` 验证流转结果。建议先 save 持久化内容再 submit。

### 3.8 全环节流转（defect-flow）

step 非 105/106 或需要审批/强制流转时使用，支持 101~110 全环节。操作人必须是问题单当前责任人，否则返回 code=403。参数与可选项先查 `defect-flow-options`，详见 `rd-cli wetrack defect-flow --help`。

## 权威参数定义

CLI `--help` 可能不完整。参数疑问以 `~/.rd-cli/cache/tools.json` 的 `inputSchema`（required / enum / type）为准；TTL 10 分钟，过期用 `rd-cli refresh` 刷新。

## 故障排查

| 症状 | 可能原因 | 排查 |
|------|----------|------|
| 所有 wetrack 命令 exit 1 | mate-proxy 不可用 | 等待重试；工具列表过期用 `rd-cli refresh`（**admin reload 已废弃**） |
| submit exit 1 无错误 | 缺必填参数（尤其 `--approver`） | 查 tools.json required 列表 |
| 名称类参数不生效 | 不匹配系统枚举 | 从 project-metadata 取精确值 |
| 模块名在元数据无匹配 | 缺陷单 `moduleName`（如 `web-操作日志`、`网关`）与 `twoLevelModules` 命名体系不一致 | 默认回退 `其他/其他`；但用户已知修复归属（如「中台已修复」）时，按实际归属选大类/模块（如 `海外云-D-Volt / 中台`），并以用户确认为准 |
| `--dry-run` 成功但实际失败 | 后端状态/权限校验 | 确认当前环节与责任人 |
| detail 返回 400 | 编号无效 | 用完整 DTS 编号 |
| 新命令不出现 | 工具列表缓存过期 | `rd-cli refresh` |

## 分析后知识沉淀（knowledge.md）

**触发时机**：**仅当用户明确要求**结合代码分析问题时执行（含「全自动托管模式」下的分析阶段）。代码分析完成后，把本次结论沉淀到本技能目录下的 `knowledge.md`（内置部署时技能目录只读，改为写入当前工作区 `.agents/skills/rd-cli-ops/knowledge.md` 并向用户报告位置）。未做代码分析则不触发，不得凭空写入。

### Step 1 生成总结（≤100 字，单行）

- **标题**：≤20 字，一眼可识别主题（如「附件大小显示 0KB」）
- **内容**：≤100 字，单行，聚焦 `现象 → 根因 → 处理/结论`，不写过程流水账
- 写不出有效结论（如未定位到代码）时**不写**

### Step 2 写入 knowledge.md

文件不存在则先创建（含表头）。**每条总结占表格一行**：

```markdown
| 标题 | 总结 |
|------|------|
| 附件大小显示 0KB | detail 回显按整数 KB 取整，<1KB 显示 0 KB，需用 Get-Item 查真实大小，勿据此判定附件为空 |
```

### 约束（红线）

- **一行一条**：内容不得换行、不得超 100 字；标题不得超 20 字
- **只追加**：不删除、不重排已有条目；发现同主题条目时就地更新该行（仍保持一行），不新增重复行
- **不写敏感信息**：工号、token、密码、内网地址一律不写
- **不臆造**：无代码分析结论或结论未经证据支撑时，宁可不写
- 写入后在答复中说明「已沉淀到 knowledge.md：<标题>」

## 全自动托管模式：修复单流程（查询 → 分析 → 修复 → 提交）

**触发条件**：用户**明确声明要修复某个缺陷单**（如「修复 DTS006689384」「把这个单改掉并提交」）时启用。用户未声明修复意图 → 保持只读，禁止自动改代码、自动提交。

**托管模式（硬性）**：一旦触发即进入**全自动托管模式**——全程**不向用户提问、不请求确认、不等待回复**；所有决策（含**修复方案选型**与提交字段取值）一律按默认推荐值自动决策后直接执行。禁止输出「是否需要…？」「请确认…」等提问，禁止调用任何交互式询问能力。

### 阶段与动作

| 阶段 | 动作 | 产出 |
|------|------|------|
| 1 查询 | `detail` 取详情 → `flow-options` 取 nextStep → `meta` 取枚举；`pending` 确认环节与责任人 | 单号上下文（环节、模块、测试领域、创建者、可选流转） |
| 2 分析 | 结合当前工作空间代码定位根因（无代码则**直接停止**并上报） | 根因 + 目标文件/方法 + 修改方案 |
| 3 修复 | 按方案最小化改码（只改根因相关代码），**不执行 mvn 编译/构建/单测验证** | 代码改动 + 改动摘要 |
| 4 提交 | 组字段 → `save` 持久化 → `submit` 流转（先 `--dry-run` 再实际执行） | 流转结果 + `pending` 复核 |

各阶段之间**连续执行、不询问确认**；仅在命中「必须人工介入」时才终止。

### 修复方案选型（默认推荐，不问用户）

- 取**最小改动**方案：优先修改现有方法，不新增抽象层
- 与所在文件/模块**既有风格一致**，不顺手重构、不统一风格
- **不引入新依赖、新配置、新表结构**
- 存在多种可行改法时，取**改动行数最少、影响面最小**的一种直接实施，**不列方案让用户选**
- 需要权衡时取**最保守、最贴合问题单描述**的方案

### 自动填写字段规则

**step=105 提交类**

| 参数 | 自动取值来源 |
|------|--------------|
| `--next-step` | `flow-options` 实际返回；默认取「提交转测自验」（示例 5001） |
| `--modify-content` | **由本次实际代码改动摘要生成**（改了哪些文件/方法 + 修了什么），禁止"已修复"等占位文案 |
| `--modify-type-name` | 默认「代码修改」（须与 metadata 精确匹配） |
| `--modify-version-name` | metadata `modifyVersions` 的**最新版本** |
| `--one-level-category-name` | 由 `fieldName`（测试领域）/`moduleName` 推断，须与 metadata 匹配 |
| `--two-level-module-name` | 由 `moduleName` 推断，**必须属于所选一级大类**（联动） |
| `--two-level-cause-name` | 由根因分析推断（独立字段，不联动）；无匹配回退「其他」 |
| `--three-level-cause` | 根因分析结论（来自代码定位，不得空泛） |
| `--svn-git` | `GIT` |
| `--approver` | 当前登录人工号 |

**step=106 提交类**

| 参数 | 自动取值来源 |
|------|--------------|
| `--next-step` | `flow-options` 实际返回；默认取「提交测试工程师」（示例 6002） |
| `--self-test-describe` | 改动点摘要（来自阶段 3 的实际代码改动）；**不执行 mvn 编译/单测，故不得声称"编译通过/测试通过"**，如实写"已完成代码修改" |
| `--self-test-ver-name` | metadata `selfTestVersions` 中与修复版本对应的项 |
| `--approver` | 缺陷创建者工号（`detail.creatorName` 的 `姓名(工号)` 取括号内数字） |

**通用**：所有枚举先 `meta` 校验；名称类无对应值时按既有回退规则（模块回退受大类联动约束，版本类无「其他」则报错停止）。

**同类单批量提交**：同一项目、同一功能模块、同一环节的连续多单（用户说「这个也是一样的问题」），直接复用上一次用户确认过的修复版本/大类/模块等取值，不重复询问；`modify-content` 与 `three-level-cause` 仍须按各单实际现象分别撰写。

### 必须人工介入（硬停止）

命中任一条 → **停止后续动作**（尤其不得提交），输出「阻塞原因 + 已完成改动 + 建议下一步」，并标记为未完成：

硬停止**仅用于确实无法自动决策**的情形（如定位不到根因、需改契约、权限不足）；**不得为求稳而主动停下来询问用户**，且硬停止时同样**不提问**、只输出结论并结束，其余情形一律按默认推荐值继续执行。

1. 工作空间无相关代码，或定位不到根因
2. 需要变更接口契约（字段/状态码/错误码语义）、公共组件或跨模块扩散
3. 需要新增依赖、改配置、改数据库结构
4. 权限不足（403）或当前登录人非该单责任人
5. 枚举无匹配且无可回退项（如版本类）
6. `--dry-run` 未通过

### 红线

- **未声明修复意图不得改码**；只读查询场景保持只读
- 改码范围**最小化**：只动根因相关代码，不顺手重构、不统一风格
- **不得跳过 `--dry-run`**；dry-run 通过才可实际提交
- 内容类字段必须来自**真实改动**，禁止占位文案、**禁止编造编译/测试结果**
- **不执行 mvn 编译/构建/单测验证**（用户明确要求）；改动正确性由用户自行在代码库确认，不得声称"已验证通过"
- 分析阶段的结论按「分析后知识沉淀」规则沉淀一条到 `knowledge.md`
- 提交后必须用 `pending` / `detail` 复核流转结果，不得凭 submit 返回值直接判定成功
- 命中硬停止项**不得自动回滚**已改代码（除非用户要求），只停止并上报
- 托管模式下**禁止任何形式的提问与确认**（含交互式选项），不得等待用户回复；改动结果由用户自行到代码库查看，**无需征求验收**

## 执行后自优化（Skill 自迭代）

**触发时机**：每次本 skill 执行完毕后（无论成功或失败），在输出最终答复之前，必须强制执行一次自检与自优化。这是本 skill 的收尾动作，不可跳过。

### 自优化五步

**Step 1 采集证据**（只读，不改文件）

- 本次实际调用的子命令 / 参数 / 关键输出
- 出现的报错、重试、手工补救动作、用户纠正或补充的信息
- 任何"文档没写但实际如此"的发现（如新必填参数、枚举联动、路径行为差异）

**Step 2 判定是否需要改进**

命中以下任一条即判定"需要改进"：

- SKILL.md（或脚本注释）描述与实际行为不一致
- 本次踩坑未在「故障排查」中记录
- 存在重复的人工步骤，可固化/脚本化
- 用户明确纠正或补充了规则、偏好、约束
- 存在更短、更稳的操作路径
- 用户频繁使用习惯,比如在skill执行完毕后,用户主动声明,结合代码分析,超过一定频率时,自动将用户行为习惯记录下来,优化用户日常流程
全部不命中则判定"本次无需优化"，直接跳到 Step 5 记录结论。

**Step 3 生成改进方案**（先出方案，再动手）

按固定格式列出：`问题 → 证据 → 改进点 → 影响面 → 是否破坏兼容 → 回滚方式`。
单次自优化改动控制在 **3 处以内**，超出则只取收益最高的 3 处，其余作为「建议项」保留。

**Step 4 落地改进（正向优化红线）**

允许（正向优化）：

- 补充/修正文档说明、示例、注意事项
- 新增「故障排查」条目、补充已知坑位
- 记录新发现的必填参数、枚举规则、硬性约束
- 优化措辞、合并重复内容、补充索引，提升可读性与执行效率

禁止（除非用户在当前对话中明确要求）：

- 删除或弱化任何既有约束、校验、红线（如 `--dry-run` 前置、`flow-options` 校验、内容类字段禁止占位文案）
- 修改脚本对外契约：CLI 子命令名、参数名、输出结构、落盘路径与文件名
- 降低校验强度、放宽枚举匹配、跳过前置检查
- 大段重写或重构全文、改动 frontmatter 的 `name`

**若改进方案命中禁止项**：不得直接实施，改为在最终答复中列为「建议项（待用户确认）」。

**Step 5 记录与汇报**

- 在下方「变更记录」表追加一行（日期 / 改动点 / 原因 / 触发场景）
- 在最终答复的「风险与未覆盖项」前增加一行：`本次自优化：<改了什么 / 本次无需优化>`
- 若本次执行暴露了无法自行修复的阻塞（如 rd-cli 侧缺陷），只记录，不臆造改动

### 变更记录

| 日期 | 改动点 | 原因 | 触发场景 |
|------|--------|------|----------|
| 2026-10-20 | 故障排查新增「模块名在元数据无匹配」条目 | 缺陷单 moduleName 与 twoLevelModules 命名体系不一致时易卡壳 | 提交 DTS006734144（web-操作日志 回退 其他/其他） |
| 2026-10-26 | 「模块名在元数据无匹配」条目补充：已知修复归属时按实际归属选大类/模块 | 用户对「网关」模块选择 `海外云-D-Volt / 中台`，而非回退 `其他/其他` | 提交 DTS006729837 |
| 2026-10-26 | 自动填写字段规则新增「同类单批量提交」：复用上次已确认取值不重复询问 | 用户连续提交同项目同模块同类单（「这个也是一样的问题」），重复询问无收益 | 提交 DTS006729974 |
