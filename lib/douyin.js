/**
 * 抖音创作中心数据的归一化：**纯函数**，不联网、不读文件、不读环境变量。
 *
 * 抓取在仓库外的脚本里（`scripts/douyin_sync.py`），它把 work_list + item/mget 的响应
 * 摊平成 JSON；这里负责变成台账能直接追加的两条记录（作品 / 快照）。分两半的原因同 B 站：
 * 插件本体必须不联网（AGENTS.md §5），而口径要能被断言管住。
 *
 * 四条口径（踩过的坑，别改回去）：
 * 1. 同一篇作品有两个数据源：列表里的 `statistics`（粗、快、每次列表都带）与详情里的
 *    `metrics`（细、要另发一次 mget）。台账**优先用 `metrics`**，取不到才退回
 *    `statistics` 并记一条 warning——两份混着用会把「详情没取到」记成「数据掉了」。
 * 2. 缺值写 `undefined`（序列化后不出现），**不写 0 冒充**。抖音刚发布的作品、
 *    图集、被限流的作品都可能是 null/空，落成 0 就是把「还没算」写成「没人看」。
 * 3. 抖音的键名**没有一份公开稳定契约**（前端由 prefetch 配置下发，字段随端/版本漂移），
 *    所以每个指标都按候选键名依次回退（`view_count` → `play_count` → `statistics.play_count`）。
 *    取不到就留空，不要硬编码单一键名——2026-11 实测：未登录时 mget 只回空 items，
 *    真实键名要等有 cookie 时才能定稿，回退链是给这份不确定性留的余量。
 * 4. `completion_rate` 是**百分比数值**（38.2 = 38.2%）；`duration` 统一**毫秒**。
 *    上游给 0.382 这种比例时乘 100 并记 warning，别静默改口径。
 * @module dsh-media-ledger/douyin
 */

export const DOUYIN_PLATFORM = 'douyin';
export const DOUYIN_KIND = '视频';
export const DOUYIN_KIND_IMAGE = '图文';

/** 台账认的那五个字段；其余一律进 extras，免得被 buildRows 当成互动数算进去。 */
const SNAPSHOT_KEYS = ['play', 'like', 'comment', 'share', 'collect'];

/**
 * 台账五键 → 候选上游键名（按优先级）。
 * 顺序是有理由的：细粒度（mget 的 metrics）在前，列表粗值（statistics）在后。
 */
const METRIC_CANDIDATES = {
  play: [
    ['metrics', 'view_count'],
    ['metrics', 'play_count'],
    ['statistics', 'play_count'],
    ['statistics', 'view_count'],
    ['view_count'],
  ],
  like: [
    ['metrics', 'like_count'],
    ['metrics', 'digg_count'],
    ['statistics', 'digg_count'],
    ['statistics', 'like_count'],
    ['digg_count'],
  ],
  comment: [
    ['metrics', 'comment_count'],
    ['statistics', 'comment_count'],
    ['comment_count'],
  ],
  share: [
    ['metrics', 'share_count'],
    ['metrics', 'share_forward_count'],
    ['statistics', 'share_count'],
    ['share_count'],
  ],
  collect: [
    ['metrics', 'favorite_count'],
    ['metrics', 'collect_count'],
    ['statistics', 'collect_count'],
    ['statistics', 'favorite_count'],
    ['collect_count'],
  ],
};

/** 只认有限数字；字符串数字（有的端会下发 "1234"）也认；其余当没写。 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** 按候选路径取值，返回 `{ value, from }`；都没有就 `{ value: undefined }`。 */
function lookup(item, candidates) {
  for (const pathKeys of candidates) {
    let cursor = item;
    let ok = true;
    for (const key of pathKeys) {
      if (!cursor || typeof cursor !== 'object' || !(key in cursor)) {
        ok = false;
        break;
      }
      cursor = cursor[key];
    }
    const value = ok ? num(cursor) : undefined;
    if (value !== undefined) return { value, from: pathKeys.join('.') };
  }
  return { value: undefined };
}

