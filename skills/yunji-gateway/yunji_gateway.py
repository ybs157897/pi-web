# -*- coding: utf-8 -*-
"""云迹（yunji）网关直连客户端 —— 独立 Python 实现（仅标准库，无第三方依赖）。

直接访问云迹日志平台的 gRPC-web + protobuf 网关（不再依赖任何部署的 Java 服务）：

    1. login        —— 明文 JSON 登录，返回 JWT
    2. list_targets —— 从 ListApp 拉取 product → service → table 目录
    3. search_logs  —— 从 SearchAppLogs 按关键字 + 时间窗检索业务日志

协议要点（从抓包逆向）：
- 传输：gRPC-web，请求体 = [1B flag][4B big-endian len][protobuf 消息]
- 登录：POST /api/auth/login，JSON {"username","password"} → {"token": JWT}
- 认证：后续调用带 Authorization: Bearer <token>
- 时间：一律北京时间；SearchAppLogs 的时间范围用 RFC3339 UTC 传输
- 限流：仅大时间窗（>24h）有全局频控（返回空，非报错）；≤23h 窗口无频控，走并发扫描

用法（Python import）：
    from yunji_gateway import YunjiGatewayClient
    client = YunjiGatewayClient()                 # 默认 test-sg 网关（dev / test-sg）
    client = YunjiGatewayClient(environment_id="fk")   # fk 环境 → fk 网关
    targets = client.list_targets()
    result = client.search_logs(keyword="<traceId>", start_time="2026-07-29 00:00:00",
                                end_time="2026-08-29 12:18:00", repos=["dolynk"])

用法（命令行）：
    python yunji_gateway.py list_targets [environment_id=test-sg]
    python yunji_gateway.py list_targets env=fk
    python yunji_gateway.py search_logs keyword=xxx start_time=... end_time=... repos='["dolynk"]'
    python yunji_gateway.py search_to_file keyword=xxx env=fk repos='["dolynk"]'
"""

from concurrent.futures import ThreadPoolExecutor, as_completed

import json as _json
import os
import re
import struct
import sys
import threading
import time as _time
import urllib.error
import urllib.parse
import urllib.request

# ===========================================================================
# 配置（可通过环境变量覆盖）
# ===========================================================================

# 云迹网关基地址（默认环境 test-sg 的网关；统一 HTTPS + 443，不再带 8128 端口）
DEFAULT_BASE_URL = "https://yunji-test-sg.dolynkcloud.com"
DEFAULT_USERNAME = "yunji"
DEFAULT_PASSWORD = "nRcGrQ4NX466kQjztjZb"
# 本机访问云迹网关需走代理；服务器直连时置空
DEFAULT_PROXY = "http://10.30.88.12:9090"
DEFAULT_ENVIRONMENT_ID = "test-sg"
DEFAULT_TIMEOUT = 30

# 环境 → 网关基地址 预设：
#   - dev / test-sg 都走 test-sg 网关（日常开发、联调默认环境）
#   - fk（test-fk）走独立的 fk 网关
ENV_GATEWAYS = {
    "test-sg": "https://yunji-test-sg.dolynkcloud.com",
    "fk": "https://yunji-test-fk.dolynkcloud.com",
}

# 环境别名归一化：sg/dev/test/testsg → test-sg；fk/test-fk/testfk → fk
ENV_ALIASES = {
    "sg": "test-sg", "test-sg": "test-sg", "testsg": "test-sg", "test_sg": "test-sg",
    "dev": "test-sg", "develop": "test-sg", "test": "test-sg",
    "fk": "fk", "test-fk": "fk", "testfk": "fk", "test_fk": "fk",
}


def normalize_env(name):
    """把环境名/别名归一化为预设键（`fk` / `test-sg`）。

    fk 系列（fk / test-fk / testfk）→ "fk"；dev / sg / test 系列 → "test-sg"。
    未知环境原样返回（小写去空格），由 base_url_for_env 决定是否回退默认。
    """
    if not name:
        return DEFAULT_ENVIRONMENT_ID
    key = str(name).strip().lower()
    return ENV_ALIASES.get(key, key)


def base_url_for_env(name):
    """按环境名取网关基地址；未收录的环境返回 None（调用方回退默认 test-sg）。"""
    return ENV_GATEWAYS.get(normalize_env(name))

# 北京时间偏移（UTC+8）
BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000


def _env(key, default):
    return os.environ.get(key, default)


# ===========================================================================
# 异常体系
# ===========================================================================

class YunjiError(Exception):
    """云迹网关错误基类。"""


class YunjiApiError(YunjiError):
    """网关返回的错误。"""

    def __init__(self, code, message, url=""):
        self.code = code
        self.message = message
        self.url = url
        super().__init__(
            "云迹网关错误 [%s]: %s%s" % (code, message, " (url %s)" % url if url else "")
        )


# ===========================================================================
# protobuf 编解码（纯标准库，够本项目用的消息结构）
# ===========================================================================

def _write_varint(out, value):
    """写入无符号 varint。"""
    v = value
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            break


def _read_varint(data, pos):
    """读取无符号 varint，返回 (值, 新pos)。"""
    result = 0
    shift = 0
    while True:
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


class ProtoBuilder:
    """构建 protobuf 消息。字段写入按 tag 追加。"""

    def __init__(self):
        self._buf = bytearray()

    def _tag(self, field, wire):
        _write_varint(self._buf, (field << 3) | wire)

    def write_string(self, field, value):
        data = value.encode("utf-8")
        self._tag(field, 2)
        _write_varint(self._buf, len(data))
        self._buf += data

    def write_bytes(self, field, data):
        self._tag(field, 2)
        _write_varint(self._buf, len(data))
        self._buf += data

    def write_message(self, field, message_bytes):
        self.write_bytes(field, message_bytes)

    def write_varint(self, field, value):
        self._tag(field, 0)
        _write_varint(self._buf, value)

    def build(self):
        return bytes(self._buf)


def _build_time_range(start=None, end=None, relative=None):
    """TimeRange {1:start,2:end,3:relative}。"""
    b = ProtoBuilder()
    if start:
        b.write_string(1, start)
    if end:
        b.write_string(2, end)
    if relative:
        b.write_string(3, relative)
    return b.build()


