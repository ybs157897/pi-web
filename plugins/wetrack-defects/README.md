# WeTrack Defects

查看 WeTrack 待办、缺陷详情，并让 Agent 结合当前工作区代码分析后渲染层级报告。

## 能力

- `wetrack_pending`：当前用户待办，或按 `project` / `owner` / `status` 查询。
- `wetrack_detail`：按 `DTS...` 编号读取完整详情。
- `wetrack_report`：接收模型产出的结论 + 章节树，渲染可折叠的层级报告。
- 默认在**右侧面板**打开一个持久页面（同一 tab 随 pending/detail/report 更新），正文只保留工具摘要和分析文字，页面不会被分析正文淹没。
- 页面：左侧缺陷列表，右侧详情/报告；支持搜索、严重程度/状态筛选、附件与内嵌图片路径展示，以及「让 AI 分析」按钮。
- 「登记缺陷」tab：由 [SurveyJS Form Library](https://github.com/surveyjs/survey-library)（v3.2.3，MIT）渲染的登记表单，提交后把结构化草稿经 `ui/message` 发回对话，由模型整理成提单文案；不直接创建缺陷。

## 安装

这是一个本地插件。在 pi-web 的 **设置 → 插件市场 → 添加市场** 中填入本目录的父目录：

```text
<workspace>/plugins
```

然后在市场里安装 `wetrack-defects`，启用后用新任务试用。

## 配置 WeTrack CLI

插件服务进程需要能找到 WeTrack CLI。按优先级配置环境变量：

| 变量 | 示例 | 说明 |
| --- | --- | --- |
| `WETRACK_CLI_JSON` | `["python","C:\\tools\\wetrack.py"]` | 推荐；JSON 数组，路径含空格也安全 |
| `WETRACK_SCRIPT` | `C:\\tools\\wetrack.py` | 配合 `WETRACK_PYTHON`（默认 `python`） |
| `WETRACK_CLI` | `rd-cli` | 单个可执行文件或完整路径；按 `PATH`/`PATHEXT` 查找，路径可以含空格 |
| `WETRACK_CWD` | `C:\\work` | 可选，CLI 工作目录 |
| `WETRACK_FIXTURE` | `fixtures/demo.json` | 仅离线演示；不让 CLI 运行 |

未配置且 `rd-cli` 不在 PATH 时，工具会返回一段配置说明，不会伪造数据。也可以在 `.pi-plugin/plugin.json` 的 `mcpServers.wetrack.env` 里写死同样的变量再安装，例如 `"WETRACK_CLI_JSON": "[\"python\",\"C:\\\\tools\\\\wetrack.py\"]"`。

调用约定（按 `rd-cli` 1.0.4 实测）：

- 可执行文件名是 `rd-cli` 时自动补 `wetrack` 命名空间（`rd-cli wetrack pending --json`）；`wetrack.py` 直接收命令。
- 过滤查询在 `rd-cli` 上是 `wetrack advanced-query`（没有 `query`），参数是 `--project-num` / `--cur-user-name` / `--defect-status`，且项目编号、产品线、问题单号、需求编号**至少要填一项**，否则 CLI 返回 `BIZ_400`；`wetrack.py` 用 `query --project/--owner/--status`。
- 详情：`rd-cli` 用 `detail --defect-number <DTS…>`，`wetrack.py` 用位置参数。
- 回复信封：`rd-cli` 成功是 `{ success: true, data }`（列表在 `data.items`，详情的 `data` 就是缺陷对象）；业务失败是 `{ success: false, error: { code, message, stage } }`，JSON 打在 **stdout**、退出码 1（认证失败 3），参数错误才是 stderr。`wetrack.py` 输出平铺、没有信封。
- Windows 上不走 `shell`：`.cmd`/`.bat` 垫片经 `cmd.exe /d /s /c` 执行，路径含空格也安全。

## 数据约定

列表与详情遵循 `wetrack.py` 的 JSON 输出：列表是 `{ source, generatedAt, count, items[] }`，详情是字段对象。插件保留未知字段；详情默认由 CLI 把 base64 图片转存并把 `description` 中的图片替换为本地路径。

## 报告结构

```json
{
  "title": "DTS... 根因分析",
  "defectNumber": "DTS...",
  "conclusion": "先给结论",
  "sections": [
    {
      "title": "根因与证据",
      "detail": "说明",
      "items": ["src/a.ts:42 ..."],
      "children": [{ "title": "待确认", "items": ["..."] }]
    }
  ]
}
```

模型应先读取详情、再检查工作区代码，最后调用 `wetrack_report`；页面会把 `sections` 按层级渲染成可折叠树。`wetrack_detail` 的 tool content 包含完整详情 JSON（不只是摘要），模型不需要再用 rd-cli 或临时文件重复读取。

## 离线预览

直接打开页面 URL 并加 `?demo=1` 可以看到内置的演示列表/详情/报告，不依赖 Host 桥接或 CLI。表单库较大，`ui/vendor/` 里的 SurveyJS 发行产物由 `server.mjs` 启动时内联进页面（宿主 CSP 禁止外链脚本/样式），因此直接以 `file://` 打开时「登记缺陷」tab 会提示不可用，看板与报告不受影响。

## 升级 SurveyJS

`ui/vendor/` 内的文件来自 `survey-core@3.2.3` 与 `survey-js-ui@3.2.3` 的 npm 发行产物（含 `i18n/simplified-chinese` 与 `themes/default-light`、`themes/default-dark`）。升级时替换同名文件即可，不要改动 `board.html` 里的 `/*__SURVEY_*__*/` 标记。
