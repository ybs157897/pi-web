---
name: yunji-gateway
description: >-
  直连云迹（yunji）日志平台网关查询业务日志（dolynk / busilink）。当用户提到云迹、yunji、
  业务日志、日志查询、日志检索、查日志、按 traceId/messageId 查日志、定位线上问题、
  排障、看错误日志（error 级别）、按接口路径/服务/表查日志时使用。
  支持环境切换：dev / test-sg 走 test-sg 网关（默认），声明 fk（test-fk）时走独立 fk 网关
  （当用户说"fk 环境""test fk""fk 的日志"时，必须用 env=fk 查 fk 网关）。
  本技能通过独立 Python 脚本 yunji_gateway.py **直接调用云迹网关的 gRPC-web + protobuf 接口**，
  不依赖任何部署的 Java 服务，不依赖第三方库（仅 Python 标准库）。
---

# 云迹（yunji）网关直连日志查询

当前 Skill 版本：1.4.0（新增环境切换 fk / test-sg；23h 切批并行覆盖 3 天日志；traceId 链路分析：gateway → 服务 → 下游传播）

本技能通过**独立 Python 脚本** `yunji_gateway.py` **直连云迹日志平台网关**（gRPC-web + protobuf），
绕开任何部署的中间服务。脚本仅使用 Python 标准库（urllib / json / struct），**无需安装任何第三方依赖**，
拷到任意能访问云迹网关的机器即可运行。

## 运行前提

- Python 3（标准库即可，无第三方依赖）
- 能访问**目标环境**的云迹网关（见下节「环境选择」）
- **本机访问需走代理**（默认 `http://10.30.88.12:9090`）；若在可直连的机器上运行，设环境变量 `YUNJI_PROXY=""`
- 登录凭据默认 `yunji` / `nRcGrQ4NX466kQjztjZb`，可用环境变量覆盖

## 环境选择（重要，先确认再查）

云迹网关**按环境分别部署**，查日志前必须先确认目标环境，否则会查错网关（常见表现：在默认环境搜不到、结果为空）：

| 用户声明 | 环境标识 | 网关基地址 |
| --- | --- | --- |
| **fk**（`fk环境` / `test-fk` / `test fk`） | `fk` | `https://yunji-test-fk.dolynkcloud.com` |
| **dev** / **test** / **test-sg**，或未声明（默认） | `test-sg` | `https://yunji-test-sg.dolynkcloud.com` |

> 网关已统一为 **HTTPS + 默认 443**，**不再使用 `:8128` 端口**。若脚本报 502/连接失败，先确认地址里没有残留 `:8128`。

- **dev 环境与 test-sg 环境都走 test-sg 网关**（同一个网关），无需区分。
- **声明 fk 时走独立的 fk 网关**，不要用默认 test-sg 网关去查 fk 日志；反之亦然。
- 切换方式（任选其一，优先级见下）：
  - **CLI**：加 `env=fk`（等价 `environment_id=fk`），如 `python yunji_gateway.py search_to_file keyword=<traceId> env=fk`
  - **Python**：`YunjiGatewayClient(environment_id="fk")`
  - **环境变量**：`YUNJI_ENV=fk`
- 基地址优先级：`YUNJI_BASE_URL` > 显式 `base_url` 入参 > 环境预设（fk / test-sg）> 默认 test-sg。
- 别名归一化：`sg` / `testsg` / `dev` / `test` / `develop` → `test-sg`；`fk` / `testfk` / `test-fk` → `fk`。
- **注意**：返回结果里的 `environment_id` 字段仅用于展示；真正决定查哪个网关的是**基地址**（由上表的环境选择决定）。

## 文件说明

本 skill 目录包含：

- `yunji_gateway.py` — 独立客户端（含 `YunjiGatewayClient` 类与 CLI 入口）
- `SKILL.md` — 本说明
- `references/gateway-protocol.md` — 网关协议参考（gRPC-web / protobuf / 限流处理）

## 使用方式（二选一）

### 方式 A：Python import（推荐）

