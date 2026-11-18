"""小红书创作中心数据采集：扫码登录 + 借页面自带「导出数据」拿明细表 → JSON。

**为什么不走接口**（2026-11-18 实测，别再试第二次）：
`GET /api/galaxy/creator/datacenter/note/analyze/list` 带 cookie 直接请求回 `HTTP 406
{"code":-1}`；照抄浏览器里那次请求的 `X-s`/`X-t`/`X-S-Common` 原样重放能 200，
但只要改任何一个查询参数（翻页、换体裁、换时间范围）就又 406 —— 签名把参数绑死了。
页面里的签名器 `window._webmsxyw` 能调，但它算出来的签名服务器不认（页面真正用的是
模块闭包里持有的那份），在页面里也钩不到。结论：**自己签是不可能稳的**。
所以改成点页面上的「导出数据」：一次点击拿到整张表（最多 1000 条），让页面自己去签名。

导出表的样子（实测 `笔记列表明细表.xlsx`）：
    第 1 行  合并提示「最多导出排序后前1000条笔记」
    第 2 行  表头：笔记标题 首次发布时间 体裁 曝光 观看量 封面点击率 点赞 评论 收藏 涨粉 分享 人均观看时长 弹幕
    第 3 行起 数据；字符串是 inlineStr，数字都是 "369.0" 这种带小数点小数的文本

两条口径（对齐 lib/xiaohongshu.js）：
- 曝光进 `extras.impressions`，`play` 只取「观看量」——两者差一个量级，混用会把互动率算错。
- 封面点击率导出是 0–1 的小数（0.037），这里换乘 100 变成 3.7（百分数）。
- 导出**没有笔记 id 也没有链接**，所以 `note_id` 由 标题+首次发布时间 稳定派生
  （同一个标题改一个字就会换 id，导入端会当成新笔记——这是已知代价，比猜 id 强）。

命令：`login` 扫码登录、`fetch` 导出并生成 JSON（用 std::lib 解析 xlsx：zipfile + ElementTree）。

凭据：`config/xhs_<账号>.txt` 里是 **JSON 对象** `{"web_session": "...", "a1": "...", ...}`
（缩进 2、UTF-8 无 BOM，与抖音脚本统一）；老的单行 `k=v; k=v` 文件仍能读，不用重扫。

退出码：0 成功 / 1 一般错误 / 2 cookie 过期（要重新 login）/ 3 触发风控 / 4 扫码超时或取消。
"""

import argparse
import hashlib
import json
import re
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_AUTH = 2
EXIT_RISK = 3
EXIT_QR_EXPIRED = 4

PLATFORM = "xhs"
CREATOR_HOST = "https://creator.xiaohongshu.com"
EXPORT_PAGE = f"{CREATOR_HOST}/statistics/data-analysis"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
)

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

#: 导出表的列名 → 台账字段。列名对不上就跳过并在 warnings 里点名。
COLUMNS = {
    "笔记标题": "title",
    "首次发布时间": "published_at",
    "体裁": "kind",
    "曝光": "impressions",
    "观看量": "play",
    "封面点击率": "cover_click_rate",
    "点赞": "like",
    "评论": "comment",
    "收藏": "collect",
    "涨粉": "fans",
    "分享": "share",
    "人均观看时长": "view_time",
    "弹幕": "danmaku",
}

#: 进 metrics 的字段；其余进 extras。
METRIC_KEYS = ("play", "like", "comment", "share", "collect", "fans")


class SyncError(Exception):
    """预期内的失败：带退出码，main 负责打印成一行中文错误。"""

    def __init__(self, message, exit_code=EXIT_ERROR):
        super().__init__(message)
        self.exit_code = exit_code


def short_url(url):
    match = re.match(r"(https?://[^/?#]+)([^?#]*)", url or "")
    return (match.group(1) + match.group(2)) if match else (url or "")


def find_workspace_root(start=None):
    """向上找「同层既有 AGENTS.md 又有 code/ 或 work/」的目录，就是工作区根。"""
    current = Path(start or Path.cwd()).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / "AGENTS.md").is_file() and ((candidate / "code").is_dir() or (candidate / "work").is_dir()):
            return candidate
    raise SyncError("找不到工作区根（同层要同时有 AGENTS.md 和 code/）；请在仓库内运行")


