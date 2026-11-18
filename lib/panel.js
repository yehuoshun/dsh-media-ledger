/**
 * 面板数据整形：把 `buildRows()` 的复盘行整理成左侧栏面板能直接渲染的形状。
 *
 * 纯函数，不读文件、不碰网络——IO 在 `lib/bridge.js`，这样 smoke 里能直接断言。
 * 面板只搬运已有口径（`buildReport`），**不重新定义**任何指标：
 * 互动率、中位数、T+ 龄期都在 `lib/metrics.js` 里，改口径去那里改，别在面板里另算一套。
 *
 * 面板是「左导航 + 右内容」：左栏要平台 → 账号两级树，右栏要**当前选中切片**的复盘。
 * 所以这里一次把每个切片的 `buildReport` 都算好（切片数 = 1 + 平台数 + 账号数，几个而已），
 * 前端只管按 id 取，一个指标都不自己算。
 * @module dsh-media-ledger/panel
 */

import { buildReport } from './metrics.js';
import { PLATFORMS } from './config.js';

/** 面板里一行作品需要的字段（顺序即渲染顺序，前端不必再挑字段）。 */
const POST_FIELDS = ['id', 'platform', 'account', 'kind', 'title', 'date', 'captured_at', 'play', 'like', 'comment', 'share', 'collect', 'tPlusHours'];

/** 面板一次最多带多少行作品。再多就不往浏览器塞了，让用户用 `media list` 看全量。 */
export const POST_LIMIT = 300;

/** 平台中文名；不在表里的平台直接显示原值，不猜。 */
const PLATFORM_LABELS = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', shipinhao: '视频号' };

/** 没有平台 / 没有账号的老记录照样要能选中，给它们一个固定标签。 */
export const NO_PLATFORM_LABEL = '未归平台';
export const NO_ACCOUNT_LABEL = '未标账号';

export function platformLabel(key) {
  if (!key) return NO_PLATFORM_LABEL;
  return PLATFORM_LABELS[key] || key;
}

export function accountLabel(name) {
  return name || NO_ACCOUNT_LABEL;
}

/** 面板里每行作品：只留面板要显示的字段，日期新的排前面。 */
export function toPanelPost(row) {
  const post = {};
  for (const field of POST_FIELDS) post[field] = row[field] ?? null;
  post.title = row.title || '';
  post.platform = row.platform || '';
  post.account = row.account || '';
  post.kind = row.kind || '未分类';
  post.date = row.date || '';
  post.hasData = row.play !== null || row.like !== null;
  return post;
}

/** 列表排序：发布日倒序；同一天按 id 倒序（id 递增，倒序即新加的在前）。 */
function comparePosts(a, b) {
  const byDate = String(b.date || '').localeCompare(String(a.date || ''));
  if (byDate !== 0) return byDate;
  return String(b.id || '').localeCompare(String(a.id || ''));
}

function platformKeyOf(row) {
  return typeof row.platform === 'string' ? row.platform.trim() : '';
}

function accountKeyOf(row) {
  return typeof row.account === 'string' ? row.account.trim() : '';
}

/**
 * 左导航的筛选树：平台 → 账号，带条数。
 * 账号只列具名的（空账号的条数算进平台总数，不单列成「未标账号」节点——那会让树变噪音）。
 * @returns {{platforms: Array<{key: string, label: string, count: number, accounts: Array<{key: string, label: string, count: number}>}>, unassigned: number}}
 */
export function buildFacets(rows) {
  const byPlatform = new Map();
  let unassigned = 0;
  for (const row of rows) {
    const platform = platformKeyOf(row);
    if (!platform) {
      unassigned += 1;
      continue;
    }
    if (!byPlatform.has(platform)) byPlatform.set(platform, new Map());
    const accounts = byPlatform.get(platform);
    const account = accountKeyOf(row);
    accounts.set(account, (accounts.get(account) || 0) + 1);
  }

  const order = [...PLATFORMS];
  for (const key of byPlatform.keys()) if (!order.includes(key)) order.push(key);

  const platforms = [];
  for (const key of order) {
    const accounts = byPlatform.get(key);
    if (!accounts) continue;
    let count = 0;
    const named = [];
    for (const [name, hits] of accounts) {
      count += hits;
      if (name) named.push({ key: name, label: name, count: hits });
    }
    named.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    platforms.push({ key, label: platformLabel(key), count, accounts: named });
  }
  return { platforms, unassigned, total: rows.length };
}

/**
 * 左导航要的平台列表：`PLATFORMS` 里的四个平台**恒在**，0 条也列出来。
 *
 * `buildFacets` 只列「有数据的平台」，那是对的（它服务的是筛选树里的账号下钻），
 * 但空台账时会让左栏一个平台都没有——用户点不到 B站，也就看不到「为什么是空的」。
 * @returns {Array<{key: string, label: string, count: number}>}
 */
