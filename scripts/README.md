# scripts —— 采集器（B站 / 抖音 / 小红书）

**独立的 Python 脚本**，负责「登录 + 把创作中心的数据抓成本地 JSON」这一件事。
插件本体不碰它们、不 import 它们，两边只通过一个 JSON 文件交接。

```
Python 脚本（唯一联网的地方）  →  <工作区根>/tmp/<平台>-import.json  →  插件导入
```

| 脚本 | 平台 | 工具 action | 凭据 |
|---|---|---|---|
| `bili_sync.py` | B站 | `import_bili` | `config/bilibili_<account>.txt` |
| `xhs_sync.py` | 小红书 | `import_xhs` | `config/xhs_<account>.txt` |

两个脚本各自独立（没有共享的 utils 模块），只有小红书那套互相引用：`xhs_sync.py`（入口）→
`xhs_login.py`（扫码）→ `xhs_browser.py`（起本机 Chrome，CDP 直通）。用法与退出码见下文。

## 为什么采集器是独立脚本，而插件本体不联网

这不是随手写的约定，是仓库的硬约束（见仓库 `AGENTS.md` §5）：

1. **插件本体不许联网**：`index.js` 与 `lib/*.js` 里不得出现 `fetch(` / `WebSocket` /
   `XMLHttpRequest` / `node:http(s)` / `node:net` / `node:dns` / `node:tls` / `axios`，
   也不得起进程（`node:child_process`）。`test/smoke.mjs` 里有断言逐条扫这些词，
   违规直接跑挂。用户明确要求过「隐私数据不上传」。
2. **抓取必须联网**：B站没有可用的开放数据接口，只能带 cookie 打创作中心的内部接口。
   这个动作天然违反上一条，所以它只能待在插件外面。
3. **靠文件解耦**：脚本产出 JSON，插件读文件。脚本挂了不影响插件运行，
   插件升级也不必碰脚本；要审计「谁联网了」，只看这一个文件即可。

代价是用户要手动跑两条命令。这是有意换来的：联网行为**显式、可见、可停**。

## 依赖

- Python 3.12（脚本只用标准库）
- `qrcode` + `pillow`：**只有 `login` 用**，在函数里懒加载，`fetch` 不付这个导入开销

```
python -m pip install qrcode pillow
```

## 路径约定

脚本不写死盘符路径。**工作区根**是从脚本文件本身向上找「同层既有 `AGENTS.md` 又有 `code/`」的那层目录；
找不到直接报错（不会退回到用户目录，静默写到别处比失败更难查）。从工作区根派生出四个固定位置：

| 用途 | 位置 |
|---|---|
| 凭据（cookie） | `<工作区根>\config\bilibili_<account>.txt` |
| 登录二维码图片 | `<工作区根>\tmp\bili-qr-<account>.png` |
| `fetch` 默认输出 | `<工作区根>\tmp\bili-import.json` |
| `--out` 相对路径 | 按**当前工作目录**解析（不是按脚本目录） |

`<account>` 是账号简称，默认 `main`。它会被拼进文件名，所以只允许字母、数字、下划线、短横线，长度 1–32
（`../x`、空格、中文一律拒绝）。

## login：扫码登录

```
python scripts/bili_sync.py login
python scripts/bili_sync.py login --account work
```

流程：

1. 向 B站申请登录二维码，用 `qrcode` 渲染成 PNG 存到 `<工作区根>\tmp\bili-qr-<account>.png`，
   终端同时打印**图片路径**和**二维码内容 URL**（URL 里带 `qrcode_key`，可以自己核对确认不是钓鱼）。
2. 打开那个 PNG，用**B站手机客户端**扫码并确认登录。
3. 脚本每 2 秒查一次扫码状态，最长等 5 分钟：
   - 未扫码 → 继续等（状态行会打「等待扫码…」）
   - 已扫码待确认 → 状态行会打「已扫码，等待手机端确认…」
   - 二维码失效（B站约 3 分钟过期）→ 退出码 `4`，重新跑一次 `login` 即可
4. 成功后补一次 `finger/spi` 拿 `buvid3`/`buvid4`（缺了这两个，部分接口会当匿名请求），
   把 cookie 序列化成一行 `k=v; k=v` 写进 `<工作区根>\config\bilibili_<account>.txt`
   （UTF-8、无 BOM、无换行结尾），最后调 `nav` 接口验证 `isLogin == true`，
   打印 `昵称(mid)` 与 `level` 后返回 0。

