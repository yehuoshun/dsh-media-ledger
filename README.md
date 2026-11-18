# dsh-media-ledger

给 DeepSeek Harness（DSH）用的自媒体台账插件：**作品台账 → 数据复盘 → 发布包**。

覆盖四个平台：**抖音 / 小红书 / B站 / 视频号**。定位是「记得住、算得清、包得快」，不是发布器。

## 边界（先划清，免得越做越大）

| 做 | 不做 |
|---|---|
| 作品台账：一作品一行，一次报数一行（JSONL，可直接 git diff） | 上传自动化（上传这一步人点按钮） |
| 复盘：播放中位数、赞/评、评论赞比、互动率、T+ 龄期、按内容型/平台/账号分组 | 抓平台私有接口、逆向签名 |
| 发布包：标题字数、简介、最多 5 个话题、封面尺寸与比例校验，出可直接粘贴的文本 | 把平台创作中心嵌进面板 |
| 一个 `media` 工具（action 分派），不给系统提示塞四五个工具 | 多账号矩阵风控、批量分发 |

## 为什么不做上传

四个平台的官方发布接口是「文档里有、个人拿不到权限」：

- **抖音**：开放平台有「上传视频」与「创建视频」，但代投稿 scope `video.create.bind` 属实验室能力，官方公告自 2024-07-20 起收回；
- **小红书**：scope 页至今只有 `basic_info` 开放，`write_notes` 仍标「规划中」；
- **B站**：确有视频稿件提交接口（`/arcopen/fn/archive/add-by-utoken`），但入驻页写明「暂未开通个人开发者的申请入驻」，需企业资质；
- **视频号**：未见对外的发布接口（**未在官方文档验证**）。

抓私有接口（`a_bogus` / `x-s` / wbi 签名）随平台版本换，维护成本远高于「省下几次点击」，而且封的是自己的账号。

**所以：插件把发布包送到手边，上传这一步留给人。**

## 装法

插件是标准 DSH bundle（`dsh.bundle.patch` 指向 `cordis.patch.yml`），`engines.dsh: ">=0.2.0"`，实测宿主 `0.2.2-rc.3`。

用 `plugin_manager` 的 `install_bundle` 指向本目录即可，或在配置里手写：

```yaml
- insert:
    - id: media-ledger
      name: dsh-media-ledger
      config:
        dataDir: D:\notes\media-ledger   # 不写就落到工作区 data/media-ledger，这里只是示例
```

配置项（都可省）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | 工作区根下的 `data/media-ledger`（查找顺序：`config.dataDir` → 环境变量 `DSH_MEDIA_LEDGER_DIR` → 工作区根下的 `data/media-ledger`（工作区根优先取宿主注入的那个） → 找不到工作区时退回 `~/media-ledger`） | 台账目录，放哪由你定，不塞进 DSH 自己的存储 |
| `sidebar` | `true` | 是否在 DSH 左侧栏显示「自媒体台账」入口；只有显式写 `false` 才隐藏，面板里的开关写的就是这一项 |
| `titleLimits` | 见 `lib/pack.js` | 按平台覆盖标题字数上限 |
| `coverSpecs` | 见 `lib/pack.js` | 按平台覆盖封面建议尺寸 |

## 左侧栏面板

装好插件、重载 DSH 之后，左侧栏会多一个柱状图图标「自媒体台账」，点开是主区的一页，分成左右两栏：

- 左栏是导航：上半切换视图（**台账 / 复盘**），下半选筛选——「全部」→ 四个平台（带条数）→ 平台下的具名账号，没归平台的老记录单独一档「未归平台」；
- 右栏跟着选中项变。台账视图是作品表（日期 / 平台 / 账号 / 类型 / 标题 / 播放 / 赞 / 评 / 转 / 藏 / T+），已经按平台筛过就不再重复显示平台列；没报数的作品单独折叠成「未报数 N 条」，不与报过数的混排；
- 复盘视图是四张卡（作品数、已报数条数、互动率、T+ 龄期范围）+ 一张分组表：平台层按账号分、账号层按类型分，口径与 `report` 的 `group_by` 一致；
- 页脚写出台账目录与坏行条数，数据到底落在哪一眼能看到；列表超过 300 条时底部提示去看 `media list`。

视图切换与筛选都是浏览器里的本地状态，不改地址、不新增路由；每个切片要的复盘数字由 Host 一次算好（同一套 `buildReport`），前端不自己算指标。

