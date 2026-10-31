# -*- coding: utf-8 -*-
"""WeTrack 缺陷管理包装脚本 — 供 AI Agent 一条命令完成多步操作。

将「环境检查 -> 查询 -> 元数据获取 -> 枚举校验 -> dry-run -> 提交 -> 验证」
串成单条命令，内部自动处理 JSON 解析、元数据缓存、枚举匹配和 approver 推断。

临时文件统一放 %TEMP%/wetrack/，按问题单号分目录（<单号>/images、<单号>/detail.json 等），
列表类命令（pending / query）的结果统一写入唯一的 _list/list.json（时间倒序、最新在上、
含 simpleDesc），项目元数据缓存进 _meta/。

用法示例:
  python wetrack.py pending                          # 待办列表（同时写入 _list/list.json）
  python wetrack.py detail DTS006636033              # 缺陷详情
  python wetrack.py detail DTS006636033 --json --out # 详情 JSON 落盘（终端只回确认行）
  python wetrack.py flow-options DTS006636033        # 当前环节可执行流转
  python wetrack.py submit DTS006636033 5001         # 交互式收集参数并提交
  python wetrack.py submit DTS006636033 5001 --yes --modify-content "..." ...
"""
import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

IS_WIN = os.name == "nt"
PY_105 = "105"   # 开发工程师问题修改
PY_106 = "106"   # 开发工程师转测自验

# submit 提交类流转的条件必填参数（按 step 区分），驳回类仅需 --comment
REQUIRED_BY_STEP = {
    PY_105: ["modify-content", "modify-type-name", "modify-version-name",
             "one-level-category-name", "two-level-cause-name",
             "two-level-module-name", "three-level-cause"],
    PY_106: ["self-test-describe", "self-test-ver-name"],
}
REJECT_NEXT_STEPS = {"5003", "5004", "5005", "5006", "6003"}
# 提交到「待自验」的流转编码（step=105 → nextStep=5001）；埋点在此流转成功后触发
SELF_TEST_NEXT_STEP = "5001"

# ---------------------------------------------------------------- 临时目录规划
# %TEMP%/wetrack/                        工具临时根目录
# ├── <问题单号>/                         每个问题单一个目录，存放它的临时文件
# │   ├── images/                        描述内嵌截图（N.jpg）
# │   ├── attachments/                   工单附件原件（按原始文件名）
# │   ├── detail.json / detail.txt       命令输出（--out 落盘）
# │   └── flow-options.json / .txt
# ├── _list/                             列表类查询（pending / query）的统一落盘目录
# │   └── list.json                      唯一列表文件（时间倒序、最新在上、含 simpleDesc）
# └── _meta/                             项目元数据缓存 + meta 命令输出
WT_ROOT = os.path.join(tempfile.gettempdir(), "wetrack")
META_CACHE = os.path.join(WT_ROOT, "_meta")
LIST_FILE = os.path.join(WT_ROOT, "_list", "list.json")
LEGACY_IMAGE_DIR = os.path.join(tempfile.gettempdir(), "wetrack-images")      # 旧版目录，兼容清理
LEGACY_META_DIR = os.path.join(tempfile.gettempdir(), "wetrack-meta-cache")  # 旧版目录，兼容清理


def _defect_dir(defect_number):
    """问题单维度的临时目录（按单号分类）。"""
    return os.path.join(WT_ROOT, str(defect_number))


def _images_dir(defect_number):
    return os.path.join(_defect_dir(defect_number), "images")


def _attachments_dir(defect_number):
    return os.path.join(_defect_dir(defect_number), "attachments")


def _out_path(defect_number, name, json_mode):
    """--out 的规划落盘路径（单号维度命令）：<单号>/<name>.json|txt。
    列表类命令（pending/query）不走这里，统一写 _list/list.json（见 _write_list_file）。"""
    ext = "json" if json_mode else "txt"
    return os.path.join(_defect_dir(defect_number), "{}.{}".format(name, ext))


def _ellipsis(s, n):
    """按显示宽度截断，超长加省略号（区分"截断"与"数据损坏"）。"""
    s = s or ""
    return s if len(s) <= n else s[:n - 1] + "…"


# ---------------------------------------------------------------- 列表统一落盘
# 约定：pending / query 的列表结果统一写入唯一文件 _list/list.json
#（按时间倒序、最新在上、每条必含 simpleDesc；--full 时保留原始完整字段）

_LIST_FIELD_ORDER = ("defectNumber", "defectStep", "defectStatusName", "severityName",
                     "projectNumber", "projectName", "simpleDesc", "submitTime", "updateTime")


def _dts_seq(s):
    """从单号提取数字序列（DTS006642870 → 6642870），用于无时间字段时的排序。"""
    m = re.search(r"(\d+)\s*$", str(s or ""))
    return int(m.group(1)) if m else 0


def _item_time(it):
    """条目的时间值（用于倒序）：query 条目有 submitTime/updateTime；pending 无时间返回空串。"""
    for k in ("submitTime", "updateTime", "createTime"):
        v = it.get(k)
        if v:
            return str(v)
    return ""


def _sort_newest_first(items):
    """统一排序：最新在最上。有时间按时间倒序；无时间（pending）按单号数字倒序（编号递增≈时间递增）。"""
    return sorted(items,
                  key=lambda it: (_item_time(it), _dts_seq(it.get("defectNumber"))),
                  reverse=True)


def _slim_item(it):
    """列表条目的精简形态：关键字段在前、simpleDesc 必有、去空字段、去 description（单条详情的范畴）。"""
    rec = {}
    for k in _LIST_FIELD_ORDER:
        v = it.get(k)
        if v not in (None, "", [], {}):
            rec[k] = v
    rec.setdefault("simpleDesc", "")
    for k, v in it.items():
        if k in rec or k == "description" or v in (None, "", [], {}):
            continue
        rec[k] = v
    return rec


def _list_payload(items, source, full=False):
    """列表统一数据结构：source + generatedAt + count + items（每条形如 _slim_item）。"""
    payload_items = items if full else [_slim_item(it) for it in items]
    return {
        "source": source,
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(payload_items),
        "items": payload_items,
    }


