/**
 * B站创作中心数据的归一化：**纯函数**，不联网、不读文件、不读环境变量。
 *
 * 抓取在仓库外的脚本里（`scripts/bili_sync.py`），它只负责把接口响应摊平成 JSON；
 * 这里负责把那份 JSON 变成台账能直接追加的两条记录（作品 / 快照）。分成两半的原因：
 * 插件本体必须不联网（见 AGENTS.md §5），而口径是要被断言管住的东西。
 *
 * 四条口径（踩过的坑，别改回去）：
 * 1. 同一页「播放量」有三个数：实时 `view.stat.view`、次日结算 `archive.stat.play`、
 *    结算后去重 `archive.play.view`。台账统一取**实时**那一列，结算值另放进 `extras`，
 *    两条曲线不能混着画。
 * 2. 缺值写 `undefined`（序列化后不出现），**不写 0 冒充**。B站未结算、未算完的指标
 *    一律是 0，直接落盘会把「还没算」写成「没人看」。
 * 3. `play.rate` / `full_play_ratio` 是**平均播放进度**的万分比（4122 = 41.22%），
 *    不是完播率。换算只在 `extras.progress_pct` 里做，别往 play 上凑。
 * 4. `archive.area` 和 `playsource` 都可能是 `null`：播放量小的时候 B站不给，
 *    这不是错误，记一条 warning 就够。
 * @module dsh-media-ledger/bilibili
 */

export const BILI_PLATFORM = 'bilibili';
export const BILI_KIND = '视频';

/** 台账认的那五个字段；其余一律进 extras，免得被 buildRows 当成互动数算进去。 */
const SNAPSHOT_KEYS = ['play', 'like', 'comment', 'share', 'collect'];

/** 万分比 → 百分比（4122 → 41.22）。算不出来返回 null，不猜。 */
export function progressPercent(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
  return Math.round(rate) / 100;
}

/** Unix 秒 → `YYYY-MM-DD HH:mm`（本地时区）。0 或非法返回空串。 */
export function tsToLocal(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 只认有限数字；其余（null / 字符串 / NaN）当没写。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 从对象里挑几个数值字段，挑不到就不放这个键。 */
function pickNumbers(source, mapping) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [to, from] of Object.entries(mapping)) {
    const value = num(source[from]);
    if (value !== undefined) out[to] = value;
  }
  return out;
}

/** 台账快照的五个字段：优先实时口径，实时缺了才用结算值兜底（并记一条 warning）。 */
function snapshotNumbers(item, warnings, bvid) {
  const live = pickNumbers(item.realtime, { play: 'play', like: 'like', comment: 'comment', share: 'share', collect: 'collect' });
  const settled = item.settled && typeof item.settled === 'object' ? item.settled : {};
  const fallback = {
    play: num(settled.play),
    like: num(settled.like),
    comment: num(settled.reply),
    share: num(settled.share),
    collect: num(settled.fav),
  };
  const out = {};
  for (const key of SNAPSHOT_KEYS) {
    if (live[key] !== undefined) {
      out[key] = live[key];
    } else if (fallback[key] !== undefined) {
      out[key] = fallback[key];
      warnings.push(`${bvid} 的 ${key} 没有实时值，用了次日结算值`);
    }
  }
  return out;
}

