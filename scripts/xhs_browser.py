# -*- coding: utf-8 -*-
"""小红书登录用的「本机浏览器会话」模块（纯标准库）。

为什么不用纯 HTTP：小红书登录接口 `edith.xiaohongshu.com/api/sns/web/v1/login/qrcode/create`
强制校验 `x-s` 签名头，纯 HTTP 请求固定返回 `HTTP 406 {"code":-1,"success":false}`，拿不到二维码。
所以改成借本机已装的 Chrome / Edge：用 `--remote-debugging-port` 起一个**临时 profile** 的浏览器，
导航到创作中心登录页，让人在窗口里用 App 扫码，脚本通过 CDP（Chrome DevTools Protocol）
轮询 cookie，拿到 `web_session` 就算登录成功。

设计要点：
- 只用标准库：socket / ssl / base64 / struct / json / subprocess / tempfile / urllib / os / time / shutil。
- 绝不碰用户正在用的浏览器 profile：`--user-data-dir` 指向自己建的临时目录，退出时删掉。
- 所有 socket 都有超时，任何等待都有 deadline，不会把脚本永久挂住。
- 只认自己起的那个进程（按 PID 关），不会误杀用户已经开着的 chrome。

对外接口（被 scripts/xhs_login.py 使用）：

    find_browser(kind=None) -> str
    BrowserSession(executable=None, port=9333, profile_dir=None, wait_timeout=20, headless=False)
        .open(url, timeout=30) / .evaluate(expr, await_promise=False, timeout=30)
        .cookie_dict(domain_suffix="xiaohongshu.com") / .wait_cookie(name, timeout=300, interval=2.0)
        .close()
    WSClient(url, timeout=20)   # 最小 RFC6455 客户端（文本帧）
"""

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# 浏览器路径
# ---------------------------------------------------------------------------

# 按「先 Chrome 后 Edge」的顺序探测。注意 32/64 位安装位置不同，两处都列。
BROWSER_PATHS = {
    "chrome": [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
    ],
    "edge": [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\Edge\Application\msedge.exe"),
    ],
}

# 依次探测的候选路径（chrome 全部 + edge 全部）；find_browser() 按这个顺序找。
CHROME_CANDIDATES = BROWSER_PATHS["chrome"] + BROWSER_PATHS["edge"]

# 端口从 9333 起最多试 10 个。
PORT_TRIES = 10

# Chrome 自己的启动参数：下面这几个是「干净起一个一次性浏览器」的最小集合。
# --disable-blink-features=AutomationControlled 很关键：默认 profile 里 navigator.webdriver
# 会是 true，小红书的登录页会用它做风控判定，去掉它扫码流程更接近真人。
# --disable-search-engine-choice-screen 是 Chrome 128+ 首次启动的搜索引擎选择弹窗，
# 它会在临时 profile 里抢焦点，导致「窗口已弹出」时用户看到的其实是那个弹窗。
COMMON_FLAGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-search-engine-choice-screen",
    "--disable-popup-blocking",
    "--disable-features=Translate",
    "--lang=zh-CN",
]


class BrowserError(RuntimeError):
    """浏览器相关失败（找不到浏览器、CDP 握手失败、等 cookie 超时等）。中文信息直接给用户看。"""


def _first_existing(paths):
    for path in paths:
        if path and os.path.isfile(path):
            return path
    return None


def find_browser(kind=None):
    """返回可用的 Chrome/Edge 可执行文件路径；都找不到就抛 BrowserError。

    kind 为 None 时按 CHROME_CANDIDATES 顺序（先 Chrome 后 Edge）探测；
    传 "chrome" / "edge" 则只在该浏览器的候选路径里找。
    """
    if kind:
        key = kind.lower()
        if key not in BROWSER_PATHS:
            raise BrowserError(f"不认识的浏览器「{kind}」，只支持 chrome / edge")
        found = _first_existing(BROWSER_PATHS[key])
        if found:
            return found
        tried = "、".join(p for p in BROWSER_PATHS[key] if p)
        raise BrowserError(f"没找到 {key} 的可执行文件，试过这些路径：{tried}")

    found = _first_existing(CHROME_CANDIDATES)
    if found:
        return found
    tried = "、".join(p for p in CHROME_CANDIDATES if p)
    raise BrowserError(
        "没找到 Chrome 或 Edge，本模块需要本机已装其中一个。试过这些路径：" + tried
    )