def _write_list_file(payload, dest=None):
    """把列表写入唯一临时文件（默认 _list/list.json）。返回 (绝对路径, 条数)。"""
    target = dest or LIST_FILE
    try:
        os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
    except OSError as e:
        sys.exit("[wetrack] 列表文件写入失败: {} ({})".format(target, e))
    # 清理旧版分散的列表文件，保证 _list 目录下只有这一个
    if not dest:
        for name in ("pending.json", "pending.txt", "query.json", "query.txt", "list.txt"):
            p = os.path.join(os.path.dirname(LIST_FILE), name)
            if os.path.isfile(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
    return os.path.abspath(target), payload["count"]


def _list_write(args, items, source):
    """列表统一处理：排序（最新在上）→ 构造 payload → 落盘唯一文件。
    返回 (排序后原始条目, payload, 文件路径, 条数)。"""
    items = _sort_newest_first(items)
    payload = _list_payload(items, source, full=getattr(args, "full", False))
    path, count = _write_list_file(payload, dest=getattr(args, "out_file", None))
    return items, payload, path, count


def _to_file(args):
    """当前输出是否写文件（--out / --out-file）。"""
    return bool(getattr(args, "out_file", None) or getattr(args, "out", False))


def _emit_output(args, text, out_path):
    """输出统一出口：默认打印到终端；指定 --out / --out-file 时写入文件并只回确认行。

    约定：终端显示可以是摘要（表格截断、JSON 瘦身），但写文件的内容必须是
    完整明细——传入的 text 在写文件场景下由调用方构建为完整版。
    """
    out_file = getattr(args, "out_file", None)
    if out_file or getattr(args, "out", False):
        path = out_file or out_path
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(text if text.endswith("\n") else text + "\n")
        except OSError as e:
            sys.exit("[wetrack] 写入输出文件失败: {} ({})".format(path, e))
        print("[wetrack] 输出已写入: {}（{} 字符）".format(os.path.abspath(path), len(text)))
        return
    print(text)

# ---------------------------------------------------------------- 埋点上报配置
# 「提交到待自验」（nextStep=5001）实际提交成功后异步上报一条行为事件；
# best-effort，失败静默丢弃，绝不影响主命令。参考 D:\2026\dolynk\tools\agent_event_report.py 移植。
EVENT_BASE_URL = os.environ.get("EVENTHUB_BASE_URL", "https://yfaieventhub.dahuatech.com")
EVENT_USERNAME = os.environ.get("AGENT_REPORT_USERNAME", "agentreport")
EVENT_PASSWORD = os.environ.get("AGENT_REPORT_PASSWORD", "F4!jN7q#S2v%P9r6")
EVENT_TIMEOUT = 10
EVENT_AGENT_NAME = "公有云-Bug 修复智能体"


def _event_token_file():
    """token 缓存文件：默认与脚本同目录，可用 AGENT_EVENT_TOKEN_FILE 覆盖。"""
    env = os.environ.get("AGENT_EVENT_TOKEN_FILE")
    if env:
        return env
    base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, ".agent_event_token.json")


def _event_debug(msg):
    if os.environ.get("WETRACK_EVENT_DEBUG"):
        sys.stderr.write("[event] " + msg + "\n")


def _event_http_post(url, headers=None, body=None):
    """POST JSON，返回 (status, 解析后的 dict 或文本)。仅在埋点链路内使用。"""
    import urllib.error
    import urllib.request
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=EVENT_TIMEOUT) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        status = e.code
    except Exception as e:  # 网络异常等一律视为失败
        return 0, "网络错误: %s" % e
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def _event_login():
    """Basic auth 登录换 token；失败返回 None。"""
    import base64
    url = EVENT_BASE_URL.rstrip("/") + "/uac/login/token"
    cred = base64.b64encode(("%s:%s" % (EVENT_USERNAME, EVENT_PASSWORD)).encode("utf-8")).decode("ascii")
    status, resp = _event_http_post(url, headers={"Authorization": "Basic " + cred})
    result = resp.get("result") if isinstance(resp, dict) else None
    if status == 200 and isinstance(resp, dict) and resp.get("code") == 200 and result:
        return {"access_token": result["access_token"],
                "refresh_token": result["refresh_token"],
                "expires_in": result.get("expires_in")}
    _event_debug("登录失败: %s %s" % (status, resp))
    return None


def _event_refresh(cached):
    """用缓存 refresh_token 续期；失败降级重新登录。"""
    if not cached:
        return _event_login()
    url = EVENT_BASE_URL.rstrip("/") + "/uac/login/token/refresh"
    status, resp = _event_http_post(url, body={"refreshToken": cached["refresh_token"]})
    result = resp.get("result") if isinstance(resp, dict) else None
    if status == 200 and isinstance(resp, dict) and resp.get("code") == 200 and result:
        return {"access_token": result["access_token"],
                "refresh_token": result["refresh_token"],
                "expires_in": result.get("expires_in")}
    _event_debug("续期失败(%s)，重新登录" % status)
    return _event_login()


def _event_user_info():
    """当前 rd-cli 登录用户（工号/姓名/部门），取不到返回 {}。"""
    code, out = run_rdcli(["auth", "status"])
    data = parse_json(out)
    try:
        if code == 0 and data and data.get("success"):
            user = (data.get("data") or {}).get("user") or {}
            return {"loginId": user.get("loginId"), "userName": user.get("userName"),
                    "deptName": user.get("deptName")}
    except Exception:
        pass
    return {}


def _event_report_sync(dts_no):
    """同步执行一次上报（子进程内调用）。全链路异常吞掉，绝不抛出。"""
    try:
        token_file = _event_token_file()
        cached = None
        try:
            with open(token_file, encoding="utf-8") as f:
                c = json.load(f)
            if c.get("access_token") and c.get("refresh_token"):
                cached = c
        except (OSError, ValueError):
            pass

        token = _event_refresh(cached)
        if not token:
            _event_debug("无可用 token，放弃上报")
            return
        try:
            os.makedirs(os.path.dirname(token_file), exist_ok=True)
            with open(token_file, "w", encoding="utf-8") as f:
                json.dump(token, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

        import time as _time
        user = _event_user_info()
        event = {
            "agentId": "公有云-Bug 修复智能体",
            "agentName": EVENT_AGENT_NAME,
            "eventType": "wetrack",
            "action": "fix",
            "targetId": dts_no,
            "started": int(_time.time() * 1000),
            "data": {"defectNumber": dts_no},
        }
        for k, v in user.items():
            if v:
                event[k] = v

        url = EVENT_BASE_URL.rstrip("/") + "/api/events/agentEvent"
        for attempt in (1, 2):
            status, resp = _event_http_post(url, headers={"Authorization": "Bearer " + token["access_token"]}, body=event)
            if status == 401:
                token = _event_login()
                if not token:
                    return
                continue
            if 500 <= status < 600:
                _event_debug("上报 5xx（第 %s 次）" % attempt)
                continue
            _event_debug("上报结果: status=%s resp=%s" % (status, resp))
            return
    except Exception as e:
        _event_debug("上报异常（已丢弃）: %s" % e)


def fire_event_async(dts_no):
    """异步触发一次埋点上报：spawn 一个后台子进程执行，主命令立即返回。
    任何异常都不影响主流程（埋点 best-effort）。

    窗口行为说明（实测）：Windows 上只可用 CREATE_NO_WINDOW——python.exe 是
    控制台程序，不加此标志会闪出一个黑窗口。
    """
    if os.environ.get("WETRACK_EVENT_DISABLED"):
        return
    try:
        cmd = [sys.executable, os.path.abspath(__file__), "__report-event", dts_no]
        kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
                  "stdin": subprocess.DEVNULL, "close_fds": True}
        if IS_WIN:
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW（避免闪黑窗）
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(cmd, **kwargs)
    except Exception as e:
        _event_debug("子进程启动失败（已忽略）: %s" % e)


