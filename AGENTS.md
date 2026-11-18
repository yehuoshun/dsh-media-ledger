# AGENTS.md — dsh-media-ledger 工作约束

本文件是本仓库的**约束基线**，每轮请求前会被 DSH 注入。它约束「在这个仓库里干活」的方式，不约束功能本身。
与工作区根 `AGENTS.md` 冲突时，取更严格的那条。

---

## 1. 这个仓库是什么，边界在哪

DSH 插件：把四个平台（抖音 / 小红书 / B站 / 视频号）的作品台账、数据快照、复盘、发布包检查做成一个 Host 工具 `media`。

**只做这三件事**：作品台账（`add_post` / `add_metrics` / `list`）、数据复盘（`report`）、发布包检查（`pack`）。

**不做的事（做过决定，别翻案）**：

| 不做 | 原因 |
|---|---|
| 上传 / 代发布自动化 | 四平台对个人号的发布接口基本关着（B站要企业资质、小红书只开 `basic_info`、抖音代投稿 2024-07 起收回） |
| 抓数据（插件内部） | 插件必须不联网，见 §5。采集放在**独立 Python 脚本**里（B站 `scripts/bili_sync.py`、抖音 `scripts/douyin_sync.py`、小红书 `scripts/xhs_sync.py`；另一进程、可单独跑），产出 JSON 后由工具的 `import_bili` / `import_douyin` / `import_xhs` 纯离线灌入；插件运行时仍然一个请求都不发 |
| 多账号矩阵、团队协作、权限 | 用户自述「我最多两账号，都是个人号」 |
| 独立 Web 应用 / 仓库内 CLI | 用户已明确否掉这两种形态，选了 DSH 插件 |

**面板已经存在**（2026-11-18，用户点名要左侧栏入口 + 开关；同日又按用户要求改成「左导航 + 右内容」）：左侧栏图标「自媒体台账」→ 主区左栏切视图（台账 / 复盘）与筛选（平台 → 账号两级树），右栏只看当前切片；页内一个「在左侧栏显示」开关。视图与筛选都是浏览器里的 `useState`，**不改地址、不新增路由**；每个切片的复盘由 Host 用同一套 `buildReport` 算好，前端不自己算指标。**不要自己扩成独立页面体系**：不加路由、不加第二个面板、不做图表库；要加内容先问用户——这是本项目被纠正过两次的地方（用户原话：「回滚，你都没问我」「我问你的是dsh插件，你在做什么？」）。

**登录也收进了面板（0.5.2 的窄例外）**：平台未绑定时，空态里与右栏顶部提示条上各有一个「扫码登录」按钮——Host 起一次白名单 `spawn` 跑对应脚本的 `login` 子命令（B站 `scripts/bili_sync.py login`、抖音 `scripts/douyin_sync.py login`、小红书 `scripts/xhs_sync.py login`），浏览器窗口由用户自己扫码，凭据落到 `config/<平台>_<账号>.json`（0.5.9 起只认这个扩展名，0.5.8 及以前叫 `.txt` 的同内容文件不再识别；**账号可选**：默认 `main`，登录前能在按钮旁填别的名字、也能一键切到已绑过的账号；名字必须与三个脚本一致，即 `^[A-Za-z0-9_-]{1,32}$`——脚本本身不收中文），轮询到成功后面板自己把标签翻成「已绑定」。一个平台可以绑多个账号，左栏「平台 → 账号」两级树里连「已绑但台账还没数据」的账号也会出现（点进去是空态，不会串到别的切片）。登录验证通过后，B站脚本还会在同一个 `config/` 里写一份 `<凭据>.identity.json`（只有 `platform`/`account`/`uname`/`mid`/`level`/`saved_at`，**没有任何 cookie**），面板只读它的昵称来把账号显示成「main（昵称）」——这份身份旁路是可选的展示数据，缺了、坏了都不影响绑定与采集（0.5.5）。视频号没有采集脚本，那个位置改成一句说明文字。

