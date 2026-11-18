/**
 * 唯一的工具入口：`media`，用 action 分子命令。
 *
 * 为什么不拆成五个工具：每个工具每轮都要进系统提示，一个工具约 150–250 token，
 * 五个就是每天都要为「可能用到」付一次钱。action 分派对模型来说够用。
 * @module dsh-media-ledger/tool
 */

import fs from 'node:fs';
import path from 'node:path';
import { serviceOf, isObject, errorText, toLossless, parseCount } from './util.js';
import { normalizePlatform, PLATFORMS } from './config.js';
import { appendJsonl, loadLedger, nextPostId, resolveDataDir, POSTS_FILE, METRICS_FILE } from './store.js';
import { buildReport, buildRows, parseTs } from './metrics.js';
import { buildPack } from './pack.js';
import * as bili from './bilibili.js';
import * as douyin from './douyin.js';
import * as xhs from './xiaohongshu.js';

const ACTIONS = ['add_post', 'add_metrics', 'list', 'report', 'pack', 'import_bili', 'import_douyin', 'import_xhs'];

/**
 * 各平台的采集导入适配器：`lib/<平台>.js` 暴露同一组纯函数，这里只挑出导入要用的四个。
 * 新增平台照这个形状加一条即可，别再往 `doImport` 里塞 if。
 */
const IMPORTERS = {
  import_bili: {
    label: 'B站',
    platform: bili.BILI_PLATFORM,
    script: 'python scripts/bili_sync.py fetch',
    normalizeImport: bili.normalizeImport,
    matchPost: bili.matchPost,
    idOf: (row) => row.bvid,
  },
  import_douyin: {
    label: '抖音',
    platform: douyin.DOUYIN_PLATFORM,
    script: 'python scripts/douyin_sync.py fetch',
    normalizeImport: douyin.normalizeImport,
    matchPost: douyin.matchPost,
    idOf: (row) => row.awemeId,
  },
  import_xhs: {
    label: '小红书',
    platform: xhs.XHS_PLATFORM,
    script: 'python scripts/xhs_sync.py fetch',
    normalizeImport: xhs.normalizeImport,
    matchPost: xhs.matchPost,
    idOf: (row) => row.noteId,
  },
};

/**
 * 平台 → 导入 action。面板「采集并导入」只知道平台（bilibili / douyin / xhs），落到哪个 action
 * 由这张表翻，别在 bridge.js 里再写一遍 if——两处各写一份，迟早会有一个平台漏掉。
 */
const IMPORT_ACTIONS = Object.fromEntries(
  Object.entries(IMPORTERS).map(([action, importer]) => [importer.platform, action]),
);

