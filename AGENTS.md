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
| 抓数据（插件内部） | 插件必须不联网，见 §5。B站采集放在**独立 Python 脚本** `scripts/bili_sync.py`（另一进程、可单独跑），产出 JSON 后由工具的 `import_bili` 纯离线灌入；插件运行时仍然一个请求都不发 |
| 多账号矩阵、团队协作、权限 | 用户自述「我最多两账号，都是个人号」 |
| 独立 Web 应用 / 仓库内 CLI | 用户已明确否掉这两种形态，选了 DSH 插件 |

**面板已经存在**（2026-11-18，用户点名要左侧栏入口 + 开关；同日又按用户要求改成「左导航 + 右内容」）：左侧栏图标「自媒体台账」→ 主区左栏切视图（台账 / 复盘）与筛选（平台 → 账号两级树），右栏只看当前切片；页内一个「在左侧栏显示」开关。视图与筛选都是浏览器里的 `useState`，**不改地址、不新增路由**；每个切片的复盘由 Host 用同一套 `buildReport` 算好，前端不自己算指标。**不要自己扩成独立页面体系**：不加路由、不加第二个面板、不做图表库；要加内容先问用户——这是本项目被纠正过两次的地方（用户原话：「回滚，你都没问我」「我问你的是dsh插件，你在做什么？」）。

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
| `lib/tool.js` | 工具定义：参数 schema、action 分发、错误收敛成 `{ ok:false, error }` |
| `lib/panel.js` | 面板数据整形：`toPanelPost` / `buildFacets`（平台 → 账号两级树）/ `buildPanel`（每个切片一份 `buildReport`，**不另算一套指标**）/ `parseSlice` |
| `lib/bridge.js` | Host 侧面板桥：`GET /api/dsh-media-ledger/state`（面板数据）、`POST .../sidebar`（写开关）；`sidebarEnabled` / `readPanel` / `saveSidebar` |
| `lib/client.js` | 浏览器侧 bundle：`window.__ModuleLoader__.load({ id: 'dsh-media-ledger', factory })`，注册 `sidebar.panellist`（图标「自媒体台账」）+ `main`（面板页）+ 命令 `media-ledger-sidebar` |
| `lib/util.js` | `parseCount`（`2.4w` / `1.2万`）、`toLossless` |
| `locale/{zh,en}.json` | 插件元数据（`meta.description` / `meta.detail` 等） |
| `docs/DETAIL.md`、`docs/DETAIL.zh.md` | 插件详情页正文，**各自恰好一行图片**（见 §4） |
| `docs/preview.svg` | 详情页那张图，纯图形、无 `text` 元素 |
| `docs/DESIGN.md` | 设计取舍笔记（不是详情页，别把两者搞混） |
| `test/smoke.mjs` | 纯函数 + 包结构冒烟（不装插件就能跑） |
| `test/activate.mjs` | 假 `ctx` 跑 `apply`，验注册 / 执行 / 渲染 / 错误路径 / 回收 |
| `scripts/bili_sync.py` | **仓库外跑**的 B站采集脚本（`login` 扫码 / `fetch` 抓数据出 JSON）：独立进程、只用标准库、不 import 插件代码；插件本体仍不联网（见 §5） |
| `scripts/README.md` | 采集脚本的用法、接口清单、退出码与口径说明 |

---

## 3. 怎么跑起来（本机没有 Node）

借用宿主 Electron 当 Node，**不要**去装 Node 或改 PATH：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\smoke.mjs"
& "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\activate.mjs"
```

- 期望：`smoke.mjs` → **全过 106/106**（含面板整形与筛选树、桥路由、客户端 bundle 契约与「真跑一遍 bundle」、B站 JSON 映射）；`activate.mjs` → 注册名 `media-ledger`、`inject=["tools"]`、工具名 `media`、28 个参数键、桥路由 `/api/dsh-media-ledger/state` 与 `/api/dsh-media-ledger/sidebar`、卸载后工具与桥路由都回收。
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

用户明确要求过「隐私数据不上传」。这条已经写成 `test/smoke.mjs` 里的 5 条断言，别绕过去。

1. **不联网**：`index.js` 与 `lib/*.js` 里不得出现 `fetch(` / `WebSocket` / `XMLHttpRequest` / `node:http(s)` / `node:net` / `node:dns` / `node:tls` / `axios`。真要联网，先停下来问用户，并同步删掉那条断言。
2. **不起进程**：不得 `node:child_process`。
3. **无第三方依赖**：`package.json` 不放 `dependencies`（宿主带什么就用什么）。
4. **台账不落仓库**：`resolveDataDir(config)` 的优先级是 `config.dataDir` → `DSH_MEDIA_LEDGER_DIR` → `<工作区根>/data/media-ledger` → `~/media-ledger`。工作区根优先取宿主注入的提示（`index.js` 把 `ctx.get('workspaceRegistry')` 包成惰性函数塞进 `config.workspaceRoot`，桌面版插件进程的 cwd 不在工作区，光靠 cwd 找不到），取不到才用 `findWorkspaceRoot()` 从 cwd 向上找「同层既有 `AGENTS.md` 又有 `code/` 或 `work/`」的目录，找不到才退回用户目录——这两种位置都在仓库外；只认这两个标记，插件仓库自己不会被当成工作区根。任何人把 `dataDir` 指进仓库，`.gitignore` 必须仍能挡住。
5. **真实数据一律不入库**：真实账号名、播放/涨粉原始导出、cookie、token、手机号、本机绝对路径（带盘符的那种）、本机私有项目名都不许提交。测试数据必须一眼可辨是假数据（命名含 `mock`/`fake`/`demo`/`example`，或注释写明）。
6. 用户自己的台账数据是**用户的**：不要为了「修 bug」去移动、截断、重写它；写盘只能追加（JSONL append-only，坏行报行号，不静默丢弃）。

---

## 6. 代码约定

- `lib/` 只放**纯函数**：不做 IO、不读环境、不联网，方便在 `smoke.mjs` 里直接测。例外只有三个，别扩大到别的文件：`store.js`（读写 JSONL）、`tool.js`（工具 IO 收敛）、`bridge.js`（Host 侧那两条本机路由的读写）；`client.js` 是浏览器 bundle，跑在页面里，不参与 Node 侧纯函数规则。
- `lib/bridge.js` 的路由**只部署在宿主自己的 webServer 上**，不 import `node:http`、不向外发请求；面板要的数据只能从这两条路由出，不要为了少写一个字段去开第三条。`POST /sidebar` 的请求体只认 `{"value": true|false}`，别把入参反射成路径或文件名。
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