**采集与解绑也收进了面板（0.5.7，用户点名要的）**：每个已绑定账号一行两个按钮——「采集并导入」和「解绑」。采集仍然是**人点一下才跑**：Host 起同一个白名单脚本的 `fetch` 子命令（`--account <别名> --max 50 --out <工作区根>/tmp/panel-fetch-<平台>-<账号>.json`；小红书额外 `--name <别名>`，因为它的 `--name` 默认跟着 `--account` 走，改默认值会悄悄改掉台账里的账号名），跑完由 Host 读那份 JSON、调 `importCollectorOutput` 灌进台账，面板显示「已导入 N 条（新增 X / 更新 Y）」。退出码非 0 **一律不导入**：失败路径下脚本可能只写了半份 JSON，灌进 append-only 的台账就撤不回来。导入时 `account` **覆盖成凭据别名**（如 `main`），不是平台昵称——否则左栏两级树和绑定名对不上、同一个号会裂成两桶数据。登录与采集共用同一个任务槽：同一时刻只跑一个，再点回 `busy`，上限 30 分钟。解绑只删两个算出来的确切文件：`config/<平台>_<账号>.json` 与 `<凭据>.identity.json`，**台账一行不动**（解绑 = 这台机器不再持有凭据，不是删作品）。删文件前必须拿到宿主注入的 `workspaceRoot`，拿不到就回 `no-workspace` 拒绝执行——**绝不回落 `process.cwd()`**：2026-11-18 就是从这个回落里把真实凭据删掉的（真事故，记在 `docs/DESIGN.md`）。所以 §5 的例外现在是「登录 + 采集两个子命令、一个 `runCollectorTask`」，仍然**不是**通用命令执行器。

---

## 2. 目录与文件职责

| 路径 | 职责 |
|---|---|
| `index.js` | 插件入口：`name = 'media-ledger'`、`inject = ['tools']`，在 `ctx.effect` 里调 `lib/tool.js` 的 `registerTools(ctx, config)` 并在回收函数里逐个 `dispose()` |
| `lib/config.js` | 平台归一、封面默认值、标题字数上限、`DEFAULT_*` 常量 |
| `lib/store.js` | `resolveDataDir`（`config.dataDir` → 环境变量 → 工作区 `data/media-ledger` → `~/media-ledger`）/ `findWorkspaceRoot` / JSONL 读写 / `nextPostId` / `loadLedger`（重复 id 直接抛错） |
| `lib/metrics.js` | 时间解析、快照取最新、中位数、`buildRows`、互动率、`buildReport` |
| `lib/pack.js` | 发布包：标题字数、标签归一截断、封面比例校验 |
| `lib/bilibili.js` | B站采集产出的 JSON → 台账记录（纯函数映射：`normalizeImport` / `toPostRecord` / `toMetricRecord` / `matchPost`；不联网、不读盘，输入输出都是普通对象） |
| `lib/xiaohongshu.js` | 小红书导出产出的 JSON → 台账记录（同上四件纯函数；口径差在观看量≠曝光量、封面点击率 0~100、涨粉进 `fans`、合成 id 不拼假链接） |
| `lib/douyin.js` | 抖音采集产出的 JSON → 台账记录（同一套归一形状；差异全在**候选键回退链**与「粗值/缺值只记 warning 不写 0」） |
| `lib/tool.js` | 工具定义：参数 schema、action 分发、错误收敛成 `{ ok:false, error }` |
| `lib/panel.js` | 面板数据整形：`toPanelPost` / `buildFacets`（平台 → 账号两级树）/ `buildPanel`（每个切片一份 `buildReport`，**不另算一套指标**）/ `parseSlice` |
| `lib/bindings.js` | 面板绑定状态：凭据文件名 → 平台/账号、有无采集脚本、空态三步文案，以及身份旁路文件 → 昵称的映射（纯函数，只吃目录清单与身份对象，不读凭据内容） |
| `lib/bridge.js` | Host 侧面板桥：`GET /api/dsh-media-ledger/state`（面板数据，含顶层 `login` 字段）、`POST .../sidebar`（写开关）、`POST .../login`（按白名单起一次登录脚本）、`GET .../login/state`（登录进度）、`POST .../unbind`（删这个账号的两份文件，台账不动）、`POST .../fetch`（按白名单起一次采集并导入）、`GET .../fetch/state`（采集进度）；`sidebarEnabled` / `readPanel` / `saveSidebar`。**全仓库唯一允许 `spawn` 的文件** |
| `lib/client.js` | 浏览器侧 bundle：`window.__ModuleLoader__.load({ id: 'dsh-media-ledger', factory })`，注册 `sidebar.panellist`（图标「自媒体台账」）+ `main`（面板页）+ 命令 `media-ledger-sidebar` |
| `lib/util.js` | `parseCount`（`2.4w` / `1.2万`）、`toLossless` |
| `locale/{zh,en}.json` | 插件元数据（`meta.description` / `meta.detail` 等） |
| `docs/DETAIL.md`、`docs/DETAIL.zh.md` | 插件详情页正文，**各自恰好一行图片**（见 §4） |
| `docs/preview.svg` | 详情页那张图，纯图形、无 `text` 元素 |
| `docs/DESIGN.md` | 设计取舍笔记（不是详情页，别把两者搞混） |
| `test/smoke.mjs` | 纯函数 + 包结构冒烟（不装插件就能跑） |
| `test/activate.mjs` | 假 `ctx` 跑 `apply`，验注册 / 执行 / 渲染 / 错误路径 / 回收 |
| `scripts/bili_sync.py` | **仓库外跑**的 B站采集脚本（`login` 扫码 / `fetch` 抓数据出 JSON）：独立进程、只用标准库、不 import 插件代码；插件本体仍不联网（见 §5） |
| `scripts/xhs_sync.py` | **仓库外跑**的小红书采集脚本（`login` 扫码 / `fetch` 走页面「导出数据」拿 xlsx 再解析成 JSON）：独立进程、只用标准库；签名绑 query 逆不动，别再试纯 HTTP 翻页（见 `docs/XHS_API.md` §4.3） |
| `scripts/xhs_login.py` | 小红书扫码登录：借本机 Chrome/Edge 起临时 profile，等 `web_session` 落进 cookie 即写凭据 |
| `scripts/xhs_browser.py` | 最小 CDP 客户端（起浏览器、`Runtime.evaluate`、`Network.setCookies`、等 cookie、收下载）：只用标准库，按自己起的 PID 收尾 |
| `docs/XHS_API.md` | 小红书数据分析页接口实测笔记（含导出表的列与口径） |
| `scripts/douyin_sync.py` | **仓库外跑**的抖音采集脚本（`login` 走浏览器 CDP 扫码 / `fetch` / `whoami` / `selftest`）：同上，独立进程、只用标准库 |
| `scripts/README.md` | 采集脚本的用法、接口清单、退出码与口径说明 |