const DESCRIPTION = [
  '自媒体作品台账（抖音/小红书/B站/视频号）。',
  'add_post 记一条作品；add_metrics 给某条报一次数（播放/赞/评/转发/收藏）；',
  'list 查台账；report 出复盘（中位数/互动率/评论赞比/龄期）；pack 生成发布包（标题字数、话题、封面尺寸校验）。',
  'import_bili / import_douyin / import_xhs 把采集脚本产出的 JSON 一次灌进台账（created/updated 分开报）。',
  '报数按快照追加，同一作品只取最新一次；数字可以写 2.4w 这种平台显示值。',
].join('');

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: '要做什么',
    },
    platform: {
      type: 'string',
      enum: [...PLATFORMS, '抖音', '小红书', 'B站', '视频号'],
      description: '平台（add_post / pack 必填，list 可选作筛选）',
    },
    // import_* 时这个字段是「覆盖」：采集文件里写的是平台昵称，台账里要的是凭据别名（main），
    // 否则左栏「平台 → 账号」两级树与用户绑定时的名字对不上（面板自动导入就是这么传的）。
    account: { type: 'string', description: '账号名（两个号要分开统计时必须填；import_* 时覆盖采集文件里的账号名）' },
    kind: { type: 'string', description: '作品类型，如 图文tag、视频、口播' },
    title: { type: 'string', description: '作品标题' },
    date: { type: 'string', description: '发布日期 YYYY-MM-DD，默认今天' },
    published_at: { type: 'string', description: '发布时间 YYYY-MM-DD HH:mm，用来算 T+ 龄期' },
    url: { type: 'string', description: '作品链接' },
    note: { type: 'string', description: '备注：打回原因、改了几版等' },
    id: { type: 'string', description: 'add_metrics 必填：作品 id（p0001 这种）' },
    captured_at: { type: 'string', description: '报数时间 YYYY-MM-DD HH:mm，默认当前时间' },
    play: { type: 'string', description: '播放量，可写 2.4w / 1.2万' },
    like: { type: 'string', description: '点赞' },
    comment: { type: 'string', description: '评论' },
    share: { type: 'string', description: '转发' },
    collect: { type: 'string', description: '收藏' },
    fans: { type: 'string', description: '这条带来的涨粉（没有就不填）' },
    source: { type: 'string', description: '数据来源，如 后台导出 / 手抄' },
    body: { type: 'string', description: 'pack：正文或简介' },
    tags: { type: 'array', items: { type: 'string' }, description: 'pack：话题标签，最多 5 个' },
    cover_width: { type: 'number', description: 'pack：封面宽（像素），给了就会校验比例' },
    cover_height: { type: 'number', description: 'pack：封面高（像素）' },
    limit: { type: 'number', description: 'list：返回条数，默认 20' },
    group_by: {
      type: 'string',
      enum: ['kind', 'platform', 'account'],
      description: 'report：分组维度，默认 kind',
    },
    max_age_hours: {
      type: 'number',
      description: 'report：只看 T+ 多少小时以内的数据（不同龄期混比没意义时用）',
    },
    path: {
      type: 'string',
      description: 'import_bili / import_douyin / import_xhs：采集脚本产出的 JSON 路径（scripts/bili_sync.py、scripts/douyin_sync.py 或 scripts/xhs_sync.py fetch 的输出）',
    },
    dry_run: {
      type: 'boolean',
      description: 'import_bili / import_douyin / import_xhs：只算不写，先看看会新建几条、更新几条',
    },
    create_missing: {
      type: 'boolean',
      description: 'import_bili / import_douyin / import_xhs：台账里没有的作品要不要顺手建档，默认 true；给 false 就只更新已有作品',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

function todayStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function todayDate() {
  return todayStamp().slice(0, 10);
}

function requireText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} 不能为空`);
  return text;
}

function requirePlatform(value) {
  const platform = normalizePlatform(value);
  if (!platform) throw new Error('platform 只认 douyin / xhs / bilibili / shipinhao（或中文平台名）');
  return platform;
}

function snapshotFields(args) {
  const out = {};
  for (const key of ['play', 'like', 'comment', 'share', 'collect', 'fans']) {
    if (args[key] === undefined || args[key] === null || args[key] === '') continue;
    const parsed = parseCount(args[key]);
    if (parsed === null) throw new Error(`${key} 看不懂：${args[key]}（可以写 2.4w / 1.2万 / 3456）`);
    out[key] = parsed;
  }
  return out;
}

function doAddPost(config, args) {
  const dir = resolveDataDir(config);
  const platform = requirePlatform(args.platform);
  const title = requireText(args.title, 'title');
  const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : todayDate();
  if (parseTs(date) === null) throw new Error('date 要写 YYYY-MM-DD');
  if (args.published_at && parseTs(args.published_at) === null) {
    throw new Error('published_at 要写 YYYY-MM-DD 或 YYYY-MM-DD HH:mm');
  }

  const { posts, errors } = loadLedger(dir);
  const record = {
    id: nextPostId(posts),
    platform,
    account: typeof args.account === 'string' ? args.account.trim() : '',
    kind: typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : '未分类',
    title,
    date,
    published_at: args.published_at || '',
    url: typeof args.url === 'string' ? args.url.trim() : '',
    note: typeof args.note === 'string' ? args.note.trim() : '',
  };
  appendJsonl(dir, POSTS_FILE, record);
  return {
    ok: true,
    added: record,
    file: `${dir}\\${POSTS_FILE}`,
    warnings: errors.length > 0 ? [`读既有台账时有 ${errors.length} 行解析失败，已忽略`] : [],
  };
}

function doAddMetrics(config, args) {
  const dir = resolveDataDir(config);
  const id = requireText(args.id, 'id');
  const { posts, errors } = loadLedger(dir);
  const post = posts.find((item) => String(item.id) === id);
  if (!post) throw new Error(`没有 id=${id} 的作品，先用 action=add_post 记作品（或 action=list 查 id）`);

  const capturedAt = typeof args.captured_at === 'string' && args.captured_at.trim()
    ? args.captured_at.trim()
    : todayStamp();
  if (parseTs(capturedAt) === null) throw new Error('captured_at 要写 YYYY-MM-DD 或 YYYY-MM-DD HH:mm');

  const record = {
    id,
    captured_at: capturedAt,
    ...snapshotFields(args),
    source: typeof args.source === 'string' && args.source.trim() ? args.source.trim() : '',
  };
  if (Object.keys(snapshotFields(args)).length === 0) throw new Error('至少要报一个数字（play/like/comment/share/collect/fans）');
  appendJsonl(dir, METRICS_FILE, record);

  const warnings = [];
  if (errors.length > 0) warnings.push(`读既有台账时有 ${errors.length} 行解析失败，已忽略`);
  if (!post.published_at) warnings.push('这条作品没写 published_at，复盘时算不出 T+ 龄期');
  return { ok: true, added: record, post: { id: post.id, title: post.title }, file: `${dir}\\${METRICS_FILE}`, warnings };
}

function doList(config, args) {
  const dir = resolveDataDir(config);
  const { posts, errors } = loadLedger(dir);
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
  const platform = args.platform ? requirePlatform(args.platform) : null;
  const filtered = platform ? posts.filter((post) => normalizePlatform(post.platform) === platform) : posts;
  const ordered = [...filtered].sort((a, b) => {
    const left = parseTs(a.date) || 0;
    const right = parseTs(b.date) || 0;
    return right - left;
  });
  return {
    ok: true,
    total: filtered.length,
    shown: Math.min(limit, ordered.length),
    posts: ordered.slice(0, limit).map((post) => ({
      id: post.id,
      date: post.date,
      platform: post.platform,
      account: post.account || '',
      kind: post.kind || '',
      title: post.title || '',
      published_at: post.published_at || '',
    })),
    warnings: errors.length > 0 ? [`${errors.length} 行解析失败`] : [],
  };
}

function doReport(config, args) {
  const dir = resolveDataDir(config);
  const { posts, metrics, errors } = loadLedger(dir);
  let rows = buildRows(posts, metrics);
  const warnings = errors.length > 0 ? [`读台账时有 ${errors.length} 行解析失败，已忽略`] : [];

  if (typeof args.max_age_hours === 'number' && args.max_age_hours > 0) {
    const keep = (row) => typeof row.tPlusHours === 'number' && row.tPlusHours <= args.max_age_hours;
    const filtered = rows.filter(keep);
    if (filtered.length === 0) {
      return {
        ok: false,
        error: `T+ ${args.max_age_hours} 小时以内的快照一条都没有（要么没写 published_at，要么报数都太晚）`,
        rows: rows.length,
      };
    }
    rows = filtered;
  }

  const report = buildReport(rows, { groupBy: args.group_by });
  return { ok: true, ...report, warnings: [...warnings, ...report.warnings], dir };
}

function doPack(config, args) {
  const pack = buildPack(
    {
      platform: args.platform,
      title: args.title,
      body: args.body,
      tags: args.tags,
      cover: typeof args.cover_width === 'number' && typeof args.cover_height === 'number'
        ? { width: args.cover_width, height: args.cover_height }
        : null,
    },
    config,
  );
  return { ok: true, ...pack, failures: pack.checks.filter((check) => !check.ok).length };
}

/**
 * 把采集脚本的产出灌进台账（各平台共用一条实现，差异全在 `IMPORTERS` 里的纯函数）。
 *
 * 为什么不在这里联网：插件本体必须不联网（AGENTS.md §5），抓取在 `scripts/*_sync.py`。
 * 这里的职责只有「读文件 → 归一 → 追加」，归一的口径全在 `lib/<平台>.js`（纯函数，有用例）。
 */
