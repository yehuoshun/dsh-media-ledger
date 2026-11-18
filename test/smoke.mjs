/**
 * 冒烟测试：不装插件、不开界面，直接把 lib/ 的纯函数跑一遍。
 *
 * 用法（不需要装 Node，借宿主的 Electron 当 Node 用）：
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\smoke.mjs"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildRows, buildReport, parseTs, latestSnapshots, median, interaction } from '../lib/metrics.js';
import { buildPack } from '../lib/pack.js';
import { parseCount, toLossless } from '../lib/util.js';
import { normalizePlatform } from '../lib/config.js';
import { appendJsonl, findWorkspaceRoot, loadLedger, nextPostId, resolveDataDir, POSTS_FILE, METRICS_FILE } from '../lib/store.js';
import { buildPanel, parseSlice, platformList, POST_LIMIT } from '../lib/panel.js';
import { describeBindings, formatSavedAt, parseCredentialName, bindingSteps } from '../lib/bindings.js';
import { matchPost, normalizeImport, progressPercent, tsToLocal } from '../lib/bilibili.js';
import { kindOf, matchPost as matchXhsPost, normalizeImport as normalizeXhsImport, toPostRecord as toXhsPost } from '../lib/xiaohongshu.js';
import { matchPost as dyMatchPost, normalizeImport as dyNormalize, percentOf, secondsOf } from '../lib/douyin.js';
import { BRIDGE_PREFIX, listCredentialFiles, makeBridgeRoutes, readPanel, sidebarEnabled } from '../lib/bridge.js';
import { LOGIN_TIMEOUT_MS, LOGIN_TARGETS, buildLoginPlan, describeLoginState, extractQrPath, filterLoginLog, sanitizeAccount } from '../lib/login.js';

const dir = path.join(os.tmpdir(), `ml-smoke-${Date.now()}`);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
  } else {
    fails.push(`${name}${detail ? ` → ${detail}` : ''}`);
  }
}

// —— 数字解析：平台显示值要能直接进台账 ——
check('parseCount 2.4w', parseCount('2.4w') === 24000, String(parseCount('2.4w')));
check('parseCount 1.2万', parseCount('1.2万') === 12000);
check('parseCount 3,456', parseCount('3,456') === 3456);
check('parseCount 12k', parseCount('12k') === 12000);
check('parseCount 空 → null', parseCount('') === null);
check('parseCount 垃圾 → null', parseCount('很多') === null);

// —— 时间解析：字符串比大小会出错的几种写法 ——
check('parseTs 日期', parseTs('2026-11-14') === new Date(2026, 10, 14).getTime());
check('parseTs 空格时间', parseTs('2026-11-14 20:30') === new Date(2026, 10, 14, 20, 30).getTime());
check('parseTs T 分隔', parseTs('2026-11-14T20:30:00') === new Date(2026, 10, 14, 20, 30).getTime());
check('parseTs 斜杠', parseTs('2026/11/14') === new Date(2026, 10, 14).getTime());
check('parseTs 垃圾 → null', parseTs('11月14日晚上8点') === null);

const snaps = [
  { id: 'p0001', captured_at: '2026-11-17T09:00', play: 100 },
  { id: 'p0001', captured_at: '2026-11-17 18:00', play: 900 },
];
check('快照按真时间取最新', latestSnapshots(snaps).get('p0001').play === 900, JSON.stringify(latestSnapshots(snaps).get('p0001')));
check('非补零日期不压过', latestSnapshots([
  { id: 'x', captured_at: '2026-9-5', play: 1 },
  { id: 'x', captured_at: '2026-11-15', play: 2 },
]).get('x').play === 2);

check('median 奇数', median([1, 2, 3]) === 2);
check('median 偶数取中位', median([1, 2, 3, 4]) === 2.5);
check('median 空 → null', median([]) === null);

// —— 复盘口径 ——
const posts = [
  { id: 'p0001', platform: 'douyin', account: 'A', kind: '图文tag', title: 't1', date: '2026-11-12', published_at: '2026-11-12 10:00' },
  { id: 'p0002', platform: 'douyin', account: 'A', kind: '图文tag', title: 't2', date: '2026-11-13', published_at: '2026-11-13 10:00' },
];
const metrics = [
  { id: 'p0001', captured_at: '2026-11-12 11:00', play: 24000, like: 46, comment: 79, share: 2, collect: 9 },
  { id: 'p0001', captured_at: '2026-11-19 10:00', play: 30000, like: 60, comment: 90, share: 3, collect: 12 },
  { id: 'p0002', captured_at: '2026-11-13 20:00', like: 100 },   // 只报赞没报播放
  { id: 'p0002', captured_at: '2026-11-14 20:00', play: 9000, like: 200, comment: 130, share: 1, collect: 4 },
];
const rows = buildRows(posts, metrics);
check('rows 取最新快照', rows[0].play === 30000, String(rows[0].play));
check('rows 算 T+', rows[0].tPlusHours === 168, String(rows[0].tPlusHours));
check('rows 没数的作品也保留', buildRows([{ id: 'p9', platform: 'xhs' }], []).length === 1);

const rate = interaction(rows);
check('互动率不是 10050%', rate !== null && rate < 100, String(rate));
check('互动率分子分母同批', rate === Math.round(((60 + 90 + 3 + 12 + 200 + 130 + 1 + 4) / (30000 + 9000)) * 10000) / 100, String(rate));

const report = buildReport(rows, { groupBy: 'kind' });
check('分组按 kind', report.groups.length === 1 && report.groups[0].key === '图文tag');
check('龄期跨度给警告', report.warnings.some((w) => w.includes('龄期跨度')), JSON.stringify(report.warnings));

// p0002 是 T+34h，p0001 是 T+168h：只留 48h 内应该剩 1 条
const young = buildRows(posts, metrics).filter((r) => typeof r.tPlusHours === 'number' && r.tPlusHours <= 48);
check('maxAgeHours 过滤生效', young.length === 1 && young[0].id === 'p0002', JSON.stringify(young.map((r) => [r.id, r.tPlusHours])));

// —— 发布包 ——
const pack = buildPack({ platform: '小红书', title: '五盾军团23人穿7号致敬C罗这可能是今年最像冠军的一届', tags: ['#C罗', 'c罗', '足球', '世界杯', '冠军', '多余'], cover: { width: 1080, height: 1920 } });
check('pack 归一平台', pack.platform === 'xhs');
check('pack 标题超限告警', pack.checks.some((c) => c.label === '标题字数' && !c.ok));
check('pack 标签去重并截断到 5', pack.tags.length === 5, JSON.stringify(pack.tags));
check('pack 封面比例不符告警', pack.checks.some((c) => c.label === '封面比例' && !c.ok));
check('pack 文本含平台名', pack.text.includes('小红书 发布包'));

check('normalizePlatform 中文', normalizePlatform('抖音') === 'douyin' && normalizePlatform('B站') === 'bilibili');

// —— 落盘 ——
appendJsonl(dir, POSTS_FILE, { id: 'p0001', platform: 'douyin', title: 'a' });
appendJsonl(dir, METRICS_FILE, { id: 'p0001', captured_at: '2026-11-14 10:00', play: 100 });
fs.appendFileSync(path.join(dir, METRICS_FILE), '{坏行\n', 'utf8');
const loaded = loadLedger(dir);
check('JSONL 读回', loaded.posts.length === 1 && loaded.metrics.length === 1);
check('坏行给行号', loaded.errors.length === 1 && loaded.errors[0].line === 2, JSON.stringify(loaded.errors));

fs.writeFileSync(path.join(dir, POSTS_FILE), `\uFEFF${JSON.stringify({ id: 'p0001' })}\n${JSON.stringify({ id: 'p0002' })}\n`, 'utf8');
check('BOM 能读', loadLedger(dir).posts.length === 2);

fs.writeFileSync(path.join(dir, POSTS_FILE), `${JSON.stringify({ id: 'p0001' })}\n${JSON.stringify({ id: 'p0001' })}\n`, 'utf8');
let dupError = '';
try {
  loadLedger(dir);
} catch (error) {
  dupError = String(error.message);
}
check('重复 id 报错', dupError.includes('重复'), dupError);

check('nextPostId 接最大号', nextPostId([{ id: 'p0009' }, { id: 'p0002' }]) === 'p0010');
check('toLossless 清 undefined', JSON.stringify(toLossless({ a: undefined, b: 1, c: NaN, d: [undefined, 2] })) === '{"b":1,"c":null,"d":[null,2]}');

// —— B站导入：实时口径优先、缺值不写 0、结算值进 extras ——
check('万分比换百分比', progressPercent(4122) === 41.22 && progressPercent(null) === null, String(progressPercent(4122)));
const mockLocal = tsToLocal(1794560515);
check('时间戳转本地时间', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(mockLocal) && parseTs(mockLocal) !== null, mockLocal);
check('时间戳 0 不猜', tsToLocal(0) === '');

const mockImport = {
  generated_at: '2026-11-18 00:40',
  account: { mid: 10001, name: 'mock-main', level: 6 },
  posts: [
    {
      bvid: 'BVmock000001',
      title: 'mock 有实时口径的稿子',
      pubdate: 1794560515,
      duration: 48,
      realtime: { play: 32, like: 1, comment: 1, share: 0, collect: 1 },
      settled: { play: 28, view: 25, like: 2, fav: 1, reply: 1, share: 0, coin: 0, dm: 0, fans_play: 3, guest_play: 25, progress_rate: 4122, avg_duration: 19 },
      diagnose: {
        gender: { male: 8, female: 0 },
        age: { age_one: 1, age_two: 7, age_three: 5, age_four: 2 },
        area: null,
        tags: [{ name: 'mock标签', count: 2105 }],
        play_proportion: { new_mobile: 24, new_pc: 4 },
        audience: { fans: 3, guest: 25 },
      },
    },
    {
      bvid: 'BVmock000002',
      title: 'mock 只有结算口径的稿子',
      pubdate: 1794560515,
      settled: { play: 7, view: 6, like: 1, fav: 0, reply: 0, share: 0 },
      diagnose: { area: [{ location: 'mock省', count: 2 }] },
    },
    { bvid: '', title: 'mock 没 bvid 的脏数据' },
    { bvid: 'BVmock000003', title: 'mock 一个数都没有' },
  ],
  warnings: ['上游提醒：某接口返回 null'],
};
const mockNormalized = normalizeImport(mockImport);
check('导入按 bvid 过滤脏数据', mockNormalized.rows.length === 2, String(mockNormalized.rows.length));
check('导入带出账号名', mockNormalized.account === 'mock-main');
const mockFirst = mockNormalized.rows[0];
check('快照取实时口径而不是结算值', mockFirst.metric.play === 32, String(mockFirst.metric.play));
check('结算值进 extras 不进 play', mockFirst.metric.extras.settled.play_settled === 28 && mockFirst.metric.extras.settled.view_dedup === 25);
check('万分比换成本地百分比', mockFirst.metric.extras.settled.progress_pct === 41.22, String(mockFirst.metric.extras.settled.progress_pct));
check('area 为 null 不崩', mockFirst.metric.extras.diagnose.area === undefined);
const mockSecond = mockNormalized.rows[1].metric;
check('缺值不写 0（没给的字段不出现）', !('elec' in mockSecond.extras.settled) && !('progress_pct' in mockSecond.extras.settled), JSON.stringify(mockSecond.extras));
check('B站给了 0 就照实记 0', mockSecond.collect === 0 && mockSecond.comment === 0, JSON.stringify(mockSecond));
check('缺实时口径要告警', mockNormalized.warnings.some((line) => line.includes('BVmock000002') && line.includes('结算值')), JSON.stringify(mockNormalized.warnings));
check('上游 warnings 透传', mockNormalized.warnings.some((line) => line.includes('上游提醒')));
check('作品记录带 platform_id 与 bilibili 平台', mockFirst.post.platform_id === 'BVmock000001' && mockFirst.post.platform === 'bilibili');
check('空导入不抛异常', normalizeImport(null).rows.length === 0 && normalizeImport({}).warnings.length > 0);

// 采集脚本产出的是格式化好的时间字符串（不是 pubdate 时间戳），两种都要吃得下
const mockPreformatted = normalizeImport({
  generated_at: '2026-11-18 00:40',
  account: { name: 'mock-main' },
  posts: [{ bvid: 'BVmock000004', title: 'mock 采集脚本格式', published_at: '2026-11-13 17:01', date: '2026-11-13', realtime: { play: 5 } }],
}).rows[0].post;
check('采集脚本格式的时间直接用', mockPreformatted.published_at === '2026-11-13 17:01' && mockPreformatted.date === '2026-11-13', JSON.stringify([mockPreformatted.published_at, mockPreformatted.date]));
check('时间戳也能换成同一格式', mockFirst.post.published_at === tsToLocal(1794560515) && mockFirst.post.date === tsToLocal(1794560515).slice(0, 10), mockFirst.post.published_at);

const mockPosts = [
  { id: 'p0001', platform: 'bilibili', url: 'https://www.bilibili.com/video/BVmock000001' },
  { id: 'p0002', platform: 'bilibili', platform_id: 'BVmock000002', url: 'https://example.invalid/elsewhere' },
];
check('按 bvid 匹配已有作品（url 兜底）', matchPost(mockPosts, 'BVmock000001').id === 'p0001');
check('按 platform_id 优先匹配', matchPost(mockPosts, 'BVmock000002').id === 'p0002');
check('匹配不到返回 null', matchPost(mockPosts, 'BVmock999999') === null);

// —— 小红书导入：观看量不是曝光量、图文视频分开、缺值不写 0 ——
const mockXhsImport = {
  platform: 'xhs',
  account: { name: 'mock-xhs' },
  generated_at: '2026-11-18 01:20',
  notes: [
    {
      note_id: 'mocknote0001',
      title: 'mock 图文笔记',
      kind: '图文',
      published_at: '2026-11-10 12:00',
      metrics: { play: 1200, like: 34, collect: 12, comment: 5, share: 2, fans: 3 },
      extras: { impressions: 8000, cover_click_rate: 31.2 },
    },
    { note_id: 'mocknote0002', title: 'mock 视频笔记', kind: '视频', metrics: { play: 0, like: 0 }, extras: { impressions: 3 } },
    { note_id: 'mocknote0003', title: 'mock 曝光比观看小', metrics: { play: 900 }, extras: { impressions: 100 } },
    { note_id: 'mocknote0004', title: 'mock 负数观看', metrics: { play: -5, like: 1 }, extras: { cover_click_rate: 320 } },
    { note_id: 'mocknote0005', title: 'mock 一个数都没有', metrics: {} },
    { title: 'mock 没 note_id 的脏数据' },
  ],
  warnings: ['上游提醒：某接口返回 null'],
};
const mockXhs = normalizeXhsImport(mockXhsImport);
check('小红书导入按 note_id 过滤脏数据', mockXhs.rows.length === 4, String(mockXhs.rows.length));
check('小红书导入带出账号名', mockXhs.account === 'mock-xhs');
const xhsFirst = mockXhs.rows[0];
check('小红书观看量进 play、涨粉进 fans', xhsFirst.metric.play === 1200 && xhsFirst.metric.fans === 3, JSON.stringify(xhsFirst.metric));
check('小红书曝光量只进 extras', xhsFirst.metric.extras.impressions === 8000 && xhsFirst.metric.extras.cover_click_rate === 31.2, JSON.stringify(xhsFirst.metric.extras));
check('小红书快照标出来源', xhsFirst.metric.source === '小红书创作中心' && xhsFirst.metric.captured_at === '2026-11-18 01:20');
check('小红书作品记录平台/类型/时间；合成 id 不拼假链接', xhsFirst.post.platform === 'xhs' && xhsFirst.post.kind === '图文'
  && xhsFirst.post.platform_id === 'mocknote0001' && xhsFirst.post.date === '2026-11-10'
  && xhsFirst.post.url === '', JSON.stringify(xhsFirst.post));
check('真笔记 id（24 位十六进制）才拼 explore 链接', toXhsPost({ note_id: 'deadbeefdeadbeefdeadbeef' }, 'mock').url
  === 'https://www.xiaohongshu.com/explore/deadbeefdeadbeefdeadbeef');
const xhsVideo = mockXhs.rows[1];
check('小红书视频与图文分开记 kind', xhsVideo.post.kind === '视频' && kindOf({ kind: 'video' }) === '视频' && kindOf({}) === '图文', xhsVideo.post.kind);
check('小红书给了 0 就照实记 0', xhsVideo.metric.play === 0 && xhsVideo.metric.like === 0, JSON.stringify(xhsVideo.metric));
check('曝光量比观看量小要告警', mockXhs.warnings.some((line) => line.includes('mocknote0003') && line.includes('曝光量')), JSON.stringify(mockXhs.warnings));
check('负数观看量当缺值并告警', !('play' in mockXhs.rows[3].metric) && mockXhs.warnings.some((line) => line.includes('mocknote0004') && line.includes('负数')), JSON.stringify(mockXhs.rows[3].metric));
check('封面点击率超 100 要告警', mockXhs.warnings.some((line) => line.includes('封面点击率')), JSON.stringify(mockXhs.warnings));
check('小红书上游 warnings 透传', mockXhs.warnings.some((line) => line.includes('上游提醒')));
check('小红书一个数字都没有的不落盘', mockXhs.warnings.some((line) => line.includes('一个数字都没抓到')));
check('小红书空导入不抛异常', normalizeXhsImport(null).rows.length === 0 && normalizeXhsImport({}).warnings.length > 0);
const xhsPosts = [
  { id: 'p0001', platform: 'xhs', url: 'https://www.xiaohongshu.com/explore/mocknote0001' },
  { id: 'p0002', platform: 'xhs', platform_id: 'mocknote0002', url: 'https://example.invalid/elsewhere' },
];
check('小红书按 note_id 匹配已有作品（url 兜底）', matchXhsPost(xhsPosts, 'mocknote0001').id === 'p0001');
check('小红书按 platform_id 优先匹配', matchXhsPost(xhsPosts, 'mocknote0002').id === 'p0002');
check('小红书匹配不到返回 null', matchXhsPost(xhsPosts, 'mocknote9999') === null);
// —— 抖音导入：键名候选回退、缺值不写 0、图集识别、秒/毫秒都吃 ——
const mockDouyin = {
  generated_at: '2026-11-18 09:00',
  account: { uid: 'mock-uid', name: 'mock-douyin' },
  posts: [
    {
      aweme_id: '7300000000000000001',
      desc: 'mock 详情有 metrics 的作品\n#mock话题',
      create_time: 1794560515,
      media_type: 0,
      duration: 12345,
      metrics: { view_count: 1200, like_count: 33, comment_count: 2, share_count: 4, favorite_count: 5, completion_rate: 0.382, avg_view_second: 7.3 },
      statistics: { play_count: 1180, digg_count: 30 },
      review: { status: 2 },
      visibility: { status: 0 },
    },
    {
      aweme_id: '7300000000000000002',
      desc: 'mock 只有列表粗值的图集',
      create_time: 1794560515000,
      media_type: 2,
      statistics: { play_count: 90, digg_count: 1 },
    },
    { aweme_id: '', desc: 'mock 没 aweme_id 的脏数据' },
    { aweme_id: '7300000000000000003', desc: 'mock 一个数都没有' },
  ],
  warnings: ['上游提醒：详情接口超时'],
};
const mockDy = dyNormalize(mockDouyin);
check('抖音导入过滤脏数据', mockDy.rows.length === 2, String(mockDy.rows.length));
const mockDyFirst = mockDy.rows[0];
check('抖音快照优先用详情 metrics', mockDyFirst.metric.play === 1200 && mockDyFirst.metric.like === 33, JSON.stringify([mockDyFirst.metric.play, mockDyFirst.metric.like]));
check('抖音列表粗值只进 extras', mockDyFirst.metric.extras.douyin.listed.play === 1180);
const mockDySecond = mockDy.rows[1].metric;
check('抖音详情缺了就用列表粗值并告警', mockDySecond.play === 90 && mockDy.warnings.some((line) => line.includes('7300000000000000002') && line.includes('statistics.')), JSON.stringify(mockDy.warnings));
check('抖音缺值不写 0', !('collect' in mockDySecond) && !('comment' in mockDySecond), JSON.stringify(mockDySecond));
check('抖音比例型完播率换算成百分比', mockDyFirst.metric.extras.douyin.completion_rate === 38.2, String(mockDyFirst.metric.extras.douyin.completion_rate));
check('抖音图集认成图文', mockDy.rows[1].post.kind === '图文' && mockDyFirst.post.kind === '视频');
check('抖音毫秒时间戳也认', mockDy.rows[1].post.published_at === tsToLocal(1794560515), mockDy.rows[1].post.published_at);
check('抖音标题取文案首行', mockDyFirst.post.title === 'mock 详情有 metrics 的作品', mockDyFirst.post.title);
check('抖音作品记录带 douyin 平台与 aweme_id', mockDyFirst.post.platform === 'douyin' && mockDyFirst.post.platform_id === '7300000000000000001');
check('抖音作品的 url 兜底到分享页', mockDyFirst.post.url === 'https://www.douyin.com/video/7300000000000000001', mockDyFirst.post.url);
check('抖音空导入不抛异常', dyNormalize(null).rows.length === 0 && dyNormalize({}).warnings.length > 0);
check('百分比换算工具两种输入都认', percentOf(38.2).value === 38.2 && percentOf(0.382).scaled === true && percentOf(null).value === undefined);
check('秒/毫秒时间戳都能归一', secondsOf(1794560515) === 1794560515 && secondsOf(1794560515000) === 1794560515);

const mockDyPosts = [
  { id: 'p0009', platform: 'douyin', url: 'https://www.douyin.com/video/7300000000000000001' },
  { id: 'p0010', platform: 'douyin', platform_id: '7300000000000000002', url: 'https://example.invalid/elsewhere' },
];
check('抖音按 platform_id 优先匹配', dyMatchPost(mockDyPosts, '7300000000000000002').id === 'p0010');
check('抖音 url 兜底匹配', dyMatchPost(mockDyPosts, '7300000000000000001').id === 'p0009');
check('抖音匹配不到返回 null', dyMatchPost(mockDyPosts, '7300000000000000999') === null);

// —— 面板数据：整形只搬运口径，不另算一套 ——
const panelPosts = [
  { id: 'p0001', platform: 'douyin', account: 'mock-main', kind: '图文tag', title: 'mock 旧作品', date: '2026-11-10', published_at: '2026-11-10 20:00' },
  { id: 'p0002', platform: 'xhs', account: 'mock-main', kind: '视频', title: 'mock 新作品', date: '2026-11-14', published_at: '2026-11-14 20:00' },
];
const panelMetrics = [
  { id: 'p0001', captured_at: '2026-11-11 10:00', play: 1000, like: 10, comment: 1, share: 1, collect: 1 },
  { id: 'p0002', captured_at: '2026-11-15 08:00', play: 24000, like: 46, comment: 3, share: 2, collect: 5 },
];
const panelRows = buildRows(panelPosts, panelMetrics);
const panel = buildPanel(panelRows, { groupBy: 'kind' });
check('面板列表日期新的在前', panel.posts[0].id === 'p0002' && panel.posts[1].id === 'p0001', panel.posts.map((p) => p.id).join(','));
check('面板行只留要显示的字段', Object.keys(panel.posts[0]).sort().join(',') === 'account,captured_at,collect,comment,date,hasData,id,kind,like,platform,play,share,tPlusHours,title');
check('面板标出没报数的作品', panel.posts.every((post) => post.hasData === true) && buildPanel(buildRows([{ id: 'p0009', platform: 'bilibili' }], [])).posts[0].hasData === false);
check('面板复盘与 buildReport 同口径', panel.report.interactionRate === buildReport(panelRows, { groupBy: 'kind' }).interactionRate && panel.report.total === 2, JSON.stringify(panel.report));
check('面板行标题/类型有兜底', buildPanel([{ id: 'p0001', platform: 'douyin' }]).posts[0].kind === '未分类');

// —— 侧栏开关：没写配置就当开，只有显式 false 才关 ——
check('开关默认开', sidebarEnabled(undefined) === true && sidebarEnabled({}) === true && sidebarEnabled({ dataDir: 'X:/tmp-ledger' }) === true);
check('显式 false 才关', sidebarEnabled({ sidebar: false }) === false && sidebarEnabled({ sidebar: true }) === true);

// —— Host 桥：面板要的数据、开关要的写入口 ——
const panelDir = path.join(dir, 'panel-ledger');
fs.mkdirSync(panelDir, { recursive: true });
fs.writeFileSync(path.join(panelDir, POSTS_FILE), panelPosts.map((post) => JSON.stringify(post)).join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(panelDir, METRICS_FILE), panelMetrics.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
const panelPayload = readPanel({ dataDir: panelDir });
check('桥读出的台账目录是配置那个', panelPayload.dataDir === panelDir && panelPayload.ok === true, panelPayload.dataDir);
check('桥的 payload 带复盘和列表', panelPayload.posts.length === 2 && panelPayload.report.total === 2 && panelPayload.sidebar === true);
check('桥没有坏行时 errors 为空', Array.isArray(panelPayload.errors) && panelPayload.errors.length === 0);

// —— 绑定状态：面板靠 config/ 里的文件名说「这个平台接没接上」——
check(
  '凭据文件名能解析出平台与账号',
  parseCredentialName('bilibili_main.txt').platform === 'bilibili' && parseCredentialName('bilibili_main.txt').account === 'main',
  JSON.stringify(parseCredentialName('bilibili_main.txt')),
);
check(
  '认不出的凭据名不猜',
  parseCredentialName('bilibili.txt') === null
    && parseCredentialName('xhs_.txt') === null
    && parseCredentialName('notes.md') === null
    && parseCredentialName('other_main.txt') === null,
  JSON.stringify([
    parseCredentialName('bilibili.txt'),
    parseCredentialName('xhs_.txt'),
    parseCredentialName('notes.md'),
    parseCredentialName('other_main.txt'),
  ]),
);
const nowStamp = new Date('2026-11-18T12:00:00Z').getTime();
check(
  '存证时间说成人话',
  formatSavedAt(nowStamp - 3600e3, nowStamp) === '今天'
    && formatSavedAt(nowStamp - 26 * 3600e3, nowStamp) === '昨天'
    && formatSavedAt(nowStamp - 5 * 86400e3, nowStamp) === '5 天前',
  [formatSavedAt(nowStamp, nowStamp), formatSavedAt(nowStamp - 26 * 3600e3, nowStamp), formatSavedAt(nowStamp - 5 * 86400e3, nowStamp)].join(','),
);
const bindingList = describeBindings([
  { name: 'bilibili_main.txt', mtimeMs: nowStamp },
  { name: 'bilibili_小号.txt', mtimeMs: nowStamp - 86400e3 },
  { name: 'notes.md', mtimeMs: nowStamp },
]).platforms;
check('四个平台恒在四条', bindingList.map((item) => item.key).join(',') === 'douyin,xhs,bilibili,shipinhao', bindingList.map((item) => item.key).join(','));
check(
  '有凭据＝已绑定并列账号（新的在前）',
  bindingList[2].status === 'ready'
    && bindingList[2].credentials.map((item) => item.account).join(',') === 'main,小号'
    && bindingList[2].credentials[0].savedAt === '今天',
  JSON.stringify(bindingList[2]),
);
check(
  '没凭据＝未绑定并给出下一步',
  bindingList[0].status === 'unbound' && bindingList[0].credentials.length === 0 && bindingList[0].steps.length === 3
    && bindingList[0].steps[1].includes('scripts/douyin_sync.py')
    && bindingList[0].statusText.includes('douyin_'),
  JSON.stringify(bindingList[0]),
);
check(
  '空态三步文案直接来自 bindingSteps',
  bindingList[0].steps.join('|') === bindingSteps('douyin').join('|') && bindingSteps('shipinhao').join('|') === bindingList[3].steps.join('|'),
  JSON.stringify(bindingSteps('douyin')),
);
check(
  '没有采集脚本＝未接入',
  bindingList[3].status === 'no-collector' && bindingList[3].credentials.length === 0 && bindingList[3].steps.length === 2,
  JSON.stringify(bindingList[3]),
);
check(
  '桥的 payload 带筛选树与切片复盘',
  panelPayload.facets && panelPayload.facets.total === 2
    && panelPayload.reports && panelPayload.reports['platform:douyin'].total === 1
    && panelPayload.postsTotal === 2 && panelPayload.truncated === false,
  JSON.stringify({ facets: panelPayload.facets, keys: panelPayload.reports && Object.keys(panelPayload.reports) }),
);
// —— 扫码登录的纯函数：账号绝不进命令行 ——
check(
  'LOGIN_TARGETS 四个平台键齐全',
  Object.keys(LOGIN_TARGETS).sort().join(',') === 'bilibili,douyin,shipinhao,xhs'
    && ['douyin', 'xhs', 'bilibili', 'shipinhao'].every((key) => LOGIN_TARGETS[key] && LOGIN_TARGETS[key].platform === key),
  Object.keys(LOGIN_TARGETS).join(','),
);
check(
  '有采集器的平台脚本都在 scripts/ 下',
  ['douyin', 'xhs', 'bilibili'].every((key) => LOGIN_TARGETS[key].hasCollector === true && LOGIN_TARGETS[key].script.startsWith('scripts/'))
    && LOGIN_TARGETS.shipinhao.hasCollector === false,
  JSON.stringify(LOGIN_TARGETS),
);
check('Host 侧耐心要长过脚本最长等待（300s）', LOGIN_TIMEOUT_MS > 300000, String(LOGIN_TIMEOUT_MS));
check('账号名只收安全形状', sanitizeAccount('main') === 'main' && sanitizeAccount('xiao-hao_2') === 'xiao-hao_2', 'main / xiao-hao_2');
const badAccountSamples = ['../x', 'a b', 'a;rm -rf', '', 'x'.repeat(33), '-lead', null, 42];
const acceptedBadAccounts = badAccountSamples.filter((value) => sanitizeAccount(value) !== null);
check('危险账号名一律拒收', acceptedBadAccounts.length === 0, JSON.stringify(acceptedBadAccounts));
const biliPlan = buildLoginPlan('bilibili', 'main');
check(
  'bilibili 的登录命令由纯函数拼好',
  biliPlan.ok === true && biliPlan.plan.script === 'scripts/bili_sync.py'
    && biliPlan.plan.account === 'main' && biliPlan.plan.args.join(' ') === 'login --account main',
  JSON.stringify(biliPlan),
);
check('xhs 用 xhs_sync.py 的 login 子命令', buildLoginPlan('xhs', 'main').plan.script === 'scripts/xhs_sync.py', JSON.stringify(buildLoginPlan('xhs', 'main')));
check('不传账号默认 main', buildLoginPlan('douyin').plan.account === 'main', JSON.stringify(buildLoginPlan('douyin')));
check('中文平台名也认', buildLoginPlan('B站', 'main').plan.platform === 'bilibili', JSON.stringify(buildLoginPlan('B站', 'main')));
const noCollectorPlan = buildLoginPlan('shipinhao', 'main');
check('视频号没有采集脚本 → no-collector', noCollectorPlan.ok === false && noCollectorPlan.code === 'no-collector' && noCollectorPlan.error.length > 0, JSON.stringify(noCollectorPlan));
const unknownPlan = buildLoginPlan('nope', 'main');
check('不认识的平台 → bad-platform', unknownPlan.ok === false && unknownPlan.code === 'bad-platform' && unknownPlan.error.length > 0, JSON.stringify(unknownPlan));
check('坏账号在拼命令行之前就被拦下', buildLoginPlan('bilibili', '../x').code === 'bad-account', JSON.stringify(buildLoginPlan('bilibili', '../x')));
const loginSamples = {
  idle: {},
  running: { phase: 'running', platform: 'bilibili', account: 'main', startedAt: Date.now() },
  done: { phase: 'done', platform: 'bilibili', account: 'main', startedAt: Date.now() - 5000, finishedAt: Date.now(), exitCode: 0 },
  failed: { phase: 'failed', platform: 'douyin', account: 'main', exitCode: 1, log: 'boom: 打不开浏览器' },
};
const badLoginPhases = [];
for (const [phase, sample] of Object.entries(loginSamples)) {
  const described = describeLoginState(sample, Date.now());
  if (described.phase !== phase || typeof described.message !== 'string' || described.message.length === 0) badLoginPhases.push(phase);
}
check('四个阶段的 phase 与 message 都讲得清', badLoginPhases.length === 0, badLoginPhases.join(','));
check('done 的文案说清凭据落在哪', describeLoginState(loginSamples.done).message === '已保存凭据：config/bilibili_main.txt', describeLoginState(loginSamples.done).message);
check('failed 的文案取脚本报错的最后一行', describeLoginState(loginSamples.failed).message.includes('打不开浏览器'), describeLoginState(loginSamples.failed).message);
check('running 的文案让用户去扫码', describeLoginState(loginSamples.running).message === '已打开浏览器窗口，请在浏览器里扫码', describeLoginState(loginSamples.running).message);
check(
  'running 拖过了超时线就按超时判失败',
  describeLoginState({ phase: 'running', platform: 'bilibili', account: 'main', startedAt: 1000 }, 1000 + LOGIN_TIMEOUT_MS + 60000).phase === 'failed',
);
const qrSample = path.join(panelDir, 'bili-qr-main.png');
check('从日志里抓得到二维码图片路径', extractQrPath('  二维码图片：' + qrSample) === qrSample, String(extractQrPath('  二维码图片：' + qrSample)));
check('日志里的凭据值被丢掉', filterLoginLog('a\nSESSDATA=leak\nb').split('\n').join(',') === 'a,b', filterLoginLog('a\nSESSDATA=leak\nb'));
check('log 只留尾部 2000 字符', describeLoginState({ phase: 'failed', log: 'x'.repeat(5000) }).log.length === 2000, String(describeLoginState({ phase: 'failed', log: 'x'.repeat(5000) }).log.length));

const routes = makeBridgeRoutes({ get: () => undefined }, { dataDir: panelDir });
check('桥只开四条路由', routes.length === 4 && routes.every((route) => route.kind === 'exact' && route.path.startsWith(BRIDGE_PREFIX)), routes.map((r) => r.path).join(','));
check(
  '桥路由名对得上客户端',
  routes.map((route) => route.path).join(',') === `${BRIDGE_PREFIX}/state,${BRIDGE_PREFIX}/sidebar,${BRIDGE_PREFIX}/login,${BRIDGE_PREFIX}/login/state`,
  routes.map((route) => route.path).join(','),
);
const fakeRes = () => {
  const out = { statusCode: 0, headers: {}, body: '' };
  out.setHeader = (key, value) => {
    out.headers[key] = value;
  };
  out.end = (text) => {
    out.body = text;
  };
  return out;
};
const stateRes = fakeRes();
routes[0].handler({ method: 'GET' }, stateRes);
const stateBody = JSON.parse(stateRes.body);
check('GET state 返回 ok 与面板数据', stateRes.statusCode === 200 && stateBody.ok === true && stateBody.posts.length === 2, stateBody.error || '');
check(
  'GET state 顺带给出登录进度（没登录过就是 idle）',
  stateBody.login && stateBody.login.phase === 'idle' && typeof stateBody.login.message === 'string' && stateBody.login.message.length > 0
    && stateBody.login.exitCode === null && stateBody.login.log === '',
  JSON.stringify(stateBody.login),
);
// 其余字段一个都不许少：login 是新增的顶层键，不是替换
check(
  'login 只是顶上多一个键，别的字段照旧',
  ['bindings', 'platforms', 'posts', 'reports', 'facets', 'postsTotal', 'truncated', 'sidebar', 'dataDir'].every((key) => key in stateBody),
  Object.keys(stateBody).join(','),
);

// 绑定状态走真目录：config/ 里只认 .txt，且只取名字与时间（绝不读内容）
const wsDir = path.join(dir, 'binding-ws');
fs.mkdirSync(path.join(wsDir, 'code'), { recursive: true });
fs.mkdirSync(path.join(wsDir, 'config'), { recursive: true });
fs.writeFileSync(path.join(wsDir, 'AGENTS.md'), '# mock workspace\n', 'utf8');
fs.writeFileSync(path.join(wsDir, 'config', 'douyin_main.txt'), 'mock-cookie-not-real\n', 'utf8');
fs.writeFileSync(path.join(wsDir, 'config', 'notes.md'), 'mock notes\n', 'utf8');
const creds = listCredentialFiles({ workspaceRoot: wsDir });
check(
  '扫 config 只认 .txt 且只带名字与时间',
  creds.dir === path.join(wsDir, 'config')
    && creds.entries.map((entry) => entry.name).join(',') === 'douyin_main.txt'
    && Object.keys(creds.entries[0]).sort().join(',') === 'mtimeMs,name',
  JSON.stringify(creds),
);
const boundPayload = readPanel({ dataDir: panelDir, workspaceRoot: wsDir });
check(
  '桥的 payload 带绑定状态',
  boundPayload.ok === true
    && boundPayload.bindings.configDir === path.join(wsDir, 'config')
    && boundPayload.bindings.platforms.length === 4
    && boundPayload.bindings.platforms[0].status === 'ready'
    && boundPayload.platforms.length === 4,
  JSON.stringify(boundPayload.bindings),
);
check('没有 config 目录也算「一个都没绑」', listCredentialFiles({ workspaceRoot: path.join(dir, 'no-such-ws') }).entries.length === 0);
const wrongMethodRes = fakeRes();
routes[0].handler({ method: 'POST' }, wrongMethodRes);
check('GET state 拒绝别的 method', wrongMethodRes.statusCode === 405, String(wrongMethodRes.statusCode));
const badValueRes = fakeRes();
await routes[1].handler(
  { method: 'POST', on: (event, handler) => { if (event === 'end') handler(); } },
  badValueRes,
);
check('POST sidebar 拒绝空请求体', badValueRes.statusCode === 400 && JSON.parse(badValueRes.body).code === 'bad-request', badValueRes.body);
const noEditorRes = fakeRes();
await routes[1].handler(
  {
    method: 'POST',
    on: (event, handler) => {
      if (event === 'data') handler('{"value":false}');
      if (event === 'end') handler();
    },
  },
  noEditorRes,
);
check('没有 configEditor 时说清保存不了', noEditorRes.statusCode === 200 && JSON.parse(noEditorRes.body).code === 'no-config-editor', noEditorRes.body);

// —— 扫码登录的两条路由：坏输入一律 200 + ok:false，绝不真起 python ——
const loginGetRes = fakeRes();
routes[2].handler({ method: 'GET' }, loginGetRes);
check('GET /login 只认 POST', loginGetRes.statusCode === 405, String(loginGetRes.statusCode));
const badPlatformRes = fakeRes();
await routes[2].handler(
  {
    method: 'POST',
    on: (event, handler) => {
      if (event === 'data') handler('{"platform":"nope","account":"main"}');
      if (event === 'end') handler();
    },
  },
  badPlatformRes,
);
const badPlatformBody = JSON.parse(badPlatformRes.body);
check(
  'POST /login 认不出的平台 → 200 + bad-platform',
  badPlatformRes.statusCode === 200 && badPlatformBody.ok === false && badPlatformBody.code === 'bad-platform' && badPlatformBody.error.length > 0,
  badPlatformRes.body,
);
const noCollectorRes = fakeRes();
await routes[2].handler(
  {
    method: 'POST',
    on: (event, handler) => {
      if (event === 'data') handler('{"platform":"shipinhao","account":"main"}');
      if (event === 'end') handler();
    },
  },
  noCollectorRes,
);
check('POST /login 视频号 → no-collector', JSON.parse(noCollectorRes.body).code === 'no-collector', noCollectorRes.body);
const badAccountRes = fakeRes();
await routes[2].handler(
  {
    method: 'POST',
    on: (event, handler) => {
      if (event === 'data') handler('{"platform":"bilibili","account":"../x"}');
      if (event === 'end') handler();
    },
  },
  badAccountRes,
);
check('POST /login 坏账号 → bad-account（没起进程）', JSON.parse(badAccountRes.body).code === 'bad-account', badAccountRes.body);
const badJsonRes = fakeRes();
await routes[2].handler(
  {
    method: 'POST',
    on: (event, handler) => {
      if (event === 'data') handler('not json at all');
      if (event === 'end') handler();
    },
  },
  badJsonRes,
);
check('POST /login 坏 JSON → 400', badJsonRes.statusCode === 400 && JSON.parse(badJsonRes.body).code === 'bad-request', badJsonRes.body);
const loginStateRes = fakeRes();
routes[3].handler({ method: 'GET' }, loginStateRes);
const loginStateBody = JSON.parse(loginStateRes.body);
check(
  'GET /login/state 坏请求之后仍然是 idle',
  loginStateRes.statusCode === 200 && loginStateBody.ok === true && loginStateBody.login.phase === 'idle',
  loginStateRes.body,
);
const loginStateWrongRes = fakeRes();
routes[3].handler({ method: 'POST' }, loginStateWrongRes);
check('GET /login/state 拒绝别的 method', loginStateWrongRes.statusCode === 405, String(loginStateWrongRes.statusCode));


// —— 侧栏面板的客户端 bundle：DSH 的 module loader 契约 ——
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const clientText = fs.readFileSync(path.join(pkgRoot, 'lib/client.js'), 'utf8');
check('package.json 声明了 web 客户端', pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.platform === 'web', JSON.stringify(pkgJson.dsh && pkgJson.dsh.client));
check('exports["./client"] 指向存在的文件', pkgJson.exports['./client'] === './lib/client.js' && fs.existsSync(path.join(pkgRoot, pkgJson.exports['./client'])));
check('客户端用 ModuleLoader 注册且 id 等于包名', clientText.includes('window.__ModuleLoader__.load(') && clientText.includes(`id: '${pkgJson.name}'`), pkgJson.name);
check('React 只从 require("react") 来', /require\('react'\)/.test(clientText));
check('不 require 任何 dsh-client-* 包', !/require\(\s*['"]@deepseek-ai\/dsh-client-/.test(clientText));
check('侧栏 id 与主区域 key 是同一个常量', /const PANEL_ID = 'dsh-media-ledger'/.test(clientText) && clientText.includes('id: PANEL_ID') && clientText.includes('key: PANEL_ID'));
check('客户端只连本机桥，没有外网地址', !/https?:\/\//.test(clientText) && clientText.includes("const BRIDGE = 'api/dsh-media-ledger'"));
check('客户端不碰文件系统', !/require\('node:/.test(clientText) && !/from 'node:/.test(clientText));
// 左栏四平台 + 绑定状态：吞掉这几条，用户就会又一次「点进去看啥都没有」
check(
  '左栏吃 Host 的四平台列表与绑定状态',
  clientText.includes('data.platforms') && clientText.includes('data.bindings') && /function SideNav\(\{[^}]*platforms[^}]*bindings/.test(clientText),
);
check(
  '空态先说为什么空再给步骤',
  clientText.includes('function EmptyState') && clientText.includes('binding.statusText') && clientText.includes('binding.steps'),
);
check(
  '绑定标签按状态给三种文案',
  clientText.includes("'已绑定'") && clientText.includes("'未绑定'") && clientText.includes("'未接入'"),
);

// 光看源码文本不够：语法错或 apply 里写错，页面上是白屏，文本断言一条都不会响。
// 这里用 vm 把 bundle 真跑一遍（stub 掉 window / document / React），确认它能 load 并注册出两个入口。
let bundleOptions = null;
const bundleSandbox = {
  window: { __ModuleLoader__: { load: (options) => { bundleOptions = options; } } },
  document: { baseURI: 'http://127.0.0.1/' },
  URL,
  fetch: () => Promise.reject(new Error('注册阶段不该联网')),
  console,
};
bundleSandbox.globalThis = bundleSandbox;
vm.createContext(bundleSandbox);
vm.runInContext(clientText, bundleSandbox, { filename: 'lib/client.js' });
const bundleReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};
const bundleSlots = [];
let bundleExport = null;
try {
  bundleExport = bundleOptions
    ? bundleOptions.factory((name) => {
        if (name === 'react') return bundleReact;
        throw new Error(`客户端 require 了不该有的模块：${name}`);
      })
    : null;
  if (bundleExport) {
    bundleExport.apply({
      slots: {
        inject: (ownerKey, body) => body(),
        register: (options, component) => {
          bundleSlots.push({ name: options.name, id: options.id, key: options.key, component: typeof component });
          return () => {};
        },
      },
      inject: (services, body) => body({ get: () => ({ register: () => () => {} }), effect: (fn) => fn() }),
    });
  }
} catch (error) {
  check('客户端 bundle 能在页面环境里跑起来', false, String((error && error.message) || error));
}
const bundleSidebar = bundleSlots.find((item) => item.name === 'sidebar.panellist');
const bundleMain = bundleSlots.find((item) => item.name === 'main');
check('客户端 bundle 能在页面环境里跑起来', Boolean(bundleOptions) && bundleOptions.id === 'dsh-media-ledger', bundleOptions && bundleOptions.id);
check(
  '侧栏图标与主面板都注册上了，id 与 key 一致',
  Boolean(bundleSidebar) && Boolean(bundleMain)
    && bundleSidebar.component === 'function' && bundleMain.component === 'function'
    && bundleSidebar.id === bundleMain.key,
  JSON.stringify(bundleSlots),
);

// —— 隐私：不外传、不落仓库 ——
const codeFiles = ['index.js', 'lib/util.js', 'lib/config.js', 'lib/store.js', 'lib/metrics.js', 'lib/pack.js', 'lib/tool.js', 'lib/panel.js', 'lib/bridge.js', 'lib/login.js', 'lib/bilibili.js', 'lib/douyin.js', 'lib/xiaohongshu.js'];
// 出网：所有文件都不许，这条没有例外
const netPatterns = [
  /\bfetch\s*\(/,
  /new\s+WebSocket/,
  /XMLHttpRequest/,
  /['"]axios['"]/,
  /from\s+'node:(http|https|net|dns|tls)'/,
  /require\(\s*['"](http|https|net|dns|tls)['"]\s*\)/,
];
// 起进程：铁律是零。唯一窄例外是 lib/bridge.js 里那个白名单登录脚本（用户 2026-11-18 批准），
// 所以只豁免 bridge.js 一个文件，别的文件连 execFile / spawnSync 都不许碰。
const processPatterns = [
  /node:child_process/,
  /require\(\s*['"]child_process['"]\s*\)/,
  /\bexecSync\b|\bexecFileSync\b|\bspawnSync\b/,
];
const leaked = [];
for (const rel of codeFiles) {
  const text = fs.readFileSync(path.join(pkgRoot, rel), 'utf8');
  for (const pattern of netPatterns) if (pattern.test(text)) leaked.push(`${rel} 命中 ${pattern}`);
  if (rel === 'lib/bridge.js') continue;
  for (const pattern of processPatterns) if (pattern.test(text)) leaked.push(`${rel} 命中 ${pattern}`);
}
check('代码里没有出网的路子', leaked.length === 0, leaked.join('；'));
const childProcessOwners = codeFiles.filter((rel) => /node:child_process/.test(fs.readFileSync(path.join(pkgRoot, rel), 'utf8')));
check('node:child_process 只在 lib/bridge.js 出现', childProcessOwners.join(',') === 'lib/bridge.js', childProcessOwners.join(','));
const bridgeSourceText = fs.readFileSync(path.join(pkgRoot, 'lib/bridge.js'), 'utf8');
const spawnCallCount = bridgeSourceText.split('spawn(').length - 1;
check('子进程只在一个地方起，且只起一次', spawnCallCount === 1, `spawn( 出现 ${spawnCallCount} 次`);
check('起进程绝不经过 shell', !/shell\s*:\s*true/.test(bridgeSourceText), 'bridge.js 里出现 shell: true');

const savedDir = process.env.DSH_MEDIA_LEDGER_DIR;
delete process.env.DSH_MEDIA_LEDGER_DIR;
const defaultDir = resolveDataDir({});
const workspaceRoot = findWorkspaceRoot(pkgRoot);
const expectedDefault = workspaceRoot ? path.join(workspaceRoot, 'data', 'media-ledger') : defaultDir;
const envDir = (() => {
  process.env.DSH_MEDIA_LEDGER_DIR = path.join(dir, 'env-ledger');
  const value = resolveDataDir({});
  return value;
})();
if (savedDir !== undefined) process.env.DSH_MEDIA_LEDGER_DIR = savedDir;
else delete process.env.DSH_MEDIA_LEDGER_DIR;
check('默认台账目录在仓库外', !defaultDir.toLowerCase().startsWith(pkgRoot.toLowerCase()), defaultDir);
if (workspaceRoot) {
  check('默认落到工作区 data/media-ledger', defaultDir === path.join(workspaceRoot, 'data', 'media-ledger'), defaultDir);
} else {
  check('找不到工作区时退回用户目录', defaultDir === path.join(os.homedir(), 'media-ledger'), defaultDir);
}
check('环境变量能改目录', envDir === path.join(dir, 'env-ledger'), envDir);
check('配置优先于环境变量', resolveDataDir({ dataDir: path.join(dir, 'cfg-ledger') }) === path.join(dir, 'cfg-ledger'));

// 宿主注入的工作区根提示（index.js 从 workspaceRegistry 取，惰性函数）：字符串与函数都认，函数抛错当没有
const hintString = resolveDataDir({ workspaceRoot: path.join(dir, 'ws-hint') });
check('工作区根提示（字符串）优先于 cwd 探测', hintString === path.join(dir, 'ws-hint', 'data', 'media-ledger'), hintString);
const hintFn = resolveDataDir({ workspaceRoot: () => path.join(dir, 'ws-fn') });
check('工作区根提示（函数）也能用', hintFn === path.join(dir, 'ws-fn', 'data', 'media-ledger'), hintFn);
check('dataDir 仍然压过工作区根提示', resolveDataDir({ dataDir: path.join(dir, 'cfg-ledger'), workspaceRoot: () => path.join(dir, 'ws-fn') }) === path.join(dir, 'cfg-ledger'));
const hintThrows = resolveDataDir({ workspaceRoot: () => { throw new Error('registry not ready'); } });
check('工作区根提示抛错不炸插件', typeof hintThrows === 'string' && hintThrows.length > 0, hintThrows);

// 工作区识别：只认「AGENTS.md + code|work」同层，插件仓库自己不会被误认（否则台账写回仓库里）
const fakeRoot = path.join(dir, 'ws');
fs.mkdirSync(path.join(fakeRoot, 'code', 'proj'), { recursive: true });
fs.writeFileSync(path.join(fakeRoot, 'AGENTS.md'), '# ws\n', 'utf8');
check('能往上找到工作区根', findWorkspaceRoot(path.join(fakeRoot, 'code', 'proj')) === fakeRoot, findWorkspaceRoot(path.join(fakeRoot, 'code', 'proj')));
check('插件仓库自己不算工作区根', findWorkspaceRoot(pkgRoot) !== pkgRoot, findWorkspaceRoot(pkgRoot));

const ignoreText = fs.readFileSync(path.join(pkgRoot, '.gitignore'), 'utf8');
check('.gitignore 挡住 data/ 与 *.jsonl', /^data\/$/m.test(ignoreText) && /\*\.jsonl/m.test(ignoreText));

const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
check('没有第三方依赖', Object.keys(pkg.dependencies || {}).length === 0, JSON.stringify(pkg.dependencies || {}));

// —— 详情页：meta.detail 必须是存在的 .md 路径，文档恰好一行图片 ——
const detailProblems = [];
for (const locale of ['zh', 'en']) {
  const meta = JSON.parse(fs.readFileSync(path.join(pkgRoot, `locale/${locale}.json`), 'utf8')).meta || {};
  const rel = meta.detail;
  if (typeof rel !== 'string' || !rel.endsWith('.md')) {
    detailProblems.push(`${locale}.json 的 meta.detail 不是 .md 路径：${JSON.stringify(rel)}`);
    continue;
  }
  const file = path.join(pkgRoot, rel);
  if (!fs.existsSync(file)) {
    detailProblems.push(`${rel} 不存在`);
    continue;
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter((line) => line.trim());
  const image = lines.length === 1 ? /^!\[[^\]]*\]\(([^)]+)\)$/.exec(lines[0].trim()) : null;
  if (!image) {
    detailProblems.push(`${rel} 必须是恰好一行 ![](图)`);
  } else if (!fs.existsSync(path.join(path.dirname(file), image[1]))) {
    detailProblems.push(`${rel} 引用的图 ${image[1]} 不存在`);
  }
}
check('详情页文档合法（路径 + 单图 + 图存在）', detailProblems.length === 0, detailProblems.join('；'));

// —— 左导航：平台 → 账号两级树，切片复盘走同一套 buildReport ——
const treeRows = buildRows(
  [
    { id: 'p0001', platform: 'douyin', account: 'mock-a', kind: '图文tag', date: '2026-11-10', published_at: '2026-11-10 20:00' },
    { id: 'p0002', platform: 'douyin', account: 'mock-b', kind: '视频', date: '2026-11-11', published_at: '2026-11-11 20:00' },
    { id: 'p0003', platform: 'douyin', account: 'mock-a', kind: '视频', date: '2026-11-12', published_at: '2026-11-12 20:00' },
    { id: 'p0004', platform: 'xhs', account: '', kind: '图文tag', date: '2026-11-13', published_at: '2026-11-13 20:00' },
    { id: 'p0005', platform: '', kind: '图文tag', date: '2026-11-14' },
  ],
  [],
);
const tree = buildPanel(treeRows);
check(
  '筛选树按平台分桶带条数',
  tree.facets.platforms.map((item) => `${item.key}:${item.count}`).join(',') === 'douyin:3,xhs:1',
  JSON.stringify(tree.facets.platforms),
);
check(
  '平台下展开具名账号并排序',
  tree.facets.platforms[0].accounts.map((item) => `${item.key}:${item.count}`).join(',') === 'mock-a:2,mock-b:1',
  JSON.stringify(tree.facets.platforms[0].accounts),
);
check('空账号不单列成节点', tree.facets.platforms[1].accounts.length === 0 && tree.facets.platforms[1].count === 1);
check(
  '左栏平台列表恒含四平台（0 条也列）',
  platformList(treeRows).map((item) => `${item.key}:${item.count}`).join(',') === 'douyin:3,xhs:1,bilibili:0,shipinhao:0',
  JSON.stringify(platformList(treeRows)),
);
check(
  '空平台也有切片复盘（点进去不炸）',
  tree.reports['platform:bilibili'].total === 0
    && tree.reports['platform:bilibili'].groupBy === 'account'
    && tree.reports['platform:shipinhao'].total === 0,
  Object.keys(tree.reports).join(','),
);
check('没填平台的老记录单独一桶', tree.facets.unassigned === 1 && tree.facets.total === 5, JSON.stringify(tree.facets));
check(
  '切片复盘与整体同口径',
  tree.reports['platform:douyin'].total === 3
    && tree.reports['platform:douyin'].groupBy === 'account'
    && tree.reports['account:douyin|mock-a'].total === 2
    && tree.reports['account:douyin|mock-a'].groupBy === 'kind',
  Object.keys(tree.reports).join(','),
);
check('all 切片默认按平台分组且就是 report', tree.report.groupBy === 'platform' && tree.reports.all === tree.report);
check(
  '切片 id 能解析也能回落',
  parseSlice('account:douyin|mock-a').platform === 'douyin'
    && parseSlice('account:douyin|mock-a').account === 'mock-a'
    && parseSlice('platform:').kind === 'platform'
    && parseSlice('all').kind === 'all'
    && parseSlice('乱写').kind === 'all',
);
const manyRows = Array.from({ length: POST_LIMIT + 5 }, (unused, index) => ({
  id: `p${String(index + 1).padStart(4, '0')}`,
  platform: 'douyin',
  account: 'mock-a',
  kind: '视频',
  title: `mock 第 ${index + 1} 条`,
  date: '2026-11-01',
}));
const bigPanel = buildPanel(manyRows);
check(
  '面板列表按上限截断并给出总数',
  bigPanel.posts.length === POST_LIMIT && bigPanel.postsTotal === POST_LIMIT + 5 && bigPanel.truncated === true,
  `${bigPanel.posts.length}/${bigPanel.postsTotal}`,
);
check('截断上限可以调', buildPanel(manyRows, { postLimit: 10 }).posts.length === 10 && buildPanel(manyRows, { postLimit: 10 }).truncated === true);

fs.rmSync(dir, { recursive: true, force: true });

console.log(fails.length === 0 ? `全过 ${pass}/${pass}` : `失败 ${fails.length} / 通过 ${pass}`);
for (const fail of fails) console.log(`- ${fail}`);
process.exit(fails.length === 0 ? 0 : 1);