右上角有「在左侧栏显示」开关和刷新按钮。关掉开关会立刻摘掉侧栏图标，并通过 DSH 的 `configEditor` 把 `sidebar: false` 写回插件配置（只动这一行的 `config`，不碰 `cordis.patch.yml` 里别的行），重启后依然生效；图标藏起来之后，还能在命令面板里跑「自媒体台账」把它叫回来，所以没有「关掉就再也打不开」的死角。

数据怎么到页面上：面板是浏览器里的 React 组件，读不到磁盘也读不到 Host 的 `config`，所以 Host 侧开两条**只走本机回环**的路由——`GET /api/dsh-media-ledger/state`（台账 + 每个筛选切片算好的复盘 + 开关状态）、`POST /api/dsh-media-ledger/sidebar`（写开关）。它们不访问外网、不收任意参数，请求体只认 `{"value": true|false}`，台账内容不出本机。数字全部来自 `media` 工具那套口径（最新快照、同批互动率、现算 T+），面板只换个地方显示，不另算一套。

改完代码怎么生效：改 Host 侧（`index.js`、`lib/bridge.js` 等）要重装插件并重启 DSH；只改 `lib/client.js` 刷一下页面即可。从旧版本升上来要走一次 `remove_bundle` + `install_bundle`，否则跑的还是旧代码。

## 用一个工具干活

`media` 的 `action`：

| action | 用途 | 必填 |
|---|---|---|
| `add_post` | 记一条作品 | `platform`、`title`（`published_at` 强烈建议填，否则算不出 T+） |
| `add_metrics` | 给某条报一次数 | `id`，以及播放/赞/评/转/藏/涨粉里至少一个 |
| `list` | 查台账（可按平台筛） | — |
| `report` | 出复盘 | —（可选 `group_by`、`max_age_hours`） |
| `pack` | 生成发布包 | `platform`、`title` |
| `import_bili` | 把 B站采集脚本产出的 JSON 灌进台账 | `path`（可选 `dry_run`、`create_missing`） |
| `import_douyin` | 把抖音采集脚本产出的 JSON 灌进台账 | `path`（可选 `dry_run`、`create_missing`） |
| `import_xhs` | 把小红书采集脚本产出的 JSON 灌进台账 | `path`（可选 `dry_run`、`create_missing`） |

数字可以直接写平台显示值：`2.4w`、`1.2万`、`3,456`、`12k` 都会换算，读不懂时报错而不是记 0。

```text
media(action: "report", group_by: "kind")
→ 图文tag  1 条  播放中位 24000  赞中位 46  互动率 0.52%  评论赞比 1.72
```

## 数据模型

两份 JSONL，字段顺序即写入顺序；缺的值存 `null`（**不填 0**，0 和「后台还没显示」在复盘里是两件事）。

`posts.jsonl`：

| 字段 | 含义 |
|---|---|
| `id` | `p0001` 顺序号，取已有最大号 +1 |
| `platform` | `douyin` / `xhs` / `bilibili` / `shipinhao` |
| `account` | 账号简称（两个号分开统计时必须填） |
| `kind` | 内容型（图文tag / 口播 / 混剪 …） |
| `title` | 标题 |
| `date` | 稿件日期 `YYYY-MM-DD` |
| `published_at` | 实际发布时刻（算 T+ 用） |
| `url` / `note` | 链接、备注（打回原因等），归档用不参与统计 |

`metrics.jsonl`：

| 字段 | 含义 |
|---|---|
| `id` | 对应 `posts.id` |
| `captured_at` | 报数时刻（**真时间**，取最新快照用） |
| `play` / `like` / `comment` / `share` / `collect` | 播放、赞、评、转、藏 |
| `fans` | 涨粉（归档用） |
| `source` | 后台导出 / 手抄 / `B站接口` / `抖音接口` |
| `extras` | 附带口径（可选）：B站导入时放 `settled`（结算值：`play_settled` / `view_dedup` / `progress_pct` / 粉丝路人拆分）与 `diagnose`（画像：性别、年龄、地区、标签、平台占比、受众构成）；抖音导入时放 `douyin`（完播率、平均观看秒数、时长、媒体类型、审核状态、可见状态、列表粗值），台账统计不读它 |

三条口径（都是踩过坑才定下来的）：