function doImport(config, args, importer) {
  const dir = resolveDataDir(config);
  const file = path.resolve(requireText(args.path, 'path'));
  if (!fs.existsSync(file)) {
    throw new Error(`找不到导入文件：${file}（先跑 ${importer.script} 生成）`);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`导入文件不是合法 JSON：${errorText(error)}`);
  }

  const { account, capturedAt, rows, warnings } = importer.normalizeImport(payload);
  // 面板「采集并导入」跑完脚本会带 account=凭据别名（如 main）进来：采集文件里写的是平台昵称，
  // 台账里必须用别名，左栏「平台 → 账号」才对得上用户绑定时的那个名字。手动导入不带就保持原口径。
  const override = typeof args.account === 'string' ? args.account.trim() : '';
  if (override) {
    if (account && account !== override) warnings.push(`账号名已按凭据别名覆盖为 "${override}"（采集文件里是 "${account}"）`);
    else if (!account) warnings.push(`采集文件没写账号名，已按凭据别名填成 "${override}"`);
  }
  if (rows.length === 0) {
    return { ok: false, error: `导入文件里没有能落盘的${importer.label}作品`, warnings };
  }

  const dryRun = args.dry_run === true;
  const createMissing = args.create_missing !== false;
  const { posts, errors } = loadLedger(dir);
  if (errors.length > 0) warnings.push(`读既有台账时有 ${errors.length} 行解析失败，已忽略`);

  // 现存作品先全部装进来，新建时才能接着 p0001 往后排号
  const known = [...posts];
  const createdAt = parseTs(capturedAt) === null ? todayStamp() : capturedAt;
  if (parseTs(capturedAt) === null) warnings.push(`采集时间 "${capturedAt}" 读不懂，快照时间用了当前时间`);

  const created = [];
  const updated = [];
  const skipped = [];
  for (const row of rows) {
    const platformId = importer.idOf(row);
    let post = importer.matchPost(known, platformId);
    if (!post) {
      if (!createMissing) {
        skipped.push(platformId);
        continue;
      }
      post = { id: nextPostId(known), ...row.post };
      // 覆盖要在 appendJsonl 之前：台账 append-only，写下去就不再回改（改既有记录属于另一件事）
      if (override) post.account = override;
      known.push(post);
      created.push({ id: post.id, platformId, title: post.title });
      if (!dryRun) appendJsonl(dir, POSTS_FILE, post);
    }
    const metric = { id: post.id, ...row.metric, captured_at: row.metric.captured_at || createdAt };
    if (parseTs(metric.captured_at) === null) metric.captured_at = createdAt;
    if (!dryRun) appendJsonl(dir, METRICS_FILE, metric);
    updated.push({
      id: post.id,
      platformId,
      play: typeof metric.play === 'number' ? metric.play : null,
      isNew: created.some((item) => item.id === post.id),
    });
  }

  return {
    ok: true,
    platform: importer.platform,
    dryRun,
    account: override || account || '(未写账号)',
    capturedAt: createdAt,
    createdCount: created.length,
    updatedCount: updated.length,
    created,
    updated,
    skipped,
    file: `${dir}\\${METRICS_FILE}`,
    warnings,
  };
}