**cookie 值永远不会打印**：终端里只出现字段名和长度，例如 `SESSDATA(len=222)，bili_jct(len=32)，…`。
要判断「是不是过期了 / 字段全不全」，看这串名字和长度就够了。

凭据文件长这样（一行，7 个固定字段在前，其余按字段名排序追加）：

```
SESSDATA=…; bili_jct=…; DedeUserID=…; DedeUserID__ckMd5=…; sid=…; buvid3=…; buvid4=…
```

> 凭据放在**工作区根的 `config/`**，不在这个 git 仓库里；不要把它复制进仓库、贴进 issue 或提交信息。

## fetch：采集数据

```
python scripts/bili_sync.py fetch                          # 最近 50 条，写到 tmp\bili-import.json
python scripts/bili_sync.py fetch --max 10                 # 只要最近 10 条（调试用，省配额）
python scripts/bili_sync.py fetch --out tmp\bili-20261118.json
python scripts/bili_sync.py fetch --max 20 --compare-size 5
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--account NAME` | `main` | 读 `config\bilibili_<NAME>.txt` |
| `--max N` | `50` | 按发布时间倒序最多采多少个稿件 |
| `--out PATH` | `<工作区根>\tmp\bili-import.json` | 输出路径；相对路径按当前目录解析 |
| `--compare-size N` | `10` | 同行对比接口一次取多少条 |

请求量与耗时（脚本对请求之间强制 ≥ 0.35 秒间隔）：

```
1 次 nav 校验 + ceil(max/20) 页列表 + 1 次 compare + 每个稿件 3 次请求
max=50 时约 155 次请求，光节流就 ≥ 54 秒
```

进度打在 **stderr**（`[3/50] BV1…`），结果摘要打在 stdout，要静默跑可以 `2>$null`。

采到的每个稿件来自三个不同口径，脚本把它们并列写进 JSON，**不做换算、不做合并**：

| JSON 字段 | 来源 | 口径 |
|---|---|---|
| `realtime` | `api.bilibili.com/x/web-interface/view` | 播放页实时数，随手刷新就会变 |
| `settled` | `member.bilibili.com/x/web/data/archive` | 创作中心的「结算」口径，滞后、但和后台看到的数一致 |
| `diagnose` | `.../archive_diagnose/overview` | 观众画像：性别、年龄、地域、标签、粉丝/路人占比 |
| `compare` | `.../archive_diagnose/compare` | 同行对比（万分比原样，例如 `4122` 表示 41.22%） |

### 输出 JSON

顶层四个键，字段名是下游解析契约，**不要改**：

```json
{
  "generated_at": "2026-11-18 00:40",
  "account": {"mid": 0, "name": "示例账号", "level": 6},
  "posts": [ … ],
  "compare": {"BVxxxxxxxxxx": {"full_play_ratio": 4122, "interact_rate": 1200}},
  "warnings": ["…"]
}
```

`posts[]` 每项：`bvid` / `aid` / `title` / `published_at`（`YYYY-MM-DD HH:MM`）/ `date` /
`duration`（秒）/ `url` / `realtime{play,like,comment,share,collect}` /
`settled{play,view,like,fav,reply,share,coin,dm,elec,fans_play,guest_play,progress_rate,avg_duration}` /
`diagnose{gender,age,area,tags,play_proportion,audience}`。

三条读法上的约定：

- **缺失写 `null`，不写 0**。B站后台「还没算出来」和「真的是 0」在接口里长得一样，
  脚本不猜语义：`null` 就是没有，`0` 就是零。下游做均值/率的时候必须先过滤 `null`，否则会把缺数据当成 0。
- **万分比不换算**：`progress_rate: 4122` 表示 41.22%，换算留给 JS 侧（避免两边各算一遍还算法不同）。
- **降级都记在 `warnings`**：例如「BV1: area 为空（接口返回 null）」「BV9: compare 这条稿件所有字段都未就绪」。
  有 warning 不代表失败——数据能落盘、缺失项是 `null`，就返回 0。

## 退出码

