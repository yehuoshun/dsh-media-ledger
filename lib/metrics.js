/**
 * 复盘计算：全部是纯函数，输入台账记录，输出能直接渲染的数字。
 *
 * 三条口径（踩过的坑写在这里，免得以后又改回去）：
 * 1. 同一条作品多次报数 → 只取 captured_at 最新的那条；比较用真时间解析，
 *    不能拿字符串比（'2026-11-17T09:00' 在字符串上会压过 '2026-11-17 18:00'）。
 * 2. 中位数而不用均值：一条爆款就能把均值拉到没有参考价值。
 * 3. 互动率只在「同一条快照里同时有播放和互动」的行上算；分子分母来自不同批
 *    会算出 10050% 这种数。
 * @module dsh-media-ledger/metrics
 */

import { parseCount } from './util.js';

const DATE_ONLY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const WITH_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** 解析 `2026-11-14`、`2026-11-14 20:30`、`2026-11-14T20:30:00`；按本地时间理解。 */
export function parseTs(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\//g, '-');
  const withTime = WITH_TIME.exec(text);
  if (withTime) {
    return new Date(
      Number(withTime[1]),
      Number(withTime[2]) - 1,
      Number(withTime[3]),
      Number(withTime[4]),
      Number(withTime[5]),
      Number(withTime[6] || 0),
    ).getTime();
  }
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
  return null;
}

/** 发布到报数之间隔了几小时（T+ 龄期）。算不出返回 null，不猜。 */
export function hoursBetween(publishedAt, capturedAt) {
  const from = parseTs(publishedAt);
  const to = parseTs(capturedAt);
  if (from === null || to === null) return null;
  return Math.round(((to - from) / 36e5) * 10) / 10;
}

/** 每条作品的最新快照；time 解析不出来的快照排在最后（按出现顺序兜底）。 */
export function latestSnapshots(metrics) {
  const best = new Map();
  metrics.forEach((snapshot, index) => {
    const id = String(snapshot.id || '').trim();
    if (!id) return;
    const time = parseTs(snapshot.captured_at);
    const rank = time === null ? Number.NEGATIVE_INFINITY : time;
    const prev = best.get(id);
    if (!prev || rank > prev.rank || (rank === prev.rank && index > prev.index)) {
      best.set(id, { snapshot, rank, index });
    }
  });
  return new Map([...best].map(([id, entry]) => [id, entry.snapshot]));
}

export function median(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  const value = numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
  return Math.round(value * 10) / 10;
}

const LINK_KEYS = ['like', 'comment', 'share', 'collect'];

/** 把作品与最新快照拼成复盘行。没报过数的作品也保留（play 为 null）。 */
export function buildRows(posts, metrics) {
  const latest = latestSnapshots(metrics);
  return posts.map((post) => {
    const snapshot = latest.get(String(post.id)) || null;
    const row = {
      id: post.id,
      platform: post.platform,
      account: post.account || '',
      kind: post.kind || '未分类',
      title: post.title || '',
      date: post.date || '',
      published_at: post.published_at || '',
      captured_at: snapshot ? snapshot.captured_at : '',
      play: null,
      like: null,
      comment: null,
      share: null,
      collect: null,
      tPlusHours: null,
    };
    if (snapshot) {
      for (const key of ['play', ...LINK_KEYS]) row[key] = parseCount(snapshot[key]);
      const derived = hoursBetween(post.published_at, snapshot.captured_at);
      row.tPlusHours = derived === null ? (typeof snapshot.t_plus_h === 'number' ? snapshot.t_plus_h : null) : derived;
    }
    return row;
  });
}

/** 互动率：只用同时有播放和互动的行，分子分母同批。 */
export function interaction(rows) {
  const paired = rows.filter((row) => typeof row.play === 'number' && row.play > 0);
  if (paired.length === 0) return null;
  const plays = paired.reduce((sum, row) => sum + row.play, 0);
  const links = paired.reduce((sum, row) => sum + LINK_KEYS.reduce((inner, key) => inner + (row[key] || 0), 0), 0);
  return Math.round((links / plays) * 10000) / 100;
}

/** 评论赞比：评论区比点赞更活跃说明有人在争。 */
export function commentLikeRatio(rows) {
  const likes = rows.reduce((sum, row) => sum + (row.like || 0), 0);
  if (likes <= 0) return null;
  const comments = rows.reduce((sum, row) => sum + (row.comment || 0), 0);
  return Math.round((comments / likes) * 100) / 100;
}

const GROUPERS = {
  kind: (row) => row.kind || '未分类',
  platform: (row) => row.platform || '未知平台',
  account: (row) => row.account || '未填账号',
};

export function groupKeyOf(groupBy) {
  return typeof GROUPERS[groupBy] === 'function' ? groupBy : 'kind';
}

/** 生成复盘结果：分组中位数、龄期范围、以及需要人注意的警告。 */
export function buildReport(rows, options = {}) {
  const groupBy = groupKeyOf(options.groupBy);
  const buckets = new Map();
  for (const row of rows) {
    const key = GROUPERS[groupBy](row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const groups = [...buckets.entries()].map(([key, items]) => ({
    key,
    count: items.length,
    playMedian: median(items.map((row) => row.play)),
    likeMedian: median(items.map((row) => row.like)),
    interactionRate: interaction(items),
    commentLikeRatio: commentLikeRatio(items),
  }));
  groups.sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));

  const ages = rows.map((row) => row.tPlusHours).filter((value) => typeof value === 'number');
  const warnings = [];
  if (ages.length > 0) {
    const span = Math.max(...ages) - Math.min(...ages);
    if (span >= 24) {
      warnings.push(`龄期跨度 ${Math.round(span)} 小时，不同龄期的数据混在一起比较意义不大，用 maxAgeHours 只看同一批`);
    }
  } else if (rows.length > 0) {
    warnings.push('都没有 published_at，算不出 T+ 龄期；补上发布时间才能做同龄对比');
  }
  const withoutData = rows.filter((row) => row.play === null && row.like === null).length;
  if (withoutData > 0) warnings.push(`${withoutData} 条还没报数`);

  return {
    groupBy,
    total: rows.length,
    withData: rows.length - withoutData,
    interactionRate: interaction(rows),
    groups,
    ageRangeHours: ages.length > 0 ? [Math.min(...ages), Math.max(...ages)] : null,
    warnings,
  };
}
