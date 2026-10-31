# 云迹网关协议参考（gRPC-web + protobuf）

本文件记录云迹日志平台网关的传输协议与 protobuf 消息结构（从抓包逆向），供 `yunji_gateway.py`
实现参考，也便于后续排查问题。

## 1. 传输方式

- 端点：`POST /AppLogService/<Method>`，请求体为 **gRPC-web 帧**。
- 帧格式：`[1 byte flag][4 byte big-endian length][protobuf message]`
  - 请求：单数据帧 flag=0x00
  - 响应：数据帧 flag=0x00，随后 trailer 帧 flag=0x80（含 `grpc-status: 0`）
- 请求头：
  - `content-type: application/grpc-web+proto`
  - `x-grpc-web: 1`
  - `grpc-accept-encoding: gzip`
  - `Authorization: Bearer <token>`（登录后）
- 登录：`POST /api/auth/login`，JSON `{"username":"...","password":"..."}`（明文）
  → 响应 `{"token":"<JWT>","username":"..."}`

## 2. protobuf 消息结构

### ListApp（目录）
请求为空消息。响应：
```
ListAppResponse {
  repeated Product products = 1;
}
Product {
  string product_code = 1;
  string product_name = 2;
  repeated Service services = 3;
}
Service {
  string service_code = 1;
  string service_name = 2;
  string table_name = 3;   // 如 dolynk_dolynk_gateway_log（不带 database 前缀）
}
```

### SearchAppLogs（日志搜索）
请求：
```
SearchRequest {
  string table_name = 1;
  TimeRange time_range = 2;
  Query query = 3;
  int32 page = 5;
  int32 page_size = 6;
  repeated Sort sorts = 7;
}
TimeRange { string start = 1; string end = 2; string relative = 3; }  // RFC3339 UTC 或 "24h"
Query { string trace_id = 1; string filter = 2; }                     // trace_id 检索: trace_id=traceId, filter="match_any"
Sort { int32 field = 1; int32 order = 2; }
```
响应：
```
SearchResponse {
  repeated LogMessage entries = 1;
  int32 page_size = 4;
  int32 page = 5;
}
LogMessage {
  Timestamp ts = 1;        // google.protobuf.Timestamp {1:seconds, 2:nanos}
  int64 micros = 2;
  string host = 3;
  string service_code = 4;
  string product_code = 5;
  string region = 6;
  string log_file_path = 7;
  string content = 8;
  int32 level = 9;         // 0=error 1=info 2=warn 3=debug
}
```

### GetAppLogHistogram（统计直方图）
请求同 SearchRequest（不携带分页字段）。响应：
```
HistogramResponse {
  int64 total_count = 1;
  repeated Bucket buckets = 2;
}
Bucket { string time = 1; int64 count = 2; }  // time 如 "2026-08-28 11:00:00.000000"
```

## 3. 限流行为（实测 2026-09，重要）

- 频控按**查询时间窗大小**全局计量，与表名、IP、traceId 无关；配额**跨表共享**，
  按**分钟窗**重置（实测约 60-65s 恢复）。
- 被限时**返回空结果**（HTTP 200 + 空数据帧，响应 <0.3s），而非报错。
- 实测配额：
  - ≤24h 窗口：**无频控**（一分钟 65 次多表并发查询全部成功）。
  - 25h ~ 3 天窗口：全局约 **5 次/分钟**（15 张表同窗并发只有前 5 张返回数据）。
  - ~7 天窗口：全局约 **1 次/分钟**。
- 重新登录**不能**重置配额；单表场景把 start 前移 1 分钟可绕过，但多表下无效（配额是全局的）。
- 客户端策略：**把查询窗口切成 ≤23h 的批次并行查询**（日志只保留 3 天，切批必然覆盖全窗口）；
  批内多表并发（默认 8 线程）。traceId 检索先查 gateway 表再按 URL 链路传播到服务表。

## 4. 时间契约

- 外部接口一律**北京时间**（`YYYY-MM-DD HH:MM:SS` 无时区 = 北京时间，+08:00）
- SearchAppLogs 的时间范围用 **RFC3339 UTC** 传输（`YYYY-MM-DDTHH:MM:SSZ`）
- 直连脚本内部把北京时区转成 RFC3339 UTC

## 5. 与旧服务的差异

- 旧部署服务 `http://10.56.36.109:19002` 是 JSON HTTP API（带 catalog 缓存），表名曾带
  `cloud_track_loganalysis.` 前缀。本脚本直连云迹网关，表名**不带前缀**，直接用 ListApp 返回的表名。
- 直连不再依赖任何中间 Java 服务，无 catalog 缓存表名过时问题。
