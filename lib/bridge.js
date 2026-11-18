/**
 * Host 侧的面板桥：左侧栏面板是浏览器里的 React 组件，它读不到 Host 的 `config`
 * 也读不到磁盘，所以这里开几条**只在本机回环上**的 HTTP 路由给它：
 *
 *   GET  /api/dsh-media-ledger/state        → 面板数据（复盘 + 作品列表）+ 侧栏开关 + 登录/抓取进度
 *   POST /api/dsh-media-ledger/sidebar      → 改「是否在左侧栏显示」，写回插件配置
 *   POST /api/dsh-media-ledger/login        → 起一次「扫码登录」（白名单脚本）
 *   GET  /api/dsh-media-ledger/login/state  → 这次登录跑到哪一步了（面板每 2 秒问一次）
 *   POST /api/dsh-media-ledger/unbind       → 解绑账号（只删 config/ 里那两个凭据文件，台账不动）
 *   POST /api/dsh-media-ledger/fetch        → 起一次「采集并导入」（白名单脚本推数据出 JSON，跑完自动灌台账）
 *   GET  /api/dsh-media-ledger/fetch/state  → 这次采集跑到哪一步了
 *
 * 为什么不像 `dsh-free-search` 那样一上来就自带一套设置页：这里只有一个布尔开关，
 * 一条 POST 就够了，没必要再造表单框架。
 *
 * 安全边界：只读写本机台账目录、工作区的 `config/` 与白名单脚本；`/sidebar` 只认
 * `{ value: boolean }`，`/login` / `/unbind` / `/fetch` 只认 `{ platform, account }` 且账号先过正则，
 * 四条都不把入参反射成路径、文件名或命令参数——`/unbind` 删的文件名由 `lib/bindings.js` 算，
 * 算出来还要校一次 `dirname` 是不是 `config/`（绝不删 `data/`，也绝不出 config）。
 *
 * 子进程例外：本插件的铁律是「不起进程、不联网」（见仓库 AGENTS.md §5）。2026-11-18 用户
 * 批准了一条**窄例外**——只为扫码登录起 `scripts/` 下白名单里的那三个脚本；同一轮又批准了
 * 第二个用途：「面板上手动点一下采集」（`/fetch`，还是那三个脚本的 `fetch` 子命令）。
 * 所以 `node:child_process` 在整个仓库只出现在这个文件，且只被下面的 `runCollectorTask` 用
 * **一次**；命令与参数由 `lib/login.js` / `lib/fetch.js` 的纯函数拼好（不经过 shell），
 * 这里只负责起、等、超时杀、收口。
 *
 * 采集本身仍然不联网：联网的是脚本那个独立进程，插件本体一个请求都不发。
 * @module dsh-media-ledger/bridge
 */

import fs from 'node:fs';
import path from 'node:path';
// 全仓库唯一一处子进程：只为「扫码登录」与「手动采集」起白名单脚本（2026-11-18 用户批准的窄例外）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configuredWorkspaceRoot, loadLedger, resolveDataDir, resolveWorkspaceRoot } from './store.js';
import { buildRows } from './metrics.js';
import { buildPanel } from './panel.js';
import { buildUnbindPlan, describeBindings, parseCredentialName } from './bindings.js';
import { LOGIN_LOG_LIMIT, LOGIN_TIMEOUT_MS, buildLoginPlan, describeLoginState, loginSpawnEnv } from './login.js';
import { FETCH_LOG_LIMIT, FETCH_TIMEOUT_MS, buildFetchPlan, countsOf, describeFetchState } from './fetch.js';
// 灌库走工具已有的那份实现（AGENTS.md §6：台账写入只此一处，不在这里重写一遍）
import { importCollectorOutput } from './tool.js';

export const BRIDGE_PREFIX = '/api/dsh-media-ledger';

/** 配置里没写 `sidebar` 就当地开——面板是这版新加的，老配置不该被无声关掉。 */
export function sidebarEnabled(config) {
  return !(config && config.sidebar === false);
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
  }
  res.end(text);
}

/** 读请求体，上限 64KB；解析不出来返回 undefined（不让坏 JSON 变成 500）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 64 * 1024) finish(undefined);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        finish(text.trim() ? JSON.parse(text) : {});
      } catch {
        finish(undefined);
      }
    });
    req.on('error', () => finish(undefined));
  });
}

/**
 * 列出工作区 `config/` 里的凭据文件：**只取名字与修改时间，不读内容**。
 *
 * 面板靠这两样东西说「这个平台绑没绑、什么时候绑的」，凭据本身永远不出这个函数。
 * 目录不存在＝一个都没绑（正常状态），不是错误。
 */