| 码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 成功 | —— |
| `1` | 一般错误：网络不通、接口 `code != 0`、参数不合法、文件读写失败 | 看 stderr 的错误原文 |
| `2` | 凭据失效：`-101`（未登录/已过期）或 `nav.isLogin != true` | 重新跑 `login` |
| `3` | 被风控：`-352` / `-412`（含 HTTP 412） | 降频，见下 |
| `4` | 二维码失效（`86038`） | 重新跑 `login` 换一张码 |

### 遇到 `-101`（退出码 2）：cookie 过期

SESSDATA 有有效期（长短由 B站决定，通常几周），换设备、改密码、网页端退出登录、
清浏览器 cookie 都会让它提前失效。重新扫码即可：

```
python scripts/bili_sync.py login
python scripts/bili_sync.py fetch
```

脚本**不会**自己去续期、也不会拿账号密码登录——只有扫码这一条路，
这样凭据只落在本机 `config\`，不需要在脚本里保管密码。

### 遇到 `-352` / `-412`（退出码 3）：被风控

B站的风控是**按账号/IP 计分**的，连续快速请求会先软失败，再升级成整段接口不可用。
处理顺序：

1. **停手 10–30 分钟**，不要重试——重试会继续加分，把小问题拖成封禁。
2. 降低单次采集量：`--max 10 --compare-size 5`，一天内不要反复跑同一个账号。
3. 检查是不是和网页版/APP 同时高频操作（同一账号并发最容易被盯）。
4. 如果 `-412` 持续一天以上，去网页版确认账号是否被要求验证（滑块/短信），手动过一次再试。

脚本这边已经做的防护：请求之间强制 ≥ 0.35 秒、传输层错误最多重试 2 次、
`code != 0` 一律**不重试**（重试没用还更容易被风控）、列表翻页有 50 页保险丝。

## 已知的接口脾气（都是写这脚本时踩到的）

- **`archive/archive` 的 `stat` 可以是 `null`**：刚发布/刚过审的稿件后台还没算数，整个 `stat` 是 `null`。
  脚本会把 `settled` 里的互动数写成 `null` 并记 warning，不会崩。
- **`area` 可能 `null`，也可能是空数组**：`null` 与 `[]` 语义不同（一个没数据、一个没地域分布），
  分别记不同的 warning，输出都是 `null`。
- **`compare` 有 `not_ready_field`**：这条稿件某些对比指标还没算出来。脚本会把**这些字段整个剔除**
  （不是写 0），并记一条 warning；如果整条稿件的对比数据都没就绪，落成 `{}`。
- **`compare` 索引里可能有本轮没采的旧稿件**：接口按「最近 N 条」返回，`--max` 小的时候会多出来。
  脚本原样保留（下游按 `bvid` 查就行），少落一份就等于静默丢数据。
- **`viewer_ty` 可能为空**：观众标签要样本够了才有，新稿件常常是 `[]`。
- **`pager.total` 与实际返回条数可能不一致**：脚本以「拿满 `--max` 或翻到 `total`」为停，
  并对重复 `bvid` 去重（接口翻页偶发重复行）。
- **`duration` 三处都有**：列表、`view`、`archive.play.duration`，脚本按这个顺序回退取第一个非空值。
- **`-412` 是 HTTP 层也可能是业务层**：两种情况都映射到退出码 3。
- **PowerShell 里中文可能乱码**：`python` 输出经管道时默认走 cp936。要看到正常中文：

  ```powershell
  $env:PYTHONUTF8='1'; [Console]::OutputEncoding=[Text.Encoding]::UTF8
  ```
- **微信/QQ 扫不出来**：必须用 B站手机客户端扫；别用第三方扫码工具，扫完也不会确认登录。

## 小红书：`xhs_sync.py`

### 为什么和 B站 完全不是一套

B站的接口自带签名白名单、裸 HTTP 带 cookie 就能过；小红书**每个数据接口都要 `x-s` 签名，而签名把
query 绑死了**——抓到真实请求原样重放是 200，换任意参数（哪怕删掉时间参数）立刻 406。页面里的
`window._webmsxyw` 能算出签名，但它被模块闭包持有，外部包一层钩不到调用（详见 `docs/XHS_API.md` §4.3）。

所以采集**不逆签名**，改走页面自己的「导出数据」按钮：下载 `笔记列表明细表.xlsx`，本地解析。
浏览器只负责灌 cookie、点按钮、收文件，数据解析全在本地。

### 用法

```powershell
# 1. 扫码登录（弹一个临时浏览器窗口，用小红书 App 扫；成功写 config\xhs_main.txt）
python scripts\xhs_sync.py login --account main --timeout 600

