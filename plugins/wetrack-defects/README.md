# WeTrack Defects

查看 WeTrack 待办、缺陷详情，并让 Agent 结合当前工作区代码分析后渲染层级报告。

## 能力

- `wetrack_pending`：当前用户待办，或按 `project` / `owner` / `status` 查询。
- `wetrack_detail`：按 `DTS...` 编号读取完整详情。
- `wetrack_report`：接收模型产出的结论 + 章节树，渲染可折叠的层级报告。
- 默认在**右侧面板**打开一个持久页面（同一 tab 随 pending/detail/report 更新），正文只保留工具摘要和分析文字，页面不会被分析正文淹没。
- 页面：左侧缺陷列表，右侧详情/报告；支持搜索、严重程度/状态筛选、附件与内嵌图片路径展示，以及「让 AI 分析」按钮。

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
| `WETRACK_CLI` | `rd-cli` | 单个可执行文件；路径不要含空格 |
| `WETRACK_CWD` | `C:\\work` | 可选，CLI 工作目录 |
| `WETRACK_FIXTURE` | `fixtures/demo.json` | 仅离线演示；不让 CLI 运行 |

未配置且 `rd-cli` 不在 PATH 时，工具会返回一段配置说明，不会伪造数据。也可以在 `.pi-plugin/plugin.json` 的 `mcpServers.wetrack.env` 里写死同样的变量再安装，例如 `"WETRACK_CLI_JSON": "[\"python\",\"C:\\\\tools\\\\wetrack.py\"]"`。

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

直接打开页面 URL 并加 `?demo=1` 可以看到内置的演示列表/详情/报告，不依赖 Host 桥接或 CLI。