def workspace_paths():
    root = find_workspace_root()
    paths = {
        "root": root,
        "config_dir": root / "config",
        "tmp_dir": root / "tmp",
    }
    paths["config_dir"].mkdir(parents=True, exist_ok=True)
    paths["tmp_dir"].mkdir(parents=True, exist_ok=True)
    return paths


def credential_path(account):
    return workspace_paths()["config_dir"] / f"xhs_{account}.txt"


def default_output_path():
    return workspace_paths()["tmp_dir"] / f"xhs-notes-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"


def validate_account(raw):
    text = (raw or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", text):
        raise SyncError(f"账号名 {raw!r} 不合法：只能用字母、数字、下划线、短横线（1–32 位），它会被拼进凭据文件名")
    return text


def parse_cookie_line(line):
    """旧格式（单行 `k=v; k=v`）拆成列表；值里的 '=' 保留（只按第一个等号切）。"""
    pairs = []
    for chunk in (line or "").split(";"):
        name, _, value = chunk.strip().partition("=")
        if name and value:
            pairs.append((name.strip(), value.strip()))
    return pairs


def parse_credential(text):
    """凭据文件的两种格式都认：JSON 对象（本脚本写的新格式）与旧的单行 `k=v; k=v`。

    老文件不重扫也能用；JSON 分支只留字符串且非空的字段，非对象 JSON 直接报错。
    错误信息里只有字段名/文件路径，不含任何 cookie 值。
    """
    body = (text or "").lstrip()
    if body[:1] in ("{", "["):
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as error:
            raise SyncError(f"凭据文件是 JSON 但解析失败（{error}），请重新 login", EXIT_AUTH) from error
        if not isinstance(payload, dict):
            raise SyncError("凭据文件的 JSON 不是一个对象（应为 {字段: 值}），请重新 login", EXIT_AUTH)
        return [(str(name), value) for name, value in payload.items() if isinstance(value, str) and value]
    return parse_cookie_line(text)


def cookie_to_header(pairs):
    return "; ".join(f"{name}={value}" for name, value in pairs)


def describe_cookie_line(line):
    """只报字段名与长度，绝不回显值；JSON 与旧单行都认。"""
    pairs = parse_credential(line)
    return "、".join(f"{name}(len={len(value)})" for name, value in pairs) or "（空）"


def load_credential(account):
    """读凭据并返回 cookie 头（header）；调用方 export_workbook 吃的就是 header。"""
    path = credential_path(account)
    if not path.is_file():
        raise SyncError(f"没有 cookie：{path}（先跑 python scripts/xhs_sync.py login --account {account}）", EXIT_AUTH)
    text = path.read_text(encoding="utf-8").replace("\ufeff", "").strip()
    if not text:
        raise SyncError(f"凭据文件是空的：{path}，请重新 login", EXIT_AUTH)
    pairs = parse_credential(text)
    if not any(name == "web_session" for name, _ in pairs):
        raise SyncError(f"{path} 里没有 web_session 字段，登录态不完整（重新 login）", EXIT_AUTH)
    return cookie_to_header(pairs)


# ---------------------------------------------------------------- xlsx 解析


def parse_xlsx_rows(path):
    """只用标准库读 xlsx：sharedStrings + inlineStr 都认，返回二维字符串表。"""
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            shared = []
            if "xl/sharedStrings.xml" in names:
                root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                for si in root.findall("m:si", NS):
                    shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
            sheets = [name for name in names if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")]
            if not sheets:
                raise SyncError(f"{path} 里没有工作表")
            root = ET.fromstring(archive.read(sorted(sheets)[0]))
    except zipfile.BadZipFile as error:
        raise SyncError(f"{path} 不是合法的 xlsx（{error}）") from error

    rows = []
    for row in root.findall(".//m:row", NS):
        values = []
        for cell in row.findall("m:c", NS):
            kind = cell.get("t")
            if kind == "inlineStr":
                values.append("".join(t.text or "" for t in cell.iter(f"{{{NS['m']}}}t")))
            else:
                node = cell.find("m:v", NS)
                if node is None or node.text is None:
                    values.append("")
                elif kind == "s":
                    index = int(node.text)
                    values.append(shared[index] if 0 <= index < len(shared) else "")
                else:
                    values.append(node.text)
        rows.append(values)
    return rows


CN_TIME = re.compile(r"(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分(\d{1,2})秒")
SHORT_TIME = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?")


def parse_time(text):
    """「2026年11月17日22时26分25秒」→「2026-11-17 22:26:25」；认不出来返回空串。"""
    raw = (text or "").strip()
    match = CN_TIME.search(raw)
    if match:
        year, month, day, hour, minute, second = (int(part) for part in match.groups())
        return f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}:{second:02d}"
    match = SHORT_TIME.search(raw)
    if match:
        year, month, day, hour, minute = (int(part) for part in match.groups()[:5])
        second = int(match.group(6) or 0)
        return f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}:{second:02d}"
    return ""