```python
import sys
sys.path.insert(0, r"<skill目录>")
from yunji_gateway import YunjiGatewayClient

client = YunjiGatewayClient()                        # 默认环境 test-sg（dev / test-sg）
# client = YunjiGatewayClient(environment_id="fk")   # 声明 fk 时改成这一行 → fk 网关
targets = client.list_targets()                      # 1. 先确认查询范围
result = client.search_logs(
    keyword="<traceId 或接口路径>",
    start_time="2026-07-29 00:00:00",
    end_time="2026-08-29 12:18:00",
    repos=["dolynk"],                                 # 或 table_name="dolynk_dolynk_gateway_log"
)
```

### 方式 B：命令行

**标准执行命令**（必须固定使用此形式）：

```bash
cd "<skill目录>"
python yunji_gateway.py <方法名> [key=value ...]
```

示例：
```bash
python yunji_gateway.py list_targets
python yunji_gateway.py search_logs keyword=xxx
python yunji_gateway.py search_logs keyword='<traceId>' start_time='2026-07-29 00:00:00' end_time='2026-08-29 12:18:00'
python yunji_gateway.py search_logs keyword=xxx repos='["dolynk"]' level=error limit=100
python yunji_gateway.py search_logs keyword=xxx table_name='dolynk_dolynk_gateway_log'
python yunji_gateway.py search_to_file keyword='<traceId>' repos='["dolynk"]' start_time='2026-07-29 00:00:00' end_time='2026-08-29 12:18:00'
# fk 环境（走独立 fk 网关，声明 fk 时必须加 env=fk）：
python yunji_gateway.py search_to_file keyword='<traceId>' env=fk repos='["dolynk"]'
python yunji_gateway.py search_logs keyword=xxx env=fk level=error
```

> **中文乱码约束（强制）**：脚本 `__main__` 已强制 UTF-8 输出，**无需也不允许**再加
> `-X utf8` 或手动设置控制台编码。若控制台仍乱码，说明是终端本身非 UTF-8，可在执行前加一行：
> ```bash
> $OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
> ```

## 环境变量（可选）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `YUNJI_ENV` | 默认环境：`fk` → fk 网关；`test-sg` / `dev` / `test` → test-sg 网关 | `test-sg` |
| `YUNJI_BASE_URL` | 网关基地址**硬覆盖**（优先级最高，会覆盖环境预设） | 由 `YUNJI_ENV` 决定 |
| `YUNJI_USERNAME` / `YUNJI_PASSWORD` | 登录凭据 | `yunji` / `nRcGrQ4NX466kQjztjZb` |
| `YUNJI_PROXY` | HTTP 代理（本机走代理，服务器直连设空） | `http://10.30.88.12:9090` |

## 方法清单

| 方法 | 作用 | 关键参数 |
| --- | --- | --- |
| `list_targets(environment_id=None)` | 列出可查询的 repo 与日志表清单 | `environment_id`（`fk` → fk 网关；缺省 test-sg 网关） |
| `search_logs(...)` | 按关键字 + 时间窗检索业务日志，返回 JSON rows | 见下方参数详解 |
| `search_to_file(...)` | 检索并把**所有匹配日志写入临时目录文件**，返回文件路径 | 见下方参数详解；**AI 查日志首选** |

## search_logs 参数详解

| 参数 | 说明 | 建议 |
| --- | --- | --- |
| `repos` | product_code 列表，如 `["dolynk"]` 或 `["busilink"]`；用于从 ListApp 解析表集合 | 建议收敛到单个 repo |
| `keyword` | 全文检索关键字；`traceId` / `messageId` 直接全文匹配 | 定位问题首选 traceId |
| `table_name` | **精确到单表**，如 `dolynk_dolynk_gateway_log`（不带前缀） | >23h 窗口时建议单表（见下方限流说明） |
| `service_code` / `product_code` | 服务/产品级收敛 | 按需 |
| `start_time` / `end_time` | 时间窗，北京时间 | 传 `"YYYY-MM-DD HH:MM:SS"`（无时区=北京时间）或 ISO8601；**默认今天 0 点至今**；>23h 自动按 23h 切批并行 |
| `level` | `all` / `error` / `warn` / `info` / `debug`，默认 all | 排障先设 `error` |
| `page_size` | 每页大小，默认 100，最大 200 | 一般不动 |
| `limit` | 最多返回条数，默认 500，最大 1000 | 需要更多再增大 |
| `retry` | 空结果时重试一次（历史窗口先等 65s），默认 True | 一般不动 |
| `environment_id` | 结果里的环境**展示**字段；**不改变**实际查询的网关（网关由客户端 `environment_id` / CLI `env=` 决定） | 见「环境选择」 |