def _build_query(trace_id=None, filter_str=None):
    """Query {1:trace_id,2:filter}。"""
    b = ProtoBuilder()
    if trace_id:
        b.write_string(1, trace_id)
    if filter_str:
        b.write_string(2, filter_str)
    return b.build()


def _build_sort(field, order=1):
    """Sort {1:field,2:order}。"""
    b = ProtoBuilder()
    b.write_varint(1, field)
    b.write_varint(2, order)
    return b.build()


def build_search_request(table_name, start_rfc, end_rfc, trace_id, filter_str,
                         page, page_size, is_histogram=False):
    """构建 SearchAppLogs / GetAppLogHistogram 请求消息。

    Args:
        table_name: 表名（不带 database 前缀，如 dolynk_dolynk_gateway_log）
        start_rfc / end_rfc: RFC3339 UTC 时间串（可为 None）
        trace_id: Query.f1（traceId 检索用）
        filter_str: Query.f2（关键字/过滤表达；traceId 检索时传 "match_any"）
        page / page_size: 页码 / 每页大小（直方图不需要）
        is_histogram: True 时不携带分页字段
    """
    b = ProtoBuilder()
    b.write_string(1, table_name)
    if start_rfc or end_rfc:
        b.write_message(2, _build_time_range(start=start_rfc, end=end_rfc))
    if trace_id or filter_str:
        b.write_message(3, _build_query(trace_id=trace_id, filter_str=filter_str))
    if not is_histogram:
        b.write_varint(5, page)
        b.write_varint(6, page_size)
    b.write_message(7, _build_sort(1))
    b.write_message(7, _build_sort(2))
    return b.build()


# ===========================================================================
# gRPC-web 帧封装
# ===========================================================================

def grpc_web_request(message_bytes):
    """把 protobuf 消息封装为 gRPC-web 数据帧（flag=0 + 4B big-endian len）。"""
    n = len(message_bytes)
    return bytes([0x00]) + n.to_bytes(4, "big") + message_bytes


def grpc_web_unwrap(body):
    """解析 gRPC-web 响应：拼接数据帧，忽略 trailer 帧；grpc-status!=0 抛错。

    Returns:
        拼接后的 protobuf 消息字节。
    """
    data = bytearray()
    pos = 0
    status = 0
    while pos + 5 <= len(body):
        flag = body[pos]
        length = int.from_bytes(body[pos + 1:pos + 5], "big")
        start = pos + 5
        if start + length > len(body):
            raise YunjiError("gRPC-web 帧长度越界")
        message = body[start:start + length]
        if flag & 0x80:
            status = _parse_grpc_status(message)
        else:
            data += message
        pos = start + length
    if status != 0:
        raise YunjiApiError(status, "grpc-status=%s" % status)
    return bytes(data)


def _parse_grpc_status(trailer):
    text = trailer.decode("utf-8", "replace")
    m = re.search(r"grpc-status:\s*(\d+)", text)
    return int(m.group(1)) if m else 0


# ===========================================================================
# 响应解析
# ===========================================================================

class _Reader:
    """读取 protobuf 消息，按 tag 遍历。"""

    def __init__(self, data):
        self.data = data
        self.pos = 0

    def next_field(self):
        """返回 (field, wire) 或 None（结束）。"""
        if self.pos >= len(self.data):
            return None
        tag, self.pos = _read_varint(self.data, self.pos)
        return tag >> 3, tag & 7

    def read_string(self):
        length, self.pos = _read_varint(self.data, self.pos)
        raw = self.data[self.pos:self.pos + length]
        self.pos += length
        return raw.decode("utf-8", "replace")

    def read_bytes(self):
        length, self.pos = _read_varint(self.data, self.pos)
        raw = self.data[self.pos:self.pos + length]
        self.pos += length
        return raw

    def read_varint(self):
        value, self.pos = _read_varint(self.data, self.pos)
        return value

    def skip(self, wire):
        if wire == 0:
            self.read_varint()
        elif wire == 1:
            self.pos += 8
        elif wire == 2:
            self.read_bytes()
        elif wire == 5:
            self.pos += 4
        else:
            raise YunjiError("不支持的 protobuf wire type: %s" % wire)


def parse_list_app(data):
    """解析 ListApp 响应 → [Product{product_code, product_name, services:[{service_code, service_name, table_name}]}]"""
    products = []
    r = _Reader(data)
    while True:
        f = r.next_field()
        if f is None:
            break
        field, wire = f
        if field == 1 and wire == 2:
            products.append(_parse_product(r.read_bytes()))
        else:
            r.skip(wire)
    return products


def _parse_product(raw):
    product = {"product_code": "", "product_name": "", "services": []}
    r = _Reader(raw)
    while True:
        f = r.next_field()
        if f is None:
            break
        field, wire = f
        if field == 1 and wire == 2:
            product["product_code"] = r.read_string()
        elif field == 2 and wire == 2:
            product["product_name"] = r.read_string()
        elif field == 3 and wire == 2:
            svc = _parse_service(r.read_bytes())
            if svc:
                product["services"].append(svc)
        else:
            r.skip(wire)
    return product


def _parse_service(raw):
    svc = {"service_code": "", "service_name": "", "table_name": ""}
    r = _Reader(raw)
    while True:
        f = r.next_field()
        if f is None:
            break
        field, wire = f
        if field == 1 and wire == 2:
            svc["service_code"] = r.read_string()
        elif field == 2 and wire == 2:
            svc["service_name"] = r.read_string()
        elif field == 3 and wire == 2:
            svc["table_name"] = r.read_string()
        else:
            r.skip(wire)
    return svc