def to_number(text):
    """"369.0" / "3,691" / "3.7%" → float；空、横杠、认不出 → None。"""
    raw = (text or "").strip().replace(",", "").rstrip("%")
    if not raw or raw in {"-", "--", "—"}:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def note_id_for(title, published_at):
    """导出表没有 note_id：用 标题+发布时间 派生一个稳定 id，同一条笔记每次导入都一致。"""
    digest = hashlib.sha1(f"{title}|{published_at}".encode("utf-8")).hexdigest()
    return f"xhs{digest[:14]}"


def note_kind(text):
    raw = (text or "").strip()
    if raw == "视频":
        return "视频"
    if raw == "图文":
        return "图文"
    return raw or "图文"


def build_note(row, warnings, index):
    """一行导出数据 → 契约里的一条 note。row 已按台账字段名映射过。"""
    title = (row.get("title") or "").strip()
    published_at = parse_time(row.get("published_at"))
    if not title and not published_at:
        return None
    if not title:
        warnings.append(f"第 {index} 行没有标题，已跳过")
        return None
    if not published_at:
        warnings.append(f"「{title}」的发布时间没解析出来（原值 {row.get('published_at')!r}）")

    metrics = {}
    extras = {}
    for field in ("impressions", "play", "cover_click_rate", "like", "comment", "collect", "fans", "share", "view_time", "danmaku"):
        value = to_number(row.get(field))
        if value is None:
            continue
        if field == "cover_click_rate":
            # 导出是 0–1 的小数，台账要百分数
            extras[field] = round(value * 100, 2)
            continue
        number = int(value) if float(value).is_integer() else value
        if field in METRIC_KEYS:
            metrics[field] = number
        else:
            extras[field] = number

    note = {
        "note_id": note_id_for(title, published_at),
        "title": title,
        "kind": note_kind(row.get("kind")),
        "published_at": published_at,
        "metrics": metrics,
        "extras": extras,
    }
    if extras.get("cover_click_rate", 0) > 100:
        warnings.append(f"「{title}」封面点击率 {extras['cover_click_rate']} 超过 100，导出口径可能变了")
    if not metrics:
        warnings.append(f"「{title}」一个指标都没解析出来，字段名可能变了（用 --dump 看原始表）")
    return note


def notes_from_rows(rows, warnings):
    header_index = None
    header_map = {}
    for index, row in enumerate(rows):
        if "笔记标题" in row and "观看量" in row:
            header_index = index
            header_map = {COLUMNS[name]: position for position, name in enumerate(row) if name in COLUMNS}
            missing = [name for name in COLUMNS if name not in row]
            if missing:
                warnings.append("导出表缺这些列（已跳过）：" + "、".join(missing))
            break
    if header_index is None:
        raise SyncError("导出表里找不到表头（含「笔记标题」「观看量」的行），页面结构可能变了")

    notes = []
    for index, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
        record = {field: (row[position] if position < len(row) else "") for field, position in header_map.items()}
        note = build_note(record, warnings, index)
        if note:
            notes.append(note)
    return notes


# ---------------------------------------------------------------- 浏览器导出


