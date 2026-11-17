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
import { buildRows, buildReport, parseTs, latestSnapshots, median, interaction } from '../lib/metrics.js';
import { buildPack } from '../lib/pack.js';
import { parseCount, toLossless } from '../lib/util.js';
import { normalizePlatform } from '../lib/config.js';
import { appendJsonl, findWorkspaceRoot, loadLedger, nextPostId, resolveDataDir, POSTS_FILE, METRICS_FILE } from '../lib/store.js';
import { buildPanel } from '../lib/panel.js';
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

// —— 隐私：不外传、不落仓库 ——
const codeFiles = ['index.js', 'lib/util.js', 'lib/config.js', 'lib/store.js', 'lib/metrics.js', 'lib/pack.js', 'lib/tool.js', 'lib/panel.js', 'lib/bridge.js'];
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

fs.rmSync(dir, { recursive: true, force: true });

console.log(fails.length === 0 ? `全过 ${pass}/${pass}` : `失败 ${fails.length} / 通过 ${pass}`);
for (const fail of fails) console.log(`- ${fail}`);
process.exit(fails.length === 0 ? 0 : 1);
