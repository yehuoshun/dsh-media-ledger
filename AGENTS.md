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
| 抓数据（爬平台后台 / 开放平台） | 插件必须不联网，见 §5 |
| 多账号矩阵、团队协作、权限 | 用户自述「我最多两账号，都是个人号」 |
| 独立 Web 应用 / 仓库内 CLI | 用户已明确否掉这两种形态，选了 DSH 插件 |

**面板 / GUI 目前不存在。** 要做先问用户，别自己开工——这是本项目已经被纠正过两次的地方（用户原话：「回滚，你都没问我」「我问你的是dsh插件，你在做什么？」）。

---

## 2. 目录与文件职责

| 路径 | 职责 |
|---|---|
| `index.js` | 插件入口：`name = 'media-ledger'`、`inject = ['tools']`，在 `ctx.effect` 里调 `lib/tool.js` 的 `registerTools(ctx, config)` 并在回收函数里逐个 `dispose()` |
| `lib/config.js` | 平台归一、封面默认值、标题字数上限、`DEFAULT_*` 常量 |
| `lib/store.js` | `resolveDataDir`（`config.dataDir` → 环境变量 → 工作区 `data/media-ledger` → `~/media-ledger`）/ `findWorkspaceRoot` / JSONL 读写 / `nextPostId` / `loadLedger`（重复 id 直接抛错） |
| `lib/metrics.js` | 时间解析、快照取最新、中位数、`buildRows`、互动率、`buildReport` |
| `lib/pack.js` | 发布包：标题字数、标签归一截断、封面比例校验 |
| `lib/tool.js` | 工具定义：参数 schema、action 分发、错误收敛成 `{ ok:false, error }` |
| `lib/util.js` | `parseCount`（`2.4w` / `1.2万`）、`toLossless` |
| `locale/{zh,en}.json` | 插件元数据（`meta.description` / `meta.detail` 等） |
| `docs/DETAIL.md`、`docs/DETAIL.zh.md` | 插件详情页正文，**各自恰好一行图片**（见 §4） |
| `docs/preview.svg` | 详情页那张图，纯图形、无 `text` 元素 |
| `docs/DESIGN.md` | 设计取舍笔记（不是详情页，别把两者搞混） |
| `test/smoke.mjs` | 纯函数 + 包结构冒烟（不装插件就能跑） |
| `test/activate.mjs` | 假 `ctx` 跑 `apply`，验注册 / 执行 / 渲染 / 错误路径 / 回收 |

---

## 3. 怎么跑起来（本机没有 Node）

借用宿主 Electron 当 Node，**不要**去装 Node 或改 PATH：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\smoke.mjs"
& "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\activate.mjs"
```

- 期望：`smoke.mjs` → **全过 46/46**；`activate.mjs` → 注册名 `media-ledger`、`inject=["tools"]`、工具名 `media`、25 个参数键、卸载后工具回收。
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
4. **台账不落仓库**：`resolveDataDir(config)` 的优先级是 `config.dataDir` → `DSH_MEDIA_LEDGER_DIR` → `<工作区根>/data/media-ledger` → `~/media-ledger`。工作区根由 `findWorkspaceRoot()` 向上找「同层既有 `AGENTS.md` 又有 `code/` 或 `work/`」的目录，找不到才退回用户目录——这两种位置都在仓库外；只认这两个标记，插件仓库自己不会被当成工作区根。任何人把 `dataDir` 指进仓库，`.gitignore` 必须仍能挡住。
5. **真实数据一律不入库**：真实账号名、播放/涨粉原始导出、cookie、token、手机号、本机绝对路径（带盘符的那种）、本机私有项目名都不许提交。测试数据必须一眼可辨是假数据（命名含 `mock`/`fake`/`demo`/`example`，或注释写明）。
6. 用户自己的台账数据是**用户的**：不要为了「修 bug」去移动、截断、重写它；写盘只能追加（JSONL append-only，坏行报行号，不静默丢弃）。

---

## 6. 代码约定

- `lib/` 只放**纯函数**：不做 IO、不读环境、不联网，方便在 `smoke.mjs` 里直接测。IO 只在 `store.js` 与 `tool.js` 里。
- 工具错误统一 `return { ok: false, error: '…' }`，**不要 throw**（throw 会让整个工具调用失败，用户看不到可读原因）。
- 工具参数 `additionalProperties: false`、`required: ['action']`、action 用枚举。新增 action 要一次改齐四处：`lib/tool.js` 的枚举与分发、参数键、`locale/{zh,en}.json` 的描述、`test/smoke.mjs` 或 `test/activate.mjs` 的断言。
- 数字口径不要随手改，改了必须在提交信息里写清为什么，并同步改断言：互动率**分子分母取同一批行**且只算 `play > 0`；快照取 `captured_at` 真正最新的那条（不是文件里最后一行）；T+ 龄期现算而不是信上报值。
- 中文注释、中文文档、中文提交信息。变量名英文。

---

## 7. 提交与推送

沿用工作区根 `AGENTS.md`，此处只重复最容易犯的：

- 提交信息：`范围: 改了什么(为什么)`，范围用 `check`/`scripts`/`docs`/`chore`。**必须写清为什么**（回溯时 `git log --oneline` 是唯一线索）。
- **一改动一 push**：一个 commit 只说一件事，立刻 `git push origin main`。
- **判 push 成功别看 exit code**：PowerShell 5.1 会把 `git push` 的进度行当 NativeCommandError 返回 1。以 `git status -sb` 显示 `## main...origin/main`（**无 `ahead`**）或 `git log --oneline -1 origin/main` 等于本地 HEAD 为准。push 失败要当场报原文并停下。
- **禁止**：`git reset --hard`、`git checkout -- .`、`git clean -fd`、`git push --force`。需要回退只做 `git revert`。
- **每次 commit 前做隐私扫描**（见 §5.5）：对已暂存内容扫关键词（`token`/`cookie`/`secret`/`password`/`Bearer`/手机号/身份证/本机绝对路径前缀/本机私有项目名/本机号主标识），命中即停，处理完重扫。
- 动仓库前先 `git status` + `git log --oneline -3`；工作区里有**不是你改的**文件，先问，别 `git add -A` 一键全加。

---

## 8. 临时文件

- 本项目的一次性脚本、探针、导出物写本仓库 `tmp/`（已被 `.gitignore` 覆盖），不要用 `%TEMP%`。
- 任务收尾删干净自己这轮产生的临时文件，并在答复里说明；`tmp/` 里别人的东西不动。
- 删任何**非本轮 tmp 自建**的文件前必须先问用户（删哪些、为什么、能否恢复）。

---

## 9. 已知遗留

- 仓库已公开，但早期提交历史里仍有本机工作区绝对路径与本机私有项目名——**无凭据**，属于「要不要清历史」的待决项。彻底清除需要改写历史 + 强制推送，属于禁止清单操作，**必须等用户明确同意**再动；不要自己 `filter-repo`。新增内容一律用占位路径。
