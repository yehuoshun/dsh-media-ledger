# -*- coding: utf-8 -*-
"""小红书扫码登录（薄封装）：借本机浏览器的窗口扫一次码，把 cookie 落到文件。

用法：
    python scripts/xhs_login.py --out <路径> [--browser chrome|edge] [--headless] [--timeout 300]

流程：起临时 profile 的浏览器 → 打开创作中心登录页 → 等 `web_session` cookie →
把 `name=value; name=value; ...`（只取 xiaohongshu.com 域）写进 --out → 用页面内 fetch
自查一次昵称。**只打印 cookie 的字段名和总长度，绝不打印 cookie 值。**

退出码：0 成功；1 失败（没找到浏览器 / 超时 / 其它异常）。
"""

import argparse
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from xhs_browser import BrowserError, BrowserSession, find_browser  # noqa: E402  必须在 sys.path 之后再导入

LOGIN_URL = "https://creator.xiaohongshu.com/login"
COOKIE_DOMAIN = "xiaohongshu.com"
SESSION_COOKIE = "web_session"

# 登录后的自查：用页面自己的 fetch 打一次个人主页接口，只关心昵称。
# 这个接口是创作中心页面自己的 XHR，同源 + 带 cookie 就能问；万一它还要额外签名头也没关系，
# 拿不到昵称只降级提示，不影响「登录成功」这个结论。
NICKNAME_JS = """
(async () => {
  try {
    const resp = await fetch('/api/galaxy/creator/home/personal_info', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    const text = await resp.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    const data = (body && (body.data || body)) || {};
    const name = data.nickname || data.nick_name || data.nickName || data.name
              || data.userName || data.user_name || null;
    return {
      status: resp.status,
      code: body && typeof body.code !== 'undefined' ? body.code : null,
      success: !!(body && (body.success === true || body.code === 0)),
      name: name === null ? null : String(name)
    };
  } catch (err) {
    return { status: 0, code: null, success: false, name: null, error: String(err) };
  }
})()
"""


def build_parser():
    parser = argparse.ArgumentParser(
        prog="xhs_login.py",
        description="小红书扫码登录：借本机 Chrome/Edge 扫码，把 cookie 写到文件（不打印 cookie 值）。",
    )
    parser.add_argument(
        "--out",
        default=os.path.join(tempfile.gettempdir(), "xhs-cookie.txt"),
        # 注意：help 文本里不能出现 %，argparse 会对 help 做 % 格式化，写成 %TEMP% 会直接 ValueError。
        help="cookie 落盘路径，默认是系统临时目录下的 xhs-cookie.txt",
    )
    parser.add_argument(
        "--browser",
        choices=("chrome", "edge"),
        default=None,
        help="指定用哪个浏览器，默认先找 Chrome 再找 Edge",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="无头模式（窗口不显示，只用于自测；真扫码别用）",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=300.0,
        help="等扫码的最长秒数，默认 300",
    )
    return parser


def resolve_executable(kind):
    """按 --browser 取可执行文件；没指定就按候选顺序找。找不到时 find_browser 抛 BrowserError。"""
    return find_browser(kind)


def make_ticker(total):
    """每 10 秒打一行进度，别刷屏。"""
    state = {"next": 10.0}

    def tick(elapsed, cookies):
        if elapsed >= state["next"]:
            print(f"  等待扫码… 已等 {elapsed:.0f}/{total:.0f} 秒（已有 cookie {len(cookies)} 个）", flush=True)
            while state["next"] <= elapsed:
                state["next"] += 10.0

    return tick


def save_cookie_line(path, cookies):
    """把 {name: value} 拼成 "name=value; ..." 写盘，返回 (字段名列表, 总字节数)。"""
    names = list(cookies)
    line = "; ".join(f"{name}={cookies[name]}" for name in names)
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(line)
    return names, len(line.encode("utf-8"))


def self_check(session):
    """登录后自查：取一次昵称。只打印昵称，不打印响应体。"""
    try:
        info = session.evaluate(NICKNAME_JS, await_promise=True, timeout=20)
    except BrowserError as exc:
        print(f"自查：没取到昵称（{exc}），登录本身不受影响")
        return
    if not isinstance(info, dict):
        print("自查：接口返回了非预期结果，跳过昵称打印")
        return
    name = info.get("name")
    if name:
        print(f"自查：当前登录账号昵称 = {name}（HTTP {info.get('status')}）")
        return
    reason = info.get("error") or f"HTTP {info.get('status')} / code={info.get('code')}"
    print(f"自查：接口这次没返回昵称（{reason}），登录本身不受影响")


def main(argv=None):
    args = build_parser().parse_args(argv)

    try:
        executable = resolve_executable(args.browser)
        print(f"浏览器：{executable}")
        if args.headless:
            print("注意：无头模式窗口不可见，只适合自测，真扫码请去掉 --headless")

        with BrowserSession(executable=executable, headless=args.headless, wait_timeout=20) as session:
            print(f"正在打开登录页：{LOGIN_URL}")
            session.open(LOGIN_URL, timeout=30)
            print("请用小红书 App 扫码登录（窗口已弹出）", flush=True)

            cookies = session.wait_cookie(
                SESSION_COOKIE,
                timeout=args.timeout,
                interval=2.0,
                on_tick=make_ticker(args.timeout),
            )
            names, size = save_cookie_line(args.out, cookies)
            print(
                f"登录成功：{COOKIE_DOMAIN} 域下 {len(names)} 个字段（{', '.join(sorted(names))}），"
                f"总长度 {size} 字节"
            )
            print(f"已写入：{args.out}")
            self_check(session)
    except BrowserError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已中断：没有完成登录", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
