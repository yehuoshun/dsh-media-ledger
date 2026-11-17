/**
 * 小红书创作中心数据的归一化：**纯函数**，不联网、不读文件、不读环境变量。
 *
 * 抓取在仓库外的脚本里（`scripts/xhs_sync.py`），它只负责把接口响应摊平成 JSON；
 * 这里负责把那份 JSON 变成台账能直接追加的两条记录（作品 / 快照）。分成两半的原因：
 * 插件本体必须不联网（见 AGENTS.md §5），而口径是要被断言管住的东西。
 *
 * 四条口径（小红书特有，别改回去）：
 * 1. **观看量不是曝光量**：笔记详情/列表里「观看量」是点开过的人次（视频即播放），
 *    「曝光量」是推到信息流的人数，两者差一个量级。`play` 只取观看量，
 *    曝光放 `extras.impressions`；混用会把互动率稀释掉一大半。
 * 2. **图文与视频分开**：一个号两种都发，`kind` 记「图文」/「视频」。
 *    混在一起看中位数，等于把阅读量和播放量平均，没有意义。
 * 3. 缺值写 `undefined`（序列化后不出现），**不写 0 冒充**。新笔记的数据看板
 *    还没算完时接口会给 0 或 null，直接落盘会把「还没算」写成「没人看」。
 * 4. 百分比字段（封面点击率、观看完成率）接口单位不统一，脚本统一换算成
 *    0–100 的百分数放 `extras`；原始值不动，只在这里校验有限性。
 *
 * 采集脚本产出的 JSON 形状（`scripts/xhs_sync.py` 的契约）：
 * ```json
 * {
 *   "platform": "xhs",
 *   "account": { "name": "示例账号", "user_id": "5f…" },
 *   "generated_at": "2026-11-18 01:20",
 *   "source": "creator.xiaohongshu.com note/analyze/list",
 *   "notes": [
 *     {
 *       "note_id": "66c4…",
 *       "title": "标题（小红书 20 字上限）",
 *       "kind": "图文",
 *       "published_at": "2026-11-10 12:00",
 *       "url": "https://www.xiaohongshu.com/explore/66c4…",
 *       "metrics": { "play": 1200, "like": 34, "collect": 12, "comment": 5, "share": 2, "fans": 3 },
 *       "extras": { "impressions": 8000, "cover_click_rate": 31.2 }
 *     }
 *   ],
 *   "warnings": []
 * }
 * ```
 * @module dsh-media-ledger/xiaohongshu
 */

export const XHS_PLATFORM = 'xhs';
export const XHS_KIND_TEXT = '图文';
export const XHS_KIND_VIDEO = '视频';

/** 台账认的快照字段；`fans` 也在里面（小红书列表页直接给「涨粉」），其余进 extras。 */
const SNAPSHOT_KEYS = ['play', 'like', 'comment', 'share', 'collect', 'fans'];

/** extras 里允许透传的数值字段：只收这几个，免得把整个接口响应塞进台账。 */
const EXTRA_KEYS = ['impressions', 'cover_click_rate', 'play_rate', 'view_time', 'follow'];