/**
 * 面板用的导入入口：按平台选同一个 importer，再走 `doImport` 的全部口径（归一 → 匹配 → 追加）。
 *
 * 存在的理由只有一个：Host 跑完采集脚本要把产出灌进台账，而台账的写入口径（matchPost /
 * nextPostId / appendJsonl）已经在这份文件里了——**不许在 bridge.js 里重写一遍**，否则手动
 * 导入与面板自动导入迟早说两种话。错误不抛：面板路由一律回 `{ ok:false, code, error }`。
 */
export function importCollectorOutput(config, options = {}) {
  const raw = typeof options.platform === 'string' ? options.platform.trim() : '';
  const platform = normalizePlatform(raw) || raw;
  const action = IMPORT_ACTIONS[platform];
  if (!action) return { ok: false, code: 'bad-platform', error: `不认识的平台：${raw || '（空）'}` };
  const file = typeof options.path === 'string' ? options.path.trim() : '';
  if (!file) return { ok: false, code: 'no-file', error: '采集产出路径为空' };
  try {
    return doImport(config, { path: file, account: options.account }, IMPORTERS[action]);
  } catch (error) {
    return { ok: false, code: 'import-failed', error: errorText(error) };
  }
}

/**
 * 注册工具，返回回收函数列表。宿主没有 tools 服务时返回空数组（插件静默不激活）。
 */
export function registerTools(ctx, config) {
  const tools = serviceOf(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') return [];

  const dispose = tools.register({
    name: 'media',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (isObject(value) && typeof value.text === 'string') {
          const lines = value.checks && value.checks.length > 0
            ? value.checks.map((check) => `${check.ok ? '✓' : '⚠'} ${check.label}：${check.detail}`)
            : [];
          return [{ type: 'text', text: [value.text, '', ...lines].join('\n') }];
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args) {
      const action = typeof args.action === 'string' ? args.action : '';
      if (!ACTIONS.includes(action)) return toLossless({ ok: false, error: `action 只支持 ${ACTIONS.join(' / ')}` });
      try {
        switch (action) {
          case 'add_post':
            return toLossless(doAddPost(config, args));
          case 'add_metrics':
            return toLossless(doAddMetrics(config, args));
          case 'list':
            return toLossless(doList(config, args));
          case 'report':
            return toLossless(doReport(config, args));
          case 'pack':
            return toLossless(doPack(config, args));
          case 'import_bili':
          case 'import_douyin':
          case 'import_xhs':
            return toLossless(doImport(config, args, IMPORTERS[action]));
          default:
            return toLossless({ ok: false, error: `未知 action：${action}` });
        }
      } catch (error) {
        return toLossless({ ok: false, error: errorText(error) });
      }
    },
  });

  return [dispose];
}