1. **一条作品多次报数只取 `captured_at` 最新那条**，比较用真时间解析——字符串比大小会让 `2026-11-17T09:00` 压过 `2026-11-17 18:00`、`2026-9-5` 压过 `2026-11-15`；
2. **用中位数不用均值**：一条爆款就能把均值拉到没有参考价值；
3. **互动率只在「同一条快照里同时有播放和互动」的行上算**，分子分母同批，否则会算出 10050%；混龄期的数不可比，用 `max_age_hours` 取同一批。

## 平台数据同步（采集脚本在插件外）

插件本体不联网（见「隐私」一节），所以后台数据走**两步**，中间用一份 JSON 交接。

```powershell
# 1. 采集（独立 Python 脚本，不依赖第三方库；凭据放工作区根的 config/bilibili_main.txt）
python scripts\bili_sync.py login                       # 首次或 cookie 过期：扫码登录，不手抄 cookie
python scripts\bili_sync.py fetch --max 10              # 产出 <工作区根>\tmp\bili-import.json

# 2. 入库（工具的 import_bili，纯离线：读 JSON、写 JSONL，不发请求）
media { action: "import_bili", path: "<工作区根>\tmp\bili-import.json" }
media { action: "import_bili", path: "…", dry_run: true }   # 先看会新建/更新几条，不写盘
```

采集脚本走的是创作中心自己的接口（`member.bilibili.com/x/web/data/archive`、`archive_diagnose/*`、`archive/index`、`index/stat` 等），只要 Cookie（无需 wbi 签名），但**必须带桌面 UA 与 member.bilibili.com 的 Referer**。它只读不清，退码分档：`0` 成功 / `1` 一般错误 / `2` cookie 过期需重新 `login` / `3` 触发风控降频 / `4` 二维码失效。

口径上有个必须记住的陷阱：**同一条稿件的「播放」有三个不同的值**——

| 取值处 | 含义 |
|---|---|
| `view.stat.view` | 实时、未去重，台账用这个（与后台「核心数据」卡片一致） |
| `archive.stat.play` | 次日 12:00 结算的累计播放 |
| `archive.play.view` | 结算后的**去重**观看数 |

所以 `import_bili` 把实时的 `realtime.*` 写进 `play/like/comment/share/collect`，把结算值与 diagnose 画像整块塞进 `extras`（`settled` / `diagnose`），两边都不丢、也不混着比。另有两条降级规则：`archive.stat` 可能是 `null`（刚发布/刚过审），此时不写 0 而记警告；`area`、`playsource` 可能返回 `null`（后者已废弃，平台占比改看 `diagnose.play_proportion`）。`archive_diagnose/compare` 的 `not_ready_field` 里的指标是「还没算好」，同样不能当真实的 0。

### 小红书数据同步

小红书和前三个平台都不一样：**每个数据接口都要 `x-s` 签名，而且签名把 query 绑死了**——原样重放是 200，换任意参数立刻 406，页内的 `_webmsxyw` 又钩不到调用点。所以脚本不逆签名，改借页面自己的「导出数据」按钮：

```powershell
# 1. 采集（弹一个临时浏览器窗口扫码；之后 fetch 自动灌 cookie、点导出、解析 xlsx）
python scripts\xhs_sync.py login --account main --timeout 600
python scripts\xhs_sync.py fetch --account main --name 你的昵称   # → <工作区根>\tmp\xhs-notes-<时间>.json

# 2. 入库（import_xhs，同样纯离线）
media { action: "import_xhs", path: "<工作区根>\tmp\xhs-notes-<时间>.json" }
```

口径要点：**观看量进 `play`，曝光量只进 `extras.impressions`**（导出两列都给，混了就失真）；封面点击率导出是 0~1 小数，统一 ×100 记 0~100；涨粉进 `fans`；图文与视频分开记 `kind`。导出表里**没有 note_id 也没有链接**，`platform_id` 由 `sha1(标题|发布时间)` 派生（以 `xhs` 开头），合成 id 不拼 `explore` 链接——那地址点开是 404。上限是「排序后前 1000 条」。接口实测细节见 [`docs/XHS_API.md`](docs/XHS_API.md)。



## 抖音数据同步（采集脚本在插件外）

形状和 B站一样：脚本抓、工具灌，中间一份 JSON。差别在**登录**——抖音 passport 对纯 HTTP 申请二维码恒定返回
`error_code: 4031`（「网站存在安全风险已阻止此次访问」，带 ttwid / 指纹头 / csrf 都过不去），所以 `login` 走浏览器：

