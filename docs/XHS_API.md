# 小红书创作中心 · 数据分析页接口分析

> 目标：把 `creator.xiaohongshu.com/statistics/data-analysis`（数据分析）的数据聚合进本插件台账。
> 本文只记录**实测**结果；没打通的写「待实测」，不做推测式描述。
> 实测时间：2026-11-18，未登录状态 + 浏览器 UA + `Referer`/`Origin` 同源；python 标准库直连。
> 分析对象：`https://creator.xiaohongshu.com/statistics/data-analysis`

---

## 0. 结论摘要

| 事项 | 结论 |
|---|---|
| 页面框架 | 微前端：`bundler-runtime` + `library-launcher`（zeus 引擎）+ 业务 chunk；统计页代码在 `index.ee084460.js` |
| 接口清单来源 | **前端常量表**（不像抖音用服务端 prefetch JSON）：所有路径写死在 `index.ee084460.js` 的 `API_LIST` 里，改版要发版 |
| 数据接口网关 | `creator.xiaohongshu.com/api/galaxy/...`，**也要 `x-s` 签名**（先前的「不校验」结论已推翻，见 §4.3）；未登录时回 `HTTP 401` + `{"code":-100,...,"msg":"无登录信息"}` |
| 登录接口网关 | `edith.xiaohongshu.com/api/sns/web/...`，**强制 `x-s` 签名**；裸 HTTP 一律 `HTTP 406 {"code":-1,"success":false}` |
| 扫码登录（纯 HTTP） | **走不通**：二维码创建接口在 edith，签名不过就没二维码（实测 406，加 `a1` cookie、加假 `X-s` 都不行） |
| 扫码登录（借浏览器） | **可行**（实测通过）：起本机 Chrome + CDP，让页面自己出二维码，脚本轮询 cookie 拿 `web_session` |
| 签名头 | `X-S` / `X-t` / `X-Mns` / `X-S-Common`（还有 `Sc-T`）；签名函数 `window._webmsxyw` 由服务端下发脚本注入 |
| 签名强度 | **签名把 query 绑死了**：抓到真实请求原样重放 → 200；改任一参数（甚至删掉时间参数）→ 406。页内 `_webmsxyw` 能算出签名，但钩不到调用（模块闭包持有） |
| 采集结论 | **不自己签名**。改借页面自己的「导出数据」按钮拿 `笔记列表明细表.xlsx`，一次导出拿到全部笔记的核心字段（上限 1000 条） |

> 一句话把工程决策说清：**别去逆 `x-s`**。它能算但绑参数、拿不到调用点，短线内稳不住；而页面上「导出数据」已经把要的指标全给了，采集就该走这条路——浏览器只负责点一下按钮和收文件，其余全在本地解析。

---

## 1. 页面与技术栈

- 入口：`GET https://creator.xiaohongshu.com/statistics/data-analysis` → HTTP 200，**19,386 字节**的 SPA 壳（同一个壳也服务 `/statistics/note-analysis` 等路由）。
- 静态资源基址：`https://fe-static.xhscdn.com/formula-static/ugc/public/resource/js/`
- 壳里写死的 23 个 script（实测抓取，按大小排）：

| 文件 | 大小 | 作用 |
|---|---|---|
| `project-publish-vue.d001adc9.js` | 2.3 MB | 发布页主包，也含 40 条 galaxy 路径（发笔记相关） |
| `5903.71b2950a.js` | 2.3 MB | 共享 chunk（39 条 galaxy 路径） |
| `index.ee084460.js` | 948 KB | **统计/数据分析页业务包**：20 处 `datacenter`、51 条 galaxy 路径全在这 |
| `project-publish-components.287b8717.js` | 480 KB | 通用组件（**登录组件**在这里：二维码 create/status、手机号验证码都在这） |
| `library-launcher.35569672.js` | 888 KB | zeus 微前端启动器 + **安全脚本加载器**：`X-S` / `X-S-Common` / `_webmsxyw` 的装配逻辑 |
| `library-delight.c2ec6e48.js` | 1.7 MB | 组件库（含 `x-s` 字样，非签名逻辑） |
| 其余 `library-*` | 200-900 KB | polyfill、element-plus、axios、vue、lodash、cos-sdk、swiper、onnxruntime、protobuf 等 |

