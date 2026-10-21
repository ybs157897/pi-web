/**
 * The format contract the model follows when document layout is on.
 *
 * The browser renders a fenced `doc` block as a designed card, comparison or
 * callout, so the model has to be told when such a block is worth writing and
 * exactly which YAML shape it accepts. The text is Chinese because the model
 * answers in the user's language; the YAML keys stay English so the renderer
 * can read them.
 */
/**
 * 一次「交付说明」的完整形状，单独用数组拼出来：里面全是反引号，塞进模板
 * 字符串需要逐行转义，反而更容易写错。
 */
const COMPLETE_EXAMPLE = [
  '## 目标理解',
  '',
  '把工作区代码从 `dcc6f2b` 更新到 `462d428`，重新构建并重启服务，确认新实例可用。',
  '',
  '## 实际改动',
  '',
  '```doc',
  'type: changes',
  'items:',
  '  - path: src/server/shell-tools.ts',
  '    summary: 新增原生 Windows PowerShell 工具',
  '    stats: +120 −0',
  '  - path: src/web/transcript.tsx',
  '    summary: 接入新的工具卡',
  '    stats: +12 −3',
  '```',
  '',
  '## 验证结果',
  '',
  '```doc',
  'type: checks',
  'items:',
  '  - status: pass',
  '    label: 构建',
  "    detail: '`npm run build` 通过（3.17s）'",
  '  - status: pass',
  '    label: 启动',
  '    detail: 端口 `4317` 监听，`GET /` 返回 HTTP 200',
  '  - status: skip',
  '    label: 类型检查',
  '    detail: 本轮未执行 `npm run typecheck`',
  '```',
  '',
  '## 风险与未覆盖项',
  '',
  '- **Windows pwsh 未实机验证**：本机是 macOS，`pwsh` 工具没有在 Windows 上跑过。',
  '',
  '```doc',
  'type: note',
  'icon: warn',
  'title: 建议补验证',
  'body: 合并前在 Windows 实机跑一次 `pwsh`，并补跑 `npm test`。',
  "code: 'npm test && npm run typecheck'",
  'label: 待办',
  '```',
].join('\n')

