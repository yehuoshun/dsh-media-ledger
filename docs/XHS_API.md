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
| 数据接口网关 | `creator.xiaohongshu.com/api/galaxy/...`，**不需要 `x-s` 签名**；未登录只回 `HTTP 401` + `{"code":-100,...,"msg":"无登录信息"}` |
| 登录接口网关 | `edith.xiaohongshu.com/api/sns/web/...`，**强制 `x-s` 签名**；裸 HTTP 一律 `HTTP 406 {"code":-1,"success":false}` |
| 扫码登录（纯 HTTP） | **走不通**：二维码创建接口在 edith，签名不过就没二维码（实测 406，加 `a1` cookie、加假 `X-s` 都不行） |
| 扫码登录（借浏览器） | **可行**（实测）：起本机 Chrome + CDP，让页面自己出二维码，脚本轮询 cookie 拿 `web_session` |
| 签名头 | `X-S` / `X-t` / `X-Mns` / `X-S-Common`（还有 `Sc-T`）；签名函数 `window._webmsxyw` 由服务端下发脚本注入 |
| 采集结论 | **数据侧只要 cookie、不要签名**；只有登录这一步需要签名 → 登录借浏览器，采集仍走纯 HTTP |

> 一句话把工程决策说清：**别去逆 `x-s`**。数据接口在 galaxy 网关，验完登录态就放行；真正卡签名的是 edith 上的登录接口，而那一步用本机浏览器扫码就绕过去了。

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
- 拦截器里的 `d.JJ(url)` 决定「这条 URL 要不要签」；实测的反证很清楚：**galaxy 路径未签名能过到业务层，sns/web 路径未签名卡在 406**。

### 4.2 哪些要签，哪些不要

| 网关 / 前缀 | 签名 | 证据 |
|---|---|---|
| `creator.xiaohongshu.com/api/galaxy/**` | **不要** | 未签名请求返回 401 + `code:-100`（业务层错误） |
| `edith.xiaohongshu.com/api/sns/web/**` | **要** | 未签名返回 406 `{"code":-1}` |
| `edith.xiaohongshu.com/api/qrcode/**` | 要（且只在 edith 有，www 上 404/503） | 见 §5 |

> 保留风险：登录态下 galaxy 是否**额外**要求某些头（如 `X-S-Common`）尚未实测（拿不到真 cookie）。采集脚本要为此留一条降级路径：检测到 406 就提示「改用 `--browser` 模式」，浏览器模式下所有请求都在页面里发，签名由页面自己的注入脚本负责。

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
4. 把 `xiaohongshu.com` 域的 cookie 串写入 `config/xhs_<account>.txt`，关掉浏览器和临时 profile。

实测到的 cookie：登录页自己会下发 `a1`、`webId`、`websectiga`、`sec_poison_id`、`xsecappid`、`gts`、`acw_tc`、`loadts`、`ets`、`webBuild`、`gid`；登录成功后多 `web_session`。

> 这条路径还有一个顺带的好处：临时 profile 是全新的，不碰用户日常浏览器，也不用装 Playwright —— 标准库起进程 + 一个最小 WebSocket 客户端（约 90 行，RFC6455 文本帧就够）即可。

---

## 6. 字段 → 台账映射

（待补：依赖 `note/analyze/list` 与 `note/base` 的真实字段名，见 §8 待实测 1。）

台账现有口径（B站那套已定型，小红书沿用形状）：

```js
post   = { platform, account, kind, title, date, published_at, url, note, platform_id }
metric = { post_id, captured_at, play, like, comment, share, collect, extras }
```

---

## 7. 采集脚本设计（`scripts/xhs_sync.py`）

| 项 | 约定（对齐 `bili_sync.py`） |
|---|---|
| 依赖 | 只用标准库（含 `socket`/`ssl`/`subprocess` 起浏览器） |
| 凭据 | `<工作区根>/config/xhs_<account>.txt`，一行 `name=value; name=value; …` |
| 输出 | `<工作区根>/tmp/xhs-import.json` |
| `login` | 默认借浏览器扫码（§5.3）；`--cookie "…"` 可直接粘贴导入（应急） |
| `fetch` | 纯 HTTP + cookie：`note/analyze/list` 翻页 → 可选 `note/base` 补单篇 → 账号概览 |
| 降级 | 纯 HTTP 若遇 406，提示改 `--browser` 模式（页面内 `fetch`，签名由页面负责） |
| 节流 | ≥0.35 s / 请求，与 B站一致；`code != 0` 不重试，传输错误重试 2 次 |
| 退出码 | 0 成功 / 1 一般错误 / 2 凭据失效（401 `code:-100`）/ 3 风控（406 或其他风控码）/ 4 二维码超时 |

---

## 8. 待实测清单

- [ ] 登录态下 `note/analyze/list` 的真实请求参数与 `data` 字段名（本页 §6 依赖它）
- [ ] 登录态下 galaxy 是否仍不校验 `X-S-Common`（决定 `--browser` 模式是不是必需）
- [ ] `page_size` 上限、`sort` / `type` / 时间范围枚举的合法取值
- [ ] `note/base` 的单篇参数名与返回结构
- [ ] `web_session` 有效期、失效表现（是 401 `code:-100` 还是 `登录已过期`）
- [ ] 图文与视频笔记在列表里的类型字段差异（`type` 枚举）
