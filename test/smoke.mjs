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
import { buildPanel, parseSlice, POST_LIMIT } from '../lib/panel.js';
import { matchPost, normalizeImport, progressPercent, tsToLocal } from '../lib/bilibili.js';
import { matchPost as dyMatchPost, normalizeImport as dyNormalize, percentOf, secondsOf } from '../lib/douyin.js';
import { BRIDGE_PREFIX, makeBridgeRoutes, readPanel, sidebarEnabled } from '../lib/bridge.js';

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
check(
  '桥的 payload 带筛选树与切片复盘',
  panelPayload.facets && panelPayload.facets.total === 2
    && panelPayload.reports && panelPayload.reports['platform:douyin'].total === 1
    && panelPayload.postsTotal === 2 && panelPayload.truncated === false,
  JSON.stringify({ facets: panelPayload.facets, keys: panelPayload.reports && Object.keys(panelPayload.reports) }),
);
const routes = makeBridgeRoutes({ get: () => undefined }, { dataDir: panelDir });
check('桥只开两条路由', routes.length === 2 && routes.every((route) => route.kind === 'exact' && route.path.startsWith(BRIDGE_PREFIX)), routes.map((r) => r.path).join(','));
check('桥路由名对得上客户端', routes.map((route) => route.path).join(',') === `${BRIDGE_PREFIX}/state,${BRIDGE_PREFIX}/sidebar`);
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
const codeFiles = ['index.js', 'lib/util.js', 'lib/config.js', 'lib/store.js', 'lib/metrics.js', 'lib/pack.js', 'lib/tool.js', 'lib/panel.js', 'lib/bridge.js', 'lib/bilibili.js', 'lib/douyin.js'];
const forbidden = [
  /\bfetch\s*\(/,
  /new\s+WebSocket/,
  /XMLHttpRequest/,
  /from\s+'node:(http|https|net|dns|tls|child_process)'/,
  /require\(\s*['"](http|https|net|dns|tls|child_process)['"]\s*\)/,
  /['"]axios['"]/,
];
const leaked = [];
for (const rel of codeFiles) {
  const text = fs.readFileSync(path.join(pkgRoot, rel), 'utf8');
  for (const pattern of forbidden) if (pattern.test(text)) leaked.push(`${rel} 命中 ${pattern}`);
}
check('代码里没有出网/起进程的路子', leaked.length === 0, leaked.join('；'));

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