/** 结算/诊断数据装进 extras：不进复盘口径，但要能查。 */
export function buildExtras(item) {
  const settled = item.settled && typeof item.settled === 'object' ? item.settled : {};
  const diagnose = item.diagnose && typeof item.diagnose === 'object' ? item.diagnose : {};
  const extras = {};

  const settledNumbers = pickNumbers(settled, {
    play_settled: 'play',
    view_dedup: 'view',
    like_settled: 'like',
    fav_settled: 'fav',
    reply_settled: 'reply',
    share_settled: 'share',
    coin: 'coin',
    dm: 'dm',
    elec: 'elec',
    play_fans: 'fans_play',
    play_guest: 'guest_play',
    avg_duration: 'avg_duration',
  });
  const progress = num(settled.progress_rate);
  const progressPct = progressPercent(progress);
  if (progress !== undefined) settledNumbers.progress_rate = progress;
  if (progressPct !== null) settledNumbers.progress_pct = progressPct;
  if (Object.keys(settledNumbers).length > 0) extras.settled = settledNumbers;

  const audience = pickNumbers(diagnose.audience, { fans: 'fans', guest: 'guest' });
  const gender = pickNumbers(diagnose.gender, { male: 'male', female: 'female' });
  const age = pickNumbers(diagnose.age, { age_one: 'age_one', age_two: 'age_two', age_three: 'age_three', age_four: 'age_four' });
  const proportion = {};
  if (diagnose.play_proportion && typeof diagnose.play_proportion === 'object') {
    for (const [key, value] of Object.entries(diagnose.play_proportion)) {
      const parsed = num(value);
      if (parsed !== undefined && parsed > 0) proportion[key] = parsed;
    }
  }
  const diag = {};
  if (Object.keys(audience).length > 0) diag.audience = audience;
  if (Object.keys(gender).length > 0) diag.gender = gender;
  if (Object.keys(age).length > 0) diag.age = age;
  if (Object.keys(proportion).length > 0) diag.play_proportion = proportion;
  if (Array.isArray(diagnose.area) && diagnose.area.length > 0) {
    diag.area = diagnose.area
      .filter((row) => row && typeof row.location === 'string' && typeof row.count === 'number')
      .slice(0, 10)
      .map((row) => ({ location: row.location, count: row.count }));
  }
  if (Array.isArray(diagnose.tags) && diagnose.tags.length > 0) {
    diag.tags = diagnose.tags
      .filter((row) => row && typeof row.name === 'string' && typeof row.count === 'number')
      .slice(0, 10)
      .map((row) => ({ name: row.name, count: row.count }));
  }
  if (Object.keys(diag).length > 0) extras.diagnose = diag;

  return extras;
}

/** 一条作品记录（还没分配 id，由调用方接 `nextPostId`）。 */
export function toPostRecord(item, account) {
  // 采集脚本已经格式化过（`2026-11-13 17:01`）就用它；只有时间戳时自己转。
  const formatted = typeof item.published_at === 'string' ? item.published_at.trim() : '';
  const publishedAt = formatted || tsToLocal(item.pubdate !== undefined ? item.pubdate : item.pubtime);
  const day = typeof item.date === 'string' && item.date.trim() ? item.date.trim() : '';
  return {
    platform: BILI_PLATFORM,
    account: typeof account === 'string' ? account : '',
    kind: BILI_KIND,
    title: typeof item.title === 'string' ? item.title.trim() : '',
    date: day || (publishedAt ? publishedAt.slice(0, 10) : ''),
    published_at: publishedAt,
    url: typeof item.url === 'string' && item.url ? item.url : `https://www.bilibili.com/video/${item.bvid}`,
    note: '',
    platform_id: typeof item.bvid === 'string' ? item.bvid : '',
  };
}

/** 一条快照记录（id 由调用方填）。 */
export function toMetricRecord(item, options = {}) {
  const bvid = typeof item.bvid === 'string' ? item.bvid : '(缺 bvid)';
  const warnings = [];
  const numbers = snapshotNumbers(item, warnings, bvid);
  const extras = buildExtras(item);
  const record = {
    captured_at: typeof options.capturedAt === 'string' && options.capturedAt ? options.capturedAt : '',
    ...numbers,
  };
  if (Object.keys(extras).length > 0) record.extras = extras;
  record.source = 'B站接口';
  return { record, warnings, empty: Object.keys(numbers).length === 0 };
}

/** 在台账里找这条稿件：先按 platform_id（bvid），再退回 url 里含 bvid。 */
export function matchPost(posts, bvid) {
  if (typeof bvid !== 'string' || !bvid) return null;
  const byId = posts.find((post) => String(post.platform_id || '') === bvid);
  if (byId) return byId;
  return posts.find((post) => typeof post.url === 'string' && post.url.includes(bvid)) || null;
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
    const bvid = typeof item.bvid === 'string' ? item.bvid : '';
    if (!bvid) {
      warnings.push('有作品没写 bvid，已跳过');
      continue;
    }
    const { record, warnings: rowWarnings, empty } = toMetricRecord(item, { capturedAt: generatedAt });
    warnings.push(...rowWarnings);
    if (empty) {
      warnings.push(`${bvid} 一个数字都没抓到，不落盘`);
      continue;
    }
    rows.push({
      bvid,
      post: toPostRecord(item, account),
      metric: { ...record, captured_at: record.captured_at || generatedAt },
    });
  }
  return { account, capturedAt: generatedAt, rows, warnings };
}