# ---------------------------------------------------------------- rd-cli 封装

def run_rdcli(args, json_mode=True):
    """执行 rd-cli 命令，返回 (returncode, stdout)。始终带 --json。"""
    cmd = ["rd-cli"]
    if json_mode:
        cmd.append("--json")
    cmd.extend(args)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=120)
    except FileNotFoundError:
        sys.exit("[wetrack] rd-cli 未安装或不在 PATH 中，请先运行: rd-cli version 检查")
    except subprocess.TimeoutExpired:
        sys.exit("[wetrack] rd-cli 命令超时（120s）: " + " ".join(args))
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def parse_json(out):
    """从输出中提取 JSON（跳过可能的非 JSON 前缀行）。"""
    start = out.find("{")
    if start < 0:
        return None
    try:
        return json.loads(out[start:])
    except json.JSONDecodeError:
        return None


def rdcli_json(args):
    """执行并解析 JSON，失败时退出。"""
    code, out = run_rdcli(args)
    data = parse_json(out)
    if code != 0 or not data or not data.get("success"):
        sys.exit("[wetrack] 命令失败: rd-cli {}\n{}".format(" ".join(args), out.strip()[:800]))
    return data.get("data")


# ---------------------------------------------------------------- 临时文件清理

RETENTION_DAYS = 7  # 临时文件保留 7 天


def cleanup_temp(max_age_days=RETENTION_DAYS, verbose=False):
    """清理过期临时文件：%TEMP%/wetrack/ 下按问题单号分目录的全部内容，
    外加两个旧版目录（wetrack-images / wetrack-meta-cache）做兼容清理。
    每次命令运行时自动调用（静默），也可通过 clean 子命令手动触发。"""
    cutoff = datetime.now().timestamp() - max_age_days * 86400
    removed = 0
    roots = [WT_ROOT, LEGACY_IMAGE_DIR, LEGACY_META_DIR]
    for root in roots:
        if not os.path.isdir(root):
            continue
        # 自底向上遍历：先清文件，再删空目录
        for dirpath, dirnames, filenames in os.walk(root, topdown=False):
            for name in filenames:
                p = os.path.join(dirpath, name)
                try:
                    if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                        os.remove(p)
                        removed += 1
                except OSError:
                    pass
            try:
                if os.path.isdir(dirpath) and not os.listdir(dirpath) and dirpath != root:
                    os.rmdir(dirpath)
            except OSError:
                pass
    if verbose:
        print("[wetrack] 已清理 {} 天前的临时文件 {} 个".format(max_age_days, removed))
    return removed


# ---------------------------------------------------------------- 环境检查

def check_env():
    """安装 + 认证双检查，不通过时退出并给出引导命令。"""
    if not shutil.which("rd-cli"):
        sys.exit("[wetrack] rd-cli 未安装。Windows: irm https://aimate.dahuatech.com/downloads/scripts/install.ps1 | iex")
    code, out = run_rdcli(["version"], json_mode=False)
    if code != 0:
        sys.exit("[wetrack] rd-cli 不可用: " + out.strip()[:300])
    code, out = run_rdcli(["auth", "status"], json_mode=False)
    if code != 0 or "已登录" not in out:
        sys.exit("[wetrack] 未登录。请执行: rd-cli auth login （浏览器 SSO）或 rd-cli auth login -u <域账号>\n" + out.strip()[:300])
    m = re.search(r"工号\s*(\d+)", out)
    return m.group(1) if m else None


def _quiet_cleanup():
    """随每次命令静默清理过期临时文件，失败不影响主流程。"""
    try:
        cleanup_temp()
    except Exception:
        pass


# ---------------------------------------------------------------- 查询类

def cmd_pending(args):
    check_env()
    data = rdcli_json(["wetrack", "pending"])
    items = (data or {}).get("items") or []
    # 列表统一落盘：唯一文件 _list/list.json（时间倒序、最新在上、含 simpleDesc）
    items, payload, path, count = _list_write(args, items, "pending")
    if getattr(args, "json_out", False):
        _emit_output(args, json.dumps(payload, ensure_ascii=False, indent=2), path)
        return
    if _to_file(args):
        print("[wetrack] 列表已写入: {}（{} 条，最新在上）".format(path, count))
        return
    if not items:
        print("待办为空")
        return
    lines = ["{:<15} {:<6} {:<10} {:<14} {}".format("编号", "环节", "严重程度", "状态", "简要描述")]
    for it in items:
        lines.append("{:<15} {:<6} {:<10} {:<14} {}".format(
            it.get("defectNumber", ""), it.get("defectStep", ""),
            it.get("severityName", ""), it.get("defectStatusName", ""),
            _ellipsis(it.get("simpleDesc") or "", 40)))
    print("\n".join(lines))
    print("\n[wetrack] 完整列表（{} 条，含 simpleDesc，最新在上）已写入: {}".format(count, path))


def _strip_html(html):
    """去掉缺陷描述中的 HTML 标签，保留纯文本，压缩多余空行。"""
    text = re.sub(r"<br\s*/?>|</p>", "\n", html or "", flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = (text.replace("&nbsp;", " ").replace("&lt;", "<")
            .replace("&gt;", ">").replace("&amp;", "&"))
    text = re.sub(r"\n[ \t\r]*(?=\n)", "", text)  # 去空白行
    text = re.sub(r"\n{3,}", "\n\n", text)        # 连续空行压缩
    return text.strip()


def _extract_images(html, defect_number):
    """从描述 HTML 中提取内嵌 base64 图片，落盘到 %TEMP%/wetrack/<单号>/images/。
    返回 (替换后的 HTML, [(路径, 字节数)])。http 图片 URL 保留在文本中。"""
    import base64
    img_dir = _images_dir(defect_number)
    saved = []

    def _save(m):
        b64 = m.group(2)
        try:
            raw = base64.b64decode(b64)
        except Exception:
            return m.group(0)
        os.makedirs(img_dir, exist_ok=True)
        ext = m.group(1).lower()  # jpeg/png/gif/bmp
        ext = "jpg" if ext == "jpeg" else ext
        path = os.path.join(img_dir, "{}.{}".format(len(saved) + 1, ext))
        # 同一缺陷重复查询时覆盖同名文件
        with open(path, "wb") as f:
            f.write(raw)
        saved.append((path, len(raw)))
        return "[图片{}已保存: {}]".format(len(saved), path)

    # <img src='data:image/jpeg;base64,...'> -> 落盘并替换为路径标注
    html = re.sub(
        r"<img[^>]*src=['\"]data:image/(\w+);base64,([A-Za-z0-9+/=]+)['\"][^>]*/?>",
        _save, html, flags=re.I)
    return html, saved


# 附件下载上限：单文件 200MB（超过则跳过并提示），整体超时 300 秒
ATTACH_MAX_BYTES = 200 * 1024 * 1024
ATTACH_TIMEOUT = 300


def _safe_filename(name):
    """清洗附件文件名：去掉路径分隔符和 Windows 非法字符，防止目录穿越。"""
    name = os.path.basename(str(name or "").replace("\\", "/"))
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name).strip(" .")
    return name or "attachment"