# 2. 采集（起浏览器 → 点导出 → 解析 xlsx → 写 JSON）
python scripts\xhs_sync.py fetch --account main --name 你的昵称

# 可选：无头跑、限制条数、另存原始导出表行
python scripts\xhs_sync.py fetch --account main --name 你的昵称 --headless --max 200 --dump

# 3. 入库（DSH 里调工具）
media action=import_xhs path="<工作区根>\tmp\xhs-notes-<时间>.json"
```

| 参数 | 作用 |
|---|---|
| `--account` | 账号简称，决定凭据文件名（默认 `main`） |
| `--name` | 台账里的账号名（省略则用昵称兜底，取不到就问你要） |
| `--headless` | 无头跑（实测可行；默认弹窗，页面状态更稳） |
| `--max N` | 只取导出表里的前 N 条 |
| `--out` | 输出 JSON 路径，默认 `<工作区根>\tmp\xhs-notes-<时间>.json` |
| `--dump` | 另存原始导出表行（排查字段用） |
| `--keep-workbook` | 保留下载的 xlsx |
| `--timeout` | 等下载的超时秒数（默认 120） |

### 口径（和 B站 不一样的地方）

- **观看量不是曝光量**：`play` 只取「观看量」，「曝光」进 `extras.impressions`。导出把两列都给了，别混。
- **封面点击率**导出是 0~1 小数（`0.037`），台账统一 0~100，脚本 ×100 后写 `extras.cover_click_rate`。
- **涨粉**进 `fans`（B站那边没有这一列）。
- **图文 / 视频**分开记 `kind`，导出「体裁」列直接说。
- **没有 note_id、没有链接**：导出表里两样都没有。`note_id` 由 `sha1(标题|发布时间)[:14]` 派生（以 `xhs` 开头），
  所以改标题会被当成新作品；合成 id **不拼 `explore/<id>` 链接**——那地址点开就是 404，宁可空着。
- 导出上限是「排序后前 1000 条笔记」，页面自己写的提示。

### 已知的接口脾气

- **导出按钮要等页面渲染完**：脚本按文本精确匹配「导出数据」才点，等不到就报退出码 3，别以为是风控。
- **GBK 控制台遇 emoji 会炸**：标题里有 📚 这类字符时 `print` 曾抛 `UnicodeEncodeError`，脚本已把
  stdout/stderr 设成 `errors="replace"`；要正常看中文仍建议 `$env:PYTHONUTF8='1'`。
- **临时 profile 会被占用**：脚本按自己起的浏览器 PID 收尾；上一次异常退出留下的 `xhs-chrome-*` 目录可以直接删。

## 安全与隐私

- cookie 只写 `<工作区根>\config\`，不进仓库；仓库 `.gitignore` 另有一层兜底但别依赖它。
- 脚本**从不打印 cookie 值**，只打印字段名与长度。
- 请求头里的 UA 写死在脚本里（不读环境变量），保证行为可复现、好排查。
- 输出 JSON 里只有你自己的稿件数据，**不要**把它提交进仓库（`tmp/` 已被忽略）。

## 抖音采集脚本 douyin_sync.py

`scripts/` 里的第二个采集器，做同一件事：**登录 + 把作品数据抓成本地 JSON**，插件再用纯函数离线灌进台账。
两个脚本只是放在同一目录，**互不 import、不共享代码、可以单独升级**。

| | `bili_sync.py`（B站） | `douyin_sync.py`（抖音） |
|---|---|---|
| 登录 | 脚本自己申请二维码 PNG，手机扫 | **拉起本机 Chrome/Edge**，你在窗口里扫码，脚本通过 CDP 轮询状态 |
| 第三方依赖 | `qrcode` + `pillow`（只 `login` 用） | **无**，纯标准库（CDP 用的 WebSocket 是手写的） |
| 凭据文件 | `config\bilibili_<account>.txt`，一行 `k=v; k=v` | `config\douyin_<account>.txt`，JSON 对象 |
| `fetch` 默认产物 | `tmp\bili-import.json` | `tmp\douyin-import.json` |
| 采集方式 | 每稿 3 个接口（实时/结算/画像） | 列表 + 按批详情，指标只有一份 |

**为什么抖音必须借浏览器**：`/passport/web/get_qrcode/` 被 passport 风控恒定拦截 ——
HTTP 200 + `{"data":{"error_code":4031,"description":"您正在尝试访问的网站存在安全风险..."},"message":"error"}`，
补 ttwid、浏览器指纹头、csrf 都不行。纯 HTTP 申请二维码这条路是死的，所以改成「用浏览器自己的登录态」：
你在弹出的窗口里扫码，脚本等作品列表接口不再返回未登录码，就把浏览器里的 cookie 取出来落盘。

### 依赖

- Python 3.12，**只用标准库**（`urllib` 发请求，`socket` + `struct` 手写 RFC6455 客户端说 CDP）
- `login` 需要本机装有 Chrome 或 Edge；`fetch` / `whoami` / `selftest` 都不需要浏览器

### 路径约定

工作区根的定位规则和 B 站脚本完全一致（从脚本自身向上找「同层既有 `AGENTS.md` 又有 `code/`」）：

| 用途 | 位置 |
|---|---|
| 凭据（cookie） | `<工作区根>\config\douyin_<account>.txt` |
| 浏览器独立 profile | `<工作区根>\tmp\douyin-profile-<account>\` |
| `fetch` 默认输出 | `<工作区根>\tmp\douyin-import.json` |
| `--out` 相对路径 | 按**当前工作目录**解析（不是按脚本目录） |

`<account>` 默认 `main`，只允许字母、数字、下划线、短横线，长度 1–32（和 B 站脚本同一条规则）。
浏览器 profile 放在 `tmp/` 下：它随时可以整目录删掉，删了下次 `login` 会重建一个干净的。

### 子命令

```
python scripts/douyin_sync.py login      # 扫码登录，写凭据
python scripts/douyin_sync.py fetch      # 采集作品列表 + 指标，出 JSON
python scripts/douyin_sync.py whoami     # 只验证凭据还有效，不写任何文件
python scripts/douyin_sync.py selftest   # 本地假服务自检（不联网、不开浏览器）
```

### login：浏览器 CDP 扫码登录

```
python scripts/douyin_sync.py login
python scripts/douyin_sync.py login --account work --port 9333
python scripts/douyin_sync.py login --browser "D:\Portable\chrome.exe"
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--account NAME` | `main` | 决定凭据文件名 `douyin_<NAME>.txt` |
| `--port PORT` | `9222` | 浏览器远程调试端口；被占用就换一个（如 `9333`） |
| `--browser PATH` | 自动探测 | 先 `C:\Program Files\Google\Chrome\Application\chrome.exe`，再 `(x86)` 的 Edge |
| `--timeout SEC` | `180` | 等扫码的最长秒数，超时退出码 `4` |
| `--force` | 关 | 已有凭据且仍有效时也重新扫 |

流程：

1. 探测浏览器可执行文件（都找不到就报错，提示用 `--browser` 指定）。
2. 用**独立 profile** 启动：`--remote-debugging-port=<port> --user-data-dir=<工作区根>\tmp\douyin-profile-<account>`
   加 `--no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled`，
   直接打开 `https://creator.douyin.com/creator-micro/content/manage`。
   **不碰你自己开着的窗口**：脚本只 kill 自己启动的那个 pid，退出时也不会关你的浏览器。
