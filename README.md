# Pi Durable Web

一个独立的 Pi Durable Web 入口。React 正文直接使用 DSH 的 Markdown、代码、终端和 Diff 展示组件，主题使用固定版本的 DSH 设计变量。执行、消息、工具和恢复由 Pi Durable 1.3.0 与 SQLite 承担。

## 启动

需要 Node.js 22.19+，推荐 Node.js 24。

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:4317。默认模型从本机 `~/.pi/agent/settings.json` 读取；Provider 与认证配置从 `models.json` 和 `auth.json` 只读导入。也可以在页面的模型设置中配置自定义 Provider。新设置保存在本项目的数据目录，已有 Pi 配置不被改写。

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
npm start
```

生产模式先构建，再运行 `npm start`。服务默认只监听本机，前端与 API 使用同一端口。

## 独立数据

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PI_WEB_PORT` | `4317` | HTTP 端口 |
| `PI_WEB_DATA_DIR` | `.data` | SQLite、应用配置和凭据目录，不提交到 Git |
| `PI_WEB_WORKSPACE` | `workspace` | Agent 文件与命令工作的目录 |
| `PI_WEB_DEMO` | 未设置 | 设为 `1` 使用明确标识的脚本化验收模型，不调用真实模型 |

真实服务不会因认证失败自动切换到演示模型。模型凭据只在服务端使用，接口不返回密钥值。

## 对话

会话支持标题、置顶和归档。模型和思考等级按会话选择；运行时发送可选择排队或插入。Pi 的插入消息会在当前工具轮结束后参与正在进行的任务。

停止使用 Pi 原生中止语义：停止当前普通工作并撤回排队输入。队列的移除按钮只撤回尚未被接纳的输入；已开始执行时返回明确错误。历史编辑可通过分叉继续，不覆盖已有 Entry。

刷新和断线恢复会读取完整会话快照。浏览器草稿、当前会话和显示主题与服务端的持久会话分开保存。

## 验证

自动化测试使用真实 Pi Durable/SQLite 与可控模型，验证持久化、幂等发送、队列、流式视图和恢复；HTTP 测试验证请求校验与订阅清理。可控模型验证不等于真实供应商调用通过。

```sh
PI_WEB_DEMO=1 PI_WEB_PORT=4318 PI_WEB_DATA_DIR=.data/demo npm run dev
npm run test:live
```

`test:live` 使用临时数据库、当前配置的默认真实模型和一个最小文本请求；不会修改已有会话或静默更换模型。供应商授权失败单独报告。

## UI 来源

- DSH 展示组件：`@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2`。
- 主题来源：DSH `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 许可和来源见 [vendor/README.md](vendor/README.md)。
- 数据与组件衔接见 [docs/architecture.md](docs/architecture.md)。