export function listCredentialFiles(config) {
  const root = resolveWorkspaceRoot(config);
  if (!root) return { dir: '', entries: [] };
  const dir = path.join(root, 'config');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { dir, entries: [] };
  }
  const entries = [];
  for (const name of names) {
    // 认不认一条凭据只看 parseCredentialName：扩展名必须是 .json（0.5.8 及以前的 .txt 不再算），
    // 身份旁路 `*.identity.json` 也会被它挡掉（剥出来的账号里带个点，过不了正则）
    if (!parseCredentialName(name)) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      entries.push({ name, mtimeMs: stat.mtimeMs });
    } catch {
      // 单个文件读不到只影响一行状态，不该让整个面板跟着 500
    }
  }
  return { dir, entries };
}

/**
 * 读 `config/` 里的**身份旁路文件**（`<凭据>.identity.json`）：只有 uname/mid/saved_at。
 *
 * 与凭据文件分开读，是为了让 §5 那条「凭据内容不出 Host」仍然成立：这里读的这份东西
 * 是登录脚本专门为面板写的，**一个 cookie 都没有**。坏 JSON、缺字段、读不到——一律跳过，
 * 面板顶多少显示一个昵称，不该整页 500。
 */
export function listIdentityFiles(config) {
  const root = resolveWorkspaceRoot(config);
  if (!root) return [];
  const dir = path.join(root, 'config');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!String(name).toLowerCase().endsWith('.identity.json')) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const uname = typeof data.uname === 'string' ? data.uname.trim() : '';
      const mid = typeof data.mid === 'number' || typeof data.mid === 'string' ? String(data.mid).trim() : '';
      if (!uname && !mid) continue;
      out.push({ name, uname, mid });
    } catch {
      // 坏文件只影响一行文案
    }
  }
  return out;
}

/**
 * 绑定状态 → `buildPanel` 要的 `boundAccounts`：`{ douyin: ['main','xiao-2'], xhs: [] }`。
 *
 * 账号名直接取 `describeBindings()` 已经算好的那份，**不再扫一遍 config 目录**：
 * 面板上写「已绑定 main、xiao-2」的那几个名字，和左栏点得进去的账号必须是同一份数据，
 * 两处各扫一次，改天凭据文件名换了规则就会各说各的。
 */
export function boundAccountsOf(bindings) {
  const list = bindings && Array.isArray(bindings.platforms) ? bindings.platforms : [];
  const out = {};
  for (const item of list) {
    const key = item && typeof item.key === 'string' ? item.key : '';
    if (!key) continue;
    const credentials = Array.isArray(item.credentials) ? item.credentials : [];
    const names = [];
    for (const credential of credentials) {
      const account = credential && typeof credential.account === 'string' ? credential.account.trim() : '';
      if (account && !names.includes(account)) names.push(account);
    }
    out[key] = names;
  }
  return out;
}

/** 读台账并整形；台账坏掉时把原因带回去，面板照样能显示（而不是整页炸掉）。 */
export function readPanel(config, options = {}) {
  const dir = resolveDataDir(config);
  const ledger = loadLedger(dir);
  const rows = buildRows(ledger.posts, ledger.metrics);
  // 先算绑定状态：它的账号名既是「已绑定」文案，也是「有凭据但还没采到数据」的空切片来源
  const credentials = listCredentialFiles(config);
  const bindings = describeBindings(credentials.entries, listIdentityFiles(config));
  const panel = buildPanel(rows, {
    groupBy: options.groupBy || 'platform',
    // 绑过凭据但台账里还没有作品的账号也要有切片，否则左栏点进去会落到「全部」的数字上
    boundAccounts: boundAccountsOf(bindings),
  });
  return {
    ok: true,
    sidebar: sidebarEnabled(config),
    dataDir: dir,
    // 四平台恒在：没绑的平台也要能点进去，看到「下一步敲什么」
    bindings: { configDir: credentials.dir, ...bindings },
    platforms: panel.platforms,
    errors: ledger.errors,
    posts: panel.posts,
    postsTotal: panel.postsTotal,
    truncated: panel.truncated,
    report: panel.report,
    // 左导航每选中一个切片就换一份复盘，前端只按 id 取，不自己算
    reports: panel.reports,
    facets: panel.facets,
  };
}