```powershell
# 1. 采集（会起一个独立 profile 的 Chrome/Edge 让你扫码，扫完自动取 cookie 并关掉）
python scripts\douyin_sync.py login                     # 凭据落到 <工作区根>\config\douyin_main.txt
python scripts\douyin_sync.py fetch --max 50            # 产出 <工作区根>\tmp\douyin-import.json
python scripts\douyin_sync.py whoami                    # 只看当前 cookie 是谁、有没有过期

# 2. 入库（纯离线：读 JSON、写 JSONL，不发请求）
media { action: "import_douyin", path: "<工作区根>\tmp\douyin-import.json" }
media { action: "import_douyin", path: "…", dry_run: true }
```

登录不需要 API 签名：`work_list` 与 `item/mget` 都不在 secsdk 的 `web_protect` 白名单里（白名单只有 14 条，全是写操作和
`user/info`），带 cookie 就够了。退码同样分档：`0` 成功 / `1` 一般错误 / `2` 未登录（`status_code==8`，不重试）/
`3` 风控 / `4` 扫码超时。

登录只走**手机 App 扫码**，脚本永远不碰密码、不碰短信验证码：它拉起的是一个独立 profile 的浏览器（你自己的窗口、扩展、
书签都不受影响），你扫完码它取 `douyin.com` 域的 cookie 落盘就关窗。**登录成功后默认把那个独立 profile 删掉**——目录里
是一份能直接续上账号的活登录态，凭据既然已单独存进 `config/`，就不该再在 `tmp/` 摊一份；想复用它重试再加 `--keep-profile`。

口径上抖音的坑不在「一套数据三个值」，而在**字段不稳定**：创作者中心的接口清单由 prefetch 配置下发、字段名随端漂移，
所以 `lib/douyin.js` 用的是候选链（`metrics.view_count` → `metrics.play_count` → `statistics.play_count` …），
取到粗值会记 warning，一个值都没有就整条不落盘（**绝不写 0**）。`completion_rate` 是 0~1 小数，入库前乘 100 并记一条警告。

---

## 隐私：数据不出本机

- **不联网**：插件代码里没有 `fetch` / `http` / `https` / `net` / `child_process`，没有任何出网路径，也没有第三方依赖（`dependencies` 为空）。`test/smoke.mjs` 里有一条断言守着这个事实，谁哪天加了出网代码，测试会先挂。
- **不写进仓库**：台账默认在工作区根的 `data/media-ledger`（按上表可改，找不到工作区才退回 `~/media-ledger`），两种位置都在仓库外。`.gitignore` 已挡住 `data/` 与 `*.jsonl`，即使把 `dataDir` 指进仓库也不会被提交。
- **不含示例数据**：仓库里没有任何真实作品、账号 ID、播放量，只有代码、文档和自测用的假数据（`test/` 里，一眼可辨是 mock）。
- **不碰宿主的存储**：数据目录由你配置，插件不往 DSH 自己的 profile 或数据库里塞东西。

## 同类开源对照

调研时间 2026-11-17（star 数为 API 实测）：

| 项目 | 规模 | 与这里的关系 |
|---|---|---|
| `woniuniuniu/dsh-media-desk` | 1469★ MIT JS | 名字撞车（本仓库因此改名 `dsh-media-ledger`）；它明说抖音/小红书读不到播放量、复盘按互动算，数据靠付费 Monid |
| `Kuhakucai/douyin-mcp` | 94★ AGPL | 借鉴它的表结构：快照表带 `UNIQUE(sync_job_id, video_id, source)`、派生比例只取同快照分子分母、缺值存 null |
| `CzzzzzzJ/mdldm-maitian` | 872★ MIT | 借鉴它的复盘节奏：发布后第 1/3/7 天出卡片、跟上一期同龄对比、每周一周报；以及 `validate.mjs` 的字数/封面前置校验 |
| DSH 插件生态 | — | 「台账 + 复盘」这个位置此前是空的（`dsh-plugin-content-calendar` 0★ 只有排期） |

## 目录