> 找接口时**先看 `index.ee084460.js`**：它是单行压缩代码，用正则 `/api/galaxy/[A-Za-z0-9_\-/.]+` 一把捞即可；`project-publish-vue` 里那些是发布页的，不要混进来。

### 1.1 接口清单是前端常量表

`index.ee084460.js` 里有一组 `API_LIST` 对象，路径用 `.concat()` 拼在 base 上：

```js
API_LIST = {
  NOTE_ANALYZE_LIST: "/api/galaxy/creator/datacenter/note/analyze/list",
  NOTE_ANALYZE_LIST_DOWNLOAD: ".../note/analyze/download",
  BASE_NOTE_INFO: ".../note/base",
  AUDIENCE_TREND: ".../note/analyze/audience/trend",
  AUDIENCE_SOURCE: ".../note/audience/source",
  AUDIENCE_SOURCE_DETAIL: ".../note/audience/source/detail",
  QUERY_ACCOUNT_DATA: "/api/galaxy/v2/creator/datacenter/account/base",
  QUERY_FANS_DATA: "/api/galaxy/v2/creator/datacenter/audience/source/account",
  QUERY_VIEW_TIME_DATA: "/api/galaxy/v2/creator/datacenter/audience/view/periods",
  QUERY_LIVE_DATA: "/api/galaxy/v2/creator/datacenter/livedata/overview",
  PERMISSION: "/api/galaxy/creator/datacenter/permission/query",
}
```

> 与抖音的对照：抖音把「路由 → 预取哪些接口」放在服务端 `prefetch.json`（前端不写路径）；小红书反过来，路径写死在前端常量表。**所以小红书改版要发版，抖音不用。**

---

## 2. 数据分析页相关接口（从 bundle 抽出，按用途分组）

### 2.1 账号维度

| 路径 | 常量名 | 用途 |
|---|---|---|
| `/api/galaxy/v2/creator/datacenter/account/base` | `QUERY_ACCOUNT_DATA` | 账号概览（粉丝总数/新增、主页访客、互动数） |
| `/api/galaxy/v2/creator/datacenter/audience/source/account` | `QUERY_FANS_DATA` | 粉丝来源（首页推荐/搜索/其他） |
| `/api/galaxy/v2/creator/datacenter/audience/view/periods` | `QUERY_VIEW_TIME_DATA` | 粉丝活跃时段 |
| `/api/galaxy/v2/creator/datacenter/livedata/overview` | `QUERY_LIVE_DATA` | 直播数据概览 |
| `/api/galaxy/creator/datacenter/account/analyze/download` | `ACCOUNT_DATA_DOWNLOAD` | 账号数据导出（文件流） |
| `/api/galaxy/v2/download/creator/datacenter/account/analyze` | `INDICATORS_DOWNLOAD` | 指标导出（文件流） |

### 2.2 笔记（作品）维度 —— 台账主要用这几条