/**
 * 把开关写回插件配置（`cordis.patch.yml` 那一行的 `config`）。
 * 用 DSH 的 configEditor 而不是自己改写文件：它会保留别人的行、串行化写入、拒绝被上层覆盖的值。
 * @returns {Promise<{ok: boolean, sidebar?: boolean, code?: string, error?: string}>}
 */
export async function saveSidebar(ctx, value) {
  const entry = ctx && ctx.fiber ? ctx.fiber.entry : undefined;
  let editor;
  try {
    editor = ctx.get('configEditor');
  } catch {
    editor = undefined;
  }
  if (entry === undefined || editor === undefined || typeof editor.edit !== 'function') {
    return {
      ok: false,
      code: 'no-config-editor',
      error: '这个 profile 不能保存插件配置（找不到 configEditor）；开关只在本次运行里有效时请改 cordis.patch.yml',
    };
  }
  try {
    await editor.edit(entry, (current) => ({ ...(current || {}), sidebar: value }));
    return { ok: true, sidebar: value };
  } catch (error) {
    return { ok: false, code: 'settings-rejected', error: String((error && error.message) || error) };
  }
}

function parseValue(body) {
  if (body && typeof body.value === 'boolean') return body.value;
  if (body && (body.value === 'true' || body.value === 'false')) return body.value === 'true';
  return undefined;
}

// ── 后台脚本任务：登录与采集共用一套 ───────────────────────────────────
//
// 铁律是「不起进程、不联网」（AGENTS.md §5）。2026-11-18 用户批准了一条窄例外：只为
// 「面板里扫码登录」起白名单脚本；同一轮又批准了第二个用途「面板上手动点一下采集」。
// 两个用途共用下面**同一个**起进程函数（全仓库唯一一次 spawn）——命令与参数由
// `lib/login.js` / `lib/fetch.js` 的纯函数拼好，这里只负责起、等、超时杀、收口。
//
// 为什么合并成一份：两个用途的「起不来怎么办、日志怎么截、超时怎么杀、终态怎么写」
// 必须一模一样，否则面板上会同时存在两套脾气不同的进度条。

/** 脚本以仓库根为 cwd 跑：脚本自己会向上找工作区，这里只是给个稳定原点。 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 原始日志比面板契约多留一倍：先收全、再滤凭据行、最后才截到 2000 字符。 */
const TASK_LOG_RAW_LIMIT = Math.max(LOGIN_LOG_LIMIT, FETCH_LOG_LIMIT) * 2;

function blankLoginState() {
  return {
    phase: 'idle',
    platform: '',
    account: '',
    startedAt: null,
    finishedAt: null,
    message: '',
    exitCode: null,
    log: '',
    qrPath: null,
  };
}

function blankFetchState() {
  return {
    phase: 'idle',
    platform: '',
    account: '',
    startedAt: null,
    finishedAt: null,
    message: '',
    exitCode: null,
    log: '',
    counts: null,
  };
}

/**
 * 两条任务的进度。**只在内存里**：它描述的是「这个宿主进程正在跑的那个脚本」。
 * 宿主重启后凭据文件还在（面板照样说「已绑定」），而上次跑到第几步已经没有意义。
 */
let loginState = blankLoginState();
let fetchState = blankFetchState();
/** 在跑的子进程；null = 当前没有任务（有它在才算 busy，登录与采集共用这一个槽）。 */
let taskChild = null;
/** 'login' | 'fetch'；空串 = 空闲。 */
let taskKind = '';
/** 超时闹钟。 */
let taskTimer = null;
/** 区分「脚本自己失败」与「我们掐掉的」——两者都要说清楚。 */
let taskTimedOut = false;

function readTaskState(kind) {
  return kind === 'fetch' ? fetchState : loginState;
}

function writeTaskState(kind, next) {
  if (kind === 'fetch') fetchState = next;
  else loginState = next;
}

/** python 解释器：默认就用命令名，用户可以用环境变量钉死一个绝对路径。 */
function pythonCommand() {
  const configured = process.env.DSH_MEDIA_LEDGER_PYTHON;
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value || 'python';
}

/** 面板读的快照。「running 放太久该算超时」这类判断也在纯函数里，这里只递时钟。 */
export function loginSnapshot(now = Date.now()) {
  return describeLoginState(loginState, now);
}