```text
index.js           插件入口：inject ['tools']，apply 里 ctx.effect 注册并回收
cordis.patch.yml   bundle 补丁（insert media-ledger）
lib/util.js        服务解析、无损 JSON、2.4w 这类数字解析
lib/config.js      平台别名、配置合并
lib/store.js       JSONL 读写（BOM 容错、坏行报行号、重复 id 报错、下一号）
lib/metrics.js     时间解析、最新快照、中位数、互动率、分组报告
lib/pack.js        发布包文本 + 标题/话题/封面的机械校验
lib/bilibili.js    B站采集产出的 JSON → 台账记录（纯函数映射，不联网）
lib/xiaohongshu.js 小红书导出产出的 JSON → 台账记录（纯函数映射，不联网）
lib/douyin.js      抖音采集产出的 JSON → 台账记录（纯函数映射，同一套归一形状，不联网）
lib/tool.js        唯一工具 media（action 分派）
lib/panel.js       面板数据整形（筛选树 facets + 每个切片的复盘，只搬运 metrics 的口径，不另算指标）
lib/bridge.js      Host 侧面板桥：/api/dsh-media-ledger/state 与 /sidebar
lib/client.js      浏览器侧 bundle：侧栏图标「自媒体台账」+ 面板页（左导航 + 右内容）+ 命令面板入口
locale/zh.json     面板标题与说明
locale/en.json     英文标题与说明
docs/DETAIL.md     插件详情页（恰好一行图片，英文）
docs/DETAIL.zh.md  插件详情页（中文）
docs/preview.svg   详情页示意图
docs/DESIGN.md     设计取舍与后续
docs/XHS_API.md    小红书数据分析页接口实测（签名为什么逆不动、导出表怎么解析）
scripts/bili_sync.py       B站采集脚本（独立进程，插件本体不联网）
scripts/xhs_sync.py        小红书采集脚本（走页面导出 xlsx）
scripts/xhs_login.py       小红书扫码登录（借本机浏览器 CDP）
scripts/xhs_browser.py     最小 CDP 客户端（起 Chrome/Edge、灌 cookie、点按钮、收下载）
scripts/douyin_sync.py     抖音采集脚本（独立进程，扫码走浏览器 CDP，插件本体不联网）
scripts/README.md          采集脚本的用法、接口清单与口径说明
AGENTS.md          仓库约束：改代码 / 提交前先读（数据与隐私、详情页契约、验收命令）
```

改这个仓库前先读 [`AGENTS.md`](AGENTS.md)，那里写着不会明说在代码里的坑（`meta.detail` 要路径不要描述、改详情页必须升版本、隐私断言别绕着走、push 成功别看 exit code）。

## 自证

两个脚本都不用装 Node、不用装插件、不开界面，借宿主的 Electron 当 Node 用：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
$node = "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe"   # 换成你自己的安装路径

& $node "test\smoke.mjs"      # 纯函数冒烟 + 隐私断言 + 桥路由 + 客户端 bundle 契约（含真跑一遍）+ 详情页校验，全过 141/141
& $node "test\activate.mjs"   # 假 ctx 跑 apply：注册 / 执行 / 渲染 / 错误路径 / 回收
```

`smoke.mjs` 守的是口径（时间解析、最新快照、互动率同批、BOM、坏行行号、重复 id）和面板契约（列表整形、开关默认开、两条路由的方法与请求体、客户端 bundle 的 ModuleLoader / id / React 来源、bundle 真跑一遍能否注册出侧栏图标与主面板），
`activate.mjs` 守的是接口（工具名、参数表、`execute` 返回无损 JSON、卸载能否回收）。

## 状态

- Host 侧工具已跑通（`add_post` / `add_metrics` / `list` / `report` / `pack` 全部自证）。
- 左侧栏面板已做（0.4.0）：左导航（台账 / 复盘切换 + 平台 → 账号两级筛选）+ 右内容（当前切片的台账或复盘），页内「在左侧栏显示」开关写回 `sidebar` 配置。数据走两条本机路由，不联网。
- B站数据同步已做（0.3.0）：`scripts/bili_sync.py` 采集（独立进程、扫码登录、只读），`import_bili` 纯离线灌进台账；实时/结算两套口径分开存，图片与地区画像进 `extras`。真账号跑过 3 条稿件，重跑幂等。
- 抖音数据同步已做：`scripts/douyin_sync.py` 采集（独立进程、扫码走浏览器 CDP、只读），`import_douyin` 纯离线灌进台账；字段用候选链兜住不稳定的键名，粗值与缺值都记警告、不写 0。**真实键名待第一次带 cookie 跑完 `fetch` 回看 warnings 后定稿。**
- 小红书数据同步已做：扫码登录（借本机浏览器）→ 页面「导出数据」下 xlsx → `scripts/xhs_sync.py` 解析成 JSON → `import_xhs` 灌进台账。真账号跑过 2 条笔记；签名逆不动这件事写进了 [`docs/XHS_API.md`](docs/XHS_API.md)。
- npm 包名待定（`dsh-media-ledger` 这个名字在 npm 上可用，但暂不发布）。
