#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抖音创作中心数据采集器（独立脚本）。

为什么是独立脚本、而不是插件里的代码：
    插件本体（index.js 与 lib/*.js）有一条硬约束——**不联网、不起进程**，test/smoke.mjs
    里有断言守着它。抖音没有可用的开放数据接口，只能带 cookie 打创作中心的内部接口；
    这个动作天然违反上面那条约束，所以它只能待在插件外面。两边靠文件解耦：
    脚本产出 JSON，插件用纯函数离线灌进台账。

四个子命令：
    login     用浏览器 CDP 扫码登录，把 cookie 存到 <工作区根>/config/douyin_<account>.txt
    fetch     拉作品列表 + 每个作品的详情指标，产出 <工作区根>/tmp/douyin-import.json
    whoami    只验证凭据是否还有效、顺带看一眼账号信息，不写任何文件
    selftest  起本地假服务跑一遍 fetch 全链路并断言输出契约（不联网、不开浏览器）

约定：
    - 只用 Python 3.12 标准库；浏览器登录靠手写的极简 WebSocket + CDP，
      不装 playwright / selenium / websocket-client（装一个就多一份供应链风险）；
    - cookie 值永不打印，只打印字段名与长度；
    - 缺失一律写 null，绝不写 0 冒充；降级情况记进输出 JSON 的 warnings；
    - 工作区根从本文件向上找「同层既有 AGENTS.md 又有 code/」的目录，代码里不写死盘符路径。

退出码：
    0  成功
    1  一般错误（网络不通、接口返回异常码、参数不合法、文件读写失败）
    2  未登录或凭据失效（status_code == 8）
    3  被风控（352 / 412 / 2154，含 HTTP 412）
    4  等待扫码超时（login 默认等 180 秒）
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import http.server
import io
import json
import math
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 请求头统一用桌面 Chrome UA。UA 写死在脚本里而不是读环境，是为了让行为可复现。
DESKTOP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

# 线上域名。测试/自检可以用环境变量或 --base-url 覆盖，默认永远是线上。
CREATOR_ORIGIN = "https://creator.douyin.com"

WORK_LIST_PATH = "/janus/douyin/creator/pc/work_list"
ITEM_MGET_PATH = "/web/api/creator/item/mget"
PROBE_PATH = "/janus/douyin/creator/data/author/upgrade"
USER_INFO_PATH = "/aweme/v1/creator/pc/user/info/"
MANAGE_PATH = "/creator-micro/content/manage"

REFERER_MANAGE = f"{CREATOR_ORIGIN}{MANAGE_PATH}"

# 网关参数两套都实测能过：默认用 prefetch 原值（1128 / android）；
# 万一登录后 work_list 返回非 0、非 8 的异常码，fetch 会切到 2906 / web 重试一次
# （只切这一次，切换本身记 warning，不做无限重试——重试更容易触发风控）。
PLATFORM_PRIMARY = {"aid": "1128", "device_platform": "android"}
PLATFORM_FALLBACK = {"aid": "2906", "device_platform": "web"}

WORK_LIST_STATUS = "0"
WORK_LIST_SCENE = "star_atlas"
MGET_FIELDS = "metrics,review,play_info"
# mget 必须带这个头，否则网关直接拒（实测：不带拿不到 items）。
MGET_EXTRA_HEADERS = {"Agw-Js-Conv": "str"}

# 请求间隔：列表 + 每批详情很容易触发风控，0.35s 是 B站脚本实跑不炸的下限，这里沿用。
MIN_REQUEST_INTERVAL = 0.35
REQUEST_TIMEOUT = 15.0
TRANSPORT_RETRIES = 2
# 传输层重试的退避：0.8s、1.6s（指数退避）。
RETRY_BACKOFF = (0.8, 1.6)

PAGE_SIZE = 20          # 列表接口一页 20 条（count 字段）
MGET_BATCH = 20         # mget 一次最多 20 个 id
MAX_POSTS_LIMIT = 200   # --max 的上限：再多既没意义也更容易被风控
MAX_PAGES = 50          # 保险丝：50 页 = 1000 条，翻到这儿还没拿满就是接口行为变了

LOGIN_TIMEOUT = 180.0   # 等扫码最长 3 分钟
LOGIN_POLL_INTERVAL = 2.0
LOGIN_NOTICE_INTERVAL = 15.0
DEVTOOLS_WAIT = 30.0    # 等浏览器把调试端口开起来的上限

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_AUTH = 2
EXIT_RISK = 3
EXIT_LOGIN_TIMEOUT = 4

# 业务状态码：8 是「未登录」（不是过期码，但处置动作一样：重新 login）。
AUTH_STATUS = {8}
# 风控码：实测常见的三个，命中就别再打了，降频后再说。
RISK_STATUS = {352, 412, 2154}

# 账号名会拼进文件名，只允许安全字符，避免 --account ../xxx 这种路径穿越。
ACCOUNT_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

# 凭据文件的字段顺序：抖音登录后这几个是必需的，其余按名字排序追加。
# 顺序只是为了人眼看，不代表接口对顺序有要求。
COOKIE_FIELD_ORDER = (
    "sessionid",
    "sessionid_ss",
    "sid_tt",
    "uid_tt",
    "passport_csrf_token",
    "ttwid",
    "odin_tt",
    "sid_guard",
)

# 浏览器探测顺序：用户环境是 Windows，先 Chrome 再 Edge；两条都找不到再试两个非主流安装位。
BROWSER_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)

# 环境变量：默认值都是线上/工作区，只有自检和排查时才覆盖。
ENV_BASE_URL = "DOUYIN_CREATOR_BASE"
ENV_CONFIG_DIR = "DOUYIN_CONFIG_DIR"

# ---------------------------------------------------------------------------
# 字段候选（**真实键名未实测**，所以每个字段给一串候选按顺序回退）
#
# 现状：`item/mget` 登录后的 items[] 键名没有生产样本可验证。硬编码一套猜的键名，
# 一旦猜错就是「静默全 null」，比报错更难查。所以这里写成候选表：
# 按 paths 顺序取第一个非空值，全部取不到就写 null，并把整串候选键名记进 warnings。
# 等哪天真拿到数据，把命中的那条路径提到最前面即可（也可以顺手删掉没用的候选）。
# ---------------------------------------------------------------------------

METRIC_SPECS = (
    (
        "view_count",
        (
            "metrics.view_count",
            "statistics.play_count",
            "play_count",
            "metrics.play_count",
            "statistics.view_count",
        ),
        "int",
    ),
    (
        "like_count",
        (
            "metrics.like_count",
            "statistics.digg_count",
            "digg_count",
            "metrics.digg_count",
        ),
        "int",
    ),
    (
        "comment_count",
        ("metrics.comment_count", "statistics.comment_count", "comment_count"),
        "int",
    ),
    (
        "share_count",
        ("metrics.share_count", "statistics.share_count", "share_count"),
        "int",
    ),
    (
        "favorite_count",
        (
            "metrics.favorite_count",
            "statistics.collect_count",
            "collect_count",
            "metrics.collect_count",
            "favorite_count",
        ),
        "int",
    ),
    (
        "completion_rate",
        (
            "metrics.completion_rate",
            "metrics.finish_rate",
            "review.completion_rate",
            "play_info.completion_rate",
        ),
        "rate",
    ),
    (
        "avg_view_second",
        (
            "metrics.avg_view_second",
            "metrics.avg_play_time",
            "play_info.avg_view_second",
            "metrics.avg_view_duration",
            "metrics.avg_view_ms",
        ),
        "seconds",
    ),
)

STATISTIC_SPECS = (
    ("play_count", ("statistics.play_count", "play_count")),
    ("digg_count", ("statistics.digg_count", "digg_count")),
    ("comment_count", ("statistics.comment_count", "comment_count")),
    ("share_count", ("statistics.share_count", "share_count")),
)

REVIEW_PATHS = ("review.status", "audit.status", "review_status", "status.review")
VISIBILITY_PATHS = (
    "visibility.status",
    "visibility_status",
    "item_visibility.status",
    "status.visibility",
)

DESC_PATHS = ("desc", "item_title", "title", "caption")
CREATE_TIME_PATHS = (
    "create_time",
    "createTime",
    "publish_time",
    "create_time_ms",
    "ctime",
)
DURATION_PATHS = (
    "duration",
    "video.duration",
    "video_duration",
    "video.duration_ms",
    "play_info.duration",
)
MEDIA_TYPE_PATHS = ("media_type", "mediaType", "aweme_type", "item_type")
COVER_PATHS = (
    "video.cover.url_list.0",
    "cover.url_list.0",
    "video.dynamic_cover.url_list.0",
    "cover",
    "cover_url",
    "video.cover",
)
SHARE_URL_PATHS = ("share_url", "share_info.share_url", "shareInfo.shareUrl")
AWEME_ID_PATHS = ("aweme_id", "item_id", "awemeId", "itemId", "id", "item_id_str")

ACCOUNT_UID_PATHS = ("uid", "user_id", "uid_str", "userId")
ACCOUNT_NAME_PATHS = ("nickname", "name", "user_name")
ACCOUNT_FOLLOWER_PATHS = (
    "follower_count",
    "fans_count",
    "mplatform_followers_count",
    "follower",
)
# 详情条目可能被套一层（不同版本的接口有的直接给 item，有的包一层），这几个键都尝试摊平。
DETAIL_UNWRAP_KEYS = ("item", "aweme_detail", "aweme_info", "detail")


# ---------------------------------------------------------------------------
# 错误类型
# ---------------------------------------------------------------------------


class SyncError(Exception):
    """带退出码的错误：main 捕获后打印一句可读中文就退出。"""

    def __init__(self, message: str, exit_code: int = EXIT_ERROR) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class ApiError(SyncError):
    """接口返回业务状态码 != 0。"""

    def __init__(self, url: str, code, message, exit_code: int) -> None:
        # 只报接口名与 code/message，绝不带 Cookie 头。
        text = f"接口 {short_url(url)} 返回 status_code={code}（{message or '无 message'}）"
        super().__init__(text, exit_code)
        self.code = code
        self.url = url


def short_url(url: str) -> str:
    """打日志用：只留 scheme+host+path，去掉 query（里面可能有 ids/cursor，也可能带凭据）。"""
    parsed = urllib.parse.urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


# ---------------------------------------------------------------------------
# 路径推导
# ---------------------------------------------------------------------------


def find_workspace_root(start: Path) -> Path:
    """向上找工作区根：同层既有 AGENTS.md 又有 code/ 的那层目录。

    只认这两个标记，所以插件仓库自己不会被当成工作区根；找不到就报错，
    而不是退回用户目录——静默写到别处比直接失败更难查。
    （与 scripts/bili_sync.py 完全一致，两条采集脚本必须落在同一个 config/、tmp/ 下。）
    """
    for candidate in [start, *start.parents]:
        if (candidate / "AGENTS.md").is_file() and (candidate / "code").is_dir():
            return candidate
    raise SyncError(
        f"从 {start} 向上找不到工作区根（需要同层有 AGENTS.md 与 code/），"
        "请把脚本放在工作区内的仓库里运行"
    )


def workspace_paths() -> dict[str, Path]:
    """一次性算出工作区根下的几个固定路径。"""
    root = find_workspace_root(Path(__file__).resolve().parent)
    return {
        "root": root,
        "config_dir": root / "config",
        "tmp_dir": root / "tmp",
    }


def config_dir() -> Path:
    """凭据目录：默认工作区根的 config/，自检时用 DOUYIN_CONFIG_DIR 指到临时目录。"""
    override = os.environ.get(ENV_CONFIG_DIR, "").strip()
    if override:
        return Path(override).expanduser()
    return workspace_paths()["config_dir"]


def credential_path(account: str) -> Path:
    return config_dir() / f"douyin_{account}.txt"


def browser_profile_dir(account: str) -> Path:
    return workspace_paths()["tmp_dir"] / f"douyin-profile-{account}"


def default_output_path() -> Path:
    return workspace_paths()["tmp_dir"] / "douyin-import.json"


def validate_account(raw: str) -> str:
    account = (raw or "").strip()
    if not ACCOUNT_PATTERN.match(account):
        raise SyncError(
            f"账号名 {raw!r} 不合法：只允许字母、数字、下划线、短横线，长度 1..32"
            "（它会被拼进凭据文件名）"
        )
    return account


def resolve_base_url(override: str | None = None) -> str:
    """取根地址：--base-url > 环境变量 DOUYIN_CREATOR_BASE > 线上域名。"""
    picked = (override or os.environ.get(ENV_BASE_URL) or CREATOR_ORIGIN).strip()
    return picked.rstrip("/")


# ---------------------------------------------------------------------------
# 取值小工具（缺失一律 None，绝不拿 0 冒充）
# ---------------------------------------------------------------------------


def as_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def as_int(value):
    """转 int；None / 空串 / 非数值 / bool / 非有限浮点 一律 None。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(float(text))
        except ValueError:
            return None
    return None


def as_float(value):
    """转 float；规则同 as_int，额外挡掉 nan / inf。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def as_text(value):
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def coerce_id(value):
    """把 id 归成字符串：抖音的 aweme_id 有时给字符串、有时给数字，一律按字符串落盘。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if math.isfinite(value) else None
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return None


def dig(source, path: str):
    """按 'a.b.0.c' 这种路径取值；中途缺失或类型不对返回 None。

    支持数字段当作列表下标（cover.url_list.0 这类结构必须靠它）。
    """
    current = source
    for part in path.split("."):
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list):
            try:
                index = int(part)
            except ValueError:
                return None
            if index < 0 or index >= len(current):
                return None
            current = current[index]
        else:
            return None
        if current is None:
            return None
    return current


def pick_path(sources, paths):
    """按「源优先、路径其次」的顺序取第一个非空值，返回 (值, 命中的路径)。

    源优先是有意的：详情接口是主源，列表行只是兜底，不能因为列表行里也恰好有个
    同名键就抢先命中（两边口径可能不同）。
    """
    for source in sources:
        if not isinstance(source, dict) or not source:
            continue
        for path in paths:
            value = dig(source, path)
            if value is None:
                continue
            if isinstance(value, str) and not value.strip():
                continue
            return value, path
    return None, None


def format_timestamp(value) -> str | None:
    """秒级时间戳 → 'YYYY-MM-DD HH:MM'；无效时间戳返回 None。"""
    stamp = as_int(value)
    if not stamp or stamp <= 0:
        return None
    try:
        return datetime.fromtimestamp(stamp).strftime("%Y-%m-%d %H:%M")
    except (OverflowError, OSError, ValueError):
        return None


def normalize_unix_seconds(value):
    """统一成 Unix **秒**：> 1e11 认为是毫秒，除以 1000（抖音有些接口给 13 位）。"""
    stamp = as_int(value)
    if stamp is None or stamp <= 0:
        return None
    if stamp > 100_000_000_000:
        return stamp // 1000
    return stamp


def normalize_rate(value, label: str, path: str, warnings: list[str]):
    """完播率统一成百分比数值（38.2 表示 38.2%）。

    接口给 0.382 时按「0..1 的比例」猜成 38.2 并记 warning——这条换算**没有实测依据**，
    所以必须留下痕迹，别让下游拿 0.38% 当结论。
    """
    number = as_float(value)
    if number is None or number < 0:
        return None
    if 0 < number <= 1.0:
        warnings.append(
            f"{label}: {path}={number:g} 落在 0..1，按比例猜成百分比（×100={round(number * 100, 2)}，"
            "口径未实测）"
        )
        return round(number * 100, 2)
    return round(number, 2)


def normalize_seconds(value, label: str, path: str, warnings: list[str]):
    """统一成**秒**；候选路径带 _ms 后缀的按毫秒 ÷1000。"""
    number = as_float(value)
    if number is None or number < 0:
        return None
    if path.endswith("_ms"):
        warnings.append(f"{label}: {path} 看着是毫秒，已 ÷1000 存成秒")
        return round(number / 1000.0, 3)
    return round(number, 3)


def nested_sources(raw: dict) -> list[dict]:
    """详情条目可能被套一层：给出「本身 + 各层内层」作为取值源，按优先级排好。"""
    sources = [raw]
    for key in DETAIL_UNWRAP_KEYS:
        inner = as_dict(raw.get(key))
        if inner:
            sources.append(inner)
    return sources


def pick_aweme_id(raw) -> str | None:
    """从列表行/详情条目里挖作品 id。"""
    if not isinstance(raw, dict):
        return None
    for source in nested_sources(raw):
        for path in AWEME_ID_PATHS:
            text = coerce_id(dig(source, path))
            if text:
                return text
    return None


def truthy(value) -> bool:
    """接口的 has_more 可能是 true / 1 / '1'，统一判断。"""
    if isinstance(value, bool):
        return value
    number = as_int(value)
    return number is not None and number != 0


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Throttle:
    """保证任意两次请求之间至少间隔 INTERVAL 秒。"""

    def __init__(self, interval: float = MIN_REQUEST_INTERVAL) -> None:
        self.interval = max(0.0, interval)
        self.last = 0.0

    def wait(self) -> None:
        if self.last <= 0.0 or self.interval <= 0.0:
            return
        remain = self.interval - (time.monotonic() - self.last)
        if remain > 0:
            time.sleep(remain)

    def mark(self) -> None:
        self.last = time.monotonic()


def build_headers(cookie_header: str | None, extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": DESKTOP_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": REFERER_MANAGE,
    }
    if cookie_header:
        headers["Cookie"] = cookie_header
    if extra:
        headers.update(extra)
    return headers


def open_url(url: str, headers: dict[str, str], timeout: float = REQUEST_TIMEOUT) -> str:
    """打开 URL 并返回响应体文本。

    传输层错误重试 TRANSPORT_RETRIES 次（0.8s / 1.6s 退避）；HTTP 错误码直接抛。
    注意这里**不打印** URL 的 query，也不打印任何请求头（Cookie 在里面）。
    """
    attempt = 0
    while True:
        try:
            request = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(request, timeout=timeout) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="replace")
        except urllib.error.HTTPError as error:
            body = ""
            with contextlib.suppress(Exception):
                body = error.read().decode("utf-8", errors="replace")[:120]
            if error.code == 412:
                raise SyncError(
                    f"{short_url(url)} 返回 HTTP 412（风控拦截），请降低频率后重试（{body or '无响应体'}）",
                    EXIT_RISK,
                ) from error
            raise SyncError(
                f"{short_url(url)} 返回 HTTP {error.code}（{body or '无响应体'}）"
            ) from error
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            attempt += 1
            if attempt > TRANSPORT_RETRIES:
                raise SyncError(f"{short_url(url)} 连接失败：{error}") from error
            time.sleep(RETRY_BACKOFF[min(attempt - 1, len(RETRY_BACKOFF) - 1)])


def parse_json_object(url: str, text: str) -> dict:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        hint = "，响应看着像 HTML/风控页" if text.lstrip()[:1] == "<" else ""
        raise SyncError(
            f"{short_url(url)} 返回的不是 JSON（{error}）{hint}，可能被风控页拦了"
        ) from error
    if not isinstance(payload, dict):
        raise SyncError(f"{short_url(url)} 返回的不是 JSON 对象")
    return payload


def envelope_status(payload: dict) -> tuple[int | None, str]:
    """从响应里挖出业务状态码与提示。

    抖音有两套封套：列表接口是单层 `status_code`/`status_msg`；mget 未登录时是双层
    `{"BaseResp":{"StatusCode":8,...},"status_code":8}`。两个都看，取第一个有值的。
    """
    base = as_dict(payload.get("BaseResp"))
    data = as_dict(payload.get("data"))
    message = (
        as_text(payload.get("status_msg"))
        or as_text(payload.get("status_message"))
        or as_text(base.get("StatusMessage"))
        or as_text(data.get("status_msg"))
        or as_text(payload.get("message"))
        or ""
    )
    for candidate in (
        payload.get("status_code"),
        base.get("StatusCode"),
        payload.get("code"),
        data.get("status_code"),
    ):
        number = as_int(candidate)
        if number is not None:
            return number, message
    return None, message


def raise_for_status(url: str, payload: dict) -> None:
    """业务状态码映射成退出码：0 过；8 凭据失效；352/412/2154 风控；其余一般错误。"""
    code, message = envelope_status(payload)
    if code is None or code == 0:
        return
    if code in AUTH_STATUS:
        raise ApiError(
            url, code, f"{message or '用户未登录'}；cookie 已失效，请重新执行 login", EXIT_AUTH
        )
    if code in RISK_STATUS:
        raise ApiError(
            url,
            code,
            f"{message or '请求被风控'}；命中风控，请停手 10–30 分钟、降低 --max 后再来",
            EXIT_RISK,
        )
    raise ApiError(url, code, message, EXIT_ERROR)


# ---------------------------------------------------------------------------
# 接口 URL
# ---------------------------------------------------------------------------


def work_list_url(base_url: str, cursor, count: int, platform: dict[str, str]) -> str:
    params = {
        "status": WORK_LIST_STATUS,
        "count": str(count),
        "max_cursor": str(cursor),
        "scene": WORK_LIST_SCENE,
        "device_platform": platform["device_platform"],
        "aid": platform["aid"],
    }
    return f"{base_url}{WORK_LIST_PATH}?{urllib.parse.urlencode(params)}"


def item_mget_url(base_url: str, ids: list[str]) -> str:
    # ids 用逗号拼接，逗号本身不编码（编码成 %2C 网关也收，但别赌）。
    joined = urllib.parse.quote(",".join(ids), safe=",")
    return f"{base_url}{ITEM_MGET_PATH}?ids={joined}&fields={MGET_FIELDS}"


def probe_url(base_url: str) -> str:
    return f"{base_url}{PROBE_PATH}"


def user_info_url(base_url: str) -> str:
    return f"{base_url}{USER_INFO_PATH}?aid=2906&device_platform=web"


class DouyinClient:
    """fetch / whoami 用的带 cookie + 限速的轻客户端。"""

    def __init__(
        self,
        cookie_header: str,
        base_url: str | None = None,
        throttle: Throttle | None = None,
        platform: dict[str, str] | None = None,
    ) -> None:
        self.cookie_header = cookie_header
        self.base_url = resolve_base_url(base_url)
        self.throttle = throttle or Throttle()
        self.platform = dict(platform or PLATFORM_PRIMARY)

    def get_json(self, url: str, extra_headers: dict[str, str] | None = None) -> dict:
        headers = build_headers(self.cookie_header, extra_headers)
        self.throttle.wait()
        try:
            text = open_url(url, headers)
        finally:
            self.throttle.mark()
        payload = parse_json_object(url, text)
        raise_for_status(url, payload)
        return payload


# ---------------------------------------------------------------------------
# 凭据读写
#
# 抖音的 cookie 字段比 B站多且随版本变化，用「一行 k=v; k=v」容易在某个值里带分号时
# 拆错，所以这里落成 JSON（name -> value）。读的时候两种格式都认，兼容手工贴的旧文件。
# ---------------------------------------------------------------------------


def ordered_cookie_pairs(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """先按 COOKIE_FIELD_ORDER，其余按名字排序；同名后者覆盖前者。"""
    collected: dict[str, str] = {}
    for name, value in pairs:
        if not name or not isinstance(value, str) or value == "":
            continue
        collected[name] = value
    ordered: list[tuple[str, str]] = []
    for name in COOKIE_FIELD_ORDER:
        if name in collected:
            ordered.append((name, collected.pop(name)))
    for name in sorted(collected):
        ordered.append((name, collected[name]))
    return ordered


def parse_cookie_line(line: str) -> list[tuple[str, str]]:
    """把 `k=v; k=v` 拆成列表。值里的 '=' 保留（只按第一个等号切）。"""
    pairs: list[tuple[str, str]] = []
    for chunk in line.split(";"):
        item = chunk.strip()
        if not item or "=" not in item:
            continue
        name, value = item.split("=", 1)
        pairs.append((name.strip(), value.strip()))
    return pairs


def parse_credential(text: str) -> list[tuple[str, str]]:
    """凭据文件的两种格式都认：JSON 对象（本脚本写的）与 k=v 行（手工贴的）。"""
    body = text.lstrip()
    if body.startswith("{"):
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as error:
            raise SyncError(f"凭据文件是 JSON 但解析失败（{error}），请重新 login") from error
        if not isinstance(payload, dict):
            raise SyncError("凭据文件的 JSON 不是一个对象，请重新 login")
        return [(str(name), str(value)) for name, value in payload.items()]
    return parse_cookie_line(text)


def cookie_to_header(pairs: list[tuple[str, str]]) -> str:
    return "; ".join(f"{name}={value}" for name, value in pairs)


def describe_credential(text: str) -> str:
    """只输出字段名与长度——排查凭据够不够用，绝不回显值。"""
    pairs = parse_credential(text)
    return "，".join(f"{name}(len={len(value)})" for name, value in pairs)


def save_credential(account: str, pairs: list[tuple[str, str]]) -> Path:
    """写凭据：UTF-8 无 BOM、JSON 对象、字段按 COOKIE_FIELD_ORDER 排在前。"""
    path = credential_path(account)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(ordered_cookie_pairs(pairs))
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="")
    return path


def load_credential(account: str) -> tuple[str, list[tuple[str, str]]]:
    """读凭据并返回 (cookie 头, 键值对)；不打印任何值。"""
    path = credential_path(account)
    if not path.is_file():
        raise SyncError(
            f"凭据文件不存在：{path}\n请先运行：python scripts/douyin_sync.py login --account {account}"
        )
    text = path.read_text(encoding="utf-8").replace("\ufeff", "").strip()
    if not text:
        raise SyncError(f"凭据文件是空的：{path}，请重新 login")
    pairs = ordered_cookie_pairs(parse_credential(text))
    if not pairs:
        raise SyncError(f"凭据文件里没有可用的 cookie 字段：{path}，请重新 login")
    return cookie_to_header(pairs), pairs


def login_state(base_url: str, cookie_header: str, sleep: float = 0.0):
    """用 work_list 探一次登录态：True 已登录 / False 明确未登录 / None 判断不了。

    work_list 不需要签名，只要带 cookie 就能读，所以它是唯一可靠的「现在能不能用」判据
    （比猜页面 URL 是否变化可靠得多）。
    """
    client = DouyinClient(cookie_header, base_url=base_url, throttle=Throttle(sleep))
    try:
        payload = client.get_json(work_list_url(client.base_url, "0", 1, client.platform))
    except ApiError as error:
        if error.exit_code == EXIT_AUTH:
            return False
        raise
    code, _ = envelope_status(payload)
    if code in AUTH_STATUS:
        return False
    if code == 0:
        return True
    return None


# ---------------------------------------------------------------------------
# 取值：作品字段
# ---------------------------------------------------------------------------


def pick_cover(sources) -> str | None:
    """封面：优先 url_list 第一张；也容忍直接给字符串或 {url: ...} 的形态。"""
    for source in sources:
        if not isinstance(source, dict):
            continue
        for path in COVER_PATHS:
            value = dig(source, path)
            if isinstance(value, str) and value.strip().startswith("http"):
                return value.strip()
            if isinstance(value, dict):
                for inner in ("url_list", "urls", "url"):
                    candidate = dig(value, inner)
                    if isinstance(candidate, str) and candidate.strip().startswith("http"):
                        return candidate.strip()
                    if isinstance(candidate, list) and candidate:
                        first = candidate[0]
                        if isinstance(first, str) and first.strip().startswith("http"):
                            return first.strip()
    return None


def build_metrics(detail: dict, list_row: dict, label: str, warnings: list[str], hints: dict) -> dict:
    """七个指标字段：候选回退取值，取不到写 null 并把缺失的键名记进 warnings。"""
    sources = (detail, list_row)
    metrics: dict = {}
    missing: list[str] = []
    for key, paths, kind in METRIC_SPECS:
        value, path = pick_path(sources, paths)
        if value is None:
            metrics[key] = None
            missing.append(key)
            continue
        if kind == "int":
            metrics[key] = as_int(value)
        elif kind == "rate":
            metrics[key] = normalize_rate(value, label, path, warnings)
        else:
            metrics[key] = normalize_seconds(value, label, path, warnings)
        if metrics[key] is None:
            missing.append(key)
    if missing:
        warnings.append(f"{label}: metrics 缺 {missing}，写 null")
        if not hints.get("metric_candidates"):
            hints["metric_candidates"] = True
            detail_text = "；".join(
                f"{key}={' | '.join(paths)}" for key, paths, _ in METRIC_SPECS if key in missing
            )
            warnings.append(f"metrics 的取值是候选回退（真实键名未实测）：{detail_text}")
    return metrics


def build_statistics(sources, label: str, warnings: list[str]) -> dict:
    out: dict = {}
    missing: list[str] = []
    for key, paths in STATISTIC_SPECS:
        value, _ = pick_path(sources, paths)
        out[key] = as_int(value)
        if out[key] is None:
            missing.append(key)
    if missing:
        warnings.append(f"{label}: statistics 缺 {missing}，写 null")
    return out


def build_status_object(sources, paths, label: str, field: str, warnings: list[str]) -> dict:
    """review / visibility 都是固定形状 `{status: N}`：形状固定，值取不到就 null。"""
    value, _ = pick_path(sources, paths)
    number = as_int(value)
    if number is None:
        warnings.append(f"{label}: {field}.status 取不到，写 null")
    return {"status": number}


def build_post(
    list_row: dict, detail: dict | None, warnings: list[str], hints: dict
) -> dict | None:
    """把「列表行 + 详情条目」整形成插件认的作品对象（键名一字不差）。"""
    aweme_id = pick_aweme_id(list_row) or (pick_aweme_id(detail) if detail else None)
    if not aweme_id:
        warnings.append("作品列表里有一条没有 aweme_id，已跳过")
        return None
    label = aweme_id

    # 元数据以列表行为准（列表接口更稳），详情只做兜底。
    meta_sources = [list_row, detail] if isinstance(detail, dict) else [list_row]

    desc = None
    raw_desc = pick_path(meta_sources, DESC_PATHS)[0]
    if isinstance(raw_desc, str):
        # 抖音的 desc 常是多行文案，标题只留第一行。
        first_line = raw_desc.strip().splitlines()[0].strip() if raw_desc.strip() else ""
        desc = first_line or None
    if desc is None:
        warnings.append(f"{label}: 文案为空，desc 写 null")

    create_time = normalize_unix_seconds(pick_path(meta_sources, CREATE_TIME_PATHS)[0])
    if create_time is None:
        warnings.append(f"{label}: 拿不到发布时间，create_time 写 null")

    duration = as_int(pick_path(meta_sources, DURATION_PATHS)[0])
    if duration is None:
        warnings.append(f"{label}: 拿不到时长，duration 写 null")

    media_type = as_int(pick_path(meta_sources, MEDIA_TYPE_PATHS)[0])
    cover = pick_cover(meta_sources)
    if cover is None:
        warnings.append(f"{label}: 拿不到封面，cover 写 null")

    share_url = as_text(pick_path(meta_sources, SHARE_URL_PATHS)[0])
    if share_url is None:
        # 兜底拼一个，这比 null 有用：插件拿它当作品链接与去重键。
        share_url = f"https://www.douyin.com/video/{aweme_id}"

    if isinstance(detail, dict):
        metrics = build_metrics(detail, list_row, label, warnings, hints)
        statistics = build_statistics((detail, list_row), label, warnings)
        status_sources = (detail, list_row)
    else:
        warnings.append(f"{label}: 详情接口没返回这一条，metrics 写 null")
        metrics = None
        statistics = build_statistics((list_row,), label, warnings)
        status_sources = (list_row,)

    review = build_status_object(status_sources, REVIEW_PATHS, label, "review", warnings)
    visibility = build_status_object(status_sources, VISIBILITY_PATHS, label, "visibility", warnings)

    return {
        "aweme_id": aweme_id,
        "desc": desc,
        "create_time": create_time,
        "media_type": media_type,
        "duration": duration,
        "cover": cover,
        "share_url": share_url,
        "metrics": metrics,
        "statistics": statistics,
        "review": review,
        "visibility": visibility,
    }


# ---------------------------------------------------------------------------
# fetch：接口调用
# ---------------------------------------------------------------------------


def probe(client: DouyinClient, warnings: list[str]) -> bool:
    """连通性探针：upgrade 接口未登录也返回 status_code 0，所以它只证明「网络通了」。"""
    try:
        client.get_json(probe_url(client.base_url))
    except ApiError:
        raise
    except SyncError as error:
        warnings.append(f"连通性探针失败（{error}），继续尝试作品列表")
        return False
    return True


def fetch_account_info(client: DouyinClient, account: str, warnings: list[str]) -> dict:
    """账号信息。

    这个接口在 secsdk 签名白名单里（signVersion 2），裸 HTTP 大概率拿不到数据——
    拿不到就记 warning 跳过，**不为此失败**；nickname 缺省时用 --account 的值兜底。
    """
    info = {"uid": None, "name": None, "follower": None}
    try:
        payload = client.get_json(user_info_url(client.base_url))
    except ApiError:
        raise
    except SyncError as error:
        warnings.append(f"账号信息接口取数失败（{error}），uid/name/follower 写 null")
        payload = {}

    sources = [as_dict(payload.get("user")), as_dict(payload.get("data")), payload]
    info["uid"] = coerce_id(pick_path(sources, ACCOUNT_UID_PATHS)[0])
    info["name"] = as_text(pick_path(sources, ACCOUNT_NAME_PATHS)[0])
    info["follower"] = as_int(pick_path(sources, ACCOUNT_FOLLOWER_PATHS)[0])

    if info["name"] is None:
        info["name"] = account
        warnings.append(
            "账号信息接口没给昵称，name 用 --account 的值兜底（真实昵称请以网页端为准）"
        )
    return info


def fetch_work_list(client: DouyinClient, max_posts: int, warnings: list[str]) -> list[dict]:
    """翻页拉作品列表：max_cursor + has_more，直到拿满 --max。"""
    rows: list[dict] = []
    seen: set[str] = set()
    cursor = "0"
    pages = 0
    platform_switched = False

    while len(rows) < max_posts:
        if pages >= MAX_PAGES:
            warnings.append(f"列表翻了 {MAX_PAGES} 页仍未拿满 {max_posts} 条，已停止翻页")
            break
        try:
            payload = client.get_json(
                work_list_url(client.base_url, cursor, PAGE_SIZE, client.platform)
            )
        except ApiError as error:
            # 只在第一次请求时回退一次网关参数；之后任何异常都直接抛（auth/risk 已在 raise_for_status 里分好类）。
            if pages == 0 and not platform_switched and error.exit_code == EXIT_ERROR:
                warnings.append(
                    f"列表接口用 aid={PLATFORM_PRIMARY['aid']}/{PLATFORM_PRIMARY['device_platform']} "
                    f"返回异常（code={error.code}），改用 "
                    f"aid={PLATFORM_FALLBACK['aid']}/{PLATFORM_FALLBACK['device_platform']} 重试一次"
                )
                client.platform = dict(PLATFORM_FALLBACK)
                platform_switched = True
                continue
            raise

        pages += 1
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            if pages == 1:
                warnings.append("作品列表第 1 页是空的，账号下可能还没有作品")
            break

        for raw in items:
            if not isinstance(raw, dict):
                continue
            aweme_id = pick_aweme_id(raw)
            if not aweme_id:
                warnings.append(f"列表第 {pages} 页有一条取不到 aweme_id，已跳过")
                continue
            if aweme_id in seen:
                continue
            seen.add(aweme_id)
            rows.append(raw)
            if len(rows) >= max_posts:
                break

        if not truthy(payload.get("has_more")):
            break
        next_cursor = coerce_id(payload.get("max_cursor"))
        if not next_cursor or next_cursor == cursor:
            warnings.append(f"has_more 为真但 max_cursor 没前进（={next_cursor}），停止翻页以免死循环")
            break
        cursor = next_cursor

    return rows[:max_posts]


def fetch_details(client: DouyinClient, aweme_ids: list[str], warnings: list[str]) -> dict[str, dict]:
    """按批（每批 ≤ 20 个 id）拉详情，返回 id -> 条目。

    单批失败只降级不整体失败：这些作品的 metrics 写 null，其余照常落盘。
    auth / risk 是例外——那说明凭据或频率出了问题，继续跑没有意义。
    """
    index: dict[str, dict] = {}
    batches = [aweme_ids[start : start + MGET_BATCH] for start in range(0, len(aweme_ids), MGET_BATCH)]
    for number, batch in enumerate(batches, start=1):
        url = item_mget_url(client.base_url, batch)
        try:
            payload = client.get_json(url, extra_headers=MGET_EXTRA_HEADERS)
        except ApiError as error:
            if error.exit_code in (EXIT_AUTH, EXIT_RISK):
                raise
            warnings.append(
                f"详情第 {number} 批取数失败（code={error.code}），这 {len(batch)} 条 metrics 写 null"
            )
            continue
        except SyncError as error:
            warnings.append(f"详情第 {number} 批取数失败（{error}），这 {len(batch)} 条 metrics 写 null")
            continue

        items = payload.get("items")
        if not isinstance(items, list):
            warnings.append(f"详情第 {number} 批没有 items 字段，这 {len(batch)} 条 metrics 写 null")
            continue
        for raw in items:
            if not isinstance(raw, dict):
                continue
            item_id = pick_aweme_id(raw)
            if not item_id:
                warnings.append(f"详情第 {number} 批有一条取不到 aweme_id，已忽略")
                continue
            index[item_id] = raw
    return index


def run_fetch(
    *,
    account: str,
    max_posts: int,
    out_path: Path | None,
    base_url: str,
    cookie_header: str,
    sleep: float,
    credential_pairs: list[tuple[str, str]] | None = None,
) -> dict:
    """fetch 的主体：拉数、整形、写盘。返回落盘的那个 payload（自检直接拿它断言）。"""
    warnings: list[str] = []
    hints: dict = {}
    client = DouyinClient(cookie_header, base_url=base_url, throttle=Throttle(sleep))

    field_text = "，".join(
        f"{name}(len={len(value)})" for name, value in (credential_pairs or [])
    )
    if field_text:
        print(f"凭据字段：{field_text}", flush=True)

    reachable = probe(client, warnings)
    print(f"网络：{'可达' if reachable else '探针失败（见 warnings）'}", flush=True)

    account_info = fetch_account_info(client, account, warnings)
    print(
        f"账号：{account_info.get('name')}({account_info.get('uid')}) "
        f"粉丝={account_info.get('follower')}",
        flush=True,
    )

    rows = fetch_work_list(client, max_posts, warnings)
    target = len(rows)
    print(f"待采集作品：{target} 条", flush=True)
    if target == 0:
        warnings.append("没有采到任何作品，posts 为空")

    ids = [pick_aweme_id(row) for row in rows]
    detail_index = fetch_details(client, [item for item in ids if item], warnings)

    posts: list[dict] = []
    for position, row in enumerate(rows, start=1):
        aweme_id = pick_aweme_id(row) or "?"
        print(f"  [{position}/{target}] {aweme_id}", file=sys.stderr, flush=True)
        post = build_post(row, detail_index.get(aweme_id) if aweme_id != "?" else None, warnings, hints)
        if post is None:
            continue
        posts.append(post)

    payload = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "account": account_info,
        "posts": posts,
        "warnings": warnings,
    }

    path = out_path if out_path is not None else default_output_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="")
    return payload


def cmd_fetch(args) -> int:
    account = validate_account(args.account)
    if args.max <= 0:
        raise SyncError("--max 必须是正整数")
    if args.max > MAX_POSTS_LIMIT:
        raise SyncError(
            f"--max 最多 {MAX_POSTS_LIMIT}：一页 20 条，采太多既没意义也更容易被风控"
        )
    if args.sleep < 0:
        raise SyncError("--sleep 不能是负数")

    base_url = resolve_base_url(args.base_url)
    cookie_header, pairs = load_credential(account)
    out_path = Path(args.out).expanduser().resolve() if args.out else None

    payload = run_fetch(
        account=account,
        max_posts=args.max,
        out_path=out_path,
        base_url=base_url,
        cookie_header=cookie_header,
        sleep=args.sleep,
        credential_pairs=pairs,
    )

    warnings = payload["warnings"]
    saved = out_path if out_path is not None else default_output_path()
    print(
        f"已写出：{saved}（{len(payload['posts'])} 条作品，{len(warnings)} 条降级提示）",
        flush=True,
    )
    if warnings:
        print("降级提示：", flush=True)
        for line in warnings[:20]:
            print(f"  - {line}", flush=True)
        if len(warnings) > 20:
            print(f"  … 另有 {len(warnings) - 20} 条，见输出 JSON 的 warnings", flush=True)
    return EXIT_OK


# ---------------------------------------------------------------------------
# whoami
# ---------------------------------------------------------------------------


def cmd_whoami(args) -> int:
    account = validate_account(args.account)
    base_url = resolve_base_url(args.base_url)
    cookie_header, pairs = load_credential(account)
    score_path = credential_path(account)

    print(f"凭据文件：{score_path}")
    print(f"凭据字段：{'，'.join(f'{name}(len={len(value)})' for name, value in pairs)}")

    warnings: list[str] = []
    client = DouyinClient(cookie_header, base_url=base_url, throttle=Throttle(args.sleep))
    reachable = probe(client, warnings)
    print(f"网络：{'可达' if reachable else '探针失败'}")

    state = login_state(base_url, cookie_header, args.sleep)
    if state is False:
        raise SyncError(
            f"work_list 返回 status_code=8（未登录）：{score_path} 已失效，请重新执行 login",
            EXIT_AUTH,
        )
    if state is None:
        print("作品列表：接口返回了非 0 也非 8 的状态码，登录态无法判断（见 warnings）")
        for line in warnings:
            print(f"  - {line}")
        return EXIT_ERROR
    print("作品列表：status_code=0（已登录）")

    info = fetch_account_info(client, account, warnings)
    print(
        f"账号：{info.get('name')}({info.get('uid')}) 粉丝={info.get('follower')}",
        flush=True,
    )
    for line in warnings:
        print(f"  - {line}")
    return EXIT_OK


# ---------------------------------------------------------------------------
# login：极简 WebSocket 客户端（RFC6455）
#
# 为什么手写：仓库约束只用标准库；而 CDP 只需要「发一条文本、收若干条文本、回 pong」，
# 帧格式就这么点，手写反而比引入 websocket-client 少一份依赖与供应链风险。
# ---------------------------------------------------------------------------


class MiniWebSocket:
    """最小 RFC6455 客户端：只处理文本帧、ping/pong、close；不支持扩展与分片压缩。"""

    def __init__(self, url: str, timeout: float = 15.0) -> None:
        self.url = url
        self.timeout = timeout
        self.sock: socket.socket | None = None
        self.buffer = b""

    def connect(self) -> None:
        parts = urllib.parse.urlsplit(self.url)
        if parts.scheme != "ws":
            raise SyncError(f"CDP 的 webSocketDebuggerUrl 不是 ws:// 开头：{self.url}")
        host = parts.hostname or "127.0.0.1"
        port = parts.port or 80
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"

        try:
            sock = socket.create_connection((host, port), timeout=self.timeout)
        except OSError as error:
            raise SyncError(f"连不上 CDP 调试端口 {host}:{port}（{error}）") from error

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        try:
            sock.sendall(request.encode("ascii"))
            header = b""
            while b"\r\n\r\n" not in header:
                chunk = sock.recv(4096)
                if not chunk:
                    raise SyncError("CDP WebSocket 握手失败：连接被对端关闭")
                header += chunk
                if len(header) > 65536:
                    raise SyncError("CDP WebSocket 握手失败：响应头过长")
        except OSError as error:
            sock.close()
            raise SyncError(f"CDP WebSocket 握手失败：{error}") from error

        head, _, rest = header.partition(b"\r\n\r\n")
        first_line = head.split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
        if "101" not in first_line:
            sock.close()
            raise SyncError(f"CDP WebSocket 握手失败：{first_line}")
        self.sock = sock
        self.buffer = rest

    def _recv_exact(self, count: int) -> bytes:
        if self.sock is None:
            raise SyncError("CDP 连接未建立")
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SyncError("CDP 连接被关闭（浏览器可能已退出）")
            self.buffer += chunk
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self.sock is None:
            raise SyncError("CDP 连接未建立")
        header = bytearray()
        header.append(0x80 | opcode)
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_message(self) -> str | None:
        """收一条完整文本消息；ping 自动回 pong；收到 close 帧返回 None。"""
        chunks: list[bytes] = []
        while True:
            first, second = self._recv_exact(2)
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length) if length else b""
            if masked and mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

            if opcode == 0x8:  # close
                return None
            if opcode == 0x9:  # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x1, 0x2, 0x0):
                chunks.append(payload)
                if fin:
                    return b"".join(chunks).decode("utf-8", errors="replace")
                continue
            # 其余保留/控制帧一律忽略

    def close(self) -> None:
        if self.sock is None:
            return
        with contextlib.suppress(Exception):
            self._send_frame(0x8, b"")
        with contextlib.suppress(Exception):
            self.sock.close()
        self.sock = None


class CdpSession:
    """在 MiniWebSocket 上跑 CDP：发命令、按 id 配对回响应，事件帧直接跳过。"""

    def __init__(self, ws: MiniWebSocket) -> None:
        self.ws = ws
        self.next_id = 0

    def call(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        message_id = self.next_id
        message: dict = {"id": message_id, "method": method}
        if params:
            message["params"] = params
        self.ws.send_text(json.dumps(message))
        while True:
            text = self.ws.recv_message()
            if text is None:
                raise SyncError(f"CDP 连接已关闭（等 {method} 的结果时）")
            try:
                reply = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(reply, dict) or reply.get("id") != message_id:
                continue  # 浏览器事件或别的响应，跳过
            if "error" in reply:
                detail = as_dict(reply.get("error"))
                raise SyncError(f"CDP {method} 返回错误：{detail.get('message') or detail}")
            return as_dict(reply.get("result"))


def cdp_evaluate(session: CdpSession, expression: str):
    """在页面里执行 JS（await Promise）并取回 by-value 结果。"""
    result = session.call(
        "Runtime.evaluate",
        {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
            "userGesture": True,
        },
    )
    if result.get("exceptionDetails"):
        details = as_dict(result.get("exceptionDetails"))
        text = details.get("text") or ""
        description = as_dict(details.get("exception")).get("description") or ""
        raise SyncError(f"页面里执行 JS 抛错：{(text or description or '未知错误')}".strip())
    return as_dict(result.get("result")).get("value")


LOGIN_PROBE_TEMPLATE = (
    "(async () => {\n"
    "  const response = await fetch(%URL%, {credentials: 'include'});\n"
    "  const text = await response.text();\n"
    "  try {\n"
    "    const payload = JSON.parse(text);\n"
    "    return JSON.stringify({\n"
    "      status_code: payload.status_code,\n"
    "      items: Array.isArray(payload.items) ? payload.items.length : null,\n"
    "    });\n"
    "  } catch (error) {\n"
    "    return JSON.stringify({status_code: null, items: null, error: String(error).slice(0, 120)});\n"
    "  }\n"
    "})()"
)


def login_probe_expression(base_url: str) -> str:
    url = work_list_url(base_url, "0", 1, PLATFORM_PRIMARY)
    return LOGIN_PROBE_TEMPLATE.replace("%URL%", json.dumps(url))


# ---------------------------------------------------------------------------
# login：浏览器与 CDP
# ---------------------------------------------------------------------------


def find_browser(explicit: str | None) -> str:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise SyncError(f"--browser 指定的浏览器不存在：{path}")
        return str(path)
    for candidate in BROWSER_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    raise SyncError(
        "找不到 Chrome / Edge 可执行文件，请用 --browser <路径> 指定，例如：\n"
        '  python scripts/douyin_sync.py login --browser "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
    )


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe_socket:
        probe_socket.settimeout(0.4)
        return probe_socket.connect_ex(("127.0.0.1", port)) == 0


def launch_browser(browser_path: str, port: int, profile_dir: Path, start_url: str):
    """用独立 profile 启动浏览器并打开调试端口。

    独立 profile 的意义：不碰用户自己正在用的窗口（他的登录态、扩展、书签都不会被动），
    关的时候也只需要关我们自己启动的这个 pid。
    """
    profile_dir.mkdir(parents=True, exist_ok=True)
    arguments = [
        browser_path,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        start_url,
    ]
    try:
        return subprocess.Popen(
            arguments,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError as error:
        raise SyncError(f"启动浏览器失败：{error}") from error


def http_get_json(url: str, timeout: float = 2.0):
    """本地调试端口的探测请求：失败返回 None，不重试、不抛。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError):
        return None


def wait_for_page_target(port: int, deadline: float) -> str:
    """等调试端口开出页面 target，返回它的 webSocketDebuggerUrl。"""
    list_url = f"http://127.0.0.1:{port}/json/list"
    while time.monotonic() < deadline:
        rows = http_get_json(list_url)
        if isinstance(rows, list):
            pages = [
                row
                for row in rows
                if isinstance(row, dict)
                and row.get("type") == "page"
                and isinstance(row.get("webSocketDebuggerUrl"), str)
                and row["webSocketDebuggerUrl"]
            ]
            for row in pages:
                if "creator.douyin.com" in str(row.get("url") or ""):
                    return str(row["webSocketDebuggerUrl"])
            if pages:
                return str(pages[0]["webSocketDebuggerUrl"])
        time.sleep(0.5)
    raise SyncError(
        f"等不到调试端口 {port} 上的页面目标：浏览器可能被安全软件拦住，或端口被占用。"
        "可以换端口重试：--port 9333",
        EXIT_LOGIN_TIMEOUT,
    )


def collect_cookies(session: CdpSession) -> list[tuple[str, str]]:
    """取 cookie：先 Storage.getCookies（全量），再 Network.getCookies（页面域）。

    只留 douyin.com 域的；同名保留最后一次拿到的值。
    """
    collected: dict[str, str] = {}
    requests = (
        ("Storage.getCookies", {}),
        ("Network.getCookies", {"urls": [CREATOR_ORIGIN]}),
    )
    for method, params in requests:
        try:
            result = session.call(method, params)
        except SyncError:
            continue
        rows = result.get("cookies")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = row.get("name")
            value = row.get("value")
            domain = str(row.get("domain") or "")
            if not isinstance(name, str) or not name:
                continue
            if not isinstance(value, str) or value == "":
                continue
            if "douyin.com" not in domain:
                continue
            collected[name] = value
    return ordered_cookie_pairs(list(collected.items()))


def wait_for_login(
    session: CdpSession, base_url: str, deadline: float
) -> list[tuple[str, str]]:
    """轮询 work_list 判据，直到「不再是未登录」，然后取 cookie。"""
    expression = login_probe_expression(base_url)
    started = time.monotonic()
    last_notice = 0.0
    unknown_notice_shown = False

    while True:
        if time.monotonic() > deadline:
            raise SyncError(
                f"等待扫码超时（{int(LOGIN_TIMEOUT)} 秒），没有检测到登录成功。请重新运行 login",
                EXIT_LOGIN_TIMEOUT,
            )
        try:
            raw = cdp_evaluate(session, expression)
        except SyncError as error:
            # 页面还没加载完 / fetch 暂时失败：继续等，别把一次抖当失败。
            if time.monotonic() - last_notice >= LOGIN_NOTICE_INTERVAL:
                print(f"  仍在等待页面就绪（{error}）", file=sys.stderr, flush=True)
                last_notice = time.monotonic()
            time.sleep(LOGIN_POLL_INTERVAL)
            continue

        probe_result: dict = {}
        if isinstance(raw, str) and raw.strip():
            with contextlib.suppress(json.JSONDecodeError):
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    probe_result = parsed
        code = as_int(probe_result.get("status_code"))

        if code == 0:
            print("  检测到已登录，正在取出 cookie…", flush=True)
            cookies = collect_cookies(session)
            if not cookies:
                raise SyncError("登录成功但一个 douyin.com 的 cookie 都没取到，请重新 login", EXIT_AUTH)
            return cookies
        if code in AUTH_STATUS or code is None:
            elapsed = time.monotonic() - started
            if time.monotonic() - last_notice >= LOGIN_NOTICE_INTERVAL:
                print(
                    f"  状态：等待扫码…（已等 {int(elapsed)} 秒，"
                    f"最长 {int(LOGIN_TIMEOUT)} 秒）",
                    file=sys.stderr,
                    flush=True,
                )
                last_notice = time.monotonic()
            time.sleep(LOGIN_POLL_INTERVAL)
            continue
        if code in RISK_STATUS:
            raise SyncError(
                f"登录态探测拿到风控码 {code}，请停手 10–30 分钟后再试，"
                "或先在浏览器里手动打开一次创作中心",
                EXIT_RISK,
            )
        if not unknown_notice_shown:
            print(
                f"  提示：登录态探测拿到未知状态码 {code}，继续等待（可能需要手动刷新页面）",
                file=sys.stderr,
                flush=True,
            )
            unknown_notice_shown = True
        time.sleep(LOGIN_POLL_INTERVAL)


def close_browser(proc, port: int) -> None:
    """关掉**我们自己启动的**浏览器：先礼后兵（Browser.close → terminate → kill）。"""
    if proc is None:
        return
    version = http_get_json(f"http://127.0.0.1:{port}/json/version", timeout=1.5)
    browser_ws = as_dict(version).get("webSocketDebuggerUrl")
    if isinstance(browser_ws, str) and browser_ws:
        ws = MiniWebSocket(browser_ws, timeout=3.0)
        try:
            ws.connect()
            CdpSession(ws).call("Browser.close", {})
        except SyncError:
            pass
        finally:
            ws.close()
    try:
        proc.wait(timeout=8)
        return
    except subprocess.TimeoutExpired:
        pass
    with contextlib.suppress(Exception):
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(Exception):
            proc.kill()
        with contextlib.suppress(Exception):
            proc.wait(timeout=5)


def cleanup_profile(profile_dir: Path) -> bool:
    """删掉登录用的独立 profile。

    那个目录里是一份**活的**登录态：cookie、LocalStorage、缓存全在，能直接续上账号。
    既然凭据已经单独落 `config/douyin_<account>.txt`，留它只是把一份登录态摊在 `tmp/` 里，
    所以默认删掉；只有想复用这份登录态重试时才加 `--keep-profile`。
    """
    if not profile_dir.exists():
        return False
    shutil.rmtree(profile_dir, ignore_errors=True)
    return not profile_dir.exists()


def cmd_login(args) -> int:
    account = validate_account(args.account)
    base_url = resolve_base_url(args.base_url)
    path = credential_path(account)

    if not args.force and path.is_file():
        existing = None
        with contextlib.suppress(SyncError):
            existing = load_credential(account)[0]
        if existing:
            state = login_state(base_url, existing)
            if state is True:
                print(f"已登录，无需重扫（凭据：{path}）；要重新登录请加 --force")
                return EXIT_OK
            if state is False:
                print("上次的 cookie 已失效（work_list 返回 status_code=8），进入扫码登录", flush=True)
            else:
                print("无法判断现有 cookie 是否有效（接口异常），进入扫码登录", flush=True)

    if port_in_use(args.port):
        raise SyncError(
            f"端口 {args.port} 已被占用（可能是上次没关掉的调试浏览器，或你自己开的浏览器）。\n"
            "请换一个端口重试：--port 9333"
        )

    browser = find_browser(args.browser)
    profile_dir = browser_profile_dir(account)
    scan_url = f"{base_url}{MANAGE_PATH}"

    print(f"浏览器：{browser}", flush=True)
    print(f"独立 profile：{profile_dir}", flush=True)
    print(
        f"已打开浏览器，请扫码：在弹出的窗口里用抖音 App 扫码登录（最长等 {int(args.timeout)} 秒）",
        file=sys.stderr,
        flush=True,
    )

    proc = launch_browser(browser, args.port, profile_dir, scan_url)
    cookies: list[tuple[str, str]] = []
    try:
        devtools_deadline = time.monotonic() + min(DEVTOOLS_WAIT, max(5.0, args.timeout))
        page_ws = wait_for_page_target(args.port, devtools_deadline)
        ws = MiniWebSocket(page_ws)
        ws.connect()
        session = CdpSession(ws)
        try:
            deadline = time.monotonic() + max(5.0, args.timeout)
            cookies = wait_for_login(session, base_url, deadline)
        finally:
            ws.close()
    finally:
        close_browser(proc, args.port)

    if not cookies:
        raise SyncError("没有取到任何 cookie，请重新 login", EXIT_AUTH)
    names = [name for name, _ in cookies]
    if not any(name in ("sessionid", "sessionid_ss", "sid_tt") for name in names):
        print(
            f"  警告：cookie 里没有 sessionid 系列字段（拿到的是 {names}），凭据可能不完整",
            flush=True,
        )

    saved = save_credential(account, cookies)
    cookie_header = cookie_to_header(cookies)
    print(f"  已写入凭据：{saved}")
    print(f"  字段：{'，'.join(f'{n}(len={len(v)})' for n, v in cookies)}", flush=True)

    # 复核一次：浏览器里能读不代表命令行带 cookie 能读（域名/指纹差异），所以真打一发。
    state = login_state(base_url, cookie_header)
    if state is not True:
        raise SyncError(
            "cookie 已落盘，但用普通 HTTP 复核仍未登录（status_code 不是 0）。\n"
            f"请确认扫码确实成功，然后重新运行：python scripts/douyin_sync.py login --account {account}",
            EXIT_AUTH,
        )
    print("  复核通过：命令行带这份 cookie 能读到作品列表", flush=True)
    if args.keep_profile:
        print(f"  独立 profile 保留（--keep-profile）：{profile_dir}", flush=True)
    elif cleanup_profile(profile_dir):
        print(f"  已删除独立 profile（里面是活的登录态，cookie 已单独落盘）：{profile_dir}", flush=True)
    else:
        print(f"  独立 profile 未能删除，建议手动清掉：{profile_dir}", flush=True)
    return EXIT_OK


# ---------------------------------------------------------------------------
# selftest：本地假服务 + 全链路断言（不联网、不开浏览器）
# ---------------------------------------------------------------------------

MOCK_ACCOUNT = {
    "uid": "1234567890",
    "nickname": "示例账号",
    "follower_count": 1234,
}
MOCK_LIST_TOTAL = 15
MOCK_POST_SECONDS = 1794900000


class MockState:
    """自检用的一张可重置的计数器（每个阶段跑之前 reset 一次）。"""

    def __init__(self) -> None:
        self.reset()
        self.login = True

    def reset(self) -> None:
        self.work_list_calls = 0
        self.mget_calls = 0
        self.mget_batch_sizes: list[int] = []
        self.mget_header_ok = True
        self.paths: list[str] = []


def mock_aweme_id(index: int) -> str:
    return f"73000000000000{index:05d}"


def mock_list_row(index: int) -> dict:
    aweme_id = mock_aweme_id(index)
    row = {
        "aweme_id": aweme_id,
        "desc": f"示例作品 {index}\n第二行是正文，不该进 desc",
        "create_time": MOCK_POST_SECONDS + index,
        "media_type": 0,
        "duration": 12345,
        "share_url": f"https://www.douyin.com/video/{aweme_id}",
        "cover": {"url_list": [f"https://example.invalid/cover-{index}.jpg"]},
    }
    if index == 3:
        # 故意给毫秒，验证 create_time 会被 ÷1000。
        row["create_time"] = (MOCK_POST_SECONDS + index) * 1000
    return row


def mock_detail(aweme_id: str, index: int) -> dict | None:
    if index == 2:
        return None  # 详情缺失：metrics 必须写 null
    detail: dict = {"aweme_id": aweme_id, "review": {"status": 2}, "visibility": {"status": 0}}
    if index == 1:
        # 只有 statistics、没有 metrics：验证 view_count/like_count 的候选回退。
        detail["statistics"] = {
            "play_count": 1200,
            "digg_count": 55,
            "comment_count": 7,
            "share_count": 8,
        }
        return detail
    detail["metrics"] = {
        "view_count": 1234,
        "like_count": 56,
        "comment_count": 7,
        "share_count": 8,
        "favorite_count": 9,
        "completion_rate": 0.382,
        "avg_view_second": 7.3,
    }
    return detail


class MockCreatorHandler(http.server.BaseHTTPRequestHandler):
    """假抖音创作中心：work_list 翻两页、item/mget 给假指标、可切换未登录分支。"""

    server_version = "MockDouyinCreator/1.0"
    state: MockState = MockState()

    def log_message(self, format, *args):  # noqa: A002 - 覆写基类签名，别改名
        return

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - 基类约定
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        state = type(self).state
        state.paths.append(parsed.path)

        if parsed.path == WORK_LIST_PATH:
            state.work_list_calls += 1
            if not state.login:
                self._send_json(
                    {
                        "items": [],
                        "has_more": None,
                        "max_cursor": None,
                        "status_code": 8,
                        "status_msg": "用户未登录",
                    }
                )
                return
            cursor = as_int((query.get("max_cursor") or ["0"])[0]) or 0
            if cursor <= 0:
                indexes = list(range(12))
                has_more = True
                next_cursor = 12
            else:
                indexes = list(range(12, MOCK_LIST_TOTAL))
                has_more = False
                next_cursor = None
            self._send_json(
                {
                    "items": [mock_list_row(index) for index in indexes],
                    "has_more": has_more,
                    "max_cursor": next_cursor,
                    "status_code": 0,
                }
            )
            return

        if parsed.path == ITEM_MGET_PATH:
            state.mget_calls += 1
            if self.headers.get("Agw-Js-Conv") != "str":
                state.mget_header_ok = False
            ids = [item for item in (query.get("ids") or [""])[0].split(",") if item]
            state.mget_batch_sizes.append(len(ids))
            if not state.login:
                self._send_json(
                    {
                        "BaseResp": {"Extra": {}, "StatusCode": 8, "StatusMessage": "用户未登录"},
                        "items": [],
                        "status_code": 8,
                        "status_msg": "用户未登录",
                    }
                )
                return
            items = []
            for aweme_id in ids:
                with contextlib.suppress(ValueError):
                    index = int(aweme_id[-5:])
                    detail = mock_detail(aweme_id, index)
                    if detail is not None:
                        items.append(detail)
            self._send_json({"items": items, "status_code": 0})
            return

        if parsed.path == PROBE_PATH:
            self._send_json({"status_code": 0, "data": {}})
            return

        if parsed.path == USER_INFO_PATH:
            self._send_json({"status_code": 0, "user": MOCK_ACCOUNT})
            return

        self._send_json({"status_code": -1, "status_msg": f"假服务没实现 {parsed.path}"}, status=404)


class Checker:
    """极简断言器：只计成功/失败并打印，不抛异常（一失败就停会看不到后面还有多少问题）。"""

    def __init__(self) -> None:
        self.total = 0
        self.passed = 0
        self.failures: list[str] = []

    def check(self, ok: bool, label: str) -> bool:
        self.total += 1
        if ok:
            self.passed += 1
            print(f"  ok   {label}")
        else:
            self.failures.append(label)
            print(f"  FAIL {label}")
        return ok


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    """在进程内跑一遍命令行，捕获 stdout/stderr。"""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


def _keys(value) -> list[str]:
    return sorted(value.keys()) if isinstance(value, dict) else []


def cmd_selftest(args) -> int:
    checker = Checker()
    work_dir = workspace_paths()["tmp_dir"] / f"douyin-selftest-{os.getpid()}"
    config_dir_path = work_dir / "config"
    out_path = work_dir / "douyin-import.json"
    config_dir_path.mkdir(parents=True, exist_ok=True)

    saved_env = {key: os.environ.get(key) for key in (ENV_BASE_URL, ENV_CONFIG_DIR)}
    state = MockState()
    MockCreatorHandler.state = state
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockCreatorHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)

    try:
        fake_cookie_value = "fake-sessionid-value-0001"
        credential_file = config_dir_path / "douyin_selftest.txt"
        credential_file.write_text(
            json.dumps({"sessionid": fake_cookie_value, "ttwid": "fake-ttwid-value"}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.environ[ENV_BASE_URL] = f"http://127.0.0.1:{port}"
        os.environ[ENV_CONFIG_DIR] = str(config_dir_path)

        thread.start()

        # ---- 阶段 1：正常路径（15 条，翻两页） ----
        code, stdout_text, _ = run_cli(
            [
                "fetch",
                "--account",
                "selftest",
                "--max",
                str(MOCK_LIST_TOTAL),
                "--sleep",
                "0",
                "--out",
                str(out_path),
            ]
        )
        checker.check(code == EXIT_OK, f"fetch 正常路径退出码为 0（实际 {code}）")
        checker.check(state.work_list_calls == 2, f"work_list 翻了两页（实际 {state.work_list_calls} 次）")
        checker.check(
            state.mget_calls == 1 and state.mget_batch_sizes == [MOCK_LIST_TOTAL],
            f"15 个 id 只发一批（实际 {state.mget_calls} 批，批量 {state.mget_batch_sizes}）",
        )
        checker.check(state.mget_header_ok, "mget 每次请求都带了 Agw-Js-Conv: str")
        checker.check(
            "status_code=8" not in stdout_text and fake_cookie_value not in stdout_text,
            "stdout 不含 cookie 值",
        )

        payload = json.loads(out_path.read_text(encoding="utf-8"))
        posts = payload.get("posts") or []
        warnings = payload.get("warnings") or []

        checker.check(
            _keys(payload) == ["account", "generated_at", "posts", "warnings"],
            f"顶层键恰好是 account/generated_at/posts/warnings（实际 {_keys(payload)}）",
        )
        checker.check(len(posts) == MOCK_LIST_TOTAL, f"posts 条数 {MOCK_LIST_TOTAL}（实际 {len(posts)}）")
        checker.check(
            _keys(posts[0] if posts else {})
            == [
                "aweme_id",
                "cover",
                "create_time",
                "desc",
                "duration",
                "media_type",
                "metrics",
                "review",
                "share_url",
                "statistics",
                "visibility",
            ],
            f"post 键集合与契约一致（实际 {_keys(posts[0] if posts else {})}）",
        )
        checker.check(
            _keys((posts[0] if posts else {}).get("metrics"))
            == [
                "avg_view_second",
                "comment_count",
                "completion_rate",
                "favorite_count",
                "like_count",
                "share_count",
                "view_count",
            ],
            "metrics 键集合与契约一致（7 个）",
        )
        checker.check(
            _keys((posts[0] if posts else {}).get("statistics"))
            == ["comment_count", "digg_count", "play_count", "share_count"],
            "statistics 键集合与契约一致（4 个）",
        )
        checker.check(
            all(
                isinstance(post.get("review"), dict)
                and _keys(post["review"]) == ["status"]
                and isinstance(post.get("visibility"), dict)
                and _keys(post["visibility"]) == ["status"]
                for post in posts
            )
            and bool(posts),
            "review / visibility 都是 {status} 形状",
        )
        checker.check(
            all(
                isinstance(post.get("create_time"), int) and 0 < post["create_time"] < 100_000_000_000
                for post in posts
            ),
            "create_time 全是秒级时间戳",
        )
        checker.check(
            len(posts) > 3 and posts[3]["create_time"] == MOCK_POST_SECONDS + 3,
            "毫秒时间戳被 ÷1000（1794900003000 → 1794900003）",
        )
        checker.check(
            all(post.get("duration") == 12345 for post in posts),
            "duration 原样保留毫秒",
        )
        checker.check(
            (posts[0].get("metrics") or {}).get("completion_rate") == 38.2
            and any("猜" in line for line in warnings),
            "completion_rate 0.382 → 38.2 并记了「猜」的 warning",
        )
        checker.check(
            (posts[1].get("metrics") or {}).get("view_count") == 1200,
            "metrics.view_count 回退到 statistics.play_count（1200）",
        )
        checker.check(
            posts[2].get("metrics") is None and any("详情" in line for line in warnings),
            "缺详情的作品 metrics 为 null 并记了 warning",
        )
        checker.check(
            (posts[1].get("metrics") or {}).get("favorite_count") is None
            and (posts[2].get("statistics") or {}).get("play_count") is None,
            "取不到的字段是 null，不是 0",
        )
        checker.check(
            isinstance(warnings, list) and warnings and all(isinstance(line, str) for line in warnings),
            "warnings 是非空字符串数组",
        )
        checker.check(
            payload.get("account", {}).get("uid") == MOCK_ACCOUNT["uid"]
            and payload.get("account", {}).get("name") == MOCK_ACCOUNT["nickname"]
            and payload.get("account", {}).get("follower") == MOCK_ACCOUNT["follower_count"],
            "account 的 uid/name/follower 都取到了",
        )
        checker.check(
            posts
            and posts[0].get("desc") == "示例作品 0"
            and str(posts[0].get("cover", "")).startswith("https://")
            and posts[0].get("share_url", "").endswith(str(posts[0].get("aweme_id"))),
            "desc 只留首行、cover 是 URL、share_url 指向作品页",
        )

        # ---- 阶段 2：--max 截断 ----
        state.reset()
        short_path = work_dir / "douyin-import-max5.json"
        code, _, _ = run_cli(
            [
                "fetch",
                "--account",
                "selftest",
                "--max",
                "5",
                "--sleep",
                "0",
                "--out",
                str(short_path),
            ]
        )
        short_payload = json.loads(short_path.read_text(encoding="utf-8"))
        checker.check(
            code == EXIT_OK and len(short_payload.get("posts") or []) == 5,
            f"--max 5 只采 5 条（实际 {len(short_payload.get('posts') or [])} 条，退出码 {code}）",
        )

        # ---- 阶段 3：未登录分支（status_code=8 → 退出码 2，且不重试） ----
        state.reset()
        state.login = False
        unlogged_path = work_dir / "douyin-import-unlogged.json"
        code, _, stderr_text = run_cli(
            [
                "fetch",
                "--account",
                "selftest",
                "--max",
                "5",
                "--sleep",
                "0",
                "--out",
                str(unlogged_path),
            ]
        )
        checker.check(code == EXIT_AUTH, f"未登录时退出码为 2（实际 {code}）")
        checker.check(
            state.work_list_calls == 1,
            f"未登录时 work_list 只请求一次、不重试（实际 {state.work_list_calls} 次）",
        )
        checker.check(
            "未登录" in stderr_text or "cookie" in stderr_text,
            "未登录时 stderr 提示重新 login",
        )

        # 独立 profile 清理：登录成功后那份活登录态不该留在 tmp/
        probe_profile = work_dir / "profile-probe"
        (probe_profile / "Default").mkdir(parents=True, exist_ok=True)
        (probe_profile / "Default" / "Cookies").write_text("mock", encoding="utf-8")
        checker.check(cleanup_profile(probe_profile) is True, "登录成功后能删除独立 profile")
        checker.check(not probe_profile.exists(), "删除后 profile 目录确实不存在")
        checker.check(cleanup_profile(probe_profile) is False, "profile 本来就不存在时删除返回 False 而不抛错")
        login_help = build_parser().parse_args(["login"]).keep_profile
        checker.check(login_help is False, "--keep-profile 默认关闭（默认删 profile）")
    finally:
        with contextlib.suppress(Exception):
            server.shutdown()
        with contextlib.suppress(Exception):
            server.server_close()
        with contextlib.suppress(Exception):
            thread.join(timeout=5)
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(work_dir, ignore_errors=True)

    if checker.failures:
        print(f"selftest: {checker.passed}/{checker.total} passed，失败 {len(checker.failures)} 条：")
        for line in checker.failures:
            print(f"  - {line}")
        return EXIT_ERROR
    print(f"selftest: {checker.passed}/{checker.total} passed")
    return EXIT_OK


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="douyin_sync.py",
        description=(
            "抖音创作中心采集器（独立脚本，插件本体不联网）。\n"
            "login 用浏览器 CDP 扫码登录，把 cookie 存到 <工作区根>/config/douyin_<account>.txt；\n"
            "fetch 采集作品列表与每篇的指标，产出 JSON 给插件导入；\n"
            "whoami 只验证凭据是否还有效；selftest 用本地假服务自检输出契约。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "退出码：0 成功；1 一般错误；2 未登录/凭据失效（需重新 login）；"
            "3 被风控（降频重试）；4 等待扫码超时。\n"
            "例子：\n"
            "  python scripts/douyin_sync.py login\n"
            "  python scripts/douyin_sync.py fetch --max 50\n"
            "  python scripts/douyin_sync.py selftest\n"
        ),
    )
    subparsers = parser.add_subparsers(dest="command", metavar="{login,fetch,whoami,selftest}")

    login_parser = subparsers.add_parser(
        "login",
        help="用浏览器扫码登录，把 cookie 写进 config/douyin_<account>.txt",
        description=(
            "启动一个独立 profile 的浏览器（不碰你自己开着的窗口），打开创作中心内容管理页，\n"
            "你在那个窗口里扫码；脚本通过 CDP 轮询作品列表接口判断是否登录成功，\n"
            "成功后取出 douyin.com 的 cookie 落盘，并用命令行复核一次。\n"
            "cookie 值不会打印到终端，只打印字段名与长度。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    login_parser.add_argument(
        "--account",
        default="main",
        metavar="NAME",
        help="账号简称，决定凭据文件名 douyin_<NAME>.txt（默认 main）",
    )
    login_parser.add_argument(
        "--port",
        type=int,
        default=9222,
        metavar="PORT",
        help="浏览器远程调试端口（默认 9222；被占用时换一个，如 9333）",
    )
    login_parser.add_argument(
        "--browser",
        default=None,
        metavar="PATH",
        help="浏览器可执行文件路径（默认自动探测 Chrome / Edge）",
    )
    login_parser.add_argument(
        "--timeout",
        type=float,
        default=LOGIN_TIMEOUT,
        metavar="SEC",
        help=f"等扫码的最长秒数（默认 {int(LOGIN_TIMEOUT)}，超时退出码 4）",
    )
    login_parser.add_argument(
        "--force",
        action="store_true",
        help="已有凭据且仍有效时也重新扫码",
    )
    login_parser.add_argument(
        "--keep-profile",
        action="store_true",
        help="登录成功后保留浏览器独立 profile（默认删掉：那里面是一份活的登录态）",
    )
    login_parser.add_argument(
        "--base-url",
        default=None,
        metavar="URL",
        help="覆盖线上域名（默认 https://creator.douyin.com，只用于排查）",
    )
    login_parser.set_defaults(handler=cmd_login)

    fetch_parser = subparsers.add_parser(
        "fetch",
        help="采集作品列表与指标，产出 tmp/douyin-import.json",
        description=(
            "先翻页拉作品列表（max_cursor + has_more），再按批（每批 ≤ 20 个 id）调 item/mget\n"
            "拿指标，合并成一个 JSON。单篇详情失败只降级（metrics 写 null）不整体失败；\n"
            "status_code=8 视为凭据失效（退出码 2），352/412/2154 视为风控（退出码 3）。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    fetch_parser.add_argument(
        "--account",
        default="main",
        metavar="NAME",
        help="账号简称，读 config/douyin_<NAME>.txt（默认 main）",
    )
    fetch_parser.add_argument(
        "--max",
        type=int,
        default=50,
        metavar="N",
        help=f"最多采集多少篇作品（默认 50，上限 {MAX_POSTS_LIMIT}）",
    )
    fetch_parser.add_argument(
        "--sleep",
        type=float,
        default=MIN_REQUEST_INTERVAL,
        metavar="SEC",
        help=f"两次请求之间的最小间隔秒数（默认 {MIN_REQUEST_INTERVAL}，别调到 0.35 以下）",
    )
    fetch_parser.add_argument(
        "--out",
        default=None,
        metavar="PATH",
        help="输出 JSON 路径（默认 <工作区根>/tmp/douyin-import.json；相对路径按当前目录解析）",
    )
    fetch_parser.add_argument(
        "--base-url",
        default=None,
        metavar="URL",
        help="覆盖线上域名（默认 https://creator.douyin.com，只用于排查与自检）",
    )
    fetch_parser.set_defaults(handler=cmd_fetch)

    whoami_parser = subparsers.add_parser(
        "whoami",
        help="只验证凭据是否还有效，不写文件",
        description=(
            "做一次连通性探针，再用作品列表接口判断登录态，最后尝试取账号信息。\n"
            "凭据失效返回 2；接口返回非 0 非 8 的状态码返回 1（登录态无法判断）。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    whoami_parser.add_argument(
        "--account",
        default="main",
        metavar="NAME",
        help="账号简称，读 config/douyin_<NAME>.txt（默认 main）",
    )
    whoami_parser.add_argument(
        "--sleep",
        type=float,
        default=MIN_REQUEST_INTERVAL,
        metavar="SEC",
        help=f"两次请求之间的最小间隔秒数（默认 {MIN_REQUEST_INTERVAL}）",
    )
    whoami_parser.add_argument(
        "--base-url",
        default=None,
        metavar="URL",
        help="覆盖线上域名（默认 https://creator.douyin.com，只用于排查与自检）",
    )
    whoami_parser.set_defaults(handler=cmd_whoami)

    selftest_parser = subparsers.add_parser(
        "selftest",
        help="起本地假服务自检 fetch 全链路（不联网、不开浏览器）",
        description=(
            "在 127.0.0.1 上起一个假抖音创作中心，模拟 work_list 翻两页、item/mget 返回假指标，\n"
            "以及一个未登录分支，断言输出 JSON 的键名与契约一致、翻页数量正确、未登录退出码为 2。\n"
            "全程只走本地回环，不启动浏览器、不访问公网。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    selftest_parser.set_defaults(handler=cmd_selftest)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return EXIT_ERROR
    try:
        return args.handler(args)  # type: ignore[misc]
    except SyncError as error:
        print(f"错误：{error}", file=sys.stderr)
        return error.exit_code
    except KeyboardInterrupt:
        print("已中断（cookie 可能只写了一半，必要时重新 login）", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
