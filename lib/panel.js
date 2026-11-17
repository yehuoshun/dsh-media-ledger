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
 * 面板 payload。
 * @param {Array<object>} rows `buildRows()` 的输出
 * @param {{groupBy?: 'kind'|'platform'|'account', postLimit?: number}} [options]
 *   `groupBy` 只作用于 `all` 这一层（下钻时固定：平台层按账号、账号层按类型）
 * @returns {{report: object, reports: Record<string, object>, facets: object, posts: Array<object>, postsTotal: number, truncated: boolean, postLimit: number}}
 */
export function buildPanel(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const postLimit = Number.isInteger(options.postLimit) && options.postLimit > 0 ? options.postLimit : POST_LIMIT;

  const facets = buildFacets(list);
  const reports = { all: buildReport(list, { groupBy: options.groupBy || 'platform' }) };
  for (const platform of facets.platforms) {
    const platformRows = rowsOfSlice(list, { kind: 'platform', platform: platform.key, account: '' });
    reports[`platform:${platform.key}`] = buildReport(platformRows, { groupBy: 'account' });
    for (const account of platform.accounts) {
      const accountRows = rowsOfSlice(list, { kind: 'account', platform: platform.key, account: account.key });
      reports[`account:${platform.key}|${account.key}`] = buildReport(accountRows, { groupBy: 'kind' });
    }
  }

  const sorted = list.map(toPanelPost).sort(comparePosts);
  return {
    report: reports.all,
    reports,
    facets,
    posts: sorted.slice(0, postLimit),
    postsTotal: sorted.length,
    truncated: sorted.length > postLimit,
    postLimit,
  };
}