/** 采集进度的快照（与登录同一套口径：阶段、日志尾巴、超时兜底都在纯函数里）。 */
export function fetchSnapshot(now = Date.now()) {
  return describeFetchState(fetchState, now);
}

function appendTaskLog(kind, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  const state = readTaskState(kind);
  writeTaskState(kind, { ...state, log: (state.log + text).slice(-TASK_LOG_RAW_LIMIT) });
}

/** 收口：成功、失败、超时都从这里进终态，顺手清掉 child 与闹钟（不留僵尸）。 */
function settleTask(kind, patch) {
  if (taskTimer) {
    clearTimeout(taskTimer);
    taskTimer = null;
  }
  taskChild = null;
  taskKind = '';
  const next = { ...readTaskState(kind), finishedAt: Date.now(), ...patch };
  writeTaskState(kind, next.phase === 'running' ? { ...next, phase: 'done' } : next);
}

/** 已经有一个任务在跑时的统一回答：两个任务共用一个槽，用户得知道是谁占着。 */
function busyResult() {
  const label = taskKind === 'fetch' ? '采集' : '登录';
  const state = readTaskState(taskKind);
  return {
    ok: false,
    code: 'busy',
    error: `已经有一个${label}任务在跑了（${state.platform || '未知平台'}），等它结束再点一次`,
  };
}

/**
 * 起一个白名单脚本、跟到终态。**全仓库唯一一处起子进程**（AGENTS.md §5 的窄例外）。
 *
 * @param {{kind: 'login'|'fetch', plan: {script: string, args: string[], platform: string, account: string},
 *   timeoutMs: number, timeoutMessage: string, onExit?: (exitCode: number|null) => object}} spec
 * @returns {Promise<{ok: true} | {ok: false, code: string, error: string}>}
 */
async function runCollectorTask(spec) {
  const { kind, plan, timeoutMs } = spec;
  const scriptPath = path.join(PKG_ROOT, plan.script);
  let present = false;
  try {
    present = fs.existsSync(scriptPath);
  } catch {
    present = false;
  }
  if (!present) {
    return {
      ok: false,
      code: 'no-script',
      error: '找不到脚本：' + plan.script + '（插件装不完整，或 scripts/ 被删了）',
    };
  }

  const python = pythonCommand();
  taskTimedOut = false;
  taskKind = kind;
  writeTaskState(kind, {
    ...(kind === 'fetch' ? blankFetchState() : blankLoginState()),
    phase: 'running',
    platform: plan.platform,
    account: plan.account,
    startedAt: Date.now(),
  });

  let child;
  try {
    child = spawn(python, [scriptPath, ...plan.args], {
      cwd: PKG_ROOT,
      // 不经过 shell：账号已经过正则，但「拼接」这条路一次都不开
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上别闪黑框；浏览器窗口是脚本自己开的
      windowsHide: true,
      // 强制 Python 用 UTF-8：不设的话中文机走 cp936，面板日志整片乱码
      env: loginSpawnEnv(process.env),
    });
  } catch (error) {
    const reason = '起不了脚本：' + String((error && error.message) || error);
    settleTask(kind, { phase: 'failed', message: reason });
    return { ok: false, code: 'spawn-failed', error: reason };
  }

  taskChild = child;
  // 能不能起来看这两个事件：成功发 'spawn'，失败发 'error'（ENOENT = 没装 python）
  const failure = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('spawn', () => settle(null));
    child.once('error', (error) => settle(error));
  });
  if (failure) {
    const code = failure && failure.code === 'ENOENT' ? 'no-python' : 'spawn-failed';
    const reason = code === 'no-python'
      ? '找不到 python（' + python + '）：装一个 Python 3，或把 DSH_MEDIA_LEDGER_PYTHON 指向解释器'
      : '起不了脚本：' + String((failure && failure.message) || failure);
    settleTask(kind, { phase: 'failed', message: reason });
    return { ok: false, code, error: reason };
  }

  if (child.stdout) child.stdout.setEncoding('utf8');
  if (child.stderr) child.stderr.setEncoding('utf8');
  const collect = (chunk) => appendTaskLog(kind, chunk);
  if (child.stdout) child.stdout.on('data', collect);
  if (child.stderr) child.stderr.on('data', collect);

  child.once('close', (code) => {
    if (taskChild !== child) return; // 已被超时/dispose 接过手，别覆盖终态
    const exitCode = Number.isInteger(code) ? code : null;
    if (taskTimedOut) {
      settleTask(kind, { phase: 'failed', exitCode, message: spec.timeoutMessage });
      return;
    }
    if (typeof spec.onExit === 'function') {
      // 采集跑完要顺手灌库：放在终态之前做，面板只会看到一条进度
      settleTask(kind, { exitCode, ...(spec.onExit(exitCode) || {}) });
      return;
    }
    settleTask(kind, { phase: exitCode === 0 ? 'done' : 'failed', exitCode });
  });

  taskTimer = setTimeout(() => {
    taskTimer = null;
    if (taskChild !== child) return;
    taskTimedOut = true;
    appendTaskLog(kind, '\n[host] 超时，正在终止脚本\n');
    try {
      child.kill();
    } catch {
      // 已经退了就没什么可杀的
    }
    settleTask(kind, {
      phase: 'failed',
      exitCode: readTaskState(kind).exitCode,
      message: spec.timeoutMessage,
    });
  }, timeoutMs);
  if (taskTimer && typeof taskTimer.unref === 'function') taskTimer.unref();

  return { ok: true };
}

