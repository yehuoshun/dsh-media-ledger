# 抖音创作中心 · 作品管理页接口分析

> 目标：把 `creator.douyin.com/creator-micro/content/manage`（作品管理）的数据聚合进本插件台账。
> 本文只记录**实测**结果；没打通的写「待实测」，不做推测式描述。
> 实测时间：2026-11-18，未登录状态 + 浏览器 UA + 同源 Referer/Origin。

---

## 0. 结论摘要

| 事项 | 结论 |
|---|---|
| 作品列表接口 | `GET /janus/douyin/creator/pc/work_list`，**不需要签名**，未登录返回 `status_code: 8` |
| 作品详情接口 | `GET /web/api/creator/item/mget?ids=<id>&fields=metrics,review,play_info`，**不需要签名** |
| 接口清单来源 | 不是前端写死的，是**服务端下发的 prefetch 配置**（微前端），改版时前端不用发版 |
| 扫码登录（纯 HTTP） | **走不通**：passport 网关对非浏览器客户端一律回 `error_code: 4031`，带 ttwid/指纹头也不行 |
| 页面自带反自动化 | 有：`562.*.js` 里检测 `__playwright__` / `__webdriver` / `__selenium` / `__cdc_` / `chrome.csi` 等 |
| 写操作 | 需要 secsdk `web_protect` 签名（signVersion 2），本仓库不做代发布，不涉及 |

---

## 1. 页面与技术栈

- 入口 `https://creator.douyin.com/creator-micro/content/manage` → HTTP 200，18,701 字节 SPA 壳。
- 静态资源基址：`https://lf-fe-creator.douyinstatic.com/obj/douyn-creator-scm-cdn/douyin-creator-master-new/`
  - `static/js/builder-runtime.79889262.js`（5.2 KB，内含 async chunk 表，29 个 chunk）
  - `static/js/main.394140d5.js`（743 KB）、`static/js/805.42ac3bdb.js`（3.1 MB）
  - `static/js/async/<id>.<hash>.js` × 29
- 首次访问只下发 cookie `gd_random`（无 ttwid、无 passport cookie）。

### 1.1 路由 → 接口的契约是 prefetch 配置

页面是微前端，「这个路由要预取哪些接口」由服务端 JSON 下发，**前端 bundle 里搜不到这些路径**：

```
GET https://creator.douyin.com/goofy/douyin_creator_pc/mono/prefetch/creator_content/manage/prefetch.json
```

```json
{"apis":[{"url":"/janus/douyin/creator/pc/work_list",
          "params":{"status":0,"count":12,"max_cursor":0,"scene":"star_atlas",
                    "device_platform":"android","aid":1128},
          "credentials":"same-origin"}]}
```

作品详情页同理：

```
GET .../prefetch/work-management/work-detail/prefetch.json
```

```json
[{"url":"/web/api/creator/item/mget",
  "params":{"ids":"<路由参数 :id>","fields":"metrics,review,play_info"},
  "headers":{"Agw-Js-Conv":"str"}},
 {"url":"/janus/douyin/creator/data/author/upgrade",
  "headers":{"Agw-Js-Conv":"str"}}]
```

> 工程含义：**这些路径不要在 bundle 里找**。29 个 async chunk 全量抓下来 grep `work_list` / `item/mget` / `janus` 均 0 命中，`main.js` 里也 0 命中；要加/换接口只能读 prefetch JSON（或抓包）。反过来，抖音改接口时这份文档的路径可能失效——重跑一次 `prefetch.json` 就能拿到最新清单。

---

## 2. 实测的三个接口

### 2.1 作品列表 `work_list` 【实测】

```
GET https://creator.douyin.com/janus/douyin/creator/pc/work_list
    ?status=0&count=12&max_cursor=0&scene=star_atlas&device_platform=android&aid=1128
```

| 参数 | 值 | 说明 |
|---|---|---|
| `status` | 0 / 1 / 2 … | 作品状态页签；0 是默认页签（实测 0、1 返回同形封套） |
| `count` | 12 | 页大小，prefetch 里是 12；上限待实测 |
| `max_cursor` | 0 | 翻页游标，首页 0，后续取上页返回的 `max_cursor` |
| `scene` | `star_atlas` | 场景标识，prefetch 原样带 |
| `device_platform` | `android` | 沿 prefetch；换成 `web` 也能过网关（见下） |
| `aid` | 1128 | `1128` 是抖音客户端；`2906` 是创作者中心 web 的 app_id，两者都能过 |

