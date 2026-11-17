/**
 * 面板数据整形：把 `buildRows()` 的复盘行整理成左侧栏面板能直接渲染的形状。
 *
 * 纯函数，不读文件、不碰网络——IO 在 `lib/bridge.js`，这样 smoke 里能直接断言。
 * 面板只搬运已有口径（`buildReport`），**不重新定义**任何指标：
 * 互动率、中位数、T+ 龄期都在 `lib/metrics.js` 里，改口径去那里改，别在面板里另算一套。
 * @module dsh-media-ledger/panel
 */

import { buildReport } from './metrics.js';

/** 面板里一行作品需要的字段（顺序即渲染顺序，前端不必再挑字段）。 */
const POST_FIELDS = ['id', 'platform', 'account', 'kind', 'title', 'date', 'captured_at', 'play', 'like', 'comment', 'share', 'collect', 'tPlusHours'];

/** 面板里每行作品：只留面板要显示的字段，日期新的排前面。 */
export function toPanelPost(row) {
  const post = {};
  for (const field of POST_FIELDS) post[field] = row[field] ?? null;
  post.title = row.title || '';
  post.platform = row.platform || '';
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

/**
 * 面板 payload。
 * @param {Array<object>} rows `buildRows()` 的输出
 * @param {{groupBy?: 'kind'|'platform'|'account'}} [options]
 * @returns {{report: object, posts: Array<object>}}
 */
export function buildPanel(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    report: buildReport(list, { groupBy: options.groupBy || 'kind' }),
    posts: list.map(toPanelPost).sort(comparePosts),
  };
}