/**
 * 起一次登录。同一时刻只允许一个任务：第二次进来直接 `busy`——两个脚本抢同一个浏览器
 * profile 会把用户扫的码对到另一次登录上。
 * @returns {Promise<{ok: true, login: object} | {ok: false, code: string, error: string}>}
 */
export async function startLogin(platform, account) {
  const built = buildLoginPlan(platform, account);
  if (!built.ok) return { ok: false, code: built.code, error: built.error };
  if (taskChild) return busyResult();
  const started = await runCollectorTask({
    kind: 'login',
    plan: built.plan,
    timeoutMs: LOGIN_TIMEOUT_MS,
    timeoutMessage: '登录超时：脚本 ' + Math.round(LOGIN_TIMEOUT_MS / 1000) + ' 秒没有退出，已终止；确认网络后可以再点一次',
  });
  if (!started.ok) return started;
  return { ok: true, login: loginSnapshot() };
}

/**
 * 采集脚本退出后的收口：**退出码 0 才灌库**，灌库结果直接写进面板看的 counts。
 *
 * 非 0 不导入是刻意的：脚本对「凭据失效」「被风控」「导出超时」给了不同退出码，
 * 失败路径下它可能只写了半份 JSON——灌进 append-only 的台账就再也撤不回来了。
 */
function finishFetch(config, plan, exitCode) {
  if (exitCode !== 0) return { phase: 'failed', counts: null };
  let imported;
  try {
    imported = importCollectorOutput(config, {
      platform: plan.platform,
      path: plan.outFile,
      // 台账里的账号用凭据别名（如 main），不是平台昵称：左栏两级树才对得上绑定时的名字
      account: plan.account,
    });
  } catch (error) {
    return {
      phase: 'failed',
      counts: null,
      message: '脚本跑完了，但灌库失败：' + String((error && error.message) || error),
    };
  }
  if (!imported || imported.ok !== true) {
    const why = (imported && (imported.error || imported.code)) || '未知原因';
    return { phase: 'failed', counts: null, message: '脚本跑完了，但灌库没成功：' + String(why) };
  }
  const counts = countsOf(imported);
  return {
    phase: 'done',
    counts,
    message: '已抓取并导入：新建 ' + (counts ? counts.created : 0) + ' 条、更新 ' + (counts ? counts.updated : 0) + ' 条',
  };
}

/**
 * 起一次「采集并导入」。与登录共用同一个任务槽，也共用同一套起进程 / 日志 / 超时。
 * @returns {Promise<{ok: true, fetch: object} | {ok: false, code: string, error: string}>}
 */