| 路径 | 常量名 | 用途 |
|---|---|---|
| `/api/galaxy/creator/datacenter/note/analyze/list` | `NOTE_ANALYZE_LIST` | **笔记列表 + 每篇核心指标**（数据分析页主表） |
| `/api/galaxy/creator/datacenter/note/base` | `BASE_NOTE_INFO` / `NOTE_STATICS` | 单篇笔记基础数据 |
| `/api/galaxy/creator/datacenter/note/analyze/audience/trend` | `AUDIENCE_TREND` | 单篇受众趋势 |
| `/api/galaxy/creator/datacenter/note/audience/source` | `AUDIENCE_SOURCE` | 单篇流量来源 |
| `/api/galaxy/creator/datacenter/note/audience/source/detail` | `AUDIENCE_SOURCE_DETAIL` | 流量来源明细 |
| `/api/galaxy/creator/datacenter/note/analyze/download` | `NOTE_ANALYZE_LIST_DOWNLOAD` | 笔记列表导出 |
| `/api/galaxy/creator/datacenter/note/{core,basic,interact}/data/download` | `*_DOWNLOAD` | 单篇明细导出 |
| `/api/galaxy/creator/datacenter/permission/query` | `PERMISSION` | 数据权限（有没有开专业号/数据看板） |

### 2.3 笔记管理 / 发布侧（本次不用，记下来免得下次重找）

- 笔记管理：`/web_api/sns/v5/creator/note/managemaent/search`（注意官方拼写就是 `managemaent`）、`/api/galaxy/v2/creator/note/user/posted`、`/api/galaxy/creator/sns/note/top`
- 发布：`/web_api/sns/capa/postgw/note/{delete,detail,update}`、`/api/sns/v1/note/privacy`
- 账号：`/api/galaxy/creator/home/personal_info`、`/api/galaxy/user/info`、`/api/galaxy/user/logout`

---

## 3. 未登录实测（判断「卡在哪一层」的关键）

三个网关的行为完全不同，**这是本文最有用的结论**：

```text
GET https://creator.xiaohongshu.com/api/galaxy/creator/datacenter/note/analyze/list?page=1&page_size=10&sort=desc&type=1
→ HTTP 401  {"code":-100,"data":{},"msg":"无登录信息","success":false}          ← 业务层拒绝，说明签名网关已放行

GET https://creator.xiaohongshu.com/api/galaxy/v2/creator/datacenter/account/base
→ HTTP 401  {"code":-100,"data":{},"msg":"无登录信息","success":false}

GET https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info
→ HTTP 401  {"code":-1,"data":"<32 位 md5>","msg":"登录已过期","result":-100,"success":false}

GET https://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo
→ HTTP 406  {"code":-1,"success":false}                                          ← 签名层直接拦掉，连业务层都没到

POST https://edith.xiaohongshu.com/api/sns/web/v1/login/qrcode/create   {"qrType":1}
→ HTTP 406  {"code":-1,"success":false}     （带 a1/webId cookie、带假 X-s 都一样）
→ 换 www.xiaohongshu.com 同路径：HTTP 500  "create invoker failed, service: jarvis-gateway-default"
```

**判据速记**：

| 现象 | 含义 |
|---|---|
| `401` + `code:-100` + `无登录信息` | galaxy 网关：没签名问题，只是没登录 → 有 cookie 就能读 |
| `406` + `{"code":-1,"success":false}` | edith 网关：**签名缺失/非法**，与登录态无关 |
| `500 create invoker failed, service: jarvis-gateway-default` | 打到了错误的 host（www 上的 galaxy 网关），路径不对 |

响应封套（galaxy 统一）：`{ code, data, msg, success }`，成功 `code == 0 && success === true`；`data` 是业务体。

---

## 4. 签名机制（要不要逆？不要）

### 4.1 谁在加签名

`library-launcher.35569672.js` 里是一段 axios 拦截器（压缩后变量名 `en` / `eo` / `ed`）：

```js
// en：给需要签名的请求加 X-S / X-t
var o = "X-s", b = "X-t", x = 规范化后的 URL(path+query)，u = 签名函数;
f.headers[o] = u(x, body);        // u === window._webmsxyw
f.headers[b] = +new Date + "";    // 毫秒时间戳
f.headers["X-Mns"] = window.mns ? window.mns.getMnsToken(...) : "unload";

// eo：加 X-S-Common（设备指纹摘要，base64 后的 JSON）
m = { s0: 平台编号, s1: "", x0: 本地 key, x1: …, x2: "PC", x3: "ugc", x4: "1.42.0", x5..x12: … };
f.headers["X-S-Common"] = encode(JSON.stringify(m));

// ed：加 Sc-T
f.headers["Sc-T"] = window.__xhs_sc__.getXHSToken() || "";
```