未登录响应（HTTP 200，259 字节）：

```json
{"activity_list":null,"aweme_list":null,"can_modify":null,
 "creator_self_tags_response":null,
 "extra":{"logid":"2026...03784","now":1794934530000},
 "has_more":null,"items":[],"max_cursor":null,"min_cursor":null,
 "status_code":8,"total":null}
```

- **`status_code: 8` = 未登录**（不是 0，也不抛 HTTP 错误码）。登录后其它字段才有值。
- 分页字段：`items[]` + `max_cursor` + `has_more` + `total`。
- `activity_list` / `creator_self_tags_response` 是页面上的运营位与自选标签，台账用不到。

### 2.2 作品详情 `item/mget` 【实测（封套）/ 待实测（条目字段）】

```
GET https://creator.douyin.com/web/api/creator/item/mget?ids=<item_id>&fields=metrics,review,play_info
Header: Agw-Js-Conv: str
```

未登录响应：

```json
{"BaseResp":{"Extra":{},"StatusCode":8,"StatusMessage":"用户未登录"},
 "items":[],"status_code":8,"status_msg":"用户未登录"}
```

- 双层封套：外层 `status_code` + 内层 `BaseResp.StatusCode`，**两个都要判**。
- `fields` 是白名单参数，只回 `metrics` / `review` / `play_info` 三组。`metrics` 就是播放/互动数那组，`play_info` 是播放相关明细，`review` 是审核状态。
- 单个 `items[]` 元素的具体键名**未实测**（要登录 cookie）；按抖音 item 系列惯例应是 `aweme_id` / `desc` / `create_time` / `statistics.*` / `video.duration` / `share_url` 一类，**实施前必须用真实 cookie 打一次确认，不要照猜写映射**。

### 2.3 其它实测过的路径

| 路径 | 未登录返回 | 用途 |
|---|---|---|
| `/janus/douyin/creator/data/author/upgrade` | `{"status_code":0,"upgrade_type":0,...}` | 数据看板开通状态；**未登录也 200 成功**，可当连通性探针 |
| `/aweme/v1/creator/pc/user/info/?aid=2906&device_platform=web` | `{"status_code":8,"status_msg":"用户未登录"}` | 账号信息（昵称/uid/粉丝），**在签名白名单内** |
| `/web/api/media/aweme/search/post?items=<id>&aid=2906&app_name=aweme_creator_platform&device_platform=web` | `{"status_code":8,"status_msg":"用户未登录"}` | 单作品数据（另一条路，未深入） |
| `/aweme/v1/creator/login/` | `{"status_code":0,"status_msg":"url doesn't match"}` | 不是登录接口，别被名字骗了 |

---

## 3. 签名机制：哪些接口要签名

`main.js` 里的 secsdk 配置：

```js
cd.setConfig({ aid: 2906, scene: "web_protect", certType: "cookie", signVersion: 2,
               consumerPathList: [ ... ] })
```

`consumerPathList` 恰好这 14 条，**只有它们要 `a_bogus` 类签名**：

```
/web/api/media/aweme/create            /web/api/media/aweme/create_v2
/web/api/media/aweme/update_v2         /web/api/media/aweme/delete
/web/api/media/aweme/reedit            /web/api/media/aweme/draft
/web/api/media/aweme/editor/compose/trigger
/passport/token/beat/web               /api/ai_platform
/aweme/v1/creator/comment/reply
/aweme/v1/creator/pc/user/info         /aweme/v1/creator/user/info
/web/api/media/user/info               /web/api/v2/creator/xigua/user/info
```

**读接口（`work_list`、`item/mget`、`media/aweme/search/post`）不在名单里 → 不需要签名**，这一点已由「无签名请求能过到应用层并返回 `status_code:8`」反证：4103/签名错会先被网关拦下，不会到业务层。

注意 `user/info` 在名单里——采集脚本若要拿账号昵称，会遇到签名问题，**优先从 `work_list` 的 `extra`/`items[].author` 里取，别去碰 `user/info`**。