/** Unix 秒或毫秒 → `YYYY-MM-DD HH:mm`（本地时区）。0 或非法返回空串。 */
export function tsToLocal(stamp) {
  const seconds = secondsOf(stamp);
  if (seconds === undefined || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 抖音有些接口给毫秒、有些给秒：按量级判断（> 1e11 当毫秒）。 */
export function secondsOf(stamp) {
  const value = num(stamp);
  if (value === undefined || value <= 0) return undefined;
  return value > 1e11 ? Math.round(value / 1000) : Math.round(value);
}

/** 百分比：0.382 → 38.2（并告知调用方「这是按比例算的」）；38.2 原样返回。 */
export function percentOf(value) {
  const parsed = num(value);
  if (parsed === undefined) return { value: undefined, scaled: false };
  if (parsed > 0 && parsed <= 1) return { value: Math.round(parsed * 10000) / 100, scaled: true };
  return { value: Math.round(parsed * 100) / 100, scaled: false };
}

/** 台账快照的五个字段：候选键名依次回退，退回粗值时报一声。 */
function snapshotNumbers(item, warnings, label) {
  const out = {};
  for (const key of SNAPSHOT_KEYS) {
    const { value, from } = lookup(item, METRIC_CANDIDATES[key]);
    if (value === undefined) {
      warnings.push(`${label} 没有 ${key}（五个候选键名都没值），这一项不落盘`);
      continue;
    }
    out[key] = value;
    if (from && from.startsWith('statistics.')) {
      warnings.push(`${label} 的 ${key} 用了列表粗值 ${from}（详情 metrics 没取到）`);
    }
  }
  return out;
}

/** 旁证数据装进 extras：不进复盘口径，但要能查。 */
export function buildExtras(item, warnings, label) {
  const extras = {};
  const detail = {};

  const completion = percentOf(item.metrics && item.metrics.completion_rate);
  if (completion.value !== undefined) {
    detail.completion_rate = completion.value;
    if (completion.scaled) warnings.push(`${label} 的完播率是 0~1 的比例，已按百分比换算`);
  }
  const avgView = num(item.metrics && item.metrics.avg_view_second);
  if (avgView !== undefined) detail.avg_view_second = avgView;
  const duration = num(item.duration);
  if (duration !== undefined) detail.duration_ms = duration > 0 && duration < 1000 ? duration * 1000 : duration;
  const mediaType = num(item.media_type);
  if (mediaType !== undefined) detail.media_type = mediaType;
  const reviewStatus = num(item.review && item.review.status);
  if (reviewStatus !== undefined) detail.review_status = reviewStatus;
  const visibility = num(item.visibility && item.visibility.status);
  if (visibility !== undefined) detail.visibility_status = visibility;

  // 列表粗值单独留一份，方便核对「两处数字不一致」时看到两边原值
  const listed = {};
  const listedPlay = num(item.statistics && item.statistics.play_count);
  if (listedPlay !== undefined) listed.play = listedPlay;
  const listedLike = num(item.statistics && item.statistics.digg_count);
  if (listedLike !== undefined) listed.like = listedLike;
  if (Object.keys(listed).length > 0) detail.listed = listed;

  if (Object.keys(detail).length > 0) extras.douyin = detail;
  return extras;
}

/** 图集还是视频：media_type=2 或有 images 就是图文。 */
export function kindOf(item) {
  const mediaType = num(item.media_type);
  if (mediaType === 2) return DOUYIN_KIND_IMAGE;
  if (Array.isArray(item.images) && item.images.length > 0) return DOUYIN_KIND_IMAGE;
  return DOUYIN_KIND;
}

/** 一条作品记录（还没分配 id，由调用方接 `nextPostId`）。 */
export function toPostRecord(item, account) {
  const formatted = typeof item.published_at === 'string' ? item.published_at.trim() : '';
  const publishedAt = formatted || tsToLocal(item.create_time !== undefined ? item.create_time : item.publish_time);
  const day = typeof item.date === 'string' && item.date.trim() ? item.date.trim() : '';
  const awemeId = typeof item.aweme_id === 'string' ? item.aweme_id.trim() : String(item.aweme_id === undefined ? '' : item.aweme_id);
  const desc = typeof item.desc === 'string' ? item.desc : '';
  // 标题取文案首行：抖音的 desc 里常带换行与 #话题，整段塞进台账会把列表撑烂
  const title = (typeof item.title === 'string' && item.title.trim()) || desc.split('\n')[0].trim();
  const shareUrl = typeof item.share_url === 'string' && item.share_url.trim() ? item.share_url.trim() : '';
  const fallbackPath = kindOf(item) === DOUYIN_KIND_IMAGE ? 'note' : 'video';
  return {
    platform: DOUYIN_PLATFORM,
    account: typeof account === 'string' ? account : '',
    kind: kindOf(item),
    title,
    date: day || (publishedAt ? publishedAt.slice(0, 10) : ''),
    published_at: publishedAt,
    url: shareUrl || (awemeId ? `https://www.douyin.com/${fallbackPath}/${awemeId}` : ''),
    note: '',
    platform_id: awemeId,
  };
}

/** 一条快照记录（id 由调用方填）。 */
export function toMetricRecord(item, options = {}) {
  const awemeId = typeof item.aweme_id === 'string' && item.aweme_id ? item.aweme_id : '(缺 aweme_id)';
  const warnings = [];
  const numbers = snapshotNumbers(item, warnings, awemeId);
  const extras = buildExtras(item, warnings, awemeId);
  const record = {
    captured_at: typeof options.capturedAt === 'string' && options.capturedAt ? options.capturedAt : '',
    ...numbers,
  };
  if (Object.keys(extras).length > 0) record.extras = extras;
  record.source = '抖音接口';
  return { record, warnings, empty: Object.keys(numbers).length === 0 };
}

/** 在台账里找这条作品：先按 platform_id（aweme_id），再退回 url 里含 aweme_id。 */
export function matchPost(posts, awemeId) {
  if (typeof awemeId !== 'string' || !awemeId) return null;
  const byId = posts.find((post) => String(post.platform_id || '') === awemeId);
  if (byId) return byId;
  return posts.find((post) => typeof post.url === 'string' && post.url.includes(awemeId)) || null;
}

/**
 * 把采集脚本产出的 JSON 归一成「作品 + 快照」两批记录。
 * 不做 IO，不抛异常（形状不对就把问题写进 warnings，让调用方决定要不要落盘）。
 */
export function normalizeImport(payload) {
  const warnings = [];
  if (!payload || typeof payload !== 'object') {
    return { account: '', capturedAt: '', rows: [], warnings: ['导入文件不是一个 JSON 对象'] };
  }
  const account = payload.account && typeof payload.account.name === 'string' ? payload.account.name.trim() : '';
  const generatedAt = typeof payload.generated_at === 'string' ? payload.generated_at.trim() : '';
  const posts = Array.isArray(payload.posts) ? payload.posts : [];
  if (posts.length === 0) warnings.push('导入文件里没有 posts');
  if (Array.isArray(payload.warnings)) warnings.push(...payload.warnings);
  if (!account) warnings.push('导入文件没写账号名，作品会归到空账号下');

  const rows = [];
  for (const item of posts) {
    if (!item || typeof item !== 'object') {
      warnings.push('posts 里有一条不是对象，已跳过');
      continue;
    }
    const awemeId = typeof item.aweme_id === 'string' ? item.aweme_id.trim() : '';
    if (!awemeId) {
      warnings.push('有作品没写 aweme_id，已跳过');
      continue;
    }
    const { record, warnings: rowWarnings, empty } = toMetricRecord(item, { capturedAt: generatedAt });
    warnings.push(...rowWarnings);
    if (empty) {
      warnings.push(`${awemeId} 一个数字都没抓到，不落盘`);
      continue;
    }
    rows.push({
      awemeId,
      post: toPostRecord(item, account),
      metric: { ...record, captured_at: record.captured_at || generatedAt },
    });
  }
  return { account, capturedAt: generatedAt, rows, warnings };
}