def parse_log_response(data, is_histogram=False):
    """解析 SearchAppLogs 或 GetAppLogHistogram 响应。

    Returns:
        {"entries":[log_entry...], "page":int, "page_size":int}  或
        {"total_count":int, "buckets":[(time_str, count),...]}
    """
    if is_histogram:
        total_count = 0
        buckets = []
        r = _Reader(data)
        while True:
            f = r.next_field()
            if f is None:
                break
            field, wire = f
            if field == 1 and wire == 0:
                total_count = r.read_varint()
            elif field == 2 and wire == 2:
                b = _parse_bucket(r.read_bytes())
                if b:
                    buckets.append(b)
            else:
                r.skip(wire)
        return {"total_count": total_count, "buckets": buckets}

    entries = []
    page = 0
    page_size = 0
    r = _Reader(data)
    while True:
        f = r.next_field()
        if f is None:
            break
        field, wire = f
        if field == 1 and wire == 2:
            entries.append(_parse_log_entry(r.read_bytes()))
        elif field == 4 and wire == 0:
            page_size = r.read_varint()
        elif field == 5 and wire == 0:
            page = r.read_varint()
        else:
            r.skip(wire)
    return {"entries": entries, "page": page, "page_size": page_size}


def _parse_log_entry(raw):
    e = {"seconds": 0, "nanos": 0, "micros": 0, "host": "", "service_code": "",
         "product_code": "", "region": "", "log_file_path": "", "content": "", "level": 0}
    r = _Reader(raw)
    while True:
        f = r.next_field()
        if f is None:
            break
        field, wire = f
        if field == 1 and wire == 2:
            _parse_timestamp(r.read_bytes(), e)
        elif field == 2 and wire == 0:
            e["micros"] = r.read_varint()
        elif field == 3 and wire == 2:
            e["host"] = r.read_string()
        elif field == 4 and wire == 2:
            e["service_code"] = r.read_string()
        elif field == 5 and wire == 2:
            e["product_code"] = r.read_string()
        elif field == 6 and wire == 2:
            e["region"] = r.read_string()
        elif field == 7 and wire == 2:
            e["log_file_path"] = r.read_string()
        elif field == 8 and wire == 2:
            e["content"] = r.read_string()
        elif field == 9 and wire == 0:
            e["level"] = r.read_varint()
        else:
            r.skip(wire)
    return e


def _parse_timestamp(raw, entry):
    r = _Reader(raw)
    while True:
        f = r.next_field()
        if f is None:
            break
        field, wire = f
        if field == 1 and wire == 0:
            entry["seconds"] = r.read_varint()
        elif field == 2 and wire == 0:
            entry["nanos"] = r.read_varint()
        else:
            r.skip(wire)


def _parse_bucket(raw):
    time_str = ""
    count = 0
    r = _Reader(raw)
    while True:
        f = r.next_field()
        if f is None:
            break
        field, wire = f
        if field == 1 and wire == 2:
            time_str = r.read_string()
        elif field == 2 and wire == 0:
            count = r.read_varint()
        else:
            r.skip(wire)
    return (time_str, count)


# ===========================================================================
# 时间工具（北京时间 ↔ RFC3339 UTC）
# ===========================================================================

def parse_time(s):
    """解析时间字符串为 epoch 毫秒（按北京时间，兼容 ISO8601/RFC3339）。"""
    if s is None or s == "":
        return None
    text = str(s).strip()
    m = re.match(
        r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$",
        text,
    )
    if not m:
        raise ValueError('invalid time "%s": expected "YYYY-MM-DD HH:MM:SS" (Asia/Shanghai) or ISO8601' % text)
    import datetime
    wall = datetime.datetime(
        int(m.group(1)), int(m.group(2)), int(m.group(3)),
        int(m.group(4)), int(m.group(5)), int(m.group(6) or 0),
        tzinfo=datetime.timezone.utc,
    )
    wall_ms = int(wall.timestamp() * 1000)
    tz = m.group(7)
    if not tz:
        return wall_ms - BEIJING_OFFSET_MS  # 无时区 = 北京时间
    if tz == "Z":
        return wall_ms
    sign = -1 if tz[0] == "-" else 1
    digits = tz[1:].replace(":", "")
    off_ms = sign * (int(digits[0:2]) * 3600 + int(digits[2:4])) * 1000
    return wall_ms - off_ms


def _beijing_wall(ms):
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000 + BEIJING_OFFSET_MS / 1000, datetime.timezone.utc)


def _format_beijing(dt):
    return "%04d-%02d-%02d %02d:%02d:%02d" % (
        dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)