---

## 4. 扫码登录：纯 HTTP 走不通（实测）

前端登录逻辑在 `main.js` 的 account SDK 类（模块 74694），路径常量：

| 路径 | 方法 | 关键参数 |
|---|---|---|
| `/passport/web/get_qrcode/` | GET | `next`、`need_short_url`、`need_logo=false`、`is_new_login=1`，公共参数 `aid` + `is_from_iesaccountsaas=1` + `p_ui=2.4.14-beta.11` |
| `/passport/web/check_qrconnect/` | POST | `token`、`need_logo`、`is_frontier`、`is_new_login`、`next`、`need_short_url` |
| `/passport/web/expire_qrcode/` | POST | — |

SDK 类默认 `aid=6383`，创作者中心全局 `aid=2906`（`setConfig({aid:2906,...})`）。

**实际请求全部被 passport 风控拦在门口**，恒返回 HTTP 200 + 下面这段：

```json
{"data":{"captcha":"","desc_url":"",
 "description":"您正在尝试访问的网站存在安全风险，为保护您的抖音账号安全与隐私，已阻止此次访问。",
 "error_code":4031},"message":"error"}
```

试过且**仍然 4031** 的组合：

1. 带 `Referer` / `Origin`（creator 的、www 的、以及 manage 页 URL）；
2. `aid=2906` 与 `aid=6383` 各一遍，两两配 Referer；
3. 先注册 `ttwid`（`POST https://ttwid.bytedance.com/ttwid/union/register/` 返回 200 `union register success`，拿到 127 字符 `ttwid` cookie）；
4. 带 `s_v_web_id=verify_<32hex>`；
5. 带 `passport_csrf_token` cookie + `x-tt-passport-csrf-token` 头；
6. 完整浏览器指纹头：`sec-ch-ua`、`sec-ch-ua-platform`、`sec-fetch-site: same-origin`、`sec-fetch-mode: cors`、`sec-fetch-dest: empty`、`Accept-Language` 等；
7. 加 `service=` 参数；换 `www.douyin.com` 域名。

其它域名：`sso.douyin.com/passport/web/get_qrcode/` → 403 纯文本「路由已封禁」；`sso.douyin.com/get_qrcode/` → 200 的 React 登录页（9,938 字节，二维码由 JS 渲染，不是接口）。

**原因判断**：passport 对 `get_qrcode` 做客户端指纹/风控判定（TLS 指纹、`x-bogus` 类参数或 SDK 上报的 `verify` 结果），Python 裸 HTTP 打不通。要走纯 HTTP 就得逆 secsdk 的 `web_protect` 签名——不稳定且随时失效，**不建议做**。

### 4.1 三条可行路径

| 方案 | 做法 | 代价 | 稳定性 |
|---|---|---|---|
| **A. Cookie 导入**（推荐先做） | 浏览器登录 `creator.douyin.com` → F12 → Network 任一请求复制 `Cookie` 头 → 脚本 `login --cookie` 存进 `config/douyin_<account>.txt` | 一次手工粘贴；cookie 通常数周到数月有效 | 高：采集与登录解耦，cookie 过期重贴即可 |
| **B. 浏览器自动化扫码** | 脚本用本机 Chrome/Edge 以 `--remote-debugging-port` 起临时 profile → 打开登录页 → 用户扫码 → 通过 CDP 取 cookie | 要写 WebSocket 客户端（stdlib 无）；页面会检测 `webdriver`（改启动参数可绕过） | 中：扫一次能自动续，但依赖本机浏览器与 CDP 稳定性 |
| **C. 逆 secsdk 签名** | 复刻 `web_protect` signVersion 2 | 工程量最大、随版本失效 | 低，不建议 |

对照 B站：那边 `get_qrcode` 是裸 HTTP 就能拿的，所以 `bili_sync.py` 的 `login` 能真扫码；抖音这一步被风控挡住，**同样的 UX 做不到**，只能退到 A 或 B。

---

## 5. 字段 → 台账映射（提案，待真实 cookie 复核）

台账现有口径（`lib/bilibili.js` 已定型，抖音照抄形状即可）：

