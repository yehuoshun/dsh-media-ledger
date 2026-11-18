# scripts —— 采集器（B站 / 小红书）

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