- 签名函数 `window._webmsxyw` 和 `window.mns` **不是 bundle 里的**，由服务端下发的安全脚本注入（loader 里 `U = "/api/sec/v1/scripting"`、`L = "/api/sec/v1/sbtsource"`，还有 `websectiga` / `sec_poison_id` / `xsecappid` 这几个 localStorage/cookie key）。**所以复刻签名 = 复刻一段会变的混淆脚本**，不稳定，别做。
- 实测：登录页跑起来后，页面上下文里 `typeof window._webmsxyw === "function"`（可用），`typeof window.mns === "undefined"`（creator 站没注入 mns，所以 `X-Mns` 对 creator 不关键）。
- 拦截器里的 `d.JJ(url)` 决定「这条 URL 要不要签」；未登录实测：galaxy 路径未签名能过到业务层（401 `code:-100`），sns/web 路径未签名卡在 406。**但登录态下 galaxy 同样要签名**，见 §4.3。

### 4.2 哪些要签，哪些不要

| 网关 / 前缀 | 签名 | 证据 |
|---|---|---|
| `creator.xiaohongshu.com/api/galaxy/**` | **要**（登录态实测） | 原样重放 200、改参数 406，见 §4.3 |
| `edith.xiaohongshu.com/api/sns/web/**` | **要** | 未签名返回 406 `{"code":-1}` |
| `edith.xiaohongshu.com/api/qrcode/**` | 要（且只在 edith 有，www 上 404/503） | 见 §5 |

### 4.3 实测：签名把 query 绑死了（所以不逆）

用 `scripts/xhs_browser.py` 起无头浏览器 + 灌 cookie，打开数据分析页，从 CDP 抓真实列表请求：

- URL：`/api/galaxy/creator/datacenter/note/analyze/list?post_begin_time=1792252800000&post_end_time=1795017599000&type=0&page_size=10&page_num=1`（**参数确为 snake_case**，时间是毫秒）
- 头：`X-s`（340 字符，`XYW_` 前缀的 base64，解出来是 `{"signSvn":"56","signType":"x2","appId":"ugc","signVersion":"1","payload":"…"}`）、`X-t`（13 位毫秒）、`X-S-Common`（320 字符）、`x-b3-traceid`、`x-xray-traceid`、`Referer`、UA

实验结果：

| 做法 | 结果 |
|---|---|
| 原样重放（同 URL 同头） | **200**，`{"msg":"成功","data":{"total":2,"result":{…},"note_infos":[{"id":"6afc…8304",…}]}}` |
| 改 `type` / `page_size` / `page_num` | **406** |
| 删掉时间参数 | **406** |
| 页内调 `window._webmsxyw(path, params)` 取签名再发 | **406**（即使用同一份真实 `X-S-Common`、补 traceid） |
| `Object.defineProperty` 或 20ms 轮询去包 `_webmsxyw` 记录调用 | **录不到**（`signLog` 恒为 0，页面用的是闭包里那份） |

结论：签名与「路径+query+body」绑定，且拿不到页面内部的调用点，**复刻签名不可行**。要拿数据只有两条路：①在页面上下文里发请求（受制于页面自己的分页与筛选）；②用页面提供的导出。实测「导出数据」按钮（右上角，点击无二次确认）直接下 `笔记列表明细表.xlsx`，字段够台账用，故取②。

---

## 5. 扫码登录

### 5.1 链路（从前端组件里读出来的）

`project-publish-components.287b8717.js` 的 `ScanLogin` 组件：