def export_workbook(cookie_line, download_dir, headless=False, timeout=180, on_tick=None):
    """借浏览器：灌 cookie → 打开数据分析页 → 点「导出数据」→ 等文件落盘。"""
    try:
        from xhs_browser import BrowserSession, BrowserError
    except ImportError as error:  # pragma: no cover - 只在缺文件时发生
        raise SyncError(f"缺少 scripts/xhs_browser.py（{error}）") from error

    download_dir = Path(download_dir)
    download_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()

    pairs = parse_cookie_line(cookie_line)
    cookies = [
        {"name": name, "value": value, "domain": ".xiaohongshu.com", "path": "/", "httpOnly": False, "secure": True}
        for name, value in pairs
    ]

    try:
        with BrowserSession(headless=headless) as session:
            session.command("Network.enable")
            session.command("Page.enable")
            try:
                session.command("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(download_dir)})
            except BrowserError:
                session.command("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(download_dir)})
            session.command("Network.setCookies", {"cookies": cookies})
            session.open(EXPORT_PAGE, timeout=45)

            # 等页面把表格画出来（导出按钮出现才算就绪；它一直在，所以再等一会儿让首屏请求走完）
            for _ in range(20):
                ready = session.evaluate("document.readyState === 'complete'", timeout=10)
                if ready is True:
                    break
                time.sleep(0.5)
            time.sleep(3)

            clicked = session.evaluate(
                r"""
(() => {
  const nodes = document.querySelectorAll('button, a, div[role="button"]');
  for (const el of nodes) {
    const text = (el.textContent || '').trim();
    if (text === '导出数据' && !el.querySelector('button, a')) {
      el.click();
      return 'ok';
    }
  }
  return 'missing';
})()
""",
                timeout=15,
            )
            if clicked != "ok":
                raise SyncError("页面上找不到「导出数据」按钮；确认账号有数据权限，或用 --dump 看页面标题")

            before = {path.name for path in download_dir.glob("*.xlsx")}
            deadline = time.time() + timeout
            while time.time() < deadline:
                files = [path for path in download_dir.glob("*.xlsx") if path.name not in before]
                if files:
                    newest = max(files, key=lambda path: path.stat().st_mtime)
                    if newest.stat().st_size > 0 and newest.stat().st_mtime >= started - 5:
                        time.sleep(1.5)  # 让浏览器把文件写完
                        return newest
                if on_tick:
                    on_tick(round(time.time() - started, 1))
                time.sleep(1.0)
            raise SyncError(f"点了导出但 {int(timeout)} 秒内没等到文件（下载目录 {download_dir}）")
    except BrowserError as error:
        raise SyncError(f"浏览器这步失败：{error}") from error


# ---------------------------------------------------------------- 命令


def cmd_login(args):
    try:
        from xhs_login import main as login_main
    except ImportError as error:
        raise SyncError(f"缺少 scripts/xhs_login.py（{error}）") from error
    out = Path(args.out) if args.out else credential_path(validate_account(args.account))
    out.parent.mkdir(parents=True, exist_ok=True)
    argv = ["--out", str(out)]
    if args.browser:
        argv += ["--browser", args.browser]
    if args.headless:
        argv += ["--headless"]
    if args.timeout:
        argv += ["--timeout", str(args.timeout)]
    code = login_main(argv)
    if code != 0:
        return EXIT_QR_EXPIRED
    line = out.read_text(encoding="utf-8").strip()
    print(f"凭据字段：{describe_cookie_line(line)}")
    return EXIT_OK


def cmd_fetch(args):
    account = validate_account(args.account)
    cookie_line = load_credential(account)
    print(f"账号：{account}（{len(parse_cookie_line(cookie_line))} 个 cookie 字段）")

    paths = workspace_paths()
    download_dir = paths["tmp_dir"] / f"xhs-download-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    if args.keep_workbook and args.dump:
        print(f"浏览器下载目录：{download_dir}")

    def tick(elapsed):
        if int(elapsed) % 10 == 0:
            print(f"  等导出文件… 已等 {int(elapsed)} 秒")

    workbook = export_workbook(
        cookie_line,
        download_dir,
        headless=args.headless,
        timeout=args.timeout,
        on_tick=tick,
    )
    print(f"已下载：{workbook.name}（{workbook.stat().st_size} 字节）")

    warnings = []
    rows = parse_xlsx_rows(workbook)
    notes = notes_from_rows(rows, warnings)
    if len(notes) >= 1000:
        warnings.append("导出了 1000 条，可能被截断（页面限制最多 1000 条），更早的笔记请先在页面上调整时间范围")
    if args.max and len(notes) > args.max:
        warnings.append(f"只保留最新 {args.max} 条（--max）")
        notes = notes[: args.max]

    payload = {
        "platform": PLATFORM,
        "account": {"name": args.name or account},
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "creator.xiaohongshu.com data-analysis 导出（笔记列表明细表）",
        "notes": notes,
        "warnings": warnings,
    }

    out_path = Path(args.out) if args.out else default_output_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="")

    if args.dump:
        dump = paths["tmp_dir"] / "xhs-export-rows.json"
        dump.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="")
        print(f"原始表格行已 dump：{dump}")

    print(f"笔记 {len(notes)} 条，已写入：{out_path}")
    for note in notes[:5]:
        metrics = note["metrics"]
        print(
            f"  {note['published_at'][:10]} {note['kind']} 观看={metrics.get('play')} "
            f"赞={metrics.get('like')} 藏={metrics.get('collect')} 评={metrics.get('comment')} {note['title'][:20]}"
        )
    if len(notes) > 5:
        print(f"  …另有 {len(notes) - 5} 条")
    for warning in warnings:
        print(f"提醒：{warning}")
    print(f"下一步：media action=import_xhs path=\"{out_path}\"")
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(
        prog="xhs_sync.py",
        description="小红书创作中心采集：扫码登录 + 借页面导出拿笔记明细，产出可被 media import_xhs 导入的 JSON。",
        epilog=(
            "退出码：0 成功；1 一般错误；2 cookie 过期（重新 login）；3 触发风控；4 扫码超时或取消。\n"
            "例子：\n"
            "  python scripts/xhs_sync.py login\n"
            "  python scripts/xhs_sync.py fetch --max 50\n"
            "  python scripts/xhs_sync.py fetch --dump      # 表头变了时先看原始表格行\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subs = parser.add_subparsers(dest="command", required=True)

    login_parser = subs.add_parser("login", help="扫码登录并把 cookie 落到 config/")
    login_parser.add_argument("--account", default="main", metavar="NAME", help="账号名，决定凭据文件名（默认 main）")
    login_parser.add_argument("--browser", choices=("chrome", "edge"), default=None, help="指定浏览器（默认自动找）")
    login_parser.add_argument("--headless", action="store_true", help="无头跑（扫码时看不见窗口，只用于自测）")
    login_parser.add_argument("--timeout", type=float, default=300.0, metavar="SEC", help="等待扫码的秒数（默认 300）")
    login_parser.add_argument("--out", default=None, metavar="PATH", help="凭据落盘路径，默认 config/xhs_<account>.txt")
    login_parser.set_defaults(handler=cmd_login)

    fetch_parser = subs.add_parser("fetch", help="导出笔记明细并生成 JSON")
    fetch_parser.add_argument("--account", default="main", metavar="NAME", help="用哪个账号的 cookie（默认 main）")
    fetch_parser.add_argument("--name", default=None, metavar="TEXT", help="台账里的账号名（默认用 --account）")
    fetch_parser.add_argument("--max", type=int, default=0, metavar="N", help="最多保留最新 N 条（默认全部）")
    fetch_parser.add_argument("--out", default=None, metavar="PATH", help="JSON 输出路径，默认 tmp/xhs-notes-<时间>.json")
    fetch_parser.add_argument("--timeout", type=float, default=180.0, metavar="SEC", help="等导出文件的秒数（默认 180）")
    fetch_parser.add_argument("--headless", action="store_true", help="无头跑（默认开窗口，方便看页面在干什么）")
    fetch_parser.add_argument("--dump", action="store_true", help="把原始表格行 dump 到 tmp/ 方便排查列名变化")
    fetch_parser.add_argument("--keep-workbook", action="store_true", help="保留下载的 xlsx 并打印路径")
    fetch_parser.set_defaults(handler=cmd_fetch)
    return parser


def main(argv=None):
    # 控制台是 GBK 时，标题里的 emoji 会让 print 直接抛 UnicodeEncodeError：宁可显示成 ?，也不许整条命令崩掉
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):  # pragma: no cover - 老环境兜底
            pass
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args)
    except SyncError as error:
        print(f"错误：{error}", file=sys.stderr)
        return error.exit_code
    except KeyboardInterrupt:
        print("已取消", file=sys.stderr)
        return EXIT_QR_EXPIRED


if __name__ == "__main__":
    sys.exit(main())