# ---------------------------------------------------------------------------
# 最小 WebSocket 客户端（RFC6455，只处理 CDP 用到的文本帧）
# ---------------------------------------------------------------------------


class WSClient:
    """够用就行的 WebSocket 客户端：握手 + 文本帧收发 + 分片重组 + ping/pong。

    只用于连 127.0.0.1 上的 CDP 端点（ws://），不处理 wss、不处理扩展协商。
    """

    def __init__(self, url, timeout=20):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "ws":
            raise BrowserError(f"只支持 ws:// 的 CDP 地址，收到：{url}")
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 80
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        self.sock = socket.create_connection((host, port), timeout=timeout)
        # 内部用小超时 + 自旋，方便上层按 deadline 判断，而不是被一次 recv 卡死。
        self.sock.settimeout(0.5)
        self.buf = b""
        self._frag = None
        self._closed = False

        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))

        # 握手响应可能带 body（错误时），也可能和后续帧粘在同一个包里，所以剩下的字节要留着。
        head_buf = b""
        deadline = time.monotonic() + timeout
        while b"\r\n\r\n" not in head_buf:
            if time.monotonic() > deadline:
                self.close()
                raise BrowserError("CDP WebSocket 握手超时（浏览器没响应）")
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout:
                continue
            except OSError as exc:
                self.close()
                raise BrowserError(f"CDP WebSocket 握手失败：{exc}")
            if not chunk:
                self.close()
                raise BrowserError("CDP WebSocket 握手失败：连接被浏览器关闭")
            head_buf += chunk
        head, _, rest = head_buf.partition(b"\r\n\r\n")
        self.buf = rest
        first_line = head.split(b"\r\n")[0]
        if b"101" not in first_line:
            self.close()
            raise BrowserError("CDP WebSocket 握手失败：" + head.decode("utf-8", "replace")[:200])

    # -- 发送 ------------------------------------------------------------

    def _send_frame(self, opcode, data):
        mask = os.urandom(4)
        n = len(data)
        header = bytearray([0x80 | opcode])
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def send(self, text):
        """发一条文本帧。"""
        self._send_frame(0x1, text.encode("utf-8"))

    # -- 接收 ------------------------------------------------------------

    def _parse_pending(self):
        """从缓冲区里切出一条完整帧；不足一帧返回 None（不消耗缓冲区）。"""
        buf = self.buf
        if len(buf) < 2:
            return None
        b1, b2 = buf[0], buf[1]
        length = b2 & 0x7F
        offset = 2
        if length == 126:
            if len(buf) < 4:
                return None
            length = struct.unpack(">H", buf[2:4])[0]
            offset = 4
        elif length == 127:
            if len(buf) < 10:
                return None
            length = struct.unpack(">Q", buf[2:10])[0]
            offset = 10
        # 服务端发的帧不带掩码；万一带了就按 RFC 解一下，别当成数据帧读错位。
        masked = bool(b2 & 0x80)
        if masked:
            if len(buf) < offset + 4:
                return None
            key = buf[offset:offset + 4]
            offset += 4
        if len(buf) < offset + length:
            return None
        payload = buf[offset:offset + length]
        if masked:
            payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
        self.buf = buf[offset + length:]
        return bool(b1 & 0x80), b1 & 0x0F, payload

    def recv(self, timeout=30):
        """读一条完整文本消息。timeout 秒内没读全就抛 BrowserError。"""
        deadline = time.monotonic() + timeout
        while True:
            frame = self._parse_pending()
            if frame is None:
                if time.monotonic() > deadline:
                    raise BrowserError(f"等待浏览器 DevTools 响应超时（{timeout} 秒）")
                try:
                    chunk = self.sock.recv(65536)
                except socket.timeout:
                    continue
                except OSError as exc:
                    raise BrowserError(f"读取 DevTools 连接失败：{exc}")
                if not chunk:
                    raise BrowserError("浏览器断开了 DevTools 连接")
                self.buf += chunk
                continue

            fin, opcode, payload = frame
            if opcode == 0x8:  # close
                raise BrowserError("浏览器关闭了 DevTools 连接")
            if opcode == 0x9:  # ping -> pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong，忽略
                continue
            if opcode in (0x1, 0x2):
                if not fin:
                    self._frag = payload
                    continue
                return payload.decode("utf-8", "replace")
            if opcode == 0x0:  # 续帧
                self._frag = (self._frag or b"") + payload
                if fin:
                    message, self._frag = self._frag, None
                    return message.decode("utf-8", "replace")
                continue
            # 其它控制帧（0xB/0xC 之类）直接忽略
            continue

    def close(self):
        """尽量干净地关掉：发 close 帧、关 socket。重复调用安全。"""
        if self._closed:
            return
        self._closed = True
        try:
            self.sock.sendall(b"\x88\x80" + os.urandom(4))
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 浏览器会话
# ---------------------------------------------------------------------------