export async function startFetch(config, platform, account) {
  // 采集会往工作区 tmp/ 写产出、并读 config/ 里的凭据：同样只认宿主注入的根，不回落 cwd
  const built = buildFetchPlan(platform, account, { root: configuredWorkspaceRoot(config) });
  if (!built.ok) return { ok: false, code: built.code, error: built.error };
  const plan = built.plan;
  if (taskChild) return busyResult();
  let credentialPresent = false;
  try {
    credentialPresent = fs.existsSync(plan.credentialFile);
  } catch {
    credentialPresent = false;
  }
  if (!credentialPresent) {
    return {
      ok: false,
      code: 'no-credential',
      error: '没有凭据：' + plan.credentialName + ' 不存在，先在面板里扫码登录这个账号',
    };
  }
  // 上一轮留下的同名产出先清掉：脚本若在写文件之前就失败，退出码 0 也会把旧 JSON 灌进台账
  try {
    fs.rmSync(plan.outFile, { force: true });
  } catch {
    // 删不掉就交给脚本自己覆盖
  }
  try {
    fs.mkdirSync(path.dirname(plan.outFile), { recursive: true });
  } catch {
    // 建不出来时脚本会自己报「写不了文件」，比在这里猜更好
  }
  const started = await runCollectorTask({
    kind: 'fetch',
    plan,
    timeoutMs: FETCH_TIMEOUT_MS,
    timeoutMessage: '抓取超时：脚本 ' + Math.round(FETCH_TIMEOUT_MS / 60000) + ' 分钟没有退出，已终止；可以再点一次',
    onExit: (exitCode) => finishFetch(config, plan, exitCode),
  });
  if (!started.ok) return started;
  return { ok: true, fetch: fetchSnapshot() };
}

/**
 * 解绑一个账号：只删 `config/` 里算出来的那两个确切文件（凭据 + 身份旁路），**台账一行不动**。
 *
 * 「台账不动」是刻意的：解绑说的是「这台机器不再持有这个号的凭据」，不是「把已经记下的作品
 * 删掉」。清台账是另一件事（append-only，要用户明确要求才做）。
 *
 * 幂等：文件本来就不在也算成功，只是照实进 missing——面板刷新后这个账号就该消失。
 * @returns {{ok: true, removed: string[], missing: string[]} | {ok: false, code: string, error: string}}
 */
export function unbindAccount(config, platform, account) {
  // 有任务在跑就不解绑：登录正在写的那份凭据、采集正在读的那份，都不该在下面被抽走
  if (taskChild) return { ...busyResult(), removed: [], missing: [] };
  // 先问「平台/账号合不合法」：这一步是纯函数、不碰磁盘，所以即使拿不到工作区根，
  // 也能回一句准确的错（bad-account / bad-platform），而不是一律 no-workspace
  const dry = buildUnbindPlan(platform, account, '');
  if (!dry.ok) return dry;
  // 删文件不猜目录：只认宿主注入的工作区根（见 store.js 的 configuredWorkspaceRoot 注释）
  const root = configuredWorkspaceRoot(config);
  if (!root) {
    return {
      ok: false,
      code: 'no-workspace',
      error: '面板没拿到工作区根，不敢猜 config/ 在哪，这次不删任何文件',
      removed: [],
      missing: [],
    };
  }
  const dir = path.join(root, 'config');
  const built = buildUnbindPlan(dry.plan.platform, dry.plan.account, dir);
  if (!built.ok) return built;
  const removed = [];
  const missing = [];
  for (const item of built.plan.files) {
    if (!dir) {
      // 连 config/ 都定位不到，那两个文件自然不在；按幂等语义如实报 missing
      missing.push(item.name);
      continue;
    }
    const target = path.resolve(dir, item.name);
    // 第二道锁：纯函数已经校过一次，这里按 resolve 后的结果再校一次——只删 config 的直接子文件
    if (path.dirname(target) !== path.resolve(dir)) {
      return { ok: false, code: 'bad-account', error: '拒绝删除 config 目录之外的文件：' + item.name, removed, missing };
    }
    try {
      fs.unlinkSync(target);
      removed.push(item.name);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        missing.push(item.name);
        continue;
      }
      return {
        ok: false,
        code: 'unlink-failed',
        error: '删不掉 ' + item.name + '：' + String((error && error.message) || error),
        removed,
        missing,
      };
    }
  }
  return { ok: true, removed, missing };
}

/**
 * 插件卸载时收尾：正在跑的那个脚本（登录或采集）必须杀掉。不然宿主退到后台、浏览器窗口
 * 还开着，用户以为自己还在登录，实际再点一次只会拿到 busy。
 *
 * 两条任务的进度一起清空：卸载后再装回来，面板不该还挂着上一轮留下的半截日志。
 * @returns {boolean} 有没有真的掐掉一个在跑的任务
 */
export function disposeLogin() {
  const running = Boolean(taskChild);
  if (taskTimer) {
    clearTimeout(taskTimer);
    taskTimer = null;
  }
  const child = taskChild;
  taskChild = null;
  taskKind = '';
  if (child) {
    try {
      child.kill();
    } catch {
      // 已经退了
    }
  }
  taskTimedOut = false;
  loginState = blankLoginState();
  fetchState = blankFetchState();
  return running;
}