3. stderr 打印「已打开浏览器，请扫码：在弹出的窗口里用抖音 App 扫码登录（最长等 180 秒）」。
4. 轮询 `127.0.0.1:<port>/json/list` 找到页面 target，连上手写的最小 WebSocket 客户端，
   发 `Runtime.evaluate` 在页面里 `fetch` 一次 `work_list` 并 await：
   **返回的 `status_code` 不再是 8 就算登录成功**（比盯 URL 变化可靠）。
5. 成功后 `Storage.getCookies` 取出 douyin.com 的 cookie，按字段名排序写成 JSON 到
   `config\douyin_<account>.txt`，再用命令行带这份 cookie 复核一次 `work_list`；
   终端只打印**字段名与长度**（例如 `sessionid(len=32)，ttwid(len=64)`），然后关掉浏览器。

已经登录过（凭据文件存在且 `work_list` 能返回非 8）会直接提示「已登录，无需重扫」，要重扫加 `--force`。

### fetch：采集数据

```
python scripts/douyin_sync.py fetch                        # 最近 50 条，写到 tmp\douyin-import.json
python scripts/douyin_sync.py fetch --max 10               # 只要最近 10 条（调试用）
python scripts/douyin_sync.py fetch --out tmp\dy-20261118.json
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--account NAME` | `main` | 读 `config\douyin_<NAME>.txt` |
| `--max N` | `50` | 按发布时间倒序最多采多少篇，上限 `200` |
| `--sleep SEC` | `0.35` | 两次请求之间的最小间隔，**不要调到 0.35 以下** |
| `--out PATH` | `<工作区根>\tmp\douyin-import.json` | 输出路径；相对路径按当前目录解析 |
| `--base-url URL` | `https://creator.douyin.com` | 只用于排查和自检，平时别动 |

