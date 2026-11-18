/**
 * Host 侧的面板桥：左侧栏面板是浏览器里的 React 组件，它读不到 Host 的 `config`
 * 也读不到磁盘，所以这里开几条**只在本机回环上**的 HTTP 路由给它：
 *
 *   GET  /api/dsh-media-ledger/state       → 面板数据（复盘 + 作品列表）+ 侧栏开关 + 登录进度
 *   POST /api/dsh-media-ledger/sidebar     → 改「是否在左侧栏显示」，写回插件配置
 *   POST /api/dsh-media-ledger/login       → 起一次「扫码登录」（白名单脚本，全插件唯一的子进程）
 *   GET  /api/dsh-media-ledger/login/state → 这次登录跑到哪一步了（面板每 2 秒问一次）
 *
 * 为什么不像 `dsh-free-search` 那样一上来就自带一套设置页：这里只有一个布尔开关，
 * 一条 POST 就够了，没必要再造表单框架。
 *
 * 安全边界：只读写本机台账目录与白名单登录脚本；`/sidebar` 只认 `{ value: boolean }`，
 * `/login` 只认 `{ platform, account }` 且账号先过正则，两条都不把入参反射到路径或命令行。
 *
 * 子进程例外：本插件的铁律是「不起进程、不联网」（见仓库 AGENTS.md §5）。2026-11-18 用户
 * 批准了一条**窄例外**——只为扫码登录起 `scripts/` 下白名单里的那三个脚本，别的一概不行。
 * 所以 `node:child_process` 在整个仓库只出现在这个文件，且只被下面的 `startLogin` 用；
 * 命令与参数由 `lib/login.js` 的纯函数拼好（不经过 shell），这里只负责起、等、超时杀、收口。
 * @module dsh-media-ledger/bridge
 */

import fs from 'node:fs';
import path from 'node:path';
// 全仓库唯一一处子进程：只为「扫码登录」起白名单脚本（2026-11-18 用户批准的窄例外）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLedger, resolveDataDir, resolveWorkspaceRoot } from './store.js';
import { buildRows } from './metrics.js';
import { buildPanel } from './panel.js';
import { describeBindings } from './bindings.js';
import { LOGIN_LOG_LIMIT, LOGIN_TIMEOUT_MS, buildLoginPlan, describeLoginState } from './login.js';

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
    if (!String(name).toLowerCase().endsWith('.txt')) continue;
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
  const bindings = describeBindings(credentials.entries);
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

// ── 扫码登录：全插件唯一的子进程 ─────────────────────────────────────────
//
// 铁律是「不起进程、不联网」（AGENTS.md §5）。2026-11-18 用户批准了一条窄例外：只为
// 「面板里扫码登录」起白名单脚本。它落在这个文件，因为这里已经是唯一的 IO 层；
// `lib/login.js` 只出纯函数（起哪个脚本、带什么参数、状态怎么讲成人话），那里一行 IO 都没有。

/** 脚本以仓库根为 cwd 跑：脚本自己会向上找工作区，这里只是给个稳定原点。 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 原始日志比面板契约多留一倍：先收全、再滤凭据行、最后才截到 2000 字符。 */
const LOGIN_LOG_RAW_LIMIT = LOGIN_LOG_LIMIT * 2;

/**
 * 一次登录的进度。**只在内存里**：它描述的是「这个宿主进程正在跑的那个脚本」。
 * 宿主重启后凭据文件还在（面板照样说「已绑定」），而上次跑到第几步已经没有意义。
 */
