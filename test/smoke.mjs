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
import { appendJsonl, loadLedger, nextPostId, resolveDataDir, POSTS_FILE, METRICS_FILE } from '../lib/store.js';

const dir = path.join(os.tmpdir(), `ml-smoke-${Date.now()}`);
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

// —— 隐私：不外传、不落仓库 ——
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codeFiles = ['index.js', 'lib/util.js', 'lib/config.js', 'lib/store.js', 'lib/metrics.js', 'lib/pack.js', 'lib/tool.js'];
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
if (savedDir !== undefined) process.env.DSH_MEDIA_LEDGER_DIR = savedDir;
check('默认台账目录在仓库外', !defaultDir.toLowerCase().startsWith(pkgRoot.toLowerCase()), defaultDir);

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