export const DOC_STYLE_INSTRUCTION = `## 结论文档排版

当你的回答属于「结论、方案、评审、对比、总结」这类内容时，用下面的结构化块输出，前端会把它渲染成设计稿里的卡片、对比与提示块；普通解释、闲聊和代码讨论照常用普通 Markdown，不要滥用结构化块。

### 写法

用三个反引号加 \`doc\` 作为围栏语言，围栏里面写 YAML，围栏的前后各空一行：

\`\`\`doc
type: cards
items:
  - icon: text
    title: 字重对比
    body: 标题层用 Semibold，正文用常规字重。
    bullets:
      - 标题 700
      - 正文 400
\`\`\`

### 完整示例

下面是一次交付说明的完整形状：分节标题用 \`##\`，改动、验证和结尾建议各用一个块，块之间照常用 Markdown 写。

${COMPLETE_EXAMPLE}

### 卡片组

并排展示几条并列的信息，每张卡片有图标、标题、说明，可选要点列表：

\`\`\`doc
type: cards
items:
  - icon: text
    title: 字重对比
    body: 标题层用 Semibold，正文用常规字重。
    bullets:
      - 标题 700
      - 正文 400
  - icon: color
    title: 强调色
    body: 只用于关键数字和结论标题。
    bullets:
      - 正文色 #1f2328
      - 强调色 #2f6feb
\`\`\`

字段：\`type\` 固定为 \`cards\`；\`items\` 是卡片列表；每张卡片有 \`icon\`、\`title\`、\`body\`（可选）、\`bullets\`（可选，要点列表）。

### 对比

左右两栏对比，\`left\` 和 \`right\` 结构相同：

\`\`\`doc
type: compare
left:
  badge: check
  title: 保留现有接口
  subtitle: 改动最小
  bullets:
    - 旧客户端不受影响
    - 不需要迁移数据
  footer: 现在就做
right:
  badge: cross
  title: 全面重写
  subtitle: 长期更干净
  bullets:
    - 需要一次性迁移
    - 迁移期要双轨维护
  footer: 暂不建议
\`\`\`

字段：\`type\` 固定为 \`compare\`；\`left\` 和 \`right\` 各有 \`badge\`（\`check\` 表示推荐，\`cross\` 表示不推荐）、\`title\`、\`subtitle\`（可选）、\`bullets\`（可选）、\`footer\`（可选）。

### 验证结果

一条一条列验证项，\`status\` 用 \`pass\`（通过）、\`fail\`（失败）、\`skip\`（未执行）：

\`\`\`doc
type: checks
items:
  - status: pass
    label: 构建
    detail: '\`npm run build\` 通过（3.17s）'
  - status: pass
    label: 启动
    detail: 端口 \`4317\` 监听，\`GET /\` 返回 HTTP 200
  - status: skip
    label: 类型检查
    detail: 本轮未执行 \`npm run typecheck\`
\`\`\`

字段：\`type\` 固定为 \`checks\`；\`items\` 每项有 \`status\`、\`label\`、\`detail\`（可选）。

### 改动清单

交付代码改动时列出文件：

\`\`\`doc
type: changes
items:
  - path: src/server/shell-tools.ts
    summary: 新增原生 Windows PowerShell 工具
    stats: +120 −0
  - path: src/web/transcript.tsx
    summary: 接入新的工具卡
    stats: +12 −3
\`\`\`

字段：\`type\` 固定为 \`changes\`；\`items\` 每项有 \`path\`、\`summary\`（可选）、\`stats\`（可选，写成 \`+120 −0\` 这种增删数）。\`stats\` 写你能确定的数字；这一行确实是本轮改过的文件时，前端会用真实 diff 覆盖它，拿不准可以省略，但不要编造。

### 提示

回答末尾的补充说明、提醒或下一步：

\`\`\`doc
type: note
icon: info
title: 下一步
body: 先补一条回归用例，再合并这个分支。
code: npm test -- doc-style
label: 可选
\`\`\`

字段：\`type\` 固定为 \`note\`；\`icon\`、\`title\`、\`body\` 必填，\`code\`（一行命令或代码片段）和 \`label\`（一个小标签）可选。

### 版面结构

多部分的结论先用 \`##\` 小节标题分节，节标题控制在理由级短语（不超过 10 个字），每个节下面放一个 doc 块或普通段落。前端会给小节自动编号（01、02…），所以不要自己在标题里写序号，也不要用一级标题 \`#\`。

### 规则

- 块内的路径、命令、提交号、URL 一律用反引号包起来（例如 \`src/app.ts\`、\`npm test\`、\`462d428\`）：前端会把它们渲染成 chip，路径可点开文件、命令点击可复制；不包反引号就只是普通文字。
- 一次回答最多用 2 到 4 个 doc 块，块之间的普通段落照常用 Markdown 写。
- 结论分节时每节至少有一个 doc 块或两段以上的正文，不要出现只有标题的空节。
- 只有结论本身值得并排、对比或提醒时才用结构化块，其余内容保持普通 Markdown。
- 卡片图标只能从下面这份白名单里选：text、doc、file、code、list、todo、edit、copy、compare、plan、goal、tree、branch、queue、api、link、injection、time、deadline、check、cross、done、failed、info、warn、question、loading、pause、stop、run、refresh、pin、add、agent、team、folder、workspace、chat、preset、settings、sliders、shield、plugin、skill、data、globe、chart、layers、space、color、sparkle、think、enhance、bulb、search、inspect、archive、restore、share、download、attach、send、expand、delete。
- 图标按语义选：结论用 check/cross/done/failed，提醒用 info/warn/question，任务与排期用 todo/plan/deadline/time，角色与组织用 agent/team/folder/workspace，技术对象用 code/api/data/chart，方向与流程用 tree/branch/link/queue。
- doc 块里不要放代码围栏（不要出现三个反引号），也不要写引用式链接和脚注；这些在块里无法正确渲染。
- 每个 doc 块只表达一件事，字段不要留空字符串，确实没有内容就省略该字段。
- YAML 值里只要出现「冒号 + 空格」（\`: \`）、\`#\`、或者以 \`{\` \`[\` 开头，整段值就用单引号包起来；\`code\` 字段一律用单引号包起来，例如 \`code: 'const s = create({ tab: 1 })'\`。值里的单引号写成两个单引号转义。`

/** The icon names a `doc` block may use; the model must not invent others. */
export const DOC_STYLE_ICONS = [
  'text', 'doc', 'file', 'code', 'list', 'todo', 'edit', 'copy', 'compare',
  'plan', 'goal', 'tree', 'branch', 'queue', 'api', 'link', 'injection',
  'time', 'deadline',
  'check', 'cross', 'done', 'failed', 'info', 'warn', 'question', 'loading', 'pause', 'stop',
  'run', 'refresh', 'pin', 'add',
  'agent', 'team', 'folder', 'workspace', 'chat', 'preset',
  'settings', 'sliders', 'shield', 'plugin', 'skill', 'data', 'globe', 'chart', 'layers',
  'space', 'color', 'sparkle', 'think', 'enhance', 'bulb', 'search', 'inspect',
  'archive', 'restore', 'share', 'download', 'attach', 'send', 'expand', 'delete',
] as const
