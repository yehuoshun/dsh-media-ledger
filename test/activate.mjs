/**
 * 激活检查：用假 ctx 跑 index.js 的 apply，确认工具能注册、能执行、能渲染、能回收。
 * 不用装插件、不用开界面，跑完不留文件（台账写在系统临时目录里，最后删掉）。
 *
 * 用法：
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" "test\activate.mjs"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../index.js';

const dataDir = path.join(os.tmpdir(), `ml-activate-${Date.now()}`);
const registered = [];
const cleaned = [];
const bridgeRoutes = [];
const webServer = {
  register(route) {
    bridgeRoutes.push(route);
    return () => {
      const index = bridgeRoutes.indexOf(route);
      if (index >= 0) bridgeRoutes.splice(index, 1);
    };
  },
};
const ctx = {
  effect(fn) {
    const dispose = fn();
    cleaned.push(dispose);
    return dispose;
  },
  logger: () => {},
  tools: {
    register(spec) {
      registered.push(spec);
      return () => { spec.disposed = true; };
    },
  },
  // 真 ctx 的 inject 会等 service 就绪再跑回调；这里只喂 webServer，够验桥的注册与回收。
  inject(services, callback) {
    if (!services.includes('webServer')) return;
    callback({
      get: (service) => (service === 'webServer' ? webServer : undefined),
      effect: (fn) => ctx.effect(fn),
    });
  },
};

apply(ctx, { dataDir });
const tool = registered[0];
if (!tool) {
  console.log('❌ 没有注册任何工具');
  process.exit(1);
}
console.log(`name=${name} inject=${JSON.stringify(inject)} 工具名=${tool.name} 参数键=${Object.keys(tool.parameters.properties).length} 个`);
console.log(`桥路由 → ${bridgeRoutes.map((route) => route.path).join(', ')}`);
const bridgeCount = bridgeRoutes.length;

const add = await tool.execute({ action: 'add_post', platform: '抖音', account: '主号', kind: '图文tag', title: '五盾军团23人穿7号致敬C罗', published_at: '2026-11-14 20:00' });
console.log('add_post →', JSON.stringify(add.added));

const snap = await tool.execute({ action: 'add_metrics', id: 'p0001', captured_at: '2026-11-17 09:00', play: '2.4w', like: '46', comment: '79' });
console.log('add_metrics →', JSON.stringify(snap.added));

const report = await tool.execute({ action: 'report', group_by: 'kind' });
console.log('report →', JSON.stringify(report.groups));

const list = await tool.execute({ action: 'list', platform: '抖音' });
console.log(`list → ${list.total} 条，第一条 ${list.posts[0].id}`);

const pack = await tool.execute({ action: 'pack', platform: 'bilibili', title: '短标题', body: '简介一段', tags: ['足球', 'C罗'], cover_width: 1080, cover_height: 1920 });
const rendered = tool.output.render({}, pack)[0].text;
console.log('pack 渲染 →', rendered.split('\n').filter((line) => line.startsWith('✓') || line.startsWith('⚠')).join(' | '));

const badId = await tool.execute({ action: 'add_metrics', id: 'p9999', play: '100' });
const badAction = await tool.execute({ action: 'nope' });
const badCount = await tool.execute({ action: 'add_metrics', id: 'p0001', play: '很多' });
console.log('错误路径 →', [badId.error, badAction.error, badCount.error].map((text) => text.slice(0, 24)).join(' / '));

// 工作区根接线：桌面版插件进程的 cwd 不是工作区，index.js 靠 ctx.get('workspaceRegistry') 拿根目录。
// 这里喂一个假 registry，确认没显式配 dataDir 时，台账目录落在 <工作区根>/data/media-ledger。
const wsRoot = path.join(os.tmpdir(), `ml-ws-${Date.now()}`);
fs.mkdirSync(path.join(wsRoot, 'code', 'mock-proj'), { recursive: true });
fs.writeFileSync(path.join(wsRoot, 'AGENTS.md'), '# mock workspace\n', 'utf8');
const hintRoutes = [];
const hintCtx = {
  effect(fn) {
    return fn();
  },
  logger: () => {},
  get: (service) => (service === 'workspaceRegistry' ? { list: () => [{ path: wsRoot }] } : undefined),
  tools: { register(spec) { return () => { spec.disposed = true; }; } },
  inject(services, callback) {
    if (!services.includes('webServer')) return;
    callback({
      get: (service) => (service === 'webServer'
        ? { register(route) { hintRoutes.push(route); return () => {}; } }
        : undefined),
      effect: (fn) => fn(),
    });
  },
};
const savedHintEnv = process.env.DSH_MEDIA_LEDGER_DIR;
delete process.env.DSH_MEDIA_LEDGER_DIR;
apply(hintCtx, {});
if (savedHintEnv !== undefined) process.env.DSH_MEDIA_LEDGER_DIR = savedHintEnv;
const stateRoute = hintRoutes.find((route) => route.path === '/api/dsh-media-ledger/state');
let stateBody = '';
if (stateRoute) {
  await stateRoute.handler({ method: 'GET' }, { writeHead() {}, end(body) { stateBody = body; } });
}
const hintedDir = stateBody ? JSON.parse(stateBody).dataDir : '';
const expectedHinted = path.join(wsRoot, 'data', 'media-ledger');
const hintOk = hintedDir === expectedHinted;
console.log(`工作区根接线 → ${hintedDir || '（没拿到路由）'}${hintOk ? ' ✓' : ` ✗（应为 ${expectedHinted}）`}`);
fs.rmSync(wsRoot, { recursive: true, force: true });

// 面板 payload 的形状：左导航要的 facets 与两级切片复盘都得在（此时台账里有 1 条 douyin/主号）
const panelRoute = bridgeRoutes.find((route) => route.path === '/api/dsh-media-ledger/state');
let panelBody = '';
if (panelRoute) {
  await panelRoute.handler({ method: 'GET' }, { writeHead() {}, end(body) { panelBody = body; } });
}
const panelPayload = panelBody ? JSON.parse(panelBody) : {};
const shapeOk = Boolean(panelPayload.facets)
  && panelPayload.facets.total === 1
  && panelPayload.facets.platforms.length === 1
  && panelPayload.facets.platforms[0].key === 'douyin'
  && panelPayload.facets.platforms[0].accounts[0].key === '主号'
  && panelPayload.reports['platform:douyin'].groupBy === 'account'
  && panelPayload.reports['account:douyin|主号'].groupBy === 'kind'
  && panelPayload.postsTotal === 1
  && panelPayload.truncated === false
  && Array.isArray(panelPayload.platforms)
  && panelPayload.platforms.length === 4
  && panelPayload.bindings
  && panelPayload.bindings.platforms.length === 4
  && panelPayload.bindings.platforms.every((item) => typeof item.statusText === 'string' && item.statusText.length > 0 && Array.isArray(item.steps));
console.log(`面板切片 → ${shapeOk ? 'facets + 两级切片 ✓' : JSON.stringify(panelPayload.facets || panelPayload)}`);

// import_xhs：走 tool.execute，验 action 分发 + 建档 + 快照落盘（放在面板断言之后，免得改动切片数量）
const xhsFile = path.join(os.tmpdir(), `ml-xhs-import-${Date.now()}.json`);
fs.writeFileSync(xhsFile, JSON.stringify({
  platform: 'xhs',
  account: { name: 'mock-xhs' },
  generated_at: '2026-11-18 01:20',
  notes: [{
    note_id: 'mocknote0001',
    title: 'mock 小红书笔记',
    kind: '图文',
    published_at: '2026-11-10 12:00',
    metrics: { play: 1200, like: 34, collect: 12, comment: 5, share: 2, fans: 3 },
    extras: { impressions: 8000 },
  }],
}), 'utf8');
const imported = await tool.execute({ action: 'import_xhs', path: xhsFile });
fs.rmSync(xhsFile, { force: true });
const importOk = imported.ok === true
  && imported.platform === 'xhs'
  && imported.createdCount === 1
  && imported.updatedCount === 1
  && imported.updated[0].platformId === 'mocknote0001'
  && imported.updated[0].play === 1200;
console.log(`import_xhs → 新建 ${imported.createdCount} 条 / 更新 ${imported.updatedCount} 条${importOk ? ' ✓' : ` ✗ ${JSON.stringify(imported)}`}`);

const serialized = JSON.stringify(report) + JSON.stringify(pack);
const ok = report.groups.length === 1
  && list.total === 1
  && badId.ok === false && badAction.ok === false && badCount.ok === false
  && !serialized.includes('undefined')
  && bridgeCount === 2
  && hintOk
  && shapeOk
  && importOk;

for (const dispose of cleaned) dispose();
const recycled = tool.disposed === true && bridgeRoutes.length === 0;
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(ok && recycled ? '全过：注册 / 执行 / 渲染 / 错误路径 / 回收' : `失败：ok=${ok} recycled=${recycled}`);
process.exit(ok && recycled ? 0 : 1);