export function platformList(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = new Map();
  for (const row of list) {
    const key = platformKeyOf(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const order = [...PLATFORMS];
  for (const key of counts.keys()) if (!order.includes(key)) order.push(key);
  return order.map((key) => ({ key, label: platformLabel(key), count: counts.get(key) || 0 }));
}

/** 切片 id：`all` / `platform:<平台>` / `account:<平台>|<账号>`，前端与断言共用同一套解析。 */
export function parseSlice(id) {
  const text = typeof id === 'string' ? id : '';
  if (text.startsWith('platform:')) {
    return { kind: 'platform', platform: text.slice('platform:'.length), account: '' };
  }
  if (text.startsWith('account:')) {
    const rest = text.slice('account:'.length);
    const cut = rest.indexOf('|');
    if (cut >= 0) return { kind: 'account', platform: rest.slice(0, cut), account: rest.slice(cut + 1) };
  }
  return { kind: 'all', platform: '', account: '' };
}

/** 按切片挑行；和 `reports` 里同 id 的那份是同一批行，口径因此天然一致。 */
function rowsOfSlice(rows, slice) {
  if (slice.kind === 'platform') return rows.filter((row) => platformKeyOf(row) === slice.platform);
  if (slice.kind === 'account') {
    return rows.filter((row) => platformKeyOf(row) === slice.platform && accountKeyOf(row) === slice.account);
  }
  return rows;
}

/**
 * 归一化 `options.boundAccounts`：只认「平台 → 账号名数组」这个形状，别的（缺省、null、
 * 数组、乱写）一律当没给——面板宁可少一个空切片，也不能因为调用方传了怪东西就崩。
 *
 * 账号名照 `accountKeyOf` 的口径 trim：切片键与行里的账号必须用同一把尺子量，
 * 否则「凭据里的 main」和「行里的 main 」会被当成两个账号。
 * @returns {Map<string, string[]>} 平台 → 去重后的账号名
 */
export function normalizeBoundAccounts(value) {
  const out = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [rawPlatform, rawNames] of Object.entries(value)) {
    const platform = typeof rawPlatform === 'string' ? rawPlatform.trim() : '';
    if (!platform || !Array.isArray(rawNames)) continue;
    const names = [];
    for (const rawName of rawNames) {
      const account = typeof rawName === 'string' ? rawName.trim() : '';
      if (!account || names.includes(account)) continue;
      names.push(account);
    }
    if (names.length > 0) out.set(platform, names);
  }
  return out;
}

/**
 * 面板 payload。
 * @param {Array<object>} rows `buildRows()` 的输出
 * @param {{groupBy?: 'kind'|'platform'|'account', postLimit?: number, boundAccounts?: Record<string, string[]>}} [options]
 *   `groupBy` 只作用于 `all` 这一层（下钻时固定：平台层按账号、账号层按类型）；
 *   `boundAccounts` 是「平台 → 已有凭据的账号名」（默认 `{}`），只用来给**台账里还没出现**的账号补空切片
 * @returns {{report: object, reports: Record<string, object>, facets: object, platforms: Array<object>, posts: Array<object>, postsTotal: number, truncated: boolean, postLimit: number}}
 */
export function buildPanel(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const postLimit = Number.isInteger(options.postLimit) && options.postLimit > 0 ? options.postLimit : POST_LIMIT;

  const facets = buildFacets(list);
  const platforms = platformList(list);
  const reports = { all: buildReport(list, { groupBy: options.groupBy || 'platform' }) };
  // 平台层：四个平台恒有一份复盘（空平台就是空报告），这样点进去能看见「这里为什么空」
  for (const platform of platforms) {
    const platformRows = rowsOfSlice(list, { kind: 'platform', platform: platform.key, account: '' });
    reports[`platform:${platform.key}`] = buildReport(platformRows, { groupBy: 'account' });
  }
  // 账号层：只有真出现过的账号才建切片（账号是数据里长出来的，不是预置的）
  for (const platform of facets.platforms) {
    for (const account of platform.accounts) {
      const accountRows = rowsOfSlice(list, { kind: 'account', platform: platform.key, account: account.key });
      reports[`account:${platform.key}|${account.key}`] = buildReport(accountRows, { groupBy: 'kind' });
    }
  }

  // 账号层再补一类：**有凭据、台账里还没出现过作品**的账号（来自 options.boundAccounts）。
  // 用户绑了小号还没采数据时，左栏那个账号点了也进不去——以前 reports[切片] 不存在，
  // 前端会回落到 data.report（全部切片），于是「小号的空页面」显示的是大号的数字。
  // 做法与「空平台也建空报告」完全一致：同一套 buildReport，只是行集为空，点进去是空态。
  // 已经真出现过的账号上面建过了，这里跳过（不重算、不覆盖）。
  for (const [platform, accounts] of normalizeBoundAccounts(options.boundAccounts)) {
    for (const account of accounts) {
      const slice = `account:${platform}|${account}`;
      if (reports[slice]) continue;
      reports[slice] = buildReport(rowsOfSlice(list, { kind: 'account', platform, account }), { groupBy: 'kind' });
    }
  }

  const sorted = list.map(toPanelPost).sort(comparePosts);
  return {
    report: reports.all,
    reports,
    facets,
    platforms,
    posts: sorted.slice(0, postLimit),
    postsTotal: sorted.length,
    truncated: sorted.length > postLimit,
    postLimit,
  };
}