请求量与耗时（请求之间强制 ≥ 0.35 秒）：

```
1 次探针 + 1 次账号信息 + ceil(max/20) 页列表 + ceil(max/20) 批详情
max=50 时约 8 次请求，光节流就 ≥ 2.5 秒（比 B 站那套轻得多：指标集中在详情接口里）
```

进度打在 **stderr**（`[3/50] 7300000000000000000`），摘要打在 stdout
（`已写出：…（50 条作品，7 条降级提示）` 加前 20 条提示），要静默跑可以 `2>$null`。

列表接口的平台参数以 `aid=1128&device_platform=android`（浏览器 prefetch 里的原值）为主，
第一次请求异常时自动回退到 `aid=2906&device_platform=web` 重试一次，回退会记在 `warnings` 里。

### 输出 JSON

顶层四个键，字段名是下游解析契约，**不要改**：

```json
{
  "generated_at": "2026-11-18 08:30",
  "account": {"uid": "1234567890", "name": "示例账号", "follower": 1234},
  "posts": [ … ],
  "warnings": ["…"]
}
```

`posts[]` 每项：`aweme_id`（字符串）/ `desc`（文案首行）/ `create_time`（**Unix 秒**）/ `media_type` /
`duration`（**毫秒**）/ `cover`（URL）/ `share_url`（`https://www.douyin.com/video/<aweme_id>`）/
`metrics{view_count,like_count,comment_count,share_count,favorite_count,completion_rate,avg_view_second}` /
`statistics{play_count,digg_count,comment_count,share_count}` / `review{status}` / `visibility{status}`。

三条读法上的约定（和 B 站脚本同一套）：

- **缺失写 `null`，不写 0**。抖音后台「还没算出来」和「真的是 0」在接口里长得一样，
  `null` 就是没有，`0` 就是零。下游做均值/率时必须先过滤 `null`，否则会把缺数据当成「真没人看」。
- **单位统一在脚本里做完**：`create_time` 一律秒（接口给毫秒时按 `> 1e11` 判断后 ÷1000）；
  `duration` 一律毫秒；`completion_rate` 一律**百分比数值**（`38.2` 表示 38.2%）。
- **降级都记在 `warnings`**：例如「7300…: 详情接口没返回这一条，metrics 写 null」。
  有 warning 不代表失败——数据能落盘、缺失项是 `null`，就返回 0。

### 哪些键名还是猜的（重要）

`item/mget` 登录后的 `items[]` 结构**没有生产样本可验证**（写脚本时手上没有真 cookie）。
所以脚本对每个字段都写成**候选路径表**，按顺序取第一个非空值，全取不到就写 `null`，
并把整串候选键名记进 `warnings`——**不会硬编码一套猜的键名然后静默全 null**。

| 输出字段 | 候选取值顺序（前几个） |
|---|---|
| `metrics.view_count` | `metrics.view_count` → `statistics.play_count` → `play_count` → `metrics.play_count` → `statistics.view_count` |
| `metrics.like_count` | `metrics.like_count` → `statistics.digg_count` → `digg_count` → `metrics.digg_count` |
| `metrics.comment_count` / `share_count` | `metrics.*` → `statistics.*` → 顶层 `*` |
| `metrics.favorite_count` | `metrics.favorite_count` → `statistics.collect_count` → `collect_count` → `metrics.collect_count` |
| `metrics.completion_rate` | `metrics.completion_rate` → `metrics.finish_rate` → `review.`/`play_info.` 同名键 |
| `metrics.avg_view_second` | `metrics.avg_view_second` → `metrics.avg_play_time` → `play_info.avg_view_second` → `metrics.avg_view_duration` → `metrics.avg_view_ms` |
| `review.status` / `visibility.status` | `review.status` / `audit.status` / `review_status`；`visibility.status` / `visibility_status` / … |
| `duration` / `create_time` / `cover` | 列表优先、详情兜底；`cover` 认 `video.cover.url_list.0` 这类嵌套路径 |