/**
 * 路由表。形状照 `dsh-free-search` 的实证写法：`{ kind: 'exact', path, handler }`，
 * `webServer.register(route)` 返回 disposer。
 */
export function makeBridgeRoutes(ctx, config) {
  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method || ''}` });
          return;
        }
        try {
          // login / fetch 是现场维护的进度字段，其余全从台账目录算出来
          writeJson(res, 200, { ...readPanel(config), login: loginSnapshot(), fetch: fetchSnapshot() });
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            error: String((error && error.message) || error),
            sidebar: sidebarEnabled(config),
            login: loginSnapshot(),
            fetch: fetchSnapshot(),
          });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/sidebar`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method || ''}` });
          return;
        }
        const value = parseValue(await readJsonBody(req));
        if (value === undefined) {
          writeJson(res, 400, { ok: false, code: 'bad-request', error: '请求体要写成 {"value": true|false}' });
          return;
        }
        writeJson(res, 200, await saveSidebar(ctx, value));
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/login`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method || ''}` });
          return;
        }
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            error: '请求体要写成 {"platform":"bilibili","account":"main"}',
          });
          return;
        }
        // 平台必填：漏了就是坏请求，别让下游把它讲成「不认识的平台：（空）」
        if (typeof body.platform !== 'string' || !body.platform.trim()) {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            error: '请求体要写成 {"platform":"bilibili","account":"main"}：platform 是必填的',
          });
          return;
        }
        let result;
        try {
          // account 缺省时由纯函数补成 main；平台名认不出就是 bad-platform，绝不起进程
          result = await startLogin(body.platform, body.account);
        } catch (error) {
          result = { ok: false, code: 'spawn-failed', error: String((error && error.message) || error) };
        }
        if (result.ok) writeJson(res, 200, { ok: true, login: result.login });
        else writeJson(res, 200, { ok: false, code: result.code, error: result.error });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/login/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method || ''}` });
          return;
        }
        writeJson(res, 200, { ok: true, login: loginSnapshot() });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/unbind`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method || ''}` });
          return;
        }
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            error: '请求体要写成 {"platform":"bilibili","account":"main"}',
          });
          return;
        }
        // 平台必填：漏了就是坏请求，别让下游把它讲成「不认识的平台：（空）」
        if (typeof body.platform !== 'string' || !body.platform.trim()) {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            error: '请求体要写成 {"platform":"bilibili","account":"main"}：platform 是必填的',
          });
          return;
        }
        let result;
        try {
          // 删哪两个文件由纯函数算，这里只做「算出来的确实是 config 的直接子文件」这道复核
          result = unbindAccount(config, body.platform, body.account);
        } catch (error) {
          result = { ok: false, code: 'unlink-failed', error: String((error && error.message) || error) };
        }
        // 幂等：文件本来就不在也算 200，missing 照实报（面板据此刷新那个账号）
        if (result.ok) writeJson(res, 200, { ok: true, removed: result.removed, missing: result.missing });
        else {
          writeJson(res, 200, {
            ok: false,
            code: result.code,
            error: result.error,
            removed: result.removed || [],
            missing: result.missing || [],
          });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/fetch`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method || ''}` });
          return;
        }
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            error: '请求体要写成 {"platform":"bilibili","account":"main"}',
          });
          return;
        }
        // 平台必填：漏了就是坏请求，别让下游把它讲成「不认识的平台：（空）」
        if (typeof body.platform !== 'string' || !body.platform.trim()) {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            error: '请求体要写成 {"platform":"bilibili","account":"main"}：platform 是必填的',
          });
          return;
        }
        let result;
        try {
          // 采集是**用户点一下才跑**的：这条路由本身不排队、不定时，起不来就原样报原因
          result = await startFetch(config, body.platform, body.account);
        } catch (error) {
          result = { ok: false, code: 'spawn-failed', error: String((error && error.message) || error) };
        }
        if (result.ok) writeJson(res, 200, { ok: true, fetch: result.fetch });
        else writeJson(res, 200, { ok: false, code: result.code, error: result.error });
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/fetch/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method || ''}` });
          return;
        }
        writeJson(res, 200, { ok: true, fetch: fetchSnapshot() });
      },
    },
  ];
}