let loginState = {
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
/** 在跑的子进程；null = 当前没有任务（有它在才算 busy）。 */
let loginChild = null;
/** 超时闹钟。 */
let loginTimer = null;
/** 区分「脚本自己失败」与「我们掐掉的」——两者都要说清楚。 */
let loginTimedOut = false;

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

function appendLoginLog(chunk) {
  const text = String(chunk || '');
  if (!text) return;
  loginState.log = (loginState.log + text).slice(-LOGIN_LOG_RAW_LIMIT);
}

/** 收口：成功、失败、超时都从这里进终态，顺手清掉 child 与闹钟（不留僵尸）。 */
function settleLogin(patch) {
  if (loginTimer) {
    clearTimeout(loginTimer);
    loginTimer = null;
  }
  loginChild = null;
  const next = { ...loginState, finishedAt: Date.now(), ...patch };
  loginState = next.phase === 'running' ? { ...next, phase: 'done' } : next;
}

/**
 * 起一次登录。同一时刻只允许一个任务：第二次进来直接 `busy`——两个脚本抢同一个浏览器
 * profile 会把用户扫的码对到另一次登录上。
 * @returns {Promise<{ok: true, login: object} | {ok: false, code: string, error: string}>}
 */
export async function startLogin(platform, account) {
  const built = buildLoginPlan(platform, account);
  if (!built.ok) return { ok: false, code: built.code, error: built.error };
  const plan = built.plan;
  if (loginChild) {
    return {
      ok: false,
      code: 'busy',
      error: '已经有一个登录任务在跑了（' + (loginState.platform || '未知平台') + '），等它结束再点一次',
    };
  }
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
      error: '找不到登录脚本：' + plan.script + '（插件装不完整，或 scripts/ 被删了）',
    };
  }

  const python = pythonCommand();
  loginTimedOut = false;
  loginState = {
    ...blankLoginState(),
    phase: 'running',
    platform: plan.platform,
    account: plan.account,
    startedAt: Date.now(),
  };

  let child;
  try {
    child = spawn(python, [scriptPath, ...plan.args], {
      cwd: PKG_ROOT,
      // 不经过 shell：账号已经过正则，但「拼接」这条路一次都不开
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上别闪黑框；浏览器窗口是脚本自己开的
      windowsHide: true,
    });
  } catch (error) {
    const reason = '起不了登录脚本：' + String((error && error.message) || error);
    settleLogin({ phase: 'failed', message: reason });
    return { ok: false, code: 'spawn-failed', error: reason };
  }

  loginChild = child;
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
      : '起不了登录脚本：' + String((failure && failure.message) || failure);
    settleLogin({ phase: 'failed', message: reason });
    return { ok: false, code, error: reason };
  }

  if (child.stdout) child.stdout.setEncoding('utf8');
  if (child.stderr) child.stderr.setEncoding('utf8');
  const collect = (chunk) => appendLoginLog(chunk);
  if (child.stdout) child.stdout.on('data', collect);
  if (child.stderr) child.stderr.on('data', collect);

  child.once('close', (code) => {
    if (loginChild !== child) return; // 已被超时/dispose 接过手，别覆盖终态
    const exitCode = Number.isInteger(code) ? code : null;
    if (loginTimedOut) {
      settleLogin({
        phase: 'failed',
        exitCode,
        message: '登录超时：脚本没有在限定时间内退出，已被终止（可以再点一次）',
      });
      return;
    }
    settleLogin({ phase: exitCode === 0 ? 'done' : 'failed', exitCode });
  });

  loginTimer = setTimeout(() => {
    loginTimer = null;
    if (loginChild !== child) return;
    loginTimedOut = true;
    appendLoginLog('\n[host] 登录超时，正在终止脚本\n');
    try {
      child.kill();
    } catch {
      // 已经退了就没什么可杀的
    }
    settleLogin({
      phase: 'failed',
      exitCode: loginState.exitCode,
      message: '登录超时：脚本 ' + Math.round(LOGIN_TIMEOUT_MS / 1000) + ' 秒没有退出，已终止；确认网络后可以再点一次',
    });
  }, LOGIN_TIMEOUT_MS);
  if (loginTimer && typeof loginTimer.unref === 'function') loginTimer.unref();

  return { ok: true, login: loginSnapshot() };
}

/**
 * 插件卸载时收尾：正在跑的登录脚本必须杀掉。不然宿主退到后台、浏览器窗口还开着，
 * 用户以为自己还在登录，实际再点一次只会拿到 busy。
 * @returns {boolean} 有没有真的掐掉一个在跑的任务
 */
export function disposeLogin() {
  const running = Boolean(loginChild);
  if (loginTimer) {
    clearTimeout(loginTimer);
    loginTimer = null;
  }
  const child = loginChild;
  loginChild = null;
  if (child) {
    try {
      child.kill();
    } catch {
      // 已经退了
    }
  }
  loginTimedOut = false;
  loginState = blankLoginState();
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
          // login 是唯一现场维护的字段，其余全从台账目录算出来
          writeJson(res, 200, { ...readPanel(config), login: loginSnapshot() });
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            error: String((error && error.message) || error),
            sidebar: sidebarEnabled(config),
            login: loginSnapshot(),
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
  ];
}