def _resolve_window(start_raw, end_raw):
    """解析时间窗为北京时区起止字符串（用于返回展示）。

    默认窗口 = 今天（北京时间 0 点）至今，保证落在当天内、可并发扫表；
    start 缺省 = 今天 0 点；end 缺省 = 现在。
    """
    now_ms = int(_time.time() * 1000)
    end = parse_time(end_raw)
    future_clipped = False
    if end is None:
        end = now_ms
    elif end > now_ms + 2 * 60 * 1000:
        # 未来时间不报错：自动截断到当前时刻（常见误传，如 end=当天 23:59:59）
        end = now_ms
        future_clipped = True
    start = parse_time(start_raw)
    if start is None:
        start = int(_beijing_wall(now_ms).replace(
            hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000) - BEIJING_OFFSET_MS
    if start > end:
        raise ValueError("start_time is after end_time")
    return {
        "start": _format_beijing(_beijing_wall(start)),
        "end": _format_beijing(_beijing_wall(end)),
        "future_clipped": future_clipped,
    }


def _to_rfc3339_utc(beijing_str):
    """把北京时区 'YYYY-MM-DD HH:MM:SS' 转成 RFC3339 UTC（SearchAppLogs 需要）。"""
    ms = parse_time(beijing_str)  # 按北京解析 → epoch ms
    if ms is None:
        return None
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch_to_beijing(seconds, nanos=0):
    """把 epoch 秒/纳秒格式化为北京时区 'YYYY-MM-DD HH:MM:SS'。"""
    import datetime
    dt = datetime.datetime.fromtimestamp(
        seconds + nanos / 1e9 + BEIJING_OFFSET_MS / 1000, datetime.timezone.utc)
    return _format_beijing(dt)


# ===========================================================================
# HTTP 客户端（带代理，仅标准库）
# ===========================================================================

class _Http:
    def __init__(self, base_url, proxy=None, timeout=DEFAULT_TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self.proxy = proxy or None
        self.timeout = timeout

    def _opener(self):
        handlers = []
        if self.proxy:
            proxy_handler = urllib.request.ProxyHandler({
                "http": self.proxy,
                "https": self.proxy,
            })
            handlers.append(proxy_handler)
        return urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()

    def post_json(self, path, body):
        url = self.base_url + path
        data = _json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        raw = self._request(req, url)
        try:
            return _json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            raise YunjiError("非 JSON 响应: %s" % raw[:300])

    def post_grpc(self, path, body_bytes, token=None):
        url = self.base_url + path
        headers = {
            "content-type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            "grpc-accept-encoding": "gzip",
            "Accept": "application/grpc-web+proto",
        }
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(url, data=body_bytes, method="POST", headers=headers)
        return self._request(req, url)

    def _request(self, req, url):
        try:
            with self._opener().open(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read()
            raise YunjiApiError(e.code, "HTTP %s: %s" % (e.code, raw[:300]), url)
        except urllib.error.URLError as e:
            raise YunjiError("网络错误: %s (url %s)" % (e.reason, url))


# ===========================================================================
# 云迹网关客户端
# ===========================================================================

# 登录锁：并发扫描时多个线程可能同时发现 token 为空
_LOGIN_LOCK = threading.Lock()

# 32hex 判定缓存锁：切批并行时各批共享 trace_mode 缓存
_TRACE_MODE_LOCK = threading.Lock()

# ListApp 目录缓存锁（只护缓存字段，不包 gRPC 调用，避免与 _LOGIN_LOCK 重入死锁）
_APPS_CACHE_LOCK = threading.Lock()


class YunjiGatewayClient:
    """云迹网关直连客户端。

    Args:
        base_url: 网关基地址；显式传入时优先于环境预设
        username / password: 登录凭据
        proxy: HTTP 代理（本机走代理，服务器直连留空）
        environment_id: 环境名，决定网关基地址（`fk` → fk 网关；其余 → test-sg 网关），
            默认取环境变量 YUNJI_ENV，再默认 test-sg
        timeout: 超时秒数
    """

    def __init__(self, base_url=None, username=None, password=None, proxy=None,
                 environment_id=None, timeout=DEFAULT_TIMEOUT, max_workers=8):
        env_raw = _env("YUNJI_ENV", environment_id or DEFAULT_ENVIRONMENT_ID)
        self.environment_id = normalize_env(env_raw)
        # 基地址优先级：YUNJI_BASE_URL > 显式 base_url 入参 > 环境预设 > 默认 test-sg
        self.base_url = (_env("YUNJI_BASE_URL", None) or base_url
                         or base_url_for_env(self.environment_id) or DEFAULT_BASE_URL)
        self.username = _env("YUNJI_USERNAME", username or DEFAULT_USERNAME)
        self.password = _env("YUNJI_PASSWORD", password or DEFAULT_PASSWORD)
        self.proxy = _env("YUNJI_PROXY", proxy if proxy is not None else DEFAULT_PROXY)
        self.max_workers = max(1, int(max_workers))
        self._http = _Http(self.base_url, self.proxy, timeout)
        self._token = None
        self._token_expires_at = 0
        self._apps_cache = None
        self._apps_cache_until = 0

    # ---------- 登录 ----------

    def login(self):
        """登录并缓存 JWT token（并发安全）。"""
        with _LOGIN_LOCK:
            data = self._http.post_json("/api/auth/login",
                                        {"username": self.username, "password": self.password})
            try:
                token = data["token"]
            except Exception:
                raise YunjiApiError("LOGIN_FAILED", "登录响应缺少 token: %s" % (str(data)[:200]))
            self._token = token
            self._token_expires_at = _extract_jwt_expiry(token)
            return token

    def _ensure_token(self):
        with _LOGIN_LOCK:
            now_ms = int(_time.time() * 1000)
            if self._token and now_ms + 60_000 < self._token_expires_at:
                return self._token
        return self.login()

    def _reset_token(self, reason):
        self._token = None

    # ---------- gRPC 调用 ----------

    def _call_grpc(self, path, message_bytes):
        token = self._ensure_token()
        body = grpc_web_request(message_bytes)
        raw = self._http.post_grpc(path, body, token=token)
        try:
            return grpc_web_unwrap(raw)
        except YunjiApiError as e:
            # 401 → token 失效，重登一次
            if e.code == 401:
                self._reset_token("401")
                token = self._ensure_token()
                raw = self._http.post_grpc(path, body, token=token)
                return grpc_web_unwrap(raw)
            raise

    # ---------- ListApp / 目录 ----------

    def list_apps(self, use_cache=True):
        """从 ListApp 拉取完整目录（product → service → table）。

        结果缓存 5 分钟（目录极少变化）：一次检索里切批并行、链路传播、
        表集合解析多处调用，避免重复 gRPC 拉取。
        注意：缓存锁只保护缓存读写，gRPC 调用在锁外执行（不可重入 _LOGIN_LOCK）。
        """
        with _APPS_CACHE_LOCK:
            if use_cache and self._apps_cache and _time.time() < self._apps_cache_until:
                return self._apps_cache
        data = self._call_grpc("/AppLogService/ListApp", b"")
        products = parse_list_app(data)
        with _APPS_CACHE_LOCK:
            self._apps_cache = products
            self._apps_cache_until = _time.time() + 300
        return products

    def list_targets(self, environment_id=None):
        """列出可查询的 repo（product）与日志表清单，对齐 skill 的 list_targets 接口。"""
        env = environment_id or self.environment_id
        products = self.list_apps()
        repos = []
        for p in products:
            tables = [s["table_name"] for s in p.get("services", []) if s.get("table_name")]
            repos.append({
                "repo_id": p.get("product_code"),
                "repo_name": p.get("product_name") or p.get("product_code"),
                "product_code": p.get("product_code"),
                "product_name": p.get("product_name") or "",
                "table_count": len(tables),
                "tables": tables,
            })
        return {
            "tool": "yunji_gateway_list_targets",
            "base_url": self.base_url,
            "environment_id": env,
            "repos": repos,
            "total_table_count": sum(r["table_count"] for r in repos),
            "note": "单次搜索建议用 table_name/service_code 收敛，避免跨全仓（可能超时或触发网关限流）",
        }

    # ---------- SearchAppLogs / 检索 ----------

    def search_logs(self, keyword="", start_time=None, end_time=None, repos=None,
                    table_name=None, service_code=None, product_code=None,
                    level="all", sort="desc", page_size=100, limit=500,
                    environment_id=None, retry=True):
        """按关键字 + 时间窗检索云迹日志。

        Args:
            keyword: traceId / messageId / 日志签名 / 接口路径；空串=按时间窗取最近日志
            start_time / end_time: 北京时间 "YYYY-MM-DD HH:MM:SS" 或 ISO8601；
                默认最近 23h（当天内，多表并发扫描）
            repos: product_code 列表，如 ["dolynk"]；用于从 ListApp 解析表集合（≤23h 窗口用）
            table_name: 精确到单表，如 dolynk_dolynk_gateway_log；
                **历史查询（>23h 或起点在今天之前）必须指定 table_name 或 service_code**
            service_code / product_code: 收敛过滤
            level: all/error/warn/info/debug
            sort: desc/asc
            page_size: 每页大小，默认 100
            limit: 最多返回条数，默认 500
            environment_id: 环境 ID（仅用于展示）
            retry: 整体为空时重试一次（>23h 窗口先等 65s 让分钟配额恢复），默认 True

        Returns:
            dict: {tool, keyword, time_range, total_count, returned_count, rows, ...}
        """
        win = _resolve_window(start_time, end_time)
        clipped_note = ("end_time 晚于当前时间，已自动截断到 now；" if win.pop("future_clipped", False) else "")
        keyword = keyword or ""
        limit = max(1, min(int(limit or 500), 1000))
        page_size = max(1, min(int(page_size or 100), 200))

        rows = self._do_search(keyword, win, repos=repos, table_name=table_name,
                               service_code=service_code, product_code=product_code,
                               page_size=page_size, limit=limit, retry=retry)

        rows = rows[:limit]
        total_count = len(rows)
        return {
            "tool": "yunji_gateway_search_logs",
            "environment_id": environment_id or self.environment_id,
            "keyword": keyword,
            "repos": repos,
            "table_name": table_name,
            "time_range": win,
            "total_count": total_count,
            "returned_count": len(rows),
            "truncated": total_count >= limit,
            "rows": rows,
            "note": clipped_note + "时间均为北京时间；默认查今天0点至今（多表并发）；>23h 窗口自动按 23h 切批并行；traceId/接口路径检索走链路分析",
        }

    def _do_search(self, keyword, win, repos=None, table_name=None, service_code=None,
                   product_code=None, page_size=100, limit=500, retry=True):
        """执行检索，返回格式化后的 rows 列表。

        查询策略（实测）：
        - 网关对 ≤23h 窗口查询无频控，多表并发扫描（默认 8 线程）
        - >23h 窗口（日志只保留 3 天）：切成 ≤23h 的批次并行查询，
          批与批并发、批内表并发
        - 空结果重试只在「单批查询」生效；多批时各批并行、不逐批 sleep
        - 32 位 hex 的字段/正文判定（探测）结果按窗口全局共享，切批不重复探测
        """
        batches = _split_window(win)
        multi_batch = len(batches) > 1
        trace_mode = {"state": "unknown"}  # 跨批共享的 32hex 判定结果

        def run_batch(batch):
            return self._search_batch(batch, keyword, repos, table_name,
                                      service_code, product_code, page_size, limit,
                                      retry=retry and not multi_batch,  # 多批不逐批重试
                                      trace_mode=trace_mode)

        if multi_batch:
            with ThreadPoolExecutor(max_workers=min(len(batches), self.max_workers)) as ex:
                futs = {ex.submit(run_batch, b): i for i, b in enumerate(batches)}
                tmp = [None] * len(batches)
                for fut in as_completed(futs):
                    tmp[futs[fut]] = fut.result()
            results = list(enumerate(tmp))
        else:
            results = [(0, run_batch(batches[0]))]

        # 按批次顺序合并（时间正序），多批时不去重（窗口不重叠）
        merged = []
        for _, rows in results:
            merged.extend(rows)
        return merged

    def _search_batch(self, batch, keyword, repos, table_name, service_code,
                      product_code, page_size, limit, retry=True, trace_mode=None):
        """查询单个 ≤23h 批次，返回 rows。

        traceId/关键字检索时走链路分析模式：
          1. 32 位 hex 先做字段/正文判定（trace_mode 缓存跨批共享，只探测一次）
          2. 先查 gateway 表（请求日志里有目标服务的 URL）
          3. 从 gateway 日志的 path 推理目标服务 → 查该服务的表
          4. 再从服务日志中识别下游调用（A 调 B）→ 查 B 的表
          若已显式指定 table_name/service_code 则直接查，不做链路分析。
        """
        win = {"start": batch[0], "end": batch[1]}
        explicit = bool(table_name or service_code)
        if explicit or not _is_trace_query(keyword):
            tables = self._resolve_tables(repos=repos, table_name=table_name,
                                          service_code=service_code,
                                          product_code=product_code)
            if not tables:
                return []
            rows = self._search_pass(tables, keyword, win, page_size, limit,
                                     trace_mode=trace_mode)
            if not rows and retry:
                _time.sleep(2)
                rows = self._search_pass(tables, keyword, win, page_size, limit,
                                         trace_mode=trace_mode)
            return rows
        return self._trace_chain_search(keyword, win, repos, product_code,
                                        page_size, limit, retry,
                                        trace_mode=trace_mode)

    # ---------- traceId 链路分析检索 ----------

    def _trace_chain_search(self, keyword, win, repos, product_code,
                            page_size, limit, retry=True, trace_mode=None):
        """gateway 优先的链路分析检索（traceId / 接口路径 / 32位hex）。

        32 位 hex：字段判定（跨批缓存）→ 全表字段扫描一轮即完成
        （trace_id 索引已覆盖 traceId 与网关收录的 messageId），无需链路传播。
        接口路径 / 其他：gateway 表 → path 推理服务表 → 下游服务传播（≤2 跳）。
        每张表只查一次，全部走 ≤23h 批次（无频控）。
        """
        all_tables = self._resolve_tables(repos=repos, product_code=product_code)
        queried = set()
        merged = []

        def query_once(tables):
            fresh = [t for t in tables if t not in queried]
            if not fresh:
                return []
            queried.update(fresh)
            rows = self._search_pass(fresh, keyword, win, page_size, limit,
                                     trace_mode=trace_mode)
            merged.extend(rows)
            return rows

        if _looks_like_trace_id(keyword):
            # trace_id 索引覆盖全表，一轮字段扫描即可（gateway 链路传播无增量）。
            # 字段模式是服务端索引查询、无漏样，空结果即真不存在，不重试；
            # body 模式（客户端后过滤受首页条数限制）才值得重试一轮。
            rows = query_once(all_tables)
            is_body_mode = (trace_mode or {}).get("state") == "body"
            if not rows and retry and is_body_mode:
                _time.sleep(2)
                queried.clear()
                query_once(all_tables)
            return merged[:limit] if limit else merged

        # 接口路径 / 链路传播模式
        gateway_tables = [t for t in all_tables if "gateway" in t.lower()]
        gw_rows = query_once(gateway_tables)

        # gateway 日志 path/服务名 → 目标服务表
        services = set()
        for r in gw_rows:
            services.update(_extract_service_hints(r.get("content", "")))
        svc_tables = _match_service_tables(self.list_apps(), services)
        query_once(svc_tables)

        # 已有日志内容 → 识别下游服务 URL（A 调 B），查 B
        for _ in range(2):  # 最多传播 2 跳，防止发散
            downstream = set()
            for r in list(merged):
                downstream.update(_extract_downstream_services(r.get("content", "")))
            down_tables = _match_service_tables(self.list_apps(), downstream)
            before = len(merged)
            query_once(down_tables)
            if len(merged) == before:  # 无新增 → 提前结束
                break

        if not merged and retry:
            _time.sleep(2)
            return self._trace_chain_search(keyword, win, repos, product_code,
                                            page_size, limit, retry=False,
                                            trace_mode=trace_mode)
        return merged[:limit] if limit else merged

    def search_to_file(self, keyword="", start_time=None, end_time=None, repos=None,
                       table_name=None, service_code=None, product_code=None,
                       level="all", limit=5000, out_dir=None, retry=True,
                       environment_id=None):
        """按关键字检索日志，并把所有匹配日志写入临时目录文件。

        Args:
            keyword: traceId / messageId / 接口路径 / 日志签名
            start_time / end_time: 北京时间 "YYYY-MM-DD HH:MM:SS" 或 ISO8601；
                默认最近 23h（当天内，多表并发扫描）
            repos / product_code: 范围收敛（≤23h 窗口用）
            table_name / service_code: 收敛到单表/单服务；
                **历史查询（>23h 或起点在今天之前）必须指定其一**
            level: 级别过滤
            limit: 最多写入条数，默认 5000，最大 20000
            out_dir: 输出目录；默认系统临时目录下的 yunji_logs/
            retry: 整体为空时重试一次（>23h 窗口先等 65s 让分钟配额恢复）

        Returns:
            dict: {tool, file_path, count, keyword, time_range, ...}
                  file_path 为绝对路径，AI 可直接读取该文件。
        """
        win = _resolve_window(start_time, end_time)
        clipped_note = ("end_time 晚于当前时间，已自动截断到 now；" if win.pop("future_clipped", False) else "")
        keyword = keyword or ""
        limit = max(1, min(int(limit or 5000), 20000))
        page_size = 200

        rows = self._do_search(keyword, win, repos=repos, table_name=table_name,
                               service_code=service_code, product_code=product_code,
                               page_size=page_size, limit=limit, retry=retry)

        file_path = self._write_logs_file(keyword, win, rows, limit, out_dir)
        return {
            "tool": "yunji_gateway_search_to_file",
            "environment_id": environment_id or self.environment_id,
            "keyword": keyword,
            "repos": repos,
            "table_name": table_name,
            "time_range": win,
            "file_path": file_path,
            "count": len(rows),
            "note": clipped_note + "日志已写入 file_path，可直接读取该文件；时间均为北京时间",
        }

    def _write_logs_file(self, keyword, win, rows, limit, out_dir=None):
        """把日志行写入临时目录文件，返回绝对路径。"""
        import tempfile
        base_dir = out_dir or os.path.join(tempfile.gettempdir(), "yunji_logs")
        os.makedirs(base_dir, exist_ok=True)
        safe_kw = re.sub(r"[^\w\-\.]", "_", keyword)[:60] or "all"
        ts = _time.strftime("%Y%m%d_%H%M%S")
        file_path = os.path.join(base_dir, "%s_%s.log" % (safe_kw, ts))

        with open(file_path, "w", encoding="utf-8") as f:
            f.write("# yunji gateway log dump\n")
            f.write("# keyword: %s\n" % keyword)
            f.write("# time_range: %s ~ %s\n" % (win["start"], win["end"]))
            f.write("# count: %d\n" % len(rows))
            f.write("# 列: 时间(北京) | 表 | 级别 | 主机 | 内容\n")
            f.write("#" + "-" * 100 + "\n")
            for r in rows:
                content = (r.get("content") or "").replace("\n", "\\n").replace("\r", "\\r")
                f.write("%s | %s | %s | %s | %s\n" % (
                    r.get("time", ""),
                    r.get("table", ""),
                    r.get("level", ""),
                    r.get("host", ""),
                    content,
                ))
        return file_path

    def _search_pass(self, tables, keyword, win, page_size, limit, trace_mode=None):
        """遍历所有表收集结果，直到达 limit。

        时间窗 ≤23h（默认）：并发扫描（网关无频控，实测一分钟 65 次多表查询无限制）。
        时间窗 >23h（历史查询）：切批后每批 ≤23h 到此，并发查询。

        网关实测（2026-09-08）：Query.filter 字段**不参与服务端过滤**（乱串 filter
        与无过滤返回完全相同），唯一有效的是 Query.trace_id 字段（且附带命中正文
        索引里的 messageId 等）。因此：
        - traceId 形态关键字 → trace_id 字段 + match_any；
        - 其他关键字 → 无过滤拉取首页 + **客户端按 content 包含后过滤**
          （受首页条数限制，覆盖不全，结果 note 中已说明）。
        trace_mode：跨批共享的 32hex 判定缓存 {"state": unknown/field/body}，
        批间并发时由锁保护，第一个批完成判定后其余批直接复用。
        """
        rows = []
        start_rfc = _to_rfc3339_utc(win["start"])
        end_rfc = _to_rfc3339_utc(win["end"])
        trace_id = keyword if _looks_like_trace_id(keyword) else None
        client_filter = None
        if trace_id:
            if trace_mode and trace_mode.get("state") == "body":
                trace_id, filter_str = None, keyword  # 已判定：正文标识
            elif trace_mode and trace_mode.get("state") == "field":
                filter_str = "match_any"  # 已判定：字段模式
            else:
                trace_id, filter_str = self._resolve_trace_mode(
                    tables, trace_id, start_rfc, end_rfc, page_size,
                    trace_mode=trace_mode)
            if trace_id is None:
                client_filter = filter_str  # 正文标识 → 客户端后过滤
        else:
            filter_str = keyword or None
            if filter_str:
                client_filter = filter_str
                filter_str = None  # 服务端 filter 无效，改为客户端过滤

        def query_table(table):
            entries = []
            max_pages = 5  # body 模式最多翻 5 页/表（热表大窗漏样兜底，上限防爆）
            for page in range(1, max_pages + 1):
                msg = build_search_request(table, start_rfc, end_rfc, trace_id, filter_str,
                                           page, page_size, is_histogram=False)
                data = self._call_grpc("/AppLogService/SearchAppLogs", msg)
                parsed = parse_log_response(data, is_histogram=False)
                batch_entries = parsed.get("entries") or []
                if client_filter:
                    batch_entries = [e for e in batch_entries
                                     if client_filter in (e.get("content") or "")]
                entries.extend(batch_entries)
                # 字段模式（精确）或本页已翻空 → 停止翻页
                if not client_filter or len(batch_entries) < page_size or not batch_entries:
                    break
            return [(table, e) for e in entries]

        if len(tables) > 1 and _window_hours(win) <= 23:
            pairs = []
            with ThreadPoolExecutor(max_workers=self.max_workers) as ex:
                futures = [ex.submit(query_table, t) for t in tables]
                for fut in as_completed(futures):
                    try:
                        pairs.extend(fut.result())
                    except Exception:
                        continue
                    if len(pairs) >= limit:
                        break
            if len(pairs) > limit:
                pairs = pairs[:limit]
        else:
            pairs = []
            for table in tables:
                try:
                    pairs.extend(query_table(table))
                except Exception:
                    continue
                if len(pairs) >= limit:
                    break

        for table, e in pairs:
            rows.append({
                "time": _epoch_to_beijing(e.get("seconds", 0), e.get("nanos", 0)),
                "table": table,
                "host": e.get("host", ""),
                "level": _level_label(e.get("level", 0)),
                "content": e.get("content", ""),
                "raw": e,
            })
        return rows

    def _resolve_trace_mode(self, tables, trace_id, start_rfc, end_rfc, page_size,
                            trace_mode=None):
        """32 位 hex 的双路判定：trace_id 字段 vs 正文标识（messageId/设备ID）。

        逐表探测（最多 3 张，跳过无数据的表）：
        1. 按 trace_id 字段查 → 命中即真 traceId；
        2. 字段为 0 时无过滤拉首页，本地验证正文是否包含该串
          （服务端 filter 无效）→ 正文确有则判定为正文标识，走客户端后过滤；
        3. 探测表无数据（无法区分）→ 换下一张表；全部无法判定 → 保守走字段模式。
        trace_mode 缓存跨批共享（加锁），判定一次后其余批次直接复用。
        """
        # 跨批缓存：另一批已判定 → 直接复用
        if trace_mode is not None:
            with _TRACE_MODE_LOCK:
                state = trace_mode.get("state")
            if state == "field":
                return trace_id, "match_any"
            if state == "body":
                return None, trace_id

        result = (trace_id, "match_any")
        probe_tables = (list(tables) or ["dolynk_dolynk_gateway_log"])[:3]
        for probe in probe_tables:
            msg = build_search_request(probe, start_rfc, end_rfc, trace_id, "match_any",
                                       1, page_size, is_histogram=False)
            try:
                data = self._call_grpc("/AppLogService/SearchAppLogs", msg)
                n_trace = len(parse_log_response(data).get("entries") or [])
            except Exception:
                continue
            if n_trace > 0:
                result = (trace_id, "match_any")  # 字段模式
                break

            # 字段为 0：无过滤拉首页，本地验证正文
            msg = build_search_request(probe, start_rfc, end_rfc, None, None,
                                       1, page_size, is_histogram=False)
            try:
                data = self._call_grpc("/AppLogService/SearchAppLogs", msg)
                entries = parse_log_response(data).get("entries") or []
            except Exception:
                continue
            if not entries:
                continue  # 探测表该窗口无数据，换一张表
            if any(trace_id in (e.get("content") or "") for e in entries):
                result = (None, trace_id)  # 正文标识 → 客户端后过滤
                break

        if trace_mode is not None:
            with _TRACE_MODE_LOCK:
                trace_mode["state"] = "field" if result[0] is not None else "body"
        return result

    def _resolve_tables(self, repos=None, table_name=None, service_code=None, product_code=None):
        """从 ListApp 目录解析出要查询的表集合。"""
        if table_name:
            return [table_name]
        products = self.list_apps()
        want_codes = set(repos or [])
        tables = []
        for p in products:
            code = p.get("product_code")
            if product_code and code != product_code:
                continue
            if want_codes and code not in want_codes:
                continue
            for s in p.get("services", []):
                if service_code and s.get("service_code") != service_code:
                    continue
                if s.get("table_name"):
                    tables.append(s["table_name"])
        return tables


def _is_trace_query(keyword):
    """traceId（32位hex）或含接口路径的检索走链路分析模式。"""
    if not keyword:
        return False
    kw = keyword.strip()
    if _looks_like_trace_id(kw):
        return True
    return kw.startswith("/") and len(kw) > 3  # 接口路径，如 /base-device/v1/...


_GATEWAY_PATH_RE = re.compile(
    r"(?:path[=:\s]+|Request:.*?\s|POST\s+|GET\s+)(/[a-z0-9\-]+/v\d+/[^\s\"']+)",
    re.IGNORECASE)
_FEIGN_URL_RE = re.compile(
    r"(?:request:|request url:|before req middle.*?uri:)\s*(?:POST|GET|PUT|DELETE)?\s*"
    r"https?://[^\s\"']+")


def _extract_service_hints(content):
    """从 gateway 日志内容提取服务提示（uri 第一段 / xxx-yyy）。"""
    hints = set()
    for m in _GATEWAY_PATH_RE.finditer(content or ""):
        first = m.group(1).strip("/").split("/")[0]
        if first and first.lower() not in ("v1", "v2", "v3"):
            hints.add(first)
    return hints


def _extract_downstream_services(content):
    """从服务日志内容识别下游调用（Feign/HTTP URL 的 host 段或 uri 段）。

    如 `POST http://10.23.1.251:9091/mp-organ-facade/v1/site/share/remove` → mp-organ-facade
    """
    down = set()
    for m in re.finditer(r"https?://[^\s\"']+", content or ""):
        rest = m.group(0).split("://", 1)[1]
        path = rest.split("/", 1)
        if len(path) == 2 and path[1]:
            first = path[1].split("/")[0]
            if first and re.match(r"^[a-z][a-z0-9\-]{3,}$", first, re.IGNORECASE) \
                    and first.lower() not in ("v1", "v2", "v3"):
                down.add(first.lower())
    return down


def _match_service_tables(products, service_hints):
    """把服务提示（如 dolynk-base-device / mp-organ-facade）匹配到日志表名。

    匹配规则：服务提示（去连字符）是表名去 _log 后缀部分的子串。
    """
    if not service_hints:
        return []
    tables = []
    seen = set()
    for p in products:
        for s in p.get("services", []):
            t = s.get("table_name") or ""
            if not t or t in seen:
                continue
            stem = t[:-4] if t.endswith("_log") else t  # 去掉 _log 后缀
            for h in service_hints:
                if h.lower().replace("-", "_") in stem.lower():
                    tables.append(t)
                    seen.add(t)
                    break
    return tables


def _split_window(win, max_hours=23.0):
    """把时间窗切成若干 ≤max_hours 的批次（北京时间字符串），批次间不重叠、无缝隙。

    用于 >23h 窗口（日志只保留 3 天）：每批独立查询，≤23h 的批次不受网关频控。
    Returns:
        [(start_str, end_str), ...] 按时间正序
    """
    start_ms = parse_time(win["start"])
    end_ms = parse_time(win["end"])
    if start_ms is None or end_ms is None or start_ms >= end_ms:
        return [(win["start"], win["end"])]
    span_ms = end_ms - start_ms
    if span_ms <= max_hours * 3600 * 1000:
        return [(win["start"], win["end"])]
    batches = []
    cursor = start_ms
    while cursor < end_ms:
        nxt = min(cursor + int(max_hours * 3600 * 1000), end_ms)
        batches.append((_format_beijing(_beijing_wall(cursor)),
                        _format_beijing(_beijing_wall(nxt))))
        cursor = nxt
    return batches


def _needs_service(win):
    """历史查询判定：跨度 >23h，或起点在今天（北京时间）0 点之前 → 需指定服务。"""
    hours = _window_hours(win)
    if hours > 23:
        return True
    try:
        start = _beijing_wall(parse_time(win["start"]))
        today0 = _beijing_wall(int(_time.time() * 1000)).replace(
            hour=0, minute=0, second=0, microsecond=0)
        return start < today0
    except Exception:
        return False


def _window_hours(win):
    """时间窗跨度（小时，向上取整）——用于选择并发/串行与重试策略。"""
    try:
        ms = parse_time(win["end"]) - parse_time(win["start"])
        return ms / 3600000.0
    except Exception:
        return 0.0


def _looks_like_trace_id(value):
    """32 位十六进制即视为 traceId。"""
    if not value:
        return False
    return bool(re.fullmatch(r"[0-9a-fA-F]{32}", value.strip()))


def _level_label(level):
    return {0: "error", 1: "info", 2: "warn", 3: "debug"}.get(level, str(level))


def _extract_jwt_expiry(jwt):
    """从 JWT payload 解析 exp，失败用默认 900s。"""
    try:
        parts = jwt.split(".")
        if len(parts) < 2:
            return int(_time.time() * 1000) + 900_000
        # base64url decode
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        import base64
        payload = _json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = payload.get("exp")
        if exp:
            return int(exp) * 1000
    except Exception:
        pass
    return int(_time.time() * 1000) + 900_000


# ===========================================================================
# 命令行入口
# ===========================================================================

def _main():
    args = sys.argv[1:]
    if "--help" in args or not args:
        print("云迹网关直连客户端（gRPC-web + protobuf，纯标准库）")
        print("CLI 用法：python yunji_gateway.py <方法名> [key=value ...]")
        print("可用方法：list_targets, search_logs, search_to_file")
        print("环境切换：env=fk 查 fk 网关；env=test-sg / env=dev（缺省）查 test-sg 网关")
        return 0

    method = args[0]
    kwargs = {}
    for kv in args[1:]:
        if "=" not in kv:
            continue
        key, _, value = kv.partition("=")
        try:
            kwargs[key] = _json.loads(value)
        except (_json.JSONDecodeError, ValueError):
            kwargs[key] = value

    # 环境选择：env=fk / environment_id=fk 均可（fk 走独立网关）；
    # 缺省时由客户端回退 YUNJI_ENV → test-sg。
    env = kwargs.pop("env", None)
    if env is None:
        env = kwargs.get("environment_id")
    client = YunjiGatewayClient(environment_id=env)
    func = getattr(client, method, None)
    if func is None:
        print("错误: 未知方法 %s" % method)
        return 1

    try:
        result = func(**kwargs)
    except (YunjiApiError, YunjiError) as e:
        print("错误: %s" % e)
        return 1
    except (TypeError, ValueError) as e:
        print("参数错误: %s" % e)
        return 1

    print(_json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(_main())