| 步骤 | 请求 | 说明 |
|---|---|---|
| 1 | `POST {edith}/api/sns/web/v1/login/qrcode/create`（body `{"qrType":1}`） | 返回 `qrId`、`code`、`url`（`url` 是二维码内容，页面自己渲染） |
| 2 | `GET {edith}/api/qrcode/userinfo?qrId=&code=` | 轮询扫码状态，返回 `codeStatus` |
| 3 | `GET {edith}/api/sns/web/v1/login/qrcode/status?qrId=&code=` | 拿到 `ticket`；成功后服务端种 `web_session` cookie |

`codeStatus` 枚举（组件里的映射表 `{0:2, 1:3, 2:1, 3:4}` 再化成对外状态）：`0` = 待扫、`1` = 已扫待确认、`2` = 已确认、`3` = 失效。另有 `x-rednote-datactry` / `x-rednote-holderctry` 两个头用于地区分流（国内站不用管）。

`base` 的取法（组件里 `nE()`）：`creator.xiaohongshu.com` 页面上固定打 `https://edith.xiaohongshu.com`；测试环境才走 `logan.devops.xiaohongshu.com/proxy/*`。`passport.xiaohongshu.com` **域名不存在**（DNS 解析失败），别照着 B 站的经验去猜。

### 5.2 为什么纯 HTTP 做不到（实测）

- 第 1 步就打不通：`406 {"code":-1,"success":false}`。
- 试过且**仍然 406** 的组合：带 `a1` + `webId` cookie、带 `X-t`、带假 `X-s`、换 `www.xiaohongshu.com`（变 500 jarvis-gateway）、换 `customer.xiaohongshu.com/api/cas/qrcode`（404）。
- 结论：**二维码本身就要签名才能创建**，没有二维码就没有可扫的东西。这和 B 站（`passport.bilibili.com` 裸 HTTP 就能拿二维码）本质不同。抖音那边也是同类问题（passport 风控 4031），两边都只能绕。

### 5.3 可行的扫码方案：借本机浏览器（已实测）

不逆签名，改成「让浏览器替我们扫码」：

1. 脚本用 `--remote-debugging-port=9333 --user-data-dir=<临时 profile>` 起本机 **Chrome/Edge**（本机实测 Chrome 157 可用，Edge 也在），导航到 `https://creator.xiaohongshu.com/login`。
2. 窗口里是**小红书官方的登录二维码**，用户用 App 扫（体验和自己开浏览器登录完全一样）。
3. 脚本通过 CDP 轮询 `Network.getAllCookies`，等到 `web_session` 出现即为登录成功。
4. 把 `xiaohongshu.com` 域的 cookie 串写入 `config/xhs_<account>.json`，关掉浏览器和临时 profile。

实测到的 cookie：登录页自己会下发 `a1`、`webId`、`websectiga`、`sec_poison_id`、`xsecappid`、`gts`、`acw_tc`、`loadts`、`ets`、`webBuild`、`gid`；登录成功后多 `web_session`。

> 这条路径还有一个顺带的好处：临时 profile 是全新的，不碰用户日常浏览器，也不用装 Playwright —— 标准库起进程 + 一个最小 WebSocket 客户端（约 90 行，RFC6455 文本帧就够）即可。

---

## 6. 字段 → 台账映射

导出的 `笔记列表明细表.xlsx` 结构（实测）：第 1 行是合并提示「最多导出排序后前 1000 条笔记」，第 2 行是表头，第 3 行起是数据；`xl/sharedStrings.xml` 是空的，所有字符串都是 `t="inlineStr"` 的 `<is><t>`，所以解析要走 inlineStr 分支（别只认 sharedStrings）。