---

## 3. 怎么跑起来（本机有 Node，没有时借宿主 Electron）

本机装有 Node、`node` 在 PATH 里，直接 `node test/smoke.mjs` 即可；换到没装 Node 的机器时才借宿主 Electron 当 Node，**不要**为了跑测试去装 Node 或改 PATH：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\smoke.mjs"
& "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\activate.mjs"
```

- 期望：`smoke.mjs` → **全过**（断言条数运行即得，别在这里写死分母；覆盖面板整形与筛选树、桥路由、客户端 bundle 契约与「真跑一遍 bundle」、B站/抖音/小红书 JSON 映射，以及登录/采集例外的三组断言与解绑的四条硬断言：坏账号不留文件、只删算出来那两份、再删一次幂等、**没拿到工作区根就一个文件都不删**）；`activate.mjs` → 注册名 `media-ledger`、`inject=["tools"]`、工具名 `media`、28 个参数键、七条桥路由（`/api/dsh-media-ledger/state`、`/sidebar`、`/login`、`/login/state`、`/unbind`、`/fetch`、`/fetch/state`）、`import_xhs` 端到端、卸载后工具与桥路由都回收。
- **改任何 `lib/*.js` 后必须重跑这两条**，两条都过才算改完。新增行为必须同时加断言——本项目的规矩是「口头保证不算，能跑挂的断言才算」。
- PowerShell 下判成功别信 exit code（`git push`、Unicode 输出都可能骗人），见 §7。

---

## 4. 插件包契约（DSH 硬规则，全是踩过的坑）

这些是 DSH 侧校验器 `@deepseek-ai/dsh-plugin-detail` 的规则，违反的后果是插件页报错，不是警告。

1. **`meta.detail` 必须是路径，不是描述**：相对包根、用 `/` 分隔、以 `.md` 或 `.markdown` 结尾（`docs/DETAIL.zh.md` 合法；`"作品台账 + 数据复盘"` 直接判 `invalid`，页面显示「插件声明的详细介绍文件无效」）。
2. **指了就必须存在**：`meta.detail` 指向的文件缺失会报错，**不会**回落到 `README.md`。没有详情页就整个省掉 `meta.detail`，那时才读 README。
3. **详情文档只能是图片**：恰好一行 `![说明](图)`，图片类型限 `.png/.jpg/.jpeg/.gif/.webp/.avif/.svg`。
4. **详情页按版本缓存**（缓存键含安装版本）：改 `meta.*`、`docs/DETAIL*.md`、`preview.svg`、图标之后，**必须把 `package.json` 的 `version` 加一档**，否则页面读旧结果。
5. `locale/<lang>.json` 走语言链回落；`engines.dsh` 不低于 `0.2.0`（本机 DSH 是 0.2.2-rc.3）。
6. 不确定 DSH 侧规则时，**先读 DSH 自己的实现**再动手（`skill: dsh-doc`，或直接读 `app.asar` 内的 `@deepseek-ai/dsh-plugin-detail`），别凭印象写，也不要在仓库里复制一份「大概的规则」。

### 装 / 卸（不要手改 profile）

```
plugin_manager install_bundle(target="<本仓库目录>")
```

已装过再装会返回 `already-installed`。改版后要生效必须两步：

```
plugin_manager remove_bundle(target="dsh-media-ledger")
plugin_manager install_bundle(target="<本仓库目录>")
```

不要直接编辑 profile 的 `package.json`（`dsh.profile.bundles` 与 `link:` 依赖由安装器维护）。

---

## 5. 数据与隐私（铁律）

用户明确要求过「隐私数据不上传」。这条已经写成 `test/smoke.mjs` 里的隐私断言（不联网、默认不起进程、无第三方依赖……），别绕过去。

1. **不联网**：`index.js` 与 `lib/*.js` 里不得出现 `fetch(` / `WebSocket` / `XMLHttpRequest` / `node:http(s)` / `node:net` / `node:dns` / `node:tls` / `axios`。真要联网，先停下来问用户，并同步删掉那条断言。
2. **默认不起进程；例外只有登录与采集两个子命令**：`lib/bridge.js` 里允许用 `node:child_process` `spawn` 一次 `scripts/` 下的白名单脚本（`login` 子命令 2026-11-18 由用户批准；`fetch` 子命令同日经用户裁决「面板加一个『采集并导入』按钮、手动触发、不自动」批准），只此一处、只此两个子命令，`lib/` 其他文件与 `index.js` 仍然零 `child_process`，shell 一律不开；`smoke.mjs` 里有断言守着（bridge 之外零命中、`spawn` 只出现一次、无 `shell:true`）。采集与解绑**拿不到宿主注入的 `workspaceRoot` 就拒绝执行**（回 `no-workspace`），绝不回落 `process.cwd()`——2026-11-18 的一次真事故就是从这个回落里删掉了真实凭据。
3. **无第三方依赖**：`package.json` 不放 `dependencies`（宿主带什么就用什么）。
4. **台账不落仓库**：`resolveDataDir(config)` 的优先级是 `config.dataDir` → `DSH_MEDIA_LEDGER_DIR` → `<工作区根>/data/media-ledger` → `~/media-ledger`。工作区根优先取宿主注入的提示（`index.js` 把 `ctx.get('workspaceRegistry')` 包成惰性函数塞进 `config.workspaceRoot`，桌面版插件进程的 cwd 不在工作区，光靠 cwd 找不到），取不到才用 `findWorkspaceRoot()` 从 cwd 向上找「同层既有 `AGENTS.md` 又有 `code/` 或 `work/`」的目录，找不到才退回用户目录——这两种位置都在仓库外；只认这两个标记，插件仓库自己不会被当成工作区根。任何人把 `dataDir` 指进仓库，`.gitignore` 必须仍能挡住。
5. **真实数据一律不入库**：真实账号名、播放/涨粉原始导出、cookie、token、手机号、本机绝对路径（带盘符的那种）、本机私有项目名都不许提交。测试数据必须一眼可辨是假数据（命名含 `mock`/`fake`/`demo`/`example`，或注释写明）。
6. 用户自己的台账数据是**用户的**：不要为了「修 bug」去移动、截断、重写它；写盘只能追加（JSONL append-only，坏行报行号，不静默丢弃）。

---

## 6. 代码约定

- `lib/` 只放**纯函数**：不做 IO、不读环境、不联网，方便在 `smoke.mjs` 里直接测。例外只有三个，别扩大到别的文件：`store.js`（读写 JSONL）、`tool.js`（工具 IO 收敛）、`bridge.js`（Host 侧七条本机路由的读写 + 登录/采集那一次 `spawn` + 解绑的删文件）；`client.js` 是浏览器 bundle，跑在页面里，不参与 Node 侧纯函数规则。
- `lib/bridge.js` 的路由**只部署在宿主自己的 webServer 上**，不 import `node:http`、不向外发请求；面板要的数据只能从这七条路由出，不要为了少写一个字段去开第八条。`POST /sidebar` 的请求体只认 `{"value": true|false}`；`POST /login` 只认 `{"platform": "bilibili"|"douyin"|"xhs", "account": "<账号名>"}`（`account` 可省，省了按 `main`），`platform` 走白名单（视频号没有脚本，直接回 `no-collector`），`account` 走 `^[A-Za-z0-9_-]{1,32}$`（与三个 Python 脚本的正则完全相同，中文别名脚本自己就不收）；`GET /login/state` 不收任何参数。别把入参反射成路径、文件名或命令参数——`spawn` 的命令与参数写死在白名单里，`shell` 永不开。
- 工具错误统一 `return { ok: false, error: '…' }`，**不要 throw**（throw 会让整个工具调用失败，用户看不到可读原因）。
- 工具参数 `additionalProperties: false`、`required: ['action']`、action 用枚举。新增 action 要一次改齐四处：`lib/tool.js` 的枚举与分发、参数键、`locale/{zh,en}.json` 的描述、`test/smoke.mjs` 或 `test/activate.mjs` 的断言。
- 数字口径不要随手改，改了必须在提交信息里写清为什么，并同步改断言：互动率**分子分母取同一批行**且只算 `play > 0`；快照取 `captured_at` 真正最新的那条（不是文件里最后一行）；T+ 龄期现算而不是信上报值。
- 中文注释、中文文档、中文提交信息。变量名英文。

---

## 7. 提交与推送

沿用工作区根 `AGENTS.md`，本节写成自包含的完整版（这些是铁律，一条都别省）：

- **提交信息**：中文，格式 `范围: 改了什么(为什么)`，范围用 `check`/`scripts`/`docs`/`chore`。**必须写清为什么**（回溯时 `git log --oneline` 是唯一线索）。
- **一修改一 push（铁律）**：每完成一处改动就 `git commit` + `git push origin main`，立刻推到远端，不许攒着、不留「等攒多点再一起推」。本地历史一次 `reset` 就没了，远端是唯一能追溯的底。中途干了多件事要拆成多个 commit 分别推，**一个 commit 只说一件事**，这样回溯时能精确 revert 单个改动。
- **push 失败（网络 / 凭据 / 远端拒绝）必须当场报出原文错误**并停下，不许静默跳过、不许改成本地攒着；确认远端真推上去了再继续下一步。
- **怎么判断 push 成功**：PowerShell 5.1 会把 `git push` 的进度行（`To github.com:...`）当 NativeCommandError、即使成功也返回 exit 1，别被退出码骗了。以 `git status -sb` 显示 `## main...origin/main`（**无 `ahead`**）或 `git log --oneline -1 origin/main` 等于本地 HEAD 为准。
- **动仓库前先看状态**：`git status` + `git log --oneline -3` + `git remote -v`。2026-11-12 出现过另一个会话在同一仓库并行改文件（根 README 被整体重写并单独提交），`git add -A` 会把别人的改动一起卷进你的 commit——发现工作区有**不是你改的**东西，先问，别一键全加。
- **禁止**：`git reset --hard`、`git checkout -- .`、`git clean -fd`、`git push --force`。需要回退只做 `git revert`（留痕），或先问用户。
- **git 操作只在项目目录内做**，不跨仓库 `git add`。
- **每次 commit 前做隐私扫描**（见 §5.5）：对已暂存内容扫关键词（`token`/`cookie`/`secret`/`password`/`Bearer`/手机号/身份证/本机绝对路径前缀/本机私有项目名/本机号主标识），命中即停，处理完重扫。

---

## 8. 临时文件

- 本项目的一次性脚本、探针、导出物写本仓库 `tmp/`（已被 `.gitignore` 覆盖），不要用 `%TEMP%`。
- 任务收尾删干净自己这轮产生的临时文件，并在答复里说明；`tmp/` 里别人的东西不动。
- 删任何**非本轮 tmp 自建**的文件前必须先问用户（删哪些、为什么、能否恢复）。

---

## 9. 已知遗留

- 仓库已公开，但早期提交历史里仍有本机工作区绝对路径与本机私有项目名——**无凭据**，属于「要不要清历史」的待决项。彻底清除需要改写历史 + 强制推送，属于禁止清单操作，**必须等用户明确同意**再动；不要自己 `filter-repo`。新增内容一律用占位路径。