```js
post   = { platform, platform_id, title, url, published_at, kind, tags, extras }
metric = { post_id, captured_at, play, like, comment, share, collect }
```

| 台账字段 | 抖音来源（预期键名，**待实测**） | 备注 |
|---|---|---|
| `platform` | 常量 `douyin` | |
| `platform_id` | `items[].aweme_id` | 纯数字 ID，比 B站 bvid 更简单 |
| `title` | `items[].desc` | 抖音没有独立标题，取文案首行；空文案落「(无文案)」 |
| `url` | `https://www.douyin.com/video/<aweme_id>` | 由 ID 拼，不用接口回 |
| `published_at` | `items[].create_time`（秒） | 复用 `tsToLocal` 的秒→本地时间 |
| `kind` | 常量 `视频` | 图文作品以后再说 |
| `tags` | `items[].text_extra[].hashtag_name` | 待实测 |
| `play` | `metrics.play_count` | 可能只有「播放中」/滞后口径，见 §6 |
| `like` | `metrics.digg_count` | |
| `comment` | `metrics.comment_count` | |
| `share` | `metrics.share_count` | |
| `collect` | `metrics.collect_count` | 抖音有「收藏」，字段名待实测 |

`item/mget` 的 `play_info` / `review` 原样塞进 `extras`（和 B站 `extras.settled` / `extras.diagnose` 一个思路：旁证入库，不参与口径计算）。

---

## 6. 采集脚本设计（`scripts/douyin_sync.py`，未开工）

| 项 | 约定（对齐 `bili_sync.py`） |
|---|---|
| 依赖 | 只用标准库；二维码渲染这类可选依赖懒加载 |
| 凭据 | `<工作区根>/config/douyin_cookie_<account>.txt`（只存 cookie 串，权限最小） |
| 输出 | `<工作区根>/tmp/douyin-import.json` |
| `login` | 方案 A：`--cookie "..."` 或 `--cookie-file`，落盘前用 `work_list` 打一次验证 `status_code != 8` |
| `fetch` | `work_list` 翻页（`count` 页大小、`max_cursor` 游标、`has_more` 停），逐条可选 `item/mget` 补 `metrics/play_info` |
| 节流 | ≥0.35s / 请求，与 B站一致；`status_code` 非 0 不重试，传输错误重试 2 次 |
| 退出码 | 0 成功 / 1 一般错误 / 2 凭据失效（`status_code: 8`）/ 3 风控 / 4 二维码失效（预留，方案 B 用） |
| 请求量 | 500 条作品 ≈ 42 页（count=12）或 10 页（count=50，上限待实测） |

### 6.1 已知坑（实施时验证）

1. **`status_code: 8` 不抛 HTTP 错误**——必须解析 body，别只看 HTTP 200。
2. **双层封套**：`item/mget` 有外层 `status_code` 和内层 `BaseResp.StatusCode`。
3. **`aid` 双轨**：prefetch 用 `1128 + device_platform=android`，创作者中心 web 全局是 `2906 + web`；两条路未登录都通，登录后哪条返回完整数据要实测（可能只有一条给全量）。
4. **数据延迟**：抖音播放数有 T+ 延迟与「播放中」状态，快照 `captured_at` 必须记「抓取时间」而不是接口的 `now`。
5. **`count` 上限未知**：prefetch 给 12，实际可能支持 50/100，不确认就按 12 走，别猜大值打限频。
6. **反自动化检测**：`562.*.js` 检测 `__playwright__`/`__webdriver`/`__selenium`/`__cdc_`/`window.chrome.csi` 等——方案 B 起浏览器要加 `--disable-blink-features=AutomationControlled`。

---

## 7. 待办 / 待实测清单

- [ ] 真实 cookie 下 `work_list` 的 `items[]` 真实键名与 `count` 上限
- [ ] `item/mget` 的 `metrics` / `play_info` / `review` 三组真实结构
- [ ] 登录态下 `aid=1128` vs `2906` 哪条更像正路
- [ ] `status` 枚举值（全部/已发布/审核中/草稿）
- [ ] 图文作品（`images` 类）在 `work_list` 里长什么样
- [ ] cookie 有效期与失效表现（是否仍是 `status_code: 8`）
