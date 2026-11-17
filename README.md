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
        dataDir: D:\media-ledger-data   # 自己挑个位置，放笔记/项目目录里都行
```

配置项（都可省）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | 环境变量 `DSH_MEDIA_LEDGER_DIR`，再退到 `~/media-ledger` | 台账目录，放哪由你定，不塞进 DSH 自己的存储 |
| `titleLimits` | 见 `lib/pack.js` | 按平台覆盖标题字数上限 |
| `coverSpecs` | 见 `lib/pack.js` | 按平台覆盖封面建议尺寸 |

## 用一个工具干活

`media` 的 `action`：

| action | 用途 | 必填 |
|---|---|---|
| `add_post` | 记一条作品 | `platform`、`title`（`published_at` 强烈建议填，否则算不出 T+） |
| `add_metrics` | 给某条报一次数 | `id`，以及播放/赞/评/转/藏/涨粉里至少一个 |
| `list` | 查台账（可按平台筛） | — |
| `report` | 出复盘 | —（可选 `group_by`、`max_age_hours`） |
| `pack` | 生成发布包 | `platform`、`title` |

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
| `source` | 后台导出 / 手抄 |

三条口径（都是踩过坑才定下来的）：

1. **一条作品多次报数只取 `captured_at` 最新那条**，比较用真时间解析——字符串比大小会让 `2026-11-17T09:00` 压过 `2026-11-17 18:00`、`2026-9-5` 压过 `2026-11-15`；
2. **用中位数不用均值**：一条爆款就能把均值拉到没有参考价值；
3. **互动率只在「同一条快照里同时有播放和互动」的行上算**，分子分母同批，否则会算出 10050%；混龄期的数不可比，用 `max_age_hours` 取同一批。

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
lib/tool.js        唯一工具 media（action 分派）
locale/zh.json     面板标题与说明
docs/DETAIL.md     设计取舍与后续
```

## 自证

两个脚本都不用装 Node、不用装插件、不开界面，借宿主的 Electron 当 Node 用：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
$node = "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe"   # 换成你自己的安装路径

& $node "test\smoke.mjs"      # 纯函数冒烟，全过 36/36
& $node "test\activate.mjs"   # 假 ctx 跑 apply：注册 / 执行 / 渲染 / 错误路径 / 回收
```

`smoke.mjs` 守的是口径（时间解析、最新快照、互动率同批、BOM、坏行行号、重复 id），
`activate.mjs` 守的是接口（工具名、参数表、`execute` 返回无损 JSON、卸载能否回收）。

## 状态

- Host 侧工具已跑通（`add_post` / `add_metrics` / `list` / `report` / `pack` 全部自证）。
- **面板（Client 槽位）未做**：先按 `docs/DETAIL.md` 里的计划，等工具用顺了再加，避免先做一堆没人点的按钮。
- npm 包名待定（`dsh-media-ledger` 这个名字在 npm 上可用，但暂不发布）。