**两个「口径靠猜」的地方会写进 warnings**（真拿到数据后应该回头看这两条，然后修正）：

- `completion_rate` 如果接口给的是 `0..1` 的比例（如 `0.382`），脚本 **×100** 存成 `38.2`，
  并记一条「按比例猜成百分比（×100=38.2，口径未实测）」；本来就是百分数就原样保留、不记 warning。
- `avg_view_second` 如果值看起来是毫秒（键名带 `_ms` 或数值 ≥ 1000），脚本会 ÷1000 存成秒，并记一条 warning。

拿到第一条真实样本后，把命中的那条候选路径提到该字段候选表的**最前面**即可（顺手删掉没用的候选）。

### 退出码

| 码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 成功（含「部分作品详情缺失，已写 null 并记 warning」） | —— |
| `1` | 一般错误：网络不通、接口返回意料外的状态码、参数不合法、凭据文件缺失、文件读写失败 | 看 stderr 的错误原文 |
| `2` | 未登录 / 凭据失效：接口返回 `status_code == 8`（含 `BaseResp.StatusCode`） | 重新跑 `login` |
| `3` | 被风控：`status_code` 命中 `352` / `412` / `2154` | 降频，见下 |
| `4` | `login` 等扫码超时（默认 180 秒） | 重新跑 `login`，扫码快一点或加 `--timeout` |

`status_code == 8` **不重试**（重试只会让风控记住你），直接按凭据失效退出；网络类异常才重试 2 次（退避 0.8s / 1.6s）。

### 遇到 `status_code = 8`（退出码 2）：cookie 过期

```
python scripts/douyin_sync.py login
python scripts/douyin_sync.py fetch
```

脚本不会自己续期、也不碰账号密码，只有扫码一条路；凭据只落在本机 `config\`。

### 遇到 `352` / `412` / `2154`（退出码 3）：被风控

1. **停手 10–30 分钟**，不要重试——重试继续加分，小问题拖成整段接口不可用。
2. 降低单次采集量：`--max 10`，一天内别反复跑同一个账号。
3. 确认不是网页版/APP 同时高频操作（同账号并发最容易被盯）。
4. 持续一天以上就去网页版确认账号是否被要求验证（滑块/短信），手动过一次再试。

脚本这边已做的防护：请求之间强制 ≥ 0.35 秒、传输层错误最多重试 2 次、
`status_code != 0` 一律不重试、列表翻页有 `--max 200` 的保险丝。

### selftest：自检（不联网、不开浏览器）

```
python scripts/douyin_sync.py selftest
# selftest: 25/25 passed
```

用 `http.server` 在 `127.0.0.1` 起一个假创作中心（作品列表翻两页 12 + 3 条、`item/mget` 返回假指标且校验
`Agw-Js-Conv: str` 请求头、外加一个未登录分支），把真实 `fetch` 链路完整跑一遍，断言：
顶层键与 `posts[]`/`metrics`/`statistics` 的键集合、翻页次数与批量大小、`create_time` 是秒级
（毫秒被 ÷1000）、`duration` 保持毫秒、`completion_rate` 把 `0.382` 猜成 `38.2` 并记 warning、
`metrics` 回退到 `statistics`、缺详情时 `metrics` 为 `null`、缺字段是 `null` 不是 `0`、
`--max` 生效、**未登录时 `work_list` 只请求一次不重试且退出码为 2**、stdout 不含 cookie 值。
全程只走本地回环，环境变量用完即还原，临时目录自己清掉。

### 安全与隐私

- cookie 只写 `<工作区根>\config\`，不进仓库；`.gitignore` 另有一层兜底但别依赖它。
- 脚本**从不打印 cookie 值**，只打印字段名与长度。
- 浏览器是**独立 profile**（`tmp\douyin-profile-<account>\`），不读你的日常浏览器配置；
  脚本只 kill 自己启动的那个 pid，不会关掉你正在用的窗口。
- 请求头 UA 写死在脚本里（不读环境变量），行为可复现、好排查。
- 输出 JSON 里只有你自己的作品数据，**不要**提交进仓库（`tmp/` 已被忽略）。
