#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B站创作中心数据采集器（独立脚本）。

为什么是独立脚本、而不是插件里的代码：
    插件本体（index.js 与 lib/*.js）有一条硬约束——**不联网、不起进程**，
    test/smoke.mjs 里有断言守着它。采集必须联网，所以采集放在这个 Python 脚本里，
    插件只吃它产出的 JSON 文件。两边靠文件解耦：脚本挂了不影响插件，插件升级也不碰脚本。

两个子命令：
    login   扫码登录，把 cookie 存到 <工作区根>/config/bilibili_<account>.txt
    fetch   拉取稿件列表 + 每个稿件的三份数据 + 实时互动数，产出 <工作区根>/tmp/bili-import.json

约定：
    - 只用标准库 + qrcode/pillow（后者只在 login 里用，懒加载，fetch 不付它的导入开销）；
    - cookie 值永不打印，只打印字段名与长度；
    - 工作区根从本文件向上找「同层既有 AGENTS.md 又有 code/」的目录，代码里不写死盘符路径；
    - 缺失字段写 null，不写 0 冒充；降级情况记进输出 JSON 的 warnings。

退出码：
    0  成功
    1  一般错误（网络不通、接口 code != 0、参数不合法、文件读写失败）
    2  cookie 过期或未登录（-101 / nav.isLogin == false），提示重新 login
    3  被风控（-352 / -412），提示降频后再来
    4  二维码失效（86038），提示重新 login
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import re
import sys
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

QRCODE_GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
QRCODE_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
FINGER_SPI_URL = "https://api.bilibili.com/x/frontend/finger/spi"
NAV_URL = "https://api.bilibili.com/x/web-interface/nav"

ARCHIVE_INDEX_URL = "https://member.bilibili.com/x/web/data/archive/index"
ARCHIVE_DETAIL_URL = "https://member.bilibili.com/x/web/data/archive"
DIAGNOSE_OVERVIEW_URL = "https://member.bilibili.com/x/web/data/archive_diagnose/overview"
DIAGNOSE_COMPARE_URL = "https://member.bilibili.com/x/web/data/archive_diagnose/compare"
VIEW_URL = "https://api.bilibili.com/x/web-interface/view"

# 创作中心自己那套 Referer：列表接口一套，单稿接口一套，B站在意这个。
LIST_REFERER = "https://member.bilibili.com/platform/data-center"
VIDEO_REFERER_TPL = "https://member.bilibili.com/platform/upload-manager/article/data/{bvid}"
NAV_REFERER = "https://www.bilibili.com/"

# 请求间隔：列表 + 每稿 3 个接口很容易触发风控，0.35s 是实跑不炸的下限。
MIN_REQUEST_INTERVAL = 0.35
REQUEST_TIMEOUT = 15.0
TRANSPORT_RETRIES = 2  # 只对传输层错误重试，code != 0 不重试（重试也没用还更容易被风控）

PAGE_SIZE = 20          # 列表接口一页 20 条
MAX_PAGES = 50          # 保险丝：50 页 = 1000 条，翻到这儿还没拿满就是接口行为变了
POLL_INTERVAL = 2.0     # 扫码轮询间隔（秒）
POLL_TIMEOUT = 300.0    # 扫码最长等待 5 分钟
QR_TAG_LIMIT = 10       # 观众标签只留前 10

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_AUTH = 2
EXIT_RISK = 3
EXIT_QR_EXPIRED = 4

# 凭据文件的字段顺序：前 7 个是 B 站登录后必有且下游要用的，其余按名字排序追加。
COOKIE_FIELD_ORDER = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
]

# 账号名会拼进文件名，只允许安全字符，避免 --account ../xxx 这种路径穿越。
ACCOUNT_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

RISK_CODES = {-352, -412}
AUTH_CODES = {-101}


# ---------------------------------------------------------------------------
# 错误类型
# ---------------------------------------------------------------------------


class SyncError(Exception):
    """带退出码的错误：main 捕获后打印一句可读中文就退出。"""

    def __init__(self, message: str, exit_code: int = EXIT_ERROR) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class ApiError(SyncError):
    """接口返回 code != 0。"""

    def __init__(self, url: str, code, message, exit_code: int) -> None:
        # 只报接口名与 code/message，绝不带 Cookie 头。
        text = f"接口 {short_url(url)} 返回 code={code}（{message or '无 message'}）"
        super().__init__(text, exit_code)
        self.code = code
        self.url = url


def short_url(url: str) -> str:
    """打日志用：只留 scheme+host+path，去掉 query（里面可能有 qrcode_key）。"""
    parsed = urllib.parse.urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


# ---------------------------------------------------------------------------
# 路径推导
# ---------------------------------------------------------------------------


def find_workspace_root(start: Path) -> Path:
    """向上找工作区根：同层既有 AGENTS.md 又有 code/ 的那层目录。

    只认这两个标记，所以插件仓库自己不会被当成工作区根；找不到就报错，
    而不是退回用户目录——静默写到别处比直接失败更难查。
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


def credential_path(account: str) -> Path:
    return workspace_paths()["config_dir"] / f"bilibili_{account}.txt"


def qr_image_path(account: str) -> Path:
    return workspace_paths()["tmp_dir"] / f"bili-qr-{account}.png"


def default_output_path() -> Path:
    return workspace_paths()["tmp_dir"] / "bili-import.json"


def validate_account(raw: str) -> str:
    account = (raw or "").strip()
    if not ACCOUNT_PATTERN.match(account):
        raise SyncError(
            f"账号名 {raw!r} 不合法：只允许字母、数字、下划线、短横线，长度 1..32"
            "（它会被拼进凭据文件名）"
        )
    return account


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Throttle:
    """保证任意两次请求之间至少间隔 MIN_REQUEST_INTERVAL 秒。"""

    def __init__(self, interval: float = MIN_REQUEST_INTERVAL) -> None:
        self.interval = interval
        self.last = 0.0

    def wait(self) -> None:
        if self.last <= 0.0:
            return
        remain = self.interval - (time.monotonic() - self.last)
        if remain > 0:
            time.sleep(remain)

    def mark(self) -> None:
        self.last = time.monotonic()


def build_headers(referer: str, with_cookie: str | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": DESKTOP_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": referer,
    }
    if with_cookie:
        headers["Cookie"] = with_cookie
    return headers


def open_url(url: str, headers: dict[str, str], opener=None, timeout: float = REQUEST_TIMEOUT):
    """打开 URL 并返回响应体文本。

    传输层错误重试 TRANSPORT_RETRIES 次；HTTP 错误码（4xx/5xx）直接抛，不重试。
    注意这里**不打印** URL 的 query，也不打印任何请求头（Cookie 在里面）。
    """
    attempt = 0
    while True:
        try:
            request = urllib.request.Request(url, headers=headers, method="GET")
            if opener is not None:
                response = opener.open(request, timeout=timeout)
            else:
                response = urllib.request.urlopen(request, timeout=timeout)
            with response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="replace")
        except urllib.error.HTTPError as error:
            # 412 是风控的经典形态，单独给提示；其余按一般错误。
            if error.code == 412:
                raise SyncError(
                    f"{short_url(url)} 返回 HTTP 412（风控拦截），请降低频率后重试",
                    EXIT_RISK,
                ) from error
            raise SyncError(f"{short_url(url)} 返回 HTTP {error.code}") from error
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            attempt += 1
            if attempt > TRANSPORT_RETRIES:
                raise SyncError(f"{short_url(url)} 连接失败：{error}") from error
            time.sleep(1.0 * attempt)


def parse_api_payload(url: str, text: str) -> dict:
    """解析 B站接口包体：code != 0 抛 ApiError，并按码给针对性提示。"""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise SyncError(f"{short_url(url)} 返回的不是 JSON（{error}），可能被风控页拦了") from error
    if not isinstance(payload, dict):
        raise SyncError(f"{short_url(url)} 返回的不是 JSON 对象")
    code = payload.get("code")
    if code != 0:
        message = payload.get("message") or payload.get("msg")
        if code in AUTH_CODES:
            raise ApiError(url, code, f"{message}；cookie 已过期，请重新执行 login", EXIT_AUTH)
        if code in RISK_CODES:
            raise ApiError(url, code, f"{message}；命中风控，请降低频率后重试", EXIT_RISK)
        raise ApiError(url, code, message, EXIT_ERROR)
    return payload


class BiliClient:
    """fetch 用的带 cookie + 限速的轻客户端。"""

    def __init__(self, cookie_header: str, throttle: Throttle | None = None) -> None:
        self.cookie_header = cookie_header
        self.throttle = throttle or Throttle()

    def get_json(self, url: str, referer: str, params: dict | None = None) -> dict:
        full_url = url
        if params:
            full_url = f"{url}?{urllib.parse.urlencode(params)}"
        self.throttle.wait()
        try:
            text = open_url(full_url, build_headers(referer, self.cookie_header))
        finally:
            self.throttle.mark()
        return parse_api_payload(full_url, text)


# ---------------------------------------------------------------------------
# 凭据读写
# ---------------------------------------------------------------------------


def cookie_to_header(pairs: list[tuple[str, str]]) -> str:
    """把 (name, value) 列表拼成单行 cookie 头。"""
    return "; ".join(f"{name}={value}" for name, value in pairs)


def jar_to_pairs(jar: http.cookiejar.CookieJar) -> list[tuple[str, str]]:
    """把 cookie jar 摊平成有序列表：先按 COOKIE_FIELD_ORDER，其余按名字排序。

    同名 cookie 可能有多个（不同 path/domain），后者覆盖前者，最终只留一个。
    """
    collected: dict[str, str] = {}
    for cookie in jar:
        value = cookie.value or ""
        if value == "":
            continue
        collected[cookie.name] = value

    ordered: list[tuple[str, str]] = []
    for name in COOKIE_FIELD_ORDER:
        if name in collected:
            ordered.append((name, collected.pop(name)))
    for name in sorted(collected):
        ordered.append((name, collected[name]))
    return ordered


def serialize_jar(jar: http.cookiejar.CookieJar) -> str:
    return cookie_to_header(jar_to_pairs(jar))


def save_credential(account: str, cookie_line: str) -> Path:
    """写凭据：UTF-8 无 BOM、单行、不带结尾换行。"""
    path = credential_path(account)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(cookie_line, encoding="utf-8", newline="")
    return path


def load_credential(account: str) -> str:
    """读凭据文件并校验关键字段存在；不打印任何值。"""
    path = credential_path(account)
    if not path.is_file():
        raise SyncError(f"凭据文件不存在：{path}\n请先运行：python scripts/bili_sync.py login --account {account}")
    text = path.read_text(encoding="utf-8").replace("\ufeff", "").strip()
    if not text:
        raise SyncError(f"凭据文件是空的：{path}，请重新 login")
    pairs = parse_cookie_line(text)
    names = [name for name, _ in pairs]
    missing = [name for name in ("SESSDATA", "bili_jct") if name not in names]
    if missing:
        raise SyncError(f"凭据文件缺少字段 {missing}：{path}，请重新 login")
    return cookie_to_header(pairs)


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


def describe_cookie_line(line: str) -> str:
    """只输出字段名与长度——排查凭据是否过期用，绝不回显值。"""
    pairs = parse_cookie_line(line)
    return "，".join(f"{name}(len={len(value)})" for name, value in pairs)


# ---------------------------------------------------------------------------
# login
# ---------------------------------------------------------------------------


def _render_qr_image(url: str, target: Path) -> None:
    """把扫码地址渲染成 PNG。qrcode/pillow 在这里懒加载，fetch 不付这个开销。"""
    import qrcode  # noqa: PLC0415  局部导入是刻意的：只有 login 需要

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(str(target))


def _paint_cookie(
    jar: http.cookiejar.CookieJar, name: str, value: str, domain: str = ".bilibili.com"
) -> None:
    """手工往 jar 塞一个 cookie（buvid3/buvid4 是接口发给我们的，不是 Set-Cookie）。"""
    jar.set_cookie(
        http.cookiejar.Cookie(
            version=0,
            name=name,
            value=value,
            port=None,
            port_specified=False,
            domain=domain,
            domain_specified=True,
            domain_initial_dot=domain.startswith("."),
            path="/",
            path_specified=True,
            secure=False,
            expires=None,
            discard=False,
            comment=None,
            comment_url=None,
            rest={"HttpOnly": None},
            rfc2109=False,
        )
    )


def cmd_login(args) -> int:
    account = validate_account(args.account)
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    # 1) 申请二维码
    generate_url = f"{QRCODE_GENERATE_URL}?source=main-fe-header"
    payload = parse_api_payload(
        generate_url, open_url(generate_url, build_headers(NAV_REFERER), opener)
    )
    data = payload.get("data") or {}
    qr_url = (data.get("url") or "").strip()
    qrcode_key = (data.get("qrcode_key") or "").strip()
    if not qr_url or not qrcode_key:
        raise SyncError("二维码接口没给 url 或 qrcode_key，接口可能改版了")

    # 2) 落盘 + 打印路径与 URL（URL 本身就是二维码内容，可以打）
    image_path = qr_image_path(account)
    _render_qr_image(qr_url, image_path)
    print("请用 B站手机客户端扫码登录：")
    print(f"  二维码图片：{image_path}")
    print(f"  二维码内容：{qr_url}")
    print(f"  最长等待 {int(POLL_TIMEOUT)} 秒，每 {int(POLL_INTERVAL)} 秒查询一次状态", flush=True)

    # 3) 轮询扫码状态，用 cookie jar 接住 Set-Cookie
    deadline = time.monotonic() + POLL_TIMEOUT
    scanned_notice_shown = False
    polled = 0
    login_url = ""
    while True:
        if time.monotonic() > deadline:
            raise SyncError(
                f"等待扫码超时（{int(POLL_TIMEOUT)} 秒），请重新运行 login", EXIT_QR_EXPIRED
            )
        time.sleep(POLL_INTERVAL)
        polled += 1
        poll_url = (
            f"{QRCODE_POLL_URL}?qrcode_key={urllib.parse.quote(qrcode_key)}"
            "&source=main-fe-header"
        )
        poll_payload = parse_api_payload(
            poll_url, open_url(poll_url, build_headers(NAV_REFERER), opener)
        )
        poll_data = poll_payload.get("data") or {}
        code = poll_data.get("code")
        login_url = (poll_data.get("url") or "").strip()
        if code == 0:
            break
        if code == 86101:
            if polled == 1:
                print("  状态：等待扫码…", flush=True)
            continue
        if code == 86090:
            if not scanned_notice_shown:
                print("  状态：已扫码，等待手机端确认…", flush=True)
                scanned_notice_shown = True
            continue
        if code == 86038:
            raise SyncError(
                f"二维码已失效（code=86038），请重新运行 login。图片：{image_path}",
                EXIT_QR_EXPIRED,
            )
        if code in AUTH_CODES:
            raise SyncError(f"扫码流程返回 code={code}，请重新运行 login", EXIT_AUTH)
        raise SyncError(
            f"扫码流程返回未知状态码 {code}（{poll_data.get('message') or '无 message'}）"
        )

    # 极少数情况下 SESSDATA 只在 data.url 的 crossDomain 跳转里下发：
    # 只在这一种情况下补一次 GET，正常路径不多打一个请求。
    if not any(cookie.name == "SESSDATA" for cookie in jar):
        if login_url.lower().startswith("http"):
            print("  提示：poll 未直接下发 SESSDATA，补一次 crossDomain 跳转收取 cookie", flush=True)
            open_url(login_url, build_headers(NAV_REFERER), opener)
        if not any(cookie.name == "SESSDATA" for cookie in jar):
            raise SyncError(
                "登录成功但没拿到 SESSDATA，可能是域名策略变化，请重新 login 或手动检查网络"
            )

    # 4) 补 buvid3 / buvid4
    spi_payload = parse_api_payload(
        FINGER_SPI_URL, open_url(FINGER_SPI_URL, build_headers(NAV_REFERER), opener)
    )
    spi = spi_payload.get("data") or {}
    b_3 = (spi.get("b_3") or "").strip()
    b_4 = (spi.get("b_4") or "").strip()
    if b_3:
        _paint_cookie(jar, "buvid3", b_3)
    if b_4:
        _paint_cookie(jar, "buvid4", b_4)
    if not b_3 or not b_4:
        print(f"  警告：finger/spi 只给了 b_3={bool(b_3)} b_4={bool(b_4)}，凭据可能不完整", flush=True)

    # 5) 序列化落盘
    cookie_line = serialize_jar(jar)
    path = save_credential(account, cookie_line)
    print(f"  已写入凭据：{path}")
    print(f"  字段：{describe_cookie_line(cookie_line)}", flush=True)

    # 6) 用 nav 验证一次
    nav_payload = parse_api_payload(
        NAV_URL, open_url(NAV_URL, build_headers(NAV_REFERER, cookie_line))
    )
    nav_data = nav_payload.get("data") or {}
    if nav_data.get("isLogin") is not True:
        raise SyncError(
            "nav 接口返回 isLogin != true，cookie 没有被 B站认下来，请重新 login", EXIT_AUTH
        )
    print(
        f"  验证通过：{nav_data.get('uname')}({nav_data.get('mid')}) "
        f"level={nav_data.get('level')}",
        flush=True,
    )
    return EXIT_OK


# ---------------------------------------------------------------------------
# fetch：取值小工具（缺失一律 None，绝不拿 0 冒充）
# ---------------------------------------------------------------------------


def as_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def as_int(value):
    """转 int；None / 空串 / 非数值 / bool 一律 None。

    B站的「后台还没算出来」和「真的是 0」在接口里长一样（null vs 0 都有），
    所以这里只做类型归一，不猜语义：null 就是 null。
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
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


def pick_int(mapping, key):
    return as_int(as_dict(mapping).get(key))


def pick_str(mapping, key):
    value = as_dict(mapping).get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def format_timestamp(value) -> tuple[str | None, str | None]:
    """秒级时间戳 → ("YYYY-MM-DD HH:MM", "YYYY-MM-DD")；无效时间戳返回 (None, None)。"""
    stamp = as_int(value)
    if not stamp or stamp <= 0:
        return None, None
    try:
        moment = datetime.fromtimestamp(stamp)
    except (OverflowError, OSError, ValueError):
        return None, None
    return moment.strftime("%Y-%m-%d %H:%M"), moment.strftime("%Y-%m-%d")


def pick_first_int(*candidates):
    """按优先级取第一个非 None 的整数（用于 duration 这类多接口都能给的字段）。"""
    for value in candidates:
        number = as_int(value)
        if number is not None:
            return number
    return None


# ---------------------------------------------------------------------------
# fetch：单稿数据整形
# ---------------------------------------------------------------------------


def build_realtime(view_data: dict, bvid: str, warnings: list[str]) -> dict:
    """实时口径：api.bilibili.com/x/web-interface/view 的 stat。

    这个接口是给播放页看的，数字比创作中心「结算」口径新，用于「现在多少人看过」。
    """
    stat = as_dict(view_data.get("stat"))
    if not stat:
        warnings.append(f"{bvid}: view 接口没给 stat，realtime 全部写 null")
    return {
        "play": pick_int(stat, "view"),
        "like": pick_int(stat, "like"),
        "comment": pick_int(stat, "reply"),
        "share": pick_int(stat, "share"),
        "collect": pick_int(stat, "favorite"),
    }


def build_settled(detail_data: dict, bvid: str, warnings: list[str]) -> dict:
    """结算口径：创作中心 archive 接口。stat 可能为 null，group/play 也可能缺。"""
    stat = detail_data.get("stat")
    if stat is None:
        warnings.append(f"{bvid}: 创作中心 archive.stat 为 null，settled 里的互动数写 null")
    elif not isinstance(stat, dict):
        warnings.append(f"{bvid}: 创作中心 archive.stat 类型异常（{type(stat).__name__}）")
    stat = as_dict(stat)
    group = as_dict(detail_data.get("group"))
    play = as_dict(detail_data.get("play"))
    return {
        "play": pick_int(stat, "play"),
        "view": pick_int(play, "view"),
        "like": pick_int(stat, "like"),
        "fav": pick_int(stat, "fav"),
        "reply": pick_int(stat, "reply"),
        "share": pick_int(stat, "share"),
        "coin": pick_int(stat, "coin"),
        "dm": pick_int(stat, "dm"),
        "elec": pick_int(stat, "elec"),
        "fans_play": pick_int(group, "fans"),
        "guest_play": pick_int(group, "guest"),
        "progress_rate": pick_int(play, "rate"),
        "avg_duration": pick_int(play, "avg_duration"),
    }


def build_diagnose(overview_data: dict, bvid: str, warnings: list[str]) -> dict:
    """诊断口径：archive_diagnose/overview。

    注意：这个接口自己也有个 stat，与 archive 的 stat 口径不同。输出结构里没有它的位置
    （下游按固定字段名解析），所以这里只取观众画像相关的字段，不落 stat。
    """
    if not isinstance(overview_data, dict) or not overview_data:
        warnings.append(f"{bvid}: diagnose overview 没有 data，diagnose 全部写 null")
        return {
            "gender": {"male": None, "female": None},
            "age": {"age_one": None, "age_two": None, "age_three": None, "age_four": None},
            "area": None,
            "tags": None,
            "play_proportion": None,
            "audience": {"fans": None, "guest": None},
        }

    gender = as_dict(overview_data.get("gender"))
    age = as_dict(overview_data.get("viewer_age"))
    audience = as_dict(overview_data.get("audience_proportion"))

    # area：可能是 null（新稿件、样本太少），也可能给一个空列表。
    area_raw = overview_data.get("viewer_area")
    area = None
    if isinstance(area_raw, list):
        area = []
        for row in area_raw:
            if not isinstance(row, dict):
                continue
            location = row.get("location")
            area.append({"location": location if isinstance(location, str) else None,
                         "count": as_int(row.get("count"))})
        if not area:
            warnings.append(f"{bvid}: viewer_area 是空列表，area 写 null")
            area = None
    else:
        warnings.append(f"{bvid}: area 为空（接口返回 null），按 null 处理")

    # 观众标签只留前 10 条（B站会给几十条）。
    tags_raw = overview_data.get("viewer_ty")
    tags = None
    if isinstance(tags_raw, list):
        tags = []
        for row in tags_raw:
            if not isinstance(row, dict):
                continue
            name = row.get("tag_name")
            tags.append({"name": name if isinstance(name, str) else None,
                         "count": as_int(row.get("count"))})
            if len(tags) >= QR_TAG_LIMIT:
                break
        if not tags:
            tags = None

    proportion_raw = overview_data.get("play_proportion")
    play_proportion = None
    if isinstance(proportion_raw, dict):
        play_proportion = {key: as_int(value) for key, value in proportion_raw.items()}
    else:
        warnings.append(f"{bvid}: play_proportion 不是对象，写 null")

    return {
        "gender": {"male": pick_int(gender, "male"), "female": pick_int(gender, "female")},
        "age": {
            "age_one": pick_int(age, "age_one"),
            "age_two": pick_int(age, "age_two"),
            "age_three": pick_int(age, "age_three"),
            "age_four": pick_int(age, "age_four"),
        },
        "area": area,
        "tags": tags,
        "play_proportion": play_proportion,
        "audience": {
            "fans": pick_int(audience, "fans"),
            "guest": pick_int(audience, "guest"),
        },
    }


# ---------------------------------------------------------------------------
# fetch：接口调用
# ---------------------------------------------------------------------------


def fetch_index_rows(client: BiliClient, max_posts: int, warnings: list[str]) -> list[dict]:
    """翻页拉列表，直到拿满 --max 或 pager.total。"""
    rows: list[dict] = []
    seen: set[str] = set()
    page = 1
    total = None
    while len(rows) < max_posts:
        if page > MAX_PAGES:
            warnings.append(f"列表翻了 {MAX_PAGES} 页仍未拿满 {max_posts} 条，已停止翻页")
            break
        payload = client.get_json(ARCHIVE_INDEX_URL, LIST_REFERER, {"pn": page, "ps": PAGE_SIZE})
        data = as_dict(payload.get("data"))
        page_rows = data.get("list")
        if not isinstance(page_rows, list) or not page_rows:
            if page == 1:
                warnings.append("列表接口第 1 页就是空的，账号下可能还没有稿件")
            break
        for item in page_rows:
            if not isinstance(item, dict):
                continue
            bvid = pick_str(item, "bvid")
            if not bvid:
                warnings.append(f"列表第 {page} 页有一条没有 bvid，已跳过")
                continue
            if bvid in seen:
                continue
            seen.add(bvid)
            rows.append(item)
            if len(rows) >= max_posts:
                break
        pager = as_dict(data.get("pager"))
        page_total = as_int(pager.get("total"))
        if page_total:
            total = page_total
        if total is not None and page * PAGE_SIZE >= total:
            break
        page += 1
    return rows[:max_posts]


def fetch_compare_index(client: BiliClient, size: int, warnings: list[str]) -> dict:
    """同行对比数据：一次拿一批，按 bvid 建索引，剔除 not_ready_field 里的未就绪字段。

    这个接口在「数据还没算完」时最常见的行为是 code 0 但列表为空/字段不全，
    所以这里把「未就绪」当降级（记 warnings），而把 -101/-352/-412 继续当致命错误。
    """
    try:
        payload = client.get_json(DIAGNOSE_COMPARE_URL, LIST_REFERER, {"size": size})
    except ApiError as error:
        if error.exit_code in (EXIT_AUTH, EXIT_RISK):
            raise
        warnings.append(f"compare 接口取数失败（code={error.code}），compare 整体写空对象")
        return {}

    data = as_dict(payload.get("data"))
    raw_rows = data.get("list")
    if raw_rows is None:
        raw_rows = data.get("items")
    if not isinstance(raw_rows, list) or not raw_rows:
        warnings.append("compare 返回空列表，compare 写空对象（多半是数据还没算完）")
        return {}

    global_not_ready = {
        field for field in as_list_of_str(data.get("not_ready_field"))
    }
    index: dict[str, dict] = {}
    for item in raw_rows:
        if not isinstance(item, dict):
            continue
        bvid = pick_str(item, "bvid")
        if not bvid:
            continue
        stat = as_dict(item.get("stat"))
        not_ready = global_not_ready | {field for field in as_list_of_str(item.get("not_ready_field"))}
        kept = {key: value for key, value in stat.items() if key not in not_ready}
        if not_ready:
            warnings.append(f"{bvid}: compare 未就绪字段已剔除 {sorted(not_ready)}")
        index[bvid] = {key: as_int(value) for key, value in kept.items()}
    return index


def as_list_of_str(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def fetch_one_post(client: BiliClient, index_row: dict, warnings: list[str]) -> dict | None:
    """抓一个稿件的三份数据 + 实时数，整形成输出结构。"""
    bvid = pick_str(index_row, "bvid")
    if not bvid:
        return None
    referer = VIDEO_REFERER_TPL.format(bvid=bvid)

    # 列表接口 → 标题与发布时间
    title = pick_str(index_row, "title")
    published_at, date = format_timestamp(index_row.get("pubtime"))
    if published_at is None:
        published_at, date = format_timestamp(index_row.get("ctime"))
    duration = as_int(index_row.get("duration"))

    # 创作中心单稿详情（结算口径）
    detail = client.get_json(ARCHIVE_DETAIL_URL, referer, {"bvid": bvid})
    detail_data = as_dict(detail.get("data"))
    settled = build_settled(detail_data, bvid, warnings)

    # 诊断概览（观众画像）
    overview = client.get_json(DIAGNOSE_OVERVIEW_URL, referer, {"bvid": bvid})
    diagnose = build_diagnose(as_dict(overview.get("data")), bvid, warnings)

    # 播放页接口（实时口径）
    view = client.get_json(VIEW_URL, referer, {"bvid": bvid})
    view_data = as_dict(view.get("data"))
    realtime = build_realtime(view_data, bvid, warnings)

    aid = pick_int(detail_data, "aid")
    if aid is None:
        aid = pick_int(view_data, "aid")
    if aid is None:
        warnings.append(f"{bvid}: 拿不到 aid，写 null")

    # duration 三个接口都可能给：列表 → 播放页 → 创作中心 play.duration
    duration = pick_first_int(duration, view_data.get("duration"), as_dict(detail_data.get("play")).get("duration"))
    if duration is None:
        warnings.append(f"{bvid}: 三个接口都没给 duration，写 null")

    # 标题兜底：列表偶尔给空，播放页一般有
    if not title:
        title = pick_str(view_data, "title")
    if not title:
        warnings.append(f"{bvid}: 标题为空，写 null")

    return {
        "bvid": bvid,
        "aid": aid,
        "title": title,
        "published_at": published_at,
        "date": date,
        "duration": duration,
        "url": f"https://www.bilibili.com/video/{bvid}",
        "realtime": realtime,
        "settled": settled,
        "diagnose": diagnose,
    }


def fetch_account(client: BiliClient) -> dict:
    """nav 接口拿账号信息，同时顺带验证 cookie 还有效。"""
    payload = client.get_json(NAV_URL, NAV_REFERER)
    data = as_dict(payload.get("data"))
    if data.get("isLogin") is not True:
        raise SyncError(
            "nav.isLogin != true：cookie 已失效，请重新执行 login", EXIT_AUTH
        )
    return {
        "mid": pick_int(data, "mid"),
        "name": pick_str(data, "uname"),
        "level": pick_int(data, "level"),
    }


def cmd_fetch(args) -> int:
    account = validate_account(args.account)
    if args.max <= 0:
        raise SyncError("--max 必须是正整数")
    if args.compare_size <= 0:
        raise SyncError("--compare-size 必须是正整数")

    cookie_header = load_credential(account)
    client = BiliClient(cookie_header)
    warnings: list[str] = []

    account_info = fetch_account(client)
    print(
        f"账号：{account_info.get('name')}({account_info.get('mid')}) "
        f"level={account_info.get('level')}",
        flush=True,
    )
    print(f"凭据字段：{describe_cookie_line(cookie_header)}", flush=True)

    # 4) 同行对比数据：一次调用，按 bvid 建索引
    compare_index = fetch_compare_index(client, args.compare_size, warnings)

    # 1) 列表
    index_rows = fetch_index_rows(client, args.max, warnings)
    target = len(index_rows)
    print(f"待采集稿件：{target} 条", flush=True)

    # 2)+3)+5) 逐稿：archive、diagnose/overview、view
    posts: list[dict] = []
    for position, row in enumerate(index_rows, start=1):
        bvid = pick_str(row, "bvid") or "?"
        print(f"  [{position}/{target}] {bvid}", file=sys.stderr, flush=True)
        post = fetch_one_post(client, row, warnings)
        if post is None:
            continue
        posts.append(post)
        if post["bvid"] not in compare_index:
            warnings.append(f"{post['bvid']}: compare 未就绪（索引里没有这条稿件）")

    # compare 按接口返回原样落盘（可能包含本轮没采的旧稿件），下游按 bvid 查就行，
    # 少落一份就等于静默丢数据；空对象表示这条稿件的对比数据全都没就绪。
    compare_out = dict(compare_index)
    for bvid, fields in compare_out.items():
        if not fields:
            warnings.append(f"{bvid}: compare 这条稿件所有字段都未就绪")

    payload = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "account": account_info,
        "posts": posts,
        "compare": compare_out,
        "warnings": warnings,
    }

    out_path = Path(args.out).expanduser().resolve() if args.out else default_output_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    out_path.write_text(text, encoding="utf-8", newline="")

    print(f"已写出：{out_path}（{len(posts)} 条稿件，{len(warnings)} 条降级提示）", flush=True)
    if warnings:
        print("降级提示：", flush=True)
        for line in warnings[:20]:
            print(f"  - {line}", flush=True)
        if len(warnings) > 20:
            print(f"  … 另有 {len(warnings) - 20} 条，见输出 JSON 的 warnings", flush=True)
    return EXIT_OK


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bili_sync.py",
        description=(
            "B站创作中心采集器（独立脚本，插件本体不联网）。\n"
            "login 扫码登录并把 cookie 存到 <工作区根>/config/bilibili_<account>.txt；\n"
            "fetch 采集稿件数据，产出 JSON 给插件导入。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "退出码：0 成功；1 一般错误；2 cookie 过期（需重新 login）；"
            "3 被风控（降频重试）；4 二维码失效（需重新 login）。\n"
            "例子：\n"
            "  python scripts/bili_sync.py login\n"
            "  python scripts/bili_sync.py fetch --max 50\n"
        ),
    )
    subparsers = parser.add_subparsers(dest="command", metavar="{login,fetch}")

    login_parser = subparsers.add_parser(
        "login",
        help="扫码登录，把 cookie 写进 config/bilibili_<account>.txt",
        description=(
            "申请登录二维码并渲染成 PNG，然后每 2 秒轮询扫码状态（最长 5 分钟）。\n"
            "成功后补 buvid3/buvid4、序列化 cookie 落盘，并用 nav 接口验证一次登录状态。\n"
            "cookie 值不会打印到终端，只打印字段名与长度。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    login_parser.add_argument(
        "--account",
        default="main",
        metavar="NAME",
        help="账号简称，决定凭据文件名 bilibili_<NAME>.txt（默认 main）",
    )
    login_parser.set_defaults(handler=cmd_login)

    fetch_parser = subparsers.add_parser(
        "fetch",
        help="采集稿件数据，产出 tmp/bili-import.json",
        description=(
            "拉取稿件列表，再逐稿抓三份数据（创作中心结算口径、诊断观众画像、播放页实时口径），\n"
            "外加一次同行对比数据，合并成一个 JSON。任意接口 code != 0 即报错退出。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    fetch_parser.add_argument(
        "--account",
        default="main",
        metavar="NAME",
        help="账号简称，读 config/bilibili_<NAME>.txt（默认 main）",
    )
    fetch_parser.add_argument(
        "--max",
        type=int,
        default=50,
        metavar="N",
        help="最多采集多少个稿件（按发布时间倒序，默认 50）",
    )
    fetch_parser.add_argument(
        "--out",
        default=None,
        metavar="PATH",
        help="输出 JSON 路径（默认 <工作区根>/tmp/bili-import.json；相对路径按当前目录解析）",
    )
    fetch_parser.add_argument(
        "--compare-size",
        type=int,
        default=10,
        metavar="N",
        help="同行对比接口一次取多少条（默认 10）",
    )
    fetch_parser.set_defaults(handler=cmd_fetch)
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
