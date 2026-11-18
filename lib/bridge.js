/**
 * Host 侧的面板桥：左侧栏面板是浏览器里的 React 组件，它读不到 Host 的 `config`
 * 也读不到磁盘，所以这里开几条**只在本机回环上**的 HTTP 路由给它：
 *
 *   GET  /api/dsh-media-ledger/state    → 面板数据（复盘 + 作品列表）+ 侧栏开关
 *   POST /api/dsh-media-ledger/sidebar  → 改「是否在左侧栏显示」，写回插件配置
 *
 * 为什么不像 `dsh-free-search` 那样一上来就自带一套设置页：这里只有一个布尔开关，
 * 一条 POST 就够了，没必要再造表单框架。
 *
 * 安全边界：只读写本机台账目录，请求体只认 `{ value: boolean }`，不反射任何入参到路径。
 * @module dsh-media-ledger/bridge
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadLedger, resolveDataDir, resolveWorkspaceRoot } from './store.js';
import { buildRows } from './metrics.js';
import { buildPanel } from './panel.js';
import { describeBindings } from './bindings.js';

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

/** 读台账并整形；台账坏掉时把原因带回去，面板照样能显示（而不是整页炸掉）。 */
export function readPanel(config, options = {}) {
  const dir = resolveDataDir(config);
  const ledger = loadLedger(dir);
  const rows = buildRows(ledger.posts, ledger.metrics);
  const panel = buildPanel(rows, { groupBy: options.groupBy || 'platform' });
  const credentials = listCredentialFiles(config);
  return {
    ok: true,
    sidebar: sidebarEnabled(config),
    dataDir: dir,
    // 四平台恒在：没绑的平台也要能点进去，看到「下一步敲什么」
    bindings: { configDir: credentials.dir, ...describeBindings(credentials.entries) },
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
          writeJson(res, 200, readPanel(config));
        } catch (error) {
          writeJson(res, 200, { ok: false, error: String((error && error.message) || error), sidebar: sidebarEnabled(config) });
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
  ];
}