def _download_attachments(attachments, defect_number):
    """下载工单附件（downloadUrl 为限时签名链接）到 %TEMP%/wetrack/<单号>/attachments/。
    返回 (已下载 [(路径, 字节数, 原始名)], 失败 [(原始名, 原因)])。
    单个附件失败不影响其余，也不影响 detail 主流程。"""
    import urllib.request
    att_dir = _attachments_dir(defect_number)
    saved, failed, used = [], [], set()
    for a in attachments or []:
        if not isinstance(a, dict):
            continue
        url = a.get("downloadUrl")
        raw_name = a.get("fileName") or a.get("name") or "attachment"
        if not url:
            failed.append((raw_name, "无 downloadUrl"))
            continue
        try:
            declared = int(a.get("fileSize") or 0)
        except (TypeError, ValueError):
            declared = 0
        if declared > ATTACH_MAX_BYTES:
            failed.append((raw_name, "文件过大（{} MB），已跳过".format(declared // 1024 // 1024)))
            continue
        # 同名文件去重（同一单重复查询时覆盖，多个同名附件加序号）
        name = _safe_filename(raw_name)
        if name in used:
            stem, ext = os.path.splitext(name)
            name = "{}_{}{}".format(stem, len(used) + 1, ext)
        used.add(name)
        path = os.path.join(att_dir, name)
        try:
            os.makedirs(att_dir, exist_ok=True)
            req = urllib.request.Request(url, headers={"User-Agent": "wetrack-cli"})
            with urllib.request.urlopen(req, timeout=ATTACH_TIMEOUT) as resp:
                raw = resp.read()
            with open(path, "wb") as f:
                f.write(raw)
            saved.append((path, len(raw), raw_name))
        except Exception as e:
            failed.append((raw_name, str(e)[:120]))
            continue
    return saved, failed


def cmd_detail(args):
    check_env()
    data = rdcli_json(["wetrack", "detail", "--defect-number", args.defect_number])
    d = data or {}
    out_json = _out_path(args.defect_number, "detail", True)
    out_text = _out_path(args.defect_number, "detail", False)

    if args.json_out:
        if getattr(args, "full", False):
            # --full：原始完整 JSON（含 base64、downloadUrl），不做任何转存
            _emit_output(args, json.dumps(d, ensure_ascii=False, indent=2), out_json)
            return
        # 默认：base64 图片落盘、description 中替换为路径标注，并新增 images 字段
        d = dict(d)
        desc_html, saved_images = _extract_images(d.get("description") or "", args.defect_number)
        d["description"] = desc_html
        if saved_images:
            d["images"] = [p for p, _ in saved_images]
        # 工单附件：下载到 <单号>/attachments/，结果写入 attachmentFiles 字段
        saved_atts = []
        if d.get("attachments"):
            saved_atts, failed_atts = _download_attachments(d["attachments"], args.defect_number)
            d["attachmentFiles"] = (
                [{"fileName": n, "path": p, "size": s} for p, s, n in saved_atts] +
                [{"fileName": n, "error": r} for n, r in failed_atts])
        _emit_output(args, json.dumps(d, ensure_ascii=False, indent=2), out_json)
        _del_files_if_requested(args, saved_images, saved_atts)
        return

    lines = []

    def val(k):
        v = d.get(k)
        return v if v not in (None, "", []) else None

    def line(label, k, width=12):
        v = val(k)
        if v is not None:
            lines.append("{:<{w}}{}".format(label + ":", v, w=width))

    # --- 基本信息 ---
    lines.append("======== 基本信息========")
    line("缺陷编号", "defectNumber")
    line("缺陷状态", "defectStatusName")
    line("严重程度", "severityName")
    line("缺陷类型", "categoryName")
    line("测试类型", "testTypeName")
    line("复现概率", "probabilityName")
    line("测试领域", "fieldName")
    line("功能模块", "moduleName")
    lines.append("")

    # --- 项目与关联 ---
    lines.append("======== 项目与关联 ========")
    line("所属项目", "projectName")
    line("项目编号", "projectNumber")
    line("产品线", "projectLineName")
    line("问题版本", "issueVerName")
    line("需求编号", "wermId")
    line("测试任务", "testNumberName")
    line("关联用例", "useCaseNum")
    line("自动化用例", "automaticUseCaseNum")
    lines.append("")

    # --- 人员与时间 ---
    lines.append("======== 人员与时间 ========")
    line("创建人", "creatorName")
    line("创建时间", "createTime")
    line("提单时间", "submitTime")
    lines.append("")

    # --- 内容 ---
    lines.append("======== 简要描述 ========")
    lines.append(d.get("simpleDesc") or "(无)")
    desc_html, saved_images = _extract_images(d.get("description") or "", args.defect_number)
    desc = _strip_html(desc_html)
    if desc.strip():
        lines.append("")
        lines.append("======== 详细描述 ========")
        lines.append(desc)
    if saved_images:
        lines.append("")
        lines.append("======== 描述内嵌截图（已落盘，可直接打开查看） ========")
        for path, size in saved_images:
            lines.append("- {} ({} KB)".format(path, size // 1024))
    mc = d.get("modifyContent")
    if mc:
        lines.append("")
        lines.append("======== 修改内容 ========")
        lines.append(mc)
    tlc = d.get("threeLevelCause")
    if tlc:
        lines.append("")
        lines.append("======== 原因分析 ========")
        lines.append(tlc)
    # 其他未归类的非空字段（兼容接口新增字段，不遗漏）
    known = {"defectNumber", "defectStatusName", "severityName", "categoryName",
             "testTypeName", "probabilityName", "fieldName", "moduleName",
             "projectName", "projectNumber", "projectLineName", "issueVerName",
             "wermId", "testNumberName", "useCaseNum", "automaticUseCaseNum",
             "creatorName", "createTime", "submitTime", "simpleDesc",
             "description", "modifyContent", "threeLevelCause", "attachments"}
    extras = {k: v for k, v in d.items() if k not in known and v not in (None, "", [])}
    if extras:
        lines.append("")
        lines.append("======== 其他信息 ========")
        to_file = _to_file(args)
        for k, v in extras.items():
            # 终端显示截断到 200 字符；写文件保留完整值
            s = str(v) if to_file else str(v)[:200]
            lines.append("{}: {}".format(k, s))
    att = d.get("attachments")
    saved_atts = []
    if att:
        saved_atts, failed_atts = _download_attachments(att, args.defect_number)
        lines.append("")
        lines.append("======== 附件（已下载，可直接打开查看） ========")
        for path, size, name in saved_atts:
            lines.append("- {} ({} KB) -> {}".format(name, size // 1024, path))
        for name, reason in failed_atts:
            lines.append("- {} 下载失败: {}".format(name, reason))
    _emit_output(args, "\n".join(lines), out_text)
    _del_files_if_requested(args, saved_images, saved_atts)


def _del_files_if_requested(args, saved_images, saved_atts=()):
    """--del-images：输出完毕后立即删除本次落盘的截图与附件（读完即删）。"""
    if not getattr(args, "del_images", False):
        return
    removed = 0
    for path, _ in list(saved_images) + [(p, s) for p, s, _ in saved_atts]:
        try:
            os.remove(path)
            removed += 1
        except OSError:
            pass
    if removed:
        print("[wetrack] --del-images：本次落盘的 {} 个文件已读取输出完毕并删除（磁盘已无残留）".format(removed))


def cmd_flow_options(args):
    """查询当前环节可执行的流转操作 —— nextStep 的权威来源。"""
    check_env()
    data = rdcli_json(["wetrack", "defect-flow-options", "--defect-number", args.defect_number])
    items = (data or {}).get("items") or []
    if args.json_out:
        _emit_output(args, json.dumps(items, ensure_ascii=False, indent=2),
                     _out_path(args.defect_number, "flow-options", True))
        return
    lines = ["问题单 {} 当前可执行流转:".format(args.defect_number)]
    for it in items:
        lines.append("  nextStep={} [{}] {}".format(it.get("nextStep"), it.get("actionType"), it.get("description")))
    _emit_output(args, "\n".join(lines), _out_path(args.defect_number, "flow-options", False))


def cmd_query(args):
    """advanced-query 包装：按项目/责任人/状态等组合查询。

    列表结果统一写入唯一文件 _list/list.json（submitTime 倒序、最新在上、含
    simpleDesc）；终端表格只给摘要（截断）。--json 输出与文件同一表示
    （source/generatedAt/count/items），默认瘦身：去空字段、去 body 巨大的
    description（单条可达 4 万+字符，其中 90%+ 是 base64 图片），需要原始
    完整字段时加 --full。
    """
    check_env()
    q = ["wetrack", "advanced-query", "--page", str(args.page), "--rows", str(args.rows)]
    if args.project:
        q += ["--project-num", args.project]
    if args.owner:
        q += ["--cur-user-name", args.owner]
    if args.status:
        q += ["--defect-status", args.status]
    if args.defect:
        q += ["--defect-number", args.defect]
    data = rdcli_json(q)
    items = ((data or {}).get("items") or (data or {}).get("records")
             or (data or {}).get("list") or [])
    # 列表统一落盘：唯一文件 _list/list.json（时间倒序、最新在上、含 simpleDesc）
    items, payload, path, count = _list_write(args, items, "query")
    if getattr(args, "json_out", False):
        _emit_output(args, json.dumps(payload, ensure_ascii=False, indent=2), path)
        return
    if _to_file(args):
        print("[wetrack] 列表已写入: {}（{} 条，最新在上）".format(path, count))
        return
    if not items:
        print("查询结果为空")
        return
    lines = ["{:<15} {:<6} {:<10} {:<14} {}".format("编号", "环节", "严重程度", "状态", "简要描述")]
    for it in items:
        lines.append("{:<15} {:<6} {:<10} {:<14} {}".format(
            it.get("defectNumber", ""), it.get("defectStep", "") or it.get("step", ""),
            it.get("severityName", ""), it.get("defectStatusName", ""),
            _ellipsis(it.get("simpleDesc") or "", 40)))
    print("\n".join(lines))
    print("\n[wetrack] 完整列表（{} 条，含 simpleDesc，最新在上）已写入: {}".format(count, path))


# ---------------------------------------------------------------- 元数据

def get_meta(project_number, force=False):
    """获取项目元数据并缓存（metadata 数据量大，rd-cli 终端输出会被截断，
    故落盘临时文件再解析；缓存有效期 1 小时）。"""
    os.makedirs(META_CACHE, exist_ok=True)
    cache_file = os.path.join(META_CACHE, project_number.replace("/", "_") + ".json")
    if not force and os.path.exists(cache_file):
        age = datetime.now().timestamp() - os.path.getmtime(cache_file)
        if age < 3600:
            with open(cache_file, encoding="utf-8") as f:
                return json.load(f)
    tmp = cache_file + ".tmp"
    code, out = run_rdcli(["wetrack", "project-metadata", "--project-number", project_number])
    data = parse_json(out)
    if code != 0 or not data or not data.get("success"):
        sys.exit("[wetrack] project-metadata 获取失败: " + out.strip()[:500])
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data.get("data"), f, ensure_ascii=False)
    os.replace(tmp, cache_file)
    return data.get("data")


def safe_exist():
    # os.makedirs 用 exist_ok，这里仅为兼容旧调用签名保留
    return True


def _meta_enums(meta):
    """把 metadata 中各枚举归一化为 name 列表；二级模块额外构建「大类名 → 模块名列表」级联映射。

    注意 twoLevelModules 的真实结构是 dict（大类 id → 模块列表），不是 list；
    其余枚举（modifyTypes/modifyVersions/oneLevelCategories/twoLevelCauses/selfTestVersions）
    是 [{"id","name"}] 列表。
    """
    enums = {}
    for key in ("modifyTypes", "modifyVersions", "oneLevelCategories",
                "twoLevelCauses", "selfTestVersions"):
        enums[key] = [_name_of(x) for x in (meta.get(key) or [])]

    # twoLevelModules: 兼容 dict（大类id -> [{id,name}]）与 list 两种结构
    two_level = meta.get("twoLevelModules") or {}
    modules, cascade = [], {}
    if isinstance(two_level, dict):
        cat_name = {str(x.get("id")): _name_of(x)
                    for x in (meta.get("oneLevelCategories") or []) if isinstance(x, dict)}
        for cid, lst in two_level.items():
            names = [_name_of(x) for x in (lst or [])]
            modules.extend(names)
            cname = cat_name.get(str(cid))
            if cname:
                cascade[cname] = names
    else:  # list 结构（防御性兼容）
        modules = [_name_of(x) for x in two_level]
    enums["twoLevelModules"] = modules
    enums["twoLevelModulesByCategory"] = cascade
    return enums


def _name_of(x):
    if isinstance(x, str):
        return x
    for k in ("name", "typeName", "versionName", "categoryName", "moduleName",
              "causeName", "twoLevelModuleName", "oneLevelCategoryName"):
        if isinstance(x, dict) and x.get(k):
            return x[k]
    return json.dumps(x, ensure_ascii=False) if x is not None else ""


def fuzzy_match(value, candidates):
    """枚举精确匹配：先精确，后唯一包含匹配。返回匹配值或 None。"""
    if value in candidates:
        return value
    hits = [c for c in candidates if value and (value in c or c in value)]
    return hits[0] if len(hits) == 1 else None


def cmd_meta(args):
    check_env()
    meta = get_meta(args.project_number, force=args.refresh)
    enums = _meta_enums(meta)
    out_json = os.path.join(META_CACHE, args.project_number.replace("/", "_") + "-enums.json")
    out_text = os.path.join(META_CACHE, args.project_number.replace("/", "_") + "-enums.txt")
    if args.json_out:
        _emit_output(args, json.dumps(enums, ensure_ascii=False, indent=2), out_json)
        return
    lines = []
    for key in ("modifyTypes", "modifyVersions", "oneLevelCategories",
                "twoLevelCauses", "selfTestVersions"):
        names = enums.get(key) or []
        lines.append("== {} ({}) ==".format(key, len(names)))
        for n in names:
            lines.append("  " + str(n))
    # 二级模块按一级大类分组展示（级联关系一目了然）
    cascade = enums.get("twoLevelModulesByCategory") or {}
    flat = enums.get("twoLevelModules") or []
    if cascade:
        lines.append("== twoLevelModules ({} 个模块，按一级大类分组) ==".format(len(flat)))
        for cat, names in cascade.items():
            lines.append("[{}]".format(cat))
            for n in names:
                lines.append("  " + str(n))
    else:
        lines.append("== twoLevelModules ({}) ==".format(len(flat)))
        for n in flat:
            lines.append("  " + str(n))
    _emit_output(args, "\n".join(lines), out_text)


# ---------------------------------------------------------------- 提交

def _normalize_enums_105(params, project):
    """105 环节名称类参数规范化（业务规则，原地修改 params）：
    - 一级大类 ↔ 二级模块 联动：模块必须属于所选大类；
      模块无对应时先退该大类的"其他"，该大类无"其他"则整体回退 其他/其他
    - 问题根因 独立：不与其他字段联动，无对应时退"其他"
    - 修复方式/修复版本：无对应时，含"其他"的退"其他"，否则报错（版本无回退项）
    """
    enums = _meta_enums(get_meta(project))
    cascade = enums.get("twoLevelModulesByCategory") or {}
    checks = [("modify-type-name", "modifyTypes"),
              ("modify-version-name", "modifyVersions"),
              ("one-level-category-name", "oneLevelCategories"),
              ("two-level-cause-name", "twoLevelCauses")]
    for param, enum_key in checks:
        v = params.get(param)
        if not v:
            continue
        candidates = enums.get(enum_key) or []
        ok = fuzzy_match(v, candidates)
        if not ok:
            if "其他" in candidates:
                print("[wetrack] --{} 值 \"{}\" 无对应枚举，按默认规则回退为 \"其他\"".format(param, v))
                ok = "其他"
            else:
                sys.exit("[wetrack] --{} 值 \"{}\" 不在项目 {} 的枚举中。\n可选值: {}".format(
                    param, v, project, "; ".join(candidates)))
        params[param] = ok  # 统一使用枚举规范值
    # 二级模块：与一级大类联动
    module_v = params.get("two-level-module-name")
    if module_v:
        cat = params.get("one-level-category-name")
        candidates = cascade.get(cat) if cat in cascade else (enums.get("twoLevelModules") or [])
        ok = fuzzy_match(module_v, candidates)
        if not ok:
            if "其他" in candidates:
                print("[wetrack] --two-level-module-name 值 \"{}\" 不属于大类 \"{}\"，按默认规则回退为 \"其他\"".format(module_v, cat))
                ok = "其他"
            elif "其他" in (enums.get("oneLevelCategories") or []) and "其他" in (cascade.get("其他") or []):
                print("[wetrack] --two-level-module-name 值 \"{}\" 无对应模块，且大类 \"{}\" 下无\"其他\"选项，按联动规则整体回退为大类/模块 = 其他/其他".format(module_v, cat))
                params["one-level-category-name"] = "其他"
                ok = "其他"
            else:
                sys.exit("[wetrack] --two-level-module-name 值 \"{}\" 不属于一级大类 \"{}\" 下的模块。\n该大类可选模块: {}".format(
                    module_v, cat, "; ".join(candidates)))
        params["two-level-module-name"] = ok


def _approver_hint(next_step, detail_data, my_id):
    """推断 approver：驳回类/105 提交类 -> 自己；106 提交类 -> 缺陷创建者工号。"""
    if next_step in REJECT_NEXT_STEPS or str(next_step) == "5001":
        return my_id, "当前登录人"
    d = detail_data or {}
    creator = d.get("creatorName") or ""
    m = re.search(r"\((\d+)\)", creator)
    creator_id = m.group(1) if m else None
    if creator_id:
        return creator_id, "缺陷创建者 {}".format(creator)
    return my_id, "当前登录人（兜底）"


def cmd_submit(args):
    my_id = check_env()
    defect = args.defect_number
    next_step = args.next_step

    # 1. 校验 nextStep 是否为当前环节合法流转
    fo = rdcli_json(["wetrack", "defect-flow-options", "--defect-number", defect])
    options = (fo or {}).get("items") or []
    opt = next((o for o in options if str(o.get("nextStep")) == str(next_step)), None)
    if not opt:
        valid = ", ".join("{}({})".format(o.get("nextStep"), o.get("description")) for o in options)
        sys.exit("[wetrack] nextStep={} 不是问题单 {} 当前可执行的流转。\n可选: {}".format(next_step, defect, valid or "(无)"))

    # 2. 驳回类只需 comment，但 step/approver 仍是 CLI 必填
    if str(next_step) in REJECT_NEXT_STEPS:
        params = dict(args.params or [])
        comment = params.get("comment")
        if not comment:
            sys.exit("[wetrack] 驳回流转需要 --comment <驳回理由>")
        step, _ = _resolve_step(defect)
        if not step:
            sys.exit("[wetrack] 无法确定问题单环节（pending 中未找到），无法组装驳回命令")
        approver = args.approver or (_approver_hint(next_step, None, my_id)[0])
        if not approver:
            sys.exit("[wetrack] 无法推断 approver，请用 --approver <工号> 指定")
        argv = ["wetrack", "submit", "--defect-number", defect, "--step", step,
                "--next-step", next_step, "--approver", approver, "--comment", comment]
        _do_write(args, argv, "驳回流转 nextStep={}".format(next_step))
        return

    # 3. 提交类：从 pending 列表确定 step，从 detail 取 approver 信息
    detail = rdcli_json(["wetrack", "detail", "--defect-number", defect])
    step, _pending = _resolve_step(defect)
    if step not in (PY_105, PY_106):
        sys.exit("[wetrack] 无法确定问题单环节（pending 中未找到或 step={}），本脚本仅支持 105/106 提交类流转".format(step or "?"))

    approver = args.approver
    if not approver:
        approver, how = _approver_hint(next_step, detail, my_id)
        print("[wetrack] approver 自动推断: {} ({})".format(approver, how))
    if not approver:
        sys.exit("[wetrack] 无法推断 approver，请用 --approver <工号> 指定")

    # 4. 收集条件必填参数
    params = dict(args.params or [])
    missing = [k for k in REQUIRED_BY_STEP.get(step, []) if k not in params]
    if missing:
        sys.exit("[wetrack] 缺少必填参数: --" + " --".join(missing))

    # 5. 枚举规范化与"默认其他"回退（业务规则见 _normalize_enums_105）
    project = detail.get("projectNumber") or detail.get("projectNum")
    if project and step == PY_105:
        _normalize_enums_105(params, project)

    # 5b. 106 提交类：自验版本校验
    if project and step == PY_106 and params.get("self-test-ver-name"):
        enums = _meta_enums(get_meta(project))
        if not fuzzy_match(params["self-test-ver-name"], enums.get("selfTestVersions") or []):
            sys.exit("[wetrack] --self-test-ver-name 值 \"{}\" 不在枚举中。\n可选值: {}".format(
                params["self-test-ver-name"], "; ".join(enums.get("selfTestVersions") or [])))

    # 6. 组装命令
    argv = ["wetrack", "submit", "--defect-number", defect, "--step", step,
            "--next-step", next_step, "--approver", approver]
    for k, v in params.items():
        argv += ["--" + k, v]

    ok = _do_write(args, argv, "step={} nextStep={}({}) approver={}".format(step, next_step, opt.get("description"), approver))
    # 埋点：仅当「提交到待自验」（nextStep=5001）实际提交成功后上报一次（异步、失败静默）
    if ok and str(next_step) == SELF_TEST_NEXT_STEP:
        fire_event_async(defect)


def _do_write(args, argv, desc):
    """dry-run -> (--dry-run 模式到此为止) -> 确认 -> 实际执行 -> 验证。
    返回 True 表示实际写操作已成功执行；dry-run / 用户取消返回 False。"""
    print("[wetrack] 准备执行: rd-cli --json " + " ".join(argv))
    # dry-run
    code, out = run_rdcli(["--dry-run"] + argv)
    dry_ok = code == 0
    print("[wetrack] dry-run: {}".format("通过" if dry_ok else "失败(见下)"))
    if not dry_ok:
        print(out.strip()[:800])
        sys.exit(1)
    if getattr(args, "dry_run", False):
        print("[wetrack] --dry-run 模式：仅校验与预演，未执行任何写操作。去掉 --dry-run 并加 --yes 实际执行。")
        return False
    if not args.yes:
        try:
            ans = input("确认执行? [y/N] ").strip().lower()
        except EOFError:
            print("[wetrack] 非交互环境无法确认，已取消。加 --yes 跳过确认（dry-run 已通过）。")
            return False
        if ans != "y":
            print("[wetrack] 已取消")
            return False
    code, out = run_rdcli(argv)
    data = parse_json(out)
    if code != 0 or not data or not data.get("success"):
        sys.exit("[wetrack] 提交失败:\n" + out.strip()[:800])
    print("[wetrack] 提交成功")
    # 验证
    code, out = run_rdcli(["wetrack", "detail", "--defect-number", argv[argv.index("--defect-number") + 1]])
    d = parse_json(out) or {}
    dd = d.get("data") or {}
    print("[wetrack] 当前状态: {}".format(dd.get("defectStatusName")))
    return True


def _resolve_step(defect):
    """detail 不返回 defectStep，从 pending 列表匹配获取；匹配不到则报错。
    返回 (step, pending_item)。"""
    data = rdcli_json(["wetrack", "pending"])
    for it in (data or {}).get("items") or []:
        if it.get("defectNumber") == defect:
            return str(it.get("defectStep") or ""), it
    return "", None


# ---------------------------------------------------------------- save

def cmd_save(args):
    check_env()
    # --step 显式指定优先；未指定时从 pending 推断
    step = str(args.step or "")
    if not step:
        step, _ = _resolve_step(args.defect_number)
    if step not in (PY_105, PY_106):
        sys.exit("[wetrack] 无法确定问题单环节（pending 中未找到或 step={}），仅支持 105/106 保存；可用 --step 105|106 显式指定".format(step or "?"))
    params = dict(args.params or [])
    if not params:
        sys.exit("[wetrack] 无保存内容，请传 --modify-content 等参数")
    # 105 名称类参数同样按业务规则规范化（大类↔模块联动、根因独立、无对应默认"其他"）
    if step == PY_105:
        detail = rdcli_json(["wetrack", "detail", "--defect-number", args.defect_number])
        project = detail.get("projectNumber") or detail.get("projectNum")
        if project:
            _normalize_enums_105(params, project)
    argv = ["wetrack", "save", "--defect-number", args.defect_number, "--step", step]
    for k, v in params.items():
        argv += ["--" + k, v]
    _do_write(args, argv, "save step={}".format(step))


# ---------------------------------------------------------------- 参数解析

PARAM_FLAGS = [
    "modify-content", "modify-type-name", "modify-version-name",
    "one-level-category-name", "two-level-module-name", "two-level-cause-name",
    "three-level-cause", "svn-git", "self-test-describe", "self-test-ver-name",
    "comment",
]

EPILOG = """示例:
  %(prog)s pending
  %(prog)s pending --json
  %(prog)s pending --json --out                      # 大输出落盘，终端只回确认行
  %(prog)s detail DTS006636033
  %(prog)s detail DTS006636033 --json --out
  %(prog)s detail DTS006636033 --json --full         # 原始完整 JSON（含 base64 截图）
  %(prog)s flow-options DTS006636033
  %(prog)s query --project DH3.RDA000896 --status 205
  %(prog)s query --project DH3.RDA000896 --rows 50 --json --out
  %(prog)s meta DH3.RDA000896
  %(prog)s save DTS006636033 --modify-content "已修复" --modify-type-name "代码修改"
  %(prog)s submit DTS006636033 5001                     # 交互确认
  %(prog)s submit DTS006636033 5003 --comment "无法复现" --yes
  %(prog)s submit DTS006636033 5001 --yes \\
      --modify-content "..." --modify-type-name "代码修改" \\
      --modify-version-name "..." --one-level-category-name "软件" \\
      --two-level-cause-name "编码错误引入" --two-level-module-name "..." \\
      --three-level-cause "..."

临时目录（%%TEMP%%\\wetrack\\）按问题单号分目录；clean --defect <单号> 删该单目录。
"""


def cmd_clean(args):
    if getattr(args, "defect", None):
        # 精确清理：删除该问题单的整个临时目录（%TEMP%/wetrack/<单号>/）
        d = _defect_dir(args.defect)
        removed = 0
        if os.path.isdir(d):
            for dirpath, _dirnames, filenames in os.walk(d, topdown=False):
                for name in filenames:
                    try:
                        os.remove(os.path.join(dirpath, name))
                        removed += 1
                    except OSError:
                        pass
                try:
                    os.rmdir(dirpath)
                except OSError:
                    pass
        # 兼容旧版平铺截图目录
        if os.path.isdir(LEGACY_IMAGE_DIR):
            for name in os.listdir(LEGACY_IMAGE_DIR):
                if name.startswith(args.defect + "-"):
                    try:
                        os.remove(os.path.join(LEGACY_IMAGE_DIR, name))
                        removed += 1
                    except OSError:
                        pass
        print("[wetrack] 已删除问题单 {} 的临时文件 {} 个（目录 {}）".format(args.defect, removed, d))
        return
    cleanup_temp(max_age_days=0 if args.all else RETENTION_DAYS, verbose=True)


def build_parser():
    ap = argparse.ArgumentParser(prog="wetrack.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=EPILOG)
    sub = ap.add_subparsers(dest="command")

    def add_json_out(p):
        p.add_argument("--json", dest="json_out", action="store_true", help="输出原始 JSON")

    def add_out(p):
        p.add_argument("--out", action="store_true",
                       help="输出写入规划的临时文件（%%TEMP%%\\wetrack\\...），终端只回确认行")
        p.add_argument("--out-file", dest="out_file", metavar="PATH",
                       help="输出写入指定文件（不使用 --out 的自动路径）")

    def add_full(p):
        p.add_argument("--full", action="store_true",
                       help="JSON 输出保留原始完整字段（含 description/图片 base64），默认瘦身")

    p = sub.add_parser("pending", help="获取我的待办缺陷列表")
    add_json_out(p)
    add_out(p)
    p.set_defaults(func=cmd_pending)

    p = sub.add_parser("detail", help="查看缺陷详情")
    p.add_argument("defect_number")
    p.add_argument("--del-images", action="store_true",
                   help="输出完毕后立即删除本次落盘的截图与附件（读完即删，无磁盘残留）")
    add_json_out(p)
    add_out(p)
    add_full(p)
    p.set_defaults(func=cmd_detail)

    p = sub.add_parser("flow-options", help="查询当前环节可执行的流转操作")
    p.add_argument("defect_number")
    add_json_out(p)
    add_out(p)
    p.set_defaults(func=cmd_flow_options)

    p = sub.add_parser("query", help="高级组合查询（advanced-query）")
    p.add_argument("--project", help="项目编号，如 DH3.RDA000896")
    p.add_argument("--owner", help="当前责任人工号")
    p.add_argument("--status", help="状态编码，如 205=待开发解决问题")
    p.add_argument("--defect", help="问题单号")
    p.add_argument("--page", type=int, default=1)
    p.add_argument("--rows", type=int, default=10)
    add_json_out(p)
    add_out(p)
    add_full(p)
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("meta", help="查看项目元数据枚举（带缓存）")
    p.add_argument("project_number")
    p.add_argument("--refresh", action="store_true", help="强制刷新缓存")
    add_json_out(p)
    add_out(p)
    p.set_defaults(func=cmd_meta)

    p = sub.add_parser("clean", help="清理临时文件（默认清 7 天前的，--all 全清，--defect 清指定单目录）")
    p.add_argument("--all", action="store_true", help="清空全部临时文件，不限天数")
    p.add_argument("--defect", help="删除指定问题单的整个临时目录（读完即删的推荐方式）")
    p.set_defaults(func=cmd_clean)

    p = sub.add_parser("save", help="保存缺陷内容（不流转）")
    p.add_argument("defect_number")
    p.add_argument("--step", help="环节号（105/106），缺省时从 pending 自动推断")
    for f in PARAM_FLAGS:
        p.add_argument("--" + f)
    p.add_argument("--yes", action="store_true", help="跳过交互确认")
    p.add_argument("--dry-run", action="store_true", help="仅校验参数与枚举并预演，不实际执行")
    add_json_out(p)
    p.set_defaults(func=cmd_save, collect_params=True)

    p = sub.add_parser("submit", help="提交缺陷流转（自动校验+推断+dry-run）")
    p.add_argument("defect_number")
    p.add_argument("next_step")
    p.add_argument("--approver")
    for f in PARAM_FLAGS:
        p.add_argument("--" + f)
    p.add_argument("--yes", action="store_true", help="跳过交互确认")
    p.add_argument("--dry-run", action="store_true", help="仅校验参数与枚举并预演，不实际执行")
    add_json_out(p)
    p.set_defaults(func=cmd_submit, collect_params=True)

    return ap


def main():
    # 隐藏子命令：异步上报子进程入口（不经 argparse，不对外暴露）
    if len(sys.argv) >= 3 and sys.argv[1] == "__report-event":
        _event_report_sync(sys.argv[2])
        return
    args = build_parser().parse_args()
    if not getattr(args, "command", None):
        build_parser().print_help()
        return
    if args.command != "clean":
        _quiet_cleanup()  # 每次命令顺带清理过期临时文件
    if getattr(args, "collect_params", False):
        # 把 None 的参数过滤掉，非 None 的收进 params
        args.params = [(f, getattr(args, f.replace("-", "_"))) for f in PARAM_FLAGS
                       if getattr(args, f.replace("-", "_")) is not None]
        for f in PARAM_FLAGS:
            attr = f.replace("-", "_")
            if hasattr(args, attr):
                delattr(args, attr)
    args.func(args)


if __name__ == "__main__":
    main()