def _port_free(port):
    """端口是否空闲（bind 试探）。注意：这里只是降低撞车概率，真正的判断还是 /json/version。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _http_json(url, timeout=2.0):
    """GET 一个 CDP 的 HTTP 接口并解析 JSON（/json/version、/json/list 都是这种）。"""
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


class BrowserSession:
    """起一个临时 profile 的本机浏览器，用 CDP 导航 / 执行 JS / 读 cookie。

    用法：
        with BrowserSession(headless=False) as session:
            session.open("https://creator.xiaohongshu.com/login")
            cookies = session.wait_cookie("web_session", timeout=300)
    """

    def __init__(self, executable=None, port=9333, profile_dir=None, wait_timeout=20, headless=False):
        self.executable = executable or find_browser()
        self.base_port = int(port)
        self.port = None
        self.headless = bool(headless)
        self.wait_timeout = float(wait_timeout)
        # 默认自建唯一临时目录（xhs-login-<随机>），绝不碰用户正在用的 profile。
        self._profile_owned = profile_dir is None
        self.profile_dir = profile_dir or tempfile.mkdtemp(prefix="xhs-login-")
        self.process = None
        self.ws = None
        self.browser_version = None
        self._next_id = 0
        self._page_enabled = False
        self._events = []
        self._closed = False

        try:
            self._launch()
            self._wait_ready()
            self._attach_page()
        except BaseException:
            # 构造阶段失败也要收干净，否则会留下一个孤儿浏览器进程 + 临时 profile。
            self.close()
            raise

    # -- 启动 / 就绪 ------------------------------------------------------

    def _pick_port(self):
        for offset in range(PORT_TRIES):
            candidate = self.base_port + offset
            if _port_free(candidate):
                return candidate
        raise BrowserError(
            f"端口 {self.base_port}~{self.base_port + PORT_TRIES - 1} 全被占用了，"
            "请关掉占用的程序，或用 port= 指定别的起始端口"
        )

    def _launch(self):
        self.port = self._pick_port()
        args = [
            self.executable,
            f"--remote-debugging-port={self.port}",
            f"--user-data-dir={self.profile_dir}",
            *COMMON_FLAGS,
            "--headless=new" if self.headless else "--start-maximized",
            "about:blank",  # 初始 URL：真正的目标页由 open() 导航过去
        ]
        try:
            self.process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise BrowserError(f"启动浏览器失败（{self.executable}）：{exc}")

    def _wait_ready(self):
        """轮询 /json/version 直到 CDP 端点可用。"""
        deadline = time.monotonic() + self.wait_timeout
        url = f"http://127.0.0.1:{self.port}/json/version"
        while True:
            if self.process.poll() is not None:
                raise BrowserError(
                    f"浏览器启动后立刻退出了（退出码 {self.process.returncode}），"
                    "可能是 profile 目录不可写或该浏览器不支持 --remote-debugging-port"
                )
            try:
                info = _http_json(url, timeout=1.0)
            except Exception:
                info = None
            if info and info.get("webSocketDebuggerUrl"):
                self.browser_version = info.get("Browser") or ""
                return
            if time.monotonic() > deadline:
                raise BrowserError(
                    f"浏览器在 {self.wait_timeout:.0f} 秒内没开好调试端口 {self.port}"
                    f"（{os.path.basename(self.executable)}），可能被安全软件拦了，或旧版本不支持"
                )
            time.sleep(0.2)

    def _attach_page(self):
        """找到页面 target 并连上它的 WebSocket。"""
        deadline = time.monotonic() + self.wait_timeout
        target = None
        while True:
            try:
                targets = _http_json(f"http://127.0.0.1:{self.port}/json/list", timeout=2.0)
            except Exception:
                targets = []
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                # 优先挑初始的 about:blank 标签页：headless 下有时会多一个空 target。
                target = next((t for t in pages if (t.get("url") or "").startswith("about:")), pages[0])
                break
            if time.monotonic() > deadline:
                raise BrowserError("浏览器起来了但找不到可用的页面标签页（/json/list 里没有 page）")
            time.sleep(0.2)
        try:
            self.ws = WSClient(target["webSocketDebuggerUrl"], timeout=20)
        except BrowserError:
            raise
        except Exception as exc:  # noqa: BLE001 - 统一收敛成 BrowserError 给用户看
            raise BrowserError(f"连接页面 WebSocket 失败：{exc}")

    # -- CDP 调用 --------------------------------------------------------

    def _call(self, method, params=None, timeout=30):
        """发一条 CDP 命令并等它的响应；顺手把期间收到的事件存进 self._events。"""
        if self.ws is None:
            raise BrowserError("浏览器会话已关闭")
        self._next_id += 1
        call_id = self._next_id
        payload = {"id": call_id, "method": method}
        if params:
            payload["params"] = params
        self.ws.send(json.dumps(payload))

        deadline = time.monotonic() + timeout
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise BrowserError(f"CDP 命令 {method} 超时（{timeout:.0f} 秒）")
            message = json.loads(self.ws.recv(timeout=remain))
            if message.get("id") == call_id:
                error = message.get("error")
                if error:
                    raise BrowserError(f"CDP 命令 {method} 失败：{error.get('message') or error}")
                return message.get("result") or {}
            if message.get("method"):
                self._events.append(message)
                # 只留最近的一小批，避免导航多时内存涨。
                if len(self._events) > 64:
                    del self._events[:-64]

    def _wait_event(self, method, deadline):
        """等一个事件；超时返回 False（不抛）。"""
        for index, event in enumerate(self._events):
            if event.get("method") == method:
                del self._events[index]
                return True
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                return False
            message = json.loads(self.ws.recv(timeout=remain))
            if message.get("method") == method:
                return True
            if message.get("method"):
                self._events.append(message)
                if len(self._events) > 64:
                    del self._events[:-64]

    def _poll_ready_state(self, deadline):
        """兜底：有的导航（about:blank、被拦截的跳转）不发 load 事件，直接看 readyState。"""
        while time.monotonic() < deadline:
            try:
                state = self.evaluate("document.readyState", timeout=3)
            except BrowserError:
                state = None
            if state in ("interactive", "complete"):
                return True
            time.sleep(0.2)
        return False

    # -- 对外能力 --------------------------------------------------------

    def open(self, url, timeout=30):
        """导航当前标签页到 url，等 load 完成。"""
        deadline = time.monotonic() + timeout
        if not self._page_enabled:
            self._call("Page.enable", timeout=10)
            self._page_enabled = True
        result = self._call("Page.navigate", {"url": url}, timeout=min(timeout, 30))
        error_text = result.get("errorText")
        # 有些「错误」是页面自己的（如 ERR_ABORTED on download），仍继续尝试等 load。
        if error_text and error_text not in ("net::ERR_ABORTED",):
            if "ERR_NAME_NOT_RESOLVED" in error_text or "ERR_CONNECTION" in error_text:
                raise BrowserError(f"打开 {url} 失败：{error_text}（检查网络/代理）")
        if not self._wait_event("Page.loadEventFired", deadline):
            if not self._poll_ready_state(deadline):
                if error_text:
                    raise BrowserError(f"打开 {url} 失败：{error_text}")
                raise BrowserError(f"打开 {url} 超时（{timeout:.0f} 秒内没等到页面 load 完成）")

    def evaluate(self, expression, await_promise=False, timeout=30):
        """Runtime.evaluate（returnByValue=True），返回 JS 值；JS 自己抛错则抛 BrowserError。"""
        result = self._call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": bool(await_promise),
                "userGesture": True,
            },
            timeout=timeout,
        )
        details = result.get("exceptionDetails")
        if details:
            text = (details.get("exception") or {}).get("description") or details.get("text") or "未知错误"
            raise BrowserError("页面内 JS 执行出错：" + str(text).splitlines()[0][:300])
        value = result.get("result") or {}
        if "value" in value:
            return value["value"]
        if value.get("type") in ("undefined", None) or value.get("subtype") == "null":
            return None
        # 返回的是不可序列化的对象（比如函数），退回描述文本。
        return value.get("description")

    def cookie_dict(self, domain_suffix="xiaohongshu.com"):
        """读全部 cookie，按域名后缀过滤，返回 {name: value}。"""
        result = self._call("Network.getAllCookies", timeout=20)
        suffix = (domain_suffix or "").lstrip(".").lower()
        cookies = {}
        for item in result.get("cookies") or []:
            domain = (item.get("domain") or "").lstrip(".").lower()
            if not suffix or domain == suffix or domain.endswith("." + suffix):
                name = item.get("name")
                if name:
                    cookies[name] = item.get("value") or ""
        return cookies

    def wait_cookie(self, name, timeout=300, interval=2.0, on_tick=None):
        """轮询直到 cookie `name` 出现，返回整份 cookie_dict；超时抛 BrowserError（带已等秒数）。

        on_tick(elapsed, cookies) 每轮调一次，方便调用方打印进度（比如「已等 30 秒」）。
        """
        start = time.monotonic()
        timeout = float(timeout)
        interval = max(0.2, float(interval))
        cookies = {}
        while True:
            cookies = self.cookie_dict()
            if cookies.get(name):
                return cookies
            elapsed = time.monotonic() - start
            if on_tick is not None:
                try:
                    on_tick(elapsed, cookies)
                except Exception:  # noqa: BLE001 - 进度回调不该影响主流程
                    pass
            if elapsed >= timeout:
                seen = "、".join(sorted(cookies)) or "（一个都没有）"
                raise BrowserError(
                    f"等不到 cookie「{name}」：已等 {elapsed:.0f} 秒（超时上限 {timeout:.0f} 秒），"
                    f"窗口里扫码完成了吗？当前已拿到的 cookie：{seen}"
                )
            time.sleep(max(0.0, min(interval, timeout - elapsed)))

    # -- 收尾 ------------------------------------------------------------

    def close(self):
        """关浏览器、清临时 profile。重复调用安全；profile 删不掉就忽略。"""
        if self._closed:
            return
        self._closed = True

        if self.ws is not None:
            try:
                self.ws.close()
            except Exception:  # noqa: BLE001
                pass
            self.ws = None

        process = self.process
        if process is not None:
            if process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    # terminate 不够就按 PID 连子进程一起收（只针对自己起的这个 PID，不动别人的 chrome）
                    try:
                        subprocess.run(
                            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            timeout=15,
                        )
                    except Exception:  # noqa: BLE001
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                except OSError:
                    pass
            self.process = None

        # Chrome 退出后索引/日志文件可能还被占用几百毫秒，重试几次再放弃。
        # 只删自己建的目录：profile_dir 由调用方显式传入时不动它（避免误删别人的东西）。
        if self.profile_dir and self._profile_owned:
            for _ in range(6):
                shutil.rmtree(self.profile_dir, ignore_errors=True)
                if not os.path.exists(self.profile_dir):
                    break
                time.sleep(0.4)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False


__all__ = [
    "BROWSER_PATHS",
    "BrowserError",
    "BrowserSession",
    "CHROME_CANDIDATES",
    "WSClient",
    "find_browser",
]