## search_to_file（AI 查日志首选）

把匹配日志写到**临时目录**文件（Windows `%TEMP%\yunji_logs\`，Linux `/tmp/yunji_logs/`），返回文件绝对路径，AI 可直接读取/搜索该文件。

```python
result = client.search_to_file(
    keyword="<traceId 或关键字>",
    start_time="2026-07-29 00:00:00",
    end_time="2026-08-29 12:18:00",
    repos=["dolynk"],            # 或 table_name="dolynk_dolynk_gateway_log"
    limit=5000,                  # 最多写多少条，默认 5000，最大 20000
)
# result["file_path"] 即为日志文件，用 Read 读取该路径即可
```

CLI：
```bash
python yunji_gateway.py search_to_file keyword='<traceId>' repos='["dolynk"]' start_time='2026-07-29 00:00:00' end_time='2026-08-29 12:18:00'
# fk 环境（走 fk 网关）：
python yunji_gateway.py search_to_file keyword='<traceId>' env=fk repos='["dolynk"]'
```

文件格式（每条日志一行，用 ` | ` 分隔）：
```
# 列: 时间(北京) | 表 | 级别 | 主机 | 内容
2026-08-28 11:21:00 | dolynk_dolynk_gateway_log | info | 192.161.1.177 | 2026-08-28 03:21:00.640 [reactor-http-epoll-2] [052f9a42bd...
```

> **推荐流程**：AI 收到查日志需求时，直接调用 `search_to_file`，拿到 `file_path` 后用
> Read 读取文件分析；比解析 `search_logs` 的 JSON rows 更高效，且能处理大结果集。

## 查询规则（重要：切批并发 + 链路分析）

日志只保留 **3 天**。网关对 ≤23h 窗口查询**无频控**，脚本策略：

1. **时间窗自动切批**：>23h 的窗口按 **23h 一批**切开，**批与批并行、批内表并行**
   （默认 8 线程），3 天窗口 ≈ 4 批并发，秒级返回。无需手动拆时间。
2. **链路分析检索（traceId / 接口路径关键字）**，按以下顺序自动执行：
   - 先查 **gateway 表**（`*gateway*_log`）——请求日志里有完整 URL；
   - 从 gateway 日志的 `path=/xxx-service/v1/...` 推理目标服务 → 查该服务的日志表；
   - 再从已获日志中识别**下游调用**（Feign/HTTP URL，如
     `http://10.x.x.x:9091/mp-user/v1/...` → mp-user）→ 查下游服务的表（最多传播 2 跳）；
   - 中台服务（`mp-*` 等）若在 ListApp 目录中无日志表则自动跳过。
3. **32 位 hex 不一定是 traceId**：`traceId` / `messageId`（如 `AC11000100012FF4...`）/
   设备 ID 都可能呈 32 位 hex 形态。脚本自动双路判定：先用探测表对比
   `trace_id` 字段模式与全文 filter 模式的命中量，全文明显更多（正文标识）时
   自动降级为全文检索，无需用户关心。
4. **显式指定 `table_name` / `service_code` 时不做链路分析**，直接精确查询。
5. **普通关键字**（非 32 位 hex、非接口路径）不做链路分析，按 `repos` 展开并发扫表。

AI 收到查日志需求时：直接给 `search_to_file` 传 `keyword` + 时间窗即可（时间可跨 3 天），
脚本自动切批 + 链路分析；只有需要精确控制时才传 `table_name`。

## 时间规则（重要）

- 一律**北京时间**：不带时区的 `"YYYY-MM-DD HH:MM:SS"` 按北京时间解析；也接受 ISO8601/RFC3339。
- 网关对 traceId/接口路径检索走**链路分析**：gateway 表 → path 推理服务 → 下游服务传播（最多 2 跳）；
  显式指定 `table_name` 时不做链路分析（见"查询规则"）。
- 历史窗口（>23h）自动**按 23h 切批并行查询**（日志只保留 3 天，切批后每批无频控）。
- **未来时间窗会被拒绝**：相对时间范围（如"今天"、"最近 1 小时"）要先换算成绝对北京时间再传。
- 返回结果中的 `time` 字段均为北京时间。

## 网关过滤能力实测（2026-09-08，重要）

- `Query.trace_id` 字段是**唯一有效的服务端过滤**：命中真 traceId，
  也附带命中网关收录的正文索引字段（如 reqBody 里的 messageId）。
- **`Query.filter` 字段无效**：乱串 filter（`zzzqqqxxx`）与无过滤返回完全相同——
  网关根本不执行 filter。所以"关键字全文检索"必须**客户端后过滤**
  （脚本已实现：无过滤拉首页 → 按 content 包含筛选）。
- 客户端后过滤的覆盖受首页条数限制（每表每批 page_size 条）：热表大窗口会漏数据。
  **需要完整结果时优先用 traceId 查询**（字段模式是精确的）。
- 32 位 hex 关键字不一定全是 traceId（可能是 messageId/设备ID）——
  脚本自动逐表探测判定（判定结果跨批次共享缓存，只探测一次）。
- **body 模式（客户端后过滤）自动翻页补扫**：热表大窗口下首页 200 条只覆盖最新几秒，
  脚本对未命中的表最多翻 5 页（每表上限 1000 条）兜底；需要更完整结果请用 traceId 查询。

## 网关限流说明（重要，2026-09 实测结论）

网关频控按**查询时间窗大小**全局计量：与表名、IP、traceId 无关，配额**跨表共享**、按分钟窗重置。
被限时**返回空结果**（而非报错）。

| 时间窗 | 频控 |
| --- | --- |
| ≤ 24h（脚本按 ≤23h 判定） | **无频控**：多表并发随便查（实测一分钟 65 次无限制） |
| >24h ~ 3 天 | 全局约 **5 次/分钟**（多表并发只有前 ~5 张表返回数据） |
| ~7 天 | 全局约 **1 次/分钟** |

脚本应对策略（已内置）：

1. **≤23h 窗口**：自动走**并发扫描**（默认 8 线程，`max_workers` 可调），无频控，全程秒级。
2. **>23h 窗口**：自动**按 23h 切批**、批间并行（每批 ≤23h 落在无频控区间），
   3 天窗口 ≈ 4 批并发、秒级返回；不再使用串行 + 65s 等待的旧策略。
3. 单批整体为空时等 2s 自动重查一次；重新登录不能重置配额（已移除该逻辑）。

## 结果解读

- `rows[]`：每条日志含 `time`（北京时间）、`table`（来源表）、`host`、`level`、
  `content`（日志内容）、`raw`（原始字段）。
- `total_count` / `returned_count`：返回条数。
- `truncated=true` 表示结果达到 limit 上限，可能还有更多：缩小时间窗或增大 `limit`。

## 常见场景示例

1. **按 traceId 全链路查日志**：先用 `list_targets` 找表，再 `table_name` + `keyword=<traceId>` 查询。
2. **按接口路径查**：`keyword="/base-device/v1/site/share/accept"`，`repos=["dolynk"]`。
3. **查某服务错误日志**：`keyword=<关键词>`，`level="error"`，时间窗按报障时间取。
4. **查 busilink 日志**：`repos=["busilink"]`。
5. **空关键字**：`keyword=""` 表示按时间窗取最近日志（浏览）。
6. **查 fk 环境日志**：加 `env=fk`（Python：`YunjiGatewayClient(environment_id="fk")`）。
   fk 与 test-sg 是**两套网关**，声明 fk 时若不加 `env=fk` 会查不到（默认走 test-sg 网关）。
7. **查 dev / test-sg 环境日志**：不用加参数（默认即 test-sg 网关），必要时显式写 `env=test-sg`。

## 错误处理

| 现象 | 原因与处理 |
| --- | --- |
| `登录响应缺少 token` | 凭据不对，检查 `YUNJI_USERNAME` / `YUNJI_PASSWORD` |
| `网络错误` | 无法访问网关；本机需走代理（默认已设），确认 `YUNJI_PROXY` |
| 返回结果为空 | **先确认环境是否选对**（声明 fk 却用默认网关会全空 → 需 `env=fk`）；其次 >23h 窗口可能被网关频控（脚本会等 65s 自动重试一次；仍为空可把窗口切到 ≤23h 并发复查），或时间窗内确实无日志；先用 `list_targets` 确认表存在 |
| `end_time is in the future` | 传了未来时间，换算成绝对北京时间 |
| `invalid time` | 时间格式不对，用 `"YYYY-MM-DD HH:MM:SS"` 或 ISO8601 |