| 导出列 | 台账字段 | 说明 |
|---|---|---|
| 笔记标题 | `post.title` | 也是派生成 `platform_id` 的原料 |
| 首次发布时间 | `post.published_at` / `post.date` | 原样是 `2026年11月17日22时26分25秒`，脚本转成 `YYYY-MM-DD HH:MM:SS` |
| 体裁 | `post.kind` | 「视频」→ `视频`，其余记 `图文` |
| 观看量 | `metric.play` | **观看量不是曝光量**，别混 |
| 曝光 | `extras.impressions` | 只作旁证，不进 `play` |
| 封面点击率 | `extras.cover_click_rate` | 导出是 0~1 小数（如 `0.037`），台账统一 0~100，×100 |
| 点赞 / 评论 / 收藏 / 分享 | `metric.like` / `comment` / `collect` / `share` | |
| 涨粉 | `metric.fans` | 小红书有这一列，B站没有；`report` 目前不用它 |
| 人均观看时长 | `extras.view_time` | 秒 |
| 弹幕 | `extras.danmaku` | |

**导出不给 note_id，也不给链接**。`note_id` 由脚本派生：`xhs` + `sha1("{标题}|{发布时间}")[:14]`；同一篇笔记标题与发布时间不变就稳定，改标题会变成「新作品」（可接受，导出表里没别的稳定键）。合成 id 不拼 `explore/<id>` 链接——那地址点开是 404，宁可空着。

台账记录形状（与 B站一致）：

```js
post   = { platform, account, kind, title, date, published_at, url, note, platform_id }
metric = { post_id, captured_at, play, like, comment, share, collect, fans?, extras }
```

---

## 7. 采集脚本设计（`scripts/xhs_sync.py`）

| 项 | 约定（对齐 `bili_sync.py`） |
|---|---|
| 依赖 | 只用标准库（`zipfile` + `xml.etree.ElementTree` 解 xlsx；`subprocess` + `socket` 起浏览器） |
| 凭据 | `<工作区根>/config/xhs_<account>.json`，一个 JSON 对象（`json.dumps(indent=2)`；旧的一行 `k=v; k=v` 仍能读）（只读取、不回显） |
| 输出 | 默认 `<工作区根>/tmp/xhs-notes-<时间>.json`，`--out` 可改，`--dump` 另存原始导出表行 |
| `login` | 借浏览器扫码（§5.3），拿到 `web_session` 即写凭据 |
| `fetch` | 起浏览器 → 灌 cookie → 开数据分析页 → 点「导出数据」→ 等下载 → 解析 xlsx → 写契约 JSON |
| 浏览器 | 默认可见窗口（导出按钮要点，页面状态更稳），`--headless` 也可跑通（实测） |
| 节流/重试 | 只有一次页面加载 + 一次点击，不需要节流；下载超时按 `--timeout`（默认 120s） |
| 退出码 | 0 成功 / 1 一般错误 / 2 凭据失效 / 3 风控或页面异常 / 4 下载超时 |
| 已知限制 | 导出只给排序后前 1000 条；没有 note_id 与链接（见 §6） |

---

## 8. 已打通 / 待实测

已打通（2026-11-18 实测）：

- [x] 扫码登录 → `config/xhs_main.json`（14 个 cookie 字段），自查页面显示登录态
- [x] 导出按钮下载 xlsx（4193 字节 / 2 篇笔记），解析出 13 列
- [x] `fetch --headless` 全链路跑通，产出契约 JSON，插件的 `normalizeImport` 映射正确（`play=74/132`、`extras={impressions:369, cover_click_rate:3.7, view_time:6}`）
- [x] galaxy 网关登录态下的签名行为（§4.3）

待实测（不阻塞，记下来省下次重找）：

- [ ] `page_size` 上限、`sort_type` / `type` 时间范围枚举的合法取值（要精确筛选时才有用）
- [ ] `note/base?noteId=` 的返回结构（想补单篇详情、拿真 note_id 时用）
- [ ] `web_session` 有效期与失效表现（是 401 `code:-100` 还是页面弹登录框）
- [ ] 超过 1000 条笔记时导出的实际行为（截断还是分片）
- [ ] 图文笔记在导出表里的「体裁」原文（当前样本只有视频）