/** 只认有限数字；其余（null / 字符串 / NaN）当没写。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 从对象里挑几个数值字段，挑不到就不放这个键。 */
function pickNumbers(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) {
    const value = num(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 笔记类型：认「视频」/`video`/数字 2，其余（含缺字段）都按图文处理——图文是默认形态。 */
export function kindOf(note) {
  const raw = note && typeof note === 'object' ? note.kind : '';
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === '视频' || text === 'video') return XHS_KIND_VIDEO;
  if (text === '图文' || text === 'normal' || text === 'image') return XHS_KIND_TEXT;
  if (typeof raw === 'number') return raw === 2 ? XHS_KIND_VIDEO : XHS_KIND_TEXT;
  return XHS_KIND_TEXT;
}

/** 一条作品记录（还没分配 id，由调用方接 `nextPostId`）。 */
export function toPostRecord(note, account) {
  const publishedAt = typeof note.published_at === 'string' ? note.published_at.trim() : '';
  const noteId = typeof note.note_id === 'string' ? note.note_id.trim() : '';
  const url = typeof note.url === 'string' && note.url ? note.url.trim() : '';
  return {
    platform: XHS_PLATFORM,
    account: typeof account === 'string' ? account : '',
    kind: kindOf(note),
    title: typeof note.title === 'string' ? note.title.trim() : '',
    date: publishedAt ? publishedAt.slice(0, 10) : '',
    published_at: publishedAt,
    url: url || (noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : ''),
    note: '',
    platform_id: noteId,
  };
}

/** 一条快照记录（id 由调用方填）。 */
export function toMetricRecord(note, options = {}) {
  const noteId = typeof note.note_id === 'string' ? note.note_id : '(缺 note_id)';
  const warnings = [];
  const numbers = pickNumbers(note.metrics, SNAPSHOT_KEYS);
  const extras = pickNumbers(note.extras, EXTRA_KEYS);

  // 「涨粉」在小红书列表里是字符串（"1,234"）时脚本负责转成数字；
  // 这里见到 0 不当缺值——0 涨粉是有意义的结果。
  if (numbers.play !== undefined && numbers.play < 0) {
    warnings.push(`${noteId} 的观看量是负数（${numbers.play}），已当缺值处理`);
    delete numbers.play;
  }
  if (extras.cover_click_rate !== undefined && (extras.cover_click_rate < 0 || extras.cover_click_rate > 100)) {
    warnings.push(`${noteId} 的封面点击率 ${extras.cover_click_rate} 不在 0–100，单位可能没换算`);
  }
  if (extras.impressions !== undefined && numbers.play !== undefined && extras.impressions < numbers.play) {
    warnings.push(`${noteId} 的曝光量（${extras.impressions}）小于观看量（${numbers.play}），疑似把两个字段取反了`);
  }

  const record = {
    captured_at: typeof options.capturedAt === 'string' && options.capturedAt ? options.capturedAt : '',
    ...numbers,
  };
  if (Object.keys(extras).length > 0) record.extras = extras;
  record.source = '小红书创作中心';
  return { record, warnings, empty: Object.keys(numbers).length === 0 };
}

/** 在台账里找这条笔记：先按 platform_id（note_id），再退回 url 里含 note_id。 */
export function matchPost(posts, noteId) {
  if (typeof noteId !== 'string' || !noteId) return null;
  const byId = posts.find((post) => String(post.platform_id || '') === noteId);
  if (byId) return byId;
  return posts.find((post) => typeof post.url === 'string' && post.url.includes(noteId)) || null;
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
  const notes = Array.isArray(payload.notes) ? payload.notes : [];
  if (notes.length === 0) warnings.push('导入文件里没有 notes');
  if (Array.isArray(payload.warnings)) warnings.push(...payload.warnings);
  if (!account) warnings.push('导入文件没写账号名，笔记会归到空账号下');
  if (payload.platform && payload.platform !== XHS_PLATFORM) {
    warnings.push(`导入文件写的平台是 ${payload.platform}，按小红书处理`);
  }

  const rows = [];
  for (const item of notes) {
    if (!item || typeof item !== 'object') {
      warnings.push('notes 里有一条不是对象，已跳过');
      continue;
    }
    const noteId = typeof item.note_id === 'string' ? item.note_id.trim() : '';
    if (!noteId) {
      warnings.push('有笔记没写 note_id，已跳过');
      continue;
    }
    const { record, warnings: rowWarnings, empty } = toMetricRecord(item, { capturedAt: generatedAt });
    warnings.push(...rowWarnings);
    if (empty) {
      warnings.push(`${noteId} 一个数字都没抓到，不落盘`);
      continue;
    }
    rows.push({
      noteId,
      post: toPostRecord(item, account),
      metric: { ...record, captured_at: record.captured_at || generatedAt },
    });
  }
  return { account, capturedAt: generatedAt, rows, warnings };
}
